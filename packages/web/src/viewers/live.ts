// The canvas seen and moved by agents (G36.12). Each viewer writes where the person is (page,
// time, line, zoom…) into a plain map — no re-render, nothing sent — and the page reads it only
// when the server asks (`canvas.query`). An agent's move (`canvas.act`) waits here for its tab's
// viewer: the viewer applies it once it is ready, and the tab's head says what the agent did.
import { signal } from "@preact/signals";
import type { CanvasDo, CanvasPlace } from "@redgiant/protocol";
import { createContext } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";

/** The tab a viewer is drawn in (its side view's id); none outside the canvas. */
export const CanvasTab = createContext<string | undefined>(undefined);

const places = new Map<string, CanvasPlace>();
const kinds = new Map<string, string>();

/** Where the person is in a tab, as its viewer last said. */
export const placeOf = (id: string): CanvasPlace | undefined => places.get(id);
export const kindOfTab = (id: string): string | undefined => kinds.get(id);

export function setTabKind(id: string, kind: string | undefined): void {
  if (kind) kinds.set(id, kind);
  else kinds.delete(id);
}

/** Merges what a viewer knows (undefined values clear theirs). */
export function report(id: string, p: Partial<Record<keyof CanvasPlace, unknown>>): void {
  // A viewer's word after it took an agent's move: the move is where the person is now.
  if (!orders.value.has(id)) moving.delete(id);
  const next: Record<string, unknown> = { ...places.get(id) };
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v)))
      delete next[k];
    else next[k] = v;
  }
  places.set(id, next as CanvasPlace);
}

/**
 * A tab shows another file now (an open copy in its original's tab, p3.5.6): what its viewer
 * said of the other file goes (the original's «page 1 of 3» stayed beside a copy of 4 slides).
 */
export function forgetPlace(id: string): void {
  places.delete(id);
}

/** A tab closed: what was known about it goes. */
export function forgetTab(id: string): void {
  places.delete(id);
  kinds.delete(id);
  moving.delete(id);
  opened.delete(id);
  if (orders.value.has(id)) {
    const m = new Map(orders.value);
    m.delete(id);
    orders.value = m;
  }
}

export interface Order {
  n: number;
  do: CanvasDo;
}

/** Moves waiting for their tab's viewer. */
export const orders = signal<ReadonlyMap<string, Order>>(new Map());
/** The last move per tab, for the head's note «The agent went to page 3». */
export const lastMove = signal<{ id: string; n: number; do: CanvasDo } | undefined>(undefined);
let counter = 0;

/** Tabs an agent moved whose viewer has not said where it is since (p3.5.6). */
const moving = new Set<string>();
/** Tabs just opened (or given another file), with when: their viewer may not have said its kind. */
const opened = new Map<string, number>();

/** A tab opened now: an agent that looks gives its viewer a moment to start (p3.5.6). */
export function tabOpened(id: string): void {
  opened.set(id, Date.now());
}

export function order(id: string, d: CanvasDo): void {
  moving.add(id);
  counter++;
  orders.value = new Map(orders.value).set(id, { n: counter, do: d });
  lastMove.value = { id, n: counter, do: d };
}

/**
 * A tab loaded again after it was let go (3.5.11, viewers/warm.ts): back where the person was, as a
 * move nobody announces (no note in the tab's head); an agent's move waiting for it wins.
 */
export function restoreTab(id: string, d: CanvasDo | undefined): void {
  if (!d || orders.value.has(id)) return;
  counter++;
  orders.value = new Map(orders.value).set(id, { n: counter, do: d });
}

function consume(id: string, n: number): void {
  if (orders.value.get(id)?.n !== n) return;
  const m = new Map(orders.value);
  m.delete(id);
  orders.value = m;
  // A move that changed nothing the viewer reports (already on that page) is done in a moment.
  void (async () => {
    for (let i = 0; i < 6; i++) await frame();
    if (!orders.value.has(id)) moving.delete(id);
  })();
}

/** A viewer's way to say where the person is (a no-op outside the canvas). */
export function useReport(): (p: Partial<Record<keyof CanvasPlace, unknown>>) => void {
  const id = useContext(CanvasTab);
  return (p) => {
    if (id) report(id, p);
  };
}

/**
 * Applies an agent's move once the viewer is `ready`. `apply` answers whether it used the move;
 * a move it cannot use (a page for a video) stays for a viewer that can (a paged preview loading).
 */
export function useOrders(apply: (d: CanvasDo) => boolean, ready = true): void {
  const id = useContext(CanvasTab);
  const o = id ? orders.value.get(id) : undefined;
  const latest = useRef(apply);
  latest.current = apply;
  useEffect(() => {
    if (!id || !o || !ready) return;
    if (latest.current(o.do)) consume(id, o.n);
  }, [o?.n, ready]);
}

/** A1:C4 (or one cell) → zero-based columns and rows, inclusive; undefined when not cells. */
export function cellRange(
  cells: string | undefined,
): { c0: number; r0: number; c1: number; r1: number } | undefined {
  const m = cells
    ?.trim()
    .toUpperCase()
    .match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/);
  if (!m) return undefined;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = { c: col(m[1] as string), r: Number(m[2]) - 1 };
  const b = m[3] ? { c: col(m[3]), r: Number(m[4]) - 1 } : a;
  return {
    c0: Math.min(a.c, b.c),
    r0: Math.min(a.r, b.r),
    c1: Math.max(a.c, b.c),
    r1: Math.max(a.r, b.r),
  };
}

/** The next frame (or a short pause where frames do not come, a page in the background). */
const frame = () =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, 50);
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => {
        clearTimeout(timer);
        done();
      });
  });

/**
 * Waits, at most `maxMs`, until the canvas says what the person sees (p3.5.6: canvas_look right
 * after canvas_act read «page 1» while the PDF was turning to page 2, and right after show_file
 * the new tab had no viewer yet): every agent's move taken and reported, every tab just opened
 * knowing its kind. `open` lists the tabs there now. Never waits longer: a move no viewer can use
 * (a page for a video) only costs the wait.
 */
export async function settled(open: readonly string[], maxMs = 1500): Promise<void> {
  const end = Date.now() + maxMs;
  const busy = () =>
    open.some(
      (id) =>
        orders.value.has(id) ||
        moving.has(id) ||
        (!kinds.has(id) && Date.now() - (opened.get(id) ?? 0) < maxMs),
    );
  let moved = false;
  while (busy() && Date.now() < end) {
    moved = true;
    await frame();
  }
  // The viewer's last word comes in an effect after its render: a few frames more.
  if (moved) for (let i = 0; i < 3 && Date.now() < end; i++) await frame();
}
