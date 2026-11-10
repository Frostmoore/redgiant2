import { EventStore, migrate } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";
import { FakeProvider, type FakeTurn, ProviderRegistry } from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSession,
  type AgentSessionOptions,
  rebuildHistory,
  TODO_REMINDER_EVERY,
  TodoWatch,
  type Tool,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

let store: EventStore;

beforeEach(async () => {
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
});

const echo: Tool<{ text: string }> = {
  def: { name: "echo", description: "Echo text", inputSchema: { type: "object" } },
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    return text.toUpperCase();
  },
};
// The same name and shape as the real tool (@redgiant/tools): the session only reads its input.
const todos: Tool = {
  def: { name: "update_todos", description: "Steps", inputSchema: { type: "object" } },
  async run() {
    return "ok";
  },
};

type Step = { content: string; status: "pending" | "in_progress" | "completed" };
const list = (...statuses: Step["status"][]) => ({
  todos: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })),
});
const write = (input: unknown): FakeTurn => ({
  toolCalls: [{ name: "update_todos", input }],
});
const calls = (n: number, from = 0): FakeTurn[] =>
  Array.from({ length: n }, (_, i) => ({
    toolCalls: [{ name: "echo", input: { text: `c${from + i}` } }],
  }));

function setup(script: FakeTurn[]) {
  const fake = new FakeProvider(script);
  const options: AgentSessionOptions = {
    store,
    providers: new ProviderRegistry().register(fake),
    model: { provider: "fake", model: "m1", effort: "medium" },
    system: "You are a test agent.",
    tools: [echo, todos],
    sessionId: "s1",
    projectId: "p1",
  };
  return { fake, options };
}

const results = async () =>
  (await store.list({ sessionId: "s1" })).flatMap((e: Event) =>
    e.type === "tool.result" && e.payload ? [e.payload] : [],
  );
const reminded = async () =>
  (await results()).filter((r) => r.output.includes("[RedGiant: Your list of steps"));

