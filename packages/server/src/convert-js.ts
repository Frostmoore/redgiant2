// Conversions done in RedGiant's own code (G34.3), with free libraries only: ag-psd (MIT) reads
// Photoshop files, fast-png (MIT) and fflate (MIT) write PNG and zip. Each one returns the open
// files it makes and what it leaves behind; nothing here touches the disk.

import { initializeCanvas, type Layer, type Psd, readPsd } from "ag-psd";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";

// ag-psd asks a canvas only for image data; Node has none, so a plain RGBA buffer does.
let canvasReady = false;
function readyPsd() {
  if (canvasReady) return;
  initializeCanvas(
    () => {
      throw new Error("No canvas on the server");
    },
    (width, height) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as never,
  );
  canvasReady = true;
}

/** An RGBA picture, 8 bits per channel. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export const pngOf = (img: Rgba): Uint8Array =>
  encodePng({
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    channels: 4,
    depth: 8,
  });

/** Any 8- or 16-bit PNG as RGBA 8-bit (palette, grey and RGB filled out). */
export function rgbaOf(png: Uint8Array): Rgba {
  const p = decodePng(png);
  const n = p.width * p.height;
  const out = new Uint8Array(n * 4);
  const src = p.data;
  const scale = p.depth === 16 ? 1 / 257 : 1;
  const ch = p.channels;
  const pal = p.palette;
  for (let i = 0; i < n; i++) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (pal) {
      const c = pal[src[i] as number] ?? [0, 0, 0];
      [r, g, b] = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
      a = c[3] ?? 255;
    } else if (ch <= 2) {
      r = g = b = (src[i * ch] as number) * scale;
      if (ch === 2) a = (src[i * ch + 1] as number) * scale;
    } else {
      r = (src[i * ch] as number) * scale;
      g = (src[i * ch + 1] as number) * scale;
      b = (src[i * ch + 2] as number) * scale;
      if (ch === 4) a = (src[i * ch + 3] as number) * scale;
    }
    out.set([r, g, b, a], i * 4);
  }
  return { width: p.width, height: p.height, data: out };
}

// ---------------------------------------------------------------- Blending (W3C compositing)

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
type Rgb = [number, number, number];

