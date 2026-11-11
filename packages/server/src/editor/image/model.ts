// The layered picture as the host keeps it (G37.5): the canvas's size and the layers, bottom
// first, each with its own pixels (RGBA, 8 bits, straight alpha) at its place, its mask, its
// groups and the attributes of stack.xml it does not know (kept and written back). OpenRaster is
// read and written here; a PNG or a JPEG is one layer. Pixels that travel (tiles, a layer put
// back) are PNG blobs of the host: written and read here synchronously, since a family's
// apply and invert are (a cache keeps the last ones decoded).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  IMAGE_MAX_SIDE,
  type ImageGroup,
  type ImageLayerInfo,
  type ImageMask,
  type ImageSnapshot,
  type ImageText,
  imageBlendName,
  TEXT_ATTRS,
  textAttrs,
  textOfAttrs,
} from "@redgiant/protocol";
import { strFromU8, strToU8 } from "fflate";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import {
  blendOver,
  elements,
  escapeXml,
  knownBlend,
  packageZip,
  parseXml,
  pngOf,
  type Rgba,
  rgbaOf,
  shrink,
  unzip,
  type XmlNode,
} from "../../convert-js.js";

export type { Rgba };

/** A layer's mask: grey in its red channel (white shows), on the picture's coordinates. */
export interface RMask {
  x: number;
  y: number;
  outside: number;
  img: Rgba;
}

export interface RLayer {
  id: string;
  name: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  blend: string;
  locked?: boolean;
  groups: ImageGroup[];
  px: Rgba;
  mask?: RMask;
  /** A text layer's text (p3.5.8): its pixels are the text drawn. */
  text?: ImageText;
  /** stack.xml's attributes of this layer the editor does not know, written back as they were. */
  extra: Record<string, string>;
}

export interface ImageModel {
  width: number;
  height: number;
  format: "ora" | "png" | "jpeg";
  /** Bottom first. */
  layers: RLayer[];
  /** The <image> element's other attributes (xres, yres, version…). */
  attrs: Record<string, string>;
  /** The zip's other entries (an application's own files), written back untouched. */
  keep: Record<string, Uint8Array>;
}

/** The biggest picture (all its layers' pixels together) the editor opens. */
export const MAX_IMAGE_PIXELS = 120_000_000;
export const MAX_IMAGE_BYTES = 400 * 1024 * 1024;

export const blank = (width: number, height: number): Rgba => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- Blobs

/**
 * The host's blobs, read and written at once (apply and invert are synchronous): PNGs by their
 * sha256 in `<data>/editor/blobs`, the same folder as the host's.
 */
export class ImageBlobs {
  private readonly decoded = new Map<string, Rgba>();
  private decodedBytes = 0;
  /** The PNG made of a buffer, by the buffer (its blob's hash). */
  private readonly made = new WeakMap<object, string>();

  constructor(
    private readonly dataDir: string,
    private readonly maxCache = 512 * 1024 * 1024,
  ) {}

  private path(hash: string) {
    return join(this.dataDir, "editor", "blobs", hash);
  }

  has(hash: string): boolean {
    return this.decoded.has(hash) || existsSync(this.path(hash));
  }

