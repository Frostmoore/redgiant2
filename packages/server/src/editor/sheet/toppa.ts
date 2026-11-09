// The «toppa» (G37.3): an ODS is never written again from the editor's model. Saving replays the
// changes made since the last save on a headless Univer, turns each mutation into a small patch
// operation (cells, rows, columns, merges, sheets, sizes, filter buttons) and LibreOffice applies
// them to the file through UNO and stores it in place, the same format. Whatever the editor does
// not show (charts, pivot tables, drawings, conditional formats, print ranges, macros) is never
// rewritten: LibreOffice keeps it, and moves its ranges with inserted rows by itself (G37.0 prova
// 2). Only ODS: an XLSX of other programs written back by LibreOffice would lose Excel's table
// styles, so an XLSX is edited on its ODS copy (decision of 2026-11-07). Macros never run.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocOp, SheetMutation } from "@redgiant/protocol";
import { LO_QUIET, profileArg } from "../../lo-profiles.js";
import { excelToCalc } from "./a1.js";
import { SheetEngine } from "./engine.js";
import type { CellData, SheetModel, Style } from "./model.js";
import { SHEET_IDS_PROPERTY } from "./ods.js";
import { asSheet, MUTATIONS, matrixBox } from "./ops.js";

/** A cell to write: its content (when it changed) and the style keys that changed. */
export interface PatchCell {
  r: number;
  c: number;
  /** Content: absent when only the style changed. */
  set?: { v?: string | number | boolean | null; f?: string };
  style?: Record<string, unknown>;
}

export type PatchOp =
  | { op: "cells"; sheet: string; cells: PatchCell[] }
  | { op: "insert_rows" | "remove_rows"; sheet: string; at: number; count: number }
  | { op: "insert_cols" | "remove_cols"; sheet: string; at: number; count: number }
  | { op: "merge" | "unmerge"; sheet: string; r0: number; c0: number; r1: number; c1: number }
  | { op: "add_sheet"; name: string; at: number }
  | { op: "remove_sheet"; name: string }
  | { op: "rename_sheet"; from: string; to: string }
  | { op: "move_sheet"; name: string; to: number }
  | { op: "sheet_visible"; name: string; visible: boolean }
  | { op: "col_width"; sheet: string; c0: number; c1: number; px: number }
  | { op: "row_height"; sheet: string; r0: number; r1: number; px: number }
  | { op: "row_auto"; sheet: string; r0: number; r1: number }
  | { op: "cols_visible"; sheet: string; c0: number; c1: number; visible: boolean }
  | { op: "rows_visible"; sheet: string; r0: number; r1: number; visible: boolean }
  | {
      op: "autofilter";
      sheet: string;
      r0?: number;
      c0?: number;
      r1?: number;
      c1?: number;
      off?: boolean;
    };

/** What a patch keeps out (said to the person: the editor keeps it, the file does not). */
export interface Patch {
  ops: PatchOp[];
  /** The sheets' ids by name after the changes (kept in the file). */
  ids: Record<string, string>;
  skipped: string[];
}

type P = Record<string, unknown>;
type Range = { startRow: number; endRow: number; startColumn: number; endColumn: number };
const isRange = (r: unknown): r is Range => !!r && typeof (r as Range).startRow === "number";
const params = (m: SheetMutation): P =>
  m.params && typeof m.params === "object" ? (m.params as P) : {};
const sub = (m: SheetMutation) => {
  const p = params(m);
  return typeof p.subUnitId === "string" ? p.subUnitId : "";
};

/** The style keys LibreOffice is told about. */
const STYLE_KEYS = ["bl", "it", "ul", "st", "cl", "bg", "ff", "fs", "ht", "vt", "tb", "n"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The style keys that differ (null: back to the default). */
export function styleDiff(
  before: Style | undefined,
  after: Style | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) {
    const a = before?.[k];
    const b = after?.[k];
    if (!same(a, b)) out[k] = b ?? null;
  }
  return Object.keys(out).length ? out : undefined;
}

const contentOf = (c: CellData) => ({ v: c.v ?? null, f: c.f ?? null });

