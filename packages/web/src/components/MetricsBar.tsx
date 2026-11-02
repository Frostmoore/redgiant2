import type { MessageMetrics } from "@redgiant/protocol";
import { clock, duration, kTokens, usd } from "../format.js";
import { t } from "../i18n.js";

/**
 * The per-message bar: how much of the context the request used (read from cache, read
 * new, generated), with the numbers and timings beside it.
 */
export function MetricsBar({
  m,
  costUsd,
  model,
  compactAt,
}: {
  m: MessageMetrics;
  costUsd?: number;
  model?: string;
  /** Where a summary is made (G24.14c): a mark on the bar. */
  compactAt?: number | undefined;
}) {
  const pct = (n: number) => `${Math.min(100, (n / m.contextWindow) * 100)}%`;
  const fresh = Math.max(0, m.inputTokens - m.cachedReadTokens);
  const used = Math.round((m.contextUsed / m.contextWindow) * 1000) / 10;
  const title = [
    model,
    `start ${m.startedAt}`,
    m.firstTokenAt && `first token ${m.firstTokenAt}`,
    m.endedAt && `end ${m.endedAt}`,
    m.source === "client" ? t("timedByClient") : "server timings",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div class="metrics" title={title} data-testid="metrics">
      <div class="metrics-bar" aria-hidden="true">
        <span class="seg cached" style={{ width: pct(m.cachedReadTokens) }} />
        <span class="seg fresh" style={{ width: pct(fresh) }} />
        <span class="seg out" style={{ width: pct(m.outputTokens) }} />
        {compactAt !== undefined && (
          <span
            class="compact-mark"
            style={{ left: `${compactAt * 100}%` }}
            title={t("compactMark", { n: String(Math.round(compactAt * 100)) })}
          />
        )}
      </div>
      <div class="metrics-text">
        <span>
          {t("input")} {kTokens(m.inputTokens)}
          {m.cachedReadTokens > 0 && (
            <em>
              {" "}
              ({t("cache")} {kTokens(m.cachedReadTokens)})
            </em>
          )}
        </span>
        <span>
          {t("output")} {kTokens(m.outputTokens)}
        </span>
        <span>
          {t("context")} {used}% / {kTokens(m.contextWindow)}
        </span>
        <span>
          {t("prefill")} {duration(m.prefillMs)}
        </span>
        <span>
          {t("generation")} {duration(m.decodeMs)}
          {m.tokPerSec ? ` · ${Math.round(m.tokPerSec)} tok/s` : ""}
        </span>
        {m.kvRestoredTokens !== undefined && (
          <span class="ssd" title={t("restoredFromDisk")}>
            SSD {kTokens(m.kvRestoredTokens)} ({duration(m.kvRestoreMs)})
          </span>
        )}
        {costUsd !== undefined && costUsd > 0 && <span>{usd(costUsd)}</span>}
        <span class="dim">{clock(m.endedAt ?? m.startedAt)}</span>
      </div>
    </div>
  );
}
