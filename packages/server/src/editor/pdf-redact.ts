// Redaction (G37.8): what is under an area of a page is taken out of the file for good, then the
// area is blacked. Covering is not redacting: the page's content is read operator by operator and
// rewritten without the glyphs, pictures and small drawings under the areas (the glyphs after them
// keep their places: a removed run becomes a TJ gap of its width), annotations there go, the alt
// texts of the marked content that lost glyphs go, the page's thumbnail goes; the file is then
// written anew and what nothing points to anymore is dropped (pdf-write.ts). pdf.js, a different
// reader, then checks the result (`verifyRedaction`): no text and no picture left under the areas,
// or the redaction is refused. When a font's measures are unknown the whole run that may reach the
// area is taken out; when something cannot be read (a filter, vertical writing, a form field under
// the area) the redaction is refused: better nothing than a fake one.
import { Encodings, type FontNames, Font as StandardFont } from "@pdf-lib/standard-fonts";
import type { PdfRect } from "@redgiant/protocol";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";
import { rectOf } from "./pdf-outline.js";

export class RedactError extends Error {}

type M = [number, number, number, number, number, number];
const ID: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];
const at = (m: M, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
/** The box of a rectangle of a space, in the space `m` maps it to. */
function boxOf(m: M, x1: number, y1: number, x2: number, y2: number): PdfRect {
  const p = [at(m, x1, y1), at(m, x2, y1), at(m, x1, y2), at(m, x2, y2)];
  return [
    Math.min(...p.map((q) => q[0])),
    Math.min(...p.map((q) => q[1])),
    Math.max(...p.map((q) => q[0])),
    Math.max(...p.map((q) => q[1])),
  ];
}
const hits = (b: PdfRect, rects: readonly PdfRect[]) =>
  rects.some((r) => b[0] < r[2] && r[0] < b[2] && b[1] < r[3] && r[1] < b[3]);
/** A glyph that touches an area, even on its edge, goes (p3.5.4). */
const touches = (b: PdfRect, rects: readonly PdfRect[]) =>
  rects.some((r) => b[0] <= r[2] && r[0] <= b[2] && b[1] <= r[3] && r[1] <= b[3]);
const area = (r: PdfRect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inside = (b: PdfRect, r: PdfRect, d: number) =>
  b[0] >= r[0] - d && b[1] >= r[1] - d && b[2] <= r[2] + d && b[3] <= r[3] + d;

// ---- reading a content stream ------------------------------------------------------------------

type Tok =
  | { k: "num"; v: number; raw: string }
  | { k: "name"; v: string; raw: string }
  | { k: "str"; b: number[]; raw: string }
  | { k: "arr"; items: Tok[]; raw: string }
  | { k: "dict"; entries: [string, Tok][]; raw: string }
  | { k: "kw"; v: string; raw: string };

interface Op {
  args: Tok[];
  op: string;
  raw: string;
  /** An inline image's dictionary. */
  inline?: [string, Tok][];
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

/** A content stream as operators with their operands (a small lexer for ISO 32000 §7.2). */
export function parseContent(s: string): Op[] {
  let i = 0;
  const n = s.length;
  const code = (k: number) => s.charCodeAt(k);
  const skip = () => {
    while (i < n) {
      const c = code(i);
      if (WS.has(c)) i++;
      else if (c === 37) while (i < n && code(i) !== 10 && code(i) !== 13) i++;
      else break;
    }
  };
  const literal = (): number[] => {
    // At "(": a string with nested parentheses and escapes.
    const out: number[] = [];
    let depth = 1;
    i++;
    while (i < n) {
      const c = code(i++);
      if (c === 92) {
        const e = s[i++];
        if (e === undefined) break;
        const map: Record<string, number> = {
          n: 10,
          r: 13,
          t: 9,
          b: 8,
          f: 12,
          "(": 40,
          ")": 41,
          "\\": 92,
        };
        if (map[e] !== undefined) out.push(map[e] as number);
        else if (/[0-7]/.test(e)) {
          let o = e;
          while (o.length < 3 && /[0-7]/.test(s[i] ?? "")) o += s[i++];
          out.push(Number.parseInt(o, 8) & 255);
        } else if (e === "\r") {
          if (s[i] === "\n") i++;
        } else if (e !== "\n") out.push(e.charCodeAt(0));
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c & 255);
    }
    return out;
  };
  const token = (): Tok | undefined => {
    skip();
    if (i >= n) return undefined;
    const start = i;
    const c = s[i] as string;
    if (c === "[") {
      i++;
      const items: Tok[] = [];
      for (;;) {
        skip();
        if (i >= n) throw new RedactError("an array of the page's content does not end");
        if (s[i] === "]") {
          i++;
          break;
        }
        const t = token();
        if (!t) break;
        items.push(t);
      }
      return { k: "arr", items, raw: s.slice(start, i) };
    }
    if (c === "<" && s[i + 1] === "<") {
      i += 2;
      const entries: [string, Tok][] = [];
      for (;;) {
        skip();
        if (i >= n) throw new RedactError("a dictionary of the page's content does not end");
        if (s[i] === ">" && s[i + 1] === ">") {
          i += 2;
          break;
        }
        const key = token();
        const val = token();
        if (!key || !val) break;
        if (key.k === "name") entries.push([key.v, val]);
      }
      return { k: "dict", entries, raw: s.slice(start, i) };
    }
    if (c === "(") {
      const b = literal();
      return { k: "str", b, raw: s.slice(start, i) };
    }
    if (c === "<") {
      const end = s.indexOf(">", i);
      if (end < 0) throw new RedactError("a string of the page's content does not end");
      let hex = s.slice(i + 1, end).replace(/\s+/g, "");
      if (hex.length % 2) hex += "0";
      i = end + 1;
      const b: number[] = [];
      for (let k = 0; k < hex.length; k += 2) b.push(Number.parseInt(hex.slice(k, k + 2), 16) || 0);
      return { k: "str", b, raw: s.slice(start, i) };
    }
    if (c === "/") {
      i++;
      while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
      const v = s
        .slice(start + 1, i)
        .replace(/#([0-9a-fA-F]{2})/g, (_, h: string) =>
          String.fromCharCode(Number.parseInt(h, 16)),
        );
      return { k: "name", v, raw: s.slice(start, i) };
    }
    if (c === ")" || c === ">" || c === "]" || c === "{" || c === "}") {
      i++;
      return { k: "kw", v: c, raw: c };
    }
    while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
    const raw = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { k: "num", v: Number(raw), raw };
    return { k: "kw", v: raw, raw };
  };
  const ops: Op[] = [];
  let args: Tok[] = [];
  let argStart = -1;
  for (;;) {
    skip();
    if (i >= n) break;
    const before = i;
    const t = token();
    if (!t) break;
    if (argStart < 0) argStart = before;
    if (t.k !== "kw" || t.v === "true" || t.v === "false" || t.v === "null") {
      args.push(t);
      continue;
    }
    if (t.v === "BI") {
      // An inline image: its dictionary up to ID, its data up to EI.
      const entries: [string, Tok][] = [];
      for (;;) {
        const key = token();
        if (!key) throw new RedactError("an inline picture of the page does not end");
        if (key.k === "kw" && key.v === "ID") break;
        const val = token();
        if (key.k === "name" && val) entries.push([key.v, val]);
      }
      i++; // the one white space after ID
      const m = /[\s\0]EI(?=[\s\0]|$)/g;
      m.lastIndex = i;
      const found = m.exec(s);
      if (!found) throw new RedactError("an inline picture of the page does not end");
      i = found.index + found[0].length;
      ops.push({ args, op: "BI", raw: s.slice(argStart, i), inline: entries });
    } else ops.push({ args, op: t.v, raw: s.slice(argStart, i) });
    args = [];
    argStart = -1;
  }
  return ops;
}

// ---- fonts -------------------------------------------------------------------------------------

interface FontInfo {
  /** Bytes per code: 1, 2, or 0 when unknown (the run is taken as a whole). */
  bytes: 0 | 1 | 2;
  /** The width of a code, in thousandths of the text size; undefined when unknown. */
  width(code: number): number | undefined;
  /** Above and below the baseline, in text size. */
  asc: number;
  desc: number;
  /** A glyph's width in glyph space is multiplied by this (1/1000, or a Type 3's matrix). */
  scale: number;
}

const STANDARD: Record<string, string> = {
  Courier: "Courier",
  "Courier-Bold": "Courier-Bold",
  "Courier-Oblique": "Courier-Oblique",
  "Courier-BoldOblique": "Courier-BoldOblique",
  Helvetica: "Helvetica",
  "Helvetica-Bold": "Helvetica-Bold",
  "Helvetica-Oblique": "Helvetica-Oblique",
  "Helvetica-BoldOblique": "Helvetica-BoldOblique",
  "Times-Roman": "Times-Roman",
  "Times-Bold": "Times-Bold",
  "Times-Italic": "Times-Italic",
  "Times-BoldItalic": "Times-BoldItalic",
  Symbol: "Symbol",
  ZapfDingbats: "ZapfDingbats",
};
let winAnsiNames: Map<number, string> | undefined;
function winAnsi(): Map<number, string> {
  if (winAnsiNames) return winAnsiNames;
  winAnsiNames = new Map();
  const um = (Encodings.WinAnsi as unknown as { unicodeMappings: Record<number, [number, string]> })
    .unicodeMappings;
  for (const [, [c, name]] of Object.entries(um)) winAnsiNames.set(c, name);
  return winAnsiNames;
}

const numOf = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : undefined);

function fontInfo(doc: PDFDocument, dict: PDFDict): FontInfo {
  const ctx = doc.context;
  const get = (d: PDFDict, k: string) => d.get(PDFName.of(k));
  const name = (d: PDFDict, k: string) => {
    const v = ctx.lookup(get(d, k));
    return v instanceof PDFName ? v.decodeText() : undefined;
  };
  const subtype = name(dict, "Subtype");
  const descr = (d: PDFDict) => ctx.lookupMaybe(get(d, "FontDescriptor"), PDFDict);
  const extents = (d: PDFDict | undefined) => {
    const a = d ? numOf(ctx.lookup(get(d, "Ascent"))) : undefined;
    const ds = d ? numOf(ctx.lookup(get(d, "Descent"))) : undefined;
    // Never less than what the check counts (0.85 above, 0.15 below the baseline).
    return {
      asc: Math.max(0.9, a !== undefined && a > 0 ? Math.min(a / 1000, 1.1) : 0),
      desc: Math.min(-0.2, ds !== undefined && ds < 0 ? Math.max(ds / 1000, -0.35) : 0),
    };
  };
  if (subtype === "Type0") {
    const enc = name(dict, "Encoding");
    const kids = ctx.lookupMaybe(get(dict, "DescendantFonts"), PDFArray);
    const cid = kids ? ctx.lookupMaybe(kids.get(0), PDFDict) : undefined;
    const ext = extents(cid ? descr(cid) : undefined);
    if (enc !== "Identity-H" || !cid)
      // Another CMap, or vertical writing: the codes cannot be told apart.
      return { bytes: 0, width: () => undefined, ...ext, scale: 1 / 1000 };
    const dw = numOf(ctx.lookup(get(cid, "DW"))) ?? 1000;
    const widths = new Map<number, number>();
    const w = ctx.lookupMaybe(get(cid, "W"), PDFArray);
    if (w) {
      const items = w.asArray().map((x) => ctx.lookup(x));
      for (let k = 0; k < items.length; ) {
        const first = numOf(items[k] as PDFObject);
        const next = items[k + 1];
        if (first === undefined) break;
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => {
            const v = numOf(ctx.lookup(x));
            if (v !== undefined) widths.set(first + j, v);
          });
          k += 2;
        } else {
          const last = numOf(next as PDFObject);
          const v = numOf(items[k + 2] as PDFObject);
          if (last === undefined || v === undefined) break;
          for (let c = first; c <= last && c - first < 70_000; c++) widths.set(c, v);
          k += 3;
        }
      }
    }
    return { bytes: 2, width: (c) => widths.get(c) ?? dw, ...ext, scale: 1 / 1000 };
  }
  const fd = descr(dict);
  const ext = extents(fd);
  const widthsArr = ctx.lookupMaybe(get(dict, "Widths"), PDFArray);
  if (subtype === "Type3") {
    const fm = ctx.lookupMaybe(get(dict, "FontMatrix"), PDFArray);
    const sx = fm ? (numOf(ctx.lookup(fm.get(0))) ?? 0.001) : 0.001;
    const first = numOf(ctx.lookup(get(dict, "FirstChar"))) ?? 0;
    const ws = widthsArr?.asArray().map((x) => numOf(ctx.lookup(x)));
    return {
      bytes: 1,
      width: (c) => (ws ? ws[c - first] : undefined),
      asc: 1.2,
      desc: -0.4,
      scale: sx,
    };
  }
  if (widthsArr) {
    const first = numOf(ctx.lookup(get(dict, "FirstChar"))) ?? 0;
    const ws = widthsArr.asArray().map((x) => numOf(ctx.lookup(x)));
    const missing = fd ? (numOf(ctx.lookup(get(fd, "MissingWidth"))) ?? 0) : 0;
    return { bytes: 1, width: (c) => ws[c - first] ?? missing, ...ext, scale: 1 / 1000 };
  }
  // A standard font without widths: Adobe's metrics, through its encoding.
  const base = (name(dict, "BaseFont") ?? "").replace(/^[A-Z]{6}\+/, "");
  const std = STANDARD[base];
  if (std) {
    const metrics = StandardFont.load(std as FontNames);
    const names = new Map(winAnsi());
    const enc = ctx.lookup(get(dict, "Encoding"));
    if (enc instanceof PDFDict) {
      const diffs = ctx.lookupMaybe(enc.get(PDFName.of("Differences")), PDFArray);
      let c = 0;
      for (const x of diffs?.asArray() ?? []) {
        const v = ctx.lookup(x);
        if (v instanceof PDFNumber) c = v.asNumber();
        else if (v instanceof PDFName) names.set(c++, v.decodeText());
      }
    }
    const symbolic = std === "Symbol" || std === "ZapfDingbats";
    return {
      bytes: 1,
      width: (c) => {
        if (symbolic) return undefined;
        const g = names.get(c);
        if (!g) return undefined;
        const w = metrics.getWidthOfGlyph(g);
        return typeof w === "number" ? w : undefined;
      },
      asc: Math.max(0.9, Math.min((metrics.Ascender ?? 800) / 1000, 1.1)),
      desc: Math.min(-0.2, Math.max((metrics.Descender ?? -200) / 1000, -0.35)),
      scale: 1 / 1000,
    };
  }
  return { bytes: 1, width: () => undefined, ...ext, scale: 1 / 1000 };
}

