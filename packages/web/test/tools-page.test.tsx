// @vitest-environment jsdom
// G34.5: the tools page (a switch per tool for every agent, the essential ones locked with why, the
// weight on top) and an agent's Tools tab (as for everyone / always on / off); the history's
// sentences; every catalog entry has its words in both languages; no check marks.
import type { ToolsView } from "@redgiant/protocol";
import { TOOL_CATALOG } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const entry = (
  id: string,
  group: string,
  tokens: number,
  global: boolean,
  extra: Record<string, unknown> = {},
) => ({
  id,
  group,
  essential: false,
  tools: [id],
  chars: Math.round(tokens * 3.5),
  tokens,
  global,
  ...extra,
});
const ALL: ToolsView = {
  agentId: null,
  entries: [
    entry("read_file", "files", 120, true, { essential: true }),
    entry("grep", "files", 107, true),
    entry("web_search", "web", 73, false),
    entry("browser", "web", 1200, true, { tools: ["browser_open", "browser_click"] }),
    entry("complete_task", "agents", 115, true, { essential: true }),
  ] as ToolsView["entries"],
  total: 1542,
  saved: 73,
};
const AGENT: ToolsView = {
  agentId: "a1",
  entries: ALL.entries.map((e) => ({
    ...e,
    own: e.essential ? null : e.id === "grep" ? "off" : null,
    on: e.essential || (e.id === "grep" ? false : e.global),
  })),
  total: 1435,
  saved: 180,
};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "toolsView") return Promise.resolve(args[0] ? AGENT : ALL);
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

const { ToolsPage } = await import("../src/components/ToolsPage.js");
const { AgentTools } = await import("../src/components/AgentTools.js");
const { describeChange } = await import("../src/changes.js");

const CHECK = 'path[d="M20 6L9 17l-5-5"]';

beforeEach(() => {
  calls.length = 0;
  lang.value = "it";
});
afterEach(cleanup);

describe("the tools page (G34.5)", () => {
  it("shows every tool with its weight, the total and the saving, essential ones locked", async () => {
    const r = render(<ToolsPage />);
    await waitFor(() => expect(r.getByText("Cercare sul web")).toBeTruthy());
    expect(r.getByText("Circa 1540 token a ogni messaggio")).toBeTruthy();
    expect(r.getByText("Spenti: 70 token risparmiati a ogni messaggio")).toBeTruthy();
    expect(r.getByText("4 su 5 accesi")).toBeTruthy();
    expect(r.getByText(/Le modifiche valgono dalle conversazioni nuove/)).toBeTruthy();
    // Groups with their names.
    expect(r.getByText("File e codice")).toBeTruthy();
    expect(r.getByText("Gestione degli agenti")).toBeTruthy();
    expect(r.getAllByText("circa 1200 token a ogni messaggio")).toHaveLength(1);
    // The essential ones: locked switch and why.
    const read = r.getByRole("switch", { name: "Leggere i file" }) as HTMLButtonElement;
    expect(read.disabled).toBe(true);
    expect(read.getAttribute("aria-checked")).toBe("true");
    expect(r.getByText(/Serve sempre: un compito si chiude solo così/)).toBeTruthy();
    expect(r.container.querySelector(CHECK)).toBeNull();
  });

  it("switches a tool off for every agent, keeping the others as they are", async () => {
    const r = render(<ToolsPage />);
    await waitFor(() => expect(r.getByRole("switch", { name: "Browser" })).toBeTruthy());
    fireEvent.click(r.getByRole("switch", { name: "Browser" }));
    await waitFor(() => expect(calls.some(([n]) => n === "setToolsOff")).toBe(true));
    const [, args] = calls.find(([n]) => n === "setToolsOff") ?? [];
    expect(args?.[0]).toEqual(["web_search", "browser"]);
    // Clicking a locked switch sends nothing.
    calls.length = 0;
    fireEvent.click(r.getByRole("switch", { name: "Leggere i file" }));
    expect(calls.some(([n]) => n === "setToolsOff")).toBe(false);
  });
});

describe("an agent's Tools tab (G34.5)", () => {
  const agent = { id: "a1", name: "Coder", kind: "agent" } as never;

  it("offers as for everyone / always on / off, with the agent's total", async () => {
    const r = render(<AgentTools agent={agent} />);
    await waitFor(() =>
      expect(r.getByText("Coder: circa 1440 token a ogni messaggio")).toBeTruthy(),
    );
    const grep = r.container.querySelector('[data-tool="grep"]') as HTMLElement;
    const buttons = [...grep.querySelectorAll("button")].map((b) => [
      b.textContent,
      b.getAttribute("aria-pressed"),
    ]);
    expect(buttons).toEqual([
      ["Come per tutti (acceso)", "false"],
      ["Sempre acceso", "false"],
      ["Spento", "true"],
    ]);
    const web = r.container.querySelector('[data-tool="web_search"]') as HTMLElement;
    expect(web.querySelector("button")?.textContent).toBe("Come per tutti (spento)");
    // Essential: no choice, only why.
    const read = r.container.querySelector('[data-tool="read_file"]') as HTMLElement;
    expect(read.querySelectorAll("button")).toHaveLength(0);
    expect(read.textContent).toContain("Serve sempre:");
    fireEvent.click([...web.querySelectorAll("button")][1] as HTMLElement);
    await waitFor(() => expect(calls.some(([n]) => n === "setAgentTools")).toBe(true));
    expect(calls.find(([n]) => n === "setAgentTools")?.[1]).toEqual(["a1", { web_search: "on" }]);
    expect(r.container.querySelector(CHECK)).toBeNull();
  });
});

