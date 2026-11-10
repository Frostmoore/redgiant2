// @vitest-environment jsdom
// p3.5.4 (the person, 2026-11-10): a project's name opens its orchestrator's chat, a task handed
// over shows up in the bar at once, and the composer's commands live in the «…» panel.
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const { api, sent } = vi.hoisted(() => ({
  api: {} as Record<
    "sessions" | "chats" | "startSession" | "configureAgent" | "createRoom" | "setup",
    ReturnType<typeof vi.fn>
  >,
  sent: [] as Record<string, unknown>[],
}));
vi.mock("../src/api.js", async (orig) => {
  const real = await orig<typeof import("../src/api.js")>();
  class Api {
    constructor() {
      // Every call the test does not set answers an empty list.
      // biome-ignore lint/correctness/noConstructorReturn: a stand-in for the whole API
      return new Proxy(
        {},
        { get: (_t, name) => (api as Record<string, unknown>)[name as string] ?? (async () => []) },
      );
    }
  }
  class Live {
    send(m: Record<string, unknown>) {
      sent.push(m);
    }
    close() {}
  }
  return { ...real, Api, Live };
});
const setUp = () => {
  Object.assign(api, {
    sessions: vi.fn(async (): Promise<unknown[]> => []),
    chats: vi.fn(async () => []),
    startSession: vi.fn(async () => ({ sessionId: "sess_new" })),
    configureAgent: vi.fn(async () => ({})),
    createRoom: vi.fn(async () => ({ id: "room1", title: "Room" })),
    setup: vi.fn(async () => ({ config: { completed: true, remote: true } })),
  });
};
setUp();

const state = await import("../src/state.js");
const { Sidebar } = await import("../src/components/Sidebar.js");
const { Chat } = await import("../src/components/Chat.js");
const { Composer } = await import("../src/components/Composer.js");
const { activeTab, agents, applyMessage, projects, sessionRows, sessionView, tabs } = state;
beforeAll(async () => {
  await state.signIn("token").catch(() => {});
});

const row = (
  id: string,
  agentId: string,
  lastAt: string,
  extra: Partial<import("../src/state.js").SessionRow> = {},
) => ({
  id,
  agentId,
  projectId: "demo",
  createdAt: "2026-11-10T08:00:00.000Z",
  lastAt,
  title: `Title ${id}`,
  pinned: false,
  archived: false,
  running: false,
  ...extra,
});

beforeEach(() => {
  lang.value = "it";
  localStorage.setItem("rg.remoteNotice", "hidden");
  localStorage.setItem("rg.barSection", "projects");
  sent.length = 0;
  tabs.value = [];
  activeTab.value = null;
  sessionRows.value = [];
  projects.value = [{ id: "demo", name: "Demo" }] as never;
  agents.value = [
    { id: "god", name: "God", kind: "god", status: "active" },
    { id: "orch", name: "Demo lead", kind: "orchestrator", projectId: "demo", status: "active" },
    { id: "coder", name: "Coder", kind: "agent", projectId: "demo", status: "active" },
  ] as never;
  setUp();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a project's name opens its orchestrator (p3.5.4)", () => {
  it("opens the latest conversation and shows the project's conversations", () => {
    sessionRows.value = [
      row("sess_old", "orch", "2026-11-10T09:00:00.000Z"),
      row("sess_late", "orch", "2026-11-10T10:00:00.000Z"),
      row("sess_arch", "orch", "2026-11-10T11:00:00.000Z", { archived: true }),
    ];
    render(<Sidebar />);
    expect(screen.queryByText("Title sess_late")).toBe(null);
    fireEvent.click(screen.getByText("Demo"));
    expect(activeTab.value).toBe("chat:sess_late");
    expect(screen.getByText("Title sess_late")).toBeTruthy();
    expect(api.startSession).not.toHaveBeenCalled();
    // A second click keeps the list open.
    fireEvent.click(screen.getByText("Demo"));
    expect(screen.getByText("Title sess_late")).toBeTruthy();
  });

  it("starts a conversation with the orchestrator when there is none", async () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText("Demo"));
    await vi.waitFor(() => expect(activeTab.value).toBe("chat:sess_new"));
    expect(api.startSession).toHaveBeenCalledWith("orch");
  });

  it("the arrow only folds and unfolds", () => {
    sessionRows.value = [row("sess_old", "orch", "2026-11-10T09:00:00.000Z")];
    render(<Sidebar />);
    const arrow = screen.getByLabelText("Apri: Demo");
    fireEvent.click(arrow);
    expect(arrow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Title sess_old")).toBeTruthy();
    expect(activeTab.value).toBe(null);
    fireEvent.click(screen.getByLabelText("Chiudi: Demo"));
    expect(screen.queryByText("Title sess_old")).toBe(null);
    expect(api.startSession).not.toHaveBeenCalled();
  });
});