// ---- the page's content rewritten -------------------------------------------------------------

export interface RedactReport {
  glyphs: number;
  runs: number;
  images: number;
  paths: number;
  annots: number;
}

interface Gs {
  ctm: M;
  font?: FontInfo | undefined;
  fs: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  ts: number;
}

const hexOf = (b: number[]) => `<${b.map((x) => x.toString(16).padStart(2, "0")).join("")}>`;
const fmt = (x: number) => (Math.round(x * 1000) / 1000).toString();

function decodeStream(doc: PDFDocument, s: PDFObject | undefined): string {
  if (!(s instanceof PDFStream)) throw new RedactError("the page's content cannot be read");
  let bytes: Uint8Array;
  if (s instanceof PDFRawStream) {
    try {
      bytes = decodePDFRawStream(s).decode();
    } catch {
      throw new RedactError("the page's content uses a compression this editor cannot read");
    }
  } else bytes = s.getContents();
  void doc;
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return out;
}

const latinBytes = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
};

interface Run {
  doc: PDFDocument;
  rects: readonly PdfRect[];
  report: RedactReport;
  /** Marked-content ids that lost glyphs (their alt texts go too). */
  mcids: Set<number>;
  fonts: Map<PDFDict, FontInfo>;
  /** How many new forms were made (their names stay unique). */
  made: number;
  depth: number;
}