/** Photoshop's separable blend modes, channel by channel (backdrop b, source s, both 0…1). */
const SEPARABLE: Record<string, (b: number, s: number) => number> = {
  normal: (_b, s) => s,
  dissolve: (_b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  darken: Math.min,
  lighten: Math.max,
  "color dodge": (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  "color burn": (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  "hard light": (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  "soft light": (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  "linear dodge": (b, s) => Math.min(1, b + s),
  "linear burn": (b, s) => Math.max(0, b + s - 1),
  "vivid light": (b, s) =>
    s <= 0.5
      ? s <= 0
        ? b >= 1
          ? 1
          : 0
        : 1 - Math.min(1, (1 - b) / (2 * s))
      : s >= 1
        ? b > 0
          ? 1
          : 0
        : Math.min(1, b / (2 * (1 - s))),
  "linear light": (b, s) => clamp01(b + 2 * s - 1),
  "pin light": (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  "hard mix": (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b > 0 ? 1 : 0) : Math.min(1, b / s)),
};

const lum = (c: Rgb) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as Rgb;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as Rgb;
  return out;
}
const setLum = (c: Rgb, l: number) => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};
const sat = (c: Rgb) => Math.max(...c) - Math.min(...c);
function setSat(c: Rgb, s: number): Rgb {
  const x = Math.max(...c);
  const n = Math.min(...c);
  if (x === n) return [0, 0, 0];
  return c.map((v) => ((v - n) * s) / (x - n)) as Rgb;
}

/** The non-separable modes, and the two that pick a whole colour. */
const NON_SEPARABLE: Record<string, (b: Rgb, s: Rgb) => Rgb> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
  "darker color": (b, s) => (lum(s) < lum(b) ? s : b),
  "lighter color": (b, s) => (lum(s) > lum(b) ? s : b),
};

/** True when RedGiant draws this Photoshop blend mode itself. */
export const knownBlend = (mode: string) =>
  mode === "pass through" || mode in SEPARABLE || mode in NON_SEPARABLE;

/** A mask on the document: grey 0…255 in its red channel, `outside` beyond its rectangle. */
export interface Mask {
  img: Rgba;
  x: number;
  y: number;
  outside: number;
}

const maskAt = (m: Mask, dx: number, dy: number) => {
  const mx = dx - m.x;
  const my = dy - m.y;
  if (mx < 0 || my < 0 || mx >= m.img.width || my >= m.img.height) return m.outside / 255;
  return (m.img.data[(my * m.img.width + mx) * 4] as number) / 255;
};

export interface BlendOptions {
  opacity?: number;
  mode?: string;
  mask?: Mask;
  /** Per document pixel (0…255): the clipping base's coverage, for clipped layers. */
  clip?: Uint8Array;
}

/** `src` composited over `dst` at (x, y): blend mode, opacity, mask, clipping (straight alpha). */
export function blendOver(dst: Rgba, src: Rgba, x: number, y: number, o: BlendOptions = {}): void {
  const opacity = o.opacity ?? 1;
  const mode = o.mode ?? "normal";
  const sep = SEPARABLE[mode];
  const non = sep ? undefined : NON_SEPARABLE[mode];
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (sy * src.width + sx) * 4;
      const d = (dy * dst.width + dx) * 4;
      let sa = ((src.data[s + 3] as number) / 255) * opacity;
      if (o.mask) sa *= maskAt(o.mask, dx, dy);
      if (o.clip) sa *= (o.clip[dy * dst.width + dx] as number) / 255;
      if (sa <= 0) continue;
      const da = (dst.data[d + 3] as number) / 255;
      const cs: Rgb = [
        (src.data[s] as number) / 255,
        (src.data[s + 1] as number) / 255,
        (src.data[s + 2] as number) / 255,
      ];
      const cb: Rgb = [
        (dst.data[d] as number) / 255,
        (dst.data[d + 1] as number) / 255,
        (dst.data[d + 2] as number) / 255,
      ];
      let mixed: Rgb = cs;
      if (da > 0 && mode !== "normal") {
        const b = sep ? (cb.map((v, i) => sep(v, cs[i] as number)) as Rgb) : non?.(cb, cs);
        // Over a partly transparent backdrop the source shows through (W3C: (1 - ab)·Cs + ab·B).
        if (b) mixed = cs.map((v, i) => (1 - da) * v + da * (b[i] as number)) as Rgb;
      }
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++)
        dst.data[d + c] = Math.round(
          (((mixed[c] as number) * sa + (cb[c] as number) * da * (1 - sa)) / oa) * 255,
        );
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/** `src` drawn over `dst` at (x, y) with an opacity (normal blending, straight alpha). */
export function drawOver(dst: Rgba, src: Rgba, x: number, y: number, opacity = 1): void {
  blendOver(dst, src, x, y, { opacity });
}

const blank = (width: number, height: number): Rgba => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

/** A smaller copy that fits in `max` × `max` (box average), for thumbnails. */
export function shrink(img: Rgba, max = 256): Rgba {
  const k = Math.max(img.width / max, img.height / max, 1);
  if (k === 1) return img;
  const w = Math.max(1, Math.round(img.width / k));
  const h = Math.max(1, Math.round(img.height / k));
  const out = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * k); yy < Math.min(img.height, Math.floor((y + 1) * k)); yy++)
        for (let xx = Math.floor(x * k); xx < Math.min(img.width, Math.floor((x + 1) * k)); xx++) {
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (img.data[i + c] as number);
          n++;
        }
      out.data.set(
        sum.map((v) => Math.round(v / Math.max(n, 1))),
        (y * w + x) * 4,
      );
    }
  return out;
}

// ---------------------------------------------------------------- A small XML reader

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
        )
      : (ENTITIES[e] ?? m),
  );
export const escapeXml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

/** Elements, attributes and text; enough for IDML, OpenRaster and OpenDocument. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1] as XmlNode;
    if (m[1] !== undefined) top.children.push(m[1]);
    else if (m[6] !== undefined) top.children.push(unescapeXml(m[6]));
    else if (m[3]) {
      if (m[2] === "/") {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g))
        attrs[a[1] as string] = unescapeXml(a[3] ?? a[4] ?? "");
      const node: XmlNode = { name: m[3], attrs, children: [] };
      top.children.push(node);
      if (m[5] !== "/") stack.push(node);
    }
  }
  return root;
}

export const elements = (n: XmlNode) =>
  n.children.filter((c): c is XmlNode => typeof c !== "string");
export function* walk(n: XmlNode): Generator<XmlNode> {
  for (const c of elements(n)) {
    yield c;
    yield* walk(c);
  }
}

// ---------------------------------------------------------------- Zip packages

/** An OpenDocument / OpenRaster package: `mimetype` first and stored, as the standards want. */
export function packageZip(mimetype: string, files: Record<string, Uint8Array>): Uint8Array {
  const z: Zippable = { mimetype: [strToU8(mimetype), { level: 0 }] };
  for (const [name, data] of Object.entries(files))
    if (name !== "mimetype") z[name] = [data, { level: name.endsWith(".png") ? 0 : 6 }];
  return zipSync(z);
}

/** The entries of a zip, or undefined when it is not one. */
export function unzip(bytes: Uint8Array): Record<string, Uint8Array> | undefined {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined;
  try {
    return unzipSync(bytes);
  } catch {
    return undefined;
  }
}

