import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "@redgiant/protocol";
import { type CompletionRequest, complete } from "@redgiant/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type KvEntry,
  KvStore,
  LocalEngineProvider,
  prefixHashes,
  SlotScheduler,
  score,
} from "../src/index.js";
import { fakeLlama } from "./fake-llama.js";

let dir: string;
const closers: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-kv-"));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await rm(dir, { recursive: true, force: true });
});

const longDoc = "RedGiant keeps the prompt prefix stable so the cache can be reused. ".repeat(60);
const user = (text: string): ChatMessage => ({ role: "user", parts: [{ type: "text", text }] });
const req = (
  session: string,
  messages: ChatMessage[],
  extra: Partial<CompletionRequest> = {},
): CompletionRequest => ({
  model: "fake",
  system: "You are terse.",
  tools: [],
  messages,
  cacheKey: session,
  cacheScope: "p1",
  ...extra,
});
/** One conversation turn: returns the history with the reply appended. */
async function turn(p: LocalEngineProvider, session: string, history: ChatMessage[], text: string) {
  const messages = [...history, user(text)];
  const c = await complete(p.stream(req(session, messages)));
  return { c, history: [...messages, { role: "assistant" as const, parts: c.message.parts }] };
}

async function setup(slots: number, kvDir = dir) {
  const engine = await fakeLlama({ slots, dir: kvDir });
  closers.push(engine.close);
  const provider = new LocalEngineProvider({
    baseURL: engine.url,
    kv: new KvStore(kvDir),
    kvMinTokens: 10,
  });
  return { engine, provider };
}