/** The names a content stream draws with `Do`. */
function drawn(content: string): Set<string> {
  const out = new Set<string>();
  for (const o of parseContent(content))
    if (o.op === "Do" && o.args[0]?.k === "name") out.add(o.args[0].v);
  return out;
}

/**
 * Resources of their own for a rewritten content: only the pictures and forms it still draws, and
 * the new forms. A picture or a form taken out would otherwise stay in the file, named there.
 */
function ownResources(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  content: string,
  added: Map<string, PDFRef>,
): PDFDict {
  const ctx = doc.context;
  const own = resources ? resources.clone(ctx) : ctx.obj({});
  const xo = ctx.lookupMaybe(own.get(PDFName.of("XObject")), PDFDict);
  const used = drawn(content);
  const keep = ctx.obj({});
  if (xo) for (const [k, v] of xo.entries()) if (used.has(k.decodeText())) keep.set(k, v);
  for (const [name, ref] of added) keep.set(PDFName.of(name), ref);
  own.set(PDFName.of("XObject"), keep);
  return own;
}

/** A content stream with what is under the areas taken out; `changed` when something was. */
function rewrite(
  run: Run,
  content: string,
  resources: PDFDict | undefined,
  start: M,
): { content: string; changed: boolean; added: Map<string, PDFRef> } {
  const ctx = run.doc.context;
  const ops = parseContent(content);
  /** Forms made for this content: their names in its own resources. */
  const added = new Map<string, PDFRef>();
  const out: string[] = [];
  let changed = false;
  let gs: Gs = { ctm: start, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0 };
  const stack: Gs[] = [];
  let tm: M = ID;
  let tlm: M = ID;
  let path: PdfRect | undefined;
  const marks: { index: number; touched: boolean; mcid?: number }[] = [];
  const res = (kind: string) =>
    resources ? ctx.lookupMaybe(resources.get(PDFName.of(kind)), PDFDict) : undefined;
  const grow = (x: number, y: number) => {
    const [px, py] = at(gs.ctm, x, y);
    path = path
      ? [Math.min(path[0], px), Math.min(path[1], py), Math.max(path[2], px), Math.max(path[3], py)]
      : [px, py, px, py];
  };
  const totalArea = run.rects.reduce((s, r) => s + area(r), 0);
  const touched = () => {
    for (const m of marks) m.touched = true;
  };
  const nums = (o: Op) => o.args.map((a) => (a.k === "num" ? a.v : Number.NaN));

  /** A string shown: the glyphs under the areas out, the rest in their places. */
  const show = (bytes: number[]): { parts: (number[] | number)[]; removed: boolean } | "whole" => {
    const f = gs.font;
    const fs = gs.fs;
    const th = gs.th;
    const parts: (number[] | number)[] = [];
    let removed = false;
    const advance = (tx: number) => {
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    };
    if (!f || f.bytes === 0) {
      // Unknown measures: the run may reach anything up to a generous width.
      const n = f?.bytes === 0 ? bytes.length : bytes.length;
      const w = n * 1.1 * fs * th + Math.abs(gs.tc) * n * th + Math.abs(gs.tw) * n * th;
      const trm = mul([1, 0, 0, 1, 0, gs.ts], mul(tm, gs.ctm));
      const env = boxOf(trm, -0.1 * fs, -0.5 * fs, w, 1.5 * fs);
      if (touches(env, run.rects)) {
        run.report.glyphs += bytes.length;
        return "whole";
      }
      advance(w);
      parts.push(bytes);
      return { parts, removed: false };
    }
    let kept: number[] = [];
    let gap = 0;
    const flushKept = () => {
      if (kept.length) parts.push(kept);
      kept = [];
    };
    for (let k = 0; k < bytes.length; k += f.bytes) {
      const codeBytes = bytes.slice(k, k + f.bytes);
      const code =
        f.bytes === 2 ? ((codeBytes[0] ?? 0) << 8) | (codeBytes[1] ?? 0) : (codeBytes[0] ?? 0);
      const w = f.width(code);
      if (w === undefined) return "whole";
      const w0 = w * f.scale;
      const trm = mul([fs * th, 0, 0, fs, 0, gs.ts], mul(tm, gs.ctm));
      const box = boxOf(trm, 0, f.desc, Math.max(w0, 0.001), f.asc);
      const tx = (w0 * fs + gs.tc + (f.bytes === 1 && code === 32 ? gs.tw : 0)) * th;
      if (touches(box, run.rects)) {
        flushKept();
        gap += tx;
        removed = true;
        run.report.glyphs++;
      } else {
        if (gap) {
          if (fs * th === 0) throw new RedactError("a text of size 0 cannot be redacted");
          parts.push((-gap * 1000) / (fs * th));
          gap = 0;
        }
        kept.push(...codeBytes);
      }
      advance(tx);
    }
    flushKept();
    if (gap) {
      if (fs * th === 0) throw new RedactError("a text of size 0 cannot be redacted");
      parts.push((-gap * 1000) / (fs * th));
    }
    return { parts, removed };
  };
  const tj = (parts: (number[] | number)[]) =>
    `[${parts.map((p) => (typeof p === "number" ? fmt(p) : hexOf(p))).join(" ")}] TJ`;

  for (const o of ops) {
    const a = nums(o);
    let emit: string | undefined = o.raw;
    switch (o.op) {
      case "q":
        stack.push({ ...gs });
        break;
      case "Q":
        gs = stack.pop() ?? gs;
        break;
      case "cm":
        if (a.length === 6 && a.every(Number.isFinite)) gs.ctm = mul(a as M, gs.ctm);
        break;
      case "BT":
        tm = ID;
        tlm = ID;
        break;
      case "Tf": {
        const nm = o.args[0];
        gs.fs = a[1] ?? 0;
        const fdict =
          nm?.k === "name"
            ? ctx.lookupMaybe(res("Font")?.get(PDFName.of(nm.v)), PDFDict)
            : undefined;
        if (fdict) {
          let fi = run.fonts.get(fdict);
          if (!fi) {
            fi = fontInfo(run.doc, fdict);
            run.fonts.set(fdict, fi);
          }
          gs.font = fi;
        } else gs.font = undefined;
        break;
      }
      case "Tc":
        gs.tc = a[0] ?? 0;
        break;
      case "Tw":
        gs.tw = a[0] ?? 0;
        break;
      case "Tz":
        gs.th = (a[0] ?? 100) / 100;
        break;
      case "TL":
        gs.tl = a[0] ?? 0;
        break;
      case "Ts":
        gs.ts = a[0] ?? 0;
        break;
      case "Td":
      case "TD":
        if (o.op === "TD") gs.tl = -(a[1] ?? 0);
        tlm = mul([1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0], tlm);
        tm = tlm;
        break;
      case "Tm":
        if (a.length === 6 && a.every(Number.isFinite)) {
          tlm = a as M;
          tm = tlm;
        }
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
        tm = tlm;
        break;
      case "Tj":
      case "'":
      case '"':
      case "TJ": {
        let prefix = "";
        if (o.op === '"') {
          gs.tw = a[0] ?? gs.tw;
          gs.tc = a[1] ?? gs.tc;
          prefix = `${o.args[0]?.raw ?? "0"} Tw ${o.args[1]?.raw ?? "0"} Tc T* `;
        }
        if (o.op === "'" || o.op === '"') {
          tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
          tm = tlm;
          if (o.op === "'") prefix = "T* ";
        }
        const items: (number[] | number)[] = [];
        const last = o.args.at(-1);
        if (o.op === "TJ" && last?.k === "arr")
          for (const it of last.items) {
            if (it.k === "num") items.push(it.v);
            else if (it.k === "str") items.push(it.b);
          }
        else if (last?.k === "str") items.push(last.b);
        const before = tm;
        const parts: (number[] | number)[] = [];
        let removed = false;
        let whole = false;
        for (const it of items) {
          if (typeof it === "number") {
            tm = mul([1, 0, 0, 1, (-it / 1000) * gs.fs * gs.th, 0], tm);
            parts.push(it);
            continue;
          }
          const r = show(it);
          if (r === "whole") {
            whole = true;
            break;
          }
          parts.push(...r.parts);
          if (r.removed) removed = true;
        }
        if (whole) {
          // The whole run goes; what follows it in the same text object may move a little.
          tm = before;
          run.report.runs++;
          touched();
          emit = prefix.trim() ? prefix.trim() : "";
          changed = true;
          break;
        }
        if (removed) {
          touched();
          changed = true;
          emit = `${prefix}${tj(parts)}`;
        }
        break;
      }
      case "m":
      case "l":
        grow(a[0] ?? 0, a[1] ?? 0);
        break;
      case "c":
        for (let k = 0; k + 1 < 6; k += 2) grow(a[k] ?? 0, a[k + 1] ?? 0);
        break;
      case "v":
      case "y":
        for (let k = 0; k + 1 < 4; k += 2) grow(a[k] ?? 0, a[k + 1] ?? 0);
        break;
      case "re": {
        const [x, y, w, h] = a as [number, number, number, number];
        grow(x, y);
        grow(x + w, y + h);
        grow(x + w, y);
        grow(x, y + h);
        break;
      }
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*": {
        // A small drawing under the areas goes (a drawn signature, outlined text); big shapes
        // that only cross them (a background, a frame) stay, covered.
        const b = path;
        path = undefined;
        if (
          b &&
          hits(b, run.rects) &&
          (area(b) <= 4 * totalArea || run.rects.some((r) => inside(b, r, 2)))
        ) {
          run.report.paths++;
          touched();
          changed = true;
          emit = "n";
        }
        break;
      }
      case "n":
        path = undefined;
        break;
      case "Do": {
        const nm = o.args[0];
        const ref = nm?.k === "name" ? res("XObject")?.get(PDFName.of(nm.v)) : undefined;
        const x = ref ? ctx.lookup(ref) : undefined;
        if (!(x instanceof PDFStream)) break;
        const st = x.dict.get(PDFName.of("Subtype"));
        const sub = st instanceof PDFName ? st.decodeText() : "";
        if (sub === "Image") {
          if (hits(boxOf(gs.ctm, 0, 0, 1, 1), run.rects)) {
            run.report.images++;
            touched();
            changed = true;
            emit = "";
          }
        } else if (sub === "Form") {
          if (run.depth > 12) throw new RedactError("the page's drawings are nested too deep");
          const fm = ctx.lookupMaybe(x.dict.get(PDFName.of("Matrix")), PDFArray);
          const mm = fm ? (fm.asArray().map((v) => numOf(ctx.lookup(v)) ?? 0) as M) : ID;
          const bbox = rectOf(ctx.lookup(x.dict.get(PDFName.of("BBox"))));
          const m2 = mul(mm, gs.ctm);
          // A form that cannot reach the areas is left as it is.
          if (bbox && !hits(boxOf(m2, bbox[0], bbox[1], bbox[2], bbox[3]), run.rects)) break;
          const inner = decodeStream(run.doc, x);
          const fres = ctx.lookupMaybe(x.dict.get(PDFName.of("Resources")), PDFDict) ?? resources;
          run.depth++;
          const r = rewrite(run, inner, fres, m2);
          run.depth--;
          if (r.changed) {
            const d = x.dict.clone(ctx);
            d.delete(PDFName.of("Filter"));
            d.delete(PDFName.of("DecodeParms"));
            d.delete(PDFName.of("Length"));
            const made = ctx.register(ctx.flateStream(latinBytes(r.content), {}));
            const fresh = ctx.lookup(made) as PDFRawStream;
            for (const [k, v] of d.entries())
              if (k.decodeText() !== "Filter" && k.decodeText() !== "Length") fresh.dict.set(k, v);
            fresh.dict.set(
              PDFName.of("Resources"),
              ownResources(run.doc, fres, r.content, r.added),
            );
            const name = `RGRedacted${++run.made}`;
            added.set(name, made);
            changed = true;
            touched();
            emit = `/${name} Do`;
          }
        }
        break;
      }
      case "BI": {
        if (hits(boxOf(gs.ctm, 0, 0, 1, 1), run.rects)) {
          run.report.images++;
          touched();
          changed = true;
          emit = "";
        }
        break;
      }
      case "BMC":
        marks.push({ index: out.length, touched: false });
        break;
      case "BDC": {
        const props = o.args[1];
        const mcid =
          props?.k === "dict" ? props.entries.find(([k]) => k === "MCID")?.[1] : undefined;
        marks.push({
          index: out.length,
          touched: false,
          ...(mcid?.k === "num" && { mcid: mcid.v }),
        });
        break;
      }
      case "EMC": {
        const m = marks.pop();
        if (m?.touched) {
          if (m.mcid !== undefined) run.mcids.add(m.mcid);
          // Its alt texts would still say what was taken out.
          const opened = out[m.index];
          if (opened !== undefined) out[m.index] = withoutAltText(opened);
        }
        break;
      }
    }
    out.push(emit);
  }
  for (const m of marks)
    if (m.touched) {
      if (m.mcid !== undefined) run.mcids.add(m.mcid);
      const opened = out[m.index];
      if (opened !== undefined) out[m.index] = withoutAltText(opened);
    }
  return { content: out.filter((x) => x !== "").join("\n"), changed, added };
}

