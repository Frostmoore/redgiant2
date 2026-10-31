import { EventStore, migrate } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";
import {
  type CompletionRequest,
  FakeProvider,
  type FakeScript,
  ProviderRegistry,
  type Recording,
  RecordingProvider,
  ReplayProvider,
  type StreamEvent,
} from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentSession, type AgentSessionOptions, rebuildHistory, type Tool } from "../src/index.js";
import { memoryDb } from "./pglite.js";

let store: EventStore;

beforeEach(async () => {
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
});

const ran: string[] = [];
const echo: Tool<{ text: string }> = {
  def: {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    ran.push(`echo:${text}`);
    await new Promise((r) => setTimeout(r, text === "slow" ? 20 : 0));
    return text.toUpperCase();
  },
};
const boom: Tool = {
  def: { name: "boom", description: "Always fails", inputSchema: { type: "object" } },
  async run() {
    throw new Error("kaput");
  },
};

function setup(
  script: FakeScript,
  extra: Partial<AgentSessionOptions> = {},
  contextWindow = 100_000,
) {
  const fake = new FakeProvider(script, { contextWindow });
  const providers = new ProviderRegistry().register(fake);
  const options: AgentSessionOptions = {
    store,
    providers,
    model: { provider: "fake", model: "m1", effort: "medium" },
    system: "You are a test agent.",
    tools: [echo, boom],
    sessionId: "s1",
    projectId: "p1",
    ...extra,
  };
  return { fake, options };
}

const types = (events: Event[]) => events.map((e) => e.type);

