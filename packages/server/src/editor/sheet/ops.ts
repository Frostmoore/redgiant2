// What a sheet operation touches and says (G37.3), read from Univer's mutations: the places for
// the host's conflict check (the same cell is a conflict), the rebasing over rows and columns that
// went in or out, and the words of the panel «Modifiche» («changed 3 cells in B2:B4»). Pure.
import type { DocOp, DocSummary, SheetArea, SheetDocOp, SheetMutation } from "@redgiant/protocol";
import { areaName, MAX_COLS, MAX_ROWS } from "./a1.js";
import type { CellData, SheetModel } from "./model.js";

export type Sheet = SheetDocOp;
export const asSheet = (op: DocOp): Sheet => {
  if (op.family !== "sheet") throw new Error("Not a sheet operation");
  return op;
};

interface Range {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}
type P = Record<string, unknown>;
const isRange = (r: unknown): r is Range =>
  !!r &&
  typeof r === "object" &&
  typeof (r as Range).startRow === "number" &&
  typeof (r as Range).endRow === "number";
const params = (m: SheetMutation): P =>
  m.params && typeof m.params === "object" ? (m.params as P) : {};
const subOf = (m: SheetMutation): string | undefined => {
  const p = params(m);
  return typeof p.subUnitId === "string" ? p.subUnitId : undefined;
};

/** The ids of mutations a sheet operation may carry, and what each does to the file. */
export const MUTATIONS = {
  values: "sheet.mutation.set-range-values",
  insertRow: "sheet.mutation.insert-row",
  removeRows: "sheet.mutation.remove-rows",
  insertCol: "sheet.mutation.insert-col",
  removeCols: "sheet.mutation.remove-col",
  moveRows: "sheet.mutation.move-rows",
  moveCols: "sheet.mutation.move-columns",
  moveRange: "sheet.mutation.move-range",
  reorder: "sheet.mutation.reorder-range",
  merge: "sheet.mutation.add-worksheet-merge",
  unmerge: "sheet.mutation.remove-worksheet-merge",
  insertSheet: "sheet.mutation.insert-sheet",
  removeSheet: "sheet.mutation.remove-sheet",
  renameSheet: "sheet.mutation.set-worksheet-name",
  orderSheet: "sheet.mutation.set-worksheet-order",
  hideSheet: "sheet.mutation.set-worksheet-hidden",
  colWidth: "sheet.mutation.set-worksheet-col-width",
  rowHeight: "sheet.mutation.set-worksheet-row-height",
  rowAuto: "sheet.mutation.set-worksheet-row-is-auto-height",
  rowAutoH: "sheet.mutation.set-worksheet-row-auto-height",
  colHidden: "sheet.mutation.set-col-hidden",
  colVisible: "sheet.mutation.set-col-visible",
  rowHidden: "sheet.mutation.set-row-hidden",
  rowVisible: "sheet.mutation.set-row-visible",
  numfmt: "sheet.mutation.set.numfmt",
  removeNumfmt: "sheet.mutation.remove.numfmt",
  filterRange: "sheet.mutation.set-filter-range",
  filterCriteria: "sheet.mutation.set-filter-criteria",
  removeFilter: "sheet.mutation.remove-filter",
  reFilter: "sheet.mutation.re-calc-filter",
  frozen: "sheet.mutation.set-frozen",
  gridlines: "sheet.mutation.toggle-gridlines",
  tabColor: "sheet.mutation.set-tab-color",
} as const;

/** Mutations a CSV keeps (values, rows and columns) or lets by in the editor only (widths, filters). */
const CSV_OK = new Set<string>([
  MUTATIONS.values,
  MUTATIONS.insertRow,
  MUTATIONS.removeRows,
  MUTATIONS.insertCol,
  MUTATIONS.removeCols,
  MUTATIONS.moveRows,
  MUTATIONS.moveCols,
  MUTATIONS.moveRange,
  MUTATIONS.reorder,
  MUTATIONS.colWidth,
  MUTATIONS.rowHeight,
  MUTATIONS.rowAuto,
  MUTATIONS.rowAutoH,
  MUTATIONS.filterRange,
  MUTATIONS.filterCriteria,
  MUTATIONS.removeFilter,
  MUTATIONS.reFilter,
  MUTATIONS.frozen,
  MUTATIONS.colHidden,
  MUTATIONS.colVisible,
  MUTATIONS.rowHidden,
  MUTATIONS.rowVisible,
  MUTATIONS.numfmt,
  MUTATIONS.removeNumfmt,
]);
const ODS_OK = new Set<string>([...Object.values(MUTATIONS)]);

