// Geometry of a drawing without a browser (G37.6): transforms as matrices, and each element's box
// (its shape's coordinates, a path's points and control points, a text's estimated size) in its
// parent's or the drawing's coordinates. Good enough to align, distribute, rotate around a centre
// and to tell the agent where things are; the browser's own measure is in the page.
import { attrOf, textContent, type XEl } from "./xml.js";

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

export function invert(m: Matrix): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return undefined;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
export const numbers = (s: string): number[] => (s.match(NUM) ?? []).map(Number);

/** A `transform` attribute as one matrix (undefined when it cannot be read). */
export function parseTransform(s: string | undefined): Matrix | undefined {
  if (!s?.trim()) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let rest = s;
  for (const part of s.matchAll(re)) {
    rest = rest.replace(part[0], "");
    const v = numbers(part[2] as string);
    let t: Matrix;
    switch (part[1]) {
      case "matrix":
        if (v.length !== 6) return undefined;
        t = v as unknown as Matrix;
        break;
      case "translate":
        t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        const cx = v[1] ?? 0;
        const cy = v[2] ?? 0;
        t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return rest.replace(/[\s,]/g, "") ? undefined : m;
}

/** A number as a file keeps it: at most 6 decimals, no trailing zeros. */
export const fmt = (n: number): string => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const union = (a: Box | undefined, b: Box | undefined): Box | undefined => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
};

export const boxOf = (pts: readonly (readonly [number, number])[]): Box | undefined => {
  if (!pts.length) return undefined;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
};

export const transformBox = (m: Matrix, b: Box | undefined): Box | undefined =>
  b &&
  boxOf([
    apply(m, b.x, b.y),
    apply(m, b.x + b.w, b.y),
    apply(m, b.x, b.y + b.h),
    apply(m, b.x + b.w, b.y + b.h),
  ]);

/** A path's end points and control points, absolute (its box holds the curve). */
export function pathPoints(d: string): [number, number][] {
  const out: [number, number][] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i] as string);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i] as string)) cmd = tokens[i++] as string;
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      x = sx;
      y = sy;
      if (!isNum()) continue;
      // A number after Z without a command: stop reading.
      break;
    }
    if (!isNum()) continue;
    const pt = (px: number, py: number): [number, number] => (rel ? [x + px, y + py] : [px, py]);
    switch (C) {
      case "M":
      case "L":
      case "T": {
        const p = pt(num(), num());
        out.push(p);
        [x, y] = p;
        if (C === "M") {
          sx = x;
          sy = y;
          cmd = rel ? "l" : "L";
        }
        break;
      }
      case "H":
        x = rel ? x + num() : num();
        out.push([x, y]);
        break;
      case "V":
        y = rel ? y + num() : num();
        out.push([x, y]);
        break;
      case "C": {
        const a = pt(num(), num());
        const b = pt(num(), num());
        const p = pt(num(), num());
        out.push(a, b, p);
        [x, y] = p;
        break;
      }
      case "S":
      case "Q": {
        const a = pt(num(), num());
        const p = pt(num(), num());
        out.push(a, p);
        [x, y] = p;
        break;
      }
      case "A": {
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        num();
        num();
        num();
        const p = pt(num(), num());
        // The arc stays inside its radii around both ends.
        out.push(
          [x - rx, y - ry],
          [x + rx, y + ry],
          [p[0] - rx, p[1] - ry],
          [p[0] + rx, p[1] + ry],
        );
        [x, y] = p;
        break;
      }
      default:
        i = tokens.length;
    }
  }
  return out.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

const len = (v: string | undefined, d = 0) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : d;
};

/** A presentation property: the element's style first, then its attribute. */
export function propOf(el: XEl, name: string): string | undefined {
  const style = attrOf(el, "style");
  if (style)
    for (const part of style.split(";")) {
      const at = part.indexOf(":");
      if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
    }
  return attrOf(el, name);
}

const NO_BOX = new Set([
  "defs",
  "metadata",
  "title",
  "desc",
  "style",
  "script",
  "linearGradient",
  "radialGradient",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "marker",
  "symbol",
]);

/** Local name without a prefix (`svg:rect` → rect). */
export const local = (name: string) => name.slice(name.indexOf(":") + 1);

/**
 * The element's box in its parent's coordinates (its own transform applied); `fontSize` is the one
 * it inherits. Undefined for what is not drawn (defs, metadata) or cannot be measured.
 */
export function elementBox(
  el: XEl,
  entities: Readonly<Record<string, string>>,
  fontSize = 16,
): Box | undefined {
  const tag = el.name.includes(":") && !el.name.startsWith("svg:") ? "" : local(el.name);
  if (!tag || NO_BOX.has(tag)) return undefined;
  const m = parseTransform(attrOf(el, "transform")) ?? IDENTITY;
  const a = (n: string) => len(attrOf(el, n));
  let b: Box | undefined;
  switch (tag) {
    case "rect":
    case "image":
    case "use":
    case "foreignObject":
      b = { x: a("x"), y: a("y"), w: a("width"), h: a("height") };
      if (tag === "use" && !attrOf(el, "width")) b = undefined;
      break;
    case "circle": {
      const r = a("r");
      b = { x: a("cx") - r, y: a("cy") - r, w: 2 * r, h: 2 * r };
      break;
    }
    case "ellipse": {
      const rx = a("rx");
      const ry = a("ry");
      b = { x: a("cx") - rx, y: a("cy") - ry, w: 2 * rx, h: 2 * ry };
      break;
    }
    case "line":
      b = boxOf([
        [a("x1"), a("y1")],
        [a("x2"), a("y2")],
      ]);
      break;
    case "polygon":
    case "polyline": {
      const v = numbers(attrOf(el, "points") ?? "");
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i] as number, v[i + 1] as number]);
      b = boxOf(pts);
      break;
    }
    case "path":
      b = boxOf(pathPoints(attrOf(el, "d") ?? ""));
      break;
    case "text":
    case "tspan":
    case "textPath": {
      const fs = len(propOf(el, "font-size"), fontSize) || fontSize;
      const text = textContent(el, entities).replace(/\s+/g, " ").trim();
      const x = numbers(attrOf(el, "x") ?? "")[0];
      const y = numbers(attrOf(el, "y") ?? "")[0];
      if (x === undefined || y === undefined) {
        // Its tspans say where it is.
        b = childrenBox(el, entities, fs);
        break;
      }
      const w = text.length * fs * 0.55;
      const anchor = propOf(el, "text-anchor");
      const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      b = { x: x0, y: y - fs * 0.8, w, h: fs };
      break;
    }
    case "g":
    case "a":
    case "switch":
    case "svg":
      b = childrenBox(el, entities, len(propOf(el, "font-size"), fontSize) || fontSize);
      break;
    default:
      b = undefined;
  }
  return transformBox(m, b);
}

function childrenBox(el: XEl, entities: Readonly<Record<string, string>>, fs: number) {
  let b: Box | undefined;
  for (const c of el.children) if (c.k === "el") b = union(b, elementBox(c, entities, fs));
  return b;
}
