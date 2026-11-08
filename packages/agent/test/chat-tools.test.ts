import { EventStore, migrate } from "@redgiant/events";
import { ASIDE_NOTE, quotedText } from "@redgiant/protocol";
import { FakeProvider, type FakeScript, ProviderRegistry } from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentSession,
  type AgentSessionOptions,
  asideMessages,
  forkPoint,
  rebuildHistory,
  sessionLog,
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
  def: {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
  schema: z.object({ text: z.string() }),
  async run({ text }) {
    return text.toUpperCase();
  },
};

function setup(script: FakeScript, extra: Partial<AgentSessionOptions> = {}) {
  const fake = new FakeProvider(script);
  const options: AgentSessionOptions = {
    store,
    providers: new ProviderRegistry().register(fake),
    model: { provider: "fake", model: "m1", effort: "medium" },
    system: "You are a test agent.",
    tools: [echo],
    sessionId: "s1",
    ...extra,
  };
  return { fake, options };
}

const lastText = (m: { parts: { type: string; text?: string }[] } | undefined) =>
  m?.parts.findLast((p) => p.type === "text")?.text;

describe("quotes (G36.22)", () => {
  it("reads as a block before the reply; the prefix and the rebuilt history do not move", async () => {
    const { fake, options } = setup([{ text: "One. Two. Three." }, { text: "About two." }]);
    const s = await AgentSession.start(options);
    await s.send("count");
    const quoted = (await store.list({ sessionId: "s1" })).find(
      (e) => e.type === "message.assistant",
    );
    const quotes = [
      {
        seq: quoted?.seq ?? 0,
        at: "2026-11-08T14:32:10.000Z",
        start: 5,
        end: 9,
        text: "Two.",
        reply: "why two?",
      },
    ];
    await s.send("and the rest is fine", undefined, { quotes });
    const [first, second] = fake.requests;
    // Everything before the new message is what the previous call sent, plus its answer.
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    expect(second?.system).toBe(first?.system);
    expect(second?.tools).toEqual(first?.tools);
    const text = lastText(second?.messages.at(-1));
    expect(text).toBe(quotedText("and the rest is fine", quotes));
    expect(text).toContain("They received the whole message");
    expect(text).toContain(`2026-11-08 14:32 UTC (event ${quoted?.seq})`);
    expect(text).toMatch(/> Two\.\n\nwhy two\?\n\nand the rest is fine$/);
    // The log keeps the person's words and the quotes apart; the rebuilt history is the live one.
    const events = await store.list({ sessionId: "s1" });
    const user = events.filter((e) => e.type === "message.user").at(-1);
    expect(user?.type === "message.user" && user.payload).toMatchObject({
      text: "and the rest is fine",
      quotes,
    });
    expect(rebuildHistory(events).map((h) => h.message)).toEqual(s.messages);
  });

  it("joins a running turn with its quotes, as the person's other words do", async () => {
    const waiting = [{ text: "", quotes: [{ seq: 3, text: "a passage", reply: "not this" }] }];
    const { fake, options } = setup(
      [{ toolCalls: [{ name: "echo", input: { text: "x" } }] }, { text: "ok" }],
      { interject: () => waiting.splice(0) },
    );
    const s = await AgentSession.start(options);
    await s.send("go");
    const results = fake.requests[1]?.messages.at(-1);
    expect(lastText(results)).toBe(
      quotedText("", waiting[0]?.quotes ?? [{ seq: 3, text: "a passage", reply: "not this" }]),
    );
    expect(rebuildHistory(await store.list({ sessionId: "s1" })).map((h) => h.message)).toEqual(
      s.messages,
    );
  });
});

