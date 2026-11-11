// Heavy tabs kept alive (3.5.11). Every tab of the area stayed drawn while hidden: ten files open
// were ten editors in memory (Univer, pdf.js, a WebGL context each…). Now the tab in view and the
// ones seen most recently stay loaded; the others are let go and loaded again when the person
// comes back, where they were (the page, line, time, zoom or sheet their viewer last said).
// Terminals, the shared screen, sites and agents' apps are never let go: they would lose what runs.
import type { CanvasDo, CanvasPlace } from "@redgiant/protocol";
import { canvasKind } from "./canvas-kind.js";

/** Canvas tabs kept loaded, the one in view included. */
export const WARM_TABS = 3;

export type WarmView =
  | { id: string; type: "canvas"; target: Parameters<typeof canvasKind>[0] }
  | { id: string; type: "terminal" | "screen" };

/** Whether a tab may be let go when it is out of view (an editor or a viewer of a file). */
export function mayUnload(v: WarmView): boolean {
  if (v.type !== "canvas") return false;
  const kind = canvasKind(v.target);
  return kind !== "site" && kind !== "artifact";
}

/**
 * The tabs to keep loaded: every tab that may not be let go, the one in view, and the most
 * recently seen of the others (`recent`, most recent first) up to `max` canvas tabs in all.
 * Tabs never seen (opened behind another) come last.
 */
export function warmTabs(
  views: readonly WarmView[],
  recent: readonly string[],
  active: string | null,
  max = WARM_TABS,
): Set<string> {
  const keep = new Set<string>();
  const heavy: string[] = [];
  for (const v of views)
    if (mayUnload(v)) heavy.push(v.id);
    else keep.add(v.id);
  const rank = (id: string) => {
    if (id === active) return -1;
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const ordered = [...heavy].sort((a, b) => rank(a) - rank(b));
  for (const id of ordered.slice(0, Math.max(1, max))) keep.add(id);
  return keep;
}

/** The tab seen now goes first in the list of the most recent (at most `limit` kept). */
export function touch(recent: readonly string[], id: string, limit = 50): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, limit);
}

/** Where the person was, as a move for the viewer loaded again (nothing a move cannot say). */
export function placeDo(place: CanvasPlace | undefined): CanvasDo | undefined {
  if (!place) return undefined;
  const d: CanvasDo = {};
  if (place.page) d.page = place.page;
  // A text keeps its own selection and scroll (TextEditor): a line here would select it.
  if (place.time !== undefined && place.time > 0) d.time = place.time;
  if (place.zoom && place.zoom >= 5 && place.zoom <= 800) d.zoom = place.zoom;
  if (place.sheet) d.sheet = place.sheet;
  if (place.cells) d.cells = place.cells;
  return Object.keys(d).length ? d : undefined;
}
