// Cell addresses for the sheet family (G37.3): A1 names in and out, and the two formula dialects
// a sheet meets on its way. Univer and the agents write formulas as Excel does (`=SUM(Sheet2!A1:B2)`,
// commas); an ODS keeps them in OpenFormula (`of:=SUM([$Sheet2.A1:.B2])`, semicolons), and
// LibreOffice's API reads its own (`=SUM($Sheet2.A1:B2)`, semicolons). Strings inside formulas are
// never touched. Pure functions, tested as tables.

/** 0 → A, 25 → Z, 26 → AA. */
export function columnName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A → 0, AA → 26; undefined when it is not a column. */
export function columnIndex(name: string): number | undefined {
  if (!/^[A-Za-z]{1,3}$/.test(name)) return undefined;
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface Cell {
  r: number;
  c: number;
}
export interface Area {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** "B2" → {r: 1, c: 1} ($ allowed). */
export function parseCell(ref: string): Cell | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return undefined;
  const c = columnIndex(m[1] as string);
  const r = Number(m[2]) - 1;
  if (c === undefined || r < 0 || r >= MAX_ROWS || c >= MAX_COLS) return undefined;
  return { r, c };
}

export const cellName = (r: number, c: number) => `${columnName(c)}${r + 1}`;

/** An area as A1: "B2" for one cell, "B2:C4" otherwise. */
export function areaName(a: Area): string {
  const from = cellName(a.r0, a.c0);
  return a.r0 === a.r1 && a.c0 === a.c1 ? from : `${from}:${cellName(a.r1, a.c1)}`;
}

/**
 * "B2:C4", "B2", whole columns "B:C" and rows "2:4" (bounded by `rows`/`cols`), with an optional
 * sheet in front ("Spese!B2:C4", "'Le spese'!B2"). Undefined when it cannot be read.
 */
export function parseArea(
  text: string,
  rows = MAX_ROWS,
  cols = MAX_COLS,
): { sheet?: string; area: Area } | undefined {
  let ref = text.trim();
  let sheet: string | undefined;
  const bang = ref.lastIndexOf("!");
  if (bang > 0) {
    sheet = ref.slice(0, bang);
    if (sheet.startsWith("'") && sheet.endsWith("'"))
      sheet = sheet.slice(1, -1).replace(/''/g, "'");
    ref = ref.slice(bang + 1);
  }
  const [a, b = a] = ref.split(":") as [string, string?];
  const whole = (x: string) => /^\$?[A-Za-z]{1,3}$/.test(x);
  const wholeRow = (x: string) => /^\$?\d{1,7}$/.test(x);
  let area: Area | undefined;
  if (whole(a) && whole(b as string)) {
    const c0 = columnIndex(a.replace("$", ""));
    const c1 = columnIndex((b as string).replace("$", ""));
    if (c0 !== undefined && c1 !== undefined)
      area = { r0: 0, r1: rows - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  } else if (wholeRow(a) && wholeRow(b as string)) {
    const r0 = Number(a.replace("$", "")) - 1;
    const r1 = Number((b as string).replace("$", "")) - 1;
    if (r0 >= 0 && r1 >= 0)
      area = { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: cols - 1 };
  } else {
    const x = parseCell(a);
    const y = parseCell(b as string);
    if (x && y)
      area = {
        r0: Math.min(x.r, y.r),
        r1: Math.max(x.r, y.r),
        c0: Math.min(x.c, y.c),
        c1: Math.max(x.c, y.c),
      };
  }
  if (!area) return undefined;
  return sheet !== undefined ? { sheet, area } : { area };
}

/** A sheet's name as a formula writes it: quoted when it is not a plain word. */
export const quoteSheet = (name: string) =>
  /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;

/** Splits a formula into strings (kept as they are) and the rest. */
function pieces(f: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let i = 0;
  let cur = "";
  while (i < f.length) {
    const ch = f[i] as string;
    if (ch === '"') {
      if (cur) out.push({ text: cur, quoted: false });
      cur = "";
      let j = i + 1;
      while (j < f.length) {
        if (f[j] === '"' && f[j + 1] === '"') j += 2;
        else if (f[j] === '"') break;
        else j++;
      }
      out.push({ text: f.slice(i, j + 1), quoted: true });
      i = j + 1;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) out.push({ text: cur, quoted: false });
  return out;
}

/**
 * OpenFormula as an ODS keeps it (`of:=SUM([.B2:.B5];[$Other.A1])`) to Excel's style
 * (`=SUM(B2:B5,Other!A1)`). Undefined when it is not OpenFormula (another program's namespace).
 */
export function odfToExcel(formula: string): string | undefined {
  const m = /^(?:of:)?=(.*)$/s.exec(formula);
  if (!m) return undefined;
  if (/^[a-z]+:=/i.test(formula) && !formula.startsWith("of:")) return undefined;
  const body = pieces(m[1] as string)
    .map((p) => {
      if (p.quoted) return p.text;
      return (
        p.text
          // [$'My sheet'.A1:.B2] / [.A1] / [$Sheet.A1:$Sheet.B2]
          .replace(/\[([^\]]*)\]/g, (_all, ref: string) => odfRef(ref))
          .replace(/;/g, ",")
      );
    })
    .join("");
  return `=${body}`;
}

function odfRef(ref: string): string {
  const parts = ref.split(":");
  let sheet: string | undefined;
  const cells = parts.map((p) => {
    // $Sheet.A1, 'Sheet name'.A1, .A1
    const dot = p.lastIndexOf(".");
    const s = dot >= 0 ? p.slice(0, dot).replace(/^\$/, "") : "";
    if (s && sheet === undefined) {
      sheet = s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
    }
    return dot >= 0 ? p.slice(dot + 1) : p;
  });
  const range = cells.join(":");
  return sheet ? `${quoteSheet(sheet)}!${range}` : range;
}

/**
 * Excel's style to LibreOffice's API grammar (`cell.Formula`): `Sheet!A1` → `$Sheet.A1`,
 * `'My sheet'!A1:B2` → `$'My sheet'.A1:B2`, commas → semicolons; strings untouched.
 */
export function excelToCalc(formula: string): string {
  const f = formula.startsWith("=") ? formula.slice(1) : formula;
  const body = pieces(f)
    .map((p) => {
      if (p.quoted) return p.text;
      return p.text
        .replace(
          /('(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/gu,
          (_all, sheet: string, range: string) => `$${sheet}.${range}`,
        )
        .replace(/,/g, ";");
    })
    .join("");
  return `=${body}`;
}
