// Fingers for an editor made for a mouse (3.5.11, G37.9): the sheet (Univer) takes a finger's
// drag as a selection and never scrolls. Here one finger moving scrolls (as wheel steps), a tap
// is a click (two taps a double click, to type in a cell), a long press starts a mouse drag (a
// selection of cells), and two fingers zoom (Ctrl+wheel). `TouchMouse` decides, pure; `touchAsMouse`
// wires it to an element, keeping the touch's own pointer events from the editor.

import type { Pt } from "../phone.js";
import { pinchStep } from "../phone.js";

/** A finger that moved more than this before the long press scrolls. */
export const SLOP = 8;
/** Held this long without moving: a press (a mouse button down where the finger is). */
export const LONG_PRESS = 450;

/** Two taps this close in time (ms) and space (px) are a double click. */
export const DOUBLE_TAP = 350;
export const DOUBLE_TAP_SLOP = 24;

export type MouseOut =
  | { t: "down" | "move" | "up" | "dblclick"; at: Pt }
  | { t: "wheel"; at: Pt; dx: number; dy: number }
  | { t: "zoom"; at: Pt; factor: number };

type State = "idle" | "pending" | "scroll" | "press" | "pinch" | "done";

export class TouchMouse {
  private state: State = "idle";
  private readonly at = new Map<number, Pt>();
  private start: Pt = [0, 0];
  private last: Pt = [0, 0];
  private pair: [Pt, Pt] | undefined;
  private lastTap: { at: Pt; time: number } | undefined;

  constructor(private readonly emit: (o: MouseOut) => void) {}

  get mode(): State {
    return this.state;
  }

  down(id: number, p: Pt): void {
    this.at.set(id, p);
    if (this.at.size === 1 && (this.state === "idle" || this.state === "done")) {
      this.state = "pending";
      this.start = p;
      this.last = p;
      return;
    }
    if (this.at.size === 2) {
      // A second finger: whatever the first began becomes a pinch (a press lets go first).
      if (this.state === "press") this.emit({ t: "up", at: this.last });
      this.state = "pinch";
      this.pair = this.two();
    }
  }

  move(id: number, p: Pt): void {
    if (!this.at.has(id)) return;
    this.at.set(id, p);
    switch (this.state) {
      case "pending":
        if (Math.hypot(p[0] - this.start[0], p[1] - this.start[1]) <= SLOP) return;
        this.state = "scroll";
        this.wheel(p);
        return;
      case "scroll":
        this.wheel(p);
        return;
      case "press":
        this.last = p;
        this.emit({ t: "move", at: p });
        return;
      case "pinch": {
        const now = this.two();
        if (!now || !this.pair) return;
        const s = pinchStep(this.pair, now);
        this.pair = now;
        if (s.factor !== 1) this.emit({ t: "zoom", at: s.mid, factor: s.factor });
        return;
      }
    }
  }

  /** The long press's time came (the caller's timer): still in place, it is a press. */
  press(): void {
    if (this.state !== "pending") return;
    this.state = "press";
    this.emit({ t: "down", at: this.start });
  }

  /** A finger lifted at `now` (ms): a tap is a click, a second tap close by a double click. */
  up(id: number, now: number = Date.now()): void {
    if (!this.at.delete(id)) return;
    if (this.state === "pending") {
      this.emit({ t: "down", at: this.start });
      this.emit({ t: "up", at: this.start });
      const prev = this.lastTap;
      if (
        prev &&
        now - prev.time <= DOUBLE_TAP &&
        Math.hypot(prev.at[0] - this.start[0], prev.at[1] - this.start[1]) <= DOUBLE_TAP_SLOP
      ) {
        this.emit({ t: "dblclick", at: this.start });
        this.lastTap = undefined;
      } else this.lastTap = { at: this.start, time: now };
    } else {
      this.lastTap = undefined;
      if (this.state === "press") this.emit({ t: "up", at: this.last });
    }
    if (this.at.size === 0) this.state = "idle";
    else if (this.state !== "pinch") this.state = "done";
    else this.pair = undefined;
  }

