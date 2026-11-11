// @vitest-environment jsdom
// The «Passi» panel follows the latest update_todos call as soon as it is recorded (3.5.7): the
// results of one message are recorded only after all its calls ran, so the panel that waited for
// the result stayed one update behind while a long command ran beside the list.
import type { Event } from "@redgiant/protocol";
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: () => {} }),
  getApi: () => new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
}));

const state = await import("../src/state.js");
const { Chat, latestTodos } = await import("../src/components/Chat.js");
const { buildItems, sessionView, agents, sessionRows, approvals, subPath, applyMessage } = state;

let seq = 0;
const ev = (type: string, payload: unknown): Event =>
  ({
    id: `e${++seq}`,
    seq,
    ts: new Date(Date.UTC(2026, 10, 11, 10, 0, seq)).toISOString(),
    ownerId: "me",
    projectId: null,
    agentId: "god",
    sessionId: "s1",
    type,
    payload,
    hash: "",
    prevHash: "",
  }) as unknown as Event;
const metrics = {
  inputTokens: 1000,
  outputTokens: 200,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  contextUsed: 1200,
  contextWindow: 100000,
  startedAt: "2026-11-11T10:00:00.000Z",
  source: "server",
};
const asks = (...calls: [string, string, unknown][]) =>
  ev("message.assistant", {
    parts: calls.map(([callId, name, input]) => ({ type: "tool_call", callId, name, input })),
    metrics,
    costUsd: 0,
    provider: "fake",
    model: "m",
    stopReason: "tool_use",
  });
/** A list of 17 steps with `done` completed and the next in progress. */
const list = (done: number) => ({
  todos: Array.from({ length: 17 }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i < done ? "completed" : i === done ? "in_progress" : "pending",
  })),
});
const call = (callId: string, tool: string, input: unknown) =>
  ev("tool.call", { callId, tool, input });
const result = (callId: string, output: string, ok = true) =>
  ev("tool.result", { callId, ok, output });

beforeEach(() => {
  lang.value = "it";
  seq = 0;
  subPath.value = {};
  approvals.value = [];
  sessionRows.value = [];
  agents.value = [{ id: "god", name: "God", kind: "god" }] as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("the list of steps", () => {
  it("shows the latest list while its result waits for a command beside it", () => {
    // In the order the server sends them: the list and a command in one message, both calls
    // recorded first, both results only once the command is over.
    const before = [
      ev("message.user", { text: "go" }),
      asks(["t1", "update_todos", list(12)]),
      call("t1", "update_todos", list(12)),
      result("t1", "12 of 17 done. Now: Step 13"),
    ];
    sessionView("s1").value = {
      events: before,
      text: "",
      thinking: "",
      state: "running",
      synced: true,
    };
    const { container } = render(<Chat sessionId="s1" agentId="god" />);
    const head = () => container.querySelector(".todos-head")?.textContent;
    expect(head()).toContain("12 su 17");
    const live = [
      asks(["t2", "update_todos", list(13)], ["c1", "run_command", { command: "pnpm test" }]),
      call("t2", "update_todos", list(13)),
      call("c1", "run_command", { command: "pnpm test" }),
    ];
    for (const e of live) act(() => applyMessage({ type: "event", sessionId: "s1", event: e }));
    // The command still runs: no result for the list yet, and the panel already says 13.
    expect(head()).toContain("13 su 17");
    for (const e of [result("t2", "13 of 17 done. Now: Step 14"), result("c1", "ok")])
      act(() => applyMessage({ type: "event", sessionId: "s1", event: e }));
    expect(head()).toContain("13 su 17");
  });

  it("keeps the previous list when the tool refuses the new one", () => {
    const two = list(13);
    (two.todos[15] as { status: string }).status = "in_progress";
    const items = buildItems([
      call("t1", "update_todos", list(12)),
      result("t1", "12 of 17 done."),
      call("t2", "update_todos", list(14)),
      result("t2", "Only one step can be in progress at a time.", false),
      // Not answered yet, but the tool will refuse it: two steps in progress.
      call("t3", "update_todos", two),
    ]);
    expect(latestTodos(items).filter((x) => x.status === "completed")).toHaveLength(12);
  });

  it("a list whose turn was cancelled before its result does not count", () => {
    const items = buildItems([
      call("t1", "update_todos", list(3)),
      result("t1", "3 of 17 done."),
      call("t2", "update_todos", list(4)),
      ev("message.assistant", {
        parts: [{ type: "text", text: "stopped" }],
        metrics,
        costUsd: 0,
        provider: "fake",
        model: "m",
        stopReason: "end_turn",
      }),
    ]);
    expect(latestTodos(items).filter((x) => x.status === "completed")).toHaveLength(3);
  });
});
