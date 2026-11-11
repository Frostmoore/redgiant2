// The layered picture editor's pixel work (G37.5, p3.5.7), pure functions on RGBA pixels (8 bits,
// straight alpha) that the page and the server share: polygons filled with anti-aliasing,
// selections (a coverage per pixel of the picture, combined as Photoshop does: new, add,
// subtract, intersect; feathered; their outline for the marching ants), the magic wand and the
// quick selection (colours grown from a point or a brush), the paint bucket, gradients, the
// clone stamp, and the Move tool's selected pixels (cut once, put down anywhere, the layer under
// them kept until the selection is let go). No canvas: the results are exact and tested.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA pixels, straight alpha. */
export interface Px {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** How much of each pixel of a rectangle a shape covers, 0…1. */
export interface Cov extends Rect {
  a: Float32Array;
}

/** A selection: how much of each pixel of the picture is selected, 0…255. */
export interface Sel {
  width: number;
  height: number;
  a: Uint8Array;
}

export type SelMode = "new" | "add" | "subtract" | "intersect";

export type RGBA = [number, number, number, number];

const SUB = 4;

export const blankPx = (w: number, h: number): Px => ({
  width: Math.max(0, w),
  height: Math.max(0, h),
  data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4),
});

export const emptySel = (w: number, h: number): Sel => ({
  width: w,
  height: h,
  a: new Uint8Array(w * h),
});

// ---------------------------------------------------------------- Polygons

/** Polygons (each x, y, x, y…) filled with the non-zero rule, inside `clip` (anti-aliased). */
export function fillPolys(
  polys: readonly number[][],
  clip: Rect,
  antialias = true,
): Cov | undefined {
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
  const sub = antialias ? SUB : 1;
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
    for (let s = 0; s < sub; s++) {
      const sy = y0 + r + (s + 0.5) / sub;
      xs.length = 0;
      for (const e of list)
        if (sy >= e.ya && sy < e.yb) xs.push({ x: e.xa + (sy - e.ya) * e.k, dir: e.dir });
      if (xs.length < 2) continue;
      xs.sort((p, q) => p.x - q.x);
      let wind = 0;
      const base = r * w - x0;
      for (let i = 0; i < xs.length - 1; i++) {
        wind += (xs[i] as { dir: number }).dir;
        if (wind === 0) continue;
        const sx = Math.max(x0, (xs[i] as { x: number }).x);
        const ex = Math.min(x1, (xs[i + 1] as { x: number }).x);
        if (ex <= sx) continue;
        if (!antialias) {
          // A pixel is in when its centre is.
          for (let px = Math.ceil(sx - 0.5); px < Math.ceil(ex - 0.5); px++)
            if (px >= x0 && px < x1) a[base + px] = 1;
          continue;
        }
        for (let px = Math.floor(sx); px < Math.ceil(ex); px++) {
          const cover = Math.min(px + 1, ex) - Math.max(px, sx);
          if (cover > 0) a[base + px] = (a[base + px] as number) + cover / sub;
        }
      }
    }
  }
  for (let i = 0; i < a.length; i++) if ((a[i] as number) > 1) a[i] = 1;
  return { x: x0, y: y0, w, h, a };
}

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
  const n = Math.max(24, Math.min(720, Math.round((Math.abs(rx) + Math.abs(ry)) * 1.5)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(t) * rx, cy + Math.sin(t) * ry);
  }
  return out;
}