/** Why a mutation is not one this file can keep (undefined: it can). */
export function refusedMutation(kind: SheetModel["kind"], m: SheetMutation): string | undefined {
  const ok = kind === "ods" ? ODS_OK : CSV_OK;
  if (ok.has(m.id)) return undefined;
  if (kind !== "ods" && ODS_OK.has(m.id))
    return `a ${kind.toUpperCase()} file keeps only one sheet of values: ${m.id.replace("sheet.mutation.", "")} cannot be kept (save a copy as ODS for that)`;
  return `${m.id} is not an edit the editor saves`;
}

// ---- places ------------------------------------------------------------------------------

const box = (sheet: string, r: Range, shift?: SheetArea["shift"]): SheetArea => ({
  sheet,
  r0: Math.max(0, r.startRow),
  c0: Math.max(0, r.startColumn ?? 0),
  r1: Math.max(0, r.endRow),
  c1: Math.max(0, r.endColumn ?? MAX_COLS - 1),
  ...(shift && { shift }),
});

/** The bounding box of a matrix of cells ({row: {col: cell}}). */
export function matrixBox(m: unknown): Range | undefined {
  if (!m || typeof m !== "object") return undefined;
  let r0 = Number.POSITIVE_INFINITY;
  let r1 = -1;
  let c0 = Number.POSITIVE_INFINITY;
  let c1 = -1;
  for (const [rk, row] of Object.entries(m as Record<string, unknown>)) {
    if (!row || typeof row !== "object") continue;
    const r = Number(rk);
    for (const ck of Object.keys(row as object)) {
      const c = Number(ck);
      if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
    }
  }
  return r1 < 0 ? undefined : { startRow: r0, endRow: r1, startColumn: c0, endColumn: c1 };
}