/** A cell's change between two moments, as LibreOffice will write it. */
function cellPatch(
  r: number,
  c: number,
  before: CellData & { s?: Style },
  after: CellData & { s?: Style },
  force = false,
): PatchCell | undefined {
  const out: PatchCell = { r, c };
  if (force || !same(contentOf(before), contentOf(after))) {
    out.set = after.f ? { f: excelToCalc(after.f) } : { v: after.v ?? null };
  }
  const st = styleDiff(before.s, after.s);
  if (st) out.style = st;
  return out.set || out.style ? out : undefined;
}

const MAX_AREA = 200_000;

/**
 * The patch for the changes `ops` made on `before` (the model at the last save). Replayed on a
 * headless engine, mutation by mutation, each read before and after it.
 */
export function buildPatch(before: SheetModel, ops: readonly DocOp[]): Patch {
  const e = new SheetEngine(before.wb);
  const out: PatchOp[] = [];
  const skipped = new Set<string>();
  const nameOf = (id: string) => e.sheetInfo(id)?.name ?? "";
  try {
    for (const op of ops) {
      // Formulas Univer moved after rows or columns went in or out: LibreOffice moves them itself.
      let moved = false;
      for (const m of asSheet(op).op.redo) {
        const s = sub(m);
        const p = params(m);
        // Cells read before and after a mutation, written where they changed.
        const around = (areas: Range[], sheet = s, run = true) => {
          const pre = new Map<string, CellData & { s?: Style }>();
          let n = 0;
          for (const a of areas)
            for (let r = a.startRow; r <= a.endRow; r++)
              for (let c = a.startColumn; c <= a.endColumn; c++) {
                if (++n > MAX_AREA) throw new Error("Too many cells changed at once to save");
                pre.set(`${r},${c}`, e.cellAt(sheet, r, c));
              }
          if (run) runOne(e, m);
          const cells: PatchCell[] = [];
          for (const [k, b] of pre) {
            const [r, c] = k.split(",").map(Number) as [number, number];
            const x = cellPatch(r, c, b, e.cellAt(sheet, r, c));
            if (x) cells.push(x);
          }
          if (cells.length) out.push({ op: "cells", sheet: nameOf(sheet), cells });
        };
        switch (m.id) {
          case MUTATIONS.values: {
            // Only the cells the mutation names (a whole column cleared stays small).
            const cells: [number, number][] = [];
            for (const [rk, row] of Object.entries(
              (p.cellValue ?? {}) as Record<string, Record<string, unknown>>,
            ))
              for (const ck of Object.keys(row ?? {})) cells.push([Number(rk), Number(ck)]);
            const pre = cells.map(([r, c]) => e.cellAt(s, r, c));
            runOne(e, m);
            const list: PatchCell[] = [];
            cells.forEach(([r, c], i) => {
              const before = pre[i] ?? {};
              const after = e.cellAt(s, r, c);
              const x = cellPatch(r, c, before, after);
              if (x && moved && before.f && after.f) delete x.set;
              if (x && (x.set || x.style)) list.push(x);
            });
            if (list.length) out.push({ op: "cells", sheet: nameOf(s), cells: list });
            break;
          }
          case MUTATIONS.numfmt:
          case MUTATIONS.removeNumfmt: {
            const ranges: Range[] = [];
            for (const r of (p.ranges as unknown[]) ?? []) if (isRange(r)) ranges.push(r);
            const v = p.values as Record<string, { ranges?: unknown[] }> | undefined;
            if (v)
              for (const x of Object.values(v))
                for (const r of x?.ranges ?? []) if (isRange(r)) ranges.push(r);
            around(ranges);
            break;
          }
          case MUTATIONS.insertRow:
          case MUTATIONS.removeRows:
          case MUTATIONS.insertCol:
          case MUTATIONS.removeCols: {
            const r = p.range as Range;
            const rows = m.id === MUTATIONS.insertRow || m.id === MUTATIONS.removeRows;
            const name = nameOf(s);
            runOne(e, m);
            moved = true;
            out.push({
              op: (m.id === MUTATIONS.insertRow
                ? "insert_rows"
                : m.id === MUTATIONS.removeRows
                  ? "remove_rows"
                  : m.id === MUTATIONS.insertCol
                    ? "insert_cols"
                    : "remove_cols") as "insert_rows",
              sheet: name,
              at: rows ? r.startRow : r.startColumn,
              count: rows ? r.endRow - r.startRow + 1 : r.endColumn - r.startColumn + 1,
            });
            // Cells the insert filled (Univer copies the style of the row above).
            if (m.id === MUTATIONS.insertRow || m.id === MUTATIONS.insertCol) {
              const box = matrixBox(p.cellValue);
              if (box) around([box], s, false);
            }
            break;
          }
          case MUTATIONS.moveRows:
          case MUTATIONS.moveCols:
          case MUTATIONS.reorder:
          case MUTATIONS.moveRange: {
            // Cells moved: written again where they are now (their content and style).
            const areas: Range[] = [];
            if (m.id === MUTATIONS.reorder && isRange(p.range)) areas.push(p.range);
            else if (m.id === MUTATIONS.moveRange) {
              for (const k of ["from", "to"]) {
                const b = matrixBox((p[k] as { value?: unknown } | undefined)?.value);
                if (b) areas.push(b);
              }
            } else {
              const a = p.sourceRange as Range;
              const b = p.targetRange as Range;
              if (isRange(a) && isRange(b)) {
                const ws = e.sheetData(s);
                const lastCol = Math.min(ws?.columnCount ?? 26, 1024) - 1;
                const lastRow = Math.min(ws?.rowCount ?? 1000, 100_000) - 1;
                areas.push(
                  m.id === MUTATIONS.moveRows
                    ? {
                        startRow: Math.min(a.startRow, b.startRow),
                        endRow: Math.max(a.endRow, b.endRow, b.startRow + (a.endRow - a.startRow)),
                        startColumn: 0,
                        endColumn: lastCol,
                      }
                    : {
                        startRow: 0,
                        endRow: lastRow,
                        startColumn: Math.min(a.startColumn, b.startColumn),
                        endColumn: Math.max(
                          a.endColumn,
                          b.endColumn,
                          b.startColumn + (a.endColumn - a.startColumn),
                        ),
                      },
                );
              }
            }
            around(areas);
            break;
          }
          case MUTATIONS.merge:
          case MUTATIONS.unmerge: {
            const name = nameOf(s);
            runOne(e, m);
            for (const r of ((p.ranges as unknown[]) ?? []).filter(isRange))
              out.push({
                op: m.id === MUTATIONS.merge ? "merge" : "unmerge",
                sheet: name,
                r0: r.startRow,
                c0: r.startColumn,
                r1: r.endRow,
                c1: r.endColumn,
              });
            break;
          }
          case MUTATIONS.insertSheet: {
            runOne(e, m);
            const id = (p.sheet as { id?: string } | undefined)?.id ?? "";
            const info = e.sheetInfo(id);
            if (!info) break;
            out.push({ op: "add_sheet", name: info.name, at: Math.max(0, info.index) });
            const data = e.sheetData(id);
            const cells: PatchCell[] = [];
            for (const [rk, row] of Object.entries(data?.cellData ?? {}))
              for (const ck of Object.keys(row ?? {})) {
                const x = cellPatch(
                  Number(rk),
                  Number(ck),
                  {},
                  e.cellAt(id, Number(rk), Number(ck)),
                );
                if (x) cells.push(x);
              }
            if (cells.length) out.push({ op: "cells", sheet: info.name, cells });
            for (const mg of data?.mergeData ?? [])
              out.push({
                op: "merge",
                sheet: info.name,
                r0: mg.startRow,
                c0: mg.startColumn,
                r1: mg.endRow,
                c1: mg.endColumn,
              });
            break;
          }
          case MUTATIONS.removeSheet: {
            const name = nameOf(s);
            runOne(e, m);
            out.push({ op: "remove_sheet", name });
            break;
          }
          case MUTATIONS.renameSheet: {
            const from = nameOf(s);
            runOne(e, m);
            out.push({ op: "rename_sheet", from, to: nameOf(s) });
            break;
          }
          case MUTATIONS.orderSheet: {
            runOne(e, m);
            out.push({ op: "move_sheet", name: nameOf(s), to: e.sheetInfo(s)?.index ?? 0 });
            break;
          }
          case MUTATIONS.hideSheet: {
            runOne(e, m);
            out.push({ op: "sheet_visible", name: nameOf(s), visible: !e.sheetData(s)?.hidden });
            break;
          }
          case MUTATIONS.colWidth:
          case MUTATIONS.rowHeight:
          case MUTATIONS.rowAuto:
          case MUTATIONS.rowAutoH:
          case MUTATIONS.colHidden:
          case MUTATIONS.colVisible:
          case MUTATIONS.rowHidden:
          case MUTATIONS.rowVisible: {
            runOne(e, m);
            const name = nameOf(s);
            const data = e.sheetData(s);
            const ranges = ((p.ranges as unknown[]) ?? (p.range ? [p.range] : [])).filter(isRange);
            for (const r of ranges) {
              if (m.id === MUTATIONS.colWidth)
                for (let c = r.startColumn; c <= r.endColumn; c++)
                  out.push({
                    op: "col_width",
                    sheet: name,
                    c0: c,
                    c1: c,
                    px: data?.columnData?.[c]?.w ?? data?.defaultColumnWidth ?? 88,
                  });
              else if (m.id === MUTATIONS.rowHeight)
                for (let x = r.startRow; x <= r.endRow; x++)
                  out.push({
                    op: "row_height",
                    sheet: name,
                    r0: x,
                    r1: x,
                    px: data?.rowData?.[x]?.h ?? data?.defaultRowHeight ?? 24,
                  });
              else if (m.id === MUTATIONS.rowAuto || m.id === MUTATIONS.rowAutoH)
                out.push({ op: "row_auto", sheet: name, r0: r.startRow, r1: r.endRow });
              else if (m.id === MUTATIONS.colHidden || m.id === MUTATIONS.colVisible)
                out.push({
                  op: "cols_visible",
                  sheet: name,
                  c0: r.startColumn,
                  c1: r.endColumn,
                  visible: m.id === MUTATIONS.colVisible,
                });
              else
                out.push({
                  op: "rows_visible",
                  sheet: name,
                  r0: r.startRow,
                  r1: r.endRow,
                  visible: m.id === MUTATIONS.rowVisible,
                });
            }
            break;
          }
          case MUTATIONS.filterRange: {
            runOne(e, m);
            const r = p.range as Range;
            if (isRange(r))
              out.push({
                op: "autofilter",
                sheet: nameOf(s),
                r0: r.startRow,
                c0: r.startColumn,
                r1: r.endRow,
                c1: r.endColumn,
              });
            break;
          }
          case MUTATIONS.removeFilter: {
            runOne(e, m);
            out.push({ op: "autofilter", sheet: nameOf(s), off: true });
            break;
          }
          case MUTATIONS.filterCriteria:
            runOne(e, m);
            skipped.add(
              "filter criteria (the filter buttons are kept; the chosen values only in the editor)",
            );
            break;
          case MUTATIONS.frozen:
          case MUTATIONS.gridlines:
          case MUTATIONS.tabColor:
          case MUTATIONS.reFilter:
            runOne(e, m);
            skipped.add("view settings (frozen rows, gridlines, tab colours)");
            break;
          default:
            runOne(e, m);
            skipped.add(m.id);
        }
      }
    }
    const snap = e.snapshot();
    const ids: Record<string, string> = {};
    for (const id of snap.sheetOrder) {
      const name = snap.sheets[id]?.name;
      if (name) ids[name] = id;
    }
    return { ops: out, ids, skipped: [...skipped] };
  } finally {
    e.dispose();
  }
}

