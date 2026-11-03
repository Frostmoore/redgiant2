// Panels that slide away on a phone (2026-11-03, the user's request): a drawer follows the finger
// while it is dragged towards the edge it came from, and closes past a third of its width or on a
// quick flick; otherwise it springs back. Only on narrow screens, where panels cover the page.
import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

const PHONE = "(max-width: 760px)";

/**
 * `toward`: the edge the panel slides away to ("left" for the left bar, "right" for panels on
 * the right). `enabled`: whether the panel is open (and so can be dragged).
 */
export function useSwipeAway(
  ref: RefObject<HTMLElement | null>,
  toward: "left" | "right",
  onClose: () => void,
  enabled = true,
): void {
  // The latest one, without attaching the listeners again at every render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const sign = toward === "left" ? -1 : 1;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let dx = 0;
    /** null: not decided yet; true: a horizontal drag of the panel; false: a scroll. */
    let dragging: boolean | null = null;
    const reset = () => {
      el.style.transform = "";
      el.style.transition = "";
    };
    const start = (e: TouchEvent) => {
      if (!window.matchMedia(PHONE).matches || e.touches.length !== 1) return;
      const t = e.touches[0] as Touch;
      x0 = t.clientX;
      y0 = t.clientY;
      t0 = Date.now();
      dx = 0;
      dragging = null;
    };
    const move = (e: TouchEvent) => {
      if (dragging === false || !window.matchMedia(PHONE).matches) return;
      const t = e.touches[0] as Touch;
      const mx = t.clientX - x0;
      const my = t.clientY - y0;
      if (dragging === null) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        // Towards the edge and more sideways than down: the panel is being slid away.
        dragging = Math.abs(mx) > Math.abs(my) * 1.2 && mx * sign > 0;
        if (!dragging) return;
        el.style.transition = "none";
      }
      e.preventDefault();
      dx = Math.max(0, mx * sign);
      el.style.transform = `translateX(${sign * dx}px)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = null;
      const fast = dx / Math.max(1, Date.now() - t0) > 0.6;
      el.style.transition = "transform 0.18s ease";
      if (dx > el.offsetWidth / 3 || (fast && dx > 30)) {
        el.style.transform = `translateX(${sign * el.offsetWidth}px)`;
        setTimeout(() => {
          // Closed first: the panel's own closed position takes over before the drag's is dropped.
          close.current();
          requestAnimationFrame(reset);
        }, 180);
      } else {
        el.style.transform = "";
        setTimeout(reset, 180);
      }
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      reset();
    };
  }, [ref, toward, enabled]);
}
