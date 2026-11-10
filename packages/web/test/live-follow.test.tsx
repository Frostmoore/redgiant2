// @vitest-environment jsdom
// p3.5.4 (the person on 3.5.3: «I have to reload almost every turn»): several parts of the page
// follow the same conversation (its tab, a sub-agent's tab, the row of tabs above it), and the
// server keeps one follow per connection. Before, the first part letting go stopped the
// conversation for all the others: an orchestrator's tab looked at and left, then nothing came,
// with spinners and «Legge il contesto» left on turns already closed.
import type { Event } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Live } from "../src/api.js";
import { lang } from "../src/i18n.js";

/** A WebSocket the test drives. */
class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    if (data !== "PING") this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  hear(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  welcome() {
    this.hear({ type: "welcome", protocolVersion: 1, ownerId: "me" });
  }
  follows() {
    return this.sent.filter((m) => m.type === "session.follow" || m.type === "session.unfollow");
  }
}
const socket = () => FakeSocket.all.at(-1) as FakeSocket;

let live: Live | undefined;
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => live,
  getApi: () => new Proxy({}, { get: () => () => new Promise(() => {}) }) as never,
}));
const state = await import("../src/state.js");
const { Chat } = await import("../src/components/Chat.js");
const { agents, applyMessage, sessionRows, sessionView, subPath, questions, approvals } = state;

let seq = 0;
const ev = (sessionId: string, type: string, payload: unknown, agentId = "god", at?: number) =>
  ({
    id: `e${at ?? ++seq}`,
    seq: at ?? seq,
    ts: new Date(Date.UTC(2026, 10, 10, 10, 0, at ?? seq)).toISOString(),
    ownerId: "me",
    projectId: null,
    agentId,
    sessionId,
    type,
    payload,
    hash: "",
    prevHash: "",
  }) as unknown as Event;

beforeEach(() => {
  lang.value = "it";
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.all = [];
  subPath.value = {};
  questions.value = [];
  approvals.value = [];
  sessionRows.value = [];
  agents.value = [
    { id: "god", name: "God", kind: "god", parentId: null },
    { id: "orch", name: "Lead", kind: "orchestrator", parentId: "god" },
  ] as never;
  Element.prototype.scrollIntoView = vi.fn();
  live = new Live(
    "token",
    applyMessage,
    () => {},
    () => {},
  );
  socket().open();
  socket().welcome();
});
afterEach(() => {
  cleanup();
  live?.close();
  live = undefined;
  vi.unstubAllGlobals();
});

describe("following a conversation from several parts of the page (p3.5.4)", () => {
  it("tells the server only the first follow and the last unfollow", () => {
    const l = live as Live;
    l.send({ type: "session.follow", sessionId: "s1" });
    l.send({ type: "session.follow", sessionId: "s1" });
    l.send({ type: "session.unfollow", sessionId: "s1" });
    // One part still follows it: the server keeps sending.
    expect(socket().follows()).toEqual([{ type: "session.follow", sessionId: "s1" }]);
    socket().hear({
      type: "event",
      sessionId: "s1",
      event: ev("s1", "message.user", {}, "god", 7),
    });
    l.send({ type: "session.unfollow", sessionId: "s1" });
    expect(socket().follows().at(-1)).toEqual({ type: "session.unfollow", sessionId: "s1" });
    // An unfollow too many changes nothing.
    l.send({ type: "session.unfollow", sessionId: "s1" });
    expect(socket().follows()).toHaveLength(2);
    // Followed again: only what came after what the page has.
    l.send({ type: "session.follow", sessionId: "s1" });
    expect(socket().follows().at(-1)).toEqual({
      type: "session.follow",
      sessionId: "s1",
      afterSeq: 7,
    });
  });

  it("follows each conversation once on a new connection, from what the page has", () => {
    const l = live as Live;
    l.send({ type: "session.follow", sessionId: "s1" });
    l.send({ type: "session.follow", sessionId: "s1" });
    socket().hear({
      type: "event",
      sessionId: "s1",
      event: ev("s1", "message.user", {}, "god", 4),
    });
    socket().onclose?.({ code: 1006 });
    // Asked while the connection is down: not queued, the welcome follows it.
    l.send({ type: "session.follow", sessionId: "s2" });
    const first = socket();
    return vi.waitFor(
      () => {
        expect(socket()).not.toBe(first);
        socket().open();
        socket().welcome();
        expect(socket().follows()).toEqual([
          { type: "session.follow", sessionId: "s1", afterSeq: 4 },
          { type: "session.follow", sessionId: "s2" },
        ]);
      },
      { timeout: 3000 },
    );
  });

  it("keeps hearing the orchestrator after its tab in God's chat was looked at and left", () => {
    sessionView("god_s").value = {
      events: [
        ev("god_s", "subagent.started", {
          childSessionId: "orch_s",
          childAgentId: "orch",
          callId: "c1",
          via: "delegate",
          title: "Files",
          task: "List the files",
        }),
      ],
      text: "",
      thinking: "",
      state: "idle",
      synced: true,
    };
    // God's chat, and the orchestrator's conversation in a tab of its own.
    const god = render(<Chat sessionId="god_s" agentId="god" />);
    const own = render(<Chat sessionId="orch_s" agentId="orch" />);
    fireEvent.click(god.getByText("Files"));
    fireEvent.click(god.getByText("Agente principale"));
    own.unmount();
    // God's row of tabs still shows the orchestrator: the server must still send it.
    const last = socket()
      .follows()
      .filter((m) => m.sessionId === "orch_s")
      .at(-1);
    expect(last?.type).toBe("session.follow");
  });

  it("puts an event older than the last one in its place", () => {
    sessionView("s3").value = { events: [], text: "", thinking: "", state: "idle", synced: true };
    for (const at of [1, 2, 5, 3, 4, 5])
      applyMessage({
        type: "event",
        sessionId: "s3",
        event: ev("s3", "message.user", {}, "god", at),
      });
    expect(sessionView("s3").value.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("God's chat says what the agents under it do (p3.5.4)", () => {
  const row = (id: string, agentId: string, running: boolean, title: string) => ({
    id,
    agentId,
    projectId: null,
    createdAt: "2026-11-10T10:00:00.000Z",
    lastAt: null,
    title,
    pinned: false,
    archived: false,
    running,
  });

  it("an orchestrator at work on a task, and its question", () => {
    sessionView("god_s").value = {
      events: [],
      text: "",
      thinking: "",
      state: "idle",
      synced: true,
    };
    sessionRows.value = [
      row("god_s", "god", false, "Collaudo"),
      row("orch_s", "orch", true, "Bilancio"),
    ];
    const r = render(<Chat sessionId="god_s" agentId="god" />);
    expect(r.getByText("Lead sta lavorando in un'altra conversazione: «Bilancio»")).toBeTruthy();
    questions.value = [
      {
        requestId: "q1",
        sessionId: "orch_s",
        agentId: "orch",
        agentName: "Lead",
        projectId: null,
        questions: [
          {
            question: "Vedi il bilancio?",
            header: "",
            multiSelect: false,
            options: [{ label: "Sì" }, { label: "No" }],
          },
        ],
        createdAt: "2026-11-10T10:00:00.000Z",
      },
    ] as never;
    r.unmount();
    const again = render(<Chat sessionId="god_s" agentId="god" />);
    expect(
      again.getByText("Lead ti chiede qualcosa in un'altra conversazione: «Bilancio»"),
    ).toBeTruthy();
    expect(again.queryByText(/sta lavorando in un'altra conversazione/)).toBe(null);
  });
});