function runOne(e: SheetEngine, m: SheetMutation) {
  const r = e.run([m]);
  if (!r.ok) throw new Error(`The change ${r.id} cannot be replayed to save: ${r.why}`);
}

// ---- LibreOffice ---------------------------------------------------------------------------

/**
 * The Python script LibreOffice's own Python runs (its `program/python`, with `uno`): it starts
 * soffice headless with a profile of ours, opens the copy (macros never run), applies the patch,
 * keeps the sheets' ids as a property of the document and stores it in place.
 */
export const TOPPA_SCRIPT = `
import json, os, subprocess, sys, time, uno
from com.sun.star.beans import PropertyValue
from com.sun.star.lang import Locale

def pv(n, v):
    p = PropertyValue(); p.Name = n; p.Value = v; return p

spec = json.load(open(sys.argv[1], encoding="utf-8"))
pipe = "rgtoppa%d" % os.getpid()
proc = subprocess.Popen([spec["soffice"], "--headless", "--invisible", "--nologo", "--norestore",
    "--nodefault", "--nolockcheck", "-env:UserInstallation=" + spec["profile"],
    "--accept=pipe,name=%s;urp;" % pipe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
out = {"ok": False}
try:
    local = uno.getComponentContext()
    res = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    t0 = time.time()
    while True:
        try:
            ctx = res.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
            break
        except Exception:
            if proc.poll() is not None or time.time() - t0 > 90: raise
            time.sleep(0.1)
    desk = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desk.loadComponentFromURL(spec["url"], "_blank", 0,
        (pv("Hidden", True), pv("MacroExecutionMode", 0), pv("UpdateDocMode", 0)))
    if doc is None: raise Exception("LibreOffice could not open the file")
    en = Locale("en", "US", "")
    fmts = doc.NumberFormats
    def fmt_key(pattern):
        k = fmts.queryKey(pattern, en, False)
        if k == -1: k = fmts.addNew(pattern, en)
        return k
    def sheet(name): return doc.Sheets.getByName(name)
    def rng(s, r0, c0, r1, c1): return s.getCellRangeByPosition(c0, r0, c1, r1)
    def style(target, st):
        for k, v in st.items():
            if k == "bl":
                if v is None: target.setPropertyToDefault("CharWeight")
                else: target.CharWeight = 150.0 if v else 100.0
            elif k == "it":
                if v is None: target.setPropertyToDefault("CharPosture")
                else: target.CharPosture = uno.Enum("com.sun.star.awt.FontSlant", "ITALIC" if v else "NONE")
            elif k == "ul":
                if v is None: target.setPropertyToDefault("CharUnderline")
                else: target.CharUnderline = 1 if v.get("s") else 0
            elif k == "st":
                if v is None: target.setPropertyToDefault("CharStrikeout")
                else: target.CharStrikeout = 1 if v.get("s") else 0
            elif k == "cl":
                if v is None: target.setPropertyToDefault("CharColor")
                else: target.CharColor = int(v["rgb"].lstrip("#"), 16)
            elif k == "bg":
                if v is None: target.setPropertyToDefault("CellBackColor")
                else: target.CellBackColor = int(v["rgb"].lstrip("#"), 16)
            elif k == "ff":
                if v is None: target.setPropertyToDefault("CharFontName")
                else: target.CharFontName = v
            elif k == "fs":
                if v is None: target.setPropertyToDefault("CharHeight")
                else: target.CharHeight = float(v)
            elif k == "ht":
                if v is None: target.setPropertyToDefault("HoriJustify")
                else: target.HoriJustify = uno.Enum("com.sun.star.table.CellHoriJustify", {1: "LEFT", 2: "CENTER", 3: "RIGHT"}.get(v, "STANDARD"))
            elif k == "vt":
                if v is None: target.setPropertyToDefault("VertJustify")
                else: target.VertJustify = {1: 1, 2: 2, 3: 3}.get(v, 0)
            elif k == "tb":
                if v is None: target.setPropertyToDefault("IsTextWrapped")
                else: target.IsTextWrapped = (v == 3)
            elif k == "n":
                if v is None: target.setPropertyToDefault("NumberFormat")
                else: target.NumberFormat = fmt_key(v["pattern"])
    for op in spec["ops"]:
        k = op["op"]
        if k == "cells":
            s = sheet(op["sheet"])
            for c in op["cells"]:
                cell = s.getCellByPosition(c["c"], c["r"])
                if "set" in c:
                    x = c["set"]
                    if x.get("f"):
                        cell.Formula = x["f"]
                    else:
                        v = x.get("v")
                        if v is None or v == "":
                            cell.getSpreadsheet().getCellRangeByPosition(c["c"], c["r"], c["c"], c["r"]).clearContents(1 | 2 | 4 | 16)
                        elif isinstance(v, bool):
                            cell.Value = 1 if v else 0
                            cell.NumberFormat = fmts.getStandardFormat(1024, en)
                        elif isinstance(v, (int, float)):
                            cell.Value = v
                        else:
                            cell.String = str(v)
                if "style" in c: style(cell, c["style"])
        elif k == "insert_rows": sheet(op["sheet"]).Rows.insertByIndex(op["at"], op["count"])
        elif k == "remove_rows": sheet(op["sheet"]).Rows.removeByIndex(op["at"], op["count"])
        elif k == "insert_cols": sheet(op["sheet"]).Columns.insertByIndex(op["at"], op["count"])
        elif k == "remove_cols": sheet(op["sheet"]).Columns.removeByIndex(op["at"], op["count"])
        elif k == "merge": rng(sheet(op["sheet"]), op["r0"], op["c0"], op["r1"], op["c1"]).merge(True)
        elif k == "unmerge": rng(sheet(op["sheet"]), op["r0"], op["c0"], op["r1"], op["c1"]).merge(False)
        elif k == "add_sheet": doc.Sheets.insertNewByName(op["name"], min(op["at"], doc.Sheets.Count))
        elif k == "remove_sheet": doc.Sheets.removeByName(op["name"])
        elif k == "rename_sheet": sheet(op["from"]).Name = op["to"]
        elif k == "move_sheet": doc.Sheets.moveByName(op["name"], op["to"] if op["to"] < doc.Sheets.Count else doc.Sheets.Count)
        elif k == "sheet_visible": sheet(op["name"]).IsVisible = op["visible"]
        elif k == "col_width":
            cols = sheet(op["sheet"]).Columns
            for i in range(op["c0"], op["c1"] + 1): cols.getByIndex(i).Width = int(round(op["px"] * 2540 / 96))
        elif k == "row_height":
            rows = sheet(op["sheet"]).Rows
            for i in range(op["r0"], op["r1"] + 1): rows.getByIndex(i).Height = int(round(op["px"] * 2540 / 96))
        elif k == "row_auto":
            rows = sheet(op["sheet"]).Rows
            for i in range(op["r0"], op["r1"] + 1): rows.getByIndex(i).OptimalHeight = True
        elif k == "cols_visible":
            cols = sheet(op["sheet"]).Columns
            for i in range(op["c0"], op["c1"] + 1): cols.getByIndex(i).IsVisible = op["visible"]
        elif k == "rows_visible":
            rows = sheet(op["sheet"]).Rows
            for i in range(op["r0"], op["r1"] + 1): rows.getByIndex(i).IsVisible = op["visible"]
        elif k == "autofilter":
            s = sheet(op["sheet"])
            dbr = doc.DatabaseRanges
            name = "__RedGiant_Filter_" + str(s.RangeAddress.Sheet)
            if dbr.hasByName(name): dbr.removeByName(name)
            if not op.get("off"):
                dbr.addNewByName(name, rng(s, op["r0"], op["c0"], op["r1"], op["c1"]).RangeAddress)
                dbr.getByName(name).AutoFilter = True
    props = doc.DocumentProperties.UserDefinedProperties
    ids = json.dumps(spec["ids"], ensure_ascii=False)
    if props.getPropertySetInfo().hasPropertyByName(spec["property"]):
        props.setPropertyValue(spec["property"], ids)
    else:
        props.addProperty(spec["property"], 0, ids)
    doc.calculateAll()
    doc.store()
    doc.close(True)
    out = {"ok": True}
except Exception as e:
    out = {"ok": False, "error": str(e)}
finally:
    try: desk.terminate()
    except Exception: pass
    try: proc.wait(timeout=30)
    except Exception: proc.kill()
print(json.dumps(out))
`;

