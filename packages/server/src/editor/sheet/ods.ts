// An ODS read into the sheet family's model (G37.3): values, formulas, cell styles, number formats,
// merged cells, column widths, row heights, hidden rows and sheets, for Univer to show and edit.
// Nothing here writes an ODS: saving is LibreOffice's «toppa» (toppa.ts), which applies only the
// changes made, so whatever this reader does not understand (charts, pivot tables, drawings,
// conditional formats, validations, macros, print ranges…) stays in the file as it was. Charts,
// pivot tables and drawings come back as placeholders the editor shows, the rest as a list.
import type { SheetPlaceholder } from "@redgiant/protocol";
import { parseXml, unzip, type XmlNode } from "../../convert-js.js";
import { odfToExcel, parseArea } from "./a1.js";
import {
  type CellData,
  emptyWorkbook,
  type SheetData,
  type SheetModel,
  type Style,
  sheetSize,
  T_BOOLEAN,
  T_NUMBER,
  T_STRING,
  type WorkbookData,
} from "./model.js";

/** Where the sheets' ids are kept in the file (a user-defined property of the document). */
export const SHEET_IDS_PROPERTY = "RedGiantSheetIds";
/** More cells than this and the editor says the file is too big for it (the pages still show it). */
export const MAX_CELLS = 300_000;

export interface OdsFormat {
  /** The sheets' ids by name as read (the toppa keeps them in the file when they change). */
  ids: Record<string, string>;
}

const kids = (n: XmlNode): XmlNode[] =>
  n.children.filter((c): c is XmlNode => typeof c !== "string");
const kid = (n: XmlNode, name: string) => kids(n).find((c) => c.name === name);
const all = (n: XmlNode, name: string) => kids(n).filter((c) => c.name === name);

function find(n: XmlNode, name: string): XmlNode | undefined {
  for (const c of kids(n)) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}

function findAll(n: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of kids(n)) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** A length of the file in CSS pixels (96 per inch). */
export function lengthPx(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^(-?[\d.]+)(in|cm|mm|pt|pc|px)$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const per: Record<string, number> = {
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 96 / 72,
    pc: 16,
    px: 1,
  };
  return Math.round(n * (per[m[2] as string] as number) * 100) / 100;
}

/** The text of a paragraph (spaces, tabs, line breaks, spans and links). */
function textOf(n: XmlNode): string {
  let s = "";
  for (const c of n.children) {
    if (typeof c === "string") s += c;
    else if (c.name === "text:s") s += " ".repeat(Number(c.attrs["text:c"] ?? 1));
    else if (c.name === "text:tab") s += "\t";
    else if (c.name === "text:line-break") s += "\n";
    else if (c.name === "office:annotation") continue;
    else s += textOf(c);
  }
  return s;
}

// ---- styles ------------------------------------------------------------------------------

interface RawStyle {
  parent?: string | undefined;
  data?: string | undefined;
  style: Style;
}

/** A colour of the file as Univer writes it. */
const colour = (v: string | undefined) =>
  v && /^#[0-9a-fA-F]{6}$/.test(v) ? { rgb: v.toLowerCase() } : undefined;

