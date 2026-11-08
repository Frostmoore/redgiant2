// Plain text (G37.1): CodeMirror's own `Text` and `ChangeSet` (`@codemirror/state`, MIT), the
// same code the page's editor runs, so the server holds the true document without a page. Only
// inserting, deleting and replacing for now; G37.2 brings Markdown, JSON/YAML and the agent's
// differences. Line ends and a byte order mark are kept as the file had them.
import { ChangeSet, Text } from "@codemirror/state";
import type { DocOp, DocSummary, TextDocOp } from "@redgiant/protocol";
import { z } from "zod";
import type { DocFamily, FromAgent } from "./family.js";

/** Bigger files are not edited here (the viewer cuts at 2 MB too). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const ENGINE = "codemirror-state" as const;
const ENGINE_VERSION = "6";

/** What plain text means here: names other families will not claim. */
const TEXT_NAMES =
  /\.(txt|text|log|md|markdown|rst|adoc|org|ini|cfg|conf|toml|ya?ml|json|jsonc|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|sql|sh|bash|zsh|fish|ps1|bat|cmd|tex|bib|srt|vtt|gitignore|dockerignore|editorconfig|properties|gradle|makefile|dockerfile)$/i;
const BARE_NAMES = /(^|[\\/])(makefile|dockerfile|readme|license|changelog|notes|todo)$/i;

interface Format {
  sep: "\n" | "\r\n";
  bom: boolean;
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

const CATALOG = `Plain text: operations for canvas_edit (ops: [...], applied one after the other, each on the text the ones before left). Lines are 1-based; offsets count characters from 0.
- {"op": "insert", "text": "...", "line": N}: before line N (N = last line + 1 adds at the end; without line or at, at the end). Or "at": offset. End "text" with a new line to insert whole lines.
- {"op": "delete", "from_line": A, "to_line": B}: whole lines A to B (B defaults to A). Or "from"/"to" offsets, or "find": "exact text" (it must appear once; "all": true for every place).
- {"op": "replace", "text": "...", "find": "exact text"}: that text (once, or "all": true). Or "from_line"/"to_line" (the lines' text without their final new line), or "from"/"to" offsets.
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

export const textFamily: DocFamily<Text> = {
  id: "text",
  engine: ENGINE,
  engineVersion: ENGINE_VERSION,
  accepts: (path) => TEXT_NAMES.test(path) || BARE_NAMES.test(path),

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
    const bom = text.startsWith("﻿");
    if (bom) text = text.slice(1);
    const sep = text.includes("\r\n") ? "\r\n" : "\n";
    return { model: Text.of(text.split(/\r\n|\r|\n/)), format: { sep, bom } satisfies Format };
  },

  save(model, format) {
    const f = (format as Format | undefined) ?? { sep: "\n", bom: false };
    return new TextEncoder().encode(
      `${f.bom ? "﻿" : ""}${model.sliceString(0, model.length, f.sep)}`,
    );
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
    let first: number | undefined;
    let last = 0;
    let doc = model;
    for (const [i, o] of ops.entries()) {
      const c = cs(o);
      c.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        added += inserted.length;
        removed += toA - fromA;
        // Lines of the first operation's text: where the person looks.
        if (i === 0) {
          const l = doc.lineAt(fromA).number;
          first = first === undefined ? l : Math.min(first, l);
          last = Math.max(last, doc.lineAt(toA).number + Math.max(0, inserted.lines - 1));
        }
      });
      doc = c.apply(doc);
    }
    const what: DocSummary["kind"] =
      kind ?? (removed === 0 ? "insert" : added === 0 ? "delete" : "replace");
    const line = first ?? 1;
    const lines = Math.max(1, last - line + 1);
    const verb =
      what === "insert"
        ? `inserted ${plural(added, "character")}`
        : what === "delete"
          ? `deleted ${plural(removed, "character")}`
          : what === "undo"
            ? `undid (${added} written, ${removed} removed)`
            : what === "replaced"
              ? `changed from outside (${added} written, ${removed} removed)`
              : `replaced ${plural(removed, "character")} with ${plural(added, "character")}`;
    return {
      text: `${verb} at line ${line}${lines > 1 ? `-${line + lines - 1}` : ""}`,
      kind: what,
      line,
      lines,
      added,
      removed,
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
