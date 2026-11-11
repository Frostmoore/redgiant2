// Text layers of the layered picture editor (p3.5.8, Photoshop's type layers): the text and its
// look kept with the layer, drawn to pixels by one pure function the page and the server share
// (a TrueType font's own outlines filled with anti-aliasing, no canvas), so a text typed on the
// page and one the agent writes are the same pixels. The fonts are the ones both sides have:
// Liberation Sans (metric-compatible with Arial), which pdf.js carries for the server and the
// server gives the page (`/api/editor/fonts/<file>`). Lines follow CSS's model (half the leading
// above and below each line), so the page's text area over the picture lines up with the result.
import { z } from "zod";
import { blankPx, type Cov, fillPolys, type Px, paintCov, type RGBA } from "./image-pixels.js";

/**
 * The families a text layer can use, each with its four real files (bold and italic are the
 * designers' own, never synthesized): Liberation Sans from pdf.js, the others carried by the
 * server (packages/server/fonts, LICENSES.md there). `kind` is the browser's fallback while a
 * file is on its way.
 */
export const TEXT_FONTS = [
  {
    id: "sans",
    name: "Liberation Sans",
    kind: "sans-serif",
    files: {
      regular: "LiberationSans-Regular.ttf",
      bold: "LiberationSans-Bold.ttf",
      italic: "LiberationSans-Italic.ttf",
      boldItalic: "LiberationSans-BoldItalic.ttf",
    },
  },
  {
    id: "serif",
    name: "Liberation Serif",
    kind: "serif",
    files: {
      regular: "LiberationSerif-Regular.ttf",
      bold: "LiberationSerif-Bold.ttf",
      italic: "LiberationSerif-Italic.ttf",
      boldItalic: "LiberationSerif-BoldItalic.ttf",
    },
  },
  {
    id: "mono",
    name: "Liberation Mono",
    kind: "monospace",
    files: {
      regular: "LiberationMono-Regular.ttf",
      bold: "LiberationMono-Bold.ttf",
      italic: "LiberationMono-Italic.ttf",
      boldItalic: "LiberationMono-BoldItalic.ttf",
    },
  },
  {
    id: "inter",
    name: "Inter",
    kind: "sans-serif",
    files: {
      regular: "Inter-Regular.ttf",
      bold: "Inter-Bold.ttf",
      italic: "Inter-Italic.ttf",
      boldItalic: "Inter-BoldItalic.ttf",
    },
  },
  {
    id: "roboto",
    name: "Roboto",
    kind: "sans-serif",
    files: {
      regular: "Roboto-Regular.ttf",
      bold: "Roboto-Bold.ttf",
      italic: "Roboto-Italic.ttf",
      boldItalic: "Roboto-BoldItalic.ttf",
    },
  },
  {
    id: "noto-sans",
    name: "Noto Sans",
    kind: "sans-serif",
    files: {
      regular: "NotoSans-Regular.ttf",
      bold: "NotoSans-Bold.ttf",
      italic: "NotoSans-Italic.ttf",
      boldItalic: "NotoSans-BoldItalic.ttf",
    },
  },
  {
    id: "noto-serif",
    name: "Noto Serif",
    kind: "serif",
    files: {
      regular: "NotoSerif-Regular.ttf",
      bold: "NotoSerif-Bold.ttf",
      italic: "NotoSerif-Italic.ttf",
      boldItalic: "NotoSerif-BoldItalic.ttf",
    },
  },
  {
    id: "open-sans",
    name: "Open Sans",
    kind: "sans-serif",
    files: {
      regular: "OpenSans-Regular.ttf",
      bold: "OpenSans-Bold.ttf",
      italic: "OpenSans-Italic.ttf",
      boldItalic: "OpenSans-BoldItalic.ttf",
    },
  },
  {
    id: "lato",
    name: "Lato",
    kind: "sans-serif",
    files: {
      regular: "Lato-Regular.ttf",
      bold: "Lato-Bold.ttf",
      italic: "Lato-Italic.ttf",
      boldItalic: "Lato-BoldItalic.ttf",
    },
  },
  {
    id: "montserrat",
    name: "Montserrat",
    kind: "sans-serif",
    files: {
      regular: "Montserrat-Regular.ttf",
      bold: "Montserrat-Bold.ttf",
      italic: "Montserrat-Italic.ttf",
      boldItalic: "Montserrat-BoldItalic.ttf",
    },
  },
] as const;
export type TextFontId = (typeof TEXT_FONTS)[number]["id"];