/** Writes a zip back with an entry changed (mimetype kept first when there is one). */
export function rezip(entries: Record<string, Uint8Array>): Uint8Array {
  const mime = entries.mimetype;
  if (mime) return packageZip(strFromU8(mime), entries);
  const z: Zippable = {};
  for (const [name, data] of Object.entries(entries)) z[name] = [data, { level: 6 }];
  return zipSync(z);
}

// ---------------------------------------------------------------- Photoshop → OpenRaster

const BLEND: Record<string, string> = {
  normal: "svg:src-over",
  multiply: "svg:multiply",
  screen: "svg:screen",
  overlay: "svg:overlay",
  darken: "svg:darken",
  lighten: "svg:lighten",
  "color dodge": "svg:color-dodge",
  "color burn": "svg:color-burn",
  "hard light": "svg:hard-light",
  "soft light": "svg:soft-light",
  difference: "svg:difference",
  exclusion: "svg:exclusion",
  hue: "svg:hue",
  saturation: "svg:saturation",
  color: "svg:color",
  luminosity: "svg:luminosity",
  "linear dodge": "svg:plus",
  "pass through": "svg:src-over",
};

/** What the agent can read of each layer (texts, fonts) beside the OpenRaster file. */
export interface LayerInfo {
  path: string;
  name: string;
  kind: "pixels" | "group" | "text" | "smart-object" | "adjustment" | "empty";
  src?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  blend: string;
  text?: string;
  font?: string;
  fontSize?: number;
}

export interface Converted {
  /** File name (inside the conversion folder) → bytes. */
  files: Record<string, Uint8Array>;
  losses: string[];
}

/** A Photoshop file's own flattened picture (G36.12, a look at it), without its layers. */
export function psdComposite(bytes: Uint8Array): Rgba | undefined {
  readyPsd();
  const psd: Psd = readPsd(bytes, {
    useImageData: true,
    skipThumbnail: true,
    skipLayerImageData: true,
  });
  return psd.imageData ? to8(psd.imageData as Rgba) : undefined;
}

