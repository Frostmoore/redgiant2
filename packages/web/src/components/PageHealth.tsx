// The page's own health (p3.5.4, the person's test of 3.5.3 on Windows: a page left with stale
// spinners and a «Stop» that did nothing). A strip when the connection to RedGiant is lost
// (instead of spinners forever), and one when the page uses most of the memory it may use.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconAlert, IconClose } from "../icons.js";
import { everOnline, status } from "../state.js";

/** How long a lost connection waits before the strip shows (a quick reconnection says nothing). */
export const LOST_AFTER = 3000;
/** The share of the page's memory limit from which the person is told. */
export const MEMORY_HIGH = 0.8;

/** The page's memory, where the browser says it (Chrome, Edge); undefined elsewhere. */
export function pageMemory(): { used: number; limit: number } | undefined {
  const m = (performance as unknown as { memory?: Record<string, number> }).memory;
  if (!m?.usedJSHeapSize || !m.jsHeapSizeLimit) return undefined;
  return { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit };
}

/** True when the page uses `MEMORY_HIGH` or more of its limit. */
export const memoryHigh = (m: { used: number; limit: number } | undefined): boolean =>
  !!m && m.limit > 0 && m.used / m.limit >= MEMORY_HIGH;

const mb = (n: number) => `${Math.round(n / 1048576).toLocaleString()} MB`;

/** «Collegamento a RedGiant perso: riprovo…», with «Ricarica». */
export function ConnectionLost() {
  const [shown, setShown] = useState(false);
  const lost = everOnline.value && status.value !== "online";
  useEffect(() => {
    if (!lost) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), LOST_AFTER);
    return () => clearTimeout(timer);
  }, [lost]);
  if (!lost || !shown) return null;
  return (
    <div class="banner error conn-lost" role="alert">
      <IconAlert /> <span>{t("connLost")}</span>
      <button type="button" class="link" onClick={() => location.reload()}>
        {t("connReload")}
      </button>
    </div>
  );
}

/** The page near its memory limit: close the open documents and sheets, or reload. */
export function MemoryNotice({ every = 30_000 }: { every?: number }) {
  const [memory, setMemory] = useState(pageMemory());
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setMemory(pageMemory()), every);
    return () => clearInterval(timer);
  }, [every]);
  if (hidden || !memory || !memoryHigh(memory)) return null;
  return (
    <div class="banner error" role="status">
      <IconAlert /> <span>{t("memHigh", { used: mb(memory.used), limit: mb(memory.limit) })}</span>
      <button
        type="button"
        class="icon-button"
        title={t("close")}
        aria-label={t("close")}
        onClick={() => setHidden(true)}
      >
        <IconClose />
      </button>
    </div>
  );
}