describe("«Intanto» (G36.24)", () => {
  it("asks with the same prefix and leaves the conversation as it was", async () => {
    const { fake, options } = setup([
      { text: "Hello" },
      { text: "It is Tuesday." },
      { text: "Next answer" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("hi");
    const before = structuredClone(s.messages);
    const a = await s.aside("what day is it?");
    expect(a).toMatchObject({ question: "what day is it?", answer: "It is Tuesday.", model: "m1" });
    const [turn, aside] = fake.requests;
    expect(aside?.system).toBe(turn?.system);
    expect(aside?.tools).toEqual(turn?.tools);
    expect(aside?.toolChoice).toBeUndefined();
    expect(aside?.messages.slice(0, -1)).toEqual(before);
    expect(lastText(aside?.messages.at(-1))).toBe(`${ASIDE_NOTE}\n\nwhat day is it?`);
    // Nothing of it in the conversation: the next turn reads as if it was never asked.
    expect(s.messages).toEqual(before);
    await s.send("go on");
    const next = fake.requests[2];
    expect(next?.messages.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(next?.messages)).not.toContain("Tuesday");
    const events = await store.list({ sessionId: "s1" });
    expect(events.filter((e) => e.type === "aside")).toHaveLength(1);
    expect(rebuildHistory(events).map((h) => h.message)).toEqual(s.messages);
    // A resumed conversation does not see it either.
    const again = await AgentSession.resume(options);
    expect(again.messages).toEqual(s.messages);
  });

  it("asks again without tools only when the model calls one anyway", async () => {
    const { fake, options } = setup([
      { text: "Hello" },
      { toolCalls: [{ name: "echo", input: { text: "x" } }] },
      { text: "Without tools: yes." },
    ]);
    const s = await AgentSession.start(options);
    await s.send("hi");
    const a = await s.aside("can you?");
    expect(a.answer).toBe("Without tools: yes.");
    expect(fake.requests[2]?.toolChoice).toBe("none");
    expect((await store.list({ sessionId: "s1" })).filter((e) => e.type === "tool.call")).toEqual(
      [],
    );
  });

  it("fits a turn in the middle of its tools", () => {
    const msgs = asideMessages(
      [
        { role: "user", parts: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          parts: [{ type: "tool_call", callId: "c1", name: "echo", input: {}, rawInput: "{}" }],
        },
      ],
      "q",
    );
    expect(msgs.at(-1)).toEqual({
      role: "user",
      parts: [
        {
          type: "tool_result",
          callId: "c1",
          content: "[Still running: the result is not in yet.]",
        },
        { type: "text", text: `${ASIDE_NOTE}\n\nq` },
      ],
    });
    // The person's unanswered message takes the question as one more part.
    const open = asideMessages([{ role: "user", parts: [{ type: "text", text: "go" }] }], "q");
    expect(open).toHaveLength(1);
    expect(open[0]?.parts).toHaveLength(2);
  });

  it("«Porta nella chat» appends the exchange as a normal one", async () => {
    const { fake, options } = setup([{ text: "Hello" }, { text: "Blue." }, { text: "ok" }]);
    const s = await AgentSession.start(options);
    await s.send("hi");
    const a = await s.aside("favourite colour?");
    await s.adoptAside(a);
    await s.send("thanks");
    const last = fake.requests[2]?.messages ?? [];
    expect(last.slice(-3).map((m) => lastText(m))).toEqual([
      "favourite colour?",
      "Blue.",
      "thanks",
    ]);
    const events = await store.list({ sessionId: "s1" });
    expect(events.some((e) => e.type === "aside.promoted")).toBe(true);
    expect(rebuildHistory(events).map((h) => h.message)).toEqual(s.messages);
  });
});

describe("fork (G36.23)", () => {
  it("goes on from the origin's events: same prefix, origin untouched", async () => {
    const { fake, options } = setup([
      { toolCalls: [{ name: "echo", input: { text: "a" } }] },
      { text: "First answer" },
      { text: "Second answer" },
      { text: "Branch answer" },
    ]);
    const s = await AgentSession.start(options);
    await s.send("one");
    await s.send("two");
    const origin = await store.list({ sessionId: "s1" });
    const first = origin.find((e) => e.type === "message.assistant");
    // From the first model message: its call and result come along, the next message does not.
    const through = forkPoint(origin, first?.seq ?? 0);
    expect(origin.find((e) => e.seq === through)?.type).toBe("tool.result");
    const cut = forkPoint(
      origin,
      origin.filter((e) => e.type === "message.assistant")[1]?.seq ?? 0,
    );
    await store.append({
      sessionId: "s2",
      body: { type: "session.forked", payload: { fromSessionId: "s1", throughSeq: cut } },
    });
    const log = await sessionLog(store, "s2");
    expect(log.map((e) => e.seq)).toEqual([
      ...origin.filter((e) => e.seq <= cut).map((e) => e.seq),
      (await store.list({ sessionId: "s2" }))[0]?.seq,
    ]);
    const branch = await AgentSession.resume({ ...options, sessionId: "s2" });
    expect(branch.messages).toEqual(
      rebuildHistory(origin.filter((e) => e.seq <= cut)).map((h) => h.message),
    );
    await branch.send("branch");
    const req = fake.requests.at(-1);
    // The origin's own requests had this very prefix: its cache is the branch's.
    const originReq = fake.requests[1];
    expect(req?.system).toBe(originReq?.system);
    expect(req?.tools).toEqual(originReq?.tools);
    expect(req?.messages.slice(0, originReq?.messages.length)).toEqual(originReq?.messages);
    // The origin is as it was.
    expect(await store.list({ sessionId: "s1" })).toEqual(origin);
    const again = await AgentSession.resume(options);
    expect(again.messages).toEqual(s.messages);
  });
});
