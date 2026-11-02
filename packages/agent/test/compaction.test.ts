import { EventStore, migrate } from "@redgiant/events";
import type { ChatMessage } from "@redgiant/protocol";
import {
  type CompletionRequest,
  FakeProvider,
  type FakeScript,
  ProviderError,
  ProviderRegistry,
} from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSession,
  type AgentSessionOptions,
  type HistoryEntry,
  keepFrom,
  rebuildHistory,
  summaryText,
  type Tool,
  trimResult,
  withoutReasoning,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

let store: EventStore;
beforeEach(async () => {
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
});

const echo: Tool<{ text: string }> = {
  def: {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  schema: z.object({ text: z.string() }),
  run: async ({ text }) => text.toUpperCase(),
};

const isSummary = (req: CompletionRequest) => {
  const last = req.messages.at(-1)?.parts[0];
  return last?.type === "text" && last.text.startsWith("Do not call any tool now.");
};

function setup(script: FakeScript, extra: Partial<AgentSessionOptions> = {}, window = 100_000) {
  const fake = new FakeProvider(script, { contextWindow: window });
  const options: AgentSessionOptions = {
    store,
    providers: new ProviderRegistry().register(fake),
    model: { provider: "fake", model: "m1" },
    system: "You are a test agent.",
    tools: [echo],
    sessionId: "s1",
    ...extra,
  };
  return { fake, options };
}

const user = (text: string, seq: number): HistoryEntry => ({
  message: { role: "user", parts: [{ type: "text", text }] },
  firstSeq: seq,
});
const assistant = (text: string, seq: number, thinking = false): HistoryEntry => ({
  message: {
    role: "assistant",
    parts: [
      ...(thinking ? [{ type: "thinking" as const, text: "hmm" }] : []),
      { type: "text", text },
    ],
    native: { provider: "anthropic", content: [] },
  } as ChatMessage,
  firstSeq: seq,
});

describe("compaction, the pure parts", () => {
  it("keeps whole recent turns within the quota, never cutting inside a turn", () => {
    const call: HistoryEntry = {
      message: {
        role: "assistant",
        parts: [{ type: "tool_call", callId: "c", name: "echo", input: { text: "x" } }],
      },
      firstSeq: 6,
    };
    const result: HistoryEntry = {
      message: { role: "user", parts: [{ type: "tool_result", callId: "c", content: "X" }] },
      firstSeq: 7,
    };
    const h = [
      user("a".repeat(700), 1),
      assistant("b".repeat(700), 2),
      user("c", 3),
      assistant("d", 4),
      user("e", 5),
      call,
      result,
      assistant("f", 8),
    ];
    // Room for the last two turns: the cut is at the start of turn "c".
    expect(keepFrom(h, 100)).toBe(2);
    // Room only for part of the last turn: cut at its start, never between call and result.
    expect(keepFrom(h, 20)).toBe(8);
    expect(keepFrom(h, 30)).toBe(4);
    // Something is always left to summarise.
    expect(keepFrom(h, 1_000_000)).toBe(2);
  });

  it("drops the reasoning of kept turns, cuts huge results, reads the summary", () => {
    const m = withoutReasoning(assistant("ok", 1, true).message);
    expect(m).toEqual({ role: "assistant", parts: [{ type: "text", text: "ok" }] });
    const cut = trimResult("x".repeat(1000), 100);
    expect(cut.startsWith("x".repeat(40))).toBe(true);
    expect(cut.endsWith("x".repeat(60))).toBe(true);
    expect(cut).toMatch(/900 characters cut.*conversation_history/);
    expect(trimResult("short", 100)).toBe("short");
    expect(summaryText("<analysis>long thought</analysis>\n<summary>\nThe gist\n</summary>")).toBe(
      "The gist",
    );
    expect(summaryText("plain summary")).toBe("plain summary");
  });
});

describe("compaction in a session (G24.14)", () => {
  it("summarises the old part ahead of time, keeps recent turns, and stays in the cache", async () => {
    const prefills: CompletionRequest[] = [];
    const asked = (req: CompletionRequest) => {
      const p = req.messages.at(-1)?.parts[0];
      return p?.type === "text" ? p.text : "";
    };
    const { fake, options } = setup(
      (req) =>
        isSummary(req)
          ? { text: "<analysis>…</analysis><summary>S1</summary>" }
          : asked(req) === "first question"
            ? { text: `answer ${"x".repeat(3000)}`, thinking: "reasoning" }
            : asked(req) === "second"
              ? // The window fills up here: the summary is made after this turn.
                { text: "short answer", thinking: "more reasoning", usage: { inputTokens: 1500 } }
              : { text: "ok" },
      { keepRatio: 0.3 },
      1800,
    );
    (fake as unknown as { prefill: (r: CompletionRequest) => Promise<void> }).prefill = async (
      r,
    ) => {
      prefills.push(r);
    };
    const s = await AgentSession.start(options);
    await s.send("first question");
    await s.send("second");
    await s.settled();
    await s.send("third");
    const events = await store.list({ sessionId: "s1" });
    const c = events.find((e) => e.type === "compaction");
    expect(c?.payload).toMatchObject({ summary: "S1", reason: "auto" });

    // The summary request: the last turn's request (a prefix of it) plus the prompt.
    const i = fake.requests.findIndex(isSummary);
    const before = fake.requests[i - 1] as CompletionRequest;
    const summaryReq = fake.requests[i] as CompletionRequest;
    expect(summaryReq.system).toBe(before.system);
    expect(summaryReq.tools).toEqual(before.tools);
    expect(summaryReq.messages.slice(0, -1)).toEqual(
      before.messages.slice(0, summaryReq.messages.length - 1),
    );
    // The local engine computed the new history before the next message.
    expect(prefills).toHaveLength(1);
    const next = fake.requests[i + 1] as CompletionRequest;
    expect(next.messages.slice(0, -1)).toEqual(prefills[0]?.messages);
    // The new history: summary, then the turns kept word for word, without reasoning.
    expect(next.messages[0]?.parts[0]).toMatchObject({ text: expect.stringContaining("S1") });
    expect(next.messages.slice(1)).toEqual([
      { role: "user", parts: [{ type: "text", text: "second" }] },
      { role: "assistant", parts: [{ type: "text", text: "short answer" }] },
      { role: "user", parts: [{ type: "text", text: "third" }] },
    ]);
    expect(c?.payload).toMatchObject({ stripped: true });
    for (const m of next.messages)
      expect(m.parts.some((p) => p.type === "thinking") || "native" in m).toBe(false);
    // And the log gives back exactly the same bytes.
    expect(rebuildHistory(await store.list({ sessionId: "s1" })).map((h) => h.message)).toEqual(
      s.messages,
    );
    expect((await AgentSession.resume(options)).messages).toEqual(s.messages);
  });

  it("builds a new summary on the previous one", async () => {
    let n = 0;
    const { fake, options } = setup(
      (req) => (isSummary(req) ? { text: `S${++n}` } : { text: "y", usage: { inputTokens: 1500 } }),
      {},
      1800,
    );
    const s = await AgentSession.start(options);
    await s.send("one");
    await s.send("two");
    await s.send("three");
    await s.settled();
    const second = fake.requests.filter(isSummary)[1];
    expect(JSON.stringify(second?.messages[0])).toContain("S1");
  });

  it("summarises everything at once when the window fills in the middle of the work", async () => {
    let calls = 0;
    const { fake, options } = setup(
      (req) => {
        if (isSummary(req)) return { text: "EMERGENCY SUMMARY" };
        calls++;
        // The second call fills the window: before the third, everything is summarised.
        return calls < 3
          ? {
              toolCalls: [{ name: "echo", input: { text: "go" } }],
              ...(calls === 2 && { usage: { inputTokens: 950 } }),
            }
          : { text: "finished" };
      },
      {},
      1000,
    );
    const s = await AgentSession.start(options);
    const r = await s.send("work");
    expect(r.stopReason).toBe("end_turn");
    const c = (await store.list({ sessionId: "s1" })).find((e) => e.type === "compaction");
    expect(c?.payload).toMatchObject({ reason: "emergency" });
    expect(c?.payload).not.toHaveProperty("stripped");
    const after = fake.requests[fake.requests.findIndex(isSummary) + 1];
    expect(after?.messages).toHaveLength(1);
    expect(JSON.stringify(after?.messages[0])).toMatch(/EMERGENCY SUMMARY.*carry on/);
  });

  it("retries once after the provider says the context is full", async () => {
    let failed = false;
    const { options } = setup((req) => {
      if (isSummary(req)) return { text: "S" };
      if (req.messages.length > 1 && !failed) {
        failed = true;
        return { error: new ProviderError("prompt is too long: 210000 tokens", false) };
      }
      return { text: "ok" };
    });
    const s = await AgentSession.start(options);
    await s.send("a");
    const r = await s.send("b");
    expect(r.stopReason).toBe("end_turn");
    expect(
      (await store.list({ sessionId: "s1" })).filter((e) => e.type === "compaction"),
    ).toHaveLength(1);
  });

  it("compacts by hand with instructions, and undoes it while nothing was said since", async () => {
    const { fake, options } = setup((req) =>
      isSummary(req) ? { text: "MANUAL" } : { text: "ok" },
    );
    const s = await AgentSession.start(options);
    await s.send("one");
    await s.send("two");
    const full = s.messages;
    // Without any metrics yet? There are: the window is known from the last call.
    expect(
      await s.compactNow({ reason: "manual", instructions: "keep the schema decisions" }),
    ).toBe(true);
    const prompt = fake.requests.find(isSummary)?.messages.at(-1)?.parts[0];
    expect(prompt?.type === "text" && prompt.text).toMatch(/keep the schema decisions$/);
    expect(s.messages).not.toEqual(full);
    expect(await s.undoCompaction()).toBe(true);
    expect(s.messages).toEqual(full);
    expect((await AgentSession.resume(options)).messages).toEqual(full);
    expect(await s.undoCompaction()).toBe(false);
  });

  it("cuts a huge tool result the same way live and from the log, and finds it again", async () => {
    const big: Tool = {
      def: { name: "big", description: "Big output", inputSchema: { type: "object" } },
      run: async () => `START${"m".repeat(5000)}NEEDLE${"m".repeat(5000)}END`,
    };
    let step = 0;
    const { options } = setup(
      () =>
        ++step === 1
          ? { toolCalls: [{ name: "big", input: {} }] }
          : step === 2
            ? { toolCalls: [{ name: "conversation_history", input: { query: "needle" } }] }
            : { text: "done" },
      { tools: [echo, big], maxResultChars: 1000 },
    );
    const s = await AgentSession.start(options);
    await s.send("go");
    const results = s.messages.flatMap((m) =>
      m.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])),
    );
    expect(results[0]?.length).toBeLessThan(1200);
    expect(results[0]).toMatch(/^START[\s\S]*characters cut[\s\S]*END$/);
    expect(results[1]).toContain("NEEDLE");
    expect((await AgentSession.resume(options)).messages).toEqual(s.messages);
  });
});
