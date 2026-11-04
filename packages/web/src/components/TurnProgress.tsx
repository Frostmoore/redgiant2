// What the model is doing right now (2026-11-03, the person's request): reading the context
// (prefill) with how much is done, how fast and how much came from the cache, or writing,
// reasoning or the answer, with its speed. Local engines report the reading as it goes; for
// the others the wait is timed until the first token arrives.
import { useEffect, useState } from "preact/hooks";
import { kTokens } from "../format.js";
import { t } from "../i18n.js";
import type { ModelCall } from "../state.js";

/** Characters a token is worth, roughly: the live speed is an estimate until the end. */
const CHARS_PER_TOKEN = 4;

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function TurnProgress({ call }: { call: ModelCall }) {
  // Times move by themselves: the line is redrawn a few times a second.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  const p = call.prefill;

  if (call.firstToken === undefined) {
    const known = p && p.total > 0;
    const fresh = p ? Math.max(0, p.processed - p.cached) : 0;
    const rate = p && p.ms > 0 ? fresh / (p.ms / 1000) : undefined;
    const done = known ? p.processed / p.total : undefined;
    return (
      <div class="turn-progress" role="status">
        <div class="turn-progress-head">
          <strong>{t("tpReading")}</strong>
          <span class="dim">{secs(now - call.since)}</span>
        </div>
        <div class={`ui-bar${done === undefined ? " busy" : ""}`}>
          <span style={done === undefined ? undefined : { width: pct(done) }} />
        </div>
        <div class="turn-progress-stats dim">
          {known ? (
            <>
              <span>{t("tpTokens", { done: kTokens(p.processed), total: kTokens(p.total) })}</span>
              {rate !== undefined && rate > 0 && (
                <span>{t("tpRate", { n: String(Math.round(rate)) })}</span>
              )}
              <span class={p.cached / p.total >= 0.5 ? "tp-good" : ""}>
                {t("tpCache", { pct: pct(p.cached / p.total) })}
              </span>
            </>
          ) : (
            <span>{t("tpWaitingFirst")}</span>
          )}
        </div>
      </div>
    );
  }

  const elapsed = Math.max(1, now - call.firstToken);
  const tokens = call.chars / CHARS_PER_TOKEN;
  const rate = tokens / (elapsed / 1000);
  return (
    <div class="turn-progress" role="status">
      <div class="turn-progress-head">
        <strong>{call.writing === "thinking" ? t("tpThinking") : t("tpWriting")}</strong>
        <span class="dim">{secs(elapsed)}</span>
      </div>
      <div class="ui-bar busy">
        <span />
      </div>
      <div class="turn-progress-stats dim">
        <span>{t("tpWritten", { n: kTokens(Math.round(tokens)) })}</span>
        {elapsed > 800 && <span>{t("tpGenRate", { n: String(Math.round(rate)) })}</span>}
        {p && p.total > 0 && (
          <span>
            {t("tpReadIn", {
              total: kTokens(p.total),
              time: secs(call.firstToken - call.since),
              pct: pct(p.cached / p.total),
            })}
          </span>
        )}
        {!p && <span>{t("tpFirstAfter", { time: secs(call.firstToken - call.since) })}</span>}
      </div>
    </div>
  );
}
