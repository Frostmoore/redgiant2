// Drawing on a layer's pixels on the server (G37.5), for the agents' operations: polygons filled
// with anti-aliasing (the coverage of each pixel, four lines of samples per row, the exact width
// of every span), shapes and strokes made of polygons, text from a TrueType font's own outlines
// (Liberation Sans, which pdf.js carries: no canvas and no native module on the server), areas
// for selections, and transforms (scale, rotate, flip) sampled bilinearly.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { blank, type Rgba } from "./model.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How much of each pixel of a rectangle a shape covers, 0…1. */
export interface Cov extends Rect {
  a: Float32Array;
}

const SUB = 4;

/** Polygons (each x, y, x, y…) filled with the non-zero rule, inside `clip`. */
export function fillPolys(polys: readonly number[][], clip: Rect): Cov | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of polys)
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i] as number;
      const y = p[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  const x0 = Math.max(clip.x, Math.floor(minX));
  const y0 = Math.max(clip.y, Math.floor(minY));
  const x1 = Math.min(clip.x + clip.w, Math.ceil(maxX));
  const y1 = Math.min(clip.y + clip.h, Math.ceil(maxY));
  if (!(x1 > x0 && y1 > y0)) return undefined;
  const w = x1 - x0;
  const h = y1 - y0;
  // Edges by the rows they cross.
  type Edge = { ya: number; yb: number; xa: number; k: number; dir: number };
  const rows: Edge[][] = Array.from({ length: h }, () => []);
  for (const p of polys) {
    const n = Math.floor(p.length / 2);
    for (let i = 0; i < n; i++) {
      const ax = p[i * 2] as number;
      const ay = p[i * 2 + 1] as number;
      const bx = p[((i + 1) % n) * 2] as number;
      const by = p[((i + 1) % n) * 2 + 1] as number;
      if (ay === by) continue;
      const e: Edge =
        ay < by
          ? { ya: ay, yb: by, xa: ax, k: (bx - ax) / (by - ay), dir: 1 }
          : { ya: by, yb: ay, xa: bx, k: (ax - bx) / (ay - by), dir: -1 };
      const r0 = Math.max(0, Math.floor(e.ya) - y0);
      const r1 = Math.min(h - 1, Math.ceil(e.yb) - 1 - y0);
      for (let r = r0; r <= r1; r++) (rows[r] as Edge[]).push(e);
    }
  }
  const a = new Float32Array(w * h);
  const xs: { x: number; dir: number }[] = [];
  for (let r = 0; r < h; r++) {
    const list = rows[r] as Edge[];
    if (!list.length) continue;
    for (let s = 0; s < SUB; s++) {
      const sy = y0 + r + (s + 0.5) / SUB;
      xs.length = 0;
      for (const e of list)
        if (sy >= e.ya && sy < e.yb) xs.push({ x: e.xa + (sy - e.ya) * e.k, dir: e.dir });
      if (xs.length < 2) continue;
      xs.sort((p, q) => p.x - q.x);
      let wind = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += (xs[i] as { dir: number }).dir;
        if (wind === 0) continue;
        const sx = Math.max(x0, (xs[i] as { x: number }).x);
        const ex = Math.min(x1, (xs[i + 1] as { x: number }).x);
        if (ex <= sx) continue;
        const base = r * w - x0;
        for (let px = Math.floor(sx); px < Math.ceil(ex); px++) {
          const cover = Math.min(px + 1, ex) - Math.max(px, sx);
          if (cover > 0) a[base + px] = (a[base + px] as number) + cover / SUB;
        }
      }
    }
  }
  for (let i = 0; i < a.length; i++) if ((a[i] as number) > 1) a[i] = 1;
  return { x: x0, y: y0, w, h, a };
}

const area = (p: number[]) => {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s +=
      (p[i * 2] as number) * (p[j * 2 + 1] as number) -
      (p[j * 2] as number) * (p[i * 2 + 1] as number);
  }
  return s / 2;
};
/** The same polygon turning the same way as every other (their overlaps then add up). */
const ccw = (p: number[]): number[] => {
  if (area(p) >= 0) return p;
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i] as number, p[i + 1] as number);
  return out;
};

export const rectPoly = (x: number, y: number, w: number, h: number) => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

