import type { ModelSpec } from "@redgiant/protocol";
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
 */
export async function* streamWithFallback(
  registry: ProviderRegistry,
  spec: ModelSpec,
  request: Omit<CompletionRequest, "model">,
  signal?: AbortSignal,
  retryDelaysMs: readonly number[] = [1000, 4000],
): AsyncIterable<StreamEvent> {
  let current: ModelSpec | undefined = spec;
  let lastError: unknown;
  // A fallback without its own effort inherits the one of the model it replaces.
  let effort = request.effort;
  let retries = 0;
  while (current) {
    effort = current.effort ?? effort;
    const attempt: CompletionRequest = { ...request, model: current.model, effort };
    let emitted = false;
    try {
      for await (const event of registry.get(current.provider).stream(attempt, signal)) {
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
      if (emitted || !(err instanceof ProviderError) || !err.retriable) throw err;
      lastError = err;
      const pause = retryDelaysMs[retries];
      if (pause !== undefined && !signal?.aborted) {
        retries++;
        await new Promise((r) => setTimeout(r, pause));
        continue;
      }
    }
    retries = 0;
    current = current.fallback;
  }
  throw lastError instanceof Error ? lastError : new ProviderError("All models refused", false);
}

/** Drains a stream and returns the final completion. */
export async function complete(events: AsyncIterable<StreamEvent>) {
  for await (const event of events) {
    if (event.type === "done") return event.completion;
  }
  throw new Error("Stream ended without a completion");
}
