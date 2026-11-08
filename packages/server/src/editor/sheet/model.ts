// The sheet family's model (G37.3): Univer's workbook data as plain JSON (what the page's Univer
// loads and what the server's headless Univer applies mutations to), plus what the editor knows
// of the file and does not show: placeholders for charts, pivot tables and drawings, and the list
// of things kept untouched. A model is never changed in place: applying an operation makes a new one.
import type { SheetPlaceholder } from "@redgiant/protocol";

/** The unit's id, the same on the page and on the server (mutations carry it). */
export const UNIT = "rg-sheet";

/** Univer's cell types (CellValueType). */
export const T_STRING = 1;
export const T_NUMBER = 2;
export const T_BOOLEAN = 3;

/** Univer's style of a cell (IStyleData), the parts the editor reads and writes. */
export interface Style {
  ff?: string | null;
  fs?: number | null;
  it?: 0 | 1 | null;
  bl?: 0 | 1 | null;
  ul?: { s: 0 | 1 } | null;
  st?: { s: 0 | 1 } | null;
  cl?: { rgb: string } | null;
  bg?: { rgb: string } | null;
  /** Horizontal: 1 left, 2 center, 3 right. */
  ht?: number | null;
  /** Vertical: 1 top, 2 middle, 3 bottom. */
  vt?: number | null;
  /** Wrap: 3 wraps. */
  tb?: number | null;
  n?: { pattern: string } | null;
  [k: string]: unknown;
}

export interface CellData {
  v?: string | number | boolean | null;
  t?: number | null;
  f?: string | null;
  si?: string | null;
  s?: string | Style | null;
  [k: string]: unknown;
}

export type Matrix<T> = Record<string, Record<string, T>>;

export interface SheetData {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: Matrix<CellData>;
  mergeData?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
  rowData?: Record<string, { h?: number; hd?: number; [k: string]: unknown }>;
  columnData?: Record<string, { w?: number; hd?: number; [k: string]: unknown }>;
  defaultColumnWidth?: number;
  defaultRowHeight?: number;
  hidden?: number;
  [k: string]: unknown;
}

export interface WorkbookData {
  id: string;
  name: string;
  appVersion: string;
  locale: string;
  styles: Record<string, Style | null>;
  sheetOrder: string[];
  sheets: Record<string, SheetData>;
  resources?: { name: string; data: string }[];
  [k: string]: unknown;
}

export type SheetKind = "csv" | "tsv" | "ods";

export interface SheetModel {
  wb: WorkbookData;
  kind: SheetKind;
  placeholders: SheetPlaceholder[];
  kept: string[];
}

/** Rows and columns a new sheet shows beyond its data. */
export function sheetSize(lastRow: number, lastCol: number) {
  return {
    rowCount: Math.min(1_048_576, Math.max(1000, lastRow + 101)),
    columnCount: Math.min(16_384, Math.max(26, lastCol + 11)),
  };
}

export function emptyWorkbook(name: string): WorkbookData {
  return {
    id: UNIT,
    name,
    appVersion: "1.4.0",
    locale: "enUS",
    styles: {},
    sheetOrder: [],
    sheets: {},
  };
}

/** A cell's style as an object (the workbook's table resolved). */
export function styleOf(wb: WorkbookData, cell: CellData | undefined): Style {
  const s = cell?.s;
  if (!s) return {};
  if (typeof s === "string") return { ...(wb.styles[s] ?? {}) };
  return { ...s };
}

/** The cells of a sheet in order: [row, col, cell]. */
export function* cellsOf(sheet: SheetData): Generator<[number, number, CellData]> {
  const rows = Object.keys(sheet.cellData)
    .map(Number)
    .sort((a, b) => a - b);
  for (const r of rows) {
    const row = sheet.cellData[r] ?? {};
    const cols = Object.keys(row)
      .map(Number)
      .sort((a, b) => a - b);
    for (const c of cols) {
      const cell = row[c];
      if (cell) yield [r, c, cell];
    }
  }
}

/** Whether a cell holds something to show or save (a value or a formula). */
export const filled = (c: CellData | undefined) =>
  !!c && ((c.v !== undefined && c.v !== null && c.v !== "") || !!c.f || !!c.si);

/** The last row and column with something in them (-1 when empty). */
export function extentOf(sheet: SheetData): { lastRow: number; lastCol: number } {
  let lastRow = -1;
  let lastCol = -1;
  for (const [r, c, cell] of cellsOf(sheet))
    if (filled(cell)) {
      if (r > lastRow) lastRow = r;
      if (c > lastCol) lastCol = c;
    }
  return { lastRow, lastCol };
}