export function ellipsePoly(cx: number, cy: number, rx: number, ry: number): number[] {
  const n = Math.max(24, Math.min(360, Math.round((Math.abs(rx) + Math.abs(ry)) * 1.5)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
  }
  return out;
}

/** A line through points, `width` wide, with round ends and joins (closed: back to the start). */
export function strokePolys(
  points: readonly [number, number][],
  width: number,
  closed = false,
): number[][] {
  const r = width / 2;
  const out: number[][] = [];
  if (!points.length || r <= 0) return out;
  const pts = closed && points.length > 2 ? [...points, points[0] as [number, number]] : points;
  for (const [x, y] of pts) out.push(ccw(ellipsePoly(x, y, r, r)));
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[i + 1] as [number, number];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const nx = (-(by - ay) / len) * r;
    const ny = ((bx - ax) / len) * r;
    out.push(ccw([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]));
  }
  return out;
}

/** A stroke along a polygon's or a rectangle's outline, centred on it. */
export const outlinePolys = (p: number[], width: number) => {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < p.length; i += 2) pts.push([p[i] as number, p[i + 1] as number]);
  return strokePolys(pts, width, true);
};

/** A colour drawn through a coverage on a layer at (lx, ly): over its pixels, or erasing them. */
export function paintCov(
  px: Rgba,
  lx: number,
  ly: number,
  cov: Cov,
  rgba: [number, number, number, number],
  mode: "over" | "erase" = "over",
): void {
  const [r, g, b, alpha] = rgba;
  for (let y = 0; y < cov.h; y++) {
    const py = cov.y + y - ly;
    if (py < 0 || py >= px.height) continue;
    for (let x = 0; x < cov.w; x++) {
      const c = cov.a[y * cov.w + x] as number;
      if (c <= 0) continue;
      const pxx = cov.x + x - lx;
      if (pxx < 0 || pxx >= px.width) continue;
      const i = (py * px.width + pxx) * 4;
      const sa = (alpha / 255) * c;
      const da = (px.data[i + 3] as number) / 255;
      if (mode === "erase") {
        px.data[i + 3] = Math.round(da * (1 - sa) * 255);
        continue;
      }
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      px.data[i] = Math.round((r * sa + (px.data[i] as number) * da * (1 - sa)) / oa);
      px.data[i + 1] = Math.round((g * sa + (px.data[i + 1] as number) * da * (1 - sa)) / oa);
      px.data[i + 2] = Math.round((b * sa + (px.data[i + 2] as number) * da * (1 - sa)) / oa);
      px.data[i + 3] = Math.round(oa * 255);
    }
  }
}

/** Every pixel of a rectangle covered (an area without a shape: the whole layer). */
export const fullCov = (r: Rect): Cov => ({ ...r, a: new Float32Array(r.w * r.h).fill(1) });

/** The coverage at a picture's pixel (0 outside). */
export const covAt = (c: Cov, x: number, y: number) =>
  x < c.x || y < c.y || x >= c.x + c.w || y >= c.y + c.h
    ? 0
    : (c.a[(y - c.y) * c.w + (x - c.x)] as number);

// ---------------------------------------------------------------- Colours

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  lime: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  gray: "#808080",
  grey: "#808080",
  brown: "#a52a2a",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  navy: "#000080",
  teal: "#008080",
  transparent: "#00000000",
};

/** "#rgb", "#rrggbb", "#rrggbbaa", rgb()/rgba() or a common name, as RGBA 0…255. */
export function parseColor(v: unknown): [number, number, number, number] | undefined {
  if (typeof v !== "string") return undefined;
  let s = v.trim().toLowerCase();
  s = NAMED[s] ?? s;
  let m = s.match(/^#([0-9a-f]{3,4})$/);
  if (m?.[1]) {
    const d = m[1].split("").map((c) => Number.parseInt(c + c, 16));
    return [d[0] as number, d[1] as number, d[2] as number, d[3] ?? 255];
  }
  m = s.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? Number.parseInt(m[2], 16) : 255];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const c = (x: string | undefined) => Math.max(0, Math.min(255, Math.round(Number(x))));
    const a =
      m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [c(m[1]), c(m[2]), c(m[3]), Math.max(0, Math.min(255, Math.round(a * 255)))];
  }
  return undefined;
}