  private wheel(p: Pt) {
    this.emit({ t: "wheel", at: p, dx: this.last[0] - p[0], dy: this.last[1] - p[1] });
    this.last = p;
  }

  private two(): [Pt, Pt] | undefined {
    const [a, b] = [...this.at.values()];
    return a && b ? [a, b] : undefined;
  }
}

/**
 * Puts `TouchMouse` between the fingers and an element: the touch's pointer events stop here
 * (capture), the editor gets mouse events and wheel steps at the same points. Returns the undo.
 */
export function touchAsMouse(el: HTMLElement): () => void {
  let target: Element = el;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (o: MouseOut) => {
    const [x, y] = o.at;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    const into = (document.elementFromPoint(x, y) as Element | null) ?? target;
    if (o.t === "wheel" || o.t === "zoom") {
      const dy = o.t === "wheel" ? o.dy : (1 - o.factor) * 300;
      into.dispatchEvent(
        new WheelEvent("wheel", {
          ...base,
          deltaX: o.t === "wheel" ? o.dx : 0,
          deltaY: dy,
          deltaMode: 0,
          ctrlKey: o.t === "zoom",
        }),
      );
      return;
    }
    if (o.t === "dblclick") {
      target.dispatchEvent(new MouseEvent("dblclick", { ...base, button: 0, detail: 2 }));
      return;
    }
    const type = o.t === "down" ? "pointerdown" : o.t === "move" ? "pointermove" : "pointerup";
    const buttons = o.t === "up" ? 0 : 1;
    const ptr = {
      ...base,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons,
    };
    const at = o.t === "down" ? into : target;
    if (o.t === "down") target = into;
    at.dispatchEvent(new PointerEvent(type, ptr));
    const mouse = o.t === "down" ? "mousedown" : o.t === "move" ? "mousemove" : "mouseup";
    at.dispatchEvent(new MouseEvent(mouse, { ...base, button: 0, buttons }));
    if (o.t === "up") at.dispatchEvent(new MouseEvent("click", { ...base, button: 0 }));
  };
  const tm = new TouchMouse(send);
  const mine = (e: PointerEvent) =>
    e.pointerType === "touch" && e.isTrusted && el.contains(e.target as Node);
  const down = (e: PointerEvent) => {
    if (!mine(e)) return;
    // Menus, fields and buttons of the editor's own bars keep their fingers.
    if (!(e.target instanceof HTMLCanvasElement)) return;
    e.stopPropagation();
    e.preventDefault();
    target = e.target;
    tm.down(e.pointerId, [e.clientX, e.clientY]);
    clearTimeout(timer);
    if (tm.mode === "pending") timer = setTimeout(() => tm.press(), LONG_PRESS);
  };
  const move = (e: PointerEvent) => {
    if (!mine(e) || tm.mode === "idle") return;
    e.stopPropagation();
    e.preventDefault();
    tm.move(e.pointerId, [e.clientX, e.clientY]);
    if (tm.mode !== "pending") clearTimeout(timer);
  };
  const up = (e: PointerEvent) => {
    if (!mine(e) || tm.mode === "idle") return;
    e.stopPropagation();
    clearTimeout(timer);
    tm.up(e.pointerId);
  };
  // The fingers are ours: the browser neither scrolls nor zooms the page under them.
  const touch = (e: TouchEvent) => {
    if (e.target instanceof HTMLCanvasElement) e.preventDefault();
  };
  el.addEventListener("pointerdown", down, true);
  el.addEventListener("pointermove", move, true);
  el.addEventListener("pointerup", up, true);
  el.addEventListener("pointercancel", up, true);
  el.addEventListener("touchmove", touch, { capture: true, passive: false });
  return () => {
    clearTimeout(timer);
    el.removeEventListener("pointerdown", down, true);
    el.removeEventListener("pointermove", move, true);
    el.removeEventListener("pointerup", up, true);
    el.removeEventListener("pointercancel", up, true);
    el.removeEventListener("touchmove", touch, true);
  };
}