  put(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    const p = this.path(hash);
    if (!existsSync(p)) {
      mkdirSync(join(this.dataDir, "editor", "blobs"), { recursive: true });
      const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, p);
    }
    return hash;
  }

  bytes(hash: string): Uint8Array | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    try {
      const b = new Uint8Array(readFileSync(this.path(hash)));
      return sha256(b) === hash ? b : undefined;
    } catch {
      return undefined;
    }
  }

  /** A PNG blob's pixels (8-bit RGBA); throws when it is missing or not a PNG. */
  rgba(hash: string): Rgba {
    const have = this.decoded.get(hash);
    if (have) {
      // Most recently used last.
      this.decoded.delete(hash);
      this.decoded.set(hash, have);
      return have;
    }
    const b = this.bytes(hash);
    if (!b) throw new Error(`the pixels ${hash.slice(0, 12)}… are not here`);
    const img = rgbaOf(b);
    this.remember(hash, img);
    this.made.set(img.data, hash);
    return img;
  }

  private remember(hash: string, img: Rgba) {
    this.decoded.set(hash, img);
    this.decodedBytes += img.data.byteLength;
    while (this.decodedBytes > this.maxCache && this.decoded.size > 1) {
      const [k, v] = this.decoded.entries().next().value as [string, Rgba];
      this.decoded.delete(k);
      this.decodedBytes -= v.data.byteLength;
    }
  }

  /** The blob of a buffer's pixels as PNG (made once per buffer). */
  hashOf(img: Rgba): string {
    const have = this.made.get(img.data);
    if (have && (this.decoded.has(have) || existsSync(this.path(have)))) return have;
    const hash = this.put(pngOf(img));
    this.made.set(img.data, hash);
    this.remember(hash, img);
    return hash;
  }

  /** The PNG bytes of a buffer (the blob's, made once). */
  pngBytes(img: Rgba): Uint8Array {
    const hash = this.hashOf(img);
    const b = this.bytes(hash);
    if (!b) throw new Error("a layer's pixels could not be kept");
    return b;
  }
}

// ---------------------------------------------------------------- Pixels

/** A copy of a rectangle of a buffer (outside it: transparent). */
export function crop(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const out = blank(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.height) continue;
    const x0 = Math.max(0, x);
    const x1 = Math.min(img.width, x + w);
    if (x1 <= x0) continue;
    out.data.set(
      img.data.subarray((sy * img.width + x0) * 4, (sy * img.width + x1) * 4),
      (row * w + (x0 - x)) * 4,
    );
  }
  return out;
}

/** `src` written over a rectangle of `dst` at (x, y), replacing (not blending) what was there. */
export function paste(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    const x0 = Math.max(0, x);
    const x1 = Math.min(dst.width, x + src.width);
    if (x1 <= x0) continue;
    dst.data.set(
      src.data.subarray((row * src.width + (x0 - x)) * 4, (row * src.width + (x1 - x)) * 4),
      (dy * dst.width + x0) * 4,
    );
  }
}

export const copyOf = (img: Rgba): Rgba => ({
  width: img.width,
  height: img.height,
  data: new Uint8Array(img.data),
});

/** Whether two rectangles of two buffers hold the same bytes. */
export function sameRect(a: Rgba, b: Rgba, x: number, y: number, w: number, h: number): boolean {
  for (let row = y; row < y + h; row++) {
    const i = (row * a.width + x) * 4;
    const j = (row * b.width + x) * 4;
    for (let k = 0; k < w * 4; k++) if (a.data[i + k] !== b.data[j + k]) return false;
  }
  return true;
}

/** The rectangle of a buffer with any pixel not fully transparent, or undefined. */
export function opaqueBox(img: Rgba): { x: number; y: number; w: number; h: number } | undefined {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] as number) > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------- Drawing the layers

const maskValue = (m: RMask, dx: number, dy: number) => {
  const mx = dx - m.x;
  const my = dy - m.y;
  if (mx < 0 || my < 0 || mx >= m.img.width || my >= m.img.height) return m.outside;
  return m.img.data[(my * m.img.width + mx) * 4] as number;
};

/** A layer's pixels with its mask multiplied into their alpha. */
export function masked(l: RLayer): Rgba {
  const m = l.mask;
  if (!m) return l.px;
  const out = copyOf(l.px);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 4 + 3;
      out.data[i] = Math.round(((out.data[i] as number) * maskValue(m, l.x + x, l.y + y)) / 255);
    }
  return out;
}

