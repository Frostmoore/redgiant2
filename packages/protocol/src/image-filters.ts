// The catalog of filters of the layered picture editor (G37.5), one pure function each on RGBA
// pixels (8 bits, straight alpha). The page and the server run the very same code: the person's
// filter is computed in the page and sent as tiles, the agent's on the server, and both give
// the same pixels.

export interface FilterParam {
  id: string;
  min: number;
  max: number;
  default: number;
  step?: number;
}

export interface FilterDef {
  id: string;
  params: FilterParam[];
}

export const IMAGE_FILTERS: readonly FilterDef[] = [
  {
    id: "brightness_contrast",
    params: [
      { id: "brightness", min: -100, max: 100, default: 0 },
      { id: "contrast", min: -100, max: 100, default: 0 },
    ],
  },
  {
    id: "hue_saturation",
    params: [
      { id: "hue", min: -180, max: 180, default: 0 },
      { id: "saturation", min: -100, max: 100, default: 0 },
      { id: "lightness", min: -100, max: 100, default: 0 },
    ],
  },
  { id: "grayscale", params: [] },
  { id: "sepia", params: [{ id: "amount", min: 0, max: 100, default: 100 }] },
  { id: "invert", params: [] },
  { id: "blur", params: [{ id: "radius", min: 1, max: 50, default: 3 }] },
  { id: "sharpen", params: [{ id: "amount", min: 0, max: 300, default: 80 }] },
  { id: "threshold", params: [{ id: "level", min: 0, max: 255, default: 128 }] },
  { id: "posterize", params: [{ id: "levels", min: 2, max: 32, default: 4 }] },
  { id: "pixelate", params: [{ id: "size", min: 2, max: 128, default: 8 }] },
];

export const imageFilter = (id: string): FilterDef | undefined =>
  IMAGE_FILTERS.find((f) => f.id === id);

/** A filter's parameters, each one given or its default, held within its range. */
export function filterParams(
  def: FilterDef,
  given: Readonly<Record<string, unknown>> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) {
    const v = given[p.id];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    out[p.id] = Number.isFinite(n) ? Math.max(p.min, Math.min(p.max, n)) : p.default;
  }
  return out;
}

type Px = Uint8Array | Uint8ClampedArray;
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function perPixel(src: Px, f: (r: number, g: number, b: number) => [number, number, number]) {
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = f(src[i] as number, src[i + 1] as number, src[i + 2] as number);
    out[i] = clamp(r);
    out[i + 1] = clamp(g);
    out[i + 2] = clamp(b);
    out[i + 3] = src[i + 3] as number;
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** One pass of a box blur along a line, on premultiplied channels (no halos at the edges). */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const win = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      // Edges repeat the first and last pixel.
      for (let k = -r; k <= r; k++) {
        const j = Math.min(len - 1, Math.max(0, k));
        sum += src[base + j * step + c] as number;
      }
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum / win;
        const out = Math.max(0, i - r);
        const inn = Math.min(len - 1, i + r + 1);
        sum += (src[base + inn * step + c] as number) - (src[base + out * step + c] as number);
      }
    }
  }
}

function blurred(src: Px, w: number, h: number, radius: number): Uint8ClampedArray {
  const n = w * h;
  const a = new Float32Array(n * 4);
  const b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const al = (src[i * 4 + 3] as number) / 255;
    a[i * 4] = (src[i * 4] as number) * al;
    a[i * 4 + 1] = (src[i * 4 + 1] as number) * al;
    a[i * 4 + 2] = (src[i * 4 + 2] as number) * al;
    a[i * 4 + 3] = src[i * 4 + 3] as number;
  }
  // Three box passes come close to a Gaussian.
  const r = Math.max(1, Math.round(radius / 2));
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const al = a[i * 4 + 3] as number;
    out[i * 4 + 3] = clamp(al);
    if (al > 0) {
      const k = 255 / al;
      out[i * 4] = clamp((a[i * 4] as number) * k);
      out[i * 4 + 1] = clamp((a[i * 4 + 1] as number) * k);
      out[i * 4 + 2] = clamp((a[i * 4 + 2] as number) * k);
    }
  }
  return out;
}