/** A colour drawn through a coverage on a layer at (lx, ly): over its pixels, or erasing them. */
export function paintCov(
  px: Px,
  lx: number,
  ly: number,
  cov: Cov,
  rgba: RGBA,
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
      if (mode === "erase") {
        px.data[i + 3] = Math.round((px.data[i + 3] as number) * (1 - sa));
        continue;
      }
      blendOver(px.data, i, r, g, b, sa);
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

/** A colour of alpha `sa` (0…1) over the pixel at `i` (straight alpha, rounded once). */
function blendOver(
  d: Uint8Array | Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
  sa: number,
): void {
  if (sa <= 0) return;
  const da = (d[i + 3] as number) / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  const k = da * (1 - sa);
  d[i] = Math.round((r * sa + (d[i] as number) * k) / oa);
  d[i + 1] = Math.round((g * sa + (d[i + 1] as number) * k) / oa);
  d[i + 2] = Math.round((b * sa + (d[i + 2] as number) * k) / oa);
  d[i + 3] = Math.round(oa * 255);
}

// ---------------------------------------------------------------- Selections

/** The selection of polygons (the lasso, the marquees), anti-aliased or not. */
export function selOfPolys(
  width: number,
  height: number,
  polys: readonly number[][],
  antialias = true,
): Sel {
  const s = emptySel(width, height);
  const cov = fillPolys(polys, { x: 0, y: 0, w: width, h: height }, antialias);
  if (!cov) return s;
  for (let y = 0; y < cov.h; y++)
    for (let x = 0; x < cov.w; x++) {
      const v = cov.a[y * cov.w + x] as number;
      if (v > 0) s.a[(cov.y + y) * width + cov.x + x] = Math.round(v * 255);
    }
  return s;
}

/** A rectangle's selection (whole pixels: the marquee snaps to them, as Photoshop's). */
export function selOfRect(width: number, height: number, r: Rect): Sel {
  const s = emptySel(width, height);
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(width, Math.round(r.x + r.w));
  const y1 = Math.min(height, Math.round(r.y + r.h));
  for (let y = y0; y < y1; y++) s.a.fill(255, y * width + x0, y * width + x1);
  return s;
}

/** An ellipse's selection inside a rectangle. */
export const selOfEllipse = (width: number, height: number, r: Rect, antialias = true): Sel =>
  selOfPolys(
    width,
    height,
    [ellipsePoly(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2)],
    antialias,
  );

/** A new selection combined with the one there is (none: `undefined`, or empty). */
export function combineSel(mode: SelMode, was: Sel | undefined, next: Sel): Sel | undefined {
  let out: Sel;
  if (mode === "new" || !was) {
    if (mode === "subtract" || mode === "intersect") return undefined;
    out = next;
  } else {
    out = emptySel(next.width, next.height);
    const a = was.a;
    const b = next.a;
    for (let i = 0; i < out.a.length; i++) {
      const x = a[i] as number;
      const y = b[i] as number;
      out.a[i] =
        mode === "add"
          ? Math.max(x, y)
          : mode === "subtract"
            ? Math.round((x * (255 - y)) / 255)
            : Math.round((x * y) / 255);
    }
  }
  return selBounds(out) ? out : undefined;
}

/** The selection the other way round. */
export function invertSel(s: Sel): Sel {
  const out = emptySel(s.width, s.height);
  for (let i = 0; i < s.a.length; i++) out.a[i] = 255 - (s.a[i] as number);
  return out;
}

/** The box of the selected pixels, or undefined when none is. */
export function selBounds(s: Sel): Rect | undefined {
  const { width: w, height: h, a } = s;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1;
    for (let x = 0; x < w; x++)
      if (a[row + x]) {
        first = x;
        break;
      }
    if (first < 0) continue;
    let last = first;
    for (let x = w - 1; x > first; x--)
      if (a[row + x]) {
        last = x;
        break;
      }
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Whether a pixel is selected (at least half). */
export const inSel = (s: Sel, x: number, y: number) => {
  const px = Math.floor(x);
  const py = Math.floor(y);
  return (
    px >= 0 && py >= 0 && px < s.width && py < s.height && (s.a[py * s.width + px] as number) >= 128
  );
};

/** A selection moved by whole pixels (what leaves the picture is lost). */
export function shiftSel(s: Sel, dx: number, dy: number): Sel {
  const out = emptySel(s.width, s.height);
  const { width: w, height: h } = s;
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    const x0 = Math.max(0, dx);
    const x1 = Math.min(w, w + dx);
    if (x1 <= x0) continue;
    out.a.set(s.a.subarray(sy * w + x0 - dx, sy * w + x1 - dx), y * w + x0);
  }
  return out;
}

/** Feathered edges: three box blurs of `radius` (close to a Gaussian, as Photoshop's feather). */
export function featherSel(s: Sel, radius: number): Sel {
  const r = Math.round(radius);
  if (r < 1) return s;
  const { width: w, height: h } = s;
  const cur = new Float32Array(s.a);
  const tmp = new Float32Array(w * h);
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const n = horizontal ? w : h;
    const lines = horizontal ? h : w;
    const step = horizontal ? 1 : w;
    for (let l = 0; l < lines; l++) {
      const base = horizontal ? l * w : l;
      let sum = 0;
      // Outside the picture counts as what the edge holds.
      const at = (k: number) => src[base + Math.max(0, Math.min(n - 1, k)) * step] as number;
      for (let k = -r; k <= r; k++) sum += at(k);
      for (let k = 0; k < n; k++) {
        dst[base + k * step] = sum / (2 * r + 1);
        sum += at(k + r + 1) - at(k - r);
      }
    }
  };
  for (let i = 0; i < 3; i++) {
    pass(cur, tmp, true);
    pass(tmp, cur, false);
  }
  const out = emptySel(w, h);
  for (let i = 0; i < out.a.length; i++) out.a[i] = Math.round(cur[i] as number);
  return out;
}