/** `src` over `dst` at (x, y), normal blending with an opacity (the common case, fast). */
function overNormal(dst: Rgba, src: Rgba, x: number, y: number, opacity: number): void {
  const k = Math.round(opacity * 255);
  if (k <= 0) return;
  const d = dst.data;
  const s = src.data;
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    const sx0 = Math.max(0, -x);
    const sx1 = Math.min(src.width, dst.width - x);
    for (let sx = sx0; sx < sx1; sx++) {
      const si = (sy * src.width + sx) * 4;
      const sa = ((s[si + 3] as number) * k) / 255;
      if (sa <= 0) continue;
      const di = (dy * dst.width + x + sx) * 4;
      const da = d[di + 3] as number;
      if (sa >= 255 || da === 0) {
        d[di] = s[si] as number;
        d[di + 1] = s[si + 1] as number;
        d[di + 2] = s[si + 2] as number;
        d[di + 3] = Math.round(sa);
        continue;
      }
      const a = sa / 255;
      const b = (da / 255) * (1 - a);
      const oa = a + b;
      d[di] = Math.round(((s[si] as number) * a + (d[di] as number) * b) / oa);
      d[di + 1] = Math.round(((s[si + 1] as number) * a + (d[di + 1] as number) * b) / oa);
      d[di + 2] = Math.round(((s[si + 2] as number) * a + (d[di + 2] as number) * b) / oa);
      d[di + 3] = Math.round(oa * 255);
    }
  }
}

/** The blend mode convert-js draws for a composite-op (undefined: drawn as normal). */
const modeOf = (op: string): string | undefined => {
  const n = imageBlendName(op);
  const mode = n === "add" ? "linear dodge" : n.replace(/-/g, " ");
  return mode !== "normal" && knownBlend(mode) ? mode : undefined;
};

function drawOn(out: Rgba, src: Rgba, x: number, y: number, opacity: number, blend: string) {
  const mode = modeOf(blend);
  if (!mode) overNormal(out, src, x, y, opacity);
  else blendOver(out, src, x, y, { opacity, mode });
}

/** A group in the tree of layers (the root has none). */
export interface Node {
  group?: ImageGroup;
  /** Bottom first. */
  children: (Node | RLayer)[];
}

export const isNode = (n: Node | RLayer): n is Node => "children" in n;

/** The layers as the tree their groups make (layers of one group next to each other share it). */
export function treeOf(layers: readonly RLayer[]): Node {
  const root: Node = { children: [] };
  const open: Node[] = [root];
  for (const l of layers) {
    let k = 0;
    while (
      k < l.groups.length &&
      k + 1 < open.length &&
      (open[k + 1] as Node).group?.id === l.groups[k]?.id
    )
      k++;
    open.length = k + 1;
    for (let g = k; g < l.groups.length; g++) {
      const n: Node = { group: l.groups[g] as ImageGroup, children: [] };
      (open[open.length - 1] as Node).children.push(n);
      open.push(n);
    }
    (open[open.length - 1] as Node).children.push(l);
  }
  return root;
}

/** The picture drawn from its layers: visibility, places, opacity, blending, masks, groups. */
export function flatten(m: ImageModel, only?: (l: RLayer) => boolean): Rgba {
  const draw = (n: Node, out: Rgba, opacity: number) => {
    for (const c of n.children) {
      if (isNode(c)) {
        const g = c.group as ImageGroup;
        if (!g.visible) continue;
        if (g.isolate || g.opacity < 1 || g.blend !== "svg:src-over") {
          const sub = blank(m.width, m.height);
          draw(c, sub, 1);
          drawOn(out, sub, 0, 0, g.opacity * opacity, g.blend);
        } else draw(c, out, opacity);
      } else {
        if (!c.visible || c.px.width === 0 || c.px.height === 0) continue;
        if (only && !only(c)) continue;
        drawOn(out, masked(c), c.x, c.y, c.opacity * opacity, c.blend);
      }
    }
  };
  const out = blank(m.width, m.height);
  draw(treeOf(m.layers), out, 1);
  return out;
}

