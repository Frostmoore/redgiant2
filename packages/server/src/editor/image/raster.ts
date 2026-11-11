// Drawing on a layer's pixels on the server (G37.5), for the agents' operations: polygons filled
// with anti-aliasing (the coverage of each pixel, four lines of samples per row, the exact width
// of every span), shapes and strokes made of polygons, text from a TrueType font's own outlines
// (Liberation Sans, which pdf.js carries: no canvas and no native module on the server), areas
// for selections, and transforms (scale, rotate, flip) sampled bilinearly.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Font, readTrueType, TEXT_FONT_FILES, textFontFile } from "@redgiant/protocol";
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

// The reader and the lines are the protocol's, shared with the page (p3.5.8).
export { type Font, readTrueType, textPolys } from "@redgiant/protocol";

/** The fonts the server draws text with (pdf.js's standard ones). */
export const FONTS = {
  sans: "LiberationSans-Regular.ttf",
  "sans-bold": "LiberationSans-Bold.ttf",
  "sans-italic": "LiberationSans-Italic.ttf",
  "sans-bold-italic": "LiberationSans-BoldItalic.ttf",
} as const;
export type FontName = keyof typeof FONTS;

const loaded = new Map<string, Font>();

/** The folder of pdf.js's standard fonts (Liberation Sans). */
const fontsDir = () => {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
};

/** The fonts the server carries (p3.5.8, packages/server/fonts, LICENSES.md there). */
const ownFonts = fileURLToPath(new URL("../../../fonts/", import.meta.url));

/**
 * A font file of `TEXT_FONTS` as bytes (what the page gets too): the server's own, or pdf.js's
 * (Liberation Sans); undefined when unknown.
 */
export function textFontBytes(file: string): Uint8Array | undefined {
  if (!TEXT_FONT_FILES.includes(file)) return undefined;
  const own = join(ownFonts, file);
  return new Uint8Array(readFileSync(existsSync(own) ? own : join(fontsDir(), file)));
}

function fontOfFile(file: string): Font {
  const have = loaded.get(file);
  if (have) return have;
  const bytes = textFontBytes(file);
  if (!bytes) throw new Error(`there is no font ${file}`);
  const f = readTrueType(bytes);
  loaded.set(file, f);
  return f;
}

export const fontNamed = (name: FontName): Font => fontOfFile(FONTS[name]);

/** The font of a text layer's family and style. */
export const textFont = (font: string, bold: boolean, italic: boolean): Font =>
  fontOfFile(textFontFile(font, bold, italic));
