import type { Pricing, Usage } from "./types.js";

/** Cost in USD of one request. Cached reads and cache writes are billed at their own rates. */
export function costUsd(usage: Usage, pricing: Pricing | undefined): number {
  if (!pricing) return 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedReadTokens - usage.cacheWriteTokens);
  return (
    (uncached * pricing.input +
      usage.cachedReadTokens * pricing.cacheRead +
      usage.cacheWriteTokens * pricing.cacheWrite +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}