/** Every font file a text can need (what the server serves). */
export const TEXT_FONT_FILES: readonly string[] = TEXT_FONTS.flatMap((f) => Object.values(f.files));

/** The file of a family's style (an unknown family: the first one). */
export function textFontFile(font: string, bold: boolean, italic: boolean): string {
  const f = TEXT_FONTS.find((x) => x.id === font) ?? TEXT_FONTS[0];
  return bold
    ? italic
      ? f.files.boldItalic
      : f.files.bold
    : italic
      ? f.files.italic
      : f.files.regular;
}

/** A layer's text: what it says and how, and where its box is (from the layer's pixels). */
export const ImageText = z.object({
  text: z.string().max(20_000),
  /** A family of `TEXT_FONTS`. */
  font: z.string().min(1).max(60),
  /** In the picture's pixels. */
  size: z.number().min(1).max(4000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
  align: z.enum(["left", "center", "right"]),
  bold: z.boolean(),
  italic: z.boolean(),
  /** A line's height, times the size. */
  lineHeight: z.number().min(0.5).max(10),
  /** Paragraph text's box (lines wrap at its width, lines beyond its height are not drawn). */
  box: z
    .object({ w: z.number().positive().max(100_000), h: z.number().positive().max(100_000) })
    .optional(),
  /** The box's top left (before the rotation) from the layer's pixels' top left. */
  ox: z.number().min(-1_000_000).max(1_000_000),
  oy: z.number().min(-1_000_000).max(1_000_000),
  /** Degrees, clockwise, around the box's centre. */
  rotate: z.number().min(-360).max(360).optional(),
});
export type ImageText = z.infer<typeof ImageText>;

/** A new text's look (Photoshop's defaults, more or less). */
export const DEFAULT_TEXT: Omit<ImageText, "text" | "ox" | "oy"> = {
  font: "sans",
  size: 48,
  color: "#000000",
  align: "left",
  bold: false,
  italic: false,
  lineHeight: 1.2,
};

// ---------------------------------------------------------------- TrueType

export interface Glyph {
  advance: number;
  /** Contours of points: x, y (font units, y up), on the curve or not. */
  contours: { x: number; y: number; on: boolean }[][];
}

export interface Font {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  glyphOf(code: number): Glyph;
}

/** A TrueType font's outlines (glyf), character map (format 4 or 12) and widths. */
export function readTrueType(bytes: Uint8Array): Font {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint16(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      bytes[at] as number,
      bytes[at + 1] as number,
      bytes[at + 2] as number,
      bytes[at + 3] as number,
    );
    tables[tag] = v.getUint32(at + 8);
  }
  for (const t of ["head", "maxp", "hhea", "hmtx", "loca", "glyf", "cmap"])
    if (tables[t] === undefined) throw new Error(`the font has no ${t} table`);
  const head = tables.head as number;
  const unitsPerEm = v.getUint16(head + 18);
  const longLoca = v.getInt16(head + 50) === 1;
  const numGlyphs = v.getUint16((tables.maxp as number) + 4);
  const hhea = tables.hhea as number;
  const ascender = v.getInt16(hhea + 4);
  const descender = v.getInt16(hhea + 6);
  const lineGap = v.getInt16(hhea + 8);
  const nMetrics = v.getUint16(hhea + 34);
  const hmtx = tables.hmtx as number;
  const advanceOf = (g: number) => v.getUint16(hmtx + Math.min(g, nMetrics - 1) * 4);
  const loca = tables.loca as number;
  const locaAt = (g: number) =>
    longLoca ? v.getUint32(loca + g * 4) : v.getUint16(loca + g * 2) * 2;
  const glyf = tables.glyf as number;
  // The character map: Windows Unicode, full (12) or basic plane (4).
  const cmap = tables.cmap as number;
  let sub4: number | undefined;
  let sub12: number | undefined;
  for (let i = 0; i < v.getUint16(cmap + 2); i++) {
    const p = v.getUint16(cmap + 4 + i * 8);
    const e = v.getUint16(cmap + 6 + i * 8);
    const off = cmap + v.getUint32(cmap + 8 + i * 8);
    const format = v.getUint16(off);
    if (format === 12 && (p === 3 || p === 0)) sub12 = off;
    if (format === 4 && ((p === 3 && e === 1) || p === 0)) sub4 ??= off;
  }
  const indexOf = (code: number): number => {
    if (sub12 !== undefined) {
      const groups = v.getUint32(sub12 + 12);
      for (let i = 0; i < groups; i++) {
        const at = sub12 + 16 + i * 12;
        const s = v.getUint32(at);
        const e = v.getUint32(at + 4);
        if (code >= s && code <= e) return v.getUint32(at + 8) + (code - s);
      }
      return 0;
    }
    if (sub4 === undefined || code > 0xffff) return 0;
    const segX2 = v.getUint16(sub4 + 6);
    const ends = sub4 + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let i = 0; i < segX2 / 2; i++) {
      const end = v.getUint16(ends + i * 2);
      if (code > end) continue;
      const start = v.getUint16(starts + i * 2);
      if (code < start) return 0;
      const delta = v.getInt16(deltas + i * 2);
      const ro = v.getUint16(ranges + i * 2);
      if (!ro) return (code + delta) & 0xffff;
      const g = v.getUint16(ranges + i * 2 + ro + (code - start) * 2);
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const outline = (g: number, depth = 0): Glyph["contours"] => {
    if (g >= numGlyphs || depth > 6) return [];
    const start = locaAt(g);
    const end = locaAt(g + 1);
    if (end <= start) return [];
    const at = glyf + start;
    const nc = v.getInt16(at);
    if (nc >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < nc; i++) endPts.push(v.getUint16(at + 10 + i * 2));
      const count = nc ? (endPts[nc - 1] as number) + 1 : 0;
      let p = at + 10 + nc * 2;
      p += 2 + v.getUint16(p);
      const flags: number[] = [];
      while (flags.length < count) {
        const f = bytes[p++] as number;
        flags.push(f);
        if (f & 8) {
          const rep = bytes[p++] as number;
          for (let r = 0; r < rep; r++) flags.push(f);
        }
      }
      const xs: number[] = [];
      let x = 0;
      for (const f of flags) {
        if (f & 2) {
          const d = bytes[p++] as number;
          x += f & 16 ? d : -d;
        } else if (!(f & 16)) {
          x += v.getInt16(p);
          p += 2;
        }
        xs.push(x);
      }
      const ys: number[] = [];
      let y = 0;
      for (const f of flags) {
        if (f & 4) {
          const d = bytes[p++] as number;
          y += f & 32 ? d : -d;
        } else if (!(f & 32)) {
          y += v.getInt16(p);
          p += 2;
        }
        ys.push(y);
      }
      const out: Glyph["contours"] = [];
      let s = 0;
      for (const e of endPts) {
        const c: Glyph["contours"][number] = [];
        for (let i = s; i <= e; i++)
          c.push({ x: xs[i] as number, y: ys[i] as number, on: !!((flags[i] as number) & 1) });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // A composite: other glyphs, moved and scaled.
    const out: Glyph["contours"] = [];
    let p = at + 10;
    for (;;) {
      const f = v.getUint16(p);
      const sub = v.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (f & 1) {
        dx = v.getInt16(p);
        dy = v.getInt16(p + 2);
        p += 4;
      } else {
        dx = v.getInt8(p);
        dy = v.getInt8(p + 1);
        p += 2;
      }
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2 = (o: number) => v.getInt16(o) / 16384;
      if (f & 8) {
        a = d = f2(p);
        p += 2;
      } else if (f & 0x40) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (f & 0x80) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      const offsets = !!(f & 2);
      for (const ct of outline(sub, depth + 1))
        out.push(
          ct.map((q) => ({
            x: a * q.x + c * q.y + (offsets ? dx : 0),
            y: b * q.x + d * q.y + (offsets ? dy : 0),
            on: q.on,
          })),
        );
      if (!(f & 0x20)) break;
    }
    return out;
  };
  const cache = new Map<number, Glyph>();
  return {
    unitsPerEm,
    ascender,
    descender,
    lineGap,
    glyphOf(code: number) {
      const have = cache.get(code);
      if (have) return have;
      const g = indexOf(code);
      const glyph = { advance: advanceOf(g), contours: outline(g) };
      cache.set(code, glyph);
      return glyph;
    },
  };
}

/** A contour of quadratic curves as a polygon (curves cut in small straight steps). */
export function contourPoly(
  c: Glyph["contours"][number],
  k: number,
  ox: number,
  oy: number,
): number[] {
  if (c.length < 2) return [];
  // Two points off the curve in a row have one on it between them.
  const pts: { x: number; y: number; on: boolean }[] = [];
  for (let i = 0; i < c.length; i++) {
    const p = c[i] as (typeof c)[number];
    const q = c[(i + 1) % c.length] as (typeof c)[number];
    pts.push(p);
    if (!p.on && !q.on) pts.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true });
  }
  const first = pts.findIndex((p) => p.on);
  const ring = first < 0 ? pts : [...pts.slice(first), ...pts.slice(0, first)];
  const out: number[] = [];
  const put = (x: number, y: number) => out.push(ox + x * k, oy - y * k);
  const start = ring[0] as (typeof ring)[number];
  put(start.x, start.y);
  for (let i = 1; i <= ring.length; i++) {
    const p = ring[i % ring.length] as (typeof ring)[number];
    if (p.on) {
      put(p.x, p.y);
      continue;
    }
    const prev = ring[(i - 1) % ring.length] as (typeof ring)[number];
    const next = ring[(i + 1) % ring.length] as (typeof ring)[number];
    const steps = Math.max(
      2,
      Math.min(16, Math.round((Math.hypot(next.x - prev.x, next.y - prev.y) * k) / 3)),
    );
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      put(
        u * u * prev.x + 2 * u * t * p.x + t * t * next.x,
        u * u * prev.y + 2 * u * t * p.y + t * t * next.y,
      );
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- Lines

/** A line of a text: its characters, its left from the box's, its width (trailing spaces aside). */
export interface TextLine {
  text: string;
  x: number;
  w: number;
  /** Where the line starts in the text (UTF-16 index, as a text area's selection). */
  start: number;
}

export interface TextLayout {
  lines: TextLine[];
  /** The box: paragraph text's own, point text's from its lines. */
  w: number;
  h: number;
  /** A line's height, and from a line's top to its baseline. */
  step: number;
  ascent: number;
  /** Paragraph text's lines that do not fit its box (not drawn; Photoshop's overflow mark). */
  hidden: number;
}

const advanceOf = (font: Font, s: string, k: number) => {
  let w = 0;
  for (const ch of s) w += font.glyphOf(ch.codePointAt(0) ?? 0).advance;
  return w * k;
};

/** A line cut where it no longer fits `width`: at spaces, inside a word only when it must. */
function wrap(font: Font, line: string, width: number, k: number): string[] {
  if (!line) return [""];
  const out: string[] = [];
  let cur = "";
  const fits = (s: string) => advanceOf(font, s.trimEnd(), k) <= width + 1e-6;
  for (const tok of line.match(/\S+\s*|\s+/g) ?? []) {
    if (fits(cur + tok)) {
      cur += tok;
      continue;
    }
    if (cur) out.push(cur);
    cur = "";
    if (fits(tok)) {
      cur = tok;
      continue;
    }
    // A word longer than the box: cut between its characters.
    for (const ch of tok) {
      if (cur && !fits(cur + ch)) {
        out.push(cur);
        cur = "";
      }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** A text's lines in its box. */
export function layoutText(font: Font, t: ImageText): TextLayout {
  const k = t.size / font.unitsPerEm;
  const step = t.size * t.lineHeight;
  const content = (font.ascender - font.descender) * k;
  const ascent = (step - content) / 2 + font.ascender * k;
  // Hard lines with where they start (a line break is one or two characters).
  const hard: { text: string; start: number }[] = [];
  let at0 = 0;
  for (const text of t.text.split(/\r\n|\r|\n/)) {
    hard.push({ text, start: at0 });
    at0 += text.length + (t.text.startsWith("\r\n", at0 + text.length) ? 2 : 1);
  }
  let all: { text: string; start: number }[] = t.box
    ? hard.flatMap((h) => {
        let at = h.start;
        return wrap(font, h.text, (t.box as { w: number }).w, k).map((text) => {
          const line = { text, start: at };
          at += text.length;
          return line;
        });
      })
    : hard;
  let hidden = 0;
  if (t.box) {
    const fit = Math.max(1, Math.floor((t.box.h + 0.5) / step));
    hidden = Math.max(0, all.length - fit);
    all = all.slice(0, fit);
  }
  const widths = all.map((l) => advanceOf(font, l.text.trimEnd(), k));
  const w = t.box ? t.box.w : Math.max(0, ...widths);
  const h = t.box ? t.box.h : all.length * step;
  const lines = all.map((l, i) => {
    const lw = widths[i] as number;
    return {
      text: l.text,
      start: l.start,
      w: lw,
      x: t.align === "center" ? (w - lw) / 2 : t.align === "right" ? w - lw : 0,
    };
  });
  return { lines, w, h, step, ascent, hidden };
}

/**
 * The character a point of the box falls on (x, y from the box's top left, before the
 * rotation): the caret's index in the text, between the two characters nearest the point.
 */
export function textIndexAt(font: Font, t: ImageText, x: number, y: number): number {
  const lay = layoutText(font, t);
  const k = t.size / font.unitsPerEm;
  if (!lay.lines.length) return 0;
  const i = Math.max(0, Math.min(lay.lines.length - 1, Math.floor(y / lay.step)));
  const line = lay.lines[i] as TextLine;
  // A wrapped line's last space belongs to it, but the caret goes before the break.
  const next = lay.lines[i + 1];
  const own =
    next && next.start === line.start + line.text.length ? line.text.trimEnd() : line.text;
  let pen = line.x;
  let at = 0;
  for (const ch of own) {
    const adv = font.glyphOf(ch.codePointAt(0) ?? 0).advance * k;
    if (x < pen + adv / 2) return line.start + at;
    pen += adv;
    at += ch.length;
  }
  return line.start + own.length;
}

/** A point of the picture in the box's own frame (the text's rotation undone). */
export function textPointIn(
  t: ImageText,
  box: { w: number; h: number },
  bx: number,
  by: number,
  px: number,
  py: number,
): [number, number] {
  if (!t.rotate) return [px - bx, py - by];
  const a = (-t.rotate * Math.PI) / 180;
  const cx = bx + box.w / 2;
  const cy = by + box.h / 2;
  const dx = px - cx;
  const dy = py - cy;
  return [
    box.w / 2 + dx * Math.cos(a) - dy * Math.sin(a),
    box.h / 2 + dx * Math.sin(a) + dy * Math.cos(a),
  ];
}

const FAR = 1 << 22;

/** The colour of a text as RGBA. */
export function textRgba(color: string): RGBA {
  const h = color.replace("#", "");
  const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}

/**
 * A text drawn with its box's top left at (bx, by) of the picture (turned around the box's
 * centre by `rotate`): the pixels and where they go; empty pixels when nothing shows.
 */
export function renderText(
  font: Font,
  t: ImageText,
  bx: number,
  by: number,
): { x: number; y: number; px: Px; layout: TextLayout } {
  const lay = layoutText(font, t);
  const k = t.size / font.unitsPerEm;
  const polys: number[][] = [];
  lay.lines.forEach((line, i) => {
    let pen = bx + line.x;
    const base = by + i * lay.step + lay.ascent;
    for (const ch of line.text) {
      const g = font.glyphOf(ch.codePointAt(0) ?? 0);
      for (const c of g.contours) {
        const p = contourPoly(c, k, pen, base);
        if (p.length >= 6) polys.push(p);
      }
      pen += g.advance * k;
    }
  });
  if (t.rotate) {
    const a = (t.rotate * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const cx = bx + lay.w / 2;
    const cy = by + lay.h / 2;
    for (const p of polys)
      for (let i = 0; i + 1 < p.length; i += 2) {
        const dx = (p[i] as number) - cx;
        const dy = (p[i + 1] as number) - cy;
        p[i] = cx + dx * cos - dy * sin;
        p[i + 1] = cy + dx * sin + dy * cos;
      }
  }
  const cov: Cov | undefined = polys.length
    ? fillPolys(polys, { x: -FAR, y: -FAR, w: 2 * FAR, h: 2 * FAR })
    : undefined;
  if (!cov) return { x: Math.round(bx), y: Math.round(by), px: blankPx(0, 0), layout: lay };
  const px = blankPx(cov.w, cov.h);
  paintCov(px, cov.x, cov.y, cov, textRgba(t.color));
  return { x: cov.x, y: cov.y, px, layout: lay };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A text layer's pixels and its text with the box at (bx, by): what the page and the server put
 * in the layer (its place, size and pixels, and the text with its box's offset).
 */
export function textLayer(
  font: Font,
  t: ImageText,
  bx: number,
  by: number,
): { x: number; y: number; px: Px; text: ImageText; layout: TextLayout } {
  const r = renderText(font, t, bx, by);
  return { ...r, text: { ...t, ox: r2(bx - r.x), oy: r2(by - r.y) } };
}

/** Where a text layer's box is in the picture (its top left, before the rotation). */
export const textOrigin = (l: { x: number; y: number; text?: ImageText }): [number, number] =>
  l.text ? [l.x + l.text.ox, l.y + l.text.oy] : [l.x, l.y];

/**
 * A text scaled by (sx, sy) and turned by `rotate` degrees more (the free transform, a resized
 * picture): the size follows the scale (both axes' mean), a paragraph's box each axis.
 */
export function scaledText(t: ImageText, sx: number, sy: number, rotate = 0): ImageText {
  const k = Math.sqrt(Math.abs(sx * sy));
  let rot = ((((t.rotate ?? 0) + rotate) % 360) + 360) % 360;
  if (rot > 180) rot -= 360;
  const out: ImageText = {
    ...t,
    size: Math.max(1, Math.min(4000, r2(t.size * k))),
    ...(t.box && {
      box: {
        w: Math.max(1, r2(t.box.w * Math.abs(sx))),
        h: Math.max(1, r2(t.box.h * Math.abs(sy))),
      },
    }),
  };
  if (Math.abs(rot) > 1e-6) out.rotate = r2(rot);
  else delete out.rotate;
  return out;
}

// ---------------------------------------------------------------- OpenRaster

/** The attributes of stack.xml that keep a text layer's text (others see a raster layer). */
export const TEXT_ATTRS = [
  "redgiant-text",
  "redgiant-text-font",
  "redgiant-text-size",
  "redgiant-text-color",
  "redgiant-text-align",
  "redgiant-text-bold",
  "redgiant-text-italic",
  "redgiant-text-line-height",
  "redgiant-text-box",
  "redgiant-text-x",
  "redgiant-text-y",
  "redgiant-text-rotate",
] as const;

export function textAttrs(t: ImageText): Record<string, string> {
  return {
    "redgiant-text": t.text,
    "redgiant-text-font": t.font,
    "redgiant-text-size": String(t.size),
    "redgiant-text-color": t.color,
    "redgiant-text-align": t.align,
    "redgiant-text-bold": String(t.bold),
    "redgiant-text-italic": String(t.italic),
    "redgiant-text-line-height": String(t.lineHeight),
    ...(t.box && { "redgiant-text-box": `${t.box.w} ${t.box.h}` }),
    "redgiant-text-x": String(t.ox),
    "redgiant-text-y": String(t.oy),
    ...(t.rotate && { "redgiant-text-rotate": String(t.rotate) }),
  };
}

/** A layer's text from its attributes (undefined: not a text layer, or not one we can read). */
export function textOfAttrs(a: Record<string, string | undefined>): ImageText | undefined {
  const text = a["redgiant-text"];
  if (text === undefined) return undefined;
  const n = (k: string, d: number) => {
    const v = Number(a[k]);
    return a[k] !== undefined && Number.isFinite(v) ? v : d;
  };
  const box = (a["redgiant-text-box"] ?? "").trim().split(/\s+/).map(Number);
  const rotate = n("redgiant-text-rotate", 0);
  const r = ImageText.safeParse({
    text,
    font: a["redgiant-text-font"] || DEFAULT_TEXT.font,
    size: n("redgiant-text-size", DEFAULT_TEXT.size),
    color: a["redgiant-text-color"] ?? DEFAULT_TEXT.color,
    align: a["redgiant-text-align"] ?? "left",
    bold: a["redgiant-text-bold"] === "true",
    italic: a["redgiant-text-italic"] === "true",
    lineHeight: n("redgiant-text-line-height", DEFAULT_TEXT.lineHeight),
    ...(box.length === 2 && box.every((v) => v > 0) && { box: { w: box[0], h: box[1] } }),
    ox: n("redgiant-text-x", 0),
    oy: n("redgiant-text-y", 0),
    ...(rotate && { rotate }),
  });
  return r.success ? r.data : undefined;
}

/**
 * A text's outlines as polygons, its top left at (x, y), lines one under the other (the agent's
 * text drawn on an existing layer, as before p3.5.8).
 */
export function textPolys(
  font: Font,
  text: string,
  size: number,
  x: number,
  y: number,
  align: "left" | "center" | "right" = "left",
  lineHeight = 1.2,
): { polys: number[][]; w: number; h: number } {
  const k = size / font.unitsPerEm;
  const lines = text.split(/\r?\n/);
  const widths = lines.map((l) => advanceOf(font, l, k));
  const w = Math.max(0, ...widths);
  const step = size * lineHeight;
  const polys: number[][] = [];
  lines.forEach((line, i) => {
    const lw = widths[i] as number;
    let pen = x + (align === "center" ? (w - lw) / 2 : align === "right" ? w - lw : 0);
    const base = y + i * step + font.ascender * k;
    for (const ch of line) {
      const g = font.glyphOf(ch.codePointAt(0) ?? 0);
      for (const c of g.contours) {
        const p = contourPoly(c, k, pen, base);
        if (p.length >= 6) polys.push(p);
      }
      pen += g.advance * k;
    }
  });
  return {
    polys,
    w,
    h: lines.length ? (lines.length - 1) * step + (font.ascender - font.descender) * k : 0,
  };
}
