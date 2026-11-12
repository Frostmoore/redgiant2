// @vitest-environment jsdom
// Settings › Artifacts (3.5.9): the list by place, the empty state that says what artifacts are,
// «Import» (a .rgartifact into the place picked in our window), «Export» with the bare-HTML
// warning, and «Delete» asked in our Modal (never the browser's confirm) then done through the
// file explorer's own deletion. An archived project's artifacts cannot be deleted.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
let listed: unknown[] = [];
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "artifacts") return Promise.resolve(listed);
        if (name === "artifactImport")
          return Promise.resolve({
            path: "artefatti/Torneo.html",
            name: "Torneo",
            dataIgnored: false,
          });
        if (name === "artifactExport") return Promise.resolve(new Blob(["zip"]));
        return Promise.resolve({});
      };
    },
  },
);
const opened: unknown[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  openCanvas: (...a: unknown[]) => {
    opened.push(a);
    return "id";
  },
}));

const { Artifacts } = await import("../src/components/Artifacts.js");
const { Dialogs } = await import("../src/components/dialogs.js");
const { projects } = await import("../src/state.js");

const art = (o: Record<string, unknown>) => ({
  scope: "project:shop",
  place: "Shop",
  projectId: "shop",
  path: "artefatti/preventivi.html",
  file: "preventivi.html",
  name: "Calcolo preventivi",
  header: true,
  version: 3,
  libs: ["chartjs"],
  wants: [],
  granted: [],
  grants: [],
  hasData: false,
  from: "agent_shop",
  size: 2048,
  modifiedAt: "2026-11-11T10:00:00Z",
  readOnly: false,
  pendingRun: false,
  ...o,
});

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  lang.value = "it";
  projects.value = [
    { id: "shop", name: "Shop", path: "/w/shop", createdAt: "2026-11-01T00:00:00Z" },
    { id: "casa", name: "Casa", path: "/w/casa", createdAt: "2026-11-01T00:00:00Z" },
  ] as typeof projects.value;
  listed = [];
});
afterEach(cleanup);

const page = () =>
  render(
    <>
      <Artifacts />
      <Dialogs />
    </>,
  );