/** A BDC's own dictionary without /ActualText, /Alt and /E. */
function withoutAltText(raw: string): string {
  const ops = parseContent(raw);
  const o = ops[0];
  if (o?.op !== "BDC") return raw;
  const tag = o.args[0];
  const props = o.args[1];
  if (props?.k !== "dict") return raw;
  const keep = props.entries.filter(([k]) => k !== "ActualText" && k !== "Alt" && k !== "E");
  return `${tag?.raw ?? "/Span"} <<${keep.map(([k, v]) => `/${k} ${v.raw}`).join(" ")}>> BDC`;
}

/** The structure elements of a page whose marked content lost glyphs lose their alt texts. */
function cleanStructure(doc: PDFDocument, page: PDFRef, mcids: Set<number>): void {
  if (!mcids.size || !doc.catalog.has(PDFName.of("StructTreeRoot"))) return;
  const ctx = doc.context;
  const pageOf = (d: PDFDict): PDFRef | undefined => {
    let cur: PDFDict | undefined = d;
    for (let k = 0; cur && k < 30; k++) {
      const pg = cur.get(PDFName.of("Pg"));
      if (pg instanceof PDFRef) return pg;
      cur = ctx.lookupMaybe(cur.get(PDFName.of("P")), PDFDict);
    }
    return undefined;
  };
  const hasMcid = (k: PDFObject | undefined): boolean => {
    const v = k instanceof PDFRef ? ctx.lookup(k) : k;
    if (v instanceof PDFNumber) return mcids.has(v.asNumber());
    if (v instanceof PDFArray) return v.asArray().some(hasMcid);
    if (v instanceof PDFDict) {
      const t = v.get(PDFName.of("Type"));
      if (t instanceof PDFName && t.decodeText() === "MCR") {
        const id = v.get(PDFName.of("MCID"));
        const pg = v.get(PDFName.of("Pg"));
        return (
          id instanceof PDFNumber &&
          mcids.has(id.asNumber()) &&
          (!(pg instanceof PDFRef) || pg.toString() === page.toString())
        );
      }
    }
    return false;
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || !obj.has(PDFName.of("S")) || !obj.has(PDFName.of("K")))
      continue;
    const pg = pageOf(obj);
    if (pg && pg.toString() !== page.toString()) continue;
    if (!hasMcid(obj.get(PDFName.of("K")))) continue;
    obj.delete(PDFName.of("ActualText"));
    obj.delete(PDFName.of("Alt"));
    obj.delete(PDFName.of("E"));
  }
}

