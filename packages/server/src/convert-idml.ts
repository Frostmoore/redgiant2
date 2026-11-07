// IDML → OpenDocument Drawing that keeps the layout (G34.3; the user: «IDML perde l'impaginazione
// non va bene, non la deve perdere»). Our own code, no outside program: every page with its size,
// every frame (text, image, shape, line) where InDesign put it — the spreads' transforms composed
// down to each item and taken back to its page —, the texts with their paragraph and character
// formatting, colours, linked or embedded images, layers, and the master pages' items on every
// page that uses them. Scribus (convert.ts) is the other way, when it can be had; this one is the
// fallback that always works. What stays approximate is said in the losses.

import { strFromU8, strToU8 } from "fflate";
import {
  type Converted,
  elements,
  escapeXml,
  packageZip,
  parseXml,
  walk,
  type XmlNode,
} from "./convert-js.js";

// ---------------------------------------------------------------- Geometry

/** An affine transform as InDesign writes it: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `p` after `q`. */
export const multiply = (p: Matrix, q: Matrix): Matrix => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
const numbers = (s: string | undefined) =>
  (s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => Number(n));
const matrixOf = (s: string | undefined): Matrix => {
  const n = numbers(s);
  return n.length === 6 && n.every(Number.isFinite) ? (n as Matrix) : IDENTITY;
};

/** A box placed on a page: its top left (before rotation), size and rotation (degrees, counterclockwise). */
export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  /** Mirrored (a negative determinant): the box is right, its content is not mirrored. */
  flipped: boolean;
  sheared: boolean;
}

/** Where a local box (x0,y0)-(x1,y1) lands under `m`, as ODF can say it. */
export function place(m: Matrix, x0: number, y0: number, x1: number, y1: number): Placement {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b) || 1;
  const det = a * d - b * c;
  const sy = det / sx;
  const shear = (a * c + b * d) / (sx * sx);
  const [x, y] = det < 0 ? apply(m, x0, y1) : apply(m, x0, y0);
  return {
    x,
    y,
    w: Math.abs(x1 - x0) * sx,
    h: Math.abs(y1 - y0) * Math.abs(sy),
    // InDesign's counterclockwise angle on a y-down page.
    angle: (Math.atan2(-b, a) * 180) / Math.PI,
    flipped: det < 0,
    sheared: Math.abs(shear) > 0.01,
  };
}

// ---------------------------------------------------------------- Colours

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