describe("the list of steps kept up to date (3.5.6)", () => {
  it(`reminds after ${TODO_REMINDER_EVERY} calls without update_todos, with the list`, async () => {
    const { fake, options } = setup([
      write(list("completed", "in_progress", "pending")),
      ...calls(TODO_REMINDER_EVERY),
      { text: "done" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    const out = await results();
    // The write, then the calls: only the last one carries the reminder.
    const marked = out.filter((r) => r.reminder === "todos");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(out.at(-1));
    expect(marked[0]?.output).toContain(`C${TODO_REMINDER_EVERY - 1}\n\n[RedGiant: Your list`);
    expect(marked[0]?.output).toContain("1. [completed] step 1\n2. [in_progress] step 2");
    expect(marked[0]?.output).toContain("Mark a step in_progress before you start it");
    // The model read it, appended to that result (the prefix is untouched).
    const last = fake.requests.at(-1)?.messages.at(-1)?.parts[0];
    expect(last?.type === "tool_result" && last.content).toBe(marked[0]?.output);
  });

  it("counts again from zero after a reminder", async () => {
    const { options } = setup([
      write(list("pending", "pending")),
      ...calls(2 * TODO_REMINDER_EVERY + 3),
      { text: "done" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    expect(await reminded()).toHaveLength(2);
  });

  it("never reminds without a list, with a closed one or one freshly updated", async () => {
    const { options } = setup([
      ...calls(TODO_REMINDER_EVERY + 2),
      write(list("in_progress", "pending")),
      ...calls(TODO_REMINDER_EVERY - 1, 100),
      write(list("completed", "in_progress")),
      ...calls(TODO_REMINDER_EVERY - 1, 200),
      write(list("completed", "completed")),
      ...calls(2 * TODO_REMINDER_EVERY, 300),
      { text: "done" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    expect(await reminded()).toEqual([]);
  });

  it("an update_todos it cannot read does not count as an update", async () => {
    const { options } = setup([
      write(list("pending")),
      ...calls(3),
      write({ todos: "not a list" }),
      ...calls(TODO_REMINDER_EVERY - 4, 10),
      { text: "done" },
    ]);
    // The real tool would refuse it; this one says ok, so the session sees a list it cannot read.
    const s = await AgentSession.start(options);
    await s.send("go");
    expect(await reminded()).toHaveLength(1);
  });

  it("reminds when a task's report arrives while the list is open, in the message's notes", async () => {
    const { fake, options } = setup([
      write(list("completed", "pending")),
      { text: "waiting" },
      { text: "noted" },
      write(list("completed", "completed")),
      { text: "all done" },
      { text: "fine" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    await s.send("<task_report>…</task_report>", undefined, { from: "Coder", taskReport: true });
    const users = (await store.list({ sessionId: "s1" })).flatMap((e) =>
      e.type === "message.user" && e.payload ? [e.payload] : [],
    );
    expect(users[1]?.notes).toHaveLength(1);
    expect(users[1]?.notes?.[0]).toMatch(/^Your list of steps \(update_todos\) still has open/);
    const read = fake.requests[2]?.messages.at(-1)?.parts[0];
    expect(read?.type === "text" && read.text).toContain(
      "</task_report>\n\n[RedGiant: Your list of steps",
    );
    // Closed list: a report carries nothing.
    await s.send("next");
    await s.send("<task_report>…</task_report>", undefined, { from: "Coder", taskReport: true });
    const after = (await store.list({ sessionId: "s1" })).flatMap((e) =>
      e.type === "message.user" && e.payload ? [e.payload] : [],
    );
    expect(after.at(-1)?.notes).toBeUndefined();
  });

  it("rebuilds the same history and the same count when resumed", async () => {
    const before = 5;
    const { fake, options } = setup([
      write(list("in_progress", "pending")),
      ...calls(before),
      { text: "paused" },
      ...calls(TODO_REMINDER_EVERY - before + 1, 50),
      { text: "done" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    const lastBefore = fake.requests.at(-1);
    const resumed = await AgentSession.resume(options);
    expect(resumed.messages).toEqual(s.messages);
    await resumed.send("go on");
    // The resumed session's first request starts with the previous one, word for word.
    const firstAfter = fake.requests[fake.requests.length - (TODO_REMINDER_EVERY - before + 2)];
    expect(firstAfter?.system).toBe(lastBefore?.system);
    expect(firstAfter?.tools).toEqual(lastBefore?.tools);
    expect(firstAfter?.messages.slice(0, lastBefore?.messages.length)).toEqual(
      lastBefore?.messages,
    );
    // The count went on from the log: the reminder came on the eighth call, not eight calls later.
    const out = await results();
    const at = out.findIndex((r) => r.reminder === "todos");
    expect(at).toBe(1 + TODO_REMINDER_EVERY - 1);
    expect(out.filter((r) => r.reminder === "todos")).toHaveLength(1);
    // And the history from the log is the one the session had.
    const events = await store.list({ sessionId: "s1" });
    expect(rebuildHistory(events).map((h) => h.message)).toEqual(resumed.messages);
    // A third session would count the same as the second one did at its end.
    const again = await AgentSession.resume(options);
    expect(again.messages).toEqual(resumed.messages);
  });

  it("a reminder in a report's notes resets the count on resume too", async () => {
    const events = [
      { type: "tool.call", payload: { callId: "a", tool: "update_todos", input: list("pending") } },
      { type: "tool.result", payload: { callId: "a", ok: true, output: "ok" } },
      ...Array.from({ length: TODO_REMINDER_EVERY - 1 }, (_, i) => [
        { type: "tool.call", payload: { callId: `c${i}`, tool: "echo", input: {} } },
        { type: "tool.result", payload: { callId: `c${i}`, ok: true, output: "x" } },
      ]).flat(),
      {
        type: "message.user",
        payload: { text: "report", notes: [new TodoWatch().text("report")] },
      },
      { type: "tool.call", payload: { callId: "z", tool: "echo", input: {} } },
      { type: "tool.result", payload: { callId: "z", ok: true, output: "x" } },
    ] as unknown as Event[];
    const w = TodoWatch.fromEvents(events);
    expect(w.open).toBe(true);
    expect(w.due).toBe(false);
    const without = TodoWatch.fromEvents(events.filter((e) => e.type !== "message.user"));
    expect(without.due).toBe(true);
  });
});