/**
 * The selection's outline along the pixels' edges (at least half selected inside), as segments
 * x0, y0, x1, y1 (runs joined), for the marching ants.
 */
export function selOutline(s: Sel): Float32Array {
  const { width: w, height: h, a } = s;
  const segs: number[] = [];
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && (a[y * w + x] as number) >= 128;
  // Horizontal edges: between rows y-1 and y.
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y - 1) !== on(x, y);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        segs.push(start, y, x, y);
        start = -1;
      }
    }
  }
  // Vertical edges: between columns x-1 and x.
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x - 1, y) !== on(x, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        segs.push(x, start, x, y);
        start = -1;
      }
    }
  }
  return Float32Array.from(segs);
}

// ---------------------------------------------------------------- Colours grown from a point

/** Whether two pixels are within `tol` of each other on every channel (Photoshop's tolerance). */
const near = (d: Uint8Array | Uint8ClampedArray, i: number, ref: RGBA, tol: number) =>
  Math.abs((d[i] as number) - ref[0]) <= tol &&
  Math.abs((d[i + 1] as number) - ref[1]) <= tol &&
  Math.abs((d[i + 2] as number) - ref[2]) <= tol &&
  Math.abs((d[i + 3] as number) - ref[3]) <= tol;

/**
 * The magic wand (and the paint bucket's area): the pixels of a picture-sized `px` within `tol`
 * of the colour at (x, y), joined to it (contiguous, 4 neighbours) or anywhere.
 */
export function wandSel(
  px: Px,
  x: number,
  y: number,
  tol: number,
  contiguous = true,
  antialias = false,
): Sel {
  const { width: w, height: h, data: d } = px;
  const s = emptySel(w, h);
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return s;
  const i0 = (sy * w + sx) * 4;
  const ref: RGBA = [
    d[i0] as number,
    d[i0 + 1] as number,
    d[i0 + 2] as number,
    d[i0 + 3] as number,
  ];
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (near(d, p * 4, ref, tol)) s.a[p] = 255;
  } else growInto(s, px, [sy * w + sx], (i) => near(d, i, ref, tol));
  return antialias ? softenEdges(s) : s;
}

/** A scanline flood from seeds (pixel indices) over the pixels `ok` accepts (by byte index). */
function growInto(s: Sel, px: Px, seeds: number[], ok: (i: number) => boolean): void {
  const { width: w, height: h } = px;
  const stack = seeds.filter((p) => !s.a[p] && ok(p * 4));
  while (stack.length) {
    const p = stack.pop() as number;
    if (s.a[p]) continue;
    const y = Math.floor(p / w);
    let l = p % w;
    let r = l;
    while (l > 0 && !s.a[y * w + l - 1] && ok((y * w + l - 1) * 4)) l--;
    while (r < w - 1 && !s.a[y * w + r + 1] && ok((y * w + r + 1) * 4)) r++;
    s.a.fill(255, y * w + l, y * w + r + 1);
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let open = false;
      for (let x = l; x <= r; x++) {
        const q = ny * w + x;
        const can = !s.a[q] && ok(q * 4);
        if (can && !open) stack.push(q);
        open = can;
      }
    }
  }
}

