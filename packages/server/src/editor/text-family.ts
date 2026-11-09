// Plain text and code (G37.1, G37.2): CodeMirror's own `Text` and `ChangeSet`
// (`@codemirror/state`, MIT), the same code the page's editor runs, so the server holds the true
// document without a page. Code, Markdown, JSON/YAML/XML and plain text are all this family: the
// page colours them by language and checks the syntax, the host only sees text. A byte order mark
// and the line ends are kept as the file had them, mixed ones too (`endsFor`). Changes are told in
// lines: «changed line 4», «added 3 lines at line 7».
import { ChangeSet, Text } from "@codemirror/state";
import type { DocOp, DocSummary, TextDocOp } from "@redgiant/protocol";
import { z } from "zod";
import type { DocFamily, FromAgent } from "./family.js";

/** Bigger files are not edited here (the viewer cuts at 2 MB too). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const ENGINE = "codemirror-state" as const;
const ENGINE_VERSION = "6";

/**
 * What plain text means here: names other families will not claim. The same extensions the page
 * shows as text, code, Markdown or a tree (`viewers/kind.ts`), so what opens editable there has a
 * family here.
 */
const TEXT_NAMES =
  /\.(txt|text|log|md|markdown|mdx|rst|adoc|org|ini|cfg|conf|env|toml|ya?ml|json|jsonc|json5|geojson|plist|xml|html?|css|scss|sass|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|php|pl|pm|lua|r|sql|sh|bash|zsh|fish|ps1|bat|cmd|tex|bib|srt|vtt|vue|svelte|dart|scala|clj|ex|exs|erl|hs|ml|fs|cmake|tf|hcl|proto|graphql|gql|diff|patch|vim|el|nix|zig|gitignore|dockerignore|editorconfig|properties|gradle|makefile|dockerfile|license|readme)$/i;
const BARE_NAMES = /(^|[\\/])(makefile|dockerfile|readme|license|changelog|notes|todo)$/i;
/**
 * Names with no extension (`hosts`, `Procfile`), dotfiles (`.env`, `.npmrc`) and `.env.local`
 * (p3.5.1): text until their bytes say otherwise (`load` refuses what is not UTF-8 text, and the
 * page shows the viewer instead). The same rule as the page's `bareText` (`viewers/kind.ts`).
 */
const NO_EXTENSION = /(^|[\\/])(\.?[^.\\/]+|\.env(\.[\w-]+)+)$/i;

type End = "\n" | "\r\n" | "\r";

interface Format {
  /** The line end new lines get: the one the file uses most. */
  sep: End;
  bom: boolean;
  /**
   * A file with more than one kind of line end: the text as last loaded or saved and the end after
   * each of its lines, so saving gives every line that is still there the end it had.
   */
  mixed?: { base: Text; ends: End[] };
}

const cs = (op: DocOp): ChangeSet => ChangeSet.fromJSON((op as TextDocOp).op.changes);

function opOf(changes: ChangeSet): TextDocOp {
  const target: [number, number][] = [];
  changes.iterChangedRanges((fromA, toA) => {
    target.push([fromA, toA]);
  });
  return {
    family: "text",
    engine: ENGINE,
    engineVersion: ENGINE_VERSION,
    op: { changes: changes.toJSON() as TextDocOp["op"]["changes"] },
    target,
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// -------------------------------------------------------------------------------------------
// The agent's operations (canvas_edit), in plain words. Lines are 1-based and whole.

const Where = {
  line: z.number().int().positive().optional(),
  from_line: z.number().int().positive().optional(),
  to_line: z.number().int().positive().optional(),
  at: z.number().int().nonnegative().optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  find: z.string().min(1).max(100_000).optional(),
  all: z.boolean().optional(),
};
const AgentOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), text: z.string().max(1_000_000), ...Where }).strict(),
  z.object({ op: z.literal("delete"), ...Where }).strict(),
  z.object({ op: z.literal("replace"), text: z.string().max(1_000_000), ...Where }).strict(),
]);
type AgentOp = z.infer<typeof AgentOp>;

