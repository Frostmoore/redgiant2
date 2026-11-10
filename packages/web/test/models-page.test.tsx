// @vitest-environment jsdom
// Settings > Models and subscriptions, drawn as the wizard (2026-11-06): the squares of every way,
// lit without a check mark, the windows with the real panels, the agents' model, web search and
// the local model as the wizard's step with what only Settings had.
import { KEY_PROVIDERS, SEARCH_PROVIDERS } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupState } from "../src/api.js";
import { lang } from "../src/i18n.js";

const calls: string[] = [];
/** A fake server: every method answers something plausible and is written down. */
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push(name);
        if (name === "localModels")
          return Promise.resolve({ models: [], files: [], diskFreeGb: 400 });
        if (name === "jobs") return Promise.resolve([]);
        if (name === "models")
          return Promise.resolve([{ provider: "anthropic", model: "claude-opus-5", effort: true }]);
        if (name === "modelsCatalog")
          return Promise.resolve({
            version: 1,
            updatedAt: "2026-11-10",
            source: "builtin",
            checkedAt: null,
          });
        if (name === "refreshModelsCatalog")
          return Promise.resolve({
            version: 2,
            updatedAt: "2026-12-01",
            source: "downloaded",
            checkedAt: "2026-12-01T10:00:00.000Z",
          });
        if (name === "claudeStatus" || name === "chatgptStatus")
          return Promise.resolve({ on: false, account: null, program: "bundled" });
        void args;
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { ModelsPage } = await import("../src/components/ModelsPage.js");

const state = (over: Partial<SetupState["config"]> = {}) =>
  ({
    config: {
      completed: true,
      subscriptions: { claude: true },
      defaultModel: { provider: "anthropic", model: "claude-opus-5", effort: "high" },
      searchProvider: "brave",
      ...over,
    },
    secretsSet: { keys: ["openai"], server: false, telegram: false },
    locked: {},
    providers: [],
    hardware: {
      os: "linux",
      cpu: "AMD Ryzen 9 7950X",
      cores: 32,
      ramGb: 64,
      freeRamGb: 40,
      diskFreeGb: 500,
      disks: [{ name: "/", ssd: true, bus: "nvme", freeGb: 500, totalGb: 1000 }],
      modelDisk: { docker: "/" },
      gpus: [{ name: "NVIDIA GeForce RTX 4080", vramGb: 16, vendor: "nvidia", integrated: false }],
      dockerGpu: true,
      gpuAccess: "",
      windowsEngine: false,
      suggestion: { engine: "cuda", maxModelGb: 12.8, kind: "gpu", vramGb: 16 },
    },
    names: { god: null, demigod: null, godPrompt: null },
    policy: { humanOnly: [], disabledDanger: [], dangers: [] },
    budgetUsd: null,
    canRunSearch: true,
  }) as unknown as SetupState;

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Settings > Models and subscriptions, as the wizard", () => {
  it("shows every way as a square, lit when connected and never with a check mark", () => {
    const r = render(<ModelsPage s={state()} reload={() => {}} />);
    const tile = (name: RegExp) => r.getByRole("button", { name });
    expect(r.getByRole("heading", { level: 1 }).textContent).toBe("Come deve pensare RedGiant?");
    expect(tile(/^Abbonamento Claude/).getAttribute("aria-pressed")).toBe("true");
    expect(tile(/^Abbonamento ChatGPT/).getAttribute("aria-pressed")).toBe("false");
    expect(tile(/^Una chiave API/).getAttribute("aria-pressed")).toBe("true");
    expect(tile(/^Un server tuo/).getAttribute("aria-pressed")).toBe("false");
    expect(tile(/^Un modello su questo computer/).getAttribute("aria-pressed")).toBe("false");
    // Each square draws only its own icon: no check mark next to the lit ones.
    for (const x of r.container.querySelectorAll(".wz-brain .wz-tile"))
      expect(x.querySelectorAll("svg")).toHaveLength(1);
    // The agents' model and the search providers are squares too.
    expect(tile(/^claude-opus-5/).getAttribute("aria-pressed")).toBe("true");
    expect(r.container.querySelectorAll(".mp-search .wz-tile")).toHaveLength(
      SEARCH_PROVIDERS.length,
    );
    expect(tile(/^Brave/).getAttribute("aria-pressed")).toBe("true");
  });

  it("says which models catalog is in use and updates it on request (3.5.4)", async () => {
    const r = render(<ModelsPage s={state()} reload={() => {}} />);
    const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString();
    await waitFor(() =>
      expect(r.getByText(`Catalogo dei modelli: aggiornato il ${day("2026-11-10")}`)).toBeTruthy(),
    );
    expect(r.getByText(/quello incluso in RedGiant · versione 1/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Aggiorna ora" }));
    await waitFor(() =>
      expect(r.getByText(`Catalogo dei modelli: aggiornato il ${day("2026-12-01")}`)).toBeTruthy(),
    );
    expect(r.getByText(/scaricato e firmato · versione 2/)).toBeTruthy();
    expect(calls).toContain("refreshModelsCatalog");
  });

  it("opens the real panels in a window: subscription, keys, server, agents' model, search", async () => {
    const r = render(<ModelsPage s={state()} reload={() => {}} />);
    const open = (name: RegExp) => fireEvent.click(r.getByRole("button", { name }));
    const dialog = () => r.getByRole("dialog");
    open(/^Abbonamento Claude/);
    expect(dialog().getAttribute("aria-label")).toBe("Abbonamento Claude");
    await waitFor(() => expect(calls).toContain("claudeStatus"));
    expect(r.getByRole("button", { name: /Apri la pagina di accesso di Anthropic/ })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Fatto" }));
    expect(r.queryByRole("dialog")).toBeNull();

    open(/^Una chiave API/);
    for (const p of KEY_PROVIDERS) expect(r.getByRole("button", { name: p.name })).toBeTruthy();
    expect(r.getByRole("button", { name: "Togli" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    open(/^Un server tuo/);
    expect(r.getByPlaceholderText("http://localhost:11434/v1")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    open(/^claude-opus-5/);
    await waitFor(() => expect(r.getByRole("combobox", { name: /Modello/ })).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });

    open(/^Brave/);
    expect(dialog().getAttribute("aria-label")).toBe("Brave Search");
  });

  it("has the local model as the wizard's step, with the bar and the engine of Settings", async () => {
    const r = render(<ModelsPage s={state()} reload={() => {}} />);
    await waitFor(() => expect(calls).toContain("localModels"));
    expect(r.getByRole("switch", { name: "SSD stream" })).toBeTruthy();
    expect(r.getByText("Dove stanno i modelli")).toBeTruthy();
    expect(r.container.querySelector(".wz-machine .wz-room .lm-room")).toBeTruthy();
    expect(r.getByText("Avanzate")).toBeTruthy();
    expect(r.getByText("Modelli scaricati")).toBeTruthy();
    expect(r.getByText("Altri modelli da Hugging Face")).toBeTruthy();
    // The local square takes the page there instead of a window.
    fireEvent.click(r.getByRole("button", { name: /^Un modello su questo computer/ }));
    expect(r.queryByRole("dialog")).toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