/** Edge pixels outside a hard selection half selected (the wand's "anti-alias"). */
function softenEdges(s: Sel): Sel {
  const { width: w, height: h, a } = s;
  const out = emptySel(w, h);
  out.a.set(a);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (a[i]) continue;
      let n = 0;
      if (x > 0 && a[i - 1]) n++;
      if (x < w - 1 && a[i + 1]) n++;
      if (y > 0 && a[i - w]) n++;
      if (y < h - 1 && a[i + w]) n++;
      if (n) out.a[i] = Math.min(255, 64 * n);
    }
  return out;
}

/**
 * The quick selection's grow: from every pixel under a round brush at (x, y), the pixels joined
 * to them whose colour is within `tol` of one of the colours under the brush (sampled, at most
 * 24), added to `into`.
 */
export function quickSel(
  px: Px,
  x: number,
  y: number,
  radius: number,
  tol: number,
  into: Sel,
): Sel {
  const { width: w, height: h, data: d } = px;
  const out = emptySel(w, h);
  out.a.set(into.a);
  const seeds: number[] = [];
  const refs: RGBA[] = [];
  const r = Math.max(0.5, radius);
  const step = Math.max(1, Math.floor(r / 3));
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++)
    for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      if ((xx + 0.5 - x) ** 2 + (yy + 0.5 - y) ** 2 > r * r) continue;
      const p = yy * w + xx;
      seeds.push(p);
      out.a[p] = 0;
      if (
        refs.length < 24 &&
        (xx - Math.floor(x - r)) % step === 0 &&
        (yy - Math.floor(y - r)) % step === 0
      ) {
        const i = p * 4;
        refs.push([d[i] as number, d[i + 1] as number, d[i + 2] as number, d[i + 3] as number]);
      }
    }
  if (!seeds.length) return out;
  const grown = emptySel(w, h);
  growInto(grown, px, seeds, (i) => refs.some((c) => near(d, i, c, tol)));
  for (const p of seeds) grown.a[p] = 255;
  for (let i = 0; i < out.a.length; i++) if (grown.a[i] || into.a[i]) out.a[i] = 255;
  return out;
}

// ---------------------------------------------------------------- Painting through a selection

/** A layer's pixels and its place in the picture. */
export interface Placed {
  x: number;
  y: number;
  px: Px;
}

/** The layer's pixels laid on a picture-sized buffer (transparent where it is not). */
export function onPicture(l: Placed, width: number, height: number): Px {
  const out = blankPx(width, height);
  const x0 = Math.max(0, l.x);
  const x1 = Math.min(width, l.x + l.px.width);
  if (x1 <= x0) return out;
  for (let y = Math.max(0, l.y); y < Math.min(height, l.y + l.px.height); y++) {
    const from = ((y - l.y) * l.px.width + (x0 - l.x)) * 4;
    out.data.set(l.px.data.subarray(from, from + (x1 - x0) * 4), (y * width + x0) * 4);
  }
  return out;
}

/**
 * A colour over a layer where `area` is (the whole picture without one), with an opacity: the
 * Fill command and the paint bucket (its area from `wandSel`). The layer is picture-placed.
 */
export function fillThrough(l: Placed, area: Sel | undefined, rgba: RGBA, opacity = 1): void {
  const { width: lw, height: lh, data: d } = l.px;
  for (let y = 0; y < lh; y++) {
    const py = l.y + y;
    for (let x = 0; x < lw; x++) {
      const px = l.x + x;
      let c = opacity;
      if (area) {
        if (px < 0 || py < 0 || px >= area.width || py >= area.height) continue;
        c *= (area.a[py * area.width + px] as number) / 255;
      }
      if (c > 0) blendOver(d, (y * lw + x) * 4, rgba[0], rgba[1], rgba[2], (rgba[3] / 255) * c);
    }
  }
}

