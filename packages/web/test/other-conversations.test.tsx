// @vitest-environment jsdom
// p3.5.3 (the person's test of 3.5.1): the bell's «apri» opens a conversation the list does not
// have yet, an agent's chat shows what the same agent asks in another conversation, and the
// canvas opens for a conversation the page does not follow.
import type { Event } from "@redgiant/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: Record<string, unknown>[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: Record<string, unknown>) => sent.push(m) }),
  getApi: () => new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
}));

const state = await import("../src/state.js");
const { Bell } = await import("../src/components/Bell.js");
const { Chat } = await import("../src/components/Chat.js");
const {
  agents,
  applyMessage,
  approvals,
  lastError,
  openSessionById,
  questions,
  sessionRows,
  sessionView,
  sideViews,
  tabs,
} = state;

const question = (sessionId: string, requestId = "q1") => ({
  requestId,
  sessionId,
  agentId: "orch",
  agentName: "Orch",
  projectId: null,
  questions: [
    {
      question: "Vedi app.py nel Canvas?",
      header: "",
      multiSelect: false,
      options: [{ label: "Sì" }, { label: "No" }],
    },
  ],
  createdAt: "2026-11-09T10:00:00.000Z",
});
const row = (id: string, running = false, title: string | null = null) => ({
  id,
  agentId: "orch",
  projectId: null,
  createdAt: "2026-11-09T10:00:00.000Z",
  lastAt: null,
  title,
  pinned: false,
  archived: false,
  running,
});

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  tabs.value = [];
  sideViews.value = [];
  approvals.value = [];
  questions.value = [];
  sessionRows.value = [];
  lastError.value = null;
  agents.value = [{ id: "orch", name: "Orch", kind: "orchestrator" }] as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("«apri» (p3.5.3)", () => {
  it("opens the question's conversation even when the list does not have it", () => {
    questions.value = [question("sess_task")];
    const close = vi.fn();
    render(<Bell close={close} />);
    fireEvent.click(screen.getAllByText("apri")[0] as HTMLElement);
    return vi.waitFor(() => {
      expect(tabs.value.map((x) => x.id)).toContain("chat:sess_task");
      expect(close).toHaveBeenCalled();
    });
  });

  it("says so when a conversation cannot be opened at all", async () => {
    expect(await openSessionById("sess_gone")).toBe(false);
    expect(lastError.value).toMatch(/non si può aprire/);
    expect(tabs.value).toEqual([]);
  });

  it("opens a permission's conversation from the bell", () => {
    approvals.value = [
      {
        requestId: "p1",
        agentId: "orch",
        agentName: "Orch",
        projectId: null,
        tool: "bash",
        input: { command: "soffice --headless" },
        reasons: ["runs a command"],
        danger: [],
        createdAt: "2026-11-09T10:00:00.000Z",
        sessionId: "sess_perm",
      },
    ];
    render(<Bell close={() => {}} />);
    fireEvent.click(screen.getAllByText("apri")[0] as HTMLElement);
    return vi.waitFor(() => expect(tabs.value.map((x) => x.id)).toContain("chat:sess_perm"));
  });
});