/** LibreOffice's own Python beside its soffice (or a system one that has uno). */
export function pythonFor(
  soffice: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  // Windows paths joined as Windows does, the others with slashes, whatever runs this.
  const path = /^[A-Za-z]:|\\/.test(soffice) ? win32 : posix;
  const dir = path.dirname(soffice);
  const mac = ["..", "Frameworks", "LibreOfficePython.framework", "Versions", "Current", "bin"];
  for (const p of [
    path.join(dir, "python.exe"),
    path.join(dir, "python"),
    path.join(dir, "..", "Resources", "python"),
    path.join(dir, ...mac, "python3"),
  ])
    if (exists(p)) return p;
  // A system LibreOffice (Debian's) uses the system's Python with python3-uno.
  return path === win32 ? undefined : "python3";
}

export interface ToppaDeps {
  soffice: string;
  python: string;
  /** LibreOffice's profile for saving (its own: two soffice cannot share one). */
  profileDir: string;
  tmpDir: string;
  run?: (
    file: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string }>;
}

const execRun = (file: string, args: string[], timeoutMs: number) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) =>
        err && !stdout
          ? reject(Object.assign(err, { stderr }))
          : resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
  });

/** One soffice at a time per profile: saves wait for each other. */
let chain: Promise<unknown> = Promise.resolve();

