// Phones and tablets (3.5.11, G37.9): when the canvas covers the chat, when an editor's bars
// fold, and the arithmetic of two fingers (pinch to zoom, pan). Pure functions, tested as tables;
// the components read the media queries through `coversNow`/`compactWidth`.

import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

/** A phone in portrait (the layout's long-standing threshold). */
export const PHONE_MAX = 760;
/** A tablet, or a phone on its side: with a finger, up to this width the canvas covers the chat. */
export const COVER_MAX = 1100;
/** The same decision as a media query, for CSS and `matchMedia`. */
export const COVER_QUERY = `(max-width: ${PHONE_MAX}px), (pointer: coarse) and (max-width: ${COVER_MAX}px)`;

/**
 * Whether the area on the right covers the chat (with «Chat» to go back) instead of sitting
 * beside it: always on a phone; with a finger (a tablet, a phone on its side) while beside the
 * left bar and the chat it would be too narrow to work in.
 */
export function canvasCovers(width: number, coarse: boolean): boolean {
  return width <= PHONE_MAX || (coarse && width <= COVER_MAX);
}

export const coversNow = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(COVER_QUERY).matches;

/** An editor narrower than this puts its tools in a bar at the bottom and its panels in a sheet. */
export const EDITOR_COMPACT = 600;
export const compactWidth = (width: number): boolean => width > 0 && width < EDITOR_COMPACT;

/** The smallest side of something pressed with a finger (WCAG 2.5.5, Apple's and Google's 44-48). */
export const TOUCH_TARGET = 44;

/** How big the 3D handles are: larger where a finger has to catch them. */
export const gizmoSize = (coarse: boolean): number => (coarse ? 1.6 : 1);

export type Pt = readonly [number, number];

/**
 * Two fingers from `prev` to `now`: how much they spread (`factor`, over 1 = zoom in), the point
 * between them now (`mid`) and how far that point moved (`pan`). A finger on the other's spot
 * (distance 0) changes nothing.
 */
export function pinchStep(
  prev: readonly [Pt, Pt],
  now: readonly [Pt, Pt],
): { factor: number; mid: Pt; pan: Pt } {
  const d0 = Math.hypot(prev[1][0] - prev[0][0], prev[1][1] - prev[0][1]);
  const d1 = Math.hypot(now[1][0] - now[0][0], now[1][1] - now[0][1]);
  const m0: Pt = [(prev[0][0] + prev[1][0]) / 2, (prev[0][1] + prev[1][1]) / 2];
  const mid: Pt = [(now[0][0] + now[1][0]) / 2, (now[0][1] + now[1][1]) / 2];
  const factor = d0 > 0 && d1 > 0 ? d1 / d0 : 1;
  return { factor, mid, pan: [mid[0] - m0[0], mid[1] - m0[1]] };
}

/**
 * Where to scroll so the point that was under the fingers stays under them after a zoom from
 * `z0` to `z1` (a picture in a scrolling box): `at` is the point on screen relative to the box,
 * `scroll` the box's scroll before, `pan` how far the fingers moved together.
 */
export function anchoredScroll(scroll: Pt, at: Pt, z0: number, z1: number, pan: Pt = [0, 0]): Pt {
  const k = z1 / z0;
  return [(scroll[0] + at[0]) * k - at[0] - pan[0], (scroll[1] + at[1]) * k - at[1] - pan[1]];
}

/**
 * The touch points on an element, by pointer id (pointer events of type "touch"): one finger
 * draws, two pan and zoom. Once a second finger came, the gesture stays a pinch until every
 * finger is lifted (lifting one does not start a stroke).
 */
export class Fingers {
  private readonly at = new Map<number, Pt>();
  private pinching = false;
  private last: [Pt, Pt] | undefined;

  /** A finger down: "pinch" when it is the second (the stroke under way must be dropped). */
  down(id: number, p: Pt): "one" | "pinch" | "ignore" {
    if (this.pinching) {
      this.at.set(id, p);
      return "ignore";
    }
    this.at.set(id, p);
    if (this.at.size === 1) return "one";
    this.pinching = true;
    this.last = this.two();
    return "pinch";
  }

  /** A finger moved: the step of the pinch, or undefined when not pinching (a stroke goes on). */
  move(id: number, p: Pt): ReturnType<typeof pinchStep> | undefined {
    if (!this.at.has(id)) return undefined;
    this.at.set(id, p);
    if (!this.pinching) return undefined;
    const now = this.two();
    const prev = this.last;
    if (!now || !prev) return undefined;
    this.last = now;
    return pinchStep(prev, now);
  }

  /** A finger up (or cancelled): whether the event belonged to a pinch (and is not a stroke's end). */
  up(id: number): boolean {
    const was = this.pinching;
    this.at.delete(id);
    if (this.at.size === 0) {
      this.pinching = false;
      this.last = undefined;
    } else if (this.pinching) this.last = this.two();
    return was;
  }

  get active(): boolean {
    return this.pinching;
  }

  private two(): [Pt, Pt] | undefined {
    const [a, b] = [...this.at.values()];
    return a && b ? [a, b] : undefined;
  }
}

/**
 * Whether an element is narrower than `EDITOR_COMPACT` now (a ResizeObserver: the canvas may sit
 * beside the chat on a desktop as narrow as a phone). False until measured, and while hidden.
 */
export function useCompact(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setCompact(compactWidth(el.clientWidth));
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  }, []);
  return compact;
}

/** Whether the main pointer is a finger (a phone, a tablet). */
export const coarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

/** A phone, not a tablet: a finger and a screen whose short side is under 600 px. */
export const isPhoneScreen = (w: number, h: number, coarse: boolean): boolean =>
  coarse && Math.min(w, h) > 0 && Math.min(w, h) < 600;

export const phoneScreen = (): boolean =>
  typeof screen !== "undefined" && isPhoneScreen(screen.width, screen.height, coarsePointer());