/** The places one mutation touches. */
export function areasOf(m: SheetMutation): SheetArea[] {
  const p = params(m);
  const sub = subOf(m);
  switch (m.id) {
    case MUTATIONS.values: {
      const b = matrixBox(p.cellValue);
      return sub && b ? [box(sub, b)] : [];
    }
    case MUTATIONS.insertRow:
    case MUTATIONS.removeRows:
      return sub && isRange(p.range)
        ? [
            {
              sheet: sub,
              r0: p.range.startRow,
              c0: 0,
              r1: MAX_ROWS - 1,
              c1: MAX_COLS - 1,
              shift: "rows",
            },
          ]
        : [];
    case MUTATIONS.insertCol:
    case MUTATIONS.removeCols:
      return sub && isRange(p.range)
        ? [
            {
              sheet: sub,
              r0: 0,
              c0: p.range.startColumn,
              r1: MAX_ROWS - 1,
              c1: MAX_COLS - 1,
              shift: "cols",
            },
          ]
        : [];
    case MUTATIONS.moveRows: {
      const s = p.sourceRange as Range | undefined;
      const t = p.targetRange as Range | undefined;
      if (!sub || !isRange(s) || !isRange(t)) return [];
      return [
        {
          sheet: sub,
          r0: Math.min(s.startRow, t.startRow),
          c0: 0,
          r1: MAX_ROWS - 1,
          c1: MAX_COLS - 1,
          shift: "rows",
        },
      ];
    }
    case MUTATIONS.moveCols: {
      const s = p.sourceRange as Range | undefined;
      const t = p.targetRange as Range | undefined;
      if (!sub || !isRange(s) || !isRange(t)) return [];
      return [
        {
          sheet: sub,
          r0: 0,
          c0: Math.min(s.startColumn, t.startColumn),
          r1: MAX_ROWS - 1,
          c1: MAX_COLS - 1,
          shift: "cols",
        },
      ];
    }
    case MUTATIONS.moveRange: {
      const out: SheetArea[] = [];
      for (const k of ["from", "to"]) {
        const side = p[k] as { subUnitId?: string; value?: unknown } | undefined;
        const b = matrixBox(side?.value);
        const s = side?.subUnitId ?? sub;
        if (s && b) out.push(box(s, b));
      }
      return out;
    }
    case MUTATIONS.reorder:
    case MUTATIONS.filterRange:
      return sub && isRange(p.range) ? [box(sub, p.range)] : [];
    case MUTATIONS.merge:
    case MUTATIONS.unmerge: {
      const ranges = (p.ranges as unknown[]) ?? [];
      return sub ? ranges.filter(isRange).map((r) => box(sub, r)) : [];
    }
    case MUTATIONS.colWidth:
    case MUTATIONS.rowHeight:
    case MUTATIONS.rowAuto:
    case MUTATIONS.rowAutoH:
    case MUTATIONS.colHidden:
    case MUTATIONS.colVisible:
    case MUTATIONS.rowHidden:
    case MUTATIONS.rowVisible: {
      const ranges = ((p.ranges as unknown[]) ?? (p.range ? [p.range] : [])).filter(isRange);
      return sub ? ranges.map((r) => box(sub, r)) : [];
    }
    case MUTATIONS.numfmt:
    case MUTATIONS.removeNumfmt: {
      // {values: {patternId: {ranges}}} or {ranges}
      const out: SheetArea[] = [];
      const add = (r: unknown) => isRange(r) && sub && out.push(box(sub, r));
      ((p.ranges as unknown[]) ?? []).forEach(add);
      const v = p.values as Record<string, { ranges?: unknown[] }> | undefined;
      if (v && typeof v === "object")
        for (const x of Object.values(v)) (x?.ranges ?? []).forEach(add);
      return out;
    }
    case MUTATIONS.insertSheet: {
      const sheet = (p.sheet as { id?: string } | undefined)?.id;
      return sheet
        ? [{ sheet, r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1, shift: "sheet" }]
        : [];
    }
    case MUTATIONS.removeSheet:
    case MUTATIONS.renameSheet:
    case MUTATIONS.orderSheet:
    case MUTATIONS.hideSheet:
      return sub
        ? [{ sheet: sub, r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1, shift: "sheet" }]
        : [];
    default:
      return sub ? [{ sheet: sub, r0: 0, c0: 0, r1: 0, c1: 0 }] : [];
  }
}

export function targetsOf(op: Sheet): SheetArea[] {
  if (op.target?.length) return op.target;
  return op.op.redo.flatMap(areasOf);
}

const meets = (a: SheetArea, b: SheetArea) =>
  a.sheet === b.sheet && a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;

/** Two operations made on the same model touch the same place (the same cell is a conflict). */
export function sheetConflicts(a: Sheet, b: Sheet): boolean {
  const ta = targetsOf(a);
  const tb = targetsOf(b);
  for (const x of ta)
    for (const y of tb) {
      if (x.shift === "sheet" || y.shift === "sheet") {
        if (x.sheet === y.sheet) return true;
        continue;
      }
      if (meets(x, y)) return true;
    }
  return false;
}

// ---- moving an operation over rows and columns that went in or out ------------------------

interface Shift {
  sheet: string;
  axis: "rows" | "cols";
  at: number;
  /** Positive: inserted; negative: removed (the rows at..at+|n|-1 are gone). */
  n: number;
}

