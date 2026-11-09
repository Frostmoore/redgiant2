// A sheet as an agent reads it (G37.3, canvas_look view "structure"): the sheets, what is kept as
// a placeholder, then the rows asked for, cell by cell, formulas with their computed values
// (formulas are computed again on the server first), formats in a few words, merged areas.
import { areaName, cellName, columnName, parseArea } from "./a1.js";
import { keepEngine, takeEngine } from "./engine.js";
import { type CellData, extentOf, type SheetModel, styleOf, type WorkbookData } from "./model.js";

const MAX_TEXT = 60_000;
const ROWS = 100;
const MAX_ROWS = 500;

export interface StructureAsk {
  fromLine?: number | undefined;
  toLine?: number | undefined;
  cells?: string | undefined;
  sheet?: string | undefined;
}

const show = (v: unknown) =>
  typeof v === "string" ? JSON.stringify(v.length > 200 ? `${v.slice(0, 200)}…` : v) : String(v);

function cellText(wb: WorkbookData, cell: CellData, formula: string | undefined): string {
  const parts: string[] = [];
  if (formula)
    parts.push(`${formula} → ${cell.v === undefined || cell.v === null ? "?" : show(cell.v)}`);
  else parts.push(show(cell.v));
  const s = styleOf(wb, cell);
  const f: string[] = [];
  if (s.bl) f.push("bold");
  if (s.it) f.push("italic");
  if (s.n?.pattern) f.push(`format ${JSON.stringify(s.n.pattern)}`);
  if (s.bg?.rgb) f.push(`background ${s.bg.rgb}`);
  if (f.length) parts.push(`[${f.join(", ")}]`);
  return parts.join(" ");
}

export async function sheetStructure(model: SheetModel, ask: StructureAsk): Promise<string> {
  // Formulas computed again: the values the agent reads are the ones the person sees.
  const engine = takeEngine(model);
  let wb: WorkbookData = model.wb;
  try {
    await engine.calculate(2500);
    wb = engine.snapshot();
  } catch {
  } finally {
    keepEngine(model, engine);
  }
  const lines: string[] = [];
  const kind = model.kind.toUpperCase();
  lines.push(
    `Sheet file (${kind}${model.kind === "ods" ? "" : `: values only, one sheet; a formula is saved as the value it computes${model.numbers ? `; numbers written with «${model.numbers.decimal}» for decimals${model.numbers.thousands ? ` and «${model.numbers.thousands}» for thousands` : ""}` : ""}`}). Sheets: ${wb.sheetOrder
      .map((id) => {
        const s = wb.sheets[id];
        if (!s) return "?";
        const e = extentOf(s);
        return `«${s.name}»${s.hidden ? " (hidden)" : ""} ${e.lastRow < 0 ? "empty" : `A1:${cellName(e.lastRow, e.lastCol)}`}`;
      })
      .join(", ")}.`,
  );
  if (model.placeholders.length) {
    lines.push(
      `Placeholders, kept in the file and not editable here: ${model.placeholders
        .map((p) =>
          p.kind === "pivot"
            ? `pivot table${p.name ? ` «${p.name}»` : ""} writing its output in «${wb.sheets[p.sheet]?.name ?? "?"}» ${areaName(p)}${p.source ? `, reading the cells ${p.source}` : ""}`
            : `${p.kind}${p.name ? ` «${p.name}»` : ""} drawn over «${wb.sheets[p.sheet]?.name ?? "?"}» ${areaName(p)}${p.source ? `, reading the cells ${p.source}` : ""}`,
        )
        .join("; ")}.`,
    );
    // p3.5.3: a row written below a chart's cells stayed out of it.
    if (model.placeholders.some((p) => p.source && (p.kind === "chart" || p.kind === "pivot")))
      lines.push(
        "A chart or pivot table reads exactly the cells listed: a row or column written next to them is NOT included. To add a row to its data, insert_rows inside the range (before its last row) and write the rows in the order you want: the range grows with the inserted rows.",
      );
  }
  if (model.kept.length) lines.push(`Also kept untouched: ${model.kept.join(", ")}.`);
  // Which sheet and which rows.
  let sheetId = wb.sheetOrder[0];
  let area: { r0: number; c0: number; r1: number; c1: number } | undefined;
  if (ask.cells) {
    const a = parseArea(ask.cells);
    if (a) {
      area = a.area;
      if (a.sheet) ask = { ...ask, sheet: a.sheet };
    }
  }
  if (ask.sheet) {
    const found = wb.sheetOrder.find(
      (id) => wb.sheets[id]?.name.toLowerCase() === ask.sheet?.toLowerCase(),
    );
    if (found) sheetId = found;
    else lines.push(`There is no sheet «${ask.sheet}»: showing the first.`);
  }
  const sheet = sheetId ? wb.sheets[sheetId] : undefined;
  if (!sheet) return lines.join("\n");
  const ext = extentOf(sheet);
  if (ext.lastRow < 0 && !area) {
    lines.push(`«${sheet.name}» is empty.`);
    return lines.join("\n");
  }
  const from = Math.max(0, area ? area.r0 : (ask.fromLine ?? 1) - 1);
  const to = area
    ? Math.min(area.r1, from + MAX_ROWS - 1)
    : Math.min(
        ext.lastRow,
        ask.toLine ? Math.min(ask.toLine - 1, from + MAX_ROWS - 1) : from + ROWS - 1,
      );
  const c0 = area?.c0 ?? 0;
  const c1 = Math.min(area?.c1 ?? ext.lastCol, c0 + 100);
  lines.push(
    `«${sheet.name}», rows ${from + 1}-${to + 1} of ${ext.lastRow + 1}, columns ${columnName(c0)}-${columnName(c1)}; each row: "row| COLUMN value" (formulas as "=… → value"):`,
  );
  const merges = (sheet.mergeData ?? []).filter((m) => m.endRow >= from && m.startRow <= to);
  if (merges.length)
    lines.push(
      `Merged: ${merges
        .slice(0, 100)
        .map((m) => areaName({ r0: m.startRow, c0: m.startColumn, r1: m.endRow, c1: m.endColumn }))
        .join(", ")}.`,
    );
  let size = lines.join("\n").length;
  for (let r = from; r <= to; r++) {
    const row = sheet.cellData[r];
    if (!row) continue;
    const cells: string[] = [];
    for (let c = c0; c <= c1; c++) {
      const cell = row[c];
      if (!cell) continue;
      const formula =
        cell.f ?? (cell.si ? (engine.formulaAt(sheet.id, r, c) ?? undefined) : undefined);
      if ((cell.v === undefined || cell.v === null || cell.v === "") && !formula) continue;
      cells.push(`${columnName(c)} ${cellText(wb, cell, formula ?? undefined)}`);
    }
    if (!cells.length) continue;
    const line = `${r + 1}| ${cells.join(" | ")}`;
    size += line.length + 1;
    if (size > MAX_TEXT) {
      lines.push(`… (cut at row ${r}: ask for fewer rows with from_line/to_line or cells)`);
      break;
    }
    lines.push(line);
  }
  if (!area && to < ext.lastRow)
    lines.push(`… rows ${to + 2}-${ext.lastRow + 1} not shown (from_line/to_line or cells).`);
  return lines.join("\n");
}