/** The picture over a colour (a JPEG has no transparency). */
export function over(img: Rgba, rgb: [number, number, number]): Rgba {
  const out = copyOf(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = (out.data[i + 3] as number) / 255;
    for (let c = 0; c < 3; c++)
      out.data[i + c] = Math.round((out.data[i + c] as number) * a + (rgb[c] as number) * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------- Files

const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** What a file is, from its first bytes. */
export function formatOf(bytes: Uint8Array): ImageModel["format"] | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "ora";
  return undefined;
}

const checkSize = (w: number, h: number) => {
  if (!(w > 0 && h > 0)) throw new Error("the picture has no size");
  if (w > IMAGE_MAX_SIDE || h > IMAGE_MAX_SIDE)
    throw new Error(`it is larger than ${IMAGE_MAX_SIDE} pixels a side`);
};

/** A picture of one layer. */
export function oneLayer(img: Rgba, format: "png" | "jpeg"): ImageModel {
  checkSize(img.width, img.height);
  return {
    width: img.width,
    height: img.height,
    format,
    layers: [
      {
        id: "image",
        name: "Background",
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        blend: "svg:src-over",
        groups: [],
        px: img,
        extra: {},
      },
    ],
    attrs: {},
    keep: {},
  };
}

export function readJpeg(bytes: Uint8Array): Rgba {
  const j = decodeJpeg(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 300,
    maxMemoryUsageInMB: 2048,
  });
  return { width: j.width, height: j.height, data: j.data };
}

export function writeJpeg(img: Rgba, quality = 92): Uint8Array {
  const j = encodeJpeg(
    { width: img.width, height: img.height, data: over(img, [255, 255, 255]).data },
    quality,
  );
  return new Uint8Array(j.data);
}

const KNOWN_LAYER = new Set([
  "name",
  "src",
  "x",
  "y",
  "opacity",
  "visibility",
  "composite-op",
  "edit-locked",
  "redgiant-mask",
  "redgiant-mask-x",
  "redgiant-mask-y",
  "redgiant-mask-outside",
  ...TEXT_ATTRS,
]);

/** A layer's id from its picture's name in the zip (`data/layer3.png` → `layer3`). */
const idOf = (src: string, used: Set<string>) => {
  const stem =
    (src.split("/").pop() ?? "layer")
      .replace(/\.png$/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 100) || "layer";
  let id = stem;
  for (let i = 2; used.has(id); i++) id = `${stem}-${i}`;
  used.add(id);
  return id;
};

/** An OpenRaster file: its layers, groups and what it keeps of other applications. */
export function readOra(bytes: Uint8Array): ImageModel {
  const z = unzip(bytes);
  if (!z) throw new Error("it is not a valid OpenRaster file (not a zip)");
  const stackXml = z["stack.xml"];
  if (!stackXml) throw new Error("it is not an OpenRaster file: there is no stack.xml");
  const image = elements(parseXml(strFromU8(stackXml))).find((e) => e.name === "image");
  if (!image) throw new Error("stack.xml has no <image>");
  const width = num(image.attrs.w, 0);
  const height = num(image.attrs.h, 0);
  checkSize(width, height);
  const used = new Set<string>();
  const usedEntries = new Set([
    "mimetype",
    "stack.xml",
    "mergedimage.png",
    "Thumbnails/thumbnail.png",
  ]);
  const layers: RLayer[] = [];
  let groups = 0;
  let pixels = 0;
  const walk = (stack: XmlNode, chain: ImageGroup[]) => {
    // Topmost first in the file.
    for (const e of [...elements(stack)].reverse()) {
      const opacity = Math.max(0, Math.min(1, num(e.attrs.opacity, 1)));
      const visible = e.attrs.visibility !== "hidden";
      const blend = e.attrs["composite-op"] ?? "svg:src-over";
      if (e.name === "stack") {
        const g: ImageGroup = {
          id: `g${++groups}`,
          name: e.attrs.name ?? "",
          opacity,
          visible,
          blend,
          isolate: e.attrs.isolation !== "auto",
        };
        walk(e, [...chain, g]);
      } else if (e.name === "layer") {
        const src = e.attrs.src ?? "";
        const png = src ? z[src] : undefined;
        if (src && !png) throw new Error(`stack.xml names ${src}, which is not in the file`);
        if (src) usedEntries.add(src);
        const px = png ? rgbaOf(png) : blank(0, 0);
        pixels += px.width * px.height;
        if (pixels > MAX_IMAGE_PIXELS)
          throw new Error("its layers are too big together to be edited here");
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.attrs)) if (!KNOWN_LAYER.has(k)) extra[k] = v;
        const l: RLayer = {
          id: idOf(src || e.attrs.name || "layer", used),
          name: e.attrs.name ?? "",
          x: Math.round(num(e.attrs.x, 0)),
          y: Math.round(num(e.attrs.y, 0)),
          opacity,
          visible,
          blend,
          ...(e.attrs["edit-locked"] === "true" && { locked: true }),
          groups: chain,
          px,
          extra,
        };
        const text = textOfAttrs(e.attrs);
        if (text) l.text = text;
        const ms = e.attrs["redgiant-mask"];
        const mpng = ms ? z[ms] : undefined;
        if (ms && mpng) {
          usedEntries.add(ms);
          l.mask = {
            x: Math.round(num(e.attrs["redgiant-mask-x"], l.x)),
            y: Math.round(num(e.attrs["redgiant-mask-y"], l.y)),
            outside: Math.max(
              0,
              Math.min(255, Math.round(num(e.attrs["redgiant-mask-outside"], 0))),
            ),
            img: rgbaOf(mpng),
          };
        }
        layers.push(l);
      }
    }
  };
  const top = elements(image).find((e) => e.name === "stack");
  if (top) walk(top, []);
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(image.attrs)) if (k !== "w" && k !== "h") attrs[k] = v;
  const keep: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(z)) if (!usedEntries.has(k) && !k.endsWith("/")) keep[k] = v;
  return { width, height, format: "ora", layers, attrs, keep };
}