function shiftsOf(op: Sheet): Shift[] | undefined {
  const out: Shift[] = [];
  for (const m of op.op.redo) {
    const p = params(m);
    const sub = subOf(m);
    const r = p.range;
    if (m.id === MUTATIONS.insertRow && sub && isRange(r))
      out.push({ sheet: sub, axis: "rows", at: r.startRow, n: r.endRow - r.startRow + 1 });
    else if (m.id === MUTATIONS.removeRows && sub && isRange(r))
      out.push({ sheet: sub, axis: "rows", at: r.startRow, n: -(r.endRow - r.startRow + 1) });
    else if (m.id === MUTATIONS.insertCol && sub && isRange(r))
      out.push({ sheet: sub, axis: "cols", at: r.startColumn, n: r.endColumn - r.startColumn + 1 });
    else if (m.id === MUTATIONS.removeCols && sub && isRange(r))
      out.push({
        sheet: sub,
        axis: "cols",
        at: r.startColumn,
        n: -(r.endColumn - r.startColumn + 1),
      });
    else if (
      m.id === MUTATIONS.moveRows ||
      m.id === MUTATIONS.moveCols ||
      m.id === MUTATIONS.reorder ||
      m.id === MUTATIONS.moveRange
    )
      return undefined;
  }
  return out;
}

/** An index moved over a shift; undefined when it was removed. */
function moveIndex(i: number, s: Shift): number | undefined {
  if (s.n > 0) return i >= s.at ? i + s.n : i;
  const gone = -s.n;
  if (i < s.at) return i;
  if (i < s.at + gone) return undefined;
  return i - gone;
}

function moveRange(r: Range, s: Shift): Range | undefined {
  if (s.axis === "rows") {
    const a = moveIndex(r.startRow, s);
    const b = moveIndex(r.endRow, s);
    if (a === undefined || b === undefined) return undefined;
    return { ...r, startRow: a, endRow: b };
  }
  const a = moveIndex(r.startColumn, s);
  const b = moveIndex(r.endColumn, s);
  if (a === undefined || b === undefined) return undefined;
  return { ...r, startColumn: a, endColumn: b };
}

function moveMatrix(m: unknown, s: Shift): Record<string, Record<string, unknown>> | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [rk, row] of Object.entries((m ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const [ck, cell] of Object.entries(row ?? {})) {
      let r: number | undefined = Number(rk);
      let c: number | undefined = Number(ck);
      if (s.axis === "rows") r = moveIndex(r, s);
      else c = moveIndex(c, s);
      if (r === undefined || c === undefined) return undefined;
      const line = out[r] ?? {};
      line[c] = cell;
      out[r] = line;
    }
  }
  return out;
}

function moveMutation(
  m: SheetMutation,
  shifts: Shift[],
  gone: Set<string>,
): SheetMutation | undefined {
  const sub = subOf(m);
  if (sub && gone.has(sub)) return undefined;
  const mine = shifts.filter((s) => s.sheet === sub);
  if (!mine.length) return m;
  let p: P = { ...params(m) };
  for (const s of mine) {
    switch (m.id) {
      case MUTATIONS.values: {
        const cv = moveMatrix(p.cellValue, s);
        if (!cv) return undefined;
        p = { ...p, cellValue: cv };
        break;
      }
      case MUTATIONS.merge:
      case MUTATIONS.unmerge:
      case MUTATIONS.colWidth:
      case MUTATIONS.rowHeight:
      case MUTATIONS.rowHidden:
      case MUTATIONS.rowVisible:
      case MUTATIONS.colHidden:
      case MUTATIONS.colVisible: {
        const rs = ((p.ranges as unknown[]) ?? []).filter(isRange).map((r) => moveRange(r, s));
        if (rs.some((r) => !r)) return undefined;
        p = { ...p, ranges: rs };
        if (isRange(p.range)) {
          const r = moveRange(p.range, s);
          if (!r) return undefined;
          p.range = r;
        }
        break;
      }
      case MUTATIONS.insertRow:
      case MUTATIONS.removeRows:
      case MUTATIONS.insertCol:
      case MUTATIONS.removeCols: {
        if (!isRange(p.range)) return undefined;
        const axis =
          m.id === MUTATIONS.insertRow || m.id === MUTATIONS.removeRows ? "rows" : "cols";
        if (axis !== s.axis) break;
        const r = moveRange(p.range, s);
        if (!r) return undefined;
        p = { ...p, range: r };
        break;
      }
      default:
        return undefined;
    }
  }
  return { id: m.id, params: p };
}