function readStyle(n: XmlNode): RawStyle {
  const s: Style = {};
  const text = kid(n, "style:text-properties");
  if (text) {
    const a = text.attrs;
    if (a["fo:font-weight"])
      s.bl = a["fo:font-weight"] === "bold" || Number(a["fo:font-weight"]) >= 600 ? 1 : 0;
    if (a["fo:font-style"]) s.it = a["fo:font-style"] === "italic" ? 1 : 0;
    const ul = a["style:text-underline-style"];
    if (ul) s.ul = { s: ul === "none" ? 0 : 1 };
    const st = a["style:text-line-through-style"];
    if (st) s.st = { s: st === "none" ? 0 : 1 };
    const cl = colour(a["fo:color"]);
    if (cl) s.cl = cl;
    const fs = /^([\d.]+)pt$/.exec(a["fo:font-size"] ?? "");
    if (fs) s.fs = Number(fs[1]);
    if (a["style:font-name"]) s.ff = a["style:font-name"];
  }
  const cell = kid(n, "style:table-cell-properties");
  if (cell) {
    const a = cell.attrs;
    const bg = colour(a["fo:background-color"]);
    if (bg) s.bg = bg;
    if (a["fo:wrap-option"] === "wrap") s.tb = 3;
    const va = a["style:vertical-align"];
    if (va === "top") s.vt = 1;
    else if (va === "middle") s.vt = 2;
    else if (va === "bottom") s.vt = 3;
  }
  const para = kid(n, "style:paragraph-properties");
  const ta = para?.attrs["fo:text-align"];
  if (ta === "center") s.ht = 2;
  else if (ta === "end" || ta === "right") s.ht = 3;
  else if (ta === "start" || ta === "left") s.ht = 1;
  return {
    parent: n.attrs["style:parent-style-name"],
    data: n.attrs["style:data-style-name"],
    style: s,
  };
}

/** A number style of the file as an Excel pattern (what Univer formats with). */
export function numberPattern(n: XmlNode): string | undefined {
  let out = "";
  const q = (t: string) => (t ? `"${t.replace(/"/g, "")}"` : "");
  for (const c of n.children) {
    if (typeof c === "string") continue;
    const a = c.attrs;
    switch (c.name) {
      case "number:number": {
        const dec = Number(a["number:decimal-places"] ?? 0);
        const min = Math.max(1, Number(a["number:min-integer-digits"] ?? 1));
        const int = "0".repeat(min);
        const head =
          a["number:grouping"] === "true" ? `${"#,##".slice(0, Math.max(2, 5 - min))}${int}` : int;
        out += head + (dec > 0 ? `.${"0".repeat(dec)}` : "");
        break;
      }
      case "number:scientific-number": {
        const dec = Number(a["number:decimal-places"] ?? 2);
        out += `0${dec > 0 ? `.${"0".repeat(dec)}` : ""}E+${"0".repeat(Number(a["number:min-exponent-digits"] ?? 2))}`;
        break;
      }
      case "number:fraction":
        out += "# ?/?";
        break;
      case "number:text":
        out += q(textOf(c));
        break;
      case "number:currency-symbol":
        out += q(textOf(c));
        break;
      case "number:day":
        out += a["number:style"] === "long" ? "dd" : "d";
        break;
      case "number:month":
        out +=
          a["number:textual"] === "true"
            ? a["number:style"] === "long"
              ? "mmmm"
              : "mmm"
            : a["number:style"] === "long"
              ? "mm"
              : "m";
        break;
      case "number:year":
        out += a["number:style"] === "long" ? "yyyy" : "yy";
        break;
      case "number:day-of-week":
        out += a["number:style"] === "long" ? "dddd" : "ddd";
        break;
      case "number:hours":
        out += a["number:style"] === "long" ? "hh" : "h";
        break;
      case "number:minutes":
        out += "mm";
        break;
      case "number:seconds":
        out += a["number:style"] === "long" ? "ss" : "s";
        break;
      case "number:am-pm":
        out += "AM/PM";
        break;
      case "number:text-content":
        out += "@";
        break;
      case "number:boolean":
        out += "TRUE";
        break;
    }
  }
  if (n.name === "number:percentage-style" && !out.includes("%")) out += "%";
  if (n.name === "number:boolean-style") return undefined;
  return out || undefined;
}

const NUMBER_STYLES = new Set([
  "number:number-style",
  "number:currency-style",
  "number:percentage-style",
  "number:date-style",
  "number:time-style",
  "number:text-style",
  "number:boolean-style",
]);

class Styles {
  private readonly raw = new Map<string, RawStyle>();
  private readonly patterns = new Map<string, string>();
  private readonly resolved = new Map<string, Style>();
  /** The workbook's style table: one id per distinct style, in order of use. */
  readonly table: Record<string, Style> = {};
  private readonly ids = new Map<string, string>();