/** A Photoshop file as OpenRaster (layers, groups, opacity, blending) and a flat PNG. */
export function psdToOra(bytes: Uint8Array, stem: string): Converted {
  readyPsd();
  const psd: Psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  const losses = new Set<string>();
  if (psd.colorMode !== undefined && psd.colorMode !== 3)
    losses.add("the document was not RGB (CMYK, Lab or other): its colours were turned into RGB");
  if ((psd.bitsPerChannel ?? 8) > 8)
    losses.add(`${psd.bitsPerChannel}-bit colour reduced to 8 bits per channel`);
  const data: Record<string, Uint8Array> = {};
  const infos: LayerInfo[] = [];
  let n = 0;
  const named = (what: string, l: Layer) => `${what}: «${l.name ?? "layer"}»`;
  const lost = {
    effects: [] as string[],
    masks: [] as string[],
    clipping: [] as string[],
    blend: [] as string[],
  };
  const xmlOf = (layers: Layer[], depth: string, path: string): string => {
    // OpenRaster lists the topmost first; Photoshop's children go bottom to top.
    return [...layers]
      .reverse()
      .map((l) => {
        const name = l.name ?? `Layer ${n + 1}`;
        const here = path ? `${path}/${name}` : name;
        const opacity = (l.opacity ?? 1).toFixed(3);
        const visibility = l.hidden ? "hidden" : "visible";
        const blend = l.blendMode ?? "normal";
        const op = BLEND[blend];
        if (!op) lost.blend.push(`${blend} on «${name}»`);
        if (l.effects && Object.values(l.effects).some((e) => e !== undefined && e !== true))
          lost.effects.push(name);
        if (l.mask?.imageData && !l.mask.disabled) lost.masks.push(name);
        if (l.clipping) lost.clipping.push(name);
        if (l.adjustment) losses.add(named("adjustment layer dropped", l));
        if (l.placedLayer) losses.add(named("smart object kept only as its pixels", l));
        if (l.text)
          losses.add(named("text layer kept as pixels (its words are in layers.json)", l));
        const common = `name="${escapeXml(name)}" opacity="${opacity}" visibility="${visibility}" composite-op="${op ?? "svg:src-over"}"`;
        const base: LayerInfo = {
          path: here,
          name,
          kind: "pixels",
          x: l.left ?? 0,
          y: l.top ?? 0,
          width: 0,
          height: 0,
          opacity: Number(opacity),
          visible: !l.hidden,
          blend,
        };
        if (l.children) {
          infos.push({ ...base, kind: "group" });
          // A group in pass-through mode is not isolated in Photoshop.
          const isolation = blend === "pass through" ? "auto" : "isolate";
          return `${depth}<stack ${common} isolation="${isolation}">\n${xmlOf(l.children, `${depth} `, here)}${depth}</stack>\n`;
        }
        const img = l.imageData;
        const info: LayerInfo = {
          ...base,
          kind: l.text
            ? "text"
            : l.placedLayer
              ? "smart-object"
              : l.adjustment
                ? "adjustment"
                : img && img.width > 0
                  ? "pixels"
                  : "empty",
          ...(l.text && {
            text: l.text.text,
            ...(l.text.style?.font?.name && { font: l.text.style.font.name }),
            ...(l.text.style?.fontSize && { fontSize: l.text.style.fontSize }),
          }),
        };
        if (!img || img.width === 0 || img.height === 0) {
          infos.push(info);
          return "";
        }
        const src = `data/layer${n++}.png`;
        // OpenRaster has no masks: a layer's mask is applied to its own pixels.
        const mask = maskOf(l);
        const pixels = to8(img as Rgba);
        data[src] = pngOf(mask ? masked(pixels, l.left ?? 0, l.top ?? 0, mask) : pixels);
        infos.push({ ...info, src, width: img.width, height: img.height });
        return `${depth}<layer ${common} src="${src}" x="${l.left ?? 0}" y="${l.top ?? 0}"/>\n`;
      })
      .join("");
  };
  const body = xmlOf(psd.children ?? [], "  ", "");
  if (lost.effects.length)
    losses.add(
      `layer effects (shadows, strokes, glows…) not applied: ${lost.effects.slice(0, 8).join(", ")}`,
    );
  if (lost.masks.length)
    losses.add(
      `layer masks applied to the layers' own pixels in the .ora: ${lost.masks.slice(0, 8).join(", ")}`,
    );
  if (lost.clipping.length)
    losses.add(
      `clipping masks drawn only in the flat PNG (the .ora shows those layers whole): ${lost.clipping.slice(0, 8).join(", ")}`,
    );
  if (lost.blend.length)
    losses.add(
      `blend modes OpenRaster does not have, drawn as normal: ${lost.blend.slice(0, 8).join(", ")}`,
    );
  // The picture Photoshop saved, when it is real: without "Maximize compatibility" the file
  // says so (versionInfo) and holds a stand-in (often just the background), so the layers
  // are drawn here instead.
  const children = psd.children ?? [];
  const unknownBlend: string[] = [];
  const drawn = () => composite(psd.width, psd.height, children, unknownBlend);
  const stored = psd.imageData ? to8(psd.imageData as Rgba) : undefined;
  const real = psd.imageResources?.versionInfo?.hasRealMergedData;
  let merged: Rgba;
  if (stored && (real === true || (real === undefined && !standIn(stored, children))))
    merged = stored;
  else {
    merged = children.length ? drawn() : (stored ?? blank(psd.width, psd.height));
    if (children.length) {
      losses.add(
        "the file had no real flat picture (saved without «Maximize compatibility»): it was drawn from the layers",
      );
      if (unknownBlend.length)
        losses.add(
          `blend modes drawn as normal in the flat PNG: ${[...new Set(unknownBlend)].slice(0, 8).join(", ")}`,
        );
    }
  }
  const mergedPng = pngOf(merged);
  const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${psd.width}" h="${psd.height}" xres="72" yres="72">\n <stack>\n${body} </stack>\n</image>\n`;
  const ora = packageZip("image/openraster", {
    "stack.xml": strToU8(stack),
    ...data,
    "mergedimage.png": mergedPng,
    "Thumbnails/thumbnail.png": pngOf(shrink(merged)),
  });
  return {
    files: {
      [`${stem}.ora`]: ora,
      [`${stem}.png`]: mergedPng,
      "layers.json": strToU8(`${JSON.stringify(infos, null, 2)}\n`),
    },
    losses: [...losses],
  };
}

/** Any ag-psd pixels (8, 16 or 32 bits per channel) as 8-bit RGBA. */
function to8(img: Rgba | { width: number; height: number; data: ArrayLike<number> }): Rgba {
  const d = img.data;
  if (d instanceof Uint8Array || d instanceof Uint8ClampedArray) return img as Rgba;
  const k = d instanceof Uint16Array ? 1 / 257 : 255;
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++)
    out[i] = Math.max(0, Math.min(255, Math.round((d[i] as number) * k)));
  return { width: img.width, height: img.height, data: out };
}

/** A layer's own mask (not disabled), on document coordinates. */
function maskOf(l: Layer): Mask | undefined {
  const m = l.mask;
  if (!m || m.disabled) return undefined;
  if (!m.imageData)
    return m.defaultColor === 0 ? { img: blank(0, 0), x: 0, y: 0, outside: 0 } : undefined;
  return {
    img: to8(m.imageData as Rgba),
    x: m.left ?? 0,
    y: m.top ?? 0,
    outside: m.defaultColor ?? 0,
  };
}

