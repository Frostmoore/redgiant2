import type { MessageMetrics } from "@redgiant/protocol";
import type { ServerTimings, Usage } from "./types.js";

/** Measures a streamed request from the client side. `now` is injectable for tests. */
export class MetricsClock {
  private readonly startedAt: number;
  private firstTokenAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** Call on every streamed token; only the first call is recorded. */
  token(): void {
    this.firstTokenAt ??= this.now();
  }

  finish(usage: Usage, contextWindow: number, server?: ServerTimings): MessageMetrics {
    const endedAt = this.now();
    const fromServer = server?.prefillMs !== undefined && server.decodeMs !== undefined;
    const prefillMs = fromServer
      ? server.prefillMs
      : this.firstTokenAt !== undefined
        ? this.firstTokenAt - this.startedAt
        : undefined;
    const decodeMs = fromServer
      ? server.decodeMs
      : this.firstTokenAt !== undefined
        ? endedAt - this.firstTokenAt
        : undefined;
    const metrics: MessageMetrics = {
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      inputTokens: usage.inputTokens,
      cachedReadTokens: usage.cachedReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      contextUsed: usage.inputTokens + usage.outputTokens,
      contextWindow,
      source: fromServer ? "server" : "client",
    };
    if (this.firstTokenAt !== undefined) {
      metrics.firstTokenAt = new Date(this.firstTokenAt).toISOString();
    }
    if (prefillMs !== undefined) metrics.prefillMs = prefillMs;
    if (decodeMs !== undefined) {
      metrics.decodeMs = decodeMs;
      // The server's own count goes with its own time; a rate no machine reaches (a burst of a
      // whole tool call at the end, 4,563 tokens a second seen 2026-11-04) is not a speed.
      const tokens =
        fromServer && server?.decodeTokens !== undefined ? server.decodeTokens : usage.outputTokens;
      const rate = decodeMs > 0 ? (tokens * 1000) / decodeMs : 0;
      if (rate > 0 && rate < 1500) metrics.tokPerSec = rate;
    }
    return metrics;
  }
}
