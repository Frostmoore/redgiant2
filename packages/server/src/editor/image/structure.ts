// What the agent reads of a layered picture (G37.5, canvas_look view "structure"): its size and
// format, then its layers from the top, one per line: id, name, place and size, opacity,
// blending, visibility, lock, mask, groups, and what the pixels hold (the box of what is not
// transparent and its average colour). The picture itself is canvas_look's usual view.
import { type ImageText, imageBlendName, layoutText, textOrigin } from "@redgiant/protocol";
import { type ImageModel, opaqueBox, type RLayer } from "./model.js";
import { textFont } from "./raster.js";

/** A paragraph text's lines that do not fit its box (0 when its font is missing). */
const hiddenLines = (t: ImageText) => {
  if (!t.box) return 0;
  try {
    return layoutText(textFont(t.font, t.bold, t.italic), t).hidden;
  } catch {
    return 0;
  }
};

const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");

function content(l: RLayer): string {
  if (!l.px.width || !l.px.height) return "empty";
  const b = opaqueBox(l.px);
  if (!b) return "fully transparent";
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  const d = l.px.data;
  const step = Math.max(1, Math.floor((b.w * b.h) / 200_000));
  let k = 0;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (k++ % step) continue;
      const i = (y * l.px.width + x) * 4;
      const a = (d[i + 3] as number) / 255;
      if (!a) continue;
      r += (d[i] as number) * a;
      g += (d[i + 1] as number) * a;
      bl += (d[i + 2] as number) * a;
      n += a;
    }
  const avg = n ? `#${hex(r / n)}${hex(g / n)}${hex(bl / n)}` : "?";
  return `pixels in [${l.x + b.x} ${l.y + b.y} ${b.w} ${b.h}], average colour ${avg}`;
}

/** A text layer's text and look, as edit_text takes them (p3.5.8). */
function textWords(l: RLayer, t: ImageText, hidden: number): string {
  const [bx, by] = textOrigin({ x: l.x, y: l.y, text: t });
  const r = (n: number) => Math.round(n * 100) / 100;
  return [
    `text layer: ${JSON.stringify(t.text.length > 400 ? `${t.text.slice(0, 400)}…` : t.text)}`,
    `font ${t.font}${t.bold ? " bold" : ""}${t.italic ? " italic" : ""} size ${t.size} color ${t.color}`,
    `align ${t.align}, line_height ${t.lineHeight}`,
    t.box
      ? `paragraph box [${r(bx)} ${r(by)} ${t.box.w} ${t.box.h}]`
      : `point text at ${r(bx)},${r(by)}`,
    ...(t.rotate ? [`rotate ${t.rotate}`] : []),
    ...(hidden
      ? [`OVERFLOW: ${hidden} line${hidden === 1 ? "" : "s"} hidden, not drawn (box too small)`]
      : []),
  ].join(", ");
}

export function imageStructure(
  m: ImageModel,
  ask: { fromLine?: number | undefined; toLine?: number | undefined },
): string {
  const kind = m.format === "ora" ? "OpenRaster" : m.format.toUpperCase();
  const top = [...m.layers].reverse();
  const n = top.length;
  const from = Math.max(1, Math.min(n || 1, ask.fromLine ?? 1));
  const to = Math.max(from, Math.min(n, ask.toLine ?? from + 199));
  const lines = top.slice(from - 1, to).map((l, i) => {
    const parts = [
      `${from + i}. layer "${l.id}" «${l.name}»`,
      `at ${l.x},${l.y} size ${l.px.width}×${l.px.height}`,
      `opacity ${Math.round(l.opacity * 100)}%`,
      `blend ${imageBlendName(l.blend)}`,
      l.visible ? "visible" : "hidden",
      ...(l.locked ? ["locked"] : []),
      ...(l.mask
        ? [`mask [${l.mask.x} ${l.mask.y} ${l.mask.img.width} ${l.mask.img.height}]`]
        : []),
      ...(l.groups.length ? [`in group ${l.groups.map((g) => `«${g.name}»`).join(" / ")}`] : []),
      ...(l.text ? [textWords(l, l.text, hiddenLines(l.text))] : []),
      content(l),
    ];
    return parts.join(", ");
  });
  const more = to < n ? `\n(${n - to} more layers below: fromLine ${to + 1})` : "";
  const flat =
    m.format === "ora"
      ? ""
      : m.layers.length > 1
        ? ` Saved flattened into the ${kind}; its layers go to an .ora copy beside it.`
        : "";
  return `${kind} picture ${m.width}×${m.height} px, ${n} layer${n === 1 ? "" : "s"} (top first).${flat}\n${lines.join("\n")}${more}`;
}