/** A copy of a layer's pixels with its mask multiplied into their alpha. */
function masked(img: Rgba, x: number, y: number, mask: Mask): Rgba {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  for (let py = 0; py < img.height; py++)
    for (let px = 0; px < img.width; px++) {
      const i = (py * img.width + px) * 4 + 3;
      out.data[i] = Math.round((out.data[i] as number) * maskAt(mask, x + px, y + py));
    }
  return out;
}

/** How much of each document pixel a layer covers (its alpha times its mask), 0…255. */
function coverage(w: number, h: number, img: Rgba | undefined, x: number, y: number, mask?: Mask) {
  const out = new Uint8Array(w * h);
  if (!img) return out;
  for (let py = 0; py < img.height; py++) {
    const dy = y + py;
    if (dy < 0 || dy >= h) continue;
    for (let px = 0; px < img.width; px++) {
      const dx = x + px;
      if (dx < 0 || dx >= w) continue;
      const a = img.data[(py * img.width + px) * 4 + 3] as number;
      out[dy * w + dx] = mask ? Math.round(a * maskAt(mask, dx, dy)) : a;
    }
  }
  return out;
}

/**
 * The layers drawn as Photoshop does, bottom to top: visibility, position, opacity and fill,
 * blend modes, layer masks, clipping masks and groups (pass-through groups drawn isolated).
 */
function composite(w: number, h: number, layers: Layer[], unknown: string[]): Rgba {
  const out = blank(w, h);
  // The clipping base's coverage: clipped layers above it show only where it does.
  let clip = new Uint8Array(w * h);
  for (const l of layers) {
    const base = !l.clipping;
    if (l.hidden) {
      if (base) clip = new Uint8Array(w * h);
      continue;
    }
    const mode = l.blendMode ?? "normal";
    if (!knownBlend(mode)) unknown.push(`${mode} on «${l.name ?? "layer"}»`);
    const mask = maskOf(l);
    let img: Rgba | undefined;
    let x = 0;
    let y = 0;
    if (l.children) img = composite(w, h, l.children, unknown);
    else if (l.imageData && l.imageData.width > 0 && l.imageData.height > 0) {
      img = to8(l.imageData as Rgba);
      x = l.left ?? 0;
      y = l.top ?? 0;
    }
    if (base) clip = coverage(w, h, img, x, y, mask);
    if (!img) continue;
    const fill = l.children ? 1 : (l.fillOpacity ?? 1);
    blendOver(out, img, x, y, {
      opacity: (l.opacity ?? 1) * fill,
      mode: mode === "pass through" || !knownBlend(mode) ? "normal" : mode,
      ...(mask && { mask }),
      ...(!base && { clip }),
    });
  }
  return out;
}

/**
 * True when the stored picture is only the bottom layer while other visible layers have
 * pixels: the stand-in of a file saved without "Maximize compatibility" and without the
 * version record that says so.
 */
function standIn(stored: Rgba, layers: Layer[]): boolean {
  const [bottom, ...rest] = layers;
  const px = bottom?.imageData;
  if (!bottom || !px || bottom.left || bottom.top) return false;
  if (px.width !== stored.width || px.height !== stored.height) return false;
  if (!rest.some((l) => !l.hidden && (l.children?.length || (l.imageData?.width ?? 0) > 0)))
    return false;
  const a = to8(px as Rgba).data;
  const b = stored.data;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** OpenRaster's composite-op → the blend mode drawn (svg:src-atop and others: as normal). */
const ORA_BLEND: Record<string, string> = Object.fromEntries([
  ...Object.entries(BLEND)
    .filter(([k]) => k !== "pass through")
    .map(([k, v]) => [v, k]),
]);

/** An OpenRaster file's layers drawn again (with their blend modes), for mergedimage.png. */
export function renderOra(entries: Record<string, Uint8Array>): {
  merged: Uint8Array;
  thumbnail: Uint8Array;
  approximated: string[];
} {
  const stackXml = entries["stack.xml"];
  if (!stackXml) throw new Error("Not an OpenRaster file: there is no stack.xml");
  const image = elements(parseXml(strFromU8(stackXml))).find((e) => e.name === "image");
  if (!image) throw new Error("stack.xml has no <image>");
  const w = Number(image.attrs.w);
  const h = Number(image.attrs.h);
  const approximated: string[] = [];
  const draw = (stack: XmlNode): Rgba => {
    const out = blank(w, h);
    // Topmost first in the file: drawn from the bottom up.
    for (const e of elements(stack).reverse()) {
      if (e.attrs.visibility === "hidden") continue;
      const opacity = e.attrs.opacity === undefined ? 1 : Number(e.attrs.opacity);
      const op = e.attrs["composite-op"] ?? "svg:src-over";
      const mode = ORA_BLEND[op];
      if (!mode) approximated.push(`${op} on «${e.attrs.name ?? "layer"}»`);
      const o = { opacity, mode: mode ?? "normal" };
      if (e.name === "stack") blendOver(out, draw(e), 0, 0, o);
      else if (e.name === "layer" && e.attrs.src) {
        const png = entries[e.attrs.src];
        if (!png) throw new Error(`stack.xml names ${e.attrs.src}, which is not in the file`);
        blendOver(out, rgbaOf(png), Number(e.attrs.x ?? 0), Number(e.attrs.y ?? 0), o);
      }
    }
    return out;
  };
  const top = elements(image).find((e) => e.name === "stack");
  const merged = top ? draw(top) : blank(w, h);
  return { merged: pngOf(merged), thumbnail: pngOf(shrink(merged)), approximated };
}

// ---------------------------------------------------------------- Previews stored inside files

export interface Picture {
  ext: "png" | "jpg";
  data: Uint8Array;
}

/** A PNG starting at `at`, measured chunk by chunk; undefined when it is not whole. */
function pngAt(b: Uint8Array, at: number): number | undefined {
  let p = at + 8;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p + 12 <= b.length) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    p += 12 + len;
    if (p > b.length) return undefined;
    if (type === "IEND") return p - at;
  }
  return undefined;
}