describe("words (G34.5)", () => {
  it("has a name and a sentence for every tool, and why for the essential ones", () => {
    for (const d of [dictionaries.en, dictionaries.it]) {
      const words = d as Record<string, string>;
      for (const e of TOOL_CATALOG) {
        expect(words[`tool_${e.id}`], e.id).toBeTruthy();
        expect(words[`toolDo_${e.id}`], e.id).toBeTruthy();
        if (e.essential) expect(words[`toolWhy_${e.id}`], e.id).toBeTruthy();
      }
    }
  });

  it("tells the history's tool changes in sentences", () => {
    const names = {
      agent: (id: string) => (id === "a1" ? "Coder" : id),
      project: (id: string) => id,
    };
    const base = {
      id: "c",
      ownerId: "me",
      kind: "config" as const,
      change: "",
      stage: "promoted" as const,
      detail: null,
      by: "human",
      createdAt: "",
      updatedAt: "",
    };
    expect(
      describeChange(
        {
          ...base,
          target: "tools",
          before: { off: ["fetch"], agents: {} },
          after: { off: ["web_search", "browser"], agents: {} },
        },
        names,
      ),
    ).toEqual([
      "Strumenti spenti per tutti gli agenti: Cercare sul web, Browser",
      "Strumenti riaccesi per tutti gli agenti: Aprire pagine web",
    ]);
    expect(
      describeChange(
        {
          ...base,
          target: "tools:a1",
          before: { off: [], agents: { a1: { grep: "off" } } },
          after: { off: [], agents: { a1: { fetch: "on" } } },
        },
        names,
      ),
    ).toEqual([
      "Coder: sempre accesi: Aprire pagine web",
      "Coder: di nuovo come per tutti: Cercare dentro i file",
    ]);
  });
});

describe("finding a tool (p3.5.3)", () => {
  it("shows each tool's real name and filters by words, name and what it does", async () => {
    const view = render(<ToolsPage />);
    await waitFor(() => expect(view.container.querySelectorAll(".tl-row")).toHaveLength(5));
    // The command beside its name in words, as the chat's lines and request_tool say it.
    const ids = [...view.container.querySelectorAll(".tl-id")].map((x) => x.textContent);
    expect(ids).toEqual(["read_file", "grep", "web_search", "browser", "complete_task"]);
    const box = view.container.querySelector(".tl-search input") as HTMLInputElement;
    const shown = () =>
      [...view.container.querySelectorAll(".tl-row")].map((r) => r.getAttribute("data-tool"));
    // The real name, with or without its underscore; case does not matter.
    fireEvent.input(box, { target: { value: "WEB_search" } });
    expect(shown()).toEqual(["web_search"]);
    fireEvent.input(box, { target: { value: "complete task" } });
    expect(shown()).toEqual(["complete_task"]);
    // Groups without any go.
    expect(view.container.querySelectorAll(".tl-section")).toHaveLength(1);
    // Nothing found: a line says so.
    fireEvent.input(box, { target: { value: "zzz" } });
    expect(shown()).toEqual([]);
    expect(view.container.querySelector(".tl-none")?.textContent).toBe(
      "Nessuno strumento per «zzz».",
    );
    fireEvent.input(box, { target: { value: "" } });
    expect(shown()).toHaveLength(5);
  });

  it("ignores accents and finds by the name in words and by what it does", async () => {
    const { findTools, toolName, toolDoes } = await import("../src/components/ToolsPage.js");
    const name = toolName("grep");
    const plain = name.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
    expect(findTools(ALL.entries, plain).map((e) => e.id)).toContain("grep");
    const word =
      toolDoes("web_search")
        .split(/\s+/)
        .find((w) => w.length > 5) ?? "";
    expect(findTools(ALL.entries, word).map((e) => e.id)).toContain("web_search");
    // An accented query on plain words («Cercare dentro i file»): still found.
    expect(findTools(ALL.entries, "cércàre dentro").map((e) => e.id)).toEqual(["grep"]);
  });

  it("has the same search in an agent's Tools tab", async () => {
    const view = render(<AgentTools agent={{ id: "a1", name: "Ada" } as never} />);
    await waitFor(() => expect(view.container.querySelectorAll(".tl-row")).toHaveLength(5));
    expect(view.container.querySelector('[data-tool="grep"] .tl-id')?.textContent).toBe("grep");
    fireEvent.input(view.container.querySelector(".tl-search input") as HTMLInputElement, {
      target: { value: "grep" },
    });
    expect(view.container.querySelectorAll(".tl-row")).toHaveLength(1);
  });
});