describe("LocalEngineProvider", () => {
  it("does not look like an agent loop to the core (no `engine` property)", async () => {
    const { provider } = await setup(1);
    // The core runs a turn through `provider.engine` when there is one (flat subscriptions):
    // a local model answered "engine.turn is not a function" on Telegram (v1.57.1).
    expect("engine" in provider).toBe(false);
  });

  it("keeps a session's cache warm in its slot", async () => {
    const { engine, provider } = await setup(2);
    const t1 = await turn(provider, "A", [], longDoc);
    const t2 = await turn(provider, "A", t1.history, "and then?");
    expect(engine.requests.map((r) => r.cached)).toEqual([0, expect.any(Number)]);
    expect(t2.c.usage.cachedReadTokens).toBeGreaterThan(0.9 * t2.c.usage.inputTokens);
    expect(t2.c.metrics.kvRestoredTokens).toBeUndefined();
  });

  it("computes a new history ahead of time, so the next message costs only itself (G24.14)", async () => {
    const { engine, provider } = await setup(1);
    await turn(provider, "A", [], longDoc);
    // After a summary: a different, shorter history, computed before the person writes.
    const summarised = [user(`Summary of the conversation so far:\n\n${longDoc.slice(0, 1500)}`)];
    await provider.prefill(req("A", summarised));
    const warm = engine.requests.at(-1);
    expect(warm?.processed).toBeGreaterThan(100);
    const next = await complete(provider.stream(req("A", [...summarised, user("and now?")])));
    expect(engine.requests.at(-1)?.processed).toBeLessThan(20);
    expect(next.usage.cachedReadTokens).toBeGreaterThan(0.9 * next.usage.inputTokens);
  });

  it("saves a cache when its slot changes hands, and restores it on return", async () => {
    const { engine, provider } = await setup(1);
    const a1 = await turn(provider, "A", [], longDoc);
    await turn(provider, "B", [], `${longDoc} — a different conversation`);
    const a2 = await turn(provider, "A", a1.history, "back to A");
    expect(a2.c.metrics.kvRestoredTokens).toBeGreaterThan(0);
    expect(a2.c.usage.cachedReadTokens).toBeGreaterThan(0.9 * a2.c.usage.inputTokens);
    expect(engine.requests.at(-1)?.processed).toBeLessThan(20);
    const files = (await new KvStore(dir).list()).map((e) => `${e.sessionId}:${e.reason}`).sort();
    expect(files).toEqual(["A:turn", "B:evict"]);
  });

  it("survives an engine restart: the next turn reads the cache back from disk", async () => {
    const first = await setup(1);
    const a1 = await turn(first.provider, "A", [], longDoc);
    await first.engine.close();
    const second = await setup(1); // empty slots, same directory
    const a2 = await turn(second.provider, "A", a1.history, "after the restart");
    expect(a2.c.metrics.kvRestoredTokens).toBeGreaterThan(0);
    expect(second.engine.requests[0]?.processed).toBeLessThan(20);
  });

  it("shares a prefix across sessions (same system, tools and opening)", async () => {
    const { engine, provider } = await setup(1);
    await turn(provider, "A", [], longDoc);
    await turn(provider, "Z", [], "something unrelated to evict A");
    const c = await turn(provider, "C", [], longDoc);
    expect(c.c.metrics.kvRestoredTokens).toBeGreaterThan(0);
    expect(engine.requests.at(-1)?.cached).toBeGreaterThan(0.9 * c.c.usage.inputTokens);
  });

  it("computes a new conversation's start ahead, once, and the first message reads only itself (2026-11-05)", async () => {
    const { engine, provider } = await setup(1);
    // The start every new conversation of the agent shares: a long system prompt.
    const start = (session: string, text: string) =>
      req(session, [user(text)], { system: `You are God. ${longDoc}` });
    await provider.prefill(start("start_god", "."), undefined, { onlyStart: true });
    const ahead = engine.requests.length;
    expect(engine.requests.at(-1)?.processed).toBeGreaterThan(100);
    // Already kept: the next start of the engine does not compute it again.
    await provider.prefill(start("start_god", "."), undefined, { onlyStart: true });
    expect(engine.requests).toHaveLength(ahead);
    // Another conversation took the slot meanwhile; a new one restores the start from the disk.
    await turn(provider, "Z", [], "something unrelated");
    const first = await complete(provider.stream(start("N", "ciao")));
    expect(first.metrics.kvRestoredTokens).toBeGreaterThan(0);
    expect(engine.requests.at(-1)?.processed).toBeLessThan(20);
  });

  it("never restores a cache made with another model", async () => {
    const first = await setup(1);
    const a1 = await turn(first.provider, "A", [], longDoc);
    await first.engine.close();
    const engine = await fakeLlama({ slots: 1, dir, model: "/models/other.gguf" });
    closers.push(engine.close);
    const other = new LocalEngineProvider({
      baseURL: engine.url,
      kv: new KvStore(dir),
      kvMinTokens: 10,
    });
    const a2 = await turn(other, "A", a1.history, "different model");
    expect(a2.c.metrics.kvRestoredTokens).toBeUndefined();
    expect(engine.requests[0]?.cached).toBe(0);
  });
});

describe("SlotScheduler", () => {
  it("serves waiting requests by priority, then in order", async () => {
    const s = new SlotScheduler(1);
    const first = await s.acquire("worker-1", 30);
    const order: string[] = [];
    const wait = (id: string, p: number) =>
      s.acquire(id, p).then((l) => {
        order.push(id);
        l.release();
      });
    const all = Promise.all([
      wait("worker-2", 30),
      wait("god", 100),
      wait("orchestrator", 70),
      wait("worker-3", 30),
    ]);
    first.release();
    await all;
    expect(order).toEqual(["god", "orchestrator", "worker-2", "worker-3"]);
  });

  it("gives a session its own slot back while warm, and evicts the least recently used", async () => {
    const s = new SlotScheduler(2);
    const a = await s.acquire("A", 50);
    const b = await s.acquire("B", 50);
    a.release();
    b.release();
    const a2 = await s.acquire("A", 50);
    expect(a2).toMatchObject({ slot: a.slot, warm: true });
    a2.release();
    const c = await s.acquire("C", 50);
    expect(c).toMatchObject({ slot: b.slot, warm: false, previous: "B" });
  });
});

