// Cutting a read document into pieces (G36.3): the parts the reader found (sections, symbols,
// pages) are kept whole when they fit, long ones split on paragraph, line or sentence
// boundaries with a little overlap, and small neighbours joined while they share a page and,
// for code and Markdown, the section above them. Every piece keeps its page and lines.

import { createHash } from "node:crypto";
import type { Chunk, ChunkOptions, Extracted, ExtractedPart } from "./types.js";

const DEFAULTS = { target: 1200, max: 1800, overlap: 150 };

/** A piece being built: text with its place. */
interface Piece {
  text: string;
  heading?: string | undefined;
  page?: number | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

export function chunkDocument(doc: Extracted, o: ChunkOptions = {}): Chunk[] {
  const max = Math.max(200, o.max ?? DEFAULTS.max);
  const target = Math.min(max, Math.max(100, o.target ?? DEFAULTS.target));
  const overlap = Math.min(Math.floor(target / 3), Math.max(0, o.overlap ?? DEFAULTS.overlap));
  const split: Piece[] = [];
  for (const part of doc.parts) {
    if (!part.text.trim()) continue;
    for (const p of splitPart(part, target, max, overlap)) split.push(p);
  }
  const sectioned = doc.kind === "markdown" || doc.kind === "code";
  const merged = mergeSmall(split, target, sectioned);
  return merged.map((p, ord) => {
    const c: Chunk = { ord, text: p.text, hash: sha256(p.text) };
    if (p.heading) c.heading = p.heading;
    if (p.page !== undefined) c.page = p.page;
    if (p.lineStart !== undefined) c.lineStart = p.lineStart;
    if (p.lineEnd !== undefined) c.lineEnd = p.lineEnd;
    return c;
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The section a heading path sits in (`A › B › C` → `A`), for joining neighbours. */
function topSection(heading: string | undefined): string {
  return (heading ?? "").split(" › ")[0] ?? "";
}

function mergeSmall(pieces: Piece[], target: number, sectioned: boolean): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out.at(-1);
    if (
      last &&
      last.page === p.page &&
      last.text.length + 2 + p.text.length <= target &&
      (!sectioned || topSection(last.heading) === topSection(p.heading)) &&
      // Lines must follow each other (pieces cut with overlap are never joined back).
      (last.lineEnd === undefined || p.lineStart === undefined || p.lineStart > last.lineEnd)
    ) {
      last.text = `${last.text}\n\n${p.text}`;
      last.heading = joinHeadings(last.heading, p.heading);
      if (p.lineStart !== undefined && last.lineStart === undefined) last.lineStart = p.lineStart;
      if (p.lineEnd !== undefined) last.lineEnd = p.lineEnd;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

function joinHeadings(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b || a === b) return a;
  // A piece of a symbol joined to the symbol: the shorter name says it.
  if (b.startsWith(`${a} › `)) return a;
  if (a.startsWith(`${b} › `)) return b;
  // Joined pieces list their sections; the citation shows the first ones.
  const names = a.split(" · ");
  if (names.includes(b)) return a;
  const joined = `${a} · ${b}`;
  return joined.length > 200 ? a : joined;
}

/** A long part cut into pieces no longer than `max`, aimed at `target`. */
function splitPart(part: ExtractedPart, target: number, max: number, overlap: number): Piece[] {
  const base: Piece = {
    text: part.text.trim(),
    heading: part.heading,
    page: part.page,
    lineStart: part.lineStart,
    lineEnd: part.lineEnd,
  };
  if (base.text.length <= max) return [trimLines(part)];
  // Work on the original lines, so every piece knows where it starts and ends.
  const lines = part.text.split("\n");
  const first = part.lineStart;
  const units = toUnits(lines, max);
  const pieces: Piece[] = [];
  let cur: Unit[] = [];
  let size = 0;
  const flush = () => {
    if (!cur.length) return;
    const text = cur
      .map((u) => u.text)
      .join("\n")
      .trim();
    if (text) {
      const p: Piece = { text, heading: part.heading, page: part.page };
      if (first !== undefined) {
        p.lineStart = first + (cur[0] as Unit).line;
        p.lineEnd = first + (cur.at(-1) as Unit).line;
      }
      pieces.push(p);
    }
  };
  for (let i = 0; i < units.length; i++) {
    const u = units[i] as Unit;
    const add = u.text.length + (cur.length ? 1 : 0);
    if (cur.length && size + add > target) {
      // Prefer to end at a blank line if one is near the end of what was gathered.
      let cut = cur.length;
      for (let k = cur.length - 1; k >= Math.floor(cur.length / 2); k--) {
        if (!(cur[k] as Unit).text.trim()) {
          cut = k;
          break;
        }
      }
      const rest = cur.slice(cut);
      cur = cur.slice(0, cut);
      flush();
      const tail = overlapOf(cur, overlap);
      cur = [...tail, ...rest];
      size = cur.reduce((n, x) => n + x.text.length + 1, 0);
      // The overlap alone must leave room: drop it when the next unit would not fit.
      if (size + add > max) {
        cur = [...rest];
        size = cur.reduce((n, x) => n + x.text.length + 1, 0);
      }
    }
    cur.push(u);
    size += add;
  }
  flush();
  return pieces.filter((p) => p.text.length > 0);
}

/** A line, or a slice of a line too long to keep whole; `line` is its index in the part. */
interface Unit {
  text: string;
  line: number;
}

function toUnits(lines: string[], max: number): Unit[] {
  const out: Unit[] = [];
  const room = Math.floor(max * 0.8);
  lines.forEach((text, line) => {
    if (text.length <= room) {
      out.push({ text, line });
      return;
    }
    for (const s of splitLong(text, room)) out.push({ text: s, line });
  });
  return out;
}

/** A long line cut at sentence ends, then at spaces, then anywhere. */
function splitLong(text: string, room: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > room) {
    const window = rest.slice(0, room);
    let cut = -1;
    const sentence = /[.!?;。！？](\s|$)/g;
    for (let m = sentence.exec(window); m; m = sentence.exec(window))
      if (m.index > room / 2) cut = m.index + 1;
    if (cut < 0) {
      const space = window.lastIndexOf(" ");
      cut = space > room / 2 ? space : room;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) out.push(rest);
  return out.filter(Boolean);
}

/** The last units of a piece, up to `overlap` characters, repeated at the start of the next. */
function overlapOf(units: Unit[], overlap: number): Unit[] {
  if (overlap <= 0 || !units.length) return [];
  const out: Unit[] = [];
  let size = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i] as Unit;
    if (!u.text.trim()) {
      if (out.length) break;
      continue;
    }
    if (size + u.text.length > overlap) {
      if (!out.length) {
        // One long last line: its end, from a word boundary.
        const tail = u.text.slice(-overlap);
        const space = tail.indexOf(" ");
        out.unshift({ text: space > 0 ? tail.slice(space + 1) : tail, line: u.line });
      }
      break;
    }
    out.unshift(u);
    size += u.text.length + 1;
  }
  return out;
}

/** A part that fits, without its leading and trailing blank lines (lines moved to match). */
function trimLines(part: ExtractedPart): Piece {
  const lines = part.text.split("\n");
  let a = 0;
  let b = lines.length - 1;
  while (a < b && !(lines[a] as string).trim()) a++;
  while (b > a && !(lines[b] as string).trim()) b--;
  const p: Piece = {
    text: lines
      .slice(a, b + 1)
      .join("\n")
      .trim(),
    heading: part.heading,
    page: part.page,
  };
  if (part.lineStart !== undefined) {
    p.lineStart = part.lineStart + a;
    p.lineEnd = part.lineEnd ?? part.lineStart + b;
    if (part.lineEnd !== undefined) p.lineEnd = Math.min(part.lineEnd, part.lineStart + b);
  }
  return p;
}