/** The file's bytes with the patch applied by LibreOffice (the input is never touched). */
export function applyPatch(bytes: Uint8Array, patch: Patch, d: ToppaDeps): Promise<Uint8Array> {
  const run = async () => {
    const dir = join(
      d.tmpDir,
      `toppa-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(dir, { recursive: true });
    try {
      const file = join(dir, "sheet.ods");
      await writeFile(file, bytes);
      const script = join(dir, "toppa.py");
      await writeFile(script, TOPPA_SCRIPT);
      const spec = join(dir, "spec.json");
      await mkdir(d.profileDir, { recursive: true });
      await writeFile(
        spec,
        JSON.stringify({
          soffice: d.soffice,
          profile: pathToFileURL(d.profileDir).href,
          url: pathToFileURL(file).href,
          ops: patch.ops,
          ids: patch.ids,
          property: SHEET_IDS_PROPERTY,
        }),
      );
      const { stdout, stderr } = await (d.run ?? execRun)(d.python, [script, spec], 180_000);
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      let res: { ok: boolean; error?: string } = { ok: false };
      try {
        res = JSON.parse(line) as typeof res;
      } catch {
        res = {
          ok: false,
          error: (stderr || stdout).trim().slice(-500) || "no answer from LibreOffice",
        };
      }
      if (!res.ok)
        throw new Error(`LibreOffice could not save the sheet: ${res.error ?? "unknown error"}`);
      return new Uint8Array(await readFile(file));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

/** A copy in another format made by LibreOffice (Esporta come…): xlsx, csv, pdf, ods. */
export function exportWith(
  bytes: Uint8Array,
  to: "xlsx" | "xls" | "csv" | "pdf" | "ods",
  d: Pick<ToppaDeps, "soffice" | "profileDir" | "tmpDir" | "run">,
): Promise<Uint8Array> {
  const run = async () => {
    const dir = join(
      d.tmpDir,
      `export-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await mkdir(join(dir, "out"), { recursive: true });
    try {
      const file = join(dir, "sheet.ods");
      await writeFile(file, bytes);
      await mkdir(d.profileDir, { recursive: true });
      const filter =
        to === "xlsx"
          ? "xlsx:Calc MS Excel 2007 XML"
          : to === "xls"
            ? "xls:MS Excel 97"
            : to === "csv"
              ? "csv:Text - txt - csv (StarCalc):44,34,76,1"
              : to;
      await (d.run ?? execRun)(
        d.soffice,
        [
          ...LO_QUIET,
          profileArg(d.profileDir),
          "--convert-to",
          filter,
          "--outdir",
          join(dir, "out"),
          file,
        ],
        180_000,
      );
      const made = join(dir, "out", `sheet.${to}`);
      if (!existsSync(made)) throw new Error(`LibreOffice did not make the ${to.toUpperCase()}`);
      return new Uint8Array(await readFile(made));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