/** Where a selection is, transparent (or `fill`, a Background's colour). */
export function clearThrough(l: Placed, area: Sel, fill?: RGBA): void {
  const { width: lw, height: lh, data: d } = l.px;
  for (let y = 0; y < lh; y++) {
    const py = l.y + y;
    if (py < 0 || py >= area.height) continue;
    for (let x = 0; x < lw; x++) {
      const px = l.x + x;
      if (px < 0 || px >= area.width) continue;
      const m = (area.a[py * area.width + px] as number) / 255;
      if (m <= 0) continue;
      const i = (y * lw + x) * 4;
      if (fill) blendOver(d, i, fill[0], fill[1], fill[2], m);
      else {
        const a = Math.round((d[i + 3] as number) * (1 - m));
        if (a) d[i + 3] = a;
        else d.fill(0, i, i + 4);
      }
    }
  }
}

export interface GradientSpec {
  from: [number, number];
  to: [number, number];
  kind: "linear" | "radial";
  /** Colour at the start and at the end (the end may be transparent). */
  c0: RGBA;
  c1: RGBA;
  opacity?: number;
  /** The colours the other way round. */
  reverse?: boolean;
}

/** A gradient over a picture-placed layer, through a selection (the whole picture without). */
export function gradientThrough(l: Placed, area: Sel | undefined, g: GradientSpec): void {
  const [ax, ay] = g.from;
  const [bx, by] = g.to;
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const len = Math.sqrt(len2);
  const c0 = g.reverse ? g.c1 : g.c0;
  const c1 = g.reverse ? g.c0 : g.c1;
  const op = g.opacity ?? 1;
  const { width: lw, height: lh, data: d } = l.px;
  for (let y = 0; y < lh; y++) {
    const py = l.y + y;
    for (let x = 0; x < lw; x++) {
      const px = l.x + x;
      let m = op;
      if (area) {
        if (px < 0 || py < 0 || px >= area.width || py >= area.height) continue;
        m *= (area.a[py * area.width + px] as number) / 255;
      }
      if (m <= 0) continue;
      const cx = px + 0.5 - ax;
      const cy = py + 0.5 - ay;
      let t = g.kind === "linear" ? (cx * vx + cy * vy) / len2 : Math.sqrt(cx * cx + cy * cy) / len;
      t = Math.min(1, Math.max(0, t));
      // Straight colours mixed by their alpha (a fade to transparent keeps its colour).
      const a0 = c0[3] * (1 - t);
      const a1 = c1[3] * t;
      const a = a0 + a1;
      if (a <= 0) continue;
      const r = (c0[0] * a0 + c1[0] * a1) / a;
      const gg = (c0[1] * a0 + c1[1] * a1) / a;
      const b = (c0[2] * a0 + c1[2] * a1) / a;
      blendOver(d, (y * lw + x) * 4, r, gg, b, (a / 255) * m);
    }
  }
}

/**
 * The clone stamp: a picture-sized `src` seen through `cover` (the strokes' coverage, picture
 * sized, 0…255) with the source `off` pixels away from where it is painted, over the layer.
 */
export function stampThrough(
  l: Placed,
  src: Px,
  off: [number, number],
  cover: Sel,
  opacity = 1,
  area?: Sel,
): void {
  const { width: lw, height: lh, data: d } = l.px;
  const ox = Math.round(off[0]);
  const oy = Math.round(off[1]);
  for (let y = 0; y < lh; y++) {
    const py = l.y + y;
    if (py < 0 || py >= cover.height) continue;
    const sy = py + oy;
    if (sy < 0 || sy >= src.height) continue;
    for (let x = 0; x < lw; x++) {
      const px = l.x + x;
      if (px < 0 || px >= cover.width) continue;
      const sx = px + ox;
      if (sx < 0 || sx >= src.width) continue;
      const p = py * cover.width + px;
      let m = ((cover.a[p] as number) / 255) * opacity;
      if (area) m *= (area.a[p] as number) / 255;
      if (m <= 0) continue;
      const j = (sy * src.width + sx) * 4;
      blendOver(
        d,
        (y * lw + x) * 4,
        src.data[j] as number,
        src.data[j + 1] as number,
        src.data[j + 2] as number,
        ((src.data[j + 3] as number) / 255) * m,
      );
    }
  }
}