describe("KvStore", () => {
  const entry = (file: string, hits: number, hoursAgo: number, bytes = 100): KvEntry => ({
    file,
    scope: "p",
    sessionId: file,
    model: "m",
    ctx: 1,
    prefixHashes: [],
    tokens: 1,
    bytes,
    reason: "turn",
    hits,
    createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  });

  it("scores by hits decaying with a six-hour half-life", () => {
    expect(score(entry("a", 0, 0))).toBeCloseTo(1, 3);
    expect(score(entry("a", 3, 6))).toBeCloseTo(2, 3);
    expect(score(entry("a", 0, 12))).toBeCloseTo(0.25, 3);
  });

  it("keeps a scope within its byte budget, dropping the least valuable first", async () => {
    const { writeFile } = await import("node:fs/promises");
    const store = new KvStore(dir);
    for (const [name, hits, hours] of [
      ["old-unused", 0, 48],
      ["hot", 20, 1],
      ["recent", 0, 0],
    ] as const) {
      await writeFile(join(dir, `${name}.bin`), "x".repeat(100));
      await writeFile(
        join(dir, `${name}.bin.json`),
        JSON.stringify(entry(`${name}.bin`, hits, hours)),
      );
    }
    expect(await store.enforceBudget("p", 200)).toEqual(["old-unused.bin"]);
    expect((await store.list()).map((e) => e.file).sort()).toEqual(["hot.bin", "recent.bin"]);
  });

  it("hashes prefixes at message boundaries, the start alone first", () => {
    const a = prefixHashes({ system: "s", tools: [], messages: [user("1"), user("2")] });
    const b = prefixHashes({ system: "s", tools: [], messages: [user("1"), user("3")] });
    const c = prefixHashes({ system: "other", tools: [], messages: [user("1")] });
    const d = prefixHashes({ system: "s", tools: [], messages: [user("new")] });
    expect(a).toHaveLength(3);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).not.toBe(b[2]);
    expect(c[0]).not.toBe(a[0]);
    // A new conversation of the same agent shares the start (system and tools) with the others.
    expect(d[0]).toBe(a[0]);
    expect(d[1]).not.toBe(a[1]);
  });

  it("finds another conversation's cache for a new one of the same agent, and the old files too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-kv-start-"));
    const store = new KvStore(dir);
    const saved = prefixHashes({ system: "s", tools: [], messages: [user("1"), user("2")] });
    const base = { scope: "p", model: "m.gguf", ctx: 8192, tokens: 3000, reason: "turn" as const };
    await writeFile(join(dir, "a.bin"), "x");
    await store.put({ ...base, file: "a.bin", sessionId: "a", prefixHashes: saved, v: 2 });
    const fresh = prefixHashes({ system: "s", tools: [], messages: [user("Ciao di nuovo")] });
    expect(
      await store.find({ scope: "p", model: "m.gguf", ctx: 8192, hashes: fresh }),
    ).toMatchObject({ entry: { file: "a.bin" }, messages: 1 });
    // Another agent's start: nothing.
    const other = prefixHashes({ system: "other", tools: [], messages: [user("x")] });
    expect(
      await store.find({ scope: "p", model: "m.gguf", ctx: 8192, hashes: other }),
    ).toBeUndefined();
    // A file saved before version 2 (no hash of the start alone) still serves its conversation.
    await rm(join(dir, "a.bin.json"));
    await writeFile(join(dir, "old.bin"), "x");
    await store.put({ ...base, file: "old.bin", sessionId: "old", prefixHashes: saved.slice(1) });
    const next = prefixHashes({
      system: "s",
      tools: [],
      messages: [user("1"), user("2"), user("3")],
    });
    expect(
      await store.find({ scope: "p", model: "m.gguf", ctx: 8192, hashes: next }),
    ).toMatchObject({ entry: { file: "old.bin" }, messages: 3 });
  });
});
