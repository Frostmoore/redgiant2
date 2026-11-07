// Sketch → SVG, from the shapes in the file (G34.3; the user's rule of 2026-11-07: nothing loses
// its layout). A Sketch file (43 and newer) is a zip of JSON: pages with artboards, groups,
// shapes whose points are fractions of their frame, texts, bitmaps and symbols. Each page becomes
// one SVG with its artboards where they are on the canvas (artboards clip their content, as in
// Sketch), every layer at its frame with its rotation, flips, fills, borders and opacity.

import { strFromU8, strToU8 } from "fflate";
import { type Converted, escapeXml } from "./convert-js.js";

type Json = Record<string, unknown>;
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const n = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const frameOf = (l: Json): Frame => {
  const f = (l.frame ?? {}) as Json;
  return { x: n(f.x), y: n(f.y), width: n(f.width), height: n(f.height) };
};

/** "{0.5, 1}" → [0.5, 1]. */
const pointOf = (s: unknown): [number, number] => {
  const m = String(s ?? "").match(/\{\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\}/i);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

const colour = (c: unknown): { hex: string; alpha: number } | undefined => {
  if (!c || typeof c !== "object") return undefined;
  const o = c as Json;
  const v = [o.red, o.green, o.blue].map((x) =>
    Math.round(Math.max(0, Math.min(1, n(x))) * 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return { hex: `#${v.join("")}`, alpha: n(o.alpha, 1) };
};

interface Ctx {
  losses: Set<string>;
  symbols: Map<string, Json>;
  images: Record<string, Uint8Array>;
  ids: number;
  depth: number;
}

function paint(style: Json | undefined, ctx: Ctx): string {
  const out: string[] = [];
  const fills = ((style?.fills as Json[]) ?? []).filter((f) => f.isEnabled !== false);
  const fill = fills[fills.length - 1];
  if (fill) {
    if (n(fill.fillType) !== 0) {
      ctx.losses.add("gradients and pattern fills are drawn with their first colour");
      const stops = ((fill.gradient as Json)?.stops as Json[]) ?? [];
      const c = colour(stops[0]?.color ?? fill.color);
      out.push(
        c ? `fill="${c.hex}"${c.alpha < 1 ? ` fill-opacity="${r3(c.alpha)}"` : ""}` : 'fill="none"',
      );
    } else {
      const c = colour(fill.color);
      out.push(
        c ? `fill="${c.hex}"${c.alpha < 1 ? ` fill-opacity="${r3(c.alpha)}"` : ""}` : 'fill="none"',
      );
    }
    if (fills.length > 1) ctx.losses.add("layers with several fills keep only the top one");
  } else out.push('fill="none"');
  const border = ((style?.borders as Json[]) ?? []).filter((b) => b.isEnabled !== false).at(-1);
  if (border) {
    const c = colour(border.color);
    if (c)
      out.push(
        `stroke="${c.hex}" stroke-width="${r3(n(border.thickness, 1))}"${c.alpha < 1 ? ` stroke-opacity="${r3(c.alpha)}"` : ""}`,
      );
    if (n(border.position) !== 0)
      ctx.losses.add("inside and outside borders are drawn centred on the edge");
  }
  const opacity = n((style?.contextSettings as Json)?.opacity, 1);
  if (opacity < 1) out.push(`opacity="${r3(opacity)}"`);
  if (((style?.shadows as Json[]) ?? []).some((s) => s.isEnabled !== false))
    ctx.losses.add("shadows and blurs are left out");
  if ((style?.blur as Json)?.isEnabled) ctx.losses.add("shadows and blurs are left out");
  return out.join(" ");
}

/** A shape's outline in its frame's coordinates. */
function pathData(l: Json, f: Frame): string {
  const pts = (l.points as Json[]) ?? [];
  if (!pts.length) return "";
  const at = (p: [number, number]) => `${r3(p[0] * f.width)} ${r3(p[1] * f.height)}`;
  const segs = [`M ${at(pointOf(pts[0]?.point))}`];
  const closed = l.isClosed !== false;
  const count = closed ? pts.length : pts.length - 1;
  for (let i = 1; i <= count; i++) {
    const a = pts[i - 1] as Json;
    const b = pts[i % pts.length] as Json;
    const curved = a.hasCurveFrom === true || b.hasCurveTo === true;
    segs.push(
      curved
        ? `C ${at(pointOf(a.curveFrom ?? a.point))} ${at(pointOf(b.curveTo ?? b.point))} ${at(pointOf(b.point))}`
        : `L ${at(pointOf(b.point))}`,
    );
  }
  return `${segs.join(" ")}${closed ? " Z" : ""}`;
}

/** Where a layer sits inside its parent: its frame, rotation (around its centre) and flips. */
function placeAttr(l: Json, f: Frame): string {
  const t = [`translate(${r3(f.x)} ${r3(f.y)})`];
  const rot = n(l.rotation);
  // Sketch stores the angle counterclockwise; SVG turns clockwise.
  if (rot) t.push(`rotate(${r3(-rot)} ${r3(f.width / 2)} ${r3(f.height / 2)})`);
  if (l.isFlippedHorizontal || l.isFlippedVertical)
    t.push(
      `translate(${l.isFlippedHorizontal ? r3(f.width) : 0} ${l.isFlippedVertical ? r3(f.height) : 0}) scale(${l.isFlippedHorizontal ? -1 : 1} ${l.isFlippedVertical ? -1 : 1})`,
    );
  return `transform="${t.join(" ")}"`;
}

function textSvg(l: Json, f: Frame, ctx: Ctx): string {
  const as = (l.attributedString ?? {}) as Json;
  const text = String(as.string ?? "");
  const attrs = (((as.attributes as Json[]) ?? [])[0]?.attributes ?? {}) as Json;
  const font = ((attrs.MSAttributedStringFontAttribute as Json)?.attributes ?? {}) as Json;
  const size = n(font.size, 12);
  const c = colour(attrs.MSAttributedStringColorAttribute) ?? { hex: "#000000", alpha: 1 };
  const para = (attrs.paragraphStyle ?? {}) as Json;
  const lineHeight = n(para.maximumLineHeight) || size * 1.2;
  const align = n(para.alignment); // 0 left, 1 right, 2 centre, 3 justified
  const anchor = align === 1 ? "end" : align === 2 ? "middle" : "start";
  const x = align === 1 ? f.width : align === 2 ? f.width / 2 : 0;
  if (((as.attributes as Json[]) ?? []).length > 1)
    ctx.losses.add("texts with several styles keep the first one");
  if (n(l.textBehaviour) === 1)
    ctx.losses.add(
      "fixed-width text boxes keep their own line breaks only (SVG text does not wrap)",
    );
  const family = String(font.name ?? "sans-serif").replace(
    /-(Regular|Bold|Italic|Medium|Light|Semibold|SemiBold|Black|Heavy)(Italic)?$/,
    "",
  );
  const weight = /Bold|Black|Heavy|Semibold|SemiBold/.test(String(font.name ?? ""))
    ? ' font-weight="bold"'
    : "";
  const italic = /Italic|Oblique/.test(String(font.name ?? "")) ? ' font-style="italic"' : "";
  const lines = text.split(/\r\n|\n|\u2028/);
  // The first baseline: about four fifths of the size below the top, plus half the extra leading.
  const first = (lineHeight - size) / 2 + size * 0.8;
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${r3(x)}" y="${r3(first + i * lineHeight)}">${escapeXml(line) || " "}</tspan>`,
    )
    .join("");
  return `<text font-family="${escapeXml(family)}" font-size="${r3(size)}"${weight}${italic} fill="${c.hex}"${c.alpha < 1 ? ` fill-opacity="${r3(c.alpha)}"` : ""} text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function layerSvg(l: Json, ctx: Ctx): string {
  if (l.isVisible === false) return "";
  const cls = String(l._class ?? "");
  if (["slice", "MSImmutableHotspotLayer", "hotspot"].includes(cls)) return "";
  if (ctx.depth > 40) return "";
  const f = frameOf(l);
  const name = `<title>${escapeXml(String(l.name ?? cls))}</title>`;
  const place = placeAttr(l, f);
  const style = l.style as Json | undefined;
  const kids = () => {
    ctx.depth++;
    const out = ((l.layers as Json[]) ?? []).map((c) => layerSvg(c, ctx)).join("");
    ctx.depth--;
    return out;
  };
  switch (cls) {
    case "group":
      return `<g ${place} ${paint(undefined, ctx).replace('fill="none"', "")}${n((style?.contextSettings as Json)?.opacity, 1) < 1 ? ` opacity="${r3(n((style?.contextSettings as Json)?.opacity, 1))}"` : ""}>${name}${kids()}</g>`;
    case "shapeGroup": {
      const parts = ((l.layers as Json[]) ?? []).filter((c) => c.isVisible !== false);
      if (parts.some((c) => n(c.booleanOperation, -1) >= 1))
        ctx.losses.add(
          "boolean operations (subtract, intersect, difference) are drawn as overlaid shapes",
        );
      const d = parts
        .map((c) => {
          const cf = frameOf(c);
          return `<path transform="translate(${r3(cf.x)} ${r3(cf.y)})" d="${pathData(c, cf)}"/>`;
        })
        .join("");
      return `<g ${place} ${paint(style, ctx)}>${name}${d}</g>`;
    }
    case "rectangle":
    case "oval":
    case "polygon":
    case "star":
    case "triangle":
    case "shapePath": {
      const p = paint(style, ctx);
      if (cls === "rectangle" && !l.edited) {
        const rx = n(l.fixedRadius) || n(((l.points as Json[]) ?? [])[0]?.cornerRadius);
        return `<rect ${place} width="${r3(f.width)}" height="${r3(f.height)}"${rx ? ` rx="${r3(rx)}"` : ""} ${p}>${name}</rect>`;
      }
      if (cls === "oval" && !l.edited)
        return `<ellipse ${place} cx="${r3(f.width / 2)}" cy="${r3(f.height / 2)}" rx="${r3(f.width / 2)}" ry="${r3(f.height / 2)}" ${p}>${name}</ellipse>`;
      return `<path ${place} d="${pathData(l, f)}" ${p}>${name}</path>`;
    }
    case "text":
      return `<g ${place}>${name}${textSvg(l, f, ctx)}</g>`;
    case "bitmap": {
      const ref = String((l.image as Json | undefined)?._ref ?? "");
      const data = ctx.images[ref] ?? ctx.images[`${ref}.png`];
      if (!data) {
        ctx.losses.add("some bitmaps were missing from the file and are left out");
        return "";
      }
      const ext = (ref.split(".").pop() ?? "png").toLowerCase();
      const mime = IMAGE_MIME[ext] ?? "image/png";
      return `<image ${place} width="${r3(f.width)}" height="${r3(f.height)}" preserveAspectRatio="none" href="data:${mime};base64,${Buffer.from(data).toString("base64")}">${name}</image>`;
    }
    case "symbolInstance": {
      const master = ctx.symbols.get(String(l.symbolID ?? ""));
      if (!master) {
        ctx.losses.add("symbols from libraries outside the file are left out");
        return "";
      }
      if (((l.overrideValues as Json[]) ?? []).length)
        ctx.losses.add(
          "symbol overrides (changed texts or images inside symbols) show the symbol's own content",
        );
      const mf = frameOf(master);
      const sx = mf.width ? f.width / mf.width : 1;
      const sy = mf.height ? f.height / mf.height : 1;
      ctx.depth++;
      const inner = ((master.layers as Json[]) ?? []).map((c) => layerSvg(c, ctx)).join("");
      ctx.depth--;
      return `<g ${place}>${name}<g transform="scale(${r3(sx)} ${r3(sy)})">${inner}</g></g>`;
    }
    default:
      if (Array.isArray(l.layers)) return `<g ${place}>${name}${kids()}</g>`;
      return "";
  }
}

function artboardSvg(a: Json, ctx: Ctx): string {
  const f = frameOf(a);
  const id = `ab${++ctx.ids}`;
  const bg = a.hasBackgroundColor ? colour(a.backgroundColor) : undefined;
  ctx.depth++;
  const inner = ((a.layers as Json[]) ?? []).map((c) => layerSvg(c, ctx)).join("");
  ctx.depth--;
  return `<g id="${id}" transform="translate(${r3(f.x)} ${r3(f.y)})"><title>${escapeXml(String(a.name ?? "Artboard"))}</title><clipPath id="${id}-clip"><rect width="${r3(f.width)}" height="${r3(f.height)}"/></clipPath><rect width="${r3(f.width)}" height="${r3(f.height)}" fill="${bg?.hex ?? "#ffffff"}"/><g clip-path="url(#${id}-clip)">${inner}</g></g>`;
}

/** Every page of a Sketch file as an SVG (the first one `<stem>.svg`, then `<stem>.<page>.svg`). */
export function sketchToSvg(entries: Record<string, Uint8Array>, stem: string): Converted {
  const pages: Json[] = [];
  for (const [name, b] of Object.entries(entries))
    if (/^pages\/[^/]+\.json$/.test(name))
      try {
        pages.push(JSON.parse(strFromU8(b)) as Json);
      } catch {
        // A broken page is skipped and said below.
      }
  // The order Sketch shows them in.
  let order: string[] = [];
  try {
    const doc = JSON.parse(strFromU8(entries["document.json"] ?? strToU8("{}"))) as Json;
    order = ((doc.pages as Json[]) ?? []).map((p) => String(p._ref ?? "").replace(/^pages\//, ""));
  } catch {
    order = [];
  }
  pages.sort((a, b) => order.indexOf(String(a.do_objectID)) - order.indexOf(String(b.do_objectID)));
  const symbols = new Map<string, Json>();
  const collect = (l: Json) => {
    if (l._class === "symbolMaster" && l.symbolID) symbols.set(String(l.symbolID), l);
    for (const c of (l.layers as Json[]) ?? []) collect(c);
  };
  for (const p of pages) collect(p);
  const images: Record<string, Uint8Array> = {};
  for (const [name, b] of Object.entries(entries)) if (name.startsWith("images/")) images[name] = b;
  const ctx: Ctx = { losses: new Set(), symbols, images, ids: 0, depth: 0 };
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const [i, page] of pages.entries()) {
    const layers = ((page.layers as Json[]) ?? []).filter((l) => l.isVisible !== false);
    // Symbols live on their own page; it is drawn too (as Sketch shows it).
    if (layers.length === 0) continue;
    const frames = layers.map(frameOf);
    const x0 = Math.min(...frames.map((f) => f.x));
    const y0 = Math.min(...frames.map((f) => f.y));
    const x1 = Math.max(...frames.map((f) => f.x + f.width));
    const y1 = Math.max(...frames.map((f) => f.y + f.height));
    const body = layers
      .map((l) =>
        l._class === "artboard" || l._class === "symbolMaster"
          ? artboardSvg(l, ctx)
          : layerSvg(l, ctx),
      )
      .join("");
    const title = String(page.name ?? `Page ${i + 1}`);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${r3(x0)} ${r3(y0)} ${r3(x1 - x0)} ${r3(y1 - y0)}" width="${r3(x1 - x0)}" height="${r3(y1 - y0)}"><title>${escapeXml(title)}</title>${body}</svg>\n`;
    let name =
      Object.keys(files).length === 0
        ? `${stem}.svg`
        : `${stem}.${title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || `page-${i + 1}`}.svg`;
    while (used.has(name)) name = name.replace(/\.svg$/, `-${i + 1}.svg`);
    used.add(name);
    files[name] = strToU8(svg);
  }
  if (Object.keys(files).length === 0) throw new Error("The Sketch file has no pages with layers");
  return {
    files,
    losses: [
      ...ctx.losses,
      "fonts are named as in Sketch: where one is not installed, a similar one is shown",
    ],
  };
}
