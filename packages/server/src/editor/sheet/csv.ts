// CSV and TSV for the sheet family (G37.3): read into one sheet and written back alike: the same
// separator, quotes only where the file had them or a value needs them, the same line ends, the
// byte order mark kept. A CSV keeps values only (p3.5.3): a formula is written as the value it
// computes, never as its text. Numbers are read the way the file writes them (p3.5.3): «23.50»
// and «23,50», thousands «1,234.50» or «1.234,50»; a number keeps its decimals and grouping as a
// number format, so it is written back as the same text.
import {
  type CellData,
  emptyWorkbook,
  extentOf,
  filled,
  type NumberStyle,
  type SheetData,
  type SheetModel,
  type Style,
  sheetSize,
  styleOf,
  T_NUMBER,
  T_STRING,
  type WorkbookData,
} from "./model.js";

export const PLAIN_NUMBERS: NumberStyle = { decimal: ".", thousands: "" };

/**
 * How a file writes its numbers: comma decimals when more numbers with a fraction use a comma than
 * a dot; thousands separators only when the file shows them unmistakably.
 */
export function sniffNumbers(fields: Iterable<string>): NumberStyle {
  let dot = 0;
  let comma = 0;
  let dotGroups = false;
  let commaGroups = false;
  let spaceGroups = false;
  for (const f of fields) {
    if (f.length > 40 || !/^-?\d/.test(f)) continue;
    if (/^-?\d+\.\d+$/.test(f)) dot++;
    else if (/^-?\d+,\d+$/.test(f)) comma++;
    else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(f)) {
      comma++;
      commaGroups = true;
    } else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(f)) {
      dot++;
      dotGroups = true;
    } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(f)) commaGroups = true;
    else if (/^-?\d{1,3}(,\d{3}){2,}$/.test(f)) dotGroups = true;
    else if (/^-?\d{1,3}( \d{3})+(,\d+)?$/.test(f)) spaceGroups = true;
  }
  if (comma > dot) return { decimal: ",", thousands: commaGroups ? "." : spaceGroups ? " " : "" };
  return { decimal: ".", thousands: dotGroups ? "," : "" };
}

const reEscape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A field as a number in the file's style, with its decimals and grouping; undefined if not one. */
export function readNumber(
  text: string,
  st: NumberStyle,
): { n: number; decimals: number; grouped: boolean } | undefined {
  if (text.length > 40) return undefined;
  const d = reEscape(st.decimal);
  const plain = new RegExp(`^(-?)(0|[1-9]\\d*)(?:${d}(\\d+))?$`).exec(text);
  const grouped =
    !plain && st.thousands
      ? new RegExp(`^(-?)([1-9]\\d{0,2}(?:${reEscape(st.thousands)}\\d{3})+)(?:${d}(\\d+))?$`).exec(
          text,
        )
      : null;
  const m = plain ?? grouped;
  if (!m) return undefined;
  const int = (m[2] as string).replace(/\D/g, "");
  const frac = m[3] ?? "";
  // Beyond 15 digits a double would not give the same text back.
  if (int.length + frac.length > 15) return undefined;
  const n = Number(`${m[1]}${int}${frac ? `.${frac}` : ""}`);
  return Number.isFinite(n) ? { n, decimals: frac.length, grouped: !!grouped } : undefined;
}

/** A number written the file's way, with these decimals and grouping (or as short as it is). */
export function numberText(
  n: number,
  st: NumberStyle,
  fmt?: { decimals: number; grouped: boolean },
): string {
  let s = fmt ? n.toFixed(Math.min(fmt.decimals, 20)) : String(n);
  if (/e/i.test(s)) return s;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const [whole = "", frac] = s.split(".");
  const int =
    fmt?.grouped && st.thousands ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, st.thousands) : whole;
  return `${neg ? "-" : ""}${int}${frac !== undefined ? `${st.decimal}${frac}` : ""}`;
}

