// Tables (G34.2): CSV and TSV read here, XLSX/ODS/XLS read by SheetJS (Community Edition,
// Apache-2.0, loaded only for a sheet). Columns sort with a press on their name, a filter keeps
// the rows that hold its words, the first row and the first column stay in place.
import { useEffect, useMemo, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconChevronDown, IconSearch } from "../../icons.js";
import { parseDelimited } from "../../viewers/delimited.js";
import { useBytes, useText, type ViewerProps } from "../../viewers/source.js";

export { parseDelimited };

/** The separator a CSV uses: the one of , ; and tab that splits its first line most. */
export function guessSeparator(text: string, format: string): string {
  if (format === "tsv") return "\t";
  const first = text.slice(0, 4000).split(/\r?\n/)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  return [",", ";", "\t"].reduce((a, b) => (count(b) > count(a) ? b : a), ",");
}

const NUMBER = /^-?[\d.,\s]*\d(?:[eE][+-]?\d+)?\s*%?$/;
/** "1.234,5" and "1,234.5" as numbers; undefined when it is not one. */
function asNumber(s: string): number | undefined {
  const v = s.trim();
  if (!v || !NUMBER.test(v)) return undefined;
  let n = v.replace(/[\s%]/g, "");
  if (/,\d{1,2}$/.test(n) && n.includes(".")) n = n.replace(/\./g, "").replace(",", ".");
  else if (/,/.test(n) && !n.includes(".") && /,\d{1,2}$/.test(n)) n = n.replace(",", ".");
  else n = n.replace(/,/g, "");
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}

export type Sort = { col: number; dir: "asc" | "desc" } | null;

/** Rows sorted by a column: numbers as numbers, words as the person's language orders them. */
export function sortRows(rows: string[][], sort: Sort): string[][] {
  if (!sort) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...rows].sort((a, b) => {
    const x = a[sort.col] ?? "";
    const y = b[sort.col] ?? "";
    const nx = asNumber(x);
    const ny = asNumber(y);
    // Empty cells go last whichever the direction.
    if (!x.trim() || !y.trim()) return !x.trim() === !y.trim() ? 0 : !x.trim() ? 1 : -1;
    if (nx !== undefined && ny !== undefined) return (nx - ny) * sign;
    return coll.compare(x, y) * sign;
  });
}

/** The rows holding every word of the filter, in any cell, any case. */
export function filterRows(rows: string[][], filter: string): string[][] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const all = r.join("\u0001").toLowerCase();
    return words.every((w) => all.includes(w));
  });
}

const MAX_SHOWN = 2000;

export function Grid({ rows }: { rows: string[][] }) {
  const [sort, setSort] = useState<Sort>(null);
  const [filter, setFilter] = useState("");
  const [head = [], ...body] = rows;
  const width = Math.max(head.length, ...body.slice(0, 500).map((r) => r.length));
  const shown = useMemo(() => sortRows(filterRows(body, filter), sort), [rows, sort, filter]);
  const next = (col: number): Sort =>
    sort?.col !== col ? { col, dir: "asc" } : sort.dir === "asc" ? { col, dir: "desc" } : null;
  return (
    <div class="vw-grid">
      <div class="vw-bar">
        <label class="vw-search">
          <IconSearch size={14} />
          <input
            type="search"
            value={filter}
            placeholder={t("vwFilter")}
            aria-label={t("vwFilter")}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </label>
        <span class="dim">
          {filter
            ? t("vwRowsOf", { n: shown.length.toLocaleString(), all: body.length.toLocaleString() })
            : t("vwRows", { n: body.length.toLocaleString() })}
        </span>
      </div>
      <div class="vw-grid-scroll">
        <table>
          <thead>
            <tr>
              <th class="vw-rowno" />
              {Array.from({ length: width }, (_, i) => (
                <th
                  key={i}
                  aria-sort={
                    sort?.col === i ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <button type="button" onClick={() => setSort(next(i))} title={t("vwSort")}>
                    <span>{head[i] ?? ""}</span>
                    {sort?.col === i && (
                      <span class={`vw-sort ${sort.dir}`}>
                        <IconChevronDown size={12} />
                      </span>
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, MAX_SHOWN).map((r, i) => (
              <tr key={i}>
                <td class="vw-rowno">{i + 1}</td>
                {Array.from({ length: width }, (_, j) => (
                  <td key={j} class={asNumber(r[j] ?? "") !== undefined ? "num" : ""}>
                    {r[j] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > MAX_SHOWN && (
          <p class="vw-note">
            {t("canvasMoreRows", { n: (shown.length - MAX_SHOWN).toLocaleString() })}
          </p>
        )}
      </div>
    </div>
  );
}

function Delimited({ src }: ViewerProps) {
  const { value, error } = useText(src.url);
  const rows = useMemo(
    () =>
      value === undefined ? undefined : parseDelimited(value, guessSeparator(value, src.format)),
    [value],
  );
  if (error) return <div class="vw-empty">{error}</div>;
  if (!rows) return <div class="vw-empty dim">{t("loading")}</div>;
  return <Grid rows={rows} />;
}

/** Every sheet of a workbook as rows of text, as the program showing it would format them. */
export async function readWorkbook(
  bytes: Uint8Array,
): Promise<{ name: string; rows: string[][] }[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(bytes, { type: "array", cellDates: true, dense: true });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const rows = sheet
      ? (XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          raw: false,
          defval: "",
          blankrows: false,
        }) as unknown[][])
      : [];
    return { name, rows: rows.map((r) => r.map((c) => String(c ?? ""))) };
  });
}

function Workbook({ src }: ViewerProps) {
  const { value, error } = useBytes(src.url);
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>();
  const [failed, setFailed] = useState<string>();
  const [on, setOn] = useState(0);
  useEffect(() => {
    if (value)
      void readWorkbook(value).then(setSheets, (e: unknown) => setFailed((e as Error).message));
  }, [value]);
  if (error || failed) return <div class="vw-empty">{error ?? failed}</div>;
  if (!sheets) return <div class="vw-empty dim">{t("loading")}</div>;
  return (
    <div class="vw-book">
      {sheets.length > 1 && (
        <div class="vw-sheets" role="tablist">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === on}
              class={i === on ? "on" : ""}
              onClick={() => setOn(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <Grid key={on} rows={sheets[on]?.rows ?? []} />
    </div>
  );
}

export function TableView(props: ViewerProps) {
  return props.src.kind === "sheet" ? <Workbook {...props} /> : <Delimited {...props} />;
}