  add(container: XmlNode | undefined) {
    if (!container) return;
    for (const n of kids(container)) {
      const name = n.attrs["style:name"];
      if (!name) continue;
      if (n.name === "style:style" && (n.attrs["style:family"] ?? "table-cell") === "table-cell")
        this.raw.set(name, readStyle(n));
      else if (NUMBER_STYLES.has(n.name)) {
        const p = numberPattern(n);
        if (p) this.patterns.set(name, p);
      }
    }
  }

  /** A named style of the cells, its parents' properties under its own. */
  style(name: string | undefined, depth = 0): Style {
    if (!name || depth > 20) return {};
    const hit = this.resolved.get(name);
    if (hit) return hit;
    const r = this.raw.get(name);
    if (!r) return {};
    const out: Style = { ...this.style(r.parent, depth + 1), ...r.style };
    const p = r.data ? this.patterns.get(r.data) : undefined;
    if (p && p !== "0" && p !== "General") out.n = { pattern: p };
    this.resolved.set(name, out);
    return out;
  }

  /** The id of a style in the workbook's table (undefined for no style). */
  idOf(style: Style): string | undefined {
    const keys = Object.keys(style).sort();
    if (!keys.length) return undefined;
    const key = JSON.stringify(style, keys);
    let id = this.ids.get(key);
    if (!id) {
      id = `st${this.ids.size + 1}`;
      this.ids.set(key, id);
      this.table[id] = style;
    }
    return id;
  }
}

// ---- values ------------------------------------------------------------------------------

/** A date of the file as Excel's serial number (days since 1899-12-30, the time as a fraction). */
export function serialOf(iso: string): number | undefined {
  const m = /^(-?\d{4,})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(iso);
  if (!m) return undefined;
  const days =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 -
    Date.UTC(1899, 11, 30) / 86_400_000;
  const secs = Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0);
  return days + secs / 86_400;
}

/** PT12H30M00S → 0.5208… (a fraction of a day). */
export function durationOf(v: string): number | undefined {
  const m = /^(-)?P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(v);
  if (!m) return undefined;
  const s =
    Number(m[2] ?? 0) * 86_400 +
    Number(m[3] ?? 0) * 3600 +
    Number(m[4] ?? 0) * 60 +
    Number(m[5] ?? 0);
  return (m[1] ? -1 : 1) * (s / 86_400);
}

function cellValueOf(cell: XmlNode): CellData {
  const a = cell.attrs;
  const out: CellData = {};
  const type = a["office:value-type"];
  const paras = all(cell, "text:p").map(textOf);
  const text = paras.join("\n");
  if (type === "float" || type === "percentage" || type === "currency") {
    out.v = Number(a["office:value"]);
    out.t = T_NUMBER;
  } else if (type === "date") {
    const n = serialOf(a["office:date-value"] ?? "");
    if (n !== undefined) {
      out.v = n;
      out.t = T_NUMBER;
    }
  } else if (type === "time") {
    const n = durationOf(a["office:time-value"] ?? "");
    if (n !== undefined) {
      out.v = n;
      out.t = T_NUMBER;
    }
  } else if (type === "boolean") {
    out.v = a["office:boolean-value"] === "true";
    out.t = T_BOOLEAN;
  } else if (type === "string") {
    out.v = a["office:string-value"] ?? text;
    out.t = T_STRING;
  } else if (text) {
    out.v = text;
    out.t = T_STRING;
  }
  const f = a["table:formula"];
  if (f) {
    const ex = odfToExcel(f);
    if (ex) out.f = ex;
  }
  return out;
}

// ---- the reader --------------------------------------------------------------------------

/** A stable id for a sheet name (the same name, the same id). */
function idFor(name: string, used: Set<string>): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let id = `s${h.toString(36)}`;
  let n = 1;
  while (used.has(id)) id = `s${h.toString(36)}-${++n}`;
  used.add(id);
  return id;
}

