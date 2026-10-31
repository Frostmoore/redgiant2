import type { MessageMetrics } from "@redgiant/protocol";

const k = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const s = (ms: number | undefined) =>
  ms === undefined ? "?" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

/** The per-message bar, as one line: tokens read and cached, context, generation, timings. */
export function metricsLine(m: MessageMetrics, costUsd?: number): string {
  const pct = Math.round((m.contextUsed / m.contextWindow) * 100);
  const parts = [
    `in ${k(m.inputTokens)}${m.cachedReadTokens ? ` (cache ${k(m.cachedReadTokens)})` : ""}`,
    `out ${k(m.outputTokens)}`,
    `ctx ${pct}% of ${k(m.contextWindow)}`,
    `prefill ${s(m.prefillMs)}`,
    `gen ${s(m.decodeMs)}`,
    ...(m.tokPerSec ? [`${m.tokPerSec.toFixed(0)} tok/s`] : []),
    ...(costUsd ? [`$${costUsd.toFixed(4)}`] : []),
    new Date(m.endedAt ?? m.startedAt).toLocaleTimeString(),
  ];
  return `  ↳ ${parts.join(" · ")}${m.source === "client" ? " (timed by client)" : ""}`;
}
