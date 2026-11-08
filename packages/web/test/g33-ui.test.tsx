// @vitest-environment jsdom
// G33.1 (2026-11-07): the agent's settings in a centred window with the same head, X and bottom bar
// as every other; the step slider of the kit; descriptions RedGiant writes in the interface's
// language; plain words for modes, the summary, SearXNG and the history's technical details; the
// services' own logos.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang, roleText, t } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const platform = { sandbox: "host", metal: false, supervised: false, releases: [] };
/** A fake server: every method answers something plausible and is written down. */
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "models" || name === "platformChanges") return Promise.resolve([]);
        if (name === "platform") return Promise.resolve(platform);
        if (name === "agentPrompt") return Promise.resolve({ text: "", custom: false });
        if (name === "notes") return Promise.resolve({ text: "" });
        if (name === "sharedMemory") return Promise.resolve({ entries: [] });
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

const { Hierarchy } = await import("../src/components/Hierarchy.js");
const { Slider } = await import("../src/components/SettingsKit.js");
const { CompactionSettings } = await import("../src/components/CompactionSettings.js");
const { Platform } = await import("../src/components/Platform.js");
const { BrandIcon, hasBrand } = await import("../src/brands.js");
const { agents, platformInfo } = await import("../src/state.js");

const CHAT_ROLE =
  "The everyday assistant: answers anything, searches the web, makes and shows things.";
const team = () => {
  agents.value = [
    { id: "g", kind: "god", name: "God", parentId: null, projectId: null, status: "active" },
    {
      id: "c",
      kind: "assistant",
      name: "Chat",
      role: CHAT_ROLE,
      parentId: "g",
      projectId: null,
      status: "active",
    },
  ] as never;
};

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  team();
});
afterEach(cleanup);

describe("the agent's window", () => {
  it("opens centred like every window, with its tabs and its buttons in the bottom bar", async () => {
    const r = render(<Hierarchy />);
    expect(r.container.querySelector(".agent-panel")).toBeNull();
    fireEvent.click(r.getByText("Chat"));
    const win = r.container.querySelector(".ui-modal.agent-panel-modal.wide") as HTMLElement;
    expect(win).not.toBeNull();
    expect(win.getAttribute("role")).toBe("dialog");
    // The same head as every window: the title, a line under it, the X.
    expect(win.querySelector(":scope > header .ui-modal-title strong")?.textContent).toBe("Chat");
    expect(win.querySelector(":scope > header .ui-modal-sub")?.textContent).toContain(
      "Assistente personale",
    );
    expect(win.querySelector(":scope > header .ui-modal-x")).not.toBeNull();
    // Every tab, and every button the side panel had.
    const tabs = [...win.querySelectorAll("[role=tab]")].map((x) => x.textContent);
    expect(tabs).toEqual([
      "Generale",
      "Modello",
      "Limiti",
      "Comportamento",
      "Memoria",
      "Conoscenza",
      "Strumenti",
    ]);
    const foot = win.querySelector(":scope > .ui-modal-foot") as HTMLElement;
    expect(foot.textContent).toContain("Apri la sua conversazione");
    expect(foot.textContent).toContain("Ferma");
    // The description RedGiant wrote in English is shown, and editable, in Italian.
    const role = win.querySelector("textarea") as HTMLTextAreaElement;
    expect(role.value).toBe(dictionaries.it.chatAgentRole);
    fireEvent.click(r.getByText("Comportamento"));
    expect(win.textContent).toContain("Sola lettura");
    fireEvent.click(r.getByText("Memoria"));
    expect(win.querySelectorAll(".kit-slider input[type=range]")).toHaveLength(2);
    // Stopping still asks, then calls the server.
    vi.stubGlobal("confirm", () => true);
    fireEvent.click(r.getByText("Ferma"));
    await waitFor(() => expect(calls.map((c) => c[0])).toContain("stopAgent"));
    vi.unstubAllGlobals();
    // The X closes it.
    fireEvent.click(win.querySelector(".ui-modal-x") as HTMLElement);
    expect(r.container.querySelector(".agent-panel-modal")).toBeNull();
  });

  it("opens «Agent under it» above itself, and God has no Stop", () => {
    const r = render(<Hierarchy />);
    fireEvent.click(r.getAllByText("God")[0] as HTMLElement);
    const foot = r.container.querySelector(".ui-modal-foot") as HTMLElement;
    expect(foot.textContent).not.toContain("Ferma");
    fireEvent.click(r.getByText("Agente sotto", { selector: ".ui-modal-foot button" }));
    const windows = [...r.container.querySelectorAll(".ui-modal")];
    expect(windows).toHaveLength(2);
    // The later in the page is drawn on top.
    expect(windows[1]?.getAttribute("aria-label")).toBe("Aggiungi un agente sotto God");
  });

  it("shows built-in descriptions in the interface's language, in the tree and the cards", () => {
    const r = render(<Hierarchy />);
    expect(r.getByText(dictionaries.it.chatAgentRole)).toBeTruthy();
    expect(r.queryByText(CHAT_ROLE)).toBeNull();
    lang.value = "en";
    cleanup();
    const r2 = render(<Hierarchy />);
    expect(r2.getByText(CHAT_ROLE)).toBeTruthy();
    // The person's own words stay as they are.
    expect(roleText("Fa la spesa")).toBe("Fa la spesa");
  });
});