/** Takes out of a page what is under the areas, then blacks them (the file is written anew). */
export async function redactPage(
  doc: PDFDocument,
  pageIndex: number,
  rects: readonly PdfRect[],
): Promise<RedactReport> {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const node = page.node;
  const report: RedactReport = { glyphs: 0, runs: 0, images: 0, paths: 0, annots: 0 };
  // Annotations under the areas go; a form field there is refused (its value would stay).
  const annots = ctx.lookupMaybe(node.get(PDFName.of("Annots")), PDFArray);
  if (annots)
    for (let k = annots.size() - 1; k >= 0; k--) {
      const d = ctx.lookupMaybe(annots.get(k), PDFDict);
      const r = d ? rectOf(ctx.lookup(d.get(PDFName.of("Rect")))) : undefined;
      if (!d || !r || !hits(r, rects)) continue;
      const st = d.get(PDFName.of("Subtype"));
      const sub = st instanceof PDFName ? st.decodeText() : "";
      if (sub === "Widget")
        throw new RedactError(
          "a form field is under the area: empty it or take it out first (its value would stay in the file)",
        );
      if (sub === "Popup") continue;
      annots.remove(k);
      report.annots++;
    }
  const contents = ctx.lookup(node.get(PDFName.of("Contents")));
  const streams: PDFObject[] =
    contents instanceof PDFArray
      ? contents.asArray().map((x) => ctx.lookup(x) as PDFObject)
      : contents
        ? [contents]
        : [];
  const content = streams.map((s) => decodeStream(doc, s)).join("\n");
  const resRaw = node.getInheritableAttribute(PDFName.of("Resources"));
  const resources = ctx.lookupMaybe(resRaw, PDFDict);
  const run: Run = {
    doc,
    rects,
    report,
    mcids: new Set(),
    fonts: new Map(),
    made: 0,
    depth: 0,
  };
  const r = rewrite(run, content, resources, ID);
  const black = rects
    .map((x) => `${fmt(x[0])} ${fmt(x[1])} ${fmt(x[2] - x[0])} ${fmt(x[3] - x[1])} re f`)
    .join("\n");
  const next = `q\n${r.content}\nQ\nq 0 g\n${black}\nQ\n`;
  node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(latinBytes(next), {})));
  // The page's own resources (a copy: they may be inherited or shared with other pages).
  node.set(PDFName.of("Resources"), ownResources(doc, resources, next, r.added));
  // A thumbnail would still show the page as it was.
  node.delete(PDFName.of("Thumb"));
  node.delete(PDFName.of("PieceInfo"));
  cleanStructure(doc, page.ref, run.mcids);
  return report;
}

