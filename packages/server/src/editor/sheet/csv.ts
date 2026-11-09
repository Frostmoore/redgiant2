// CSV and TSV for the sheet family (G37.3): read into one sheet and written back alike: the same
// separator, quotes only where the file had them or a value needs them, the same line ends, the
// byte order mark kept. A formula is written as its text (`=SUM(A1:A3)`): spreadsheet programs
// read it back as a formula. Numbers read as numbers only when they come back as the same text.
import {
  type CellData,
  emptyWorkbook,
  extentOf,
  filled,
  type SheetData,
  type SheetModel,
  sheetSize,
  T_NUMBER,
  T_STRING,
} from "./model.js";

export interface DelimitedFormat {
  sep: string;
  eol: "\n" | "\r\n";
  bom: boolean;
  /** Every field was quoted in the file (written so again). */
  quoteAll: boolean;
  /** The file ended with a line end. */
  finalEol: boolean;
}

export const CSV_SHEET = "sheet1";

/** The separator of a delimited text: tabs for .tsv, otherwise the most regular of , ; tab. */
export function sniffSeparator(text: string, tsv: boolean): string {
  if (tsv) return "\t";
  const lines = text.split(/\r?\n/, 20).filter((l) => l.length > 0);
  let best = ",";
  let bestScore = -1;
  for (const sep of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => splitRow(l, sep).length);
    if (!counts.length) continue;
    const first = counts[0] as number;
    if (first < 2) continue;
    const same = counts.filter((n) => n === first).length;
    const score = same * 10 + first;
    if (score > bestScore) {
      bestScore = score;
      best = sep;
    }
  }
  return best;
}

function splitRow(line: string, sep: string): string[] {
  return parseRows(line, sep)[0] ?? [];
}

/** RFC 4180 rows (quotes, doubled quotes, separators and line ends inside quotes). */
export function parseRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let any = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      any = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      any = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      any = false;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    any = true;
    i++;
  }
  if (any || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A field's value: a number when it reads back as the same text, a formula, or the text. */
function cellOf(text: string): CellData | undefined {
  if (text === "") return undefined;
  if (text.startsWith("=") && text.length > 1) return { f: text };
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n) && String(n) === text) return { v: n, t: T_NUMBER };
  }
  return { v: text, t: T_STRING };
}

export function readDelimited(
  bytes: Uint8Array,
  tsv: boolean,
): { model: SheetModel; format: DelimitedFormat } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new Error("This file is not UTF-8 text");
  }
  if (text.includes("\u0000")) throw new Error("This file is not text");
  const sep = sniffSeparator(text, tsv);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const finalEol = /\r?\n$/.test(text);
  const rows = parseRows(finalEol ? text.replace(/\r?\n$/, "") : text, sep);
  const fields = rows.flat().length;
  const quoteAll = fields > 0 && quotedFields(text, sep) >= fields;
  const cellData: SheetData["cellData"] = {};
  let lastCol = 0;
  rows.forEach((r, ri) => {
    r.forEach((f, ci) => {
      const c = cellOf(f);
      if (!c) return;
      const row = cellData[ri] ?? {};
      row[ci] = c;
      cellData[ri] = row;
      if (ci > lastCol) lastCol = ci;
    });
  });
  const wb = emptyWorkbook("sheet");
  wb.sheetOrder = [CSV_SHEET];
  wb.sheets[CSV_SHEET] = {
    id: CSV_SHEET,
    name: tsv ? "TSV" : "CSV",
    ...sheetSize(rows.length - 1, lastCol),
    cellData,
  };
  return {
    model: { wb, kind: tsv ? "tsv" : "csv", placeholders: [], kept: [] },
    format: { sep, eol, bom, quoteAll, finalEol },
  };
}

function quotedFields(text: string, sep: string): number {
  // Fields starting with a quote right after a separator or a line start.
  let n = 0;
  const re = new RegExp(`(^|[${sep === "\t" ? "\\t" : sep}\\r\\n])"`, "g");
  for (const _ of text.matchAll(re)) n++;
  return n;
}

/** A cell as its text in the file: the formula, or the value. */
function textOf(c: CellData | undefined): string {
  if (!c) return "";
  if (c.f) return c.f;
  if (c.v === undefined || c.v === null) return "";
  if (typeof c.v === "boolean") return c.v ? "TRUE" : "FALSE";
  return String(c.v);
}

export function writeDelimited(model: SheetModel, format: DelimitedFormat): Uint8Array {
  const id = model.wb.sheetOrder[0];
  const sheet = id ? model.wb.sheets[id] : undefined;
  const lines: string[] = [];
  if (sheet) {
    const { lastRow, lastCol } = extentOf(sheet);
    for (let r = 0; r <= lastRow; r++) {
      const row = sheet.cellData[r] ?? {};
      let last = -1;
      for (const k of Object.keys(row)) if (filled(row[k]) && Number(k) > last) last = Number(k);
      // Every line as wide as the widest, as the file had it.
      const width = Math.max(last, lastCol);
      const fields: string[] = [];
      for (let c = 0; c <= width; c++) fields.push(quote(textOf(row[c]), format));
      lines.push(fields.join(format.sep));
    }
  }
  const body = lines.join(format.eol) + (format.finalEol && lines.length ? format.eol : "");
  const out = new TextEncoder().encode(body);
  if (!format.bom) return out;
  const b = new Uint8Array(out.length + 3);
  b.set([0xef, 0xbb, 0xbf]);
  b.set(out, 3);
  return b;
}

function quote(text: string, f: DelimitedFormat): string {
  const needs =
    text.includes(f.sep) || text.includes('"') || text.includes("\n") || text.includes("\r");
  if (!needs && !f.quoteAll) return text;
  if (!needs && f.quoteAll && text === "") return text;
  return `"${text.replace(/"/g, '""')}"`;
}
