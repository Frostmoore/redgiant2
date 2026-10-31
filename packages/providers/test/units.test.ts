import { describe, expect, it } from "vitest";
import {
  BudgetTracker,
  complete,
  costUsd,
  FakeProvider,
  MetricsClock,
  ProviderError,
  ProviderRegistry,
  sseData,
  streamWithFallback,
} from "../src/index.js";

const usage = { inputTokens: 1000, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };

describe("MetricsClock", () => {
  it("measures prefill to the first token and decode after it", () => {
    let t = 1_000;
    const clock = new MetricsClock(() => t);
    t = 1_250;
    clock.token();
    t = 1_300;
    clock.token();
    t = 2_250;
    const m = clock.finish(usage, 8192);
    expect(m).toMatchObject({
      prefillMs: 250,
      decodeMs: 1000,
      tokPerSec: 100,
      source: "client",
      contextUsed: 1100,
    });
  });

  it("prefers server timings when both are present", () => {
    const m = new MetricsClock(() => 0).finish(usage, 8192, { prefillMs: 5, decodeMs: 20 });
    expect(m).toMatchObject({ prefillMs: 5, decodeMs: 20, source: "server", tokPerSec: 5000 });
  });
});

describe("costUsd", () => {
  it("is zero without pricing (local models)", () => {
    expect(costUsd(usage, undefined)).toBe(0);
  });
});

describe("BudgetTracker", () => {
  it("reports breaches on every scope that went over", () => {
    const b = new BudgetTracker();
    const agent = { scope: "agent" as const, id: "a1" };
    const project = { scope: "project" as const, id: "p1" };
    const global = { scope: "global" as const, id: "all" };
    b.setLimit(agent, { tokens: 1500 });
    b.setLimit(global, { usd: 1 });
    expect(b.record([agent, project, global], usage, 0.4)).toEqual([]);
    const breaches = b.record([agent, project, global], usage, 0.7);
    expect(breaches.map((x) => x.key.scope)).toEqual(["agent", "global"]);
    expect(b.check([project])).toEqual([]);
    expect(b.used(global)).toEqual({ usd: 1.1, tokens: 2200 });
  });
});

describe("sseData", () => {
  it("handles CRLF, multi-line data and events split across chunks", async () => {
    const parts = [
      'data: {"a":',
      "1}\r\n\r\nevent: x\r\ndata: line1\r\ndata: line2\r\n\r\n",
      ": comment\n\ndata: tail",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    expect(out).toEqual(['{"a":1}', "line1\nline2", "tail"]);
  });
});

describe("streamWithFallback", () => {
  const req = {
    system: "",
    tools: [],
    messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "x" }] }],
  };

  it("moves to the fallback on a retriable error before any output", async () => {
    const primary = new FakeProvider([{ error: new ProviderError("529", true) }], { id: "cloud" });
    const backup = new FakeProvider([{ text: "from backup" }], { id: "local" });
    const reg = new ProviderRegistry().register(primary).register(backup);
    const c = await complete(
      streamWithFallback(
        reg,
        {
          provider: "cloud",
          model: "big",
          effort: "high",
          fallback: { provider: "local", model: "small" },
        },
        req,
      ),
    );
    expect(c.provider).toBe("local");
    expect(backup.requests[0]).toMatchObject({ model: "small", effort: "high" });
  });

  it("moves to the fallback on a refusal with no output", async () => {
    const reg = new ProviderRegistry()
      .register(new FakeProvider([{ stopReason: "refusal" }], { id: "a" }))
      .register(new FakeProvider([{ text: "ok" }], { id: "b" }));
    const c = await complete(
      streamWithFallback(
        reg,
        { provider: "a", model: "m", fallback: { provider: "b", model: "n" } },
        req,
      ),
    );
    expect(c.provider).toBe("b");
  });

  it("does not fall back on a non-retriable error", async () => {
    const reg = new ProviderRegistry()
      .register(new FakeProvider([{ error: new ProviderError("400", false) }], { id: "a" }))
      .register(new FakeProvider([{ text: "ok" }], { id: "b" }));
    await expect(
      complete(
        streamWithFallback(
          reg,
          { provider: "a", model: "m", fallback: { provider: "b", model: "n" } },
          req,
        ),
      ),
    ).rejects.toMatchObject({ retriable: false });
  });
});

describe("FakeProvider", () => {
  it("records requests and fails loudly when the script runs out", async () => {
    const p = new FakeProvider([{ text: "one" }]);
    const req = { model: "m", system: "", tools: [], messages: [] };
    await complete(p.stream(req));
    expect(p.requests).toHaveLength(1);
    await expect(complete(p.stream(req))).rejects.toThrow(/no scripted turn/);
  });
});
