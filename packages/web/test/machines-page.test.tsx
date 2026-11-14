// @vitest-environment jsdom
// G38.2: Settings > Machines. The page lists the machines with their public key to copy and the
// machine's fingerprint, never a secret; «Test the connection» shows the key of a first connection
// and trusts it only on the person's click; a changed key is shown in red and replaced only after
// a confirmation in our own window; adding a machine sends the key or password once. No native
// checkboxes, radios or dialogs; the chat's tool cards name the machine.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const PUB =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFake redgiant-web";
const FP_NEW = "SHA256:n3wK3yN3wK3yN3wK3yN3wK3yN3wK3yN3wK3yN3wK3y0";
const FP_OLD = "SHA256:0ldK3y0ldK3y0ldK3y0ldK3y0ldK3y0ldK3y0ldK3y0";
const web = {
  id: "mach_1",
  name: "web",
  host: "web.example.test",
  port: 22,
  user: "deploy",
  auth: "key",
  keySource: "generated",
  publicKey: PUB,
  folder: "/srv/app",
  access: { everyone: true, agents: [], projects: [] },
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
};
const pi = {
  ...web,
  id: "mach_2",
  name: "pi",
  host: "pi.example.test",
  auth: "password",
  keySource: undefined,
  publicKey: undefined,
  hasPassword: true,
  hostKey: { type: "ssh-ed25519", fingerprint: FP_OLD, pinnedAt: "2026-11-12T00:00:00Z" },
  access: { everyone: false, agents: [], projects: [] },
};
let tests: Record<string, unknown> = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "machines") return Promise.resolve({ machines: [web, pi] });
        if (name === "testMachine") return Promise.resolve(tests[args[0] as string]);
        if (name === "trustMachine") return Promise.resolve(web);
        if (name === "addMachine") return Promise.resolve(web);
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refresh: () => Promise.resolve(),
}));

const { Machines } = await import("../src/components/Machines.js");
const { Dialogs } = await import("../src/components/dialogs.js");
const { t } = await import("../src/i18n.js");

const NATIVE = 'input[type="checkbox"], input[type="radio"]';

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  tests = {
    mach_1: {
      ok: false,
      code: "host-key-new",
      message: "First connection",
      hostKey: { type: "ssh-ed25519", fingerprint: FP_NEW },
    },
    mach_2: {
      ok: false,
      code: "host-key-changed",
      message: "DANGER",
      hostKey: { type: "ssh-ed25519", fingerprint: FP_NEW },
      expected: FP_OLD,
    },
  };
});
afterEach(() => cleanup());

describe("Settings > Machines (G38.2)", () => {
  it("lists the machines with the public key to copy and the fingerprint, never a secret", async () => {
    const r = render(<Machines />);
    await waitFor(() => r.getByText("web"));
    expect(r.getByText("Le tue macchine")).toBeTruthy();
    expect(r.container.textContent).toContain(PUB);
    expect(r.container.textContent).toContain(FP_OLD);
    expect(r.container.textContent).toContain("deploy@web.example.test");
    expect(r.container.textContent).toContain("Non ancora controllata");
    expect(r.container.textContent).toContain("Chiave fidata");
    expect(r.container.textContent).toContain("ancora nessuno");
    expect(r.container.textContent).not.toMatch(/PRIVATE KEY/);
    expect(r.container.querySelectorAll(NATIVE)).toHaveLength(0);
  });

  it("shows the key of a first connection and trusts it only on the person's click", async () => {
    const r = render(<Machines />);
    await waitFor(() => r.getByText("web"));
    const [first] = r.getAllByText("Prova la connessione");
    fireEvent.click(first as HTMLElement);
    await waitFor(() => r.getByText("Prima connessione: è la chiave della macchina?"));
    expect(r.container.textContent).toContain(FP_NEW);
    expect(calls.some(([n]) => n === "trustMachine")).toBe(false);
    fireEvent.click(r.getByText("Fidati di questa chiave"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "trustMachine")?.[1]).toEqual(["mach_1", FP_NEW]),
    );
  });

  it("a changed key: red, and replaced only after our own confirmation", async () => {
    const r = render(
      <>
        <Machines />
        <Dialogs />
      </>,
    );
    await waitFor(() => r.getByText("pi"));
    const buttons = r.getAllByText("Prova la connessione");
    fireEvent.click(buttons[1] as HTMLElement);
    await waitFor(() => r.getByText("Pericolo: la macchina ha risposto con un'altra chiave"));
    expect(r.container.querySelector(".mc-changed")?.getAttribute("role")).toBe("alert");
    expect(r.container.textContent).toContain(FP_OLD);
    fireEvent.click(r.getAllByText("Fidati della chiave nuova")[0] as HTMLElement);
    await waitFor(() => r.getByText("Fidarsi della chiave nuova di «pi»?"));
    expect(calls.some(([n]) => n === "trustMachine")).toBe(false);
  });

  it("adds a machine: a key made by RedGiant by default, who may use it chosen with our controls", async () => {
    const r = render(<Machines />);
    await waitFor(() => r.getByText("web"));
    fireEvent.click(r.getByText("Aggiungi una macchina"));
    await waitFor(() => r.getByText(t("mcEditorLead")));
    const input = (label: string) =>
      [...document.querySelectorAll(".mc-editor .ui-label")]
        .find((x) => x.textContent === label)
        ?.parentElement?.querySelector("input") as HTMLInputElement;
    fireEvent.input(input("Nome"), { target: { value: "lab" } });
    fireEvent.input(input("Indirizzo"), { target: { value: "lab.example.test" } });
    fireEvent.input(input("Utente"), { target: { value: "ann" } });
    fireEvent.input(input("Cartella di lavoro"), { target: { value: "/srv/lab" } });
    fireEvent.click(r.getByRole("switch", { name: "Tutti gli agenti" }));
    expect(document.querySelectorAll(NATIVE)).toHaveLength(0);
    fireEvent.click(r.getByText("Aggiungi"));
    await waitFor(() => expect(calls.some(([n]) => n === "addMachine")).toBe(true));
    expect(calls.find(([n]) => n === "addMachine")?.[1][0]).toEqual({
      name: "lab",
      host: "lab.example.test",
      port: 22,
      user: "ann",
      auth: "key",
      folder: "/srv/lab",
      access: { everyone: true, agents: [], projects: [] },
    });
  });

  it("every text is there in both languages", () => {
    for (const l of ["it", "en"] as const) {
      lang.value = l;
      for (const k of ["mcTitle", "mcTofuTitle", "mcChangedTitle", "tool_ssh", "toolDo_ssh"])
        expect(t(k as never)).not.toBe(k);
      // A Windows machine's folder is a drive path (p3.7.2): the help says so.
      expect(t("mcFolderHelp")).toContain("E:\\coding");
    }
  });
});