/** A JPEG starting at `at`: segments up to the scan, then to its end marker. */
function jpegAt(b: Uint8Array, at: number): number | undefined {
  let p = at + 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return undefined;
    const marker = b[p + 1] as number;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = ((b[p + 2] as number) << 8) | (b[p + 3] as number);
    p += 2 + len;
    if (marker === 0xda) {
      for (; p + 1 < b.length; p++) if (b[p] === 0xff && b[p + 1] === 0xd9) return p + 2 - at;
      return undefined;
    }
  }
  return undefined;
}

/**
 * The preview a closed file carries: the XMP thumbnail (InDesign, Illustrator) first, otherwise
 * the largest whole PNG or JPEG found in its bytes (Affinity and others store one).
 */
export function embeddedPreview(bytes: Uint8Array): Picture | undefined {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  let best: Picture | undefined;
  for (const m of text.matchAll(/<xmpGImg:image>([\s\S]*?)<\/xmpGImg:image>/g)) {
    const data = new Uint8Array(Buffer.from(unescapeXml(m[1] ?? "").replace(/\s+/g, ""), "base64"));
    if (data[0] === 0xff && data[1] === 0xd8 && (!best || data.length > best.data.length))
      best = { ext: "jpg", data };
  }
  if (best) return best;
  for (
    let i = text.indexOf("\x89PNG\r\n\x1a\n");
    i >= 0;
    i = text.indexOf("\x89PNG\r\n\x1a\n", i + 8)
  ) {
    const len = pngAt(bytes, i);
    if (len && (!best || len > best.data.length))
      best = { ext: "png", data: bytes.slice(i, i + len) };
  }
  for (let i = text.indexOf("\xff\xd8\xff"); i >= 0; i = text.indexOf("\xff\xd8\xff", i + 3)) {
    const len = jpegAt(bytes, i);
    if (len && len > 256 && (!best || len > best.data.length * 1.5))
      best = { ext: "jpg", data: bytes.slice(i, i + len) };
  }
  return best;
}

/** The largest preview picture inside a zip-based design file (Sketch, Figma's .fig, XD). */
export function zipPreview(entries: Record<string, Uint8Array>): Picture | undefined {
  let best: Picture | undefined;
  for (const [name, data] of Object.entries(entries)) {
    if (!/(preview|thumbnail)[^/]*\.(png|jpe?g)$/i.test(name)) continue;
    if (!best || data.length > best.data.length)
      best = { ext: /\.png$/i.test(name) ? "png" : "jpg", data };
  }
  return best;
}

