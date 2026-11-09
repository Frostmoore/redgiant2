// The page's side of the sheet editor (G37.3): the person's commands go to the server as Univer
// mutations with their undo, one batch in flight at a time, on the revision they were made on.
// Others' revisions are applied as collaboration when they do not meet what the person has not
// seen confirmed yet; when they do (the same cells, rows going in or out, sheets), the page loads
// the file again from the host, which has the truth. Pure: no Univer, no socket, tested alone.
import type { DocOp, SheetArea, SheetMutation } from "@redgiant/protocol";

/** The unit's id on the page and on the server (packages/server/src/editor/sheet/model.ts). */
export const SHEET_UNIT = "rg-sheet";
export const UNIVER_VERSION = "1.4.0";

export interface SheetOutgoing {
  clientId: string;
  baseRevision: number;
  ops: DocOp[];
}

/** Mutations that move rows, columns or sheets: others' edits cannot be laid over them here. */
const STRUCTURE = new Set([
  "sheet.mutation.insert-row",
  "sheet.mutation.remove-rows",
  "sheet.mutation.insert-col",
  "sheet.mutation.remove-col",
  "sheet.mutation.move-rows",
  "sheet.mutation.move-columns",
  "sheet.mutation.move-range",
  "sheet.mutation.reorder-range",
  "sheet.mutation.insert-sheet",
  "sheet.mutation.remove-sheet",
  "sheet.mutation.add-worksheet-merge",
  "sheet.mutation.remove-worksheet-merge",
]);

type Box = { sheet: string; r0: number; c0: number; r1: number; c1: number };

/** The cells a mutation writes, as boxes; undefined when it moves things. */
function boxesOf(m: SheetMutation): Box[] | undefined {
  if (STRUCTURE.has(m.id)) return undefined;
  const p = (m.params ?? {}) as {
    subUnitId?: string;
    cellValue?: Record<string, Record<string, unknown>>;
  };
  if (!p.subUnitId || !p.cellValue) return [];
  let r0 = Number.POSITIVE_INFINITY;
  let c0 = Number.POSITIVE_INFINITY;
  let r1 = -1;
  let c1 = -1;
  for (const [rk, row] of Object.entries(p.cellValue))
    for (const ck of Object.keys(row ?? {})) {
      r0 = Math.min(r0, Number(rk));
      r1 = Math.max(r1, Number(rk));
      c0 = Math.min(c0, Number(ck));
      c1 = Math.max(c1, Number(ck));
    }
  return r1 < 0 ? [] : [{ sheet: p.subUnitId, r0, c0, r1, c1 }];
}

/** Whether two lists of mutations can be applied in either order (different cells, no moves). */
export function independent(a: readonly SheetMutation[], b: readonly SheetMutation[]): boolean {
  const ba: Box[] = [];
  for (const m of a) {
    const x = boxesOf(m);
    if (!x) return false;
    ba.push(...x);
  }
  for (const m of b) {
    const y = boxesOf(m);
    if (!y) return false;
    for (const q of y)
      for (const p of ba)
        if (p.sheet === q.sheet && p.r0 <= q.r1 && q.r0 <= p.r1 && p.c0 <= q.c1 && q.c0 <= p.c1)
          return false;
  }
  return true;
}

export const sheetOp = (redo: SheetMutation[], undo: SheetMutation[]): DocOp => ({
  family: "sheet",
  engine: "univer",
  engineVersion: UNIVER_VERSION,
  op: { redo, undo },
});

const mutationsOf = (ops: readonly DocOp[]) =>
  ops.flatMap((o) => (o.family === "sheet" ? o.op.redo : []));

let counter = 0;
const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

export class SheetCollab {
  revision = 0;
  private inflight: { id: string; ops: DocOp[] } | undefined;
  private buffer: DocOp[] = [];

  constructor(private readonly send: (o: SheetOutgoing) => void) {}

  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = [];
  }

  get pending(): boolean {
    return !!this.inflight || this.buffer.length > 0;
  }

  /** One of the person's commands, applied on the page already. */
  local(op: { redo: SheetMutation[]; undo: SheetMutation[] }): void {
    if (!op.redo.length) return;
    this.buffer.push(sheetOp(op.redo, op.undo));
  }

  flush(): void {
    if (this.inflight || !this.buffer.length) return;
    this.inflight = { id: newId(), ops: this.buffer };
    this.buffer = [];
    this.send({ clientId: this.inflight.id, baseRevision: this.revision, ops: this.inflight.ops });
  }

  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
    return true;
  }

  /**
   * Someone else's revision: "apply" (its mutations go on the page as they are), or "resync"
   * (not the next revision, or it meets what the person has not seen confirmed).
   */
  remote(revision: number, ops: readonly DocOp[]): "apply" | "resync" {
    if (revision !== this.revision + 1) return "resync";
    const mine = [...(this.inflight?.ops ?? []), ...this.buffer];
    if (mine.length && !independent(mutationsOf(mine), mutationsOf(ops))) return "resync";
    this.revision = revision;
    return "apply";
  }

  rejected(clientId: string): boolean {
    return this.inflight?.id === clientId;
  }
}

// ---- a cell as one number (the same as the server's, sheet/ops.ts) --------------------------

export function sheetKey(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 131_072;
}
const ROW = 2 ** 14;
const SHEET = 2 ** 34;
export const cellPos = (sheet: string, r: number, c: number) =>
  sheetKey(sheet) * SHEET + Math.min(r, 1_048_575) * ROW + Math.min(c, 16_383);
export const posCell = (pos: number) => ({
  key: Math.floor(pos / SHEET),
  r: Math.floor((pos % SHEET) / ROW),
  c: pos % ROW,
});

/** The areas a change wrote (DocChange.wrote) on the sheets of this workbook. */
export function wroteAreas(
  wrote: readonly [number, number][],
  sheets: readonly string[],
): SheetArea[] {
  const byKey = new Map(sheets.map((s) => [sheetKey(s), s]));
  const out: SheetArea[] = [];
  for (const [a, b] of wrote) {
    const x = posCell(a);
    const y = posCell(b);
    const sheet = byKey.get(x.key);
    if (!sheet) continue;
    out.push({ sheet, r0: x.r, c0: x.c, r1: y.r, c1: y.c });
  }
  return out;
}

/** A column's letters (1-based number in). */
export function columnLetters(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}