interface Pending {
  name: string;
  sheet: string;
  kind: SheetPlaceholder["kind"];
  x?: number | undefined;
  y?: number | undefined;
  w?: number | undefined;
  h?: number | undefined;
  r?: number | undefined;
  c?: number | undefined;
  end?: string | undefined;
  source?: string | undefined;
}

export function readOds(bytes: Uint8Array): { model: SheetModel; format: OdsFormat } {
  const files = unzip(bytes);
  if (!files) throw new Error("This file is not an ODS (not a zip)");
  const mime = files.mimetype ? new TextDecoder().decode(files.mimetype) : "";
  if (mime && mime.trim() !== "application/vnd.oasis.opendocument.spreadsheet")
    throw new Error("This file is not an ODS spreadsheet");
  const content = files["content.xml"];
  if (!content) throw new Error("This ODS has no content.xml");
  const doc = parseXml(new TextDecoder().decode(content));
  const stylesXml = files["styles.xml"]
    ? parseXml(new TextDecoder().decode(files["styles.xml"]))
    : undefined;
  const styles = new Styles();
  if (stylesXml) {
    styles.add(find(stylesXml, "office:styles"));
    styles.add(find(stylesXml, "office:automatic-styles"));
  }
  const auto = find(doc, "office:automatic-styles");
  styles.add(auto);
  // Column and row sizes, and the tables' own properties.
  const colWidth = new Map<string, number>();
  const rowHeight = new Map<string, number>();
  const hiddenTable = new Set<string>();
  for (const n of auto ? kids(auto) : []) {
    const name = n.attrs["style:name"] ?? "";
    const fam = n.attrs["style:family"];
    if (fam === "table-column") {
      const w = lengthPx(kid(n, "style:table-column-properties")?.attrs["style:column-width"]);
      if (w) colWidth.set(name, w);
    } else if (fam === "table-row") {
      const h = lengthPx(kid(n, "style:table-row-properties")?.attrs["style:row-height"]);
      if (h) rowHeight.set(name, h);
    } else if (fam === "table") {
      if (kid(n, "style:table-properties")?.attrs["table:display"] === "false")
        hiddenTable.add(name);
    }
  }
  // The sheets' ids kept in the file, if RedGiant saved it before.
  let kept: Record<string, string> = {};
  const meta = files["meta.xml"]
    ? parseXml(new TextDecoder().decode(files["meta.xml"]))
    : undefined;
  const prop = meta
    ? findAll(meta, "meta:user-defined").find((n) => n.attrs["meta:name"] === SHEET_IDS_PROPERTY)
    : undefined;
  if (prop)
    try {
      const v = JSON.parse(textOf(prop)) as unknown;
      if (v && typeof v === "object") kept = v as Record<string, string>;
    } catch {}
  const manifest = files["META-INF/manifest.xml"]
    ? new TextDecoder().decode(files["META-INF/manifest.xml"])
    : "";
  const isChart = (href: string) => {
    const path = href.replace(/^\.\//, "").replace(/\/$/, "");
    return new RegExp(
      `manifest:full-path="${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?"[^>]*opendocument\\.chart|opendocument\\.chart[^>]*manifest:full-path="${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?"`,
    ).test(manifest);
  };

  const spreadsheet = find(doc, "office:spreadsheet");
  if (!spreadsheet) throw new Error("This ODS has no spreadsheet");
  const wb: WorkbookData = emptyWorkbook("workbook");
  const used = new Set<string>(Object.values(kept));
  const ids: Record<string, string> = {};
  const pending: Pending[] = [];
  const keptThings = new Set<string>();
  let total = 0;
  const sheetGeometry = new Map<
    string,
    { widths: number[]; heights: number[]; dw: number; dh: number }
  >();

  for (const table of all(spreadsheet, "table:table")) {
    const name = table.attrs["table:name"] ?? `Sheet${wb.sheetOrder.length + 1}`;
    const id =
      kept[name] && !Object.values(ids).includes(kept[name] as string)
        ? (kept[name] as string)
        : idFor(name, used);
    ids[name] = id;
    const cellData: SheetData["cellData"] = {};
    const merges: NonNullable<SheetData["mergeData"]> = [];
    const columnData: NonNullable<SheetData["columnData"]> = {};
    const rowData: NonNullable<SheetData["rowData"]> = {};
    const colDefault: (string | undefined)[] = [];
    const widths: number[] = [];
    const heights: number[] = [];
    // Columns (in groups and header columns too).
    let col = 0;
    const columns = (parent: XmlNode) => {
      for (const n of kids(parent)) {
        if (n.name === "table:table-column") {
          const rep = Math.min(Number(n.attrs["table:number-columns-repeated"] ?? 1), 16_384 - col);
          const w = colWidth.get(n.attrs["table:style-name"] ?? "");
          const hidden = n.attrs["table:visibility"] === "collapse";
          for (let i = 0; i < rep && col < 1024; i++, col++) {
            if (w || hidden) columnData[col] = { ...(w && { w }), ...(hidden && { hd: 1 }) };
            widths[col] = w ?? 88;
            colDefault[col] = n.attrs["table:default-cell-style-name"];
          }
          if (col >= 1024) col += Math.max(0, rep - 1024);
        } else if (
          n.name === "table:table-column-group" ||
          n.name === "table:table-header-columns" ||
          n.name === "table:table-columns"
        )
          columns(n);
      }
    };
    columns(table);
    // Rows.
    let row = 0;
    let lastRow = -1;
    let lastCol = -1;
    const covered = new Set<string>();
    const rows = (parent: XmlNode) => {
      for (const n of kids(parent)) {
        if (n.name === "table:table-row") {
          const rep = Number(n.attrs["table:number-rows-repeated"] ?? 1);
          const h = rowHeight.get(n.attrs["table:style-name"] ?? "");
          const hidden =
            n.attrs["table:visibility"] === "collapse" || n.attrs["table:visibility"] === "filter";
          const cells = kids(n).filter(
            (c) => c.name === "table:table-cell" || c.name === "table:covered-table-cell",
          );
          const hasContent = cells.some(
            (c) =>
              c.attrs["office:value-type"] ||
              c.attrs["table:formula"] ||
              kid(c, "text:p") ||
              findAll(c, "draw:frame").length,
          );
          // A run of empty rows (often to the end of the sheet) is a size, not content.
          const times = hasContent ? Math.min(rep, 10_000) : Math.min(rep, 1);
          for (let i = 0; i < times; i++) {
            const r = row + i;
            if (h || hidden) rowData[r] = { ...(h && { h }), ...(hidden && { hd: 1 }) };
            heights[r] = h ?? 24;
            let c = 0;
            for (const cell of cells) {
              const crep = Math.min(
                Number(cell.attrs["table:number-columns-repeated"] ?? 1),
                16_384 - c,
              );
              const isCovered = cell.name === "table:covered-table-cell";
              const value = isCovered ? undefined : cellValueOf(cell);
              const styleName = cell.attrs["table:style-name"] ?? colDefault[c];
              const style = styles.style(styleName);
              const sid = styles.idOf(style);
              const filled = value && (value.v !== undefined || value.f);
              const span = Number(cell.attrs["table:number-columns-spanned"] ?? 1);
              const rspan = Number(cell.attrs["table:number-rows-spanned"] ?? 1);
              // Frames anchored to this cell (drawings, charts, pictures).
              for (const fr of kids(cell).filter((k) => k.name.startsWith("draw:")))
                pending.push(frame(fr, id, r, c));
              if (findAll(cell, "office:annotation").length) keptThings.add("comments");
              const reps = filled || sid ? Math.min(crep, 1024) : 1;
              for (let k = 0; k < reps; k++) {
                const cc = c + k;
                if (covered.has(`${r},${cc}`)) continue;
                if (filled || sid) {
                  const cd: CellData = { ...(value ?? {}) };
                  if (sid) cd.s = sid;
                  const line = cellData[r] ?? {};
                  line[cc] = cd;
                  cellData[r] = line;
                  if (filled) {
                    total++;
                    if (r > lastRow) lastRow = r;
                    if (cc > lastCol) lastCol = cc;
                  }
                }
              }
              if (!isCovered && (span > 1 || rspan > 1)) {
                merges.push({
                  startRow: r,
                  endRow: r + rspan - 1,
                  startColumn: c,
                  endColumn: c + span - 1,
                });
                for (let y = r; y < r + rspan; y++)
                  for (let x = c; x < c + span; x++)
                    if (y !== r || x !== c) covered.add(`${y},${x}`);
              }
              c += crep;
            }
            if (total > MAX_CELLS)
              throw new Error(
                `This sheet has more than ${MAX_CELLS.toLocaleString("en")} cells: too big for the editor (its pages still show it)`,
              );
          }
          row += rep;
        } else if (
          n.name === "table:table-row-group" ||
          n.name === "table:table-header-rows" ||
          n.name === "table:table-rows"
        )
          rows(n);
      }
    };
    rows(table);
    // Drawings anchored to the page (charts mostly).
    const shapes = kid(table, "table:shapes");
    for (const fr of shapes ? kids(shapes) : []) pending.push(frame(fr, id));
    if (table.attrs["table:print-ranges"]) keptThings.add("print ranges");
    const sheet: SheetData = {
      id,
      name,
      ...sheetSize(lastRow, lastCol),
      cellData,
      ...(merges.length && { mergeData: merges }),
      ...(Object.keys(rowData).length && { rowData }),
      ...(Object.keys(columnData).length && { columnData }),
      defaultColumnWidth: 88,
      defaultRowHeight: 24,
      ...(hiddenTable.has(table.attrs["table:style-name"] ?? "") && { hidden: 1 }),
    };
    wb.sheetOrder.push(id);
    wb.sheets[id] = sheet;
    sheetGeometry.set(id, { widths, heights, dw: 88, dh: 24 });
  }
  wb.styles = styles.table;

  // Pivot tables: their output is a placeholder (refreshed by LibreOffice, never edited here).
  const placeholders: SheetPlaceholder[] = [];
  for (const p of findAll(spreadsheet, "table:data-pilot-table")) {
    const target = odfRange(p.attrs["table:target-range-address"] ?? "");
    const sheetId = target?.sheet ? ids[target.sheet] : undefined;
    if (!target || !sheetId) continue;
    const src = kid(p, "table:source-cell-range")?.attrs["table:cell-range-address"];
    placeholders.push({
      kind: "pivot",
      sheet: sheetId,
      ...(p.attrs["table:name"] && { name: p.attrs["table:name"] }),
      ...target.area,
      ...(src && { source: odfRangeText(src) }),
    });
  }
  for (const f of pending) {
    const g = sheetGeometry.get(f.sheet);
    if (!g) continue;
    let area: { r0: number; c0: number; r1: number; c1: number };
    if (f.r !== undefined && f.c !== undefined) {
      const end = f.end ? odfRange(f.end)?.area : undefined;
      area = end
        ? { r0: f.r, c0: f.c, r1: Math.max(f.r, end.r1), c1: Math.max(f.c, end.c1) }
        : placeAt(g, f, f.r, f.c);
    } else area = placeAt(g, f, 0, 0);
    placeholders.push({
      kind: f.kind,
      sheet: f.sheet,
      ...(f.name && { name: f.name }),
      ...area,
      ...(f.source && { source: f.source }),
    });
  }
  function frame(fr: XmlNode, sheet: string, r?: number, c?: number): Pending {
    const obj = kid(fr, "draw:object") ?? kid(fr, "draw:object-ole");
    const img = kid(fr, "draw:image");
    const href = obj?.attrs["xlink:href"] ?? "";
    const kind: SheetPlaceholder["kind"] =
      fr.name !== "draw:frame"
        ? "shape"
        : obj
          ? isChart(href) || obj.attrs["draw:notify-on-update-of-ranges"]
            ? "chart"
            : "object"
          : img
            ? "image"
            : "shape";
    const ranges = obj?.attrs["draw:notify-on-update-of-ranges"];
    return {
      name: fr.attrs["draw:name"] ?? "",
      sheet,
      kind,
      x: lengthPx(fr.attrs["svg:x"]),
      y: lengthPx(fr.attrs["svg:y"]),
      w: lengthPx(fr.attrs["svg:width"]),
      h: lengthPx(fr.attrs["svg:height"]),
      r,
      c,
      end: fr.attrs["table:end-cell-address"],
      source: ranges ? ranges.split(/\s+/).map(odfRangeText).join(", ") : undefined,
    };
  }

  if (find(doc, "calcext:conditional-formats") || (auto && findAll(auto, "style:map").length))
    keptThings.add("conditional formats");
  if (find(doc, "table:content-validations")) keptThings.add("validations");
  const named = find(doc, "table:named-expressions");
  if (named && kids(named).length) keptThings.add("named ranges");
  if (find(doc, "table:database-ranges")) keptThings.add("filters and database ranges");
  if (Object.keys(files).some((k) => k.startsWith("Basic/") || k.startsWith("Scripts/")))
    keptThings.add("macros (never run)");
  if (findAll(doc, "table:scenario").length) keptThings.add("scenarios");

  return {
    model: { wb, kind: "ods", placeholders, kept: [...keptThings] },
    format: { ids },
  };
}

/** Where a drawing anchored by position falls, in cells. */
function placeAt(
  g: { widths: number[]; heights: number[]; dw: number; dh: number },
  f: Pending,
  r0: number,
  c0: number,
) {
  const walk = (sizes: number[], d: number, from: number, start: number, len: number) => {
    let pos = 0;
    let i = 0;
    while (pos + (sizes[i] ?? d) <= start && i < 100_000) pos += sizes[i++] ?? d;
    const first = Math.max(i, from);
    let end = first;
    let p = pos;
    while (p < start + len && end < 100_000) p += sizes[end++] ?? d;
    return [first, Math.max(first, end - 1)] as const;
  };
  const [c, c1] =
    f.r === undefined
      ? walk(g.widths, g.dw, c0, f.x ?? 0, f.w ?? g.dw)
      : [c0, c0 + Math.max(0, Math.round((f.w ?? g.dw) / g.dw) - 1)];
  const [r, r1] =
    f.r === undefined
      ? walk(g.heights, g.dh, r0, f.y ?? 0, f.h ?? g.dh)
      : [r0, r0 + Math.max(0, Math.round((f.h ?? g.dh) / g.dh) - 1)];
  return { r0: r, c0: c, r1, c1 };
}

/** "Pivot.A3:Pivot.D9" or "$'My sheet'.A1:.B2" → its sheet and area. */
export function odfRange(
  text: string,
): { sheet?: string; area: { r0: number; c0: number; r1: number; c1: number } } | undefined {
  const t = odfRangeText(text);
  return parseArea(t);
}

/** An ODF range as A1 with the sheet: "Vendite.F3:Vendite.F15" → "Vendite!F3:F15". */
export function odfRangeText(text: string): string {
  const parts = text.split(":");
  let sheet: string | undefined;
  const cells = parts.map((p) => {
    const dot = p.lastIndexOf(".");
    if (dot > 0 && sheet === undefined) {
      const s = p.slice(0, dot).replace(/^\$/, "");
      sheet = s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
    }
    return (dot >= 0 ? p.slice(dot + 1) : p).replace(/\$/g, "");
  });
  const range = cells.join(":");
  if (!sheet) return range;
  return `${/^[\p{L}_][\p{L}\p{N}_]*$/u.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${range}`;
}