/** `a`, made on the same model as `b`, moved to apply after it; undefined when it cannot be. */
export function sheetMap(a: Sheet, b: Sheet): Sheet | undefined {
  const shifts = shiftsOf(b);
  const touched = new Set(targetsOf(a).map((t) => t.sheet));
  const gone = new Set(
    b.op.redo.filter((m) => m.id === MUTATIONS.removeSheet).map((m) => subOf(m) ?? ""),
  );
  if (!shifts) {
    // Moves and sorts are not followed: only an operation on other sheets passes.
    const theirs = new Set(targetsOf(b).map((t) => t.sheet));
    return [...touched].some((s) => theirs.has(s)) ? undefined : a;
  }
  if (!shifts.length && !gone.size) return a;
  const redo: SheetMutation[] = [];
  const undo: SheetMutation[] = [];
  for (const m of a.op.redo) {
    const x = moveMutation(m, shifts, gone);
    if (!x) return undefined;
    redo.push(x);
  }
  for (const m of a.op.undo) {
    const x = moveMutation(m, shifts, gone);
    if (!x) return undefined;
    undo.push(x);
  }
  const { target: _t, ...rest } = a;
  return { ...rest, op: { redo, undo } };
}

export function sheetCompose(ops: readonly Sheet[]): Sheet | undefined {
  const first = ops[0];
  if (!first) return undefined;
  if (ops.length === 1) return first;
  return {
    family: "sheet",
    engine: "univer",
    engineVersion: first.engineVersion,
    op: {
      redo: ops.flatMap((o) => o.op.redo),
      undo: [...ops].reverse().flatMap((o) => o.op.undo),
    },
    target: ops.flatMap(targetsOf).slice(0, 2000),
  };
}

export const sheetInvert = (op: Sheet): Sheet => ({
  ...op,
  op: { redo: op.op.undo, undo: op.op.redo },
  ...(op.target && { target: op.target }),
});

// ---- presence: a cell as one number ------------------------------------------------------

/** A sheet's id as a small number (the same on the page: viewers/sheet-collab.ts). */
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
  sheetKey(sheet) * SHEET + Math.min(r, MAX_ROWS - 1) * ROW + Math.min(c, MAX_COLS - 1);
export const posCell = (pos: number) => ({
  key: Math.floor(pos / SHEET),
  r: Math.floor((pos % SHEET) / ROW),
  c: pos % ROW,
});

export function touchesPos(op: Sheet, from: number, to: number): boolean {
  const a = posCell(from);
  const b = posCell(to);
  for (const t of targetsOf(op)) {
    if (sheetKey(t.sheet) !== a.key) continue;
    if (t.shift === "sheet") return true;
    const r0 = Math.min(a.r, b.r);
    const r1 = Math.max(a.r, b.r);
    const c0 = Math.min(a.c, b.c);
    const c1 = Math.max(a.c, b.c);
    if (t.r0 <= r1 && r0 <= t.r1 && t.c0 <= c1 && c0 <= t.c1) return true;
  }
  return false;
}

export function wroteOf(ops: readonly Sheet[]): [number, number][] {
  const out: [number, number][] = [];
  for (const op of ops)
    for (const t of targetsOf(op)) {
      if (t.shift) continue;
      out.push([cellPos(t.sheet, t.r0, t.c0), cellPos(t.sheet, t.r1, t.c1)]);
      if (out.length >= 1000) return out;
    }
  return out;
}

// ---- words -------------------------------------------------------------------------------

const sameValue = (a: CellData | undefined, b: CellData | undefined) =>
  (a?.v ?? null) === (b?.v ?? null) && (a?.f ?? null) === (b?.f ?? null);

