import type { PriceSet, Pricing, Usage } from "./types.js";

/** The prices one request pays: a long prompt can move all of its tokens to higher prices. */
export function pricesFor(usage: Usage, pricing: Pricing): PriceSet {
  const long = pricing.longPrompt;
  return long && usage.inputTokens > long.overTokens ? long.prices : pricing;
}

/** Cost in USD of one request. Cached reads and cache writes are billed at their own rates. */
export function costUsd(usage: Usage, pricing: Pricing | undefined): number {
  const extra = usage.extraUsd ?? 0;
  if (!pricing) return extra;
  const p = pricesFor(usage, pricing);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedReadTokens - usage.cacheWriteTokens);
  const writes1h = Math.min(usage.cacheWriteTokens, usage.cacheWrite1hTokens ?? 0);
  return (
    (uncached * p.input +
      usage.cachedReadTokens * p.cacheRead +
      (usage.cacheWriteTokens - writes1h) * p.cacheWrite +
      writes1h * (p.cacheWrite1h ?? p.cacheWrite) +
      usage.outputTokens * p.output) /
      1_000_000 +
    extra
  );
}