// ---- checked by another reader ------------------------------------------------------------------

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsLoaded: Promise<PdfJs> | undefined;
export const pdfjs = (): Promise<PdfJs> => {
  pdfjsLoaded ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLoaded;
};

/** A glyph pdf.js draws: its text, its box on the page, its run of text (for spaces between). */
export interface PageGlyph {
  c: string;
  box: PdfRect;
  /** Its baseline's start and the text size, for telling words and lines apart. */
  x: number;
  y: number;
  size: number;
  space: boolean;
  /** The glyph's run (one string shown): a new run may start a new word or line. */
  run: number;
}

type PdfJsPage = Awaited<
  ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>
>;
type OperatorList = Awaited<ReturnType<PdfJsPage["getOperatorList"]>>;

/**
 * Every glyph of a page as pdf.js reads it (p3.5.4): its operators replayed with the font's own
 * widths, the spacing and the matrices, so each character has its true box. A word's place in a
 * run of text is no longer guessed from its share of the characters (wide capitals after narrow
 * letters left «Z» of «ZEBRA-77» outside the area), and the check sees a single letter.
 */
export function glyphsOf(lib: PdfJs, page: PdfJsPage, ops: OperatorList): PageGlyph[] {
  const OPS = lib.OPS as Record<string, number>;
  const out: PageGlyph[] = [];
  interface St {
    ctm: M;
    fs: number;
    tc: number;
    tw: number;
    th: number;
    tl: number;
    rise: number;
    fm: number;
    vertical: boolean;
  }
  let st: St = { ctm: ID, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, fm: 0.001, vertical: false };
  const stack: St[] = [];
  let tm: M = ID;
  let x = 0;
  let y = 0;
  let lineX = 0;
  let lineY = 0;
  let runs = 0;
  const move = (dx: number, dy: number) => {
    lineX += dx;
    lineY += dy;
    x = lineX;
    y = lineY;
  };
  const font = (id: unknown) => {
    try {
      const f = page.commonObjs.get(String(id)) as
        | { fontMatrix?: number[]; vertical?: boolean }
        | undefined;
      return { fm: f?.fontMatrix?.[0] ?? 0.001, vertical: f?.vertical === true };
    } catch {
      return { fm: 0.001, vertical: false };
    }
  };
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k] as number;
    const a = (ops.argsArray[k] ?? []) as unknown[];
    if (fn === OPS.save) stack.push({ ...st });
    else if (fn === OPS.restore) st = stack.pop() ?? st;
    else if (fn === OPS.transform) st.ctm = mul(a.slice(0, 6) as M, st.ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...st });
      const m = a[0] as number[] | null;
      if (m && m.length === 6) st.ctm = mul(m as M, st.ctm);
    } else if (fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st;
    else if (fn === OPS.beginText) {
      tm = ID;
      x = y = lineX = lineY = 0;
    } else if (fn === OPS.setFont) {
      st.fs = Number(a[1]) || 0;
      Object.assign(st, font(a[0]));
    } else if (fn === OPS.setCharSpacing) st.tc = Number(a[0]) || 0;
    else if (fn === OPS.setWordSpacing) st.tw = Number(a[0]) || 0;
    else if (fn === OPS.setHScale) st.th = (Number(a[0]) || 100) / 100;
    else if (fn === OPS.setLeading) st.tl = Number(a[0]) || 0;
    else if (fn === OPS.setTextRise) st.rise = Number(a[0]) || 0;
    else if (fn === OPS.moveText) move(Number(a[0]) || 0, Number(a[1]) || 0);
    else if (fn === OPS.setLeadingMoveText) {
      st.tl = -(Number(a[1]) || 0);
      move(Number(a[0]) || 0, Number(a[1]) || 0);
    } else if (fn === OPS.setTextMatrix) {
      const m = a[0] && typeof a[0] === "object" ? Object.values(a[0] as object) : a.slice(0, 6);
      tm = m.slice(0, 6).map(Number) as M;
      x = y = lineX = lineY = 0;
    } else if (fn === OPS.nextLine) move(0, -st.tl);
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const glyphs = (Array.isArray(a[0]) ? a[0] : []) as unknown[];
      const m = mul(tm, st.ctm);
      const fs = st.fs;
      const dir = fs < 0 ? -1 : 1;
      const run = runs++;
      for (const g of glyphs) {
        if (typeof g === "number") {
          const d = (g * fs) / 1000;
          if (st.vertical) y -= d;
          else x -= d * st.th;
          continue;
        }
        if (!g || typeof g !== "object") continue;
        const gl = g as { unicode?: string; width?: number; isSpace?: boolean };
        const w = (gl.width ?? 0) * fs * st.fm;
        const spacing = (gl.isSpace ? st.tw : 0) + st.tc;
        const c = (gl.unicode ?? "").normalize("NFKC");
        if (st.vertical) {
          const adv = w - spacing * dir;
          const box = boxOf(
            m,
            x - 0.5 * Math.abs(fs),
            y - Math.abs(adv),
            x + 0.5 * Math.abs(fs),
            y,
          );
          const [px, py] = at(m, x, y);
          out.push({ c, box, x: px, y: py, size: Math.abs(fs), space: gl.isSpace === true, run });
          y -= adv;
        } else {
          const adv = (w + spacing * dir) * st.th;
          const lo = y + st.rise - 0.15 * Math.abs(fs);
          const hi = y + st.rise + 0.85 * Math.abs(fs);
          const box = boxOf(m, x, lo, x + Math.max(w * st.th, 0.001), hi);
          const [px, py] = at(m, x, y + st.rise);
          const size = Math.abs(fs) * Math.hypot(m[2], m[3]);
          out.push({ c, box, x: px, y: py, size, space: gl.isSpace === true, run });
          x += adv;
        }
      }
    }
  }
  return out;
}