// ---------------------------------------------------------------- Transforms

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** Scale (and flip), then rotate (degrees, clockwise on the screen), around a point. */
export function affineAround(
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  angle: number,
): Affine {
  const t = (angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  // x' = R·S·(x - c) + c
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  return { a, b, c, d, e: cx - a * cx - c * cy, f: cy - b * cx - d * cy };
}

/**
 * A buffer at (x, y) of the picture drawn through an affine map (picture coordinates), as a
 * new buffer at its new place: bilinear sampling on premultiplied colours, `outside` for what
 * falls outside the source (0: transparent; a mask's own value).
 */
export function transformBuffer(
  src: Rgba,
  x: number,
  y: number,
  m: Affine,
  grey = false,
  outside = 0,
): { px: Rgba; x: number; y: number } {
  const corners = [
    [x, y],
    [x + src.width, y],
    [x, y + src.height],
    [x + src.width, y + src.height],
  ].map(([u, v]) => [
    m.a * (u as number) + m.c * (v as number) + m.e,
    m.b * (u as number) + m.d * (v as number) + m.f,
  ]);
  const nx = Math.floor(Math.min(...corners.map((p) => p[0] as number)) + 1e-6);
  const ny = Math.floor(Math.min(...corners.map((p) => p[1] as number)) + 1e-6);
  const nw = Math.max(0, Math.ceil(Math.max(...corners.map((p) => p[0] as number)) - 1e-6) - nx);
  const nh = Math.max(0, Math.ceil(Math.max(...corners.map((p) => p[1] as number)) - 1e-6) - ny);
  const det = m.a * m.d - m.b * m.c;
  if (!det || nw * nh === 0 || nw > 40_000 || nh > 40_000) return { px: blank(0, 0), x: nx, y: ny };
  // The inverse map.
  const ia = m.d / det;
  const ib = -m.b / det;
  const ic = -m.c / det;
  const id = m.a / det;
  const ie = -(ia * m.e + ic * m.f);
  const iff = -(ib * m.e + id * m.f);
  const out = blank(nw, nh);
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const sample = (sx: number, sy: number, ch: number): [number, number] => {
    // Returns [premultiplied channel, alpha] at a source pixel (outside: the given value).
    if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) return grey ? [outside, 255] : [0, 0];
    const i = (sy * sw + sx) * 4;
    const al = s[i + 3] as number;
    return [((s[i + ch] as number) * al) / 255, al];
  };
  for (let v = 0; v < nh; v++)
    for (let u = 0; u < nw; u++) {
      const px = nx + u + 0.5;
      const py = ny + v + 0.5;
      const qx = ia * px + ic * py + ie - x - 0.5;
      const qy = ib * px + id * py + iff - y - 0.5;
      const fx = Math.floor(qx);
      const fy = Math.floor(qy);
      if (fx < -1 || fy < -1 || fx >= sw || fy >= sh) {
        if (grey) out.data.set([outside, outside, outside, 255], (v * nw + u) * 4);
        continue;
      }
      const tx = qx - fx;
      const ty = qy - fy;
      const o = (v * nw + u) * 4;
      let alpha = 0;
      const acc = [0, 0, 0];
      for (const [dx, dy, wgt] of [
        [0, 0, (1 - tx) * (1 - ty)],
        [1, 0, tx * (1 - ty)],
        [0, 1, (1 - tx) * ty],
        [1, 1, tx * ty],
      ] as const) {
        if (wgt === 0) continue;
        for (let ch = 0; ch < 3; ch++)
          acc[ch] = (acc[ch] as number) + sample(fx + dx, fy + dy, ch)[0] * wgt;
        alpha += sample(fx + dx, fy + dy, 0)[1] * wgt;
      }
      if (alpha <= 0.001) continue;
      for (let ch = 0; ch < 3; ch++)
        out.data[o + ch] = Math.max(
          0,
          Math.min(255, Math.round(((acc[ch] as number) * 255) / alpha)),
        );
      out.data[o + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    }
  return { px: out, x: nx, y: ny };
}

// ---------------------------------------------------------------- TrueType text

interface Glyph {
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
function contourPoly(c: Glyph["contours"][number], k: number, ox: number, oy: number): number[] {
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

/** A text's outlines as polygons, its top left at (x, y), lines one under the other. */
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
  const widths = lines.map(
    (l) => [...l].reduce((s, ch) => s + font.glyphOf(ch.codePointAt(0) ?? 0).advance, 0) * k,
  );
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

/** The fonts the server draws text with (pdf.js's standard ones). */
export const FONTS = {
  sans: "LiberationSans-Regular.ttf",
  "sans-bold": "LiberationSans-Bold.ttf",
  "sans-italic": "LiberationSans-Italic.ttf",
  "sans-bold-italic": "LiberationSans-BoldItalic.ttf",
} as const;
export type FontName = keyof typeof FONTS;

const loaded = new Map<string, Font>();
export function fontNamed(name: FontName): Font {
  const have = loaded.get(name);
  if (have) return have;
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  const f = readTrueType(new Uint8Array(readFileSync(join(dir, FONTS[name]))));
  loaded.set(name, f);
  return f;
}
