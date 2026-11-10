import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_STALL,
  type CompletionRequest,
  LOCAL_STALL,
  type Provider,
  ProviderRegistry,
  ProviderStalledError,
  type StreamEvent,
  setStallLog,
  streamWithFallback,
} from "../src/index.js";

const usage = { inputTokens: 1, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };
const done = (provider: string, model: string): StreamEvent => ({
  type: "done",
  completion: {
    message: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    stopReason: "end_turn",
    usage,
    metrics: {
      startedAt: "",
      inputTokens: 1,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      contextUsed: 2,
      contextWindow: 10,
      prefillMs: 0,
      decodeMs: 0,
      tokPerSec: 0,
      source: "client",
    },
    model,
    provider,
  },
});

/** A provider that answers as `script` says for each try: "silent" never sends anything. */
function scripted(
  id: string,
  script: ("silent" | "answer" | "stops")[],
  limits?: Provider["stall"],
): Provider & { tries: number; aborted: number } {
  const p = {
    id,
    stall: limits,
    tries: 0,
    aborted: 0,
    modelInfo: (model: string) => ({
      id: model,
      contextWindow: 10,
      maxOutputTokens: 10,
      supportsEffort: false,
    }),
    async *stream(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      const mode = script[p.tries++] ?? "answer";
      signal?.addEventListener("abort", () => p.aborted++, { once: true });
      if (mode === "answer") {
        yield { type: "text_delta", text: "hi" };
        yield done(id, req.model);
        return;
      }
      if (mode === "stops") yield { type: "thinking_delta", text: "hm" };
      // Silent: waits for ever (only the abort could end it, and this provider ignores it).
      await new Promise(() => {});
    },
  };
  return p;
}

const drain = async (events: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const request = { system: "", tools: [], messages: [] };
let lines: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  setStallLog((l) => lines.push(l));
});
afterEach(() => {
  vi.useRealTimers();
  setStallLog((l) => console.warn(l));
});

describe("a provider that stops answering", () => {
  it("is cancelled at the first-token limit and tried again, then answers", async () => {
    const p = scripted("cloud", ["silent", "answer"]);
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(p),
        { provider: "cloud", model: "m" },
        request,
      ),
    );
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.firstTokenMs + 10_000);
    const events = await run;
    expect(events.at(-1)?.type).toBe("done");
    expect(p.tries).toBe(2);
    // The stalled try was really aborted.
    expect(p.aborted).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /cloud\/m: no first token after 180s, cancelled; trying again in 10s \(1\/2\)/,
    );
  });

  it("stops the turn after two new tries with growing pauses, saying how long it waited", async () => {
    const p = scripted("cloud", ["silent", "silent", "silent"]);
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(p),
        { provider: "cloud", model: "m" },
        request,
      ),
    ).catch((e: unknown) => e);
    // Not yet after the first pause: the second try is waiting.
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.firstTokenMs + 10_000);
    expect(p.tries).toBe(2);
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.firstTokenMs + 30_000);
    expect(p.tries).toBe(3);
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.firstTokenMs);
    const err = await run;
    expect(err).toBeInstanceOf(ProviderStalledError);
    const e = err as ProviderStalledError;
    expect(e.code).toBe("provider_stalled");
    expect(e.retries).toBe(2);
    expect(e.minutes).toBe(10);
    expect(e.params).toEqual({ minutes: "10", retries: "2" });
    expect(p.aborted).toBe(3);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/trying again in 30s \(2\/2\)/);
    expect(lines[2]).toMatch(/2 new tries done, the turn stops/);
  });

  it("moves to the agent's fallback model after the tries, never changing the model itself", async () => {
    const a = scripted("a", ["silent", "silent", "silent"]);
    const b = scripted("b", ["answer"]);
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(a).register(b),
        { provider: "a", model: "m", fallback: { provider: "b", model: "n" } },
        request,
        undefined,
        [1000, 4000],
        [10, 20],
      ),
    );
    await vi.advanceTimersByTimeAsync(3 * CLOUD_STALL.firstTokenMs + 100);
    const events = await run;
    const last = events.at(-1);
    expect(last?.type === "done" && last.completion.provider).toBe("b");
    expect(lines.at(-1)).toMatch(/moving to b\/n/);
  });

  it("counts a stream that stops in the middle (idle limit) and ignores alive events", async () => {
    const p = scripted("cloud", ["stops", "answer"]);
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(p),
        { provider: "cloud", model: "m" },
        request,
      ),
    );
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.idleMs + 10_000);
    const events = await run;
    expect(events.some((e) => e.type === "alive")).toBe(false);
    expect(lines[0]).toMatch(/the answer stopped after 120s/);
  });

  it("gives a local engine its own, longer limit", async () => {
    const p = scripted("local", ["silent", "answer"], LOCAL_STALL);
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(p),
        { provider: "local", model: "m" },
        request,
      ),
    );
    await vi.advanceTimersByTimeAsync(CLOUD_STALL.firstTokenMs * 2);
    expect(p.tries).toBe(1);
    await vi.advanceTimersByTimeAsync(LOCAL_STALL.firstTokenMs);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(p.tries).toBe(2);
  });

  it("never fires while signs of life keep coming", async () => {
    let n = 0;
    const p: Provider = {
      id: "slow",
      modelInfo: (model) => ({
        id: model,
        contextWindow: 1,
        maxOutputTokens: 1,
        supportsEffort: false,
      }),
      async *stream(req) {
        // Ten minutes of thinking, a piece every minute.
        for (; n < 10; n++) {
          await new Promise((r) => setTimeout(r, 60_000));
          yield { type: "alive" };
        }
        yield done("slow", req.model);
      },
    };
    const run = drain(
      streamWithFallback(
        new ProviderRegistry().register(p),
        { provider: "slow", model: "m" },
        request,
      ),
    );
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect((await run).at(-1)?.type).toBe("done");
    expect(lines).toEqual([]);
  });
});