const CATALOG = `Plain text: operations for canvas_edit on text and code (code, Markdown, JSON, YAML, XML, plain text: all edited as text; ops: [...], applied one after the other, each on the text the ones before left). Lines are 1-based; offsets count characters from 0.
- {"op": "insert", "text": "...", "line": N}: before line N (N = last line + 1 adds at the end; without line or at, at the end). Or "at": offset. End "text" with a new line to insert whole lines.
- {"op": "delete", "from_line": A, "to_line": B}: whole lines A to B (B defaults to A). Or "from"/"to" offsets, or "find": "exact text" (it must appear once; "all": true for every place).
- {"op": "replace", "text": "...", "find": "exact text"}: that text (once, or "all": true). Or "from_line"/"to_line" (the lines' text without their final new line), or "from"/"to" offsets.
Keep the file valid yourself: the person's page marks JSON, YAML and XML syntax errors but never blocks a change. Markdown stays Markdown source (the page shows its preview beside it). Each change is told in lines («changed line 4», «added 3 lines at line 7»).
Options of canvas_edit: "dry_run": true shows what would change; "expect_revision": the revision you read (canvas_look view "structure" gives it). Without it the host uses the one you last saw: if the person changed the same place since, the edit is refused and you look again.`;

/** Whole lines A..B as [from, to) of the text, with their final new line (delete) or not. */
function linesRange(doc: Text, a: number, b: number, withBreak: boolean): [number, number] {
  const first = doc.line(a);
  const last = doc.line(b);
  if (!withBreak) return [first.from, last.to];
  if (b < doc.lines) return [first.from, doc.line(b + 1).from];
  // The last lines: the break before them goes instead.
  return [a > 1 ? doc.line(a - 1).to : first.from, last.to];
}

function placesOf(doc: Text, o: AgentOp): [number, number][] | string {
  const len = doc.length;
  if (o.find !== undefined) {
    const text = doc.toString();
    const found: [number, number][] = [];
    for (let i = text.indexOf(o.find); i >= 0; i = text.indexOf(o.find, i + o.find.length)) {
      found.push([i, i + o.find.length]);
      if (found.length > 10_000) break;
    }
    if (found.length === 0) return `"find" text not found: «${o.find.slice(0, 80)}»`;
    if (found.length > 1 && !o.all)
      return `"find" text appears ${found.length} times: give more of it, or "all": true`;
    return found;
  }
  const lineA = o.from_line ?? o.line;
  if (lineA !== undefined) {
    const lineB = o.to_line ?? lineA;
    const max = o.op === "insert" ? doc.lines + 1 : doc.lines;
    if (lineA > max || lineB > doc.lines + (o.op === "insert" ? 1 : 0))
      return `line ${Math.max(lineA, lineB)} is past the end (the text has ${plural(doc.lines, "line")})`;
    if (lineB < lineA) return `to_line ${lineB} is before from_line ${lineA}`;
    if (o.op === "insert") {
      const at = lineA > doc.lines ? len : doc.line(lineA).from;
      return [[at, at]];
    }
    return [linesRange(doc, lineA, lineB, o.op === "delete")];
  }
  if (o.at !== undefined || o.from !== undefined) {
    const from = o.at ?? (o.from as number);
    const to = o.op === "insert" ? from : (o.to ?? from);
    if (from > len || to > len) return `offset ${Math.max(from, to)} is past the end (${len})`;
    if (to < from) return `"to" ${to} is before "from" ${from}`;
    return [[from, to]];
  }
  if (o.op === "insert") return [[len, len]];
  return `say where: "find", "from_line"/"to_line", or "from"/"to"`;
}

/** The text to insert at the end of a document without a final break: whole lines stay whole. */
function textFor(doc: Text, o: AgentOp, at: number): string {
  if (o.op === "delete") return "";
  const t = o.text;
  // Inserting lines after the last one (which has no final break): the break goes first.
  if (
    o.op === "insert" &&
    at === doc.length &&
    at > 0 &&
    t.endsWith("\n") &&
    !doc.sliceString(at - 1, at).includes("\n")
  )
    return `\n${t.slice(0, -1)}`;
  return t;
}

/**
 * The end after each line of `now`, a later version of `base`: lines kept at the start and at the
 * end keep theirs; in between, lines matched with `base` (their longest common run) keep the end
 * they had there, and a changed line takes the end of the line it replaced; new lines get `sep`.
 */