// Line breaks and tabs as references: an XML reader makes plain ones in an attribute spaces.
const attrsText = (a: Record<string, string>) =>
  Object.entries(a)
    .map(([k, v]) => ` ${k}="${escapeXml(v).replace(/[\n\r\t]/g, (c) => `&#${c.charCodeAt(0)};`)}"`)
    .join("");
const fmtOpacity = (o: number) => String(Math.round(o * 1000) / 1000);

/** The model as an OpenRaster file (layers' PNGs made once per buffer, through the blobs). */
export function writeOra(m: ImageModel, blobs: ImageBlobs): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const xml = (n: Node, depth: string): string =>
    [...n.children]
      .reverse()
      .map((c) => {
        if (isNode(c)) {
          const g = c.group as ImageGroup;
          return `${depth}<stack${attrsText({
            name: g.name,
            opacity: fmtOpacity(g.opacity),
            visibility: g.visible ? "visible" : "hidden",
            "composite-op": g.blend,
            isolation: g.isolate ? "isolate" : "auto",
          })}>\n${xml(c, `${depth} `)}${depth}</stack>\n`;
        }
        const src = `data/${c.id}.png`;
        files[src] = blobs.pngBytes(c.px.width && c.px.height ? c.px : blank(1, 1));
        const a: Record<string, string> = {
          name: c.name,
          src,
          x: String(c.x),
          y: String(c.y),
          opacity: fmtOpacity(c.opacity),
          visibility: c.visible ? "visible" : "hidden",
          "composite-op": c.blend,
          ...(c.locked && { "edit-locked": "true" }),
          ...(c.text && textAttrs(c.text)),
        };
        if (c.mask) {
          const ms = `data/${c.id}.mask.png`;
          files[ms] = blobs.pngBytes(c.mask.img);
          Object.assign(a, {
            "redgiant-mask": ms,
            "redgiant-mask-x": String(c.mask.x),
            "redgiant-mask-y": String(c.mask.y),
            "redgiant-mask-outside": String(c.mask.outside),
          });
        }
        return `${depth}<layer${attrsText({ ...a, ...c.extra })}/>\n`;
      })
      .join("");
  const body = xml(treeOf(m.layers), "  ");
  const image = { version: "0.0.5", ...m.attrs, w: String(m.width), h: String(m.height) };
  const stack = `<?xml version="1.0" encoding="UTF-8"?>\n<image${attrsText(image)}>\n <stack>\n${body} </stack>\n</image>\n`;
  const merged = flatten(m);
  return packageZip("image/openraster", {
    "stack.xml": strToU8(stack),
    ...files,
    "mergedimage.png": pngOf(merged),
    "Thumbnails/thumbnail.png": pngOf(shrink(merged)),
    ...m.keep,
  });
}

