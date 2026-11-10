import { EventStore, migrate } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";
import {
  type CompletionRequest,
  FakeProvider,
  type FakeScript,
  ProviderRegistry,
  ProviderStalledError,
  type Recording,
  RecordingProvider,
  ReplayProvider,
  type StreamEvent,
  setStallLog,
} from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSession,
  type AgentSessionOptions,
  type Engine,
  rebuildHistory,
  type Tool,
} from "../src/index.js";
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
const isSummary = (req: CompletionRequest) => {
  const last = req.messages.at(-1)?.parts[0];
  return last?.type === "text" && last.text.startsWith("Do not call any tool now.");
};

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
    expect(r1?.tools.map((t) => t.name)).toEqual(["boom", "conversation_history", "echo"]);
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

  it("sends images and the sender with a message, and rebuilds them from the log", async () => {
    const { fake, options } = setup([{ text: "a cat" }]);
    const s = await AgentSession.start(options);
    const image = { type: "image" as const, mediaType: "image/png" as const, data: "iVBOR" };
    await s.send("what is it?", undefined, { images: [image], from: "Telegram" });
    const user = (await store.list({ sessionId: "s1" })).find((e) => e.type === "message.user");
    expect(user?.payload).toEqual({ text: "what is it?", images: [image], from: "Telegram" });
    expect(fake.requests[0]?.messages.at(-1)?.parts).toEqual([
      { type: "text", text: "what is it?" },
      image,
    ]);
    const resumed = await AgentSession.resume(options);
    expect(resumed.messages).toEqual(s.messages);
  });

  it("lets an external engine run the turn while the tools, permissions and log stay RedGiant's", async () => {
    const seen: { resume: string | undefined; tools: string[] }[] = [];
    const metrics = {
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T10:00:01.000Z",
      inputTokens: 100,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
      contextUsed: 110,
      contextWindow: 200_000,
      prefillMs: 0,
      decodeMs: 0,
      tokPerSec: 0,
      source: "server" as const,
    };
    const engine: Engine = {
      id: "fake-engine",
      async turn(t) {
        seen.push({ resume: t.resume, tools: t.tools.map((x) => x.name) });
        await t.onMessage({
          parts: [
            { type: "tool_call", callId: "c1", name: "echo", input: { text: "hi" }, rawInput: "" },
          ],
          metrics,
          stopReason: "tool_use",
          model: "sub-model",
        });
        const ok = await t.runTool({ callId: "c1", name: "echo", input: { text: "hi" } });
        const no = await t.runTool({ callId: "c2", name: "boom", input: {} });
        await t.onMessage({
          parts: [{ type: "text", text: `${ok.content} ${no.isError}` }],
          metrics,
          stopReason: "end_turn",
          model: "sub-model",
        });
        return { resume: "thread-1", stopReason: "end_turn" };
      },
    };
    const { options } = setup([], {
      engine,
      permission: async (call) =>
        call.name === "boom" ? { allow: false, reason: "no" } : { allow: true },
    });
    const s = await AgentSession.start(options);
    expect(await s.send("go")).toMatchObject({ stopReason: "end_turn", turns: 1 });
    const events = await store.list({ sessionId: "s1" });
    expect(types(events)).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
      "tool.call",
      "tool.result",
      "tool.call",
      "tool.result",
      "message.assistant",
      "engine.session",
    ]);
    const last = events.filter((e) => e.type === "message.assistant").at(-1);
    expect(last?.payload).toMatchObject({ parts: [{ type: "text", text: "HI true" }], costUsd: 0 });
    // The next message continues the engine's conversation, also after a restart.
    const resumed = await AgentSession.resume(options);
    await resumed.send("again");
    expect(seen.map((x) => x.resume)).toEqual([undefined, "thread-1"]);
    expect(seen[0]?.tools).toEqual(["boom", "conversation_history", "echo"]);
    expect(
      types(await store.list({ sessionId: "s1" })).filter((t) => t === "engine.session"),
    ).toHaveLength(1);
  });

  describe("an engine that stops answering (3.5.4)", () => {
    const quick = { firstTokenMs: 40, idleMs: 40 };
    const metrics = {
      startedAt: "2026-11-01T10:00:00.000Z",
      inputTokens: 1,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      contextUsed: 2,
      contextWindow: 200_000,
      prefillMs: 0,
      decodeMs: 0,
      tokPerSec: 0,
      source: "server" as const,
    };
    /** Silent (until cancelled) for the first `silent` turns, then it answers. */
    const engineOf = (silent: number, seen: { text: string; model: string; aborted: boolean }[]) =>
      ({
        id: "fake-engine",
        stall: quick,
        async turn(t) {
          const entry = { text: t.text, model: t.model.model, aborted: false };
          seen.push(entry);
          if (seen.length <= silent) {
            await new Promise<void>((ok) =>
              t.signal?.addEventListener("abort", () => ok(), { once: true }),
            );
            entry.aborted = true;
            return { resume: "", stopReason: "aborted" };
          }
          t.alive?.();
          await t.onMessage({
            parts: [{ type: "text", text: "here" }],
            metrics,
            stopReason: "end_turn",
            model: t.model.model,
          });
          return { resume: "thread-1", stopReason: "end_turn" };
        },
      }) satisfies Engine;

    it("cancels the silent turn for real and makes it again, then goes on", async () => {
      const seen: { text: string; model: string; aborted: boolean }[] = [];
      const lines: string[] = [];
      setStallLog((l) => lines.push(l));
      const { options } = setup([], { engine: engineOf(2, seen), stallDelaysMs: [5, 10] });
      const s = await AgentSession.start(options);
      expect(await s.send("go")).toMatchObject({ stopReason: "end_turn" });
      expect(seen.map((x) => [x.text, x.aborted])).toEqual([
        ["go", true],
        ["go", true],
        ["go", false],
      ]);
      // The conversation's model is the same at every try.
      expect(new Set(seen.map((x) => x.model))).toEqual(new Set(["m1"]));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/fake-engine\/m1: no first token .* trying again/);
      setStallLog((l) => console.warn(l));
    });

    it("stops the turn after two new tries with a clear error", async () => {
      const seen: { text: string; model: string; aborted: boolean }[] = [];
      setStallLog(() => {});
      const { options } = setup([], { engine: engineOf(9, seen), stallDelaysMs: [5, 10] });
      const s = await AgentSession.start(options);
      const err = await s.send("go").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderStalledError);
      expect((err as ProviderStalledError).retries).toBe(2);
      expect(seen).toHaveLength(3);
      setStallLog((l) => console.warn(l));
    });

    it("moves to the agent's fallback on the same engine after the tries", async () => {
      const seen: { text: string; model: string; aborted: boolean }[] = [];
      setStallLog(() => {});
      const { options } = setup([], {
        engine: engineOf(3, seen),
        stallDelaysMs: [5, 10],
        model: {
          provider: "fake-engine",
          model: "m1",
          fallback: { provider: "fake-engine", model: "m2" },
        },
      });
      const s = await AgentSession.start(options);
      expect(await s.send("go")).toMatchObject({ stopReason: "end_turn" });
      expect(seen.map((x) => x.model)).toEqual(["m1", "m1", "m1", "m2"]);
      setStallLog((l) => console.warn(l));
    });

    it("does not count the time of RedGiant's tools (a long command is not a silent provider)", async () => {
      const slow: Tool = {
        def: { name: "slow", description: "Takes its time", inputSchema: { type: "object" } },
        async run() {
          await new Promise((r) => setTimeout(r, 150));
          return "ok";
        },
      };
      let turns = 0;
      const engine: Engine = {
        id: "fake-engine",
        stall: quick,
        async turn(t) {
          turns++;
          t.alive?.();
          await t.onMessage({
            parts: [{ type: "tool_call", callId: "c1", name: "slow", input: {}, rawInput: "{}" }],
            metrics,
            stopReason: "tool_use",
            model: "m1",
          });
          const r = await t.runTool({ callId: "c1", name: "slow", input: {} });
          t.alive?.();
          await t.onMessage({
            parts: [{ type: "text", text: r.content }],
            metrics,
            stopReason: "end_turn",
            model: "m1",
          });
          return { resume: "thread-1", stopReason: "end_turn" };
        },
      };
      const { options } = setup([], { engine, tools: [slow], stallDelaysMs: [5, 10] });
      const s = await AgentSession.start(options);
      expect(await s.send("go")).toMatchObject({ stopReason: "end_turn" });
      expect(turns).toBe(1);
    });
  });

  it("compacts when the context is nearly full and records it", async () => {
    const big = "lorem ipsum ".repeat(40);
    const { fake, options } = setup(
      (req, i) => {
        if (isSummary(req)) return { text: "SUMMARY: user said hi twice" };
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
    expect(compaction?.payload).toMatchObject({
      summary: "SUMMARY: user said hi twice",
      reason: "auto",
    });
    // Made ahead of time, after the first turn: the second message lands after the summary.
    expect(fake.requests.map((r) => (isSummary(r) ? "S" : "T")).slice(0, 3)).toEqual([
      "T",
      "S",
      "T",
    ]);
    await s.settled();
    expect(fake.requests.filter((r) => !isSummary(r)).at(-1)?.messages).toEqual([
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

    // The summary request is the previous request plus one message: the cached prefix holds.
    const summaryReq = fake.requests.find(isSummary);
    const before = fake.requests[fake.requests.indexOf(summaryReq as CompletionRequest) - 1];
    expect(summaryReq?.tools).toEqual(before?.tools);
    expect(summaryReq?.system).toBe(before?.system);
    expect(summaryReq?.toolChoice).toBeUndefined();
  });

  it("falls back to toolChoice none if the model calls a tool instead of summarising", async () => {
    const big = "lorem ipsum ".repeat(40);
    const { fake, options } = setup(
      (req, i) => {
        if (isSummary(req))
          return req.toolChoice === "none"
            ? { text: "S" }
            : { toolCalls: [{ name: "echo", input: { text: "x" } }] };
        return { text: i === 0 ? big : "ok" };
      },
      {},
      200,
    );
    const s = await AgentSession.start(options);
    await s.send("one");
    await s.send("two");
    expect(
      fake.requests
        .filter(isSummary)
        .map((r) => r.toolChoice)
        .slice(0, 2),
    ).toEqual([undefined, "none"]);
  });

  it("lets preCompact hooks postpone compaction or add instructions", async () => {
    const big = "lorem ipsum ".repeat(40);
    let allow = false;
    const { fake, options } = setup(
      (req, i) => (isSummary(req) ? { text: "S" } : { text: i === 0 ? big : "ok" }),
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
    const summaryReq = fake.requests.find(isSummary);
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

    // A function is read at each send (the person's setting, G36.15).
    let limit = 2;
    const read = setup(() => ({ toolCalls: [{ name: "echo", input: { text: "again" } }] }), {
      sessionId: "s3",
      maxTurns: () => limit,
    });
    const s3 = await AgentSession.start(read.options);
    expect(await s3.send("go")).toMatchObject({ stopReason: "max_turns", turns: 2 });
    limit = 5;
    expect(await s3.send("go")).toMatchObject({ stopReason: "max_turns", turns: 5 });
  });

  it("says when a call keeps repeating, and closes the step limit with a summary", async () => {
    const seen: CompletionRequest[] = [];
    const { options } = setup(
      (req) => {
        seen.push(req);
        const last = req.messages.at(-1);
        const asked = last?.parts.some(
          (p) => p.type === "text" && p.text.includes("limit of steps"),
        );
        return asked
          ? { text: "Done: three echoes. Left: nothing." }
          : { toolCalls: [{ name: "echo", input: { text: "again" } }] };
      },
      { maxTurns: 4 },
    );
    const s = await AgentSession.start(options);
    const r = await s.send("go");
    expect(r).toMatchObject({ stopReason: "max_turns", turns: 4 });
    expect(r.lastCompletion?.message.parts).toEqual([
      { type: "text", text: "Done: three echoes. Left: nothing." },
    ]);
    // Same tools and system for the closing call: the cached prefix holds.
    expect(seen.at(-1)?.tools).toEqual(seen[0]?.tools);
    expect(seen.at(-1)?.system).toEqual(seen[0]?.system);
    const events = await store.list({ sessionId: "s1" });
    const outputs = events.flatMap((e) =>
      e.type === "tool.result" ? [String(e.payload.output)] : [],
    );
    expect(outputs.slice(0, 2).every((o) => o === "AGAIN")).toBe(true);
    expect(outputs[2]).toMatch(/3th time in a row/);
    expect(outputs[3]).toMatch(/4th time in a row/);
    // The note joins the last results' message, and a rebuild sees exactly what the model saw.
    const note = events.find((e) => e.type === "message.user" && e.payload.from === "redgiant");
    expect(note).toBeDefined();
    const rebuilt = rebuildHistory(events).map((h) => h.message);
    expect(rebuilt.at(-2)).toEqual(seen.at(-1)?.messages.at(-1));
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

describe("the loop's hard edges (2026-11-05, compared with the Claude Agent SDK)", () => {
  it("runs reads together and everything else one at a time, in the model's order", async () => {
    const log: string[] = [];
    const tool = (name: string): Tool => ({
      def: { name, description: name, inputSchema: { type: "object" } },
      async run(input) {
        const id = (input as { id: string }).id;
        log.push(`start ${id}`);
        await new Promise((r) => setTimeout(r, 30));
        log.push(`end ${id}`);
        return "ok";
      },
    });
    const { options } = setup(
      [
        {
          toolCalls: [
            { name: "read", input: { id: "r1" } },
            { name: "read", input: { id: "r2" } },
            { name: "write", input: { id: "w1" } },
            { name: "write", input: { id: "w2" } },
          ],
        },
        { text: "done" },
      ],
      { tools: [tool("read"), tool("write")], readOnlyTools: new Set(["read"]) },
    );
    const s = await AgentSession.start(options);
    await s.send("go");
    expect(log).toEqual([
      "start r1",
      "start r2",
      "end r1",
      "end r2",
      "start w1",
      "end w1",
      "start w2",
      "end w2",
    ]);
  });

  it("answers a call cut by the output limit with an error, and lets the model try again", async () => {
    const seen: CompletionRequest[] = [];
    const { options } = setup((req, i) => {
      seen.push(req);
      if (i === 0)
        return { toolCalls: [{ name: "echo", input: { text: "half" } }], stopReason: "max_tokens" };
      return { text: "smaller steps then" };
    });
    const s = await AgentSession.start(options);
    const r = await s.send("write a long file");
    expect(r.stopReason).toBe("end_turn");
    expect(ran).not.toContain("echo:half");
    const results = seen[1]?.messages.at(-1)?.parts ?? [];
    expect(results).toMatchObject([{ type: "tool_result", isError: true }]);
    // The log says the same when the conversation is read again.
    const rebuilt = rebuildHistory(await store.list({ sessionId: "s1" }));
    expect(rebuilt.map((h) => h.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("gives a call left without a result (a stop in the middle of tools) an 'interrupted' one", () => {
    const at = new Date().toISOString();
    const ev = (seq: number, type: string, payload: unknown) =>
      ({
        seq,
        type,
        payload,
        ts: at,
        sessionId: "s1",
        ownerId: "o",
        projectId: null,
        agentId: null,
      }) as unknown as Event;
    const history = rebuildHistory([
      ev(1, "message.user", { text: "go" }),
      ev(2, "message.assistant", {
        parts: [
          { type: "tool_call", callId: "a", name: "echo", input: {} },
          { type: "tool_call", callId: "b", name: "echo", input: {} },
        ],
        stopReason: "tool_use",
      }),
      ev(3, "tool.call", { callId: "a", tool: "echo", input: {} }),
      ev(4, "tool.result", { callId: "a", ok: true, output: "A" }),
      ev(5, "message.user", { text: "are you there?" }),
    ]);
    expect(history.map((h) => h.message.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(history[2]?.message.parts).toMatchObject([
      { type: "tool_result", callId: "a", content: "A" },
      { type: "tool_result", callId: "b", isError: true },
    ]);
  });
});

describe("a resumed conversation keeps its system prompt (2026-11-05)", () => {
  it("uses the prompt it started with, not one rebuilt since", async () => {
    const seen: CompletionRequest[] = [];
    const { options } = setup((req) => {
      seen.push(req);
      return { text: "ok" };
    });
    const first = await AgentSession.start({ ...options, system: "Notes: likes tea." });
    await first.send("hi");
    const again = await AgentSession.resume({ ...options, system: "Notes: likes coffee." });
    await again.send("hi again");
    expect(seen.map((r) => r.system)).toEqual(["Notes: likes tea.", "Notes: likes tea."]);
  });
});