/** A page's glyphs from a file (0-based), as pdf.js reads them. */
export async function pageGlyphs(bytes: Uint8Array, pageIndex: number): Promise<PageGlyph[]> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  try {
    const doc = await task.promise;
    if (pageIndex < 0 || pageIndex >= doc.numPages) return [];
    const page = await doc.getPage(pageIndex + 1);
    return glyphsOf(lib, page, await page.getOperatorList());
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The glyphs of a page that are words: their text, with a space between words and lines. */
export function glyphText(glyphs: readonly PageGlyph[]): { c: string; glyph: number }[] {
  const out: { c: string; glyph: number }[] = [];
  let prev: PageGlyph | undefined;
  glyphs.forEach((g, k) => {
    if (prev && !g.space) {
      const size = Math.max(prev.size, g.size, 1);
      const sameLine = Math.abs(prev.y - g.y) < size * 0.5;
      const gap = g.box[0] - prev.box[2];
      if (!sameLine || gap > size * 0.25 || gap < -size * 2) out.push({ c: " ", glyph: -1 });
    }
    if (g.space || !g.c.trim()) out.push({ c: " ", glyph: -1 });
    else for (const ch of g.c) out.push({ c: ch, glyph: k });
    prev = g;
  });
  return out;
}

/** Words in a page's glyphs (case and runs of white space do not count): each match's glyphs. */
export function matchGlyphs(glyphs: readonly PageGlyph[], words: string): number[][] {
  const want = words.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (!want) return [];
  const kept: { c: string; glyph: number }[] = [];
  for (const ch of glyphText(glyphs)) {
    const space = /\s/.test(ch.c);
    if (space && (!kept.length || kept.at(-1)?.c === " ")) continue;
    if (space) kept.push({ c: " ", glyph: -1 });
    else for (const low of ch.c.toLowerCase()) kept.push({ c: low, glyph: ch.glyph });
  }
  const text = kept.map((k) => k.c).join("");
  const out: number[][] = [];
  for (let i = text.indexOf(want); i >= 0 && out.length < 500; i = text.indexOf(want, i + 1))
    out.push([
      ...new Set(kept.slice(i, i + want.length).flatMap((k) => (k.glyph >= 0 ? [k.glyph] : []))),
    ]);
  return out;
}

/** Where some words' glyphs are on a page (0-based): one box per glyph, from pdf.js. */
async function wordBoxes(bytes: Uint8Array, pageIndex: number, words: string): Promise<PdfRect[]> {
  const glyphs = await pageGlyphs(bytes, pageIndex);
  return matchGlyphs(glyphs, words).flatMap((ids) =>
    ids.flatMap((id) => {
      const g = glyphs[id];
      return g && !g.space ? [g.box] : [];
    }),
  );
}

/**
 * Whether pdf.js finds text, a picture or an annotation under the areas of a page of the written
 * file (they are shrunk by a quarter of a point, so what only touches their edges is not counted).
 * Every glyph is checked on its own (p3.5.4: one letter left is a failed redaction), and the
 * words a redaction was asked for (`words`) must be nowhere on the page anymore.
 * Undefined: nothing is there; otherwise what was found.
 */
export async function verifyRedaction(
  bytes: Uint8Array,
  pageIndex: number,
  rects: readonly PdfRect[],
  words: readonly string[] = [],
  /**
   * The file before (a redaction by words): the words' own glyphs are found there again, and
   * nothing may be left where they were, whatever areas were made from them.
   */
  before?: Uint8Array,
): Promise<string | undefined> {
  const where: PdfRect[] = [];
  if (before)
    for (const w of words) if (w.trim()) where.push(...(await wordBoxes(before, pageIndex, w)));
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(pageIndex + 1);
    const shrunk = rects.map(
      (r) => [r[0] + 0.25, r[1] + 0.25, r[2] - 0.25, r[3] - 0.25] as PdfRect,
    );
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform as M;
      const len = Math.hypot(a, b) || 1;
      const up = Math.hypot(c, d) || 1;
      const ux = a / len;
      const uy = b / len;
      const vx = c / up;
      const vy = d / up;
      const w = it.width;
      const h = it.height || up;
      const pts: [number, number][] = [];
      for (const s of [0, w])
        for (const t of [-0.15 * h, 0.85 * h]) pts.push([e + ux * s + vx * t, f + uy * s + vy * t]);
      const box: PdfRect = [
        Math.min(...pts.map((p) => p[0])),
        Math.min(...pts.map((p) => p[1])),
        Math.max(...pts.map((p) => p[0])),
        Math.max(...pts.map((p) => p[1])),
      ];
      if (hits(box, shrunk)) return `text «${it.str.slice(0, 40)}»`;
    }
    const ops = await page.getOperatorList();
    // Glyph by glyph: a single character under an area is enough to refuse.
    const glyphs = glyphsOf(lib, page, ops);
    const at = [
      ...shrunk,
      ...where.map((r) => [r[0] + 0.25, r[1] + 0.25, r[2] - 0.25, r[3] - 0.25] as PdfRect),
    ];
    const under = glyphs.filter((g) => !g.space && g.c.trim() && hits(g.box, at));
    if (under.length)
      return `text «${under
        .map((g) => g.c)
        .join("")
        .slice(0, 40)}»`;
    // The words asked for, anywhere on the page (both readers' text).
    const norm = (t: string) => t.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    const pageText = [
      norm(
        glyphText(glyphs)
          .map((x) => x.c)
          .join(""),
      ),
      norm(
        content.items.map((it) => ("str" in it ? `${it.str}${it.hasEOL ? " " : ""}` : "")).join(""),
      ),
    ];
    for (const w of words.map(norm).filter(Boolean))
      if (pageText.some((t) => t.includes(w))) return `text «${w.slice(0, 40)}»`;
    const OPS = lib.OPS;
    const images = new Set<number>([
      OPS.paintImageXObject,
      OPS.paintInlineImageXObject,
      OPS.paintImageMaskXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintSolidColorImageMask,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat,
    ]);
    let ctm: M = ID;
    const stack: M[] = [];
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k] as number;
      const args = ops.argsArray[k] as unknown[] | null;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform && args) ctm = mul(args.slice(0, 6) as M, ctm);
      else if (fn === OPS.paintFormXObjectBegin && args) {
        stack.push(ctm);
        const m = args[0] as number[] | null;
        if (m && m.length === 6) ctm = mul(m as M, ctm);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (images.has(fn) && hits(boxOf(ctm, 0, 0, 1, 1), shrunk)) return "a picture";
    }
    for (const an of await page.getAnnotations()) {
      const r = an.rect as number[] | undefined;
      if (r && an.subtype !== "Popup" && hits([r[0], r[1], r[2], r[3]] as PdfRect, shrunk))
        return `an annotation (${an.subtype})`;
    }
    return undefined;
  } finally {
    await task.destroy().catch(() => {});
  }
}
