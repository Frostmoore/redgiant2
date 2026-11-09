// An agent's sheet operations in plain words (G37.3, canvas_edit): `set {cell, value|formula}`,
// `set_range`, `clear`, `insert_rows`, `delete_rows`, `insert_cols`, `delete_cols`, `format`,
// `merge`, `unmerge`, `add_sheet`, `rename_sheet`, `delete_sheet`, `sort`, `filter`, `width`,
// `height`. Each becomes Univer's own commands, run on a headless copy of the model: what the
// commands do (formulas following the rows, merges, styles) is what the page would do, and their
// undo mutations are Univer's. The agent never needs to know the mutations.
import type { DocOp, SheetMutation } from "@redgiant/protocol";
import { columnIndex, parseArea } from "./a1.js";
import { numberPattern, numberText, PLAIN_NUMBERS, readNumber } from "./csv.js";
import { SheetEngine, UNIVER_VERSION, univer } from "./engine.js";
import type { NumberStyle, SheetModel } from "./model.js";

export const SHEET_CATALOG = `Sheets (csv, tsv, ods; an xlsx is edited on its ODS copy): canvas_edit "ops", applied in order. Cells are A1 names; "sheet" is a sheet's name (the first sheet when left out); rows are numbers from 1, columns letters.
- {"op":"set","cell":"B2","value":42} or {"op":"set","cell":"B6","formula":"=SUM(B2:B5)"}: one cell. A value is a number, text, true/false or null (empty); text starting with "=" is a formula. Formulas are written as in Excel (commas, Sheet!A1).
- {"op":"set_range","range":"A2:C3","values":[["Luce",60,"=B2*2"],["Gas",45,null]]}: rows of values from the range's top-left cell ("range" may be just "A2").
- {"op":"clear","range":"B2:B9","what":"values"|"formats"|"all"}: empty cells (values by default).
- {"op":"insert_rows","before":5,"count":2} / {"op":"delete_rows","from":5,"count":2}: rows (formulas, charts and pivot sources below follow).
- {"op":"insert_cols","before":"C","count":1} / {"op":"delete_cols","from":"C","count":1}.
- {"op":"format","range":"A1:F1","bold":true,"italic":false,"underline":true,"strike":false,"color":"#1f4e79","background":"#fff2cc","font":"Arial","size":12,"align":"left|center|right","valign":"top|middle|bottom","wrap":true,"number":"#,##0.00 €"}: only the keys given change ("number" is an Excel number format: "0%", "dd/mm/yyyy"…).
- {"op":"merge","range":"A1:F1"} / {"op":"unmerge","range":"A1:F1"}.
- {"op":"add_sheet","name":"Riepilogo","at":2} / {"op":"rename_sheet","sheet":"Foglio1","name":"Spese"} / {"op":"delete_sheet","sheet":"Vecchio"} (ods only).
- {"op":"sort","range":"A2:F15","by":[{"col":"F","order":"desc"}],"header":false}: rows of the range sorted ("by" may be just "F").
- {"op":"filter","range":"A1:F15"} turns the filter buttons on; {"op":"filter","off":true} off.
- {"op":"width","cols":"A:C","px":120} / {"op":"height","rows":"2:5","px":30}.
Charts, pivot tables and pictures are placeholders here: kept in the file, not editable; cells inside a pivot table's output cannot be changed. A chart or a pivot table reads a fixed range of cells (canvas_look view "structure" lists it, e.g. "reading the cells Vendite!A1:B7"): a row written below that range is NOT in the chart. To add a row to its data, insert_rows inside the range (before its last row: the range grows with it), then write the rows in the order you want. A CSV keeps values only (one sheet, no formats or merges; a formula is saved as the value it computes); in a CSV a text like "23.50" (or "23,50" where the file writes numbers so) is a number. Read the sheet first with canvas_look view "structure" (cells, formulas with their values, merges, placeholders).`;

type Plain = Record<string, unknown>;
type Range = { startRow: number; endRow: number; startColumn: number; endColumn: number };

class Bad extends Error {}
const bad = (why: string): never => {
  throw new Bad(why);
};

