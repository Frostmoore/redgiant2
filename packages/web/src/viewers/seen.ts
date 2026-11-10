// How long an agent's highlight stays (p3.5.4, the person's test of 3.5.3 on Windows: the edits
// were there but never seen highlighted). The time counts only while the person can see the
// editor: the page in front and the editor on screen (not a hidden tab of the canvas, not a
// browser tab in the background), so a highlight made while they read the chat or looked
// elsewhere is still there when they look. Since p3.5.6 (the person's test of 3.5.5: the
// highlights went while «God sta modificando» was still shown) the time starts once no agent is
// editing the file anymore.

/** How long a highlight stays once the person can see it. */
export const HIGHLIGHT_SEEN_MS = 12_000;
/** How often the time seen is counted. */
export const SEEN_TICK_MS = 500;

/** Whether the page is in front (a browser tab in the background counts nothing). */
export const pageShown = (): boolean =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/** Whether an element is on screen: connected, laid out (not in a hidden tab), the page in front. */
export const elementShown =
  (el: () => Element | null | undefined): (() => boolean) =>
  () => {
    const e = el();
    return !!e && e.isConnected && e.getClientRects().length > 0 && pageShown();
  };

/**
 * Calls `done` once `shown()` has been true for `ms` in all (counted every `SEEN_TICK_MS`), not
 * counting while `busy()` (p3.5.6: an agent still editing the file, «… sta modificando»: its
 * highlights stay for the whole turn, then for `ms` seen). Returns a function that cancels it.
 */
export function afterSeen(
  ms: number,
  done: () => void,
  shown: () => boolean = pageShown,
  busy: () => boolean = () => false,
) {
  let seen = 0;
  const timer = setInterval(() => {
    if (!shown() || busy()) return;
    seen += SEEN_TICK_MS;
    if (seen < ms) return;
    clearInterval(timer);
    done();
  }, SEEN_TICK_MS);
  return () => clearInterval(timer);
}