// ---------------------------------------------------------------- The Move tool's pixels

/**
 * A layer's selected pixels, cut once (`float`) and put down `dx`, `dy` away (`floatAt`): the
 * piece over the layer with its hole, the layer grown (inside the picture) when the piece lands
 * beyond it. The hole is exactly the selection (its soft edges too), transparent, or `fill`
 * (a Background's colour); with `copy` (Alt) there is none. Moving again while the selection is
 * held starts from the same cut: what the piece covered on the way comes back (as Photoshop's
 * floating pixels, p3.5.7: before, every drop was final and the next drag cut a new hole there).
 */
export interface Floating {
  /** The layer as it was before the cut. */
  base: Placed;
  /** The selected pixels, picture-sized (their alpha times the selection). */
  piece: Px;
  /** Where the selected pixels are (a box of the picture). */
  box: Rect;
  sel: Sel;
  copy: boolean;
  fill?: RGBA | undefined;
}

export function float(base: Placed, sel: Sel, copy = false, fill?: RGBA): Floating {
  const { width: w, height: h } = sel;
  const piece = onPicture(base, w, h);
  const d = piece.data;
  for (let p = 0; p < w * h; p++) {
    const m = sel.a[p] as number;
    if (m === 255) continue;
    d[p * 4 + 3] = Math.round(((d[p * 4 + 3] as number) * m) / 255);
  }
  const box = selBounds(sel) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { base: copyPlaced(base), piece, box, sel, copy, ...(fill && { fill }) };
}

export const copyPlaced = (l: Placed): Placed => ({
  x: l.x,
  y: l.y,
  px: { width: l.px.width, height: l.px.height, data: new Uint8ClampedArray(l.px.data) },
});

/** The layer with the floating pixels put down `dx`, `dy` from where they were cut. */
export function floatAt(f: Floating, dx: number, dy: number): Placed {
  const { width: W, height: H } = f.sel;
  const b = f.base;
  // The layer grows to hold the piece (inside the picture).
  const land = inter(
    { x: f.box.x + dx, y: f.box.y + dy, w: f.box.w, h: f.box.h },
    { x: 0, y: 0, w: W, h: H },
  );
  const here = { x: b.x, y: b.y, w: b.px.width, h: b.px.height };
  const r = land && !contains(here, land) ? union(here, land) : here;
  const out: Placed = { x: r.x, y: r.y, px: blankPx(r.w, r.h) };
  for (let y = 0; y < b.px.height; y++) {
    const from = y * b.px.width * 4;
    out.px.data.set(
      b.px.data.subarray(from, from + b.px.width * 4),
      ((b.y - r.y + y) * r.w + (b.x - r.x)) * 4,
    );
  }
  if (!f.copy) clearThrough(out, f.sel, f.fill);
  if (!land) return out;
  const d = out.px.data;
  const s = f.piece.data;
  for (let y = land.y; y < land.y + land.h; y++)
    for (let x = land.x; x < land.x + land.w; x++) {
      const j = ((y - dy) * W + (x - dx)) * 4;
      const sa = s[j + 3] as number;
      if (!sa) continue;
      blendOver(
        d,
        ((y - r.y) * r.w + (x - r.x)) * 4,
        s[j] as number,
        s[j + 1] as number,
        s[j + 2] as number,
        sa / 255,
      );
    }
  return out;
}

// ---------------------------------------------------------------- Rectangles

export function inter(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : undefined;
}

export function union(a: Rect, b: Rect): Rect {
  if (!a.w || !a.h) return b;
  if (!b.w || !b.h) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const contains = (a: Rect, b: Rect) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** "#rrggbb" or "#rrggbbaa" as RGBA (black when it cannot be read). */
export function rgbaOfHex(hex: string): RGBA {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return [0, 0, 0, 255];
  const v = Number.parseInt(m[1] as string, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? Number.parseInt(m[2], 16) : 255];
}
