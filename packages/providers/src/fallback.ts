import type { ModelSpec } from "@redgiant/protocol";
import {
  CLOUD_STALL,
  ProviderStalledError,
  STALL_RETRY_DELAYS_MS,
  StallWatch,
  stallLog,
} from "./stall.js";
import { type CompletionRequest, type Provider, ProviderError, type StreamEvent } from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  remove(id: string): void {
    this.providers.delete(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  get(id: string): Provider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Unknown provider "${id}"`);
    return p;
  }
}

/**
 * Streams `request` on `spec`, moving down the `fallback` chain when a model fails with a
 * retriable error or refuses **before producing any output**. Once output has been streamed
 * the result is final, whatever it is. A retriable error (429, 503, a model still loading) is
 * first tried again on the same model after a pause (2026-11-05: the OpenAI-compatible servers
 * had no retry of their own), `retryDelaysMs` apart.
 *
 * A provider that stops answering (3.5.4) is cancelled when its first sign of life does not
 * come in time, or the answer stops: the same request is made again (fresh, nothing shown yet
 * is kept) after `stallDelaysMs`, then the fallback model if there is one, then a
 * `ProviderStalledError`. One log line per stalled try. `alive` events never leave here.
 */
export async function* streamWithFallback(
  registry: ProviderRegistry,
  spec: ModelSpec,
  request: Omit<CompletionRequest, "model">,
  signal?: AbortSignal,
  retryDelaysMs: readonly number[] = [1000, 4000],
  stallDelaysMs: readonly number[] = STALL_RETRY_DELAYS_MS,
): AsyncIterable<StreamEvent> {
  let current: ModelSpec | undefined = spec;
  let lastError: unknown;
  // A fallback without its own effort inherits the one of the model it replaces.
  let effort = request.effort;
  let retries = 0;
  let stalls = 0;
  let stallStarted: number | undefined;
  while (current) {
    effort = current.effort ?? effort;
    const attempt: CompletionRequest = { ...request, model: current.model, effort };
    const provider = registry.get(current.provider);
    const limits = provider.stall ?? CLOUD_STALL;
    let emitted = false;
    // Its own cancel: a stalled try is aborted for real (the HTTP request, the engine).
    const inner = new AbortController();
    const cancel = () => inner.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) inner.abort();
    const began = Date.now();
    let stalledNow: (kind: "first" | "idle") => void = () => {};
    const stalled = new Promise<"first" | "idle">((ok) => {
      stalledNow = ok;
    });
    const watch = new StallWatch(limits, (kind) => {
      inner.abort();
      stalledNow(kind);
    });
    const it = provider.stream(attempt, inner.signal)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([it.next(), stalled.then((kind) => ({ kind }))]);
        if ("kind" in next) throw new StallSignal(next.kind);
        if (next.done) break;
        const event = next.value;
        watch.touch();
        if (event.type === "alive") continue;
        if (watch.stalled) throw new StallSignal(watch.stalled);
        if (
          event.type === "done" &&
          !emitted &&
          event.completion.stopReason === "refusal" &&
          current.fallback
        ) {
          break;
        }
        if (event.type !== "done") emitted = true;
        yield event;
        if (event.type === "done") return;
      }
    } catch (err) {
      if (err instanceof StallSignal) {
        // Whatever it still does, this try is over: its generator is closed without waiting.
        void it.return?.(undefined)?.catch(() => {});
        stallStarted ??= began;
        const waited = Math.round((Date.now() - began) / 1000);
        const what = err.kind === "first" ? "no first token" : "the answer stopped";
        if (signal?.aborted) throw err;
        const pause = stallDelaysMs[stalls];
        if (pause !== undefined) {
          stalls++;
          stallLog(
            `provider ${current.provider}/${current.model}: ${what} after ${waited}s, cancelled; trying again in ${Math.round(pause / 1000)}s (${stalls}/${stallDelaysMs.length})`,
          );
          await sleep(pause, signal);
          if (signal?.aborted) throw new ProviderError("Stopped while waiting to try again", false);
          continue;
        }
        const minutes = Math.max(1, Math.round((Date.now() - stallStarted) / 60_000));
        lastError = new ProviderStalledError(current.provider, current.model, minutes, stalls);
        stallLog(
          `provider ${current.provider}/${current.model}: ${what} after ${waited}s, cancelled; ${stalls} new tries done${current.fallback ? `, moving to ${current.fallback.provider}/${current.fallback.model}` : ", the turn stops"}`,
        );
      } else {
        if (emitted || !(err instanceof ProviderError) || !err.retriable) throw err;
        lastError = err;
        const pause = retryDelaysMs[retries];
        if (pause !== undefined && !signal?.aborted) {
          retries++;
          await new Promise((r) => setTimeout(r, pause));
          continue;
        }
      }
    } finally {
      watch.stop();
      signal?.removeEventListener("abort", cancel);
      // Closed as a for-await would close it (its own `finally` runs: recordings, slots). A
      // stalled one was already let go without waiting.
      if (!watch.stalled) await it.return?.(undefined);
    }
    retries = 0;
    stalls = 0;
    stallStarted = undefined;
    current = current.fallback;
  }
  throw lastError instanceof Error ? lastError : new ProviderError("All models refused", false);
}

/** Internal: the watch fired. */
class StallSignal extends Error {
  constructor(readonly kind: "first" | "idle") {
    super(`stalled: ${kind}`);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      ok();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** Drains a stream and returns the final completion. */
export async function complete(events: AsyncIterable<StreamEvent>) {
  for await (const event of events) {
    if (event.type === "done") return event.completion;
  }
  throw new Error("Stream ended without a completion");
}