function labToRgb(L: number, A: number, B: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [X, Y, Z] = [0.95047 * f(fy + A / 500), f(fy), 1.08883 * f(fy - B / 200)];
  const lin = [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
  return lin.map((v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)) as [
    number,
    number,
    number,
  ];
}

/** Swatch references (`Color/Red`, `Tint/…`, `Swatch/None`) to #rrggbb, or null for none. */
export function colourTable(graphic: XmlNode | undefined): {
  get(ref: string | undefined, tint?: number): string | null | undefined;
  gradients: Set<string>;
} {
  const raw = new Map<string, XmlNode>();
  for (const e of graphic ? walk(graphic) : [])
    if (e.attrs.Self && ["Color", "Tint", "Gradient", "MixedInk", "Swatch"].includes(e.name))
      raw.set(e.attrs.Self, e);
  const gradients = new Set<string>();
  const mix = (c: string, tint: number) => {
    const v = [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
    const t = tint / 100;
    return hex(...(v.map((x) => 255 - (255 - x) * t) as [number, number, number]));
  };
  const get = (ref: string | undefined, tint = 100, depth = 0): string | null | undefined => {
    if (!ref || depth > 5) return undefined;
    if (ref === "Swatch/None" || ref === "n") return null;
    if (ref === "Color/Paper") return tint < 100 ? mix("#ffffff", tint) : "#ffffff";
    const e = raw.get(ref);
    if (!e)
      return ref === "Color/Black" || ref === "Color/Registration"
        ? mix("#000000", tint)
        : undefined;
    if (e.name === "Tint")
      return get(e.attrs.BaseColor, (tint * Number(e.attrs.TintValue ?? 100)) / 100, depth + 1);
    if (e.name === "Gradient") {
      gradients.add(ref);
      const stop = [...walk(e)].find((s) => s.name === "GradientStop");
      return get(stop?.attrs.StopColor, tint, depth + 1);
    }
    if (e.name !== "Color") return undefined;
    const v = numbers(e.attrs.ColorValue);
    let c: string;
    if (e.attrs.Space === "RGB") c = hex(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    else if (e.attrs.Space === "LAB") c = hex(...labToRgb(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0));
    else {
      const [C, M, Y, K] = (v.length ? v : [0, 0, 0, 100]).map((x) => (x ?? 0) / 100) as number[];
      const k = 1 - (K ?? 0);
      c = hex(255 * (1 - (C ?? 0)) * k, 255 * (1 - (M ?? 0)) * k, 255 * (1 - (Y ?? 0)) * k);
    }
    return tint < 100 ? mix(c, tint) : c;
  };
  return { get: (r, t) => get(r, t), gradients };
}

// ---------------------------------------------------------------- Styles

type Props = Record<string, string>;
const PROPERTY_CHILDREN = ["AppliedFont", "BasedOn", "Leading"];

/** An element's own attributes with <Properties><AppliedFont|BasedOn|Leading> folded in. */
function ownProps(e: XmlNode): Props {
  const p: Props = { ...e.attrs };
  const props = elements(e).find((c) => c.name === "Properties");
  for (const c of props ? elements(props) : [])
    if (PROPERTY_CHILDREN.includes(c.name))
      p[c.name === "AppliedFont" ? "font" : c.name] = c.children
        .filter((x) => typeof x === "string")
        .join("")
        .trim();
  return p;
}

const TEXT_KEYS = [
  "font",
  "FontStyle",
  "PointSize",
  "FillColor",
  "FillTint",
  "Leading",
  "Tracking",
  "Capitalization",
  "Underline",
  "StrikeThru",
  "Position",
];
const PARA_KEYS = [
  "Justification",
  "SpaceBefore",
  "SpaceAfter",
  "FirstLineIndent",
  "LeftIndent",
  "RightIndent",
];
const pick = (p: Props, keys: string[]) => {
  const o: Props = {};
  for (const k of keys) if (p[k] !== undefined && p[k] !== "") o[k] = p[k] as string;
  return o;
};

/** Paragraph and character styles with what they inherit (BasedOn) already merged. */
function styleSheet(styles: XmlNode | undefined) {
  const own = new Map<string, Props>();
  for (const e of styles ? walk(styles) : [])
    if ((e.name === "ParagraphStyle" || e.name === "CharacterStyle") && e.attrs.Self)
      own.set(e.attrs.Self, ownProps(e));
  const done = new Map<string, Props>();
  const resolve = (ref: string | undefined, depth = 0): Props => {
    if (!ref || depth > 20) return {};
    const hit = done.get(ref);
    if (hit) return hit;
    const p = own.get(ref);
    if (!p) return {};
    const parent = p.BasedOn && !p.BasedOn.includes("[No ") ? resolve(p.BasedOn, depth + 1) : {};
    const merged = { ...parent, ...pick(p, [...TEXT_KEYS, ...PARA_KEYS]) };
    done.set(ref, merged);
    return merged;
  };
  return {
    paragraph: (ref: string | undefined) => {
      const p = resolve(ref);
      return Object.keys(p).length ? p : resolve("ParagraphStyle/$ID/NormalParagraphStyle");
    },
    character: resolve,
  };
}

const ALIGN: Record<string, string> = {
  LeftAlign: "start",
  CenterAlign: "center",
  RightAlign: "end",
  LeftJustified: "justify",
  CenterJustified: "justify",
  RightJustified: "justify",
  FullyJustified: "justify",
  ToBindingSide: "start",
  AwayFromBindingSide: "end",
};

const pt = (v: string | number) => `${Math.round(Number(v) * 1000) / 1000}pt`;

function textProps(p: Props, colour: (ref: string, tint?: number) => string | null | undefined) {
  const out: string[] = [];
  if (p.font)
    out.push(`style:font-name="${escapeXml(p.font)}" fo:font-family="${escapeXml(p.font)}"`);
  if (p.PointSize) out.push(`fo:font-size="${pt(p.PointSize)}"`);
  if (p.FontStyle !== undefined) {
    const fs = p.FontStyle.toLowerCase();
    if (/bold|black|heavy|semibold|demi/.test(fs)) out.push('fo:font-weight="bold"');
    else if (p.explicit) out.push('fo:font-weight="normal"');
    if (/italic|oblique/.test(fs)) out.push('fo:font-style="italic"');
    else if (p.explicit) out.push('fo:font-style="normal"');
  }
  if (p.FillColor) {
    const c = colour(p.FillColor, p.FillTint ? Number(p.FillTint) : undefined);
    if (c) out.push(`fo:color="${c}"`);
  }
  if (p.Tracking && Number(p.Tracking))
    out.push(`fo:letter-spacing="${pt((Number(p.Tracking) / 1000) * Number(p.PointSize ?? 12))}"`);
  if (p.Capitalization === "AllCaps") out.push('fo:text-transform="uppercase"');
  if (p.Capitalization === "SmallCaps" || p.Capitalization === "CapToSmallCap")
    out.push('fo:font-variant="small-caps"');
  if (p.Underline === "true")
    out.push('style:text-underline-style="solid" style:text-underline-width="auto"');
  if (p.StrikeThru === "true") out.push('style:text-line-through-style="solid"');
  if (p.Position === "Superscript" || p.Position === "OTSuperscript")
    out.push('style:text-position="super 58%"');
  if (p.Position === "Subscript" || p.Position === "OTSubscript")
    out.push('style:text-position="sub 58%"');
  return out.join(" ");
}

function paraProps(p: Props) {
  const out: string[] = [];
  if (p.Justification && ALIGN[p.Justification])
    out.push(`fo:text-align="${ALIGN[p.Justification]}"`);
  if (p.SpaceBefore) out.push(`fo:margin-top="${pt(p.SpaceBefore)}"`);
  if (p.SpaceAfter) out.push(`fo:margin-bottom="${pt(p.SpaceAfter)}"`);
  if (p.LeftIndent) out.push(`fo:margin-left="${pt(p.LeftIndent)}"`);
  if (p.RightIndent) out.push(`fo:margin-right="${pt(p.RightIndent)}"`);
  if (p.FirstLineIndent) out.push(`fo:text-indent="${pt(p.FirstLineIndent)}"`);
  if (p.Leading && p.Leading !== "Auto" && Number(p.Leading) > 0)
    out.push(`fo:line-height="${pt(p.Leading)}"`);
  return out.join(" ");
}

// ---------------------------------------------------------------- Stories

/** InDesign's page number marker, kept through the XML reader. */
const PAGE_NUMBER = "\uE018";

interface Run {
  text: string;
  props: Props;
}
interface Paragraph {
  props: Props;
  runs: Run[];
}

/** A story's paragraphs with their merged formatting (tables as paragraphs, cell by cell). */
function storyParagraphs(
  story: XmlNode,
  sheet: ReturnType<typeof styleSheet>,
  seen: { anchored: number; tables: number; notes: number },
): Paragraph[] {
  const out: Paragraph[] = [];
  let current: Paragraph | undefined;
  const end = () => {
    if (current) out.push(current);
    current = undefined;
  };
  const visit = (n: XmlNode, para: Props, chars: Props) => {
    for (const c of elements(n)) {
      if (c.name === "ParagraphStyleRange") {
        const p = {
          ...sheet.paragraph(c.attrs.AppliedParagraphStyle),
          ...pick(ownProps(c), [...TEXT_KEYS, ...PARA_KEYS]),
        };
        visit(c, p, {});
        if (current?.runs.length) end();
      } else if (c.name === "CharacterStyleRange") {
        const ref = c.attrs.AppliedCharacterStyle;
        const cs = ref && !ref.includes("[No ") ? sheet.character(ref) : {};
        visit(c, para, { ...pick(cs, TEXT_KEYS), ...pick(ownProps(c), TEXT_KEYS) });
      } else if (c.name === "Content") {
        const text = c.children.filter((x) => typeof x === "string").join("");
        current ??= { props: para, runs: [] };
        current.runs.push({ text, props: { ...pick(para, TEXT_KEYS), ...chars } });
      } else if (c.name === "Br") {
        current ??= { props: para, runs: [] };
        end();
      } else if (c.name === "Table") {
        seen.tables++;
        end();
        for (const cell of [...walk(c)].filter((x) => x.name === "Cell")) {
          visit(cell, para, chars);
          end();
        }
      } else if (c.name === "Footnote" || c.name === "Note") seen.notes++;
      else if (
        ["Rectangle", "TextFrame", "Oval", "Polygon", "Group", "GraphicLine"].includes(c.name)
      )
        seen.anchored++;
      else if (c.name !== "Properties") visit(c, para, chars);
    }
  };
  visit(story, sheet.paragraph(undefined), {});
  end();
  return out;
}

// ---------------------------------------------------------------- Page items

export interface IdmlPage {
  name: string;
  width: number;
  height: number;
  /** The page's top left in its spread's coordinates. */
  origin: [number, number];
  master?: string;
}

type Kind = "text" | "rect" | "oval" | "path" | "image";

interface Item {
  id: string;
  kind: Kind;
  /** Local (inner) bounding box. */
  box: [number, number, number, number];
  /** Local → spread. */
  m: Matrix;
  /** Subpaths in local coordinates: anchor, left and right handles. */
  paths: { open: boolean; points: [number, number, number, number, number, number][] }[];
  e: XmlNode;
  layer?: string;
  opacity: number;
  image?: { node: XmlNode; m: Matrix };
}

function pathsOf(e: XmlNode): Item["paths"] {
  const props = elements(e).find((c) => c.name === "Properties");
  const geo = props && elements(props).find((c) => c.name === "PathGeometry");
  if (!geo) return [];
  return elements(geo)
    .filter((g) => g.name === "GeometryPathType")
    .map((g) => ({
      open: g.attrs.PathOpen === "true",
      points: [...walk(g)]
        .filter((p) => p.name === "PathPointType")
        .map((p) => {
          const a = numbers(p.attrs.Anchor);
          const l = p.attrs.LeftDirection ? numbers(p.attrs.LeftDirection) : a;
          const r = p.attrs.RightDirection ? numbers(p.attrs.RightDirection) : a;
          return [a[0] ?? 0, a[1] ?? 0, l[0] ?? 0, l[1] ?? 0, r[0] ?? 0, r[1] ?? 0] as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
        }),
    }))
    .filter((p) => p.points.length > 0);
}

const opacityOf = (e: XmlNode) => {
  const t = elements(e).find((c) => c.name === "TransparencySetting");
  const b = t && elements(t).find((c) => c.name === "BlendingSetting");
  return b?.attrs.Opacity ? Number(b.attrs.Opacity) / 100 : 1;
};

const SHAPES = new Set(["TextFrame", "Rectangle", "Oval", "Polygon", "GraphicLine"]);
const GRAPHICS = new Set(["Image", "PDF", "EPS", "WMF", "PICT", "ImportedPage", "SVG"]);

/** Every page item of a spread, groups opened, with its transform down to the spread. */
function spreadItems(spread: XmlNode, losses: Set<string>): Item[] {
  const out: Item[] = [];
  const visit = (n: XmlNode, m: Matrix, opacity: number, layer: string | undefined) => {
    for (const c of elements(n)) {
      if (c.attrs.Visible === "false") {
        losses.add("hidden items (Visible off in InDesign) are left out");
        continue;
      }
      const cm = multiply(m, matrixOf(c.attrs.ItemTransform));
      const op = opacity * opacityOf(c);
      const lay = c.attrs.ItemLayer ?? layer;
      if (c.name === "Group") {
        visit(c, cm, op, lay);
        continue;
      }
      if (!SHAPES.has(c.name)) continue;
      const paths = pathsOf(c);
      if (!paths.length) continue;
      const xs = paths.flatMap((p) => p.points.flatMap((q) => [q[0], q[2], q[4]]));
      const ys = paths.flatMap((p) => p.points.flatMap((q) => [q[1], q[3], q[5]]));
      const box: Item["box"] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const graphic = elements(c).find((g) => GRAPHICS.has(g.name));
      const curved = paths.some((p) =>
        p.points.some((q) => q[0] !== q[2] || q[1] !== q[3] || q[0] !== q[4] || q[1] !== q[5]),
      );
      const rectangular =
        paths.length === 1 && !curved && paths[0]?.points.length === 4 && !paths[0]?.open;
      const kind: Kind =
        c.name === "TextFrame"
          ? "text"
          : graphic
            ? "image"
            : c.name === "Oval"
              ? "oval"
              : c.name === "Rectangle" && rectangular
                ? "rect"
                : "path";
      out.push({
        id: c.attrs.Self ?? `item${out.length}`,
        kind,
        box,
        m: cm,
        paths,
        e: c,
        ...(lay && { layer: lay }),
        opacity: op,
        ...(graphic && { image: { node: graphic, m: matrixOf(graphic.attrs.ItemTransform) } }),
      });
      for (const s of elements(c).filter((x) => x.name === "TransparencySetting"))
        for (const fx of walk(s))
          if (
            (fx.attrs.Mode && fx.attrs.Mode !== "None") ||
            fx.attrs.Applied === "true" ||
            (fx.attrs.BlendMode && fx.attrs.BlendMode !== "Normal")
          )
            losses.add(
              "effects (drop shadows, feathering, glows, blending modes) are left out; opacity is kept",
            );
      if (c.attrs.CornerOption && !/None/.test(c.attrs.CornerOption))
        losses.add("rounded or fancy corners are drawn square");
    }
  };
  visit(spread, matrixOf(spread.attrs.ItemTransform), 1, undefined);
  return out;
}

function pagesOf(spread: XmlNode): IdmlPage[] {
  const sm = matrixOf(spread.attrs.ItemTransform);
  return elements(spread)
    .filter((p) => p.name === "Page")
    .map((p) => {
      const [t = 0, l = 0, b = 0, r = 0] = numbers(p.attrs.GeometricBounds);
      const origin = apply(multiply(sm, matrixOf(p.attrs.ItemTransform)), l, t);
      return {
        name: p.attrs.Name ?? "",
        width: r - l,
        height: b - t,
        origin,
        ...(p.attrs.AppliedMaster &&
          p.attrs.AppliedMaster !== "n" && { master: p.attrs.AppliedMaster }),
      };
    });
}

/** The page an item belongs to (its centre inside), or undefined on the pasteboard. */
function pageOfItem(it: Item, pages: IdmlPage[]): number | undefined {
  const [cx, cy] = apply(it.m, (it.box[0] + it.box[2]) / 2, (it.box[1] + it.box[3]) / 2);
  const i = pages.findIndex(
    (p) =>
      cx >= p.origin[0] - 0.01 &&
      cx <= p.origin[0] + p.width + 0.01 &&
      cy >= p.origin[1] - 0.01 &&
      cy <= p.origin[1] + p.height + 0.01,
  );
  return i >= 0 ? i : undefined;
}

// ---------------------------------------------------------------- Pictures

/** A picture's kind and natural size in points (pixels at its DPI; 72 when the file says none, as InDesign). */
export function pictureInfo(b: Uint8Array): { ext: string; mime: string; w?: number; h?: number } {
  const u32 = (i: number) =>
    ((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
  const u16 = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  if (b[0] === 0x89 && b[1] === 0x50) {
    const w = u32(16);
    const h = u32(20);
    let dpi = 72;
    for (let i = 8; i + 12 < b.length; ) {
      const len = u32(i);
      const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
      if (type === "pHYs" && b[i + 16] === 1) dpi = (u32(i + 8) * 0.0254) | 0 || 72;
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
    return { ext: "png", mime: "image/png", w: (w * 72) / dpi, h: (h * 72) / dpi };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let dpi = 72;
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1] ?? 0;
      const len = u16(i + 2);
      if (marker === 0xe0 && String.fromCharCode(...b.subarray(i + 4, i + 9)) === "JFIF\0") {
        const unit = b[i + 11];
        const x = u16(i + 12);
        if (unit === 1 && x > 1) dpi = x;
        if (unit === 2 && x > 1) dpi = x * 2.54;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return {
          ext: "jpg",
          mime: "image/jpeg",
          w: (u16(i + 7) * 72) / dpi,
          h: (u16(i + 5) * 72) / dpi,
        };
      i += 2 + len;
    }
    return { ext: "jpg", mime: "image/jpeg" };
  }
  const s = strFromU8(b.subarray(0, 8));
  if (s.startsWith("GIF8"))
    return {
      ext: "gif",
      mime: "image/gif",
      w: (b[6] ?? 0) | ((b[7] ?? 0) << 8),
      h: (b[8] ?? 0) | ((b[9] ?? 0) << 8),
    };
  if (s.startsWith("%PDF")) return { ext: "pdf", mime: "application/pdf" };
  if (s.startsWith("II*") || s.startsWith("MM\0*")) return { ext: "tif", mime: "image/tiff" };
  if (s.startsWith("8BPS")) return { ext: "psd", mime: "image/vnd.adobe.photoshop" };
  if (/^\s*<(\?xml|svg)/.test(strFromU8(b.subarray(0, 64))))
    return { ext: "svg", mime: "image/svg+xml" };
  return { ext: "bin", mime: "application/octet-stream" };
}

/** The linked files an IDML points to (LinkResourceURI), as written. */
export function idmlLinks(entries: Record<string, Uint8Array>): string[] {
  const out = new Set<string>();
  for (const [n, b] of Object.entries(entries))
    if (/^(MasterSpreads|Spreads)\/.+\.xml$/.test(n))
      for (const m of strFromU8(b).matchAll(/LinkResourceURI="([^"]+)"/g)) out.add(m[1] as string);
  return [...out];
}

/** The file name a link URI ends with (`file:/Users/x/Links/beach%20a.jpg` → `beach a.jpg`). */
export const linkName = (uri: string) => {
  const last = uri.replace(/\\/g, "/").split(/[/:]/).pop() ?? uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** The same IDML with its links pointing at files found here (for Scribus, which follows them). */
export function relinkIdml(
  entries: Record<string, Uint8Array>,
  found: Record<string, string>,
): Record<string, Uint8Array> {
  const out = { ...entries };
  for (const [n, b] of Object.entries(entries)) {
    if (!/^(MasterSpreads|Spreads)\/.+\.xml$/.test(n)) continue;
    const xml = strFromU8(b);
    const next = xml.replace(/LinkResourceURI="([^"]+)"/g, (all, uri: string) => {
      const p = found[uri];
      if (!p) return all;
      const url = `file:${p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`;
      return `LinkResourceURI="${escapeXml(encodeURI(url))}"`;
    });
    if (next !== xml) out[n] = strToU8(next);
  }
  return out;
}

// ---------------------------------------------------------------- ODG writer

const mm = (v: number) => `${Math.round(((v * 25.4) / 72) * 1000) / 1000}mm`;
const num = (v: number) => `${Math.round(v * 1e6) / 1e6}`;

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
  'xmlns:dc="http://purl.org/dc/elements/1.1/"',
  'office:version="1.3"',
].join(" ");

/** Automatic styles, one per distinct set of properties. */
class Styles {
  readonly list: string[] = [];
  private readonly seen = new Map<string, string>();
  name(family: "graphic" | "paragraph" | "text", prefix: string, inner: string): string {
    const key = `${family}|${inner}`;
    let n = this.seen.get(key);
    if (!n) {
      n = `${prefix}${this.seen.size + 1}`;
      this.seen.set(key, n);
      this.list.push(
        `<style:style style:name="${n}" style:family="${family}">${inner}</style:style>`,
      );
    }
    return n;
  }
}

function textXml(s: string, page: string) {
  return escapeXml(s)
    .replace(/\u2028/g, "<text:line-break/>")
    .replace(/\t/g, "<text:tab/>")
    .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`)
    .replace(
      new RegExp(PAGE_NUMBER, "g"),
      `<text:page-number>${escapeXml(page)}</text:page-number>`,
    )
    .replace(/[\uE000-\uF8FF\uFEFF]/g, "");
}

/** The paragraphs a frame shows, as ODF. */
function paragraphsXml(
  paras: Paragraph[],
  st: Styles,
  colour: ReturnType<typeof colourTable>["get"],
  page: string,
) {
  return paras
    .map((p) => {
      const pp = paraProps(p.props);
      const tp = textProps(pick(p.props, TEXT_KEYS), colour);
      const pName = st.name(
        "paragraph",
        "P",
        `${pp ? `<style:paragraph-properties ${pp}/>` : ""}${tp ? `<style:text-properties ${tp}/>` : ""}`,
      );
      const base = pick(p.props, TEXT_KEYS);
      const runs = p.runs
        .map((r) => {
          // Only what differs from the paragraph's own text formatting.
          const own: Props = {};
          for (const [k, v] of Object.entries(r.props)) if (base[k] !== v) own[k] = v;
          if (own.FontStyle) own.explicit = "1";
          const t = textProps(own, colour);
          const body = textXml(r.text, page);
          return t
            ? `<text:span text:style-name="${st.name("text", "T", `<style:text-properties ${t}/>`)}">${body}</text:span>`
            : body;
        })
        .join("");
      return `<text:p text:style-name="${pName}">${runs}</text:p>`;
    })
    .join("");
}

/**
 * Splits a threaded story across its frames by how much text each frame can hold (an estimate).
 * `overset` is set when the last frame looks much too small for what is left (InDesign hides it).
 */
function distribute(
  paras: Paragraph[],
  frames: { w: number; h: number }[],
  overset: { found: boolean },
): Paragraph[][] {
  const out: Paragraph[][] = frames.map(() => []);
  let f = 0;
  let room = (frames[0]?.w ?? 0) * (frames[0]?.h ?? 0);
  const size = (p: Props) => Number(p.PointSize ?? 12) || 12;
  const lead = (p: Props, s: number) =>
    p.Leading && p.Leading !== "Auto" && Number(p.Leading) > 0 ? Number(p.Leading) : s * 1.2;
  for (const para of paras) {
    let piece: Paragraph = { props: para.props, runs: [] };
    for (const run of para.runs) {
      let text = run.text;
      while (text) {
        const s = size(run.props);
        const perChar = 0.5 * s * lead(para.props, s);
        const fits = f === frames.length - 1 ? text.length : Math.floor(room / perChar);
        if (f === frames.length - 1) room -= text.length * perChar;
        if (fits >= text.length) {
          piece.runs.push({ ...run, text });
          if (f < frames.length - 1) room -= text.length * perChar;
          text = "";
          break;
        }
        // Break at the last space that fits, then go on in the next frame.
        let cut = text.lastIndexOf(" ", Math.max(0, fits));
        if (cut <= 0) cut = Math.max(0, fits);
        if (cut > 0) piece.runs.push({ ...run, text: text.slice(0, cut + 1) });
        if (piece.runs.length) (out[f] as Paragraph[]).push(piece);
        piece = { props: { ...para.props, FirstLineIndent: "0" }, runs: [] };
        text = text.slice(cut + 1);
        f++;
        room = (frames[f]?.w ?? 0) * (frames[f]?.h ?? 0);
      }
    }
    if (piece.runs.length || para.runs.length === 0) (out[f] as Paragraph[]).push(piece);
    const s = size(para.props);
    room -= (frames[f]?.w ?? 0) * lead(para.props, s) * 0.5;
  }
  const last = frames[frames.length - 1];
  if (last && room < -0.25 * last.w * last.h) overset.found = true;
  return out;
}

export interface IdmlLayout {
  pages: IdmlPage[];
  layers: { id: string; name: string; visible: boolean; locked: boolean }[];
}

/**
 * An IDML as an ODG that keeps the layout. `pictures` gives the bytes of the linked files that
 * were found (by their LinkResourceURI); the others are drawn as grey boxes and named in the losses.
 */
export function idmlToOdg(
  entries: Record<string, Uint8Array>,
  stem: string,
  pictures: Record<string, Uint8Array> = {},
): Converted & { layout: IdmlLayout } {
  const read = (n: string | undefined) => {
    const b = n ? entries[n] : undefined;
    if (!b) return undefined;
    return parseXml(strFromU8(b).replace(/<\?ACE 18\s*\?>/g, PAGE_NUMBER));
  };
  const design = read("designmap.xml");
  if (!design) throw new Error("Not an IDML: there is no designmap.xml");
  const src = (tag: string) =>
    [...walk(design)]
      .filter((e) => e.name === tag && e.attrs.src)
      .map((e) => e.attrs.src as string);
  const losses = new Set<string>();
  const colours = colourTable(read(src("idPkg:Graphic")[0] ?? "Resources/Graphic.xml"));
  const colour = colours.get;
  const sheet = styleSheet(read(src("idPkg:Styles")[0] ?? "Resources/Styles.xml"));
  const layers = [...walk(design)]
    .filter((e) => e.name === "Layer" && e.attrs.Self)
    .map((e) => ({
      id: e.attrs.Self as string,
      name: e.attrs.Name ?? (e.attrs.Self as string),
      visible: e.attrs.Visible !== "false",
      locked: e.attrs.Locked === "true",
    }));
  const layerName = new Map(layers.map((l) => [l.id, l.name]));

  // Stories, by their Self id.
  const seen = { anchored: 0, tables: 0, notes: 0 };
  const stories = new Map<string, Paragraph[]>();
  const storyFiles = src("idPkg:Story");
  for (const n of Object.keys(entries))
    if (/^Stories\/.+\.xml$/.test(n) && !storyFiles.includes(n)) storyFiles.push(n);
  for (const f of storyFiles) {
    const s = read(f);
    const story = s && [...walk(s)].find((e) => e.name === "Story");
    if (story?.attrs.Self) stories.set(story.attrs.Self, storyParagraphs(story, sheet, seen));
  }

  // Masters and spreads.
  const masters = new Map<string, { pages: IdmlPage[]; items: Item[]; name: string }>();
  for (const f of src("idPkg:MasterSpread")) {
    const x = read(f);
    const ms = x && [...walk(x)].find((e) => e.name === "MasterSpread");
    if (!ms?.attrs.Self) continue;
    masters.set(ms.attrs.Self, {
      pages: pagesOf(ms),
      items: spreadItems(ms, losses),
      name: ms.attrs.Name ?? ms.attrs.Self,
    });
  }
  const pages: IdmlPage[] = [];
  const onPage: { it: Item; master?: string }[][] = [];
  let pasteboard = 0;
  for (const f of src("idPkg:Spread")) {
    const x = read(f);
    const spread = x && [...walk(x)].find((e) => e.name === "Spread");
    if (!spread) continue;
    const ps = pagesOf(spread);
    const base = pages.length;
    for (const p of ps) {
      pages.push(p);
      const list: { it: Item; master?: string }[] = [];
      // The master's items first (behind), taken from its page on the same side.
      const m = p.master ? masters.get(p.master) : undefined;
      if (m?.pages.length) {
        const side =
          m.pages.length === 1
            ? 0
            : Math.max(
                0,
                m.pages.findIndex(
                  (mp) => Math.sign(mp.origin[0] + 0.5) === Math.sign(p.origin[0] + 0.5),
                ),
              );
        const mp = m.pages[side] as IdmlPage;
        for (const it of m.items)
          if (pageOfItem(it, m.pages) === side)
            list.push({
              it: {
                ...it,
                m: multiply(
                  [1, 0, 0, 1, p.origin[0] - mp.origin[0], p.origin[1] - mp.origin[1]],
                  it.m,
                ),
              },
              master: m.name,
            });
      }
      onPage.push(list);
    }
    for (const it of spreadItems(spread, losses)) {
      const i = pageOfItem(it, ps);
      if (i === undefined) pasteboard++;
      else onPage[base + i]?.push({ it });
    }
  }
  if (pages.length === 0) throw new Error("This IDML has no pages");
  if (pasteboard)
    losses.add(`${pasteboard} item(s) on the pasteboard, outside every page, are left out`);

  // Threaded frames: each story split over its chain (in the document's chain order).
  const chainOf = new Map<string, string[]>();
  const frameById = new Map<string, Item>();
  for (const list of onPage)
    for (const { it } of list) if (it.kind === "text") frameById.set(it.id, it);
  for (const it of frameById.values()) {
    const prev = it.e.attrs.PreviousTextFrame;
    if (prev && prev !== "n" && frameById.has(prev)) continue;
    const chain = [it.id];
    let next = it.e.attrs.NextTextFrame;
    while (next && next !== "n" && frameById.has(next) && !chain.includes(next)) {
      chain.push(next);
      next = frameById.get(next)?.e.attrs.NextTextFrame;
    }
    chainOf.set(it.id, chain);
  }
  const frameText = new Map<string, Paragraph[]>();
  const partOf = new Map<string, [number, number]>();
  let threaded = false;
  const overset = { found: false };
  for (const chain of chainOf.values()) {
    const first = frameById.get(chain[0] as string) as Item;
    const paras = stories.get(first.e.attrs.ParentStory ?? "") ?? [];
    if (chain.length > 1) threaded = true;
    const parts = distribute(
      paras,
      chain.map((id) => {
        const it = frameById.get(id) as Item;
        const p = place(it.m, ...it.box);
        return { w: p.w, h: p.h };
      }),
      overset,
    );
    chain.forEach((id, i) => {
      frameText.set(id, parts[i] ?? []);
      if (chain.length > 1) partOf.set(id, [i + 1, chain.length]);
    });
  }
  if (overset.found)
    losses.add(
      "some stories look longer than their frames (overset text, hidden in InDesign): all of it is kept, in the last frame, and runs past its bottom",
    );
  if (threaded)
    losses.add(
      "text that flows through linked frames is split between them by an estimate of how much each holds: line breaks can fall a little earlier or later than in InDesign (the frames' names say which story and which part)",
    );

  // The drawing.
  const st = new Styles();
  const files: Record<string, Uint8Array> = {};
  const media: { path: string; mime: string }[] = [];
  const missing = new Set<string>();
  const fonts = new Set<string>();
  for (const s of stories.values())
    for (const p of s) {
      if (p.props.font) fonts.add(p.props.font);
      for (const r of p.runs) if (r.props.font) fonts.add(r.props.font);
    }
  let pictureCount = 0;
  const shapeXml = (it: Item, pageIdx: number, master?: string): string => {
    const page = pages[pageIdx] as IdmlPage;
    const toPage: Matrix = multiply([1, 0, 0, 1, -page.origin[0], -page.origin[1]], it.m);
    const p = place(toPage, ...it.box);
    if (p.sheared) losses.add("skewed frames are drawn without their skew");
    if (p.flipped)
      losses.add("mirrored frames keep their place but not the mirroring of their content");
    const geom = (q: Placement) =>
      Math.abs(q.angle) < 0.001
        ? `svg:x="${mm(q.x)}" svg:y="${mm(q.y)}" svg:width="${mm(q.w)}" svg:height="${mm(q.h)}"`
        : `svg:width="${mm(q.w)}" svg:height="${mm(q.h)}" draw:transform="rotate (${num((q.angle * Math.PI) / 180)}) translate (${mm(q.x)} ${mm(q.y)})"`;
    const layer = it.layer && layerName.get(it.layer);
    const part = partOf.get(it.id);
    const story = it.kind === "text" ? it.e.attrs.ParentStory : undefined;
    const name = `${it.e.name} ${it.id}${master ? ` (master ${master})` : ""}${story ? `, story ${story}${part ? ` part ${part[0]} of ${part[1]}` : ""}` : ""}`;
    const common = `draw:name="${escapeXml(name)}"${layer ? ` draw:layer="${escapeXml(layer)}"` : ""}`;
    const fill = colour(
      it.e.attrs.FillColor,
      it.e.attrs.FillTint ? Number(it.e.attrs.FillTint) : undefined,
    );
    const stroke = colour(
      it.e.attrs.StrokeColor,
      it.e.attrs.StrokeTint ? Number(it.e.attrs.StrokeTint) : undefined,
    );
    const weight = Number(it.e.attrs.StrokeWeight ?? 1);
    const g: string[] = [
      fill ? `draw:fill="solid" draw:fill-color="${fill}"` : 'draw:fill="none"',
      stroke && weight > 0
        ? `draw:stroke="solid" svg:stroke-color="${stroke}" svg:stroke-width="${mm(weight)}"`
        : 'draw:stroke="none"',
      'draw:shadow="hidden"',
    ];
    if (it.opacity < 1) g.push(`draw:opacity="${Math.round(it.opacity * 100)}%"`);
    if (it.kind === "text") {
      const pref = elements(it.e).find((c) => c.name === "TextFramePreference");
      const insets = (() => {
        if (!pref) return [0, 0, 0, 0];
        const at = numbers(pref.attrs.InsetSpacing);
        if (at.length) return at.length === 1 ? [at[0], at[0], at[0], at[0]] : at;
        const props = elements(pref).find((c) => c.name === "Properties");
        const list = props && elements(props).find((c) => c.name === "InsetSpacing");
        return list
          ? elements(list).map((li) =>
              Number(li.children.filter((x) => typeof x === "string").join("")),
            )
          : [0, 0, 0, 0];
      })() as number[];
      const [t = 0, l = 0, b = 0, r = 0] = insets;
      const v = {
        TopAlign: "top",
        CenterAlign: "middle",
        BottomAlign: "bottom",
        JustifyAlign: "justify",
      }[pref?.attrs.VerticalJustification ?? "TopAlign"];
      g.push(
        `draw:textarea-vertical-align="${v ?? "top"}" draw:auto-grow-height="false" draw:auto-grow-width="false" fo:min-height="0mm" fo:padding-top="${mm(t)}" fo:padding-left="${mm(l)}" fo:padding-bottom="${mm(b)}" fo:padding-right="${mm(r)}"`,
      );
      const cols = Number(pref?.attrs.TextColumnCount ?? 1);
      const inner =
        cols > 1
          ? `<style:graphic-properties ${g.join(" ")}><style:columns fo:column-count="${cols}" fo:column-gap="${mm(Number(pref?.attrs.TextColumnGutter ?? 12))}"/></style:graphic-properties>`
          : `<style:graphic-properties ${g.join(" ")}/>`;
      const style = st.name("graphic", "gr", inner);
      const body = paragraphsXml(frameText.get(it.id) ?? [], st, colour, page.name);
      return `<draw:frame draw:style-name="${style}" ${common} ${geom(p)}><draw:text-box>${body}</draw:text-box></draw:frame>`;
    }
    if (it.kind === "image" && it.image) {
      const node = it.image.node;
      const props = elements(node).find((c) => c.name === "Properties");
      const contents = props && elements(props).find((c) => c.name === "Contents");
      const gb = props && elements(props).find((c) => c.name === "GraphicBounds");
      const link = elements(node).find((c) => c.name === "Link")?.attrs.LinkResourceURI;
      let bytes: Uint8Array | undefined;
      if (contents)
        bytes = new Uint8Array(Buffer.from(contents.children.join("").trim(), "base64"));
      else if (link) bytes = pictures[link];
      const frame = `<draw:rect draw:style-name="${st.name("graphic", "gr", `<style:graphic-properties ${g.join(" ")}/>`)}" ${common} ${geom(p)}/>`;
      if (!bytes?.length) {
        if (link) missing.add(linkName(link));
        const grey = st.name(
          "graphic",
          "gr",
          '<style:graphic-properties draw:fill="solid" draw:fill-color="#d9d9d9" draw:stroke="solid" svg:stroke-color="#999999" draw:shadow="hidden"/>',
        );
        return `<draw:rect draw:style-name="${grey}" ${common} ${geom(p)}><svg:title>${escapeXml(`Missing image: ${link ? linkName(link) : node.name}`)}</svg:title></draw:rect>`;
      }
      const info = pictureInfo(bytes);
      if (["psd", "bin"].includes(info.ext))
        losses.add(
          "pictures in formats LibreOffice cannot draw (Photoshop, unknown) stay in Pictures/ but may show empty",
        );
      const path = `Pictures/image${++pictureCount}.${info.ext}`;
      files[path] = bytes;
      media.push({ path, mime: info.mime });
      // The picture's own box (its bounds through its transform), cut by the frame's.
      const [L, T, R, B] = gb
        ? [gb.attrs.Left, gb.attrs.Top, gb.attrs.Right, gb.attrs.Bottom].map((v) => Number(v ?? 0))
        : [0, 0, info.w ?? it.box[2] - it.box[0], info.h ?? it.box[3] - it.box[1]];
      const im = it.image.m;
      const straight = Math.abs(im[1]) < 1e-6 && Math.abs(im[2]) < 1e-6 && im[0] > 0 && im[3] > 0;
      const [ix0, iy0] = apply(im, L as number, T as number);
      const [ix1, iy1] = apply(im, R as number, B as number);
      const [fx0, fy0, fx1, fy1] = it.box;
      const vx0 = Math.max(ix0, fx0);
      const vy0 = Math.max(iy0, fy0);
      const vx1 = Math.min(ix1, fx1);
      const vy1 = Math.min(iy1, fy1);
      if (!straight || vx1 <= vx0 || vy1 <= vy0) {
        if (!straight)
          losses.add("pictures rotated inside their frame are drawn without the frame's crop");
        const q = place(multiply(toPage, im), L as number, T as number, R as number, B as number);
        return `${frame}<draw:frame draw:style-name="${st.name("graphic", "gr", '<style:graphic-properties draw:fill="none" draw:stroke="none"/>')}" ${common} ${geom(q)}><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
      }
      // fo:clip is measured on the picture at its natural size; InDesign's bounds are in points.
      const kx =
        info.w && (R as number) > (L as number) ? info.w / ((R as number) - (L as number)) : 1;
      const ky =
        info.h && (B as number) > (T as number) ? info.h / ((B as number) - (T as number)) : 1;
      const clip = [
        ((vy0 - iy0) / im[3]) * ky,
        ((ix1 - vx1) / im[0]) * kx,
        ((iy1 - vy1) / im[3]) * ky,
        ((vx0 - ix0) / im[0]) * kx,
      ];
      const cut = clip.some((c) => c > 0.001);
      const q = place(toPage, vx0, vy0, vx1, vy1);
      const style = st.name(
        "graphic",
        "gr",
        `<style:graphic-properties draw:fill="none" draw:stroke="none"${cut ? ` fo:clip="rect(${clip.map(mm).join(", ")})"` : ""}/>`,
      );
      return `${fill || stroke ? frame : ""}<draw:frame draw:style-name="${style}" ${common} ${geom(q)}><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`;
    }
    const style = st.name("graphic", "gr", `<style:graphic-properties ${g.join(" ")}/>`);
    if (it.kind === "rect") return `<draw:rect draw:style-name="${style}" ${common} ${geom(p)}/>`;
    if (it.kind === "oval")
      return `<draw:ellipse draw:style-name="${style}" ${common} ${geom(p)}/>`;
    // A path in the box's own coordinates (hundredths of a millimetre).
    const [x0, y0, x1, y1] = it.box;
    const k = (25.4 / 72) * 100;
    const sx = Math.hypot(toPage[0], toPage[1]) || 1;
    const sy = Math.abs((toPage[0] * toPage[3] - toPage[1] * toPage[2]) / sx);
    const flipY = p.flipped;
    const X = (x: number) => Math.round((x - x0) * sx * k);
    const Y = (y: number) => Math.round((flipY ? y1 - y : y - y0) * sy * k);
    const d = it.paths
      .map((sp) => {
        const pts = sp.points;
        const segs = [`M ${X(pts[0]?.[0] ?? 0)} ${Y(pts[0]?.[1] ?? 0)}`];
        const n = pts.length;
        for (let i = 1; i <= (sp.open ? n - 1 : n); i++) {
          const a = pts[i - 1] as number[];
          const b = pts[i % n] as number[];
          const straightSeg = a[4] === a[0] && a[5] === a[1] && b[2] === b[0] && b[3] === b[1];
          segs.push(
            straightSeg
              ? `L ${X(b[0] as number)} ${Y(b[1] as number)}`
              : `C ${X(a[4] as number)} ${Y(a[5] as number)} ${X(b[2] as number)} ${Y(b[3] as number)} ${X(b[0] as number)} ${Y(b[1] as number)}`,
          );
        }
        return `${segs.join(" ")}${sp.open ? "" : " Z"}`;
      })
      .join(" ");
    const vw = Math.max(1, Math.round((x1 - x0) * sx * k));
    const vh = Math.max(1, Math.round((y1 - y0) * sy * k));
    return `<draw:path draw:style-name="${style}" ${common} ${geom({ ...p, w: Math.max(p.w, 0.01), h: Math.max(p.h, 0.01) })} svg:viewBox="0 0 ${vw} ${vh}" svg:d="${d}"/>`;
  };

  // One page layout and master per page size.
  const sizes = new Map<string, string>();
  const sizeOf = (p: IdmlPage) => {
    const key = `${mm(p.width)}x${mm(p.height)}`;
    let n = sizes.get(key);
    if (!n) {
      n = `M${sizes.size + 1}`;
      sizes.set(key, n);
    }
    return n;
  };
  const body = pages
    .map((p, i) => {
      const shapes = (onPage[i] ?? []).map(({ it, master }) => shapeXml(it, i, master)).join("");
      return `<draw:page draw:name="${escapeXml(`Page ${p.name || i + 1}`)}" draw:master-page-name="${sizeOf(p)}">${shapes}</draw:page>`;
    })
    .join("");
  const layouts = [...sizes.entries()]
    .map(([key, n]) => {
      const [w, h] = key.split("x");
      return `<style:page-layout style:name="PL${n}"><style:page-layout-properties fo:margin-top="0mm" fo:margin-bottom="0mm" fo:margin-left="0mm" fo:margin-right="0mm" fo:page-width="${w}" fo:page-height="${h}" style:print-orientation="${Number.parseFloat(w as string) > Number.parseFloat(h as string) ? "landscape" : "portrait"}"/></style:page-layout>`;
    })
    .join("");
  const masterXml = [...sizes.values()]
    .map((n) => `<style:master-page style:name="${n}" style:page-layout-name="PL${n}"/>`)
    .join("");
  const layerSet = `<draw:layer-set><draw:layer draw:name="layout"/><draw:layer draw:name="background"/><draw:layer draw:name="backgroundobjects"/><draw:layer draw:name="controls"/><draw:layer draw:name="measurelines"/>${layers
    .map(
      (l) =>
        `<draw:layer draw:name="${escapeXml(l.name)}"${l.visible ? "" : ' draw:display="none"'}${l.locked ? ' draw:protected="true"' : ""}/>`,
    )
    .join("")}</draw:layer-set>`;
  const faces = `<office:font-face-decls>${[...fonts]
    .map((f) => `<style:font-face style:name="${escapeXml(f)}" svg:font-family="${escapeXml(f)}"/>`)
    .join("")}</office:font-face-decls>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NS}>${faces}<office:automatic-styles>${st.list.join("")}</office:automatic-styles><office:body><office:drawing>${body}</office:drawing></office:body></office:document-content>\n`;
  const defaults =
    '<style:default-style style:family="graphic"><style:graphic-properties draw:shadow="hidden" draw:fill="none" draw:stroke="none"/><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt"/><style:text-properties fo:font-size="12pt" fo:color="#000000"/></style:default-style>';
  const styles = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NS}>${faces}<office:styles>${defaults}</office:styles><office:automatic-styles>${layouts}</office:automatic-styles><office:master-styles>${layerSet}${masterXml}</office:master-styles></office:document-styles>\n`;
  const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NS}><office:meta><dc:title>${escapeXml(stem)}</dc:title><meta:generator xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">RedGiant IDML import</meta:generator></office:meta></office:document-meta>\n`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.graphics"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${media
    .map(
      (m) =>
        `<manifest:file-entry manifest:full-path="${m.path}" manifest:media-type="${m.mime}"/>`,
    )
    .join("")}</manifest:manifest>\n`;
  const odg = packageZip("application/vnd.oasis.opendocument.graphics", {
    "content.xml": strToU8(content),
    "styles.xml": strToU8(styles),
    "meta.xml": strToU8(meta),
    "META-INF/manifest.xml": strToU8(manifest),
    ...files,
  });

  if (missing.size)
    losses.add(
      `${missing.size} linked image(s) were not found beside the IDML (nor in a Links folder) and are grey boxes: ${[...missing].slice(0, 8).join(", ")}. Put them there and convert again`,
    );
  if (colours.gradients.size) losses.add("gradients are filled with their first colour");
  if (seen.tables) losses.add("tables are kept as their cells' text, one paragraph per cell");
  if (seen.anchored) losses.add("objects anchored inside the text are left out");
  if (seen.notes) losses.add("footnotes and notes are left out");
  if (fonts.size)
    losses.add(
      `fonts used: ${[...fonts].slice(0, 12).join(", ")}; where one is not installed LibreOffice shows a similar one, and the text can reflow a little`,
    );
  losses.add(
    "paragraph and character styles are kept as each paragraph's formatting (a drawing has no named text styles); master pages' items are copied on each page that uses them",
  );
  return {
    files: { [`${stem}.odg`]: odg },
    losses: [...losses],
    layout: { pages, layers },
  };
}