/** The pixels a filter makes of `src` (w × h, RGBA); `src` is not changed. */
export function runImageFilter(
  id: string,
  src: Px,
  w: number,
  h: number,
  given: Readonly<Record<string, unknown>> = {},
): Uint8ClampedArray {
  const def = imageFilter(id);
  if (!def) throw new Error(`there is no filter «${id}»`);
  const p = filterParams(def, given);
  switch (id) {
    case "brightness_contrast": {
      const br = ((p.brightness as number) / 100) * 255;
      const c = (p.contrast as number) * 2.55;
      const k = (259 * (c + 255)) / (255 * (259 - c));
      return perPixel(src, (r, g, b) => [
        k * (r + br - 128) + 128,
        k * (g + br - 128) + 128,
        k * (b + br - 128) + 128,
      ]);
    }
    case "hue_saturation": {
      const dh = (p.hue as number) / 360;
      const ds = (p.saturation as number) / 100;
      const dl = (p.lightness as number) / 100;
      return perPixel(src, (r, g, b) => {
        let [hh, s, l] = rgbToHsl(r, g, b);
        hh = (((hh + dh) % 1) + 1) % 1;
        s = ds >= 0 ? s + (1 - s) * ds * (s > 0 ? 1 : 0) : s * (1 + ds);
        l = dl >= 0 ? l + (1 - l) * dl : l * (1 + dl);
        return hslToRgb(hh, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
      });
    }
    case "grayscale":
      return perPixel(src, (r, g, b) => {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        return [y, y, y];
      });
    case "sepia": {
      const k = (p.amount as number) / 100;
      return perPixel(src, (r, g, b) => {
        const sr = 0.393 * r + 0.769 * g + 0.189 * b;
        const sg = 0.349 * r + 0.686 * g + 0.168 * b;
        const sb = 0.272 * r + 0.534 * g + 0.131 * b;
        return [r + (sr - r) * k, g + (sg - g) * k, b + (sb - b) * k];
      });
    }
    case "invert":
      return perPixel(src, (r, g, b) => [255 - r, 255 - g, 255 - b]);
    case "blur":
      return blurred(src, w, h, p.radius as number);
    case "sharpen": {
      const soft = blurred(src, w, h, 2);
      const k = (p.amount as number) / 100;
      const out = new Uint8ClampedArray(src.length);
      for (let i = 0; i < src.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const v = src[i + c] as number;
          out[i + c] = clamp(v + (v - (soft[i + c] as number)) * k);
        }
        out[i + 3] = src[i + 3] as number;
      }
      return out;
    }
    case "threshold": {
      const level = p.level as number;
      return perPixel(src, (r, g, b) => {
        const v = 0.2126 * r + 0.7152 * g + 0.0722 * b >= level ? 255 : 0;
        return [v, v, v];
      });
    }
    case "posterize": {
      const n = Math.round(p.levels as number) - 1;
      const q = (v: number) => (Math.round((v / 255) * n) / n) * 255;
      return perPixel(src, (r, g, b) => [q(r), q(g), q(b)]);
    }
    case "pixelate": {
      const size = Math.round(p.size as number);
      const out = new Uint8ClampedArray(src.length);
      for (let by = 0; by < h; by += size)
        for (let bx = 0; bx < w; bx += size) {
          const sum = [0, 0, 0, 0];
          let wsum = 0;
          let n = 0;
          const y1 = Math.min(h, by + size);
          const x1 = Math.min(w, bx + size);
          for (let y = by; y < y1; y++)
            for (let x = bx; x < x1; x++) {
              const i = (y * w + x) * 4;
              const al = src[i + 3] as number;
              sum[0] = (sum[0] as number) + (src[i] as number) * al;
              sum[1] = (sum[1] as number) + (src[i + 1] as number) * al;
              sum[2] = (sum[2] as number) + (src[i + 2] as number) * al;
              sum[3] = (sum[3] as number) + al;
              wsum += al;
              n++;
            }
          const px = [
            wsum ? (sum[0] as number) / wsum : 0,
            wsum ? (sum[1] as number) / wsum : 0,
            wsum ? (sum[2] as number) / wsum : 0,
            (sum[3] as number) / Math.max(1, n),
          ];
          for (let y = by; y < y1; y++)
            for (let x = bx; x < x1; x++) {
              const i = (y * w + x) * 4;
              for (let c = 0; c < 4; c++) out[i + c] = clamp(px[c] as number);
            }
        }
      return out;
    }
    default:
      throw new Error(`there is no filter «${id}»`);
  }
}