describe("AgentSession", () => {
  it("records a plain exchange and forwards deltas live", async () => {
    const live: StreamEvent[] = [];
    const { options } = setup([{ text: "Hello there" }], { live: (e) => live.push(e) });
    const s = await AgentSession.start(options);
    const r = await s.send("hi");
    expect(r).toMatchObject({ stopReason: "end_turn", turns: 1 });
    expect(types(await store.list({ sessionId: "s1" }))).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
    ]);
    expect(live.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("Hello there");
  });

  it("runs tool calls in parallel, records them in order and loops until done", async () => {
    ran.length = 0;
    const { fake, options } = setup([
      {
        toolCalls: [
          { name: "echo", input: { text: "slow" } },
          { name: "echo", input: { text: "fast" } },
        ],
      },
      { text: "done" },
    ]);
    const s = await AgentSession.start(options);
    expect((await s.send("go")).turns).toBe(2);
    expect(ran).toEqual(["echo:slow", "echo:fast"]);
    const events = await store.list({ sessionId: "s1" });
    expect(types(events)).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
      "tool.call",
      "tool.call",
      "tool.result",
      "tool.result",
      "message.assistant",
    ]);
    const second = fake.requests[1]?.messages.at(-1);
    expect(second).toEqual({
      role: "user",
      parts: [
        { type: "tool_result", callId: "call_0_0", content: "SLOW" },
        { type: "tool_result", callId: "call_0_1", content: "FAST" },
      ],
    });
  });

  it("turns bad calls into error results without running the tool", async () => {
    ran.length = 0;
    const { fake, options } = setup([
      {
        toolCalls: [
          { name: "nope", input: {} },
          { name: "echo", input: { text: 42 } },
          { name: "boom", input: {} },
        ],
      },
      { text: "ok" },
    ]);
    // Simulate a model that produced invalid JSON for a fourth call.
    const original = fake.stream.bind(fake);
    fake.stream = async function* (req: CompletionRequest, signal?: AbortSignal) {
      for await (const e of original(req, signal)) {
        if (e.type === "done" && e.completion.stopReason === "tool_use") {
          e.completion.message.parts.push({
            type: "tool_call",
            callId: "bad",
            name: "echo",
            input: undefined,
            rawInput: "{text: oops",
          });
        }
        yield e;
      }
    };
    const s = await AgentSession.start(options);
    await s.send("go");
    expect(ran).toEqual([]);
    const results = (await store.list({ sessionId: "s1" })).flatMap((e) =>
      e.type === "tool.result" ? [e.payload] : [],
    );
    expect(results.map((r) => r?.ok)).toEqual([false, false, false, false]);
    expect(results.map((r) => r?.output)).toEqual([
      'Unknown tool "nope".',
      expect.stringMatching(/^Invalid arguments: text:/),
      "Tool failed: kaput",
      "The arguments are not valid JSON. Received: {text: oops",
    ]);
  });

  it("applies hooks and the permission check", async () => {
    ran.length = 0;
    const { options } = setup(
      [
        {
          toolCalls: [
            { name: "echo", input: { text: "rm -rf" } },
            { name: "echo", input: { text: "rewrite me" } },
            { name: "echo", input: { text: "deny me" } },
          ],
        },
        { text: "first stop" },
        { text: "second stop" },
      ],
      {
        hooks: {
          preToolUse: [
            (c) =>
              (c.input as { text: string }).text === "rm -rf"
                ? { action: "block", reason: "dangerous" }
                : { action: "allow" },
            (c) =>
              (c.input as { text: string }).text === "rewrite me"
                ? { action: "modify", input: { text: "rewritten" } }
                : { action: "allow" },
          ],
          // Runs only after a tool actually ran: blocked and denied calls are not touched.
          postToolUse: [(_c, r) => ({ ...r, content: `${r.content}!` })],
          stop: [
            (c) =>
              c.message.parts.some((p) => p.type === "text" && p.text === "first stop")
                ? "Run the verifier."
                : undefined,
          ],
        },
        permission: async (c) => ({
          allow: (c.input as { text: string }).text !== "deny me",
          reason: "policy",
        }),
      },
    );
    const s = await AgentSession.start(options);
    const r = await s.send("go");
    expect(r.turns).toBe(3);
    expect(ran).toEqual(["echo:rewritten"]);
    const events = await store.list({ sessionId: "s1" });
    expect(events.filter((e) => e.type === "hook.blocked")).toHaveLength(1);
    const outputs = events.flatMap((e) => (e.type === "tool.result" ? [e.payload?.output] : []));
    expect(outputs).toEqual(["Blocked: dangerous", "REWRITTEN!", "Permission denied: policy."]);
    expect(events.filter((e) => e.type === "message.user").map((e) => e.payload)).toEqual([
      { text: "go" },
      { text: "Run the verifier." },
    ]);
  });

  it("keeps the prompt prefix stable across turns", async () => {
    const { fake, options } = setup([
      { toolCalls: [{ name: "echo", input: { text: "a" } }] },
      { text: "b" },
      { text: "c" },
    ]);
    const s = await AgentSession.start({ ...options, tools: [echo, boom].reverse() });
    await s.send("one");
    await s.send("two");
    const [r1, r2, r3] = fake.requests;
    expect(r1?.tools.map((t) => t.name)).toEqual(["boom", "echo"]);
    for (const [a, b] of [
      [r1, r2],
      [r2, r3],
    ] as const) {
      expect(b?.system).toBe(a?.system);
      expect(b?.tools).toEqual(a?.tools);
      expect(b?.messages.slice(0, a?.messages.length)).toEqual(a?.messages);
    }
  });

  it("rebuilds the same history from the log when resumed", async () => {
    const { options } = setup([
      { toolCalls: [{ name: "echo", input: { text: "x" } }] },
      { text: "done" },
      { text: "again" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("go");
    const resumed = await AgentSession.resume(options);
    expect(resumed.messages).toEqual(s.messages);
    await resumed.send("more");
    expect(rebuildHistory(await store.list({ sessionId: "s1" })).map((h) => h.message)).toEqual(
      resumed.messages,
    );
  });

  it("compacts when the context is nearly full and records it", async () => {
    const big = "lorem ipsum ".repeat(40);
    const { fake, options } = setup(
      (req, i) => {
        if (req.tools.length === 0) return { text: "SUMMARY: user said hi twice" };
        return i === 0 ? { text: big } : { text: "after compaction" };
      },
      {},
      200,
    );
    const s = await AgentSession.start(options);
    await s.send("hi");
    await s.send("hi again");
    const events = await store.list({ sessionId: "s1" });
    const compaction = events.find((e) => e.type === "compaction");
    expect(compaction?.payload).toMatchObject({ summary: "SUMMARY: user said hi twice" });
    expect(fake.requests.at(-1)?.messages).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "Summary of the conversation so far:\n\nSUMMARY: user said hi twice",
          },
        ],
      },
      { role: "user", parts: [{ type: "text", text: "hi again" }] },
    ]);
    expect((await AgentSession.resume(options)).messages).toEqual(s.messages);
  });

  it("lets preCompact hooks postpone compaction or add instructions", async () => {
    const big = "lorem ipsum ".repeat(40);
    let allow = false;
    const { fake, options } = setup(
      (req, i) => (req.tools.length === 0 ? { text: "S" } : { text: i === 0 ? big : "ok" }),
      { hooks: { preCompact: [() => (allow ? "Keep the file list." : false)] } },
      200,
    );
    const s = await AgentSession.start(options);
    await s.send("one");
    await s.send("two");
    expect((await store.list({ sessionId: "s1" })).some((e) => e.type === "compaction")).toBe(
      false,
    );
    allow = true;
    await s.send("three");
    const summaryReq = fake.requests.find((r) => r.tools.length === 0);
    const lastPart = summaryReq?.messages.at(-1)?.parts[0];
    expect(lastPart?.type === "text" && lastPart.text).toMatch(/Keep the file list\.$/);
  });

  it("stops with 'aborted' and at max_turns", async () => {
    const controller = new AbortController();
    const { options } = setup([{ text: "a b c d e f" }], {
      live: (e) => e.type === "text_delta" && controller.abort(),
    });
    const s = await AgentSession.start(options);
    expect((await s.send("go", controller.signal)).stopReason).toBe("aborted");

    const loop = setup(() => ({ toolCalls: [{ name: "echo", input: { text: "again" } }] }), {
      sessionId: "s2",
      maxTurns: 3,
    });
    const s2 = await AgentSession.start(loop.options);
    expect(await s2.send("go")).toMatchObject({ stopReason: "max_turns", turns: 3 });
  });

  it("replays a recorded session into an identical log", async () => {
    const recordings: Recording[] = [];
    const script: FakeScript = [
      { thinking: "plan", toolCalls: [{ name: "echo", input: { text: "x" } }] },
      { text: "done", usage: { inputTokens: 10, outputTokens: 2 } },
    ];
    const fake = new FakeProvider(script, { now: () => 0 });
    const original = await AgentSession.start({
      store,
      providers: new ProviderRegistry().register(
        new RecordingProvider(fake, (r) => recordings.push(r)),
      ),
      model: { provider: "fake", model: "m1" },
      system: "S",
      tools: [echo],
      sessionId: "orig",
    });
    await original.send("go");
    const jsonl = recordings.map((r) => JSON.stringify(r)).join("\n");

    const { db } = await memoryDb();
    await migrate(db);
    const replayStore = new EventStore(db);
    const replay = await AgentSession.start({
      store: replayStore,
      providers: new ProviderRegistry().register(
        new ReplayProvider(
          "fake",
          jsonl.split("\n").map((l) => JSON.parse(l)),
        ),
      ),
      model: { provider: "fake", model: "m1" },
      system: "S",
      tools: [echo],
      sessionId: "orig",
    });
    await replay.send("go");
    const strip = (es: Event[]) => es.map((e) => ({ type: e.type, payload: e.payload }));
    expect(strip(await replayStore.list())).toEqual(strip(await store.list({ sessionId: "orig" })));
    expect((await replayStore.verify()).ok).toBe(true);
  });
});