describe("the same agent in another conversation (p3.5.3)", () => {
  it("shows its question in the chat the person watches, with the way there", () => {
    sessionRows.value = [row("sess_a", true, "Orch: Alpha"), row("sess_b", true, "Orch: Beta")];
    sessionView("sess_a").value = {
      events: [],
      text: "",
      thinking: "",
      state: "running",
      synced: true,
    };
    questions.value = [question("sess_b")];
    render(<Chat sessionId="sess_a" agentId="orch" />);
    expect(
      screen.getByText("Orch ti chiede qualcosa in un'altra conversazione: «Orch: Beta»"),
    ).toBeTruthy();
    expect(screen.getByText("Vedi app.py nel Canvas?")).toBeTruthy();
    // Asking already says it works there: no second line for it.
    expect(screen.queryByText(/sta lavorando in un'altra conversazione/)).toBe(null);
    fireEvent.click(screen.getByText("apri"));
    return vi.waitFor(() => expect(tabs.value.map((x) => x.id)).toContain("chat:sess_b"));
  });

  it("says when it works in another conversation", () => {
    sessionRows.value = [row("sess_a", false, "Orch: Alpha"), row("sess_b", true, "Orch: Beta")];
    render(<Chat sessionId="sess_a" agentId="orch" />);
    expect(
      screen.getByText("Orch sta lavorando in un'altra conversazione: «Orch: Beta»"),
    ).toBeTruthy();
  });

  it("learns the running state of a listed conversation it does not follow", () => {
    sessionRows.value = [row("sess_b")];
    applyMessage({
      type: "session.activity",
      sessionId: "sess_b",
      agentId: "orch",
      state: "running",
    });
    expect(sessionRows.value[0]?.running).toBe(true);
  });
});

describe("a task just handed over (p3.5.6)", () => {
  const ev = (seq: number, type: string, payload: Record<string, unknown>): Event =>
    ({
      id: `g${seq}`,
      seq,
      ts: "2026-11-10T10:00:00.000Z",
      ownerId: "me",
      projectId: null,
      agentId: "god",
      sessionId: "sess_god",
      type,
      payload,
      hash: "",
      prevHash: "",
    }) as unknown as Event;
  const started = ev(3, "subagent.started", {
    childSessionId: "sess_new",
    childAgentId: "fresh",
    via: "delegate",
    title: "Prepara il collaudo",
    task: "...",
  });
  const godChat = (events: Event[], state: "idle" | "running") => {
    agents.value = [{ id: "god", name: "God", kind: "god", parentId: null }] as never;
    sessionView("sess_god").value = { events, text: "", thinking: "", state, synced: true };
  };

  it("says it at once, before the list knows the conversation or its agent", () => {
    godChat([started], "running");
    render(<Chat sessionId="sess_god" agentId="god" />);
    expect(
      screen.getByText(/sta lavorando in un'altra conversazione: «Prepara il collaudo»/),
    ).toBeTruthy();
  });

  it("stops saying it when the tab records its end", () => {
    godChat(
      [started, ev(4, "subagent.ended", { childSessionId: "sess_new", status: "done" })],
      "running",
    );
    render(<Chat sessionId="sess_god" agentId="god" />);
    expect(screen.queryByText(/sta lavorando in un'altra conversazione/)).toBe(null);
  });

  it("trusts the list once it has the conversation, and ignores a tab a restart left open", () => {
    godChat([started], "idle");
    render(<Chat sessionId="sess_god" agentId="god" />);
    expect(screen.queryByText(/sta lavorando in un'altra conversazione/)).toBe(null);
    cleanup();
    godChat([started], "idle");
    sessionRows.value = [
      { ...row("sess_new", true, "God: Prepara il collaudo"), agentId: "fresh" },
    ];
    render(<Chat sessionId="sess_god" agentId="god" />);
    expect(screen.getAllByText(/sta lavorando in un'altra conversazione/)).toHaveLength(1);
  });
});

describe("the canvas for a conversation the page does not follow (p3.5.3)", () => {
  const show = (seq: number): Event =>
    ({
      id: `e${seq}`,
      seq,
      ts: "2026-11-09T10:00:00.000Z",
      ownerId: "me",
      projectId: null,
      agentId: "orch",
      sessionId: "sess_task",
      type: "canvas.show",
      payload: { title: "app.py", target: { kind: "file", scope: "collaudo", path: "app.py" } },
      hash: "",
      prevHash: "",
    }) as unknown as Event;

  it("opens the file once, also when the followed copy arrives too", () => {
    applyMessage({ type: "canvas.open", sessionId: "sess_task", event: show(7) });
    expect(sideViews.value.map((v) => v.title)).toEqual(["app.py"]);
    // The person closes it, then the same event comes through a follow: it stays closed.
    sideViews.value = [];
    sessionView("sess_task").value = {
      events: [],
      text: "",
      thinking: "",
      state: "running",
      synced: true,
    };
    applyMessage({ type: "event", sessionId: "sess_task", event: show(7) });
    expect(sideViews.value).toEqual([]);
    applyMessage({ type: "canvas.open", sessionId: "sess_task", event: show(9) });
    expect(sideViews.value.map((v) => v.title)).toEqual(["app.py"]);
  });
});
