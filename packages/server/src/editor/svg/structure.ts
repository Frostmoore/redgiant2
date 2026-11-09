// What the agent reads of a drawing (G37.6, canvas_look view "structure"): the tree of elements,
// one per line, with its id (or virtual id), kind, label, box in the drawing's coordinates, text
// and paint. What is kept but not drawn (metadata, Inkscape's view settings) is one line.
import {
  type Box,
  elementBox,
  fmt,
  IDENTITY,
  local,
  type Matrix,
  multiply,
  parseTransform,
  propOf,
  transformBox,
} from "./geometry.js";
import { virtualIds, walk } from "./ops.js";
import { attrOf, textContent, type XDoc, type XEl } from "./xml.js";

const KEPT = /^(metadata|sodipodi:namedview|rdf:RDF)$/;
const SHORT = 60;

const clip = (s: string, n = SHORT) => (s.length > n ? `${s.slice(0, n)}…` : s);
const boxText = (b: Box | undefined) =>
  b
    ? ` [${fmt(Math.round(b.x * 10) / 10)} ${fmt(Math.round(b.y * 10) / 10)} ${fmt(Math.round(b.w * 10) / 10)} ${fmt(Math.round(b.h * 10) / 10)}]`
    : "";

export function svgStructure(
  doc: XDoc,
  revision: number | undefined,
  ask: { fromLine?: number | undefined; toLine?: number | undefined },
): string {
  const v = virtualIds(doc).byPath;
  const lines: string[] = [];
  const root = doc.root;
  let count = 0;
  for (const _ of walk(root)) count++;
  const go = (el: XEl, path: number[], depth: number, ctm: Matrix, fs: number) => {
    const name = el.name;
    const tag = local(name);
    const id =
      path.length === 0
        ? (attrOf(el, "id") ?? "")
        : (attrOf(el, "id") ?? v.get(path.join(".")) ?? "");
    const pad = "  ".repeat(depth);
    if (KEPT.test(name) || (name.includes(":") && !name.startsWith("svg:"))) {
      lines.push(`${pad}${name}${id ? ` #${id}` : ""} (kept as it is)`);
      return;
    }
    if (tag === "defs") {
      const kids = el.children.filter((c): c is XEl => c.k === "el");
      lines.push(
        `${pad}defs${id ? ` #${id}` : ""}: ${kids.length} ${kids.length === 1 ? "definition" : "definitions"}${kids.length ? ` (${clip(kids.map((k) => `${local(k.name)}${attrOf(k, "id") ? `#${attrOf(k, "id")}` : ""}`).join(", "), 200)})` : ""}`,
      );
      return;
    }
    const fsHere = Number.parseFloat(propOf(el, "font-size") ?? "") || fs;
    const parts: string[] = [`${pad}${tag}${id ? ` #${id}` : ""}`];
    const label = attrOf(el, "inkscape:label");
    if (attrOf(el, "inkscape:groupmode") === "layer") parts.push(`layer «${label ?? id}»`);
    else if (label) parts.push(`«${clip(label)}»`);
    if (path.length) parts[0] += boxText(transformBox(ctm, elementBox(el, doc.entities, fs)));
    if (["text", "tspan", "textPath", "title", "desc"].includes(tag)) {
      const tx = textContent(el, doc.entities).replace(/\s+/g, " ").trim();
      if (tx) parts.push(`"${clip(tx, 120)}"`);
    }
    const paint = ["fill", "stroke", "stroke-width", "opacity", "display"]
      .map((p) => [p, propOf(el, p)] as const)
      .filter(([, x]) => x !== undefined)
      .map(([p, x]) => `${p}=${clip(x as string, 40)}`);
    if (paint.length && path.length) parts.push(paint.join(" "));
    const t = attrOf(el, "transform");
    if (t && path.length) parts.push(`transform=${clip(t, 60)}`);
    if (path.length === 0) {
      const dims = ["width", "height", "viewBox"]
        .map((a) => [a, attrOf(el, a)] as const)
        .filter(([, x]) => x !== undefined)
        .map(([a, x]) => `${a}="${x}"`);
      parts.push(dims.join(" "));
    }
    lines.push(parts.join("  "));
    // Inside a text, the tspans are shown with it already unless there are several.
    const kids = el.children.map((c, i) => [c, i] as const).filter(([c]) => c.k === "el") as [
      XEl,
      number,
    ][];
    if (
      tag === "text" &&
      kids.length <= 1 &&
      kids.every(([c]) => local(c.name) === "tspan" && !c.children.some((x) => x.k === "el"))
    ) {
      for (const [c, i] of kids) {
        const cid = attrOf(c, "id") ?? v.get([...path, i].join(".")) ?? "";
        lines.push(`${pad}  tspan${cid ? ` #${cid}` : ""}`);
      }
      return;
    }
    const here = path.length
      ? multiply(ctm, parseTransform(attrOf(el, "transform")) ?? IDENTITY)
      : ctm;
    for (const [c, i] of kids) go(c, [...path, i], depth + 1, here, fsHere);
  };
  go(root, [], 0, IDENTITY, 16);
  const from = Math.max(1, ask.fromLine ?? 1);
  const to = Math.min(lines.length, ask.toLine ?? from + 399);
  const head = `SVG drawing${revision !== undefined ? `, revision ${revision}` : ""}: ${count} elements. Each line: kind #id [x y w h in the drawing's units] "text" paint. Lines ${from}-${to} of ${lines.length}${to < lines.length ? ` (ask for fromLine ${to + 1} for more)` : ""}.`;
  return `${head}\n${lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(String(to).length)}| ${l}`)
    .join("\n")}`;
}