export function endsFor(base: Text, ends: readonly End[], now: Text, sep: End): End[] {
  const m = base.lines;
  const n = now.lines;
  const endOf = (i: number) => (i < m - 1 ? (ends[i] ?? sep) : sep);
  let p = 0;
  while (p < m && p < n && base.line(p + 1).text === now.line(p + 1).text) p++;
  let q = 0;
  while (q < m - p && q < n - p && base.line(m - q).text === now.line(n - q).text) q++;
  const was: string[] = [];
  for (let i = p; i < m - q; i++) was.push(base.line(i + 1).text);
  const is: string[] = [];
  for (let i = p; i < n - q; i++) is.push(now.line(i + 1).text);
  const middle = matchLines(was, is).map((j) => (j === undefined ? sep : endOf(p + j)));
  const out: End[] = [];
  for (let i = 0; i < n - 1; i++)
    out.push(i < p ? endOf(i) : i >= n - q ? endOf(m - (n - i)) : (middle[i - p] ?? sep));
  return out;
}

/**
 * For each line of `is`, the index of the line of `was` it stands for: equal lines along their
 * longest common run, and between two of them the changed lines one to one. Big middles (a whole
 * file rewritten) match equal lines in order instead.
 */
function matchLines(was: readonly string[], is: readonly string[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(is.length).fill(undefined);
  if (was.length * is.length > 4_000_000) {
    const left = new Map<string, number[]>();
    was.forEach((t, j) => {
      const list = left.get(t);
      if (list) list.push(j);
      else left.set(t, [j]);
    });
    is.forEach((t, i) => {
      out[i] = left.get(t)?.shift();
    });
    return out;
  }
  const w = was.length + 1;
  const len = new Uint32Array((is.length + 1) * w);
  for (let i = is.length - 1; i >= 0; i--)
    for (let j = was.length - 1; j >= 0; j--)
      len[i * w + j] =
        is[i] === was[j]
          ? (len[(i + 1) * w + j + 1] as number) + 1
          : Math.max(len[(i + 1) * w + j] as number, len[i * w + j + 1] as number);
  // Walk the run; the lines between two matches are paired in order.
  let i = 0;
  let j = 0;
  let gapI = 0;
  let gapJ = 0;
  const pair = (toI: number, toJ: number) => {
    for (let k = 0; gapI + k < toI && gapJ + k < toJ; k++) out[gapI + k] = gapJ + k;
  };
  while (i < is.length && j < was.length) {
    if (is[i] === was[j]) {
      pair(i, j);
      out[i] = j;
      i++;
      j++;
      gapI = i;
      gapJ = j;
    } else if ((len[(i + 1) * w + j] as number) >= (len[i * w + j + 1] as number)) i++;
    else j++;
  }
  pair(is.length, was.length);
  return out;
}

/** Lines changed, added and removed by one change set on `doc`, and the first line it touches. */
export function lineCounts(
  doc: Text,
  c: ChangeSet,
): {
  changed: number;
  added: number;
  removed: number;
  first?: number | undefined;
  last?: number | undefined;
} {
  // Changes whose lines touch are one region: two edits on one line are one changed line.
  const regions: { l1: number; l2: number; parts: [number, number, string][] }[] = [];
  c.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const l1 = doc.lineAt(fromA).number;
    const l2 = doc.lineAt(toA).number;
    const last = regions.at(-1);
    if (last && l1 <= last.l2) {
      last.l2 = Math.max(last.l2, l2);
      last.parts.push([fromA, toA, inserted.toString()]);
    } else regions.push({ l1, l2, parts: [[fromA, toA, inserted.toString()]] });
  });
  let changed = 0;
  let added = 0;
  let removed = 0;
  let first: number | undefined;
  let last: number | undefined;
  let shift = 0;
  for (const r of regions) {
    const start = doc.line(r.l1).from;
    const end = doc.line(r.l2).to;
    let after = "";
    let at = start;
    for (const [f, t, ins] of r.parts) {
      after += doc.sliceString(at, f) + ins;
      at = t;
    }
    after += doc.sliceString(at, end);
    const was = doc.sliceString(start, end).split("\n");
    const now = after.split("\n");
    let a = 0;
    while (a < was.length && a < now.length && was[a] === now[a]) a++;
    let b = 0;
    while (b < was.length - a && b < now.length - a && was.at(-1 - b) === now.at(-1 - b)) b++;
    const gone = was.length - a - b;
    const come = now.length - a - b;
    const both = Math.min(gone, come);
    changed += both;
    added += come - both;
    removed += gone - both;
    // Lines of the text after the change: where the person looks.
    const from = r.l1 + shift + a;
    first = first === undefined ? from : Math.min(first, from);
    last = Math.max(last ?? from, from + Math.max(come, 1) - 1);
    shift += now.length - was.length;
  }
  return { changed, added, removed, ...(first !== undefined && { first, last }) };
}