function sheetOf(model: SheetModel, name: unknown): { id: string; rows: number; cols: number } {
  const wb = model.wb;
  let id: string | undefined;
  if (name === undefined || name === null || name === "") id = wb.sheetOrder[0];
  else if (typeof name === "string") {
    id = wb.sheetOrder.find((s) => wb.sheets[s]?.name === name);
    id ??= wb.sheetOrder.find((s) => wb.sheets[s]?.name.toLowerCase() === name.toLowerCase());
    if (!id)
      bad(
        `there is no sheet «${name}» (the sheets: ${wb.sheetOrder.map((s) => wb.sheets[s]?.name).join(", ")})`,
      );
  } else bad('"sheet" is a sheet\'s name');
  const s = wb.sheets[id as string];
  if (!s) return bad("this file has no sheet");
  return { id: s.id, rows: s.rowCount, cols: s.columnCount };
}

function rangeOf(text: unknown, rows: number, cols: number): { sheet?: string; r: Range } {
  if (typeof text !== "string") return bad('give a "range" like "B2:C4"');
  const a = parseArea(text, rows, cols);
  if (!a) return bad(`«${text}» is not a range (write it like "B2:C4" or "B2")`);
  return {
    ...(a.sheet !== undefined && { sheet: a.sheet }),
    r: { startRow: a.area.r0, endRow: a.area.r1, startColumn: a.area.c0, endColumn: a.area.c1 },
  };
}

/** A value of the agent as a cell. */
function anyCellOf(v: unknown): Plain {
  if (v === null || v === undefined || v === "") return { v: null, f: null, si: null, p: null };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) bad("a number must be finite");
    return { v, f: null, si: null, p: null, t: 2 };
  }
  if (typeof v === "boolean") return { v, f: null, si: null, p: null, t: 3 };
  if (typeof v === "string") {
    if (v.startsWith("=") && v.length > 1) return { f: v, si: null, p: null };
    return { v, f: null, si: null, p: null, t: 1 };
  }
  return bad("a value is a number, a text, true/false or null");
}

/**
 * A value of the agent in a CSV (p3.5.3): a text that is a number the file's way («23.50»,
 * «1.234,50» in an Italian file) is that number, with its decimals kept as its format.
 */
function csvCellOf(v: unknown, st: NumberStyle): Plain {
  if (typeof v === "string" && !(v.startsWith("=") && v.length > 1)) {
    const r = readNumber(v.trim(), st);
    if (r)
      return numberText(r.n, st) === v.trim()
        ? { v: r.n, f: null, si: null, p: null, t: 2 }
        : {
            v: r.n,
            f: null,
            si: null,
            p: null,
            t: 2,
            s: { n: { pattern: numberPattern(r.decimals, r.grouped) } },
          };
  }
  return anyCellOf(v);
}

const rowNumber = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) bad(`"${what}" is a row number from 1`);
  return n - 1;
};
const colNumber = (v: unknown, what: string): number => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v - 1;
  const c = typeof v === "string" ? columnIndex(v) : undefined;
  if (c === undefined) return bad(`"${what}" is a column letter (C) or number from 1`);
  return c;
};
const countOf = (v: unknown) => {
  if (v === undefined) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) bad('"count" is a number from 1 to 10000');
  return n;
};
const hex = (v: unknown, what: string) => {
  if (typeof v !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(v))
    bad(`"${what}" is a colour like "#1f4e79"`);
  return { rgb: `#${(v as string).replace("#", "").toLowerCase()}` };
};