/** Sketch's pages, artboards, layers and texts as an indented outline. */
export function sketchOutline(entries: Record<string, Uint8Array>): string {
  const lines: string[] = [];
  type SLayer = {
    _class?: string;
    name?: string;
    frame?: { width?: number; height?: number };
    layers?: SLayer[];
    attributedString?: { string?: string };
  };
  const visit = (l: SLayer, depth: number) => {
    if (lines.length > 5000) return;
    const pad = "  ".repeat(depth);
    const size = l.frame?.width
      ? ` (${Math.round(l.frame.width)} x ${Math.round(l.frame.height ?? 0)})`
      : "";
    const text = l.attributedString?.string;
    lines.push(
      `${pad}${l._class ?? "layer"} «${l.name ?? ""}»${size}${text ? `: ${text.replace(/\s+/g, " ")}` : ""}`,
    );
    for (const c of l.layers ?? []) visit(c, depth + 1);
  };
  for (const [name, data] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^pages\/[^/]+\.json$/.test(name)) continue;
    try {
      visit(JSON.parse(strFromU8(data)) as SLayer, 0);
    } catch {
      lines.push(`(${name} could not be read)`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- IDML → OpenDocument Text

/** An ODF style name from any name (letters, digits; the rest as _hex_ like LibreOffice). */
export const odfName = (s: string) => {
  const n = s.replace(/[^A-Za-z0-9_]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
  return /^[A-Za-z_]/.test(n) ? n : `S${n}`;
};

type Props = Record<string, string>;

/** The text properties InDesign and ODF share: font, size, weight, slant, alignment, spacing. */
function odfProps(p: Props): { text: string; para: string } {
  const text: string[] = [];
  const para: string[] = [];
  if (p.font)
    text.push(`style:font-name="${escapeXml(p.font)}" fo:font-family="${escapeXml(p.font)}"`);
  if (p.PointSize) text.push(`fo:font-size="${Number(p.PointSize)}pt"`);
  const fs = (p.FontStyle ?? "").toLowerCase();
  if (/bold|black|heavy|semibold/.test(fs)) text.push('fo:font-weight="bold"');
  if (/italic|oblique/.test(fs)) text.push('fo:font-style="italic"');
  if (p.FillColor && /^Color\/#?([0-9a-f]{6})$/i.test(p.FillColor))
    text.push(`fo:color="#${(p.FillColor.match(/([0-9a-f]{6})$/i) as RegExpMatchArray)[1]}"`);
  const align: Record<string, string> = {
    LeftAlign: "start",
    CenterAlign: "center",
    RightAlign: "end",
    LeftJustified: "justify",
    CenterJustified: "justify",
    RightJustified: "justify",
    FullyJustified: "justify",
  };
  if (p.Justification && align[p.Justification])
    para.push(`fo:text-align="${align[p.Justification]}"`);
  if (p.SpaceBefore) para.push(`fo:margin-top="${Number(p.SpaceBefore)}pt"`);
  if (p.SpaceAfter) para.push(`fo:margin-bottom="${Number(p.SpaceAfter)}pt"`);
  if (p.FirstLineIndent) para.push(`fo:text-indent="${Number(p.FirstLineIndent)}pt"`);
  return { text: text.join(" "), para: para.join(" ") };
}

/** An element's own properties, with <Properties><AppliedFont> folded in. */
function propsOf(e: XmlNode): Props {
  const p: Props = { ...e.attrs };
  const props = elements(e).find((c) => c.name === "Properties");
  const font = props && elements(props).find((c) => c.name === "AppliedFont");
  if (font)
    p.font = font.children
      .filter((c) => typeof c === "string")
      .join("")
      .trim();
  return p;
}

const odfStyle = (
  family: "paragraph" | "text",
  name: string,
  display: string,
  p: Props,
  parent?: string,
) => {
  const { text, para } = odfProps(p);
  return `<style:style style:name="${odfName(name)}" style:display-name="${escapeXml(display)}" style:family="${family}"${parent ? ` style:parent-style-name="${parent}"` : ""}>${para && family === "paragraph" ? `<style:paragraph-properties ${para}/>` : ""}${text ? `<style:text-properties ${text}/>` : ""}</style:style>`;
};

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"';

/** An ODT from content and styles (the minimal valid package). */
export function odtPackage(
  body: string,
  styles: string,
  automatic = "",
  fonts: string[] = [],
): Uint8Array {
  const faces = fonts
    .map((f) => `<style:font-face style:name="${escapeXml(f)}" svg:font-family="${escapeXml(f)}"/>`)
    .join("");
  const decls = `<office:font-face-decls>${faces}</office:font-face-decls>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}>${decls}<office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>\n`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}>${decls}<office:styles>${styles}</office:styles></office:document-styles>\n`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>\n`;
  return packageZip("application/vnd.oasis.opendocument.text", {
    "content.xml": strToU8(content),
    "styles.xml": strToU8(stylesXml),
    "META-INF/manifest.xml": strToU8(manifest),
  });
}

const styleKey = (ref: string | undefined) =>
  (ref ?? "").replace(/^(ParagraphStyle|CharacterStyle)\//, "").replace(/^\$ID\//, "");

/** The stories of an IDML (InDesign's open-ish XML) as an ODT with their styles. */
export function idmlToOdt(entries: Record<string, Uint8Array>, stem: string): Converted {
  const read = (n: string) => {
    const b = entries[n];
    return b ? parseXml(strFromU8(b)) : undefined;
  };
  const design = read("designmap.xml");
  if (!design) throw new Error("Not an IDML: there is no designmap.xml");
  const fonts = new Set<string>();
  const styles: string[] = [];
  const stylesXml = read("Resources/Styles.xml");
  for (const e of stylesXml ? walk(stylesXml) : []) {
    if (e.name !== "ParagraphStyle" && e.name !== "CharacterStyle") continue;
    const p = propsOf(e);
    if (p.font) fonts.add(p.font);
    const key = styleKey(e.attrs.Self);
    const family = e.name === "ParagraphStyle" ? "paragraph" : "text";
    styles.push(
      odfStyle(family, `${family === "paragraph" ? "P" : "C"}_${key}`, e.attrs.Name ?? key, p),
    );
  }
  // The stories in the document's order.
  const storyFiles = [...walk(design)]
    .filter((e) => e.name === "idPkg:Story" && e.attrs.src)
    .map((e) => e.attrs.src as string);
  for (const n of Object.keys(entries))
    if (/^Stories\/Story_.+\.xml$/.test(n) && !storyFiles.includes(n)) storyFiles.push(n);
  const auto: string[] = [];
  const autoKey = new Map<string, string>();
  // InDesign's "[No character style]" / "[No paragraph style]": no named style at all.
  const named = (prefix: "P" | "C", ref: string | undefined) => {
    const key = styleKey(ref);
    return !key || key.startsWith("[No ") ? "" : odfName(`${prefix}_${key}`);
  };
  const local = (family: "paragraph" | "text", parent: string, p: Props): string => {
    const own: Props = {};
    for (const k of [
      "PointSize",
      "FontStyle",
      "Justification",
      "SpaceBefore",
      "SpaceAfter",
      "FillColor",
      "font",
    ])
      if (p[k] !== undefined) own[k] = p[k] as string;
    if (Object.keys(own).length === 0) return parent;
    const key = `${family}|${parent}|${JSON.stringify(own)}`;
    let name = autoKey.get(key);
    if (!name) {
      name = `${family === "paragraph" ? "P" : "T"}${autoKey.size + 1}`;
      autoKey.set(key, name);
      if (own.font) fonts.add(own.font);
      auto.push(
        odfStyle(family, name, name, own, parent || undefined).replace(
          / style:display-name="[^"]*"/,
          "",
        ),
      );
    }
    return name;
  };
  const body: string[] = [];
  let words = 0;
  for (const file of storyFiles) {
    const story = read(file);
    if (!story) continue;
    const id = file.replace(/^Stories\/|\.xml$/g, "");
    let first = true;
    for (const psr of [...walk(story)].filter((e) => e.name === "ParagraphStyleRange")) {
      const pStyle = local("paragraph", named("P", psr.attrs.AppliedParagraphStyle), propsOf(psr));
      let runs: string[] = [];
      const flush = () => {
        const mark = first ? `<text:bookmark text:name="${escapeXml(id)}"/>` : "";
        first = false;
        const style = pStyle ? ` text:style-name="${pStyle}"` : "";
        body.push(`<text:p${style}>${mark}${runs.join("")}</text:p>`);
        runs = [];
      };
      for (const csr of elements(psr).filter((e) => e.name === "CharacterStyleRange")) {
        const cStyle = local("text", named("C", csr.attrs.AppliedCharacterStyle), propsOf(csr));
        for (const c of elements(csr)) {
          if (c.name === "Content") {
            const s = c.children.filter((x) => typeof x === "string").join("");
            words += s.split(/\s+/).filter(Boolean).length;
            const t = escapeXml(s).replace(/\u2028/g, "<text:line-break/>");
            runs.push(cStyle ? `<text:span text:style-name="${cStyle}">${t}</text:span>` : t);
          } else if (c.name === "Br") flush();
        }
      }
      if (runs.length) flush();
    }
  }
  const links = new Set<string>();
  for (const [n, b] of Object.entries(entries)) {
    if (!n.startsWith("Spreads/")) continue;
    for (const e of walk(parseXml(strFromU8(b))))
      if (e.name === "Link" && e.attrs.LinkResourceURI) links.add(e.attrs.LinkResourceURI);
  }
  const losses = [
    "the page layout (frames, positions, master pages, columns) is not carried over: only the stories' text with their paragraph and character styles, in the document's order",
    ...(links.size
      ? [`${links.size} placed image(s) are not carried over: ${[...links].slice(0, 5).join(", ")}`]
      : []),
    "tables, footnotes and anchored objects inside stories are kept as plain text",
  ];
  return {
    files: {
      [`${stem}.odt`]: odtPackage(body.join(""), styles.join(""), auto.join(""), [...fonts]),
    },
    losses: [...losses, ...(words === 0 ? ["the stories had no text"] : [])],
  };
}