/** «changed 2 lines and added 3 lines», or undefined when no whole line moved. */
function linesText(n: { changed: number; added: number; removed: number }): string | undefined {
  const parts = [
    n.changed && `changed ${plural(n.changed, "line")}`,
    n.added && `added ${plural(n.added, "line")}`,
    n.removed && `removed ${plural(n.removed, "line")}`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const textFamily: DocFamily<Text> = {
  id: "text",
  engine: ENGINE,
  engineVersion: ENGINE_VERSION,
  accepts: (path) => TEXT_NAMES.test(path) || BARE_NAMES.test(path) || NO_EXTENSION.test(path),

  load(bytes) {
    if (bytes.length > MAX_TEXT_BYTES)
      throw new Error(`The file is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error("The file is not UTF-8 text");
    }
    if (text.includes("\u0000")) throw new Error("The file holds binary data");
    const bom = text.startsWith("\uFEFF");
    if (bom) text = text.slice(1);
    const ends = (text.match(/\r\n|\r|\n/g) ?? []) as End[];
    const count = { "\n": 0, "\r\n": 0, "\r": 0 };
    for (const e of ends) count[e]++;
    const sep = (Object.keys(count) as End[]).reduce((a, b) => (count[b] > count[a] ? b : a), "\n");
    const model = Text.of(text.split(/\r\n|\r|\n/));
    const kinds = Object.values(count).filter((n) => n > 0).length;
    const format: Format = { sep, bom, ...(kinds > 1 && { mixed: { base: model, ends } }) };
    return { model, format };
  },

  save(model, format) {
    const f = (format as Format | undefined) ?? { sep: "\n", bom: false };
    let body: string;
    if (f.mixed) {
      const ends = endsFor(f.mixed.base, f.mixed.ends, model, f.sep);
      const out: string[] = [];
      for (let i = 1; i <= model.lines; i++) out.push(model.line(i).text, ends[i - 1] ?? "");
      body = out.join("");
      // What the file is now: the next save compares with it.
      f.mixed = { base: model, ends };
    } else body = model.sliceString(0, model.length, f.sep);
    return new TextEncoder().encode(`${f.bom ? "\uFEFF" : ""}${body}`);
  },

  snapshot: (model) => ({ family: "text", text: model.toString() }),

  check(model, op) {
    if (op.family !== "text") return `a ${op.family} operation on a text`;
    try {
      const c = cs(op);
      if (c.length !== model.length)
        return `the operation is for a text of ${c.length} characters, this one has ${model.length}`;
    } catch (err) {
      return `not a change set: ${(err as Error).message}`;
    }
    return undefined;
  },

  apply: (model, op) => cs(op).apply(model),
  invert: (model, op) => opOf(cs(op).invert(model)),

  compose(ops) {
    if (ops.length === 0) return undefined;
    let c = cs(ops[0] as DocOp);
    for (const o of ops.slice(1)) c = c.compose(cs(o));
    return opOf(c);
  },

  conflicts(a, b) {
    const later = cs(b);
    let hit = false;
    cs(a).iterChangedRanges((fromA, toA) => {
      if (!hit && later.touchesRange(fromA, toA)) hit = true;
    });
    return hit;
  },

  // The op that came later goes first where both insert at one point (as the page maps it).
  map: (a, b) => opOf(cs(a).map(cs(b), true)),

  touches: (op, from, to) => cs(op).touchesRange(from, to) !== false,
  mapPos: (op, pos, assoc) => cs(op).mapPos(pos, assoc),
  lineOf: (model, pos) => model.lineAt(Math.max(0, Math.min(pos, model.length))).number,

  diff(before, after, maxBytes) {
    const a = before.toString();
    const b = after.toString();
    if (a === b) return undefined;
    let start = 0;
    const min = Math.min(a.length, b.length);
    while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
      endA--;
      endB--;
    }
    if (endA - start + (endB - start) > maxBytes) return undefined;
    return opOf(ChangeSet.of({ from: start, to: endA, insert: b.slice(start, endB) }, a.length));
  },

  summarize(model, ops, kind) {
    let added = 0;
    let removed = 0;
    const lines = { changed: 0, added: 0, removed: 0 };
    let first: number | undefined;
    let last = 0;
    let doc = model;
    for (const [i, o] of ops.entries()) {
      const c = cs(o);
      c.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        added += inserted.length;
        removed += toA - fromA;
      });
      const n = lineCounts(doc, c);
      lines.changed += n.changed;
      lines.added += n.added;
      lines.removed += n.removed;
      // Lines of the first operation's text: where the person looks.
      if (i === 0 && n.first !== undefined) {
        first = n.first;
        last = n.last ?? n.first;
      }
      doc = c.apply(doc);
    }
    const what: DocSummary["kind"] =
      kind ??
      (ops.length > 1
        ? "edit"
        : lines.changed === 0 && lines.removed === 0 && lines.added > 0
          ? "insert"
          : lines.changed === 0 && lines.added === 0 && lines.removed > 0
            ? "delete"
            : "replace");
    const line = first ?? 1;
    const span = Math.max(1, last - line + 1);
    const said = linesText(lines) ?? "changed nothing visible";
    const at =
      what === "delete"
        ? `from line ${line}`
        : `at line ${line}${span > 1 ? `-${line + span - 1}` : ""}`;
    const onlyChanged = lines.changed > 0 && lines.added === 0 && lines.removed === 0;
    const text =
      onlyChanged && (what === "replace" || what === "insert" || what === "delete")
        ? span > 1
          ? `changed lines ${line}-${line + span - 1}`
          : `changed line ${line}`
        : what === "undo"
          ? `undid a change (${said}) ${at}`
          : what === "replaced"
            ? `changed from outside (${said}) ${at}`
            : what === "edit"
              ? `made ${ops.length} changes from line ${line} (${said})`
              : `${said} ${at}`;
    return {
      text,
      kind: what,
      line,
      lines: span,
      added,
      removed,
      linesChanged: lines.changed,
      linesAdded: lines.added,
      linesRemoved: lines.removed,
      ...(ops.length > 1 && { count: ops.length }),
    };
  },

  wrote(ops) {
    let ranges: [number, number][] = [];
    for (const o of ops) {
      const c = cs(o);
      ranges = ranges
        .map(([f, t]): [number, number] => [c.mapPos(f, 1), c.mapPos(t, -1)])
        .filter(([f, t]) => t > f);
      c.iterChanges((_fa, _ta, fromB, toB) => {
        if (toB > fromB) ranges.push([fromB, toB]);
      });
    }
    return ranges.sort((x, y) => x[0] - y[0]).slice(0, 1000);
  },

  fromAgent(model, raw): FromAgent {
    const ops: DocOp[] = [];
    let doc = model;
    for (const [index, r] of raw.entries()) {
      const parsed = AgentOp.safeParse(r);
      if (!parsed.success)
        return {
          index,
          error: `not an operation of plain text (${parsed.error.issues
            .map((i) => `${i.path.join(".") || "op"}: ${i.message}`)
            .join("; ")}); call canvas_edit with "help": true for the list`,
        };
      const o = parsed.data;
      const places = placesOf(doc, o);
      if (typeof places === "string") return { index, error: places };
      const changes = ChangeSet.of(
        places.map(([from, to]) => ({ from, to, insert: textFor(doc, o, from) })),
        doc.length,
      );
      if (changes.empty) continue;
      ops.push(opOf(changes));
      doc = changes.apply(doc);
    }
    if (ops.length === 0) return { error: "nothing to change: the operations change no text" };
    return { ops };
  },

  catalog: () => CATALOG,

  structure(model, ask) {
    const total = model.lines;
    const from = Math.max(1, Math.min(ask.fromLine ?? 1, total));
    const to = Math.min(total, ask.toLine ?? from + 399, from + 999);
    const width = String(to).length;
    const out: string[] = [];
    let bytes = 0;
    let shown = from - 1;
    for (let n = from; n <= to; n++) {
      const text = model.line(n).text;
      const line = `${String(n).padStart(width)}| ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`;
      bytes += line.length;
      if (bytes > 60_000) break;
      out.push(line);
      shown = n;
    }
    return `Plain text, ${plural(total, "line")}, ${plural(model.length, "character")}. Lines ${from}-${shown}${shown < total ? ` (more: from_line ${shown + 1})` : ""}:\n${out.join("\n")}`;
  },
};