/** What a batch does, in English for the agent and the log, and in parts for the page. */
export function sheetSummary(
  model: SheetModel,
  ops: readonly Sheet[],
  kind?: DocSummary["kind"],
): DocSummary {
  const all = ops.flatMap((o) => o.op.redo);
  const nameOf = (id: string | undefined) =>
    (id && model.wb.sheets[id]?.name) ||
    (id &&
      (
        all.find(
          (m) => m.id === MUTATIONS.insertSheet && (params(m).sheet as { id?: string })?.id === id,
        )?.params as { sheet?: { name?: string } } | undefined
      )?.sheet?.name) ||
    undefined;
  const count = ops.length > 1 ? { count: ops.length } : {};
  const done = (
    action: NonNullable<DocSummary["sheet"]>["action"],
    text: string,
    extra: { name?: string | undefined; range?: string; n?: number; at?: number } = {},
    k: DocSummary["kind"] = "edit",
  ): DocSummary => {
    const sheet = {
      action,
      ...(extra.name &&
        (model.wb.sheetOrder.length > 1 || action.endsWith("_sheet")) && { name: extra.name }),
      ...(extra.range && { range: extra.range }),
      ...(extra.n !== undefined && { n: extra.n }),
      ...(extra.at !== undefined && { at: extra.at }),
    };
    const where = extra.name && model.wb.sheetOrder.length > 1 ? ` (${extra.name})` : "";
    return { text: `${text}${where}`.slice(0, 500), kind: kind ?? k, sheet, ...count };
  };
  const find = (id: string) => all.find((m) => m.id === id);
  const rowsOf = (m: SheetMutation) => {
    const r = params(m).range as Range;
    return { n: r.endRow - r.startRow + 1, at: r.startRow + 1 };
  };
  const colsOf = (m: SheetMutation) => {
    const r = params(m).range as Range;
    return { n: r.endColumn - r.startColumn + 1, at: r.startColumn + 1 };
  };
  let m: SheetMutation | undefined;
  m = find(MUTATIONS.insertSheet);
  if (m) {
    const name = (params(m).sheet as { name?: string })?.name;
    return done("add_sheet", `added the sheet «${name ?? "?"}»`, { name }, "insert");
  }
  m = find(MUTATIONS.removeSheet);
  if (m) {
    const name = nameOf(subOf(m));
    return done("delete_sheet", `deleted the sheet «${name ?? "?"}»`, { name }, "delete");
  }
  m = find(MUTATIONS.renameSheet);
  if (m) {
    const name = params(m).name as string;
    return done("rename_sheet", `renamed the sheet «${nameOf(subOf(m)) ?? "?"}» to «${name}»`, {
      name,
    });
  }
  m = find(MUTATIONS.orderSheet);
  if (m) return done("order_sheet", "moved a sheet", { name: nameOf(subOf(m)) });
  m = find(MUTATIONS.insertRow);
  if (m) {
    const { n, at } = rowsOf(m);
    return done(
      "insert_rows",
      `inserted ${n} row${n > 1 ? "s" : ""} at row ${at}`,
      { name: nameOf(subOf(m)), n, at },
      "insert",
    );
  }
  m = find(MUTATIONS.removeRows);
  if (m) {
    const { n, at } = rowsOf(m);
    return done(
      "delete_rows",
      `deleted ${n} row${n > 1 ? "s" : ""} from row ${at}`,
      { name: nameOf(subOf(m)), n, at },
      "delete",
    );
  }
  m = find(MUTATIONS.insertCol);
  if (m) {
    const { n, at } = colsOf(m);
    return done(
      "insert_cols",
      `inserted ${n} column${n > 1 ? "s" : ""} at column ${at}`,
      { name: nameOf(subOf(m)), n, at },
      "insert",
    );
  }
  m = find(MUTATIONS.removeCols);
  if (m) {
    const { n, at } = colsOf(m);
    return done(
      "delete_cols",
      `deleted ${n} column${n > 1 ? "s" : ""} from column ${at}`,
      { name: nameOf(subOf(m)), n, at },
      "delete",
    );
  }
  m = find(MUTATIONS.moveRows) ?? find(MUTATIONS.moveCols) ?? find(MUTATIONS.moveRange);
  if (m) return done("move", "moved cells", { name: nameOf(subOf(m)) });
  m = find(MUTATIONS.reorder);
  if (m) {
    const range = areaName(box("", params(m).range as Range));
    return done("sort", `sorted ${range}`, { name: nameOf(subOf(m)), range });
  }
  if (
    (m =
      find(MUTATIONS.filterRange) ?? find(MUTATIONS.filterCriteria) ?? find(MUTATIONS.removeFilter))
  )
    return done(
      "filter",
      m.id === MUTATIONS.removeFilter ? "removed the filter" : "changed the filter",
      { name: nameOf(subOf(m)) },
    );
  m = find(MUTATIONS.merge);
  if (m) {
    const r = (params(m).ranges as Range[])?.[0];
    const range = r ? areaName(box("", r)) : undefined;
    return done("merge", `merged ${range ?? "cells"}`, {
      name: nameOf(subOf(m)),
      ...(range && { range }),
    });
  }
  m = find(MUTATIONS.unmerge);
  if (m) {
    const r = (params(m).ranges as Range[])?.[0];
    const range = r ? areaName(box("", r)) : undefined;
    return done("unmerge", `unmerged ${range ?? "cells"}`, {
      name: nameOf(subOf(m)),
      ...(range && { range }),
    });
  }
  // Cell values and formats.
  const values = all.filter((x) => x.id === MUTATIONS.values);
  const fmts = all.filter((x) => x.id === MUTATIONS.numfmt || x.id === MUTATIONS.removeNumfmt);
  if (values.length || fmts.length) {
    let cells = 0;
    let changed = 0;
    let cleared = 0;
    let r0 = Number.POSITIVE_INFINITY;
    let c0 = Number.POSITIVE_INFINITY;
    let r1 = -1;
    let c1 = -1;
    let sheet: string | undefined;
    for (const v of values) {
      sheet ??= subOf(v);
      const s = sheet ? model.wb.sheets[sheet] : undefined;
      for (const [rk, row] of Object.entries(
        (params(v).cellValue ?? {}) as Record<string, Record<string, CellData | null>>,
      ))
        for (const [ck, cell] of Object.entries(row ?? {})) {
          const r = Number(rk);
          const c = Number(ck);
          cells++;
          const before = s?.cellData[r]?.[c];
          const hasValue = cell && ("v" in cell || "f" in cell || "si" in cell);
          if (hasValue && !sameValue(before, cell ?? undefined)) {
            changed++;
            if ((cell?.v === null || cell?.v === undefined || cell?.v === "") && !cell?.f)
              cleared++;
          }
          r0 = Math.min(r0, r);
          r1 = Math.max(r1, r);
          c0 = Math.min(c0, c);
          c1 = Math.max(c1, c);
        }
    }
    for (const f of fmts) {
      sheet ??= subOf(f);
      for (const a of areasOf(f)) {
        r0 = Math.min(r0, a.r0);
        r1 = Math.max(r1, a.r1);
        c0 = Math.min(c0, a.c0);
        c1 = Math.max(c1, a.c1);
        cells += (a.r1 - a.r0 + 1) * (a.c1 - a.c0 + 1);
      }
    }
    const range = r1 >= 0 ? areaName({ r0, c0, r1, c1 }) : undefined;
    const name = nameOf(sheet);
    if (changed === 0)
      return done(
        "format",
        `formatted ${cells} cell${cells === 1 ? "" : "s"}${range ? ` in ${range}` : ""}`,
        { name, n: cells, ...(range && { range }) },
      );
    if (cleared === changed)
      return done(
        "clear",
        `cleared ${changed} cell${changed === 1 ? "" : "s"}${range ? ` in ${range}` : ""}`,
        { name, n: changed, ...(range && { range }) },
        "delete",
      );
    return done(
      "cells",
      `changed ${changed} cell${changed === 1 ? "" : "s"}${range ? ` in ${range}` : ""}`,
      { name, n: changed, ...(range && { range }) },
      "replace",
    );
  }
  if (
    all.some(
      (x) =>
        x.id === MUTATIONS.colWidth || x.id === MUTATIONS.rowHeight || x.id === MUTATIONS.rowAuto,
    )
  )
    return done("size", "changed row or column sizes", {
      name: nameOf(subOf(all[0] as SheetMutation)),
    });
  return done("other", "changed the sheet", { name: nameOf(all[0] ? subOf(all[0]) : undefined) });
}