describe("a task handed over shows up at once (p3.5.4)", () => {
  it("fetches an unknown conversation that starts and lists it as a task", async () => {
    sessionRows.value = [row("sess_old", "orch", "2026-11-10T09:00:00.000Z")];
    render(<Sidebar />);
    fireEvent.click(screen.getByLabelText("Apri: Demo"));
    const task = row("sess_task", "coder", "2026-11-10T10:00:00.000Z", {
      title: "Demo lead: Add the --json flag",
      task: "Add the --json flag",
      running: true,
    });
    api.sessions.mockImplementation(async () => [sessionRows.value[0], task]);
    applyMessage({
      type: "session.activity",
      sessionId: "sess_task",
      agentId: "coder",
      state: "running",
    });
    await vi.waitFor(() => expect(screen.getByText("Compito: Add the --json flag")).toBeTruthy());
    const line = screen.getByText("Compito: Add the --json flag").closest(".session-row");
    expect(line?.classList.contains("task")).toBe(true);
    expect(line?.querySelector(".dot.running")?.getAttribute("aria-label")).toBe("al lavoro");
    expect(line?.textContent).toContain("Coder");
    fireEvent.click(screen.getByText("Compito: Add the --json flag"));
    expect(activeTab.value).toBe("chat:sess_task");
  });

  it("fetches a known conversation again when it takes a task or ends one", async () => {
    sessionRows.value = [row("sess_w", "coder", "2026-11-10T09:00:00.000Z")];
    api.sessions.mockImplementation(async () => [
      { ...sessionRows.value[0], task: "Write the tests", running: true },
    ]);
    applyMessage({
      type: "session.activity",
      sessionId: "sess_w",
      agentId: "coder",
      state: "running",
    });
    expect(sessionRows.value[0]?.running).toBe(true);
    await vi.waitFor(() => expect(sessionRows.value[0]?.task).toBe("Write the tests"));
    api.sessions.mockImplementation(async () => [{ ...sessionRows.value[0], task: null }]);
    applyMessage({
      type: "session.activity",
      sessionId: "sess_w",
      agentId: "coder",
      state: "idle",
    });
    await vi.waitFor(() => expect(sessionRows.value[0]?.task).toBe(null));
    // A turn of a conversation with no task that stops: nothing to fetch.
    const calls = api.sessions.mock.calls.length;
    applyMessage({
      type: "session.activity",
      sessionId: "sess_w",
      agentId: "coder",
      state: "idle",
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(api.sessions.mock.calls.length).toBe(calls);
  });
});

describe("the composer's «…» (p3.5.4)", () => {
  const box = (changed = false) =>
    render(
      <Composer
        placeholder="Scrivi"
        running={false}
        lang="it"
        onSend={() => {}}
        moreChanged={changed}
        more={(close) => (
          <>
            <button type="button">Uno</button>
            <select aria-label="Menu">
              <option>a</option>
            </select>
            <button type="button" onClick={close}>
              Due
            </button>
            <button type="button" disabled>
              Spento
            </button>
          </>
        )}
      />,
    );

  it("opens next to Attach, moves with the arrows and closes with Esc", () => {
    box();
    const more = screen.getByLabelText("Altri comandi");
    expect(more.closest(".box-bar")).toBeTruthy();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.querySelector(".more-mark")).toBe(null);
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("dialog", { name: "Altri comandi" });
    expect(document.activeElement?.textContent).toBe("Uno");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.tagName).toBe("SELECT");
    // A menu keeps its own arrows.
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.tagName).toBe("SELECT");
    (screen.getByText("Due") as HTMLElement).focus();
    // The switched-off command is skipped; the end goes back to the start.
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Uno");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement?.textContent).toBe("Due");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBe(null);
    expect(document.activeElement).toBe(more);
  });

  it("closes when a command asks or on a click elsewhere, and marks a change", () => {
    box(true);
    const more = screen.getByLabelText("Altri comandi (qualcosa non è come all'inizio)");
    expect(more.querySelector(".more-mark")).toBeTruthy();
    fireEvent.click(more);
    fireEvent.click(screen.getByText("Due"));
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("holds the chat's mode, model, Meanwhile, Summarise and Add an agent", async () => {
    sessionRows.value = [row("sess_c", "orch", "2026-11-10T09:00:00.000Z")];
    agents.value = [
      {
        id: "orch",
        name: "Demo lead",
        kind: "orchestrator",
        projectId: "demo",
        status: "active",
        mode: "plan",
        model: { provider: "fake", model: "claude-opus-5-5", effort: "medium" },
      },
    ] as never;
    const msg = (seq: number, type: string, payload: unknown) => ({
      id: `e${seq}`,
      seq,
      ts: "2026-11-10T09:00:00.000Z",
      ownerId: "me",
      projectId: "demo",
      agentId: "orch",
      sessionId: "sess_c",
      type,
      payload,
      hash: "",
      prevHash: "",
    });
    const answer = (text: string) => ({
      parts: [{ type: "text", text }],
      stopReason: "end_turn",
      provider: "fake",
      model: "claude-opus-5-5",
      metrics: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
    });
    sessionView("sess_c").value = {
      events: [
        msg(1, "message.user", { text: "Ciao" }),
        msg(2, "message.assistant", answer("Eccomi")),
        msg(3, "message.user", { text: "Ancora" }),
        msg(4, "message.assistant", answer("Sì")),
      ],
      text: "",
      thinking: "",
      state: "idle",
      synced: true,
    } as never;
    const { container } = render(<Chat sessionId="sess_c" agentId="orch" />);
    // Nothing of it in the composer's row: Attach, «…», send.
    const bar = container.querySelector(".box-bar") as HTMLElement;
    expect(bar.querySelector(".mode, select")).toBe(null);
    const more = screen.getByLabelText("Altri comandi (qualcosa non è come all'inizio)");
    fireEvent.click(more);
    expect(screen.getByText("Modalità: Piano")).toBeTruthy();
    expect(screen.getByText("Modello: Opus 5.5 · Medio")).toBeTruthy();
    expect(screen.getByLabelText("Modello")).toBeTruthy();
    expect(screen.getByText("Intanto")).toBeTruthy();
    expect(screen.getByText("Riassumi")).toBeTruthy();
    expect(screen.getByText("Aggiungi un agente")).toBeTruthy();
    const plan = screen.getByText("Piano", { selector: ".more-seg" });
    expect(plan.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Automatico", { selector: ".more-seg" }));
    await vi.waitFor(() =>
      expect(api.configureAgent).toHaveBeenCalledWith("orch", { mode: "auto" }),
    );
    // Meanwhile opens its panel and the menu goes away.
    fireEvent.click(screen.getByText("Intanto"));
    expect(screen.queryByRole("dialog")).toBe(null);
    fireEvent.click(more);
    expect(
      screen
        .getByText("Intanto", { selector: ".more-name" })
        .closest("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("aperto")).toBeTruthy();
    fireEvent.click(screen.getByText("Aggiungi un agente"));
    await vi.waitFor(() =>
      expect(api.createRoom).toHaveBeenCalledWith({
        members: [],
        from: { agentId: "orch", sessionId: "sess_c" },
      }),
    );
  });
});