/** Bytes to a model (OpenRaster, PNG or JPEG). */
export function readImage(bytes: Uint8Array): ImageModel {
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(`it is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const f = formatOf(bytes);
  if (f === "ora") return readOra(bytes);
  if (f === "png") {
    const img = rgbaOf(bytes);
    if (img.width * img.height > MAX_IMAGE_PIXELS) throw new Error("it is too big to edit here");
    return oneLayer(img, "png");
  }
  if (f === "jpeg") {
    const img = readJpeg(bytes);
    if (img.width * img.height > MAX_IMAGE_PIXELS) throw new Error("it is too big to edit here");
    return oneLayer(img, "jpeg");
  }
  throw new Error("it is not an OpenRaster, PNG or JPEG picture");
}

/** The model as its own format's bytes. */
export function writeImage(m: ImageModel, blobs: ImageBlobs): Uint8Array {
  if (m.format === "ora") return writeOra(m, blobs);
  const flat = flatten(m);
  return m.format === "png" ? pngOf(flat) : writeJpeg(flat);
}

/** Whether a PNG or JPEG holds more than one plain layer: its layers go in an OpenRaster copy. */
export const needsLayers = (m: ImageModel) =>
  m.format !== "ora" &&
  (m.layers.length > 1 ||
    m.layers.some(
      (l) =>
        !!l.mask ||
        l.opacity < 1 ||
        !l.visible ||
        l.blend !== "svg:src-over" ||
        l.x !== 0 ||
        l.y !== 0 ||
        l.px.width !== m.width ||
        l.px.height !== m.height,
    ));

// ---------------------------------------------------------------- The page's view

export const infoOf = (l: RLayer): ImageLayerInfo => ({
  id: l.id,
  name: l.name,
  x: l.x,
  y: l.y,
  w: l.px.width,
  h: l.px.height,
  opacity: l.opacity,
  visible: l.visible,
  blend: l.blend,
  ...(l.locked && { locked: true }),
  ...(l.groups.length && { groups: l.groups }),
  ...(l.text && { text: l.text }),
});

export const maskInfoOf = (m: RMask, blobs: ImageBlobs): ImageMask => ({
  x: m.x,
  y: m.y,
  w: m.img.width,
  h: m.img.height,
  outside: m.outside,
  png: blobs.hashOf(m.img),
});

export function snapshotOf(m: ImageModel, blobs: ImageBlobs): ImageSnapshot {
  return {
    family: "image",
    format: m.format,
    width: m.width,
    height: m.height,
    layers: m.layers.map((l) => ({
      ...infoOf(l),
      png: l.px.width && l.px.height ? blobs.hashOf(l.px) : null,
      ...(l.mask && { mask: maskInfoOf(l.mask, blobs) }),
    })),
  };
}