/** The number format that writes a number back with these decimals and grouping. */
export const numberPattern = (decimals: number, grouped: boolean) =>
  `${grouped ? "#,##0" : "0"}${decimals ? `.${"0".repeat(decimals)}` : ""}`;

/** The decimals and grouping of a simple number format («0.00», «#,##0»); undefined otherwise. */
export function patternFormat(
  pattern: string | undefined,
): { decimals: number; grouped: boolean } | undefined {
  const m = pattern ? /^(#,##)?0(?:\.(0+))?$/.exec(pattern) : null;
  return m ? { decimals: m[2]?.length ?? 0, grouped: !!m[1] } : undefined;
}

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

/**
 * A field's value: a formula, a number when it is written back as the same text (its decimals and
 * grouping kept as a number format, `numberStyleId`), or the text.
 */
function cellOf(
  text: string,
  st: NumberStyle,
  numberStyleId: (pattern: string) => string,
): CellData | undefined {
  if (text === "") return undefined;
  if (text.startsWith("=") && text.length > 1) return { f: text };
  if (st.decimal === "." && /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n) && String(n) === text) return { v: n, t: T_NUMBER };
  }
  const r = readNumber(text, st);
  if (r) {
    if (numberText(r.n, st) === text) return { v: r.n, t: T_NUMBER };
    if (numberText(r.n, st, r) === text)
      return { v: r.n, t: T_NUMBER, s: numberStyleId(numberPattern(r.decimals, r.grouped)) };
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
  const numbers = sniffNumbers(rows.flat());
  const styles: Record<string, Style> = {};
  const styleIds = new Map<string, string>();
  const numberStyleId = (pattern: string) => {
    let id = styleIds.get(pattern);
    if (!id) {
      id = `rgnum${styleIds.size + 1}`;
      styleIds.set(pattern, id);
      styles[id] = { n: { pattern } };
    }
    return id;
  };
  const cellData: SheetData["cellData"] = {};
  let lastCol = 0;
  rows.forEach((r, ri) => {
    r.forEach((f, ci) => {
      const c = cellOf(f, numbers, numberStyleId);
      if (!c) return;
      const row = cellData[ri] ?? {};
      row[ci] = c;
      cellData[ri] = row;
      if (ci > lastCol) lastCol = ci;
    });
  });
  const wb = emptyWorkbook("sheet");
  wb.styles = styles;
  wb.sheetOrder = [CSV_SHEET];
  wb.sheets[CSV_SHEET] = {
    id: CSV_SHEET,
    name: tsv ? "TSV" : "CSV",
    ...sheetSize(rows.length - 1, lastCol),
    cellData,
  };
  return {
    model: {
      wb,
      kind: tsv ? "tsv" : "csv",
      placeholders: [],
      kept: [],
      ...(numbers.decimal !== "." || numbers.thousands ? { numbers } : {}),
    },
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

/**
 * A cell as its text in the file: its value, a number the file's way with its format's decimals; a
 * formula as the value it computes (`computed`: the cell after calculating), its text only when no
 * value could be computed.
 */
function textOf(
  wb: WorkbookData,
  c: CellData | undefined,
  st: NumberStyle,
  computed?: CellData,
): string {
  if (!c) return "";
  const formula = c.f || c.si;
  const v = formula ? computed?.v : c.v;
  if (formula && (v === undefined || v === null)) return c.f ?? "";
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    const fmt = patternFormat(styleOf(wb, c).n?.pattern ?? undefined);
    return numberText(v, st, fmt);
  }
  return String(v);
}

/**
 * The sheet as a CSV or TSV. `computed`: the workbook with its formulas calculated (the sheet
 * family's save), whose values are written in place of the formulas.
 */
export function writeDelimited(
  model: SheetModel,
  format: DelimitedFormat,
  computed?: WorkbookData,
): Uint8Array {
  const st = model.numbers ?? PLAIN_NUMBERS;
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
      const done = id ? computed?.sheets[id]?.cellData[r] : undefined;
      for (let c = 0; c <= width; c++)
        fields.push(quote(textOf(model.wb, row[c], st, done?.[c]), format));
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