/** The commands an agent's operation stands for. */
function commandsOf(model: SheetModel, o: Plain): { id: string; params: Plain }[] {
  const m = univer();
  const S = m.sheets;
  const kind = typeof o.op === "string" ? o.op : "";
  const sheetName = (o.sheet as string | undefined) ?? undefined;
  const pick = (range?: { sheet?: string }) => sheetOf(model, range?.sheet ?? sheetName);
  const ods = model.kind === "ods";
  const cellOf = (v: unknown) =>
    ods ? anyCellOf(v) : csvCellOf(v, model.numbers ?? PLAIN_NUMBERS);
  const odsOnly = () => {
    if (!ods)
      bad(
        `a ${model.kind.toUpperCase()} file has one sheet of values only: "${kind}" needs an ODS`,
      );
  };
  switch (kind) {
    case "set": {
      if (typeof o.cell !== "string") return bad('"cell" is a cell like "B2"');
      const at = parseArea(o.cell);
      const c = at && at.area.r0 === at.area.r1 && at.area.c0 === at.area.c1 ? at.area : undefined;
      if (!c || !at) return bad(`«${o.cell}» is not one cell`);
      const s = sheetOf(model, at.sheet ?? sheetName);
      const value =
        o.formula !== undefined
          ? String(o.formula).startsWith("=")
            ? o.formula
            : `=${o.formula}`
          : o.value;
      if (o.formula === undefined && !("value" in o)) bad('give "value" or "formula"');
      return [
        {
          id: S.SetRangeValuesCommand.id,
          params: {
            subUnitId: s.id,
            range: { startRow: c.r0, endRow: c.r0, startColumn: c.c0, endColumn: c.c0 },
            value: { [c.r0]: { [c.c0]: cellOf(value) } },
          },
        },
      ];
    }
    case "set_range": {
      const { sheet, r } = rangeOf(o.range, 1_048_576, 16_384);
      const s = sheetOf(model, sheet ?? sheetName);
      if (!Array.isArray(o.values) || !o.values.every(Array.isArray))
        return bad('"values" is a list of rows, each a list of values');
      const rows = o.values as unknown[][];
      if (rows.length * Math.max(0, ...rows.map((x) => x.length)) > 50_000)
        bad("at most 50000 cells at once");
      const value: Record<number, Record<number, Plain>> = {};
      let maxC = r.startColumn;
      rows.forEach((row, i) => {
        row.forEach((v, j) => {
          const rr = r.startRow + i;
          const cc = r.startColumn + j;
          const line = value[rr] ?? {};
          line[cc] = cellOf(v);
          value[rr] = line;
          maxC = Math.max(maxC, cc);
        });
      });
      if (!rows.length) bad('"values" is empty');
      return [
        {
          id: S.SetRangeValuesCommand.id,
          params: {
            subUnitId: s.id,
            range: {
              startRow: r.startRow,
              endRow: r.startRow + rows.length - 1,
              startColumn: r.startColumn,
              endColumn: maxC,
            },
            value,
          },
        },
      ];
    }
    case "clear": {
      const { sheet, r } = rangeOf(o.range, 1_048_576, 16_384);
      const s = sheetOf(model, sheet ?? sheetName);
      const what = (o.what as string | undefined) ?? "values";
      if (!["values", "formats", "all"].includes(what)) bad('"what" is values, formats or all');
      const sh = model.wb.sheets[s.id];
      const value: Record<number, Record<number, Plain>> = {};
      // Only cells that hold something: a whole column stays small.
      for (const [rk, row] of Object.entries(sh?.cellData ?? {}))
        for (const ck of Object.keys(row ?? {})) {
          const rr = Number(rk);
          const cc = Number(ck);
          if (rr < r.startRow || rr > r.endRow || cc < r.startColumn || cc > r.endColumn) continue;
          const line = value[rr] ?? {};
          line[cc] = {
            ...(what !== "formats" && { v: null, f: null, si: null, p: null }),
            ...(what !== "values" && { s: null }),
          };
          value[rr] = line;
        }
      if (!Object.keys(value).length) return [];
      return [{ id: S.SetRangeValuesCommand.id, params: { subUnitId: s.id, value } }];
    }
    case "insert_rows":
    case "delete_rows": {
      const s = pick();
      const at = rowNumber(
        kind === "insert_rows" ? o.before : (o.from ?? o.row),
        kind === "insert_rows" ? "before" : "from",
      );
      const n = countOf(o.count);
      const range = { startRow: at, endRow: at + n - 1, startColumn: 0, endColumn: s.cols - 1 };
      return kind === "insert_rows"
        ? [
            {
              id: S.InsertRowCommand.id,
              params: { subUnitId: s.id, direction: m.core.Direction.UP, range },
            },
          ]
        : [{ id: S.RemoveRowCommand.id, params: { subUnitId: s.id, range } }];
    }
    case "insert_cols":
    case "delete_cols": {
      const s = pick();
      const at = colNumber(
        kind === "insert_cols" ? o.before : (o.from ?? o.col),
        kind === "insert_cols" ? "before" : "from",
      );
      const n = countOf(o.count);
      const range = { startRow: 0, endRow: s.rows - 1, startColumn: at, endColumn: at + n - 1 };
      return kind === "insert_cols"
        ? [
            {
              id: S.InsertColCommand.id,
              params: { subUnitId: s.id, direction: m.core.Direction.LEFT, range },
            },
          ]
        : [{ id: S.RemoveColCommand.id, params: { subUnitId: s.id, range } }];
    }
    case "format": {
      const { sheet, r } = rangeOf(o.range, 1_048_576, 16_384);
      const s = sheetOf(model, sheet ?? sheetName);
      const styles: [string, unknown][] = [];
      const flag = (k: string, key: string, wrap?: (v: number) => unknown) => {
        if (o[k] === undefined) return;
        if (typeof o[k] !== "boolean") bad(`"${k}" is true or false`);
        const v = o[k] ? 1 : 0;
        styles.push([key, wrap ? wrap(v) : v]);
      };
      flag("bold", "bl");
      flag("italic", "it");
      flag("underline", "ul", (v) => ({ s: v }));
      flag("strike", "st", (v) => ({ s: v }));
      if (o.color !== undefined) styles.push(["cl", hex(o.color, "color")]);
      if (o.background !== undefined) styles.push(["bg", hex(o.background, "background")]);
      if (o.font !== undefined) {
        if (typeof o.font !== "string" || !o.font.trim()) bad('"font" is a font name');
        styles.push(["ff", o.font]);
      }
      if (o.size !== undefined) {
        const n = Number(o.size);
        if (!(n >= 4 && n <= 200)) bad('"size" is a font size in points (4-200)');
        styles.push(["fs", n]);
      }
      if (o.align !== undefined) {
        const v = { left: 1, center: 2, right: 3 }[String(o.align)];
        if (!v) bad('"align" is left, center or right');
        styles.push(["ht", v]);
      }
      if (o.valign !== undefined) {
        const v = { top: 1, middle: 2, bottom: 3 }[String(o.valign)];
        if (!v) bad('"valign" is top, middle or bottom');
        styles.push(["vt", v]);
      }
      if (o.wrap !== undefined) styles.push(["tb", o.wrap ? 3 : 1]);
      const out: { id: string; params: Plain }[] = styles.map(([type, value]) => ({
        id: S.SetStyleCommand.id,
        params: { subUnitId: s.id, range: r, style: { type, value } },
      }));
      if (o.number !== undefined) {
        if (typeof o.number !== "string" || !o.number.trim())
          bad('"number" is a number format like "#,##0.00"');
        const values: { row: number; col: number; pattern: string }[] = [];
        for (let rr = r.startRow; rr <= Math.min(r.endRow, r.startRow + 999); rr++)
          for (let cc = r.startColumn; cc <= Math.min(r.endColumn, r.startColumn + 99); cc++)
            values.push({ row: rr, col: cc, pattern: o.number as string });
        out.push({ id: m.numfmt.SetNumfmtCommand.id, params: { subUnitId: s.id, values } });
      }
      if (!out.length)
        bad("say what to change: bold, italic, color, background, size, align, number…");
      return out;
    }
    case "merge":
    case "unmerge": {
      odsOnly();
      const { sheet, r } = rangeOf(o.range, 1_048_576, 16_384);
      const s = sheetOf(model, sheet ?? sheetName);
      return kind === "merge"
        ? [{ id: S.AddWorksheetMergeCommand.id, params: { subUnitId: s.id, selections: [r] } }]
        : [{ id: S.RemoveWorksheetMergeCommand.id, params: { subUnitId: s.id, ranges: [r] } }];
    }
    case "add_sheet": {
      odsOnly();
      const name = o.name;
      if (typeof name !== "string" || !name.trim() || name.length > 100 || /[[\]*?:/\\]/.test(name))
        return bad('"name" is a sheet name (no [ ] * ? : / \\)');
      if (
        model.wb.sheetOrder.some(
          (s) => model.wb.sheets[s]?.name.toLowerCase() === name.toLowerCase(),
        )
      )
        bad(`there is a sheet «${name}» already`);
      const at = o.at === undefined ? model.wb.sheetOrder.length : Number(o.at) - 1;
      if (!Number.isInteger(at) || at < 0 || at > model.wb.sheetOrder.length)
        bad('"at" is a position from 1');
      const id = `s${Math.random().toString(36).slice(2, 10)}`;
      return [
        {
          id: S.InsertSheetCommand.id,
          params: { index: at, sheet: { id, name, rowCount: 1000, columnCount: 26, cellData: {} } },
        },
      ];
    }
    case "rename_sheet": {
      odsOnly();
      const s = sheetOf(model, o.sheet);
      const name = o.name;
      if (typeof name !== "string" || !name.trim() || /[[\]*?:/\\]/.test(name))
        return bad('"name" is the new name');
      return [{ id: S.SetWorksheetNameCommand.id, params: { subUnitId: s.id, name } }];
    }
    case "delete_sheet": {
      odsOnly();
      const s = sheetOf(model, o.sheet);
      if (model.wb.sheetOrder.length < 2) bad("the last sheet cannot be deleted");
      return [{ id: S.RemoveSheetCommand.id, params: { subUnitId: s.id } }];
    }
    case "sort": {
      const { sheet, r } = rangeOf(o.range, 1_048_576, 16_384);
      const s = sheetOf(model, sheet ?? sheetName);
      const by = typeof o.by === "string" || typeof o.by === "number" ? [{ col: o.by }] : o.by;
      if (!Array.isArray(by) || !by.length)
        return bad('"by" is a column ("F") or a list like [{"col":"F","order":"desc"}]');
      const orderRules = (by as Plain[]).map((b) => {
        const c = colNumber(b.col, "col");
        if (c < r.startColumn || c > r.endColumn)
          bad(`column ${String(b.col)} is not in the range`);
        const order = b.order === undefined ? "asc" : String(b.order);
        if (order !== "asc" && order !== "desc") bad('"order" is asc or desc');
        return { type: order, colIndex: c };
      });
      const range = o.header ? { ...r, startRow: r.startRow + 1 } : r;
      if (range.startRow > range.endRow) bad("nothing to sort under the header");
      return [
        {
          id: m.sort.SortRangeCommand.id,
          params: { subUnitId: s.id, range, orderRules, hasTitle: false },
        },
      ];
    }
    case "filter": {
      const s = pick(typeof o.range === "string" ? parseArea(o.range) : undefined);
      if (o.off) return [{ id: m.filter.RemoveSheetFilterCommand.id, params: { subUnitId: s.id } }];
      const { r } = rangeOf(o.range, s.rows, s.cols);
      return [
        { id: m.filter.SetSheetFilterRangeCommand.id, params: { subUnitId: s.id, range: r } },
      ];
    }
    case "width":
    case "height": {
      const s = pick();
      const px = Number(o.px);
      if (!(px >= 2 && px <= 2000)) bad('"px" is a size in pixels (2-2000)');
      if (kind === "width") {
        const { r } = rangeOf(o.cols, s.rows, s.cols);
        return [
          { id: S.SetColWidthCommand.id, params: { subUnitId: s.id, ranges: [r], value: px } },
        ];
      }
      const { r } = rangeOf(o.rows, s.rows, s.cols);
      return [
        { id: S.SetRowHeightCommand.id, params: { subUnitId: s.id, ranges: [r], value: px } },
      ];
    }
    default:
      return bad(
        `unknown operation «${kind}»: set, set_range, clear, insert_rows, delete_rows, insert_cols, delete_cols, format, merge, unmerge, add_sheet, rename_sheet, delete_sheet, sort, filter, width, height (help: true for the details)`,
      );
  }
}