describe("the step slider", () => {
  it("is a native range with a notch per step and the value beside its name", () => {
    const seen: number[] = [];
    const r = render(
      <Slider
        label="Quando"
        value={80}
        min={50}
        max={95}
        step={5}
        format={(n) => `${n}%`}
        onChange={(v) => seen.push(v)}
      />,
    );
    const input = r.getByLabelText("Quando") as HTMLInputElement;
    expect(input.type).toBe("range");
    expect([input.min, input.max, input.step, input.value]).toEqual(["50", "95", "5", "80"]);
    expect(input.getAttribute("aria-valuetext")).toBe("80%");
    expect(r.container.querySelector("output")?.textContent).toBe("80%");
    const notches = r.container.querySelectorAll(".kit-slider-notch");
    expect(notches).toHaveLength(10);
    expect(r.container.querySelectorAll(".kit-slider-notch.on")).toHaveLength(7);
    fireEvent.input(input, { target: { value: "65" } });
    expect(seen).toEqual([65]);
  });

  it("the summary: two sliders, an example that follows them, and saving", async () => {
    const agent = { id: "c", name: "Chat", kind: "assistant", compaction: { at: 0.9, keep: 0.1 } };
    const r = render(<CompactionSettings agent={agent as never} />);
    expect(r.container.textContent).toContain("piena al 90%");
    expect(r.container.textContent).toContain("arriva a 90 pagine");
    expect(r.container.textContent).toContain("le ultime 10 pagine");
    const [at, keep] = [...r.container.querySelectorAll("input[type=range]")] as HTMLInputElement[];
    fireEvent.input(at as HTMLInputElement, { target: { value: "70" } });
    fireEvent.input(keep as HTMLInputElement, { target: { value: "0" } });
    expect(r.container.textContent).toContain("le trasforma tutte");
    fireEvent.click(r.getByText("Salva"));
    await waitFor(() =>
      expect(calls).toContainEqual(["configureAgent", ["c", { compaction: { at: 0.7, keep: 0 } }]]),
    );
  });
});

describe("plain words", () => {
  it("modes, SearXNG and the summary say what they mean", () => {
    expect(dictionaries.it.agentMode_readonly).toBe("Sola lettura");
    expect(dictionaries.en.agentMode_readonly).toBe("Read only");
    for (const l of ["it", "en"] as const) {
      expect(dictionaries[l].searchCard_searxng).not.toMatch(/sopra|above/);
      expect(dictionaries[l].searchHow_searxng_own).not.toMatch(/Avvia il motore|Start RedGiant/);
    }
    // The Chat's description as the server writes it.
    expect(dictionaries.en.chatAgentRole).toBe(CHAT_ROLE);
    expect(t("compactExplain")).toContain("come chi prende appunti");
  });

  it("the history's technical details in sentences, with no red for the normal setup", async () => {
    platformInfo.value = null;
    const r = render(<Platform />);
    await waitFor(() => expect(r.container.querySelector(".tech-facts")).not.toBeNull());
    const tech = r.container.querySelector(".tech-facts") as HTMLElement;
    expect(tech.textContent).toContain("Direttamente su questo computer");
    expect(tech.textContent).toContain("Non devi fare niente");
    expect(tech.textContent).not.toContain("Sandbox");
    expect(tech.querySelector(".danger, .tech-facts-warn")).toBeNull();
  });
});

describe("the services' logos", () => {
  it("draws the brand's own path, readable in both themes; none for services without one", () => {
    expect(hasBrand("github")).toBe(true);
    expect(hasBrand("slack")).toBe(false);
    const r = render(<BrandIcon id="github" size={20} />);
    const svg = r.container.querySelector("svg.brand-ico") as SVGElement;
    expect(svg.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(50);
    // GitHub's near-black is lightened for the dark theme.
    expect(svg.style.getPropertyValue("--b-l")).toBe("#181717");
    expect(svg.style.getPropertyValue("--b-d")).not.toBe("#181717");
    expect(render(<BrandIcon id="nothing" />).container.innerHTML).toBe("");
  });
});