describe("Settings › Artifacts (3.5.9)", () => {
  it("says what artifacts are when there are none", async () => {
    const r = page();
    await waitFor(() => expect(r.getByText("Ancora nessun artefatto")).toBeTruthy());
    expect(r.getByText(/Un artefatto è un'app HTML in un file solo/)).toBeTruthy();
    expect(r.getByText(/importa un \.rgartifact da un altro RedGiant/)).toBeTruthy();
    expect(r.container.querySelector("input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("lists them by place with their facts, opens one in the Canvas the usual way", async () => {
    listed = [
      art({}),
      art({
        scope: "platform",
        place: "God's folder",
        projectId: null,
        path: "artefatti/torneo.html",
        file: "torneo.html",
        name: "Torneo",
        version: null,
        header: false,
        libs: [],
        from: null,
        pendingRun: true,
      }),
    ];
    const r = page();
    await waitFor(() => expect(r.getByText("Calcolo preventivi")).toBeTruthy());
    expect(r.getByText("Shop")).toBeTruthy();
    expect(r.getByText("Cartella di God")).toBeTruthy();
    expect(r.getByText(/versione 3 · librerie: chartjs · da agent_shop/)).toBeTruthy();
    expect(r.getByText(/senza intestazione/)).toBeTruthy();
    expect(r.getByText("Importato · non ancora eseguito")).toBeTruthy();
    fireEvent.click(r.getAllByText("Apri")[0] as HTMLElement);
    expect(opened).toEqual([
      [
        "preventivi.html",
        { kind: "file", scope: "project:shop", path: "artefatti/preventivi.html" },
      ],
    ]);
  });

  it("deletes only after a yes in our window, through the file explorer's deletion", async () => {
    const confirm = vi.spyOn(window, "confirm");
    listed = [art({})];
    const r = page();
    await waitFor(() => expect(r.getByText("Calcolo preventivi")).toBeTruthy());
    fireEvent.click(r.getByText("Elimina"));
    await waitFor(() => expect(r.getByText("Eliminare «Calcolo preventivi»?")).toBeTruthy());
    expect(document.querySelector(".ui-modal")).not.toBeNull();
    expect(calls.some(([n]) => n === "fileOp")).toBe(false);
    // The window's own «Elimina» (the second one on the page).
    const buttons = r.getAllByText("Elimina");
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "fileOp")?.[1]).toEqual([
        { op: "delete", scope: "project:shop", path: "artefatti/preventivi.html" },
      ]),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("offers no deletion in an archived project", async () => {
    listed = [art({ readOnly: true })];
    const r = page();
    await waitFor(() => expect(r.getByText("Calcolo preventivi")).toBeTruthy());
    expect(r.queryByText("Elimina")).toBeNull();
    expect(r.getByText(/sola lettura: il progetto è archiviato/)).toBeTruthy();
  });

  it("imports a picked .rgartifact into the place chosen in our window", async () => {
    const r = page();
    await waitFor(() => expect(r.getByText("Ancora nessun artefatto")).toBeTruthy());
    const made: HTMLInputElement[] = [];
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = create(tag);
      if (tag === "input") {
        made.push(el as HTMLInputElement);
        (el as HTMLInputElement).click = () => {};
      }
      return el;
    });
    fireEvent.click(r.getByText("Importa"));
    spy.mockRestore();
    const input = made[0] as HTMLInputElement;
    expect(input.accept).toBe(".rgartifact");
    const file = new File(["zip"], "Torneo.rgartifact");
    Object.defineProperty(input, "files", { value: [file] });
    input.onchange?.(new Event("change"));
    await waitFor(() => expect(r.getByText("Dove lo metto?")).toBeTruthy());
    // Only the places in use: both projects, God's folder, the desk.
    expect(r.getByText("Casa")).toBeTruthy();
    expect(r.getByText("Scrivania degli assistenti")).toBeTruthy();
    fireEvent.click(r.getByText("Casa"));
    await waitFor(() =>
      expect(
        r.getByText(/«Torneo» importato in Casa: la prima volta si apre sul sorgente/),
      ).toBeTruthy(),
    );
    expect(calls.find(([n]) => n === "artifactImport")?.[1]).toEqual(["project:casa", file]);
  });

  it("exports as .rgartifact or as HTML, with the warning on the bare HTML", async () => {
    listed = [art({})];
    const url = vi.fn(() => "blob:x");
    URL.createObjectURL = url;
    URL.revokeObjectURL = () => {};
    const r = page();
    await waitFor(() => expect(r.getByText("Calcolo preventivi")).toBeTruthy());
    fireEvent.click(r.getByText("Esporta"));
    expect(r.getByText("Scarica come HTML")).toBeTruthy();
    expect(r.getByText(/fuori da RedGiant gira senza il riquadro isolato/)).toBeTruthy();
    fireEvent.click(r.getByText("Un file .rgartifact"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "artifactExport")?.[1]).toEqual([
        "project:shop",
        "artefatti/preventivi.html",
        "zip",
        false,
      ]),
    );
    expect(url).toHaveBeenCalled();
  });
});

describe("Settings › Artifacts: the bridge's permissions (3.6)", () => {
  it("shows what it asks for, granted or not, with the cap; grants and takes back", async () => {
    listed = [
      art({
        wants: ["ask", "storage", "files:dati/", "nonsense"],
        granted: ["ask"],
        grants: [{ capability: "ask", agentId: "agent_shop", capUsd: 2, spentUsd: 0.25, at: "x" }],
      }),
    ];
    const r = page();
    await waitFor(() => expect(r.getByText("Permessi")).toBeTruthy());
    const text = r.container.textContent ?? "";
    expect(text).toContain("Chiede di fare domande a");
    expect(text).toContain("spesi 0.25 $ di 2 $");
    expect(text).toContain("Chiede di tenere dati suoi su RedGiant");
    expect(text).toContain(
      "Chiede di leggere i file della cartella dati/ del progetto (solo lettura)",
    );
    expect(text).not.toContain("nonsense");
    expect(r.getAllByText("concesso")).toHaveLength(1);
    expect(r.getAllByText("non concesso")).toHaveLength(2);
    fireEvent.click(r.getByText("Togli"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "artifactRevoke")?.[1]).toEqual([
        "project:shop",
        "artefatti/preventivi.html",
        "ask",
      ]),
    );
    fireEvent.click(r.getAllByText("Concedi")[1] as HTMLElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "artifactGrant")?.[1]).toEqual([
        "project:shop",
        "artefatti/preventivi.html",
        "files:dati/",
        undefined,
      ]),
    );
    // A new cap for a granted ask applies at once.
    fireEvent.click(r.getByText("5 $"));
    await waitFor(() =>
      expect(calls.filter(([n]) => n === "artifactGrant").at(-1)?.[1]).toEqual([
        "project:shop",
        "artefatti/preventivi.html",
        "ask",
        5,
      ]),
    );
    expect(r.container.querySelector("input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("exports its saved data only when the person switches it on", async () => {
    listed = [art({ hasData: true, wants: ["storage"], granted: ["storage"], grants: [] })];
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = () => {};
    const r = page();
    await waitFor(() => expect(r.getByText("Calcolo preventivi")).toBeTruthy());
    expect(r.getByText(/ha dati salvati/)).toBeTruthy();
    fireEvent.click(r.getByText("Esporta"));
    const sw = r.getByRole("switch", { name: "Includi i dati salvati" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    fireEvent.click(r.getByText("Un file .rgartifact"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "artifactExport")?.[1]).toEqual([
        "project:shop",
        "artefatti/preventivi.html",
        "zip",
        true,
      ]),
    );
  });
});