/** A cell the operation names, checked against what the editor never changes (pivot outputs). */
export type Guard = (model: SheetModel, op: DocOp) => string | undefined;

/**
 * The agent's operations, one after the other, as sheet operations (one each). Run on a headless
 * copy: nothing changes in `model`.
 */
export async function sheetFromAgent(
  model: SheetModel,
  ops: readonly unknown[],
  guard: Guard,
): Promise<{ ops: DocOp[] } | { error: string; index?: number }> {
  let engine: SheetEngine | undefined;
  try {
    engine = new SheetEngine(model.wb);
    let current = model;
    const out: DocOp[] = [];
    for (const [index, raw] of ops.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { error: 'each operation is an object with "op"', index };
      let cmds: { id: string; params: Plain }[];
      try {
        cmds = commandsOf(current, raw as Plain);
      } catch (err) {
        if (err instanceof Bad) return { error: err.message, index };
        throw err;
      }
      const redo: SheetMutation[] = [];
      const undo: SheetMutation[] = [];
      for (const c of cmds) {
        const made = await engine.command(c.id, c.params);
        if ("error" in made) return { error: made.error, index };
        redo.push(...made.redo);
        undo.unshift(...made.undo);
      }
      if (!redo.length) continue;
      const op: DocOp = {
        family: "sheet",
        engine: "univer",
        engineVersion: UNIVER_VERSION,
        op: { redo, undo },
      };
      const no = guard(current, op);
      if (no) return { error: no, index };
      out.push(op);
      current = { ...current, wb: engine.snapshot() };
    }
    if (!out.length) return { error: "these operations change nothing" };
    return { ops: out };
  } finally {
    engine?.dispose();
  }
}
