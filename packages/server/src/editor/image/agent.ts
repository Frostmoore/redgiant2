// The agent's operations on a layered picture (G37.5, canvas_edit): plain words (a layer by its
// name or id, shapes in the picture's pixels, a filter of the catalog) turned into the same
// actions the page sends, drawn here on the server: only the tiles that changed travel, a layer
// grows when a drawing goes beyond it, and «put this generated picture in as a layer» is
// `add_layer` with `image` (a PNG or JPEG of the workspace, made a blob by `prepare`).
import {
  IMAGE_FILTERS,
  IMAGE_MAX_SIDE,
  type ImageAction,
  type ImageLayerInfo,
  type ImagePlainAction,
  type ImageText,
  type ImageTile,
  imageBlendName,
  imageBlendOf,
  imageFilter,
  imagePx,
  imageTilesOf,
  layoutText,
  runImageFilter,
  scaledText,
  TEXT_FONTS,
  textLayer,
  textOrigin,
} from "@redgiant/protocol";
import { rgbaOf } from "../../convert-js.js";
import {
  blank,
  copyOf,
  crop,
  flatten,
  type ImageBlobs,
  type ImageModel,
  infoOf,
  masked,
  paste,
  type Rgba,
  type RLayer,
  readJpeg,
  sameRect,
} from "./model.js";
import { applyAction } from "./ops.js";
import {
  affineAround,
  type Cov,
  covAt,
  ellipsePoly,
  FONTS,
  type FontName,
  fillPolys,
  fontNamed,
  fullCov,
  outlinePolys,
  paintCov,
  parseColor,
  type Rect,
  rectPoly,
  strokePolys,
  textFont,
  textPolys,
  transformBuffer,
} from "./raster.js";

export const IMAGE_CATALOG = `Layered pictures (image: .ora OpenRaster with layers; .png and .jpg open as one layer and are saved flattened, their layers kept in an .ora copy beside them; a .psd is edited on its .ora copy): canvas_edit "ops", applied in order, one revision. canvas_look view "structure" lists the layers (top first) with id, name, place and size, opacity, blending, mask and what they hold. "layer" is a layer's id or name. Coordinates are the picture's pixels (0,0 top left). "area" is the selection an operation works in: {"rect":[x,y,w,h]}, {"ellipse":[x,y,w,h]} or {"polygon":[[x,y],…]} (without it: the whole layer, or the whole picture for fill). Colours: "#rrggbb", "#rrggbbaa", rgb()/rgba() or a name.
- {"op":"add_layer","name":"Sky","image":"out/generated.png","fit":"contain","x":0,"y":0,"opacity":1,"blend":"normal","above":"Background"}: a new layer on top (or above "above"); "image" puts a PNG or JPEG of your workspace in it (a generated picture as a layer), "fit" none|contain|cover|stretch to the picture (none: its own size, centred unless x/y); "color" fills it; with neither it is empty.
- {"op":"delete_layer","layer":"Sky"} / {"op":"duplicate_layer","layer":"Sky","name":"Sky copy"} / {"op":"merge_down","layer":"Sky"} (into the layer under it).
- {"op":"move_layer","layer":"Sky","to":"top|bottom|up|down"} or {"op":"move_layer","layer":"Sky","above":"Background"} ("above": null for the bottom).
- {"op":"set_layer","layer":"Sky","name":"Cielo","opacity":0.6,"blend":"multiply","visible":true,"locked":false,"x":10,"y":20}: blends normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity, add.
- {"op":"draw","layer":"Sky","shape":"rect|ellipse|line|polygon|polyline","x":10,"y":10,"w":100,"h":50,"fill":"#ffcc00","stroke":"#333","stroke_width":3}: line with "x1","y1","x2","y2"; polygon/polyline with "points":[[x,y],…].
- {"op":"stroke","layer":"Sky","points":[[10,10],[60,40],[120,30]],"color":"#ff0000","size":8,"opacity":1}: a brush stroke through the points (round); "erase":true rubs out instead.
- {"op":"gradient","layer":"Sky","from":[0,0],"to":[0,400],"kind":"linear|radial","colors":["#1a2a6c","#fdbb2d"],"opacity":1,"area":{…}}: a gradient over the layer (in the area), colours "#rrggbbaa" for transparency.
- {"op":"bucket","layer":"Sky","at":[120,80],"color":"#ffcc00","tolerance":32,"contiguous":true,"all_layers":false}: the paint bucket: the colour over the pixels like the one at "at" (joined to it unless contiguous false; all_layers looks at the whole picture).
- {"op":"fill","layer":"Sky","area":{"rect":[0,0,200,100]},"color":"#3366ff"} / {"op":"clear","layer":"Sky","area":{"ellipse":[10,10,80,80]}} (makes it transparent).
- {"op":"filter","layer":"Sky","name":"blur","radius":4,"area":{…}}: filters ${IMAGE_FILTERS.map((f) => (f.params.length ? `${f.id} (${f.params.map((p) => `${p.id} ${p.min}…${p.max}`).join(", ")})` : f.id)).join(", ")}.
- {"op":"transform","layer":"Sky","dx":10,"dy":-5,"scale":1.5,"rotate":30,"flip":"horizontal|vertical"}: around the layer's centre ("scale":[sx,sy] for each axis); moving alone keeps the pixels as they are. With "area" and dx/dy alone only the pixels inside the area move (cut and put down there, as the Move tool with a selection): {"op":"transform","layer":"Sky","area":{"rect":[0,0,50,50]},"dx":30,"dy":0}.
- {"op":"crop","x":0,"y":0,"w":800,"h":600} / {"op":"resize_canvas","width":1200,"height":800,"anchor":"center|top-left|top|top-right|left|right|bottom-left|bottom|bottom-right"} / {"op":"resize_image","width":800} (every layer scaled; give width, height or both).
- {"op":"add_text","text":"Saldi\\n-30%","x":40,"y":40,"size":48,"color":"#ffffff","font":"${TEXT_FONTS.map((f) => f.id).join("|")}","bold":false,"italic":false,"align":"left|center|right","line_height":1.2,"box":[400,200],"rotate":0,"name":"Titolo"}: a new text layer (Photoshop's type layer, still editable: the person double-clicks it), its box's top left at x, y; "box" [w, h] makes paragraph text (lines wrap at its width), without it point text. "layer" draws the text as plain pixels on that layer instead.
- {"op":"edit_text","layer":"Titolo","text":"Saldi -50%","size":64,"color":"#ff0000","font":"sans","bold":true,"italic":false,"align":"center","line_height":1.1,"box":[400,200] or null,"rotate":15,"x":40,"y":40}: changes a text layer's text or look (only what you give; x, y move its box). Text layers refuse pixel operations (draw, stroke, filter…): {"op":"rasterize_text","layer":"Titolo"} makes one plain pixels first.
- {"op":"add_mask","layer":"Sky","area":{"ellipse":[0,0,400,300]},"invert":false}: a mask that shows the layer only inside the area (everywhere without one); {"op":"delete_mask","layer":"Sky"} / {"op":"apply_mask","layer":"Sky"} (the mask becomes the layer's transparency). "target":"mask" on fill, clear and stroke paints the mask itself (fill and stroke show, clear hides).`;

type Plain = Record<string, unknown>;

class Bad extends Error {}
const bad = (why: string): never => {
  throw new Bad(why);
};

const num = (v: unknown, what: string): number => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return bad(`"${what}" must be a number`);
  return n;
};
const opt = (v: unknown, what: string) =>
  v === undefined || v === null ? undefined : num(v, what);
const str = (v: unknown, what: string): string =>
  typeof v === "string" && v.trim() ? v.trim() : bad(`give "${what}"`);
const colorOf = (v: unknown, what: string) => {
  const c = parseColor(v);
  if (!c) return bad(`"${what}" is not a colour (try "#ff8800")`);
  return c;
};
const point = (v: unknown): [number, number] => {
  if (!Array.isArray(v) || v.length < 2) return bad("a point is [x, y]");
  return [num(v[0], "x"), num(v[1], "y")];
};
const points = (v: unknown, min: number): [number, number][] => {
  if (!Array.isArray(v) || v.length < min) return bad(`give "points": at least ${min} [x, y]`);
  if (v.length > 20_000) return bad("too many points");
  return v.map(point);
};
const box = (v: unknown, what: string): [number, number, number, number] => {
  if (!Array.isArray(v) || v.length !== 4) return bad(`"${what}" is [x, y, w, h]`);
  return [num(v[0], "x"), num(v[1], "y"), num(v[2], "w"), num(v[3], "h")];
};

let ids = 0;
const newId = () => `l-${Date.now().toString(36)}${(ids++).toString(36)}`;

export interface AgentContext {
  blobs: ImageBlobs;
}

/** A layer by its id, or its name (case aside); ambiguous names are refused. */
function layerOf(m: ImageModel, v: unknown, what = "layer"): RLayer {
  const s = str(v, what);
  const byId = m.layers.find((l) => l.id === s);
  if (byId) return byId;
  const named = m.layers.filter((l) => l.name.toLowerCase() === s.toLowerCase());
  if (named.length === 1) return named[0] as RLayer;
  if (named.length > 1)
    return bad(
      `${named.length} layers are named «${s}»: use one's id (${named.map((l) => l.id).join(", ")})`,
    );
  return bad(`there is no layer «${s}» (canvas_look view "structure" lists them)`);
}

const canvasRect = (m: ImageModel): Rect => ({ x: 0, y: 0, w: m.width, h: m.height });
const layerRect = (l: RLayer): Rect => ({ x: l.x, y: l.y, w: l.px.width, h: l.px.height });
const union = (a: Rect, b: Rect): Rect => {
  if (!a.w || !a.h) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const inside = (a: Rect, b: Rect) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/** The coverage of an "area", in the picture's coordinates (undefined: no area given). */
/** A coverage as a picture-sized selection (imagePx's). */
function selOfCov(c: Cov, width: number, height: number): imagePx.Sel {
  const s = imagePx.emptySel(width, height);
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const px = c.x + x;
      const py = c.y + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      s.a[py * width + px] = Math.round((c.a[y * c.w + x] as number) * 255);
    }
  return s;
}

function areaCov(v: unknown, clip: Rect): Cov | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object")
    return bad('"area" is {"rect":[x,y,w,h]}, {"ellipse":[x,y,w,h]} or {"polygon":[[x,y],…]}');
  const a = v as Plain;
  let polys: number[][];
  if (a.rect !== undefined) {
    const [x, y, w, h] = box(a.rect, "area.rect");
    polys = [rectPoly(x, y, w, h)];
  } else if (a.ellipse !== undefined) {
    const [x, y, w, h] = box(a.ellipse, "area.ellipse");
    polys = [ellipsePoly(x + w / 2, y + h / 2, w / 2, h / 2)];
  } else if (a.polygon !== undefined) polys = [points(a.polygon, 3).flat()];
  else return bad('"area" is {"rect":[x,y,w,h]}, {"ellipse":[x,y,w,h]} or {"polygon":[[x,y],…]}');
  return fillPolys(polys, clip) ?? null;
}

/** The tiles of a layer's buffer (or mask) that differ between `before` and `after` (same size). */
function changedTiles(before: Rgba, after: Rgba, blobs: ImageBlobs): ImageTile[] {
  const out: ImageTile[] = [];
  for (const t of imageTilesOf(0, 0, after.width, after.height))
    if (!sameRect(before, after, t.x, t.y, t.w, t.h))
      out.push({ ...t, png: blobs.hashOf(crop(after, t.x, t.y, t.w, t.h)) });
  return out;
}

type What = NonNullable<Extract<ImagePlainAction, { t: "tiles" }>["what"]>;

/**
 * A layer's pixels changed by `draw` (on a copy, at least as big as `need`): tiles when it stays
 * the same size, all its pixels when it had to grow.
 */
function edited(
  l: RLayer,
  need: Rect | undefined,
  draw: (px: Rgba, x: number, y: number) => void,
  what: What,
  blobs: ImageBlobs,
): ImagePlainAction[] {
  if (l.locked) bad(`the layer «${l.name}» is locked`);
  if (l.text)
    bad(
      `«${l.name}» is a text layer: change it with edit_text, or make it pixels with rasterize_text first`,
    );
  const here = layerRect(l);
  if (need && need.w > 0 && need.h > 0 && !inside(need, here)) {
    const r = union(here, need);
    if (r.w > IMAGE_MAX_SIDE * 2 || r.h > IMAGE_MAX_SIDE * 2) bad("the layer would grow too big");
    const px = blank(r.w, r.h);
    paste(px, l.px, l.x - r.x, l.y - r.y);
    draw(px, r.x, r.y);
    return [
      { t: "pixels", layer: l.id, x: r.x, y: r.y, w: r.w, h: r.h, png: blobs.hashOf(px), what },
    ];
  }
  const px = copyOf(l.px);
  draw(px, l.x, l.y);
  const tiles = changedTiles(l.px, px, blobs);
  return tiles.length ? [{ t: "tiles", layer: l.id, tiles, what }] : [];
}

/** The same on a layer's mask (grey), which never grows. */
function editedMask(
  l: RLayer,
  draw: (img: Rgba, x: number, y: number) => void,
  what: What,
  blobs: ImageBlobs,
): ImagePlainAction[] {
  const mk = l.mask;
  if (!mk) return bad(`the layer «${l.name}» has no mask (add_mask first)`);
  const img = copyOf(mk.img);
  draw(img, mk.x, mk.y);
  // Grey stays grey: what was drawn in colour becomes its lightness.
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i] as number;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  const tiles = changedTiles(mk.img, img, blobs);
  return tiles.length ? [{ t: "tiles", layer: l.id, mask: true, tiles, what }] : [];
}

/**
 * The pixels of a layer inside a coverage moved by (dx, dy): taken out where they were (as much
 * as the coverage covers them) and drawn over what is where they land; the layer grows to hold
 * them, inside the picture.
 */
function movedPixels(
  l: RLayer,
  cov: Cov,
  dx: number,
  dy: number,
  picture: Rect,
  blobs: ImageBlobs,
): ImagePlainAction[] {
  // The piece, read before anything changes: its colour and its alpha times the coverage.
  const piece = new Uint8ClampedArray(cov.w * cov.h * 4);
  for (let y = 0; y < cov.h; y++)
    for (let x = 0; x < cov.w; x++) {
      const k = cov.a[y * cov.w + x] as number;
      const lx = cov.x + x - l.x;
      const ly = cov.y + y - l.y;
      if (k <= 0 || lx < 0 || ly < 0 || lx >= l.px.width || ly >= l.px.height) continue;
      const i = (ly * l.px.width + lx) * 4;
      const o = (y * cov.w + x) * 4;
      piece[o] = l.px.data[i] as number;
      piece[o + 1] = l.px.data[i + 1] as number;
      piece[o + 2] = l.px.data[i + 2] as number;
      piece[o + 3] = Math.round((l.px.data[i + 3] as number) * k);
    }
  const landed = { x: cov.x + dx, y: cov.y + dy, w: cov.w, h: cov.h };
  const reach = union({ x: cov.x, y: cov.y, w: cov.w, h: cov.h }, landed);
  const x0 = Math.max(reach.x, picture.x);
  const y0 = Math.max(reach.y, picture.y);
  const need = {
    x: x0,
    y: y0,
    w: Math.max(0, Math.min(reach.x + reach.w, picture.x + picture.w) - x0),
    h: Math.max(0, Math.min(reach.y + reach.h, picture.y + picture.h) - y0),
  };
  return edited(
    l,
    need,
    (px, ox, oy) => {
      paintCov(px, ox, oy, cov, [0, 0, 0, 255], "erase");
      for (let y = 0; y < cov.h; y++) {
        const py = landed.y + y - oy;
        if (py < 0 || py >= px.height) continue;
        for (let x = 0; x < cov.w; x++) {
          const o = (y * cov.w + x) * 4;
          const sa = (piece[o + 3] as number) / 255;
          if (sa <= 0) continue;
          const pxx = landed.x + x - ox;
          if (pxx < 0 || pxx >= px.width) continue;
          const i = (py * px.width + pxx) * 4;
          const da = (px.data[i + 3] as number) / 255;
          const oa = sa + da * (1 - sa);
          for (let c = 0; c < 3; c++)
            px.data[i + c] = Math.round(
              ((piece[o + c] as number) * sa + (px.data[i + c] as number) * da * (1 - sa)) / oa,
            );
          px.data[i + 3] = Math.round(oa * 255);
        }
      }
    },
    "transform",
    blobs,
  );
}

const greyOf = (c: [number, number, number, number]): [number, number, number, number] => {
  const v = Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
  return [v, v, v, c[3]];
};

/** A buffer scaled to w × h (bilinear). */
function scaled(img: Rgba, w: number, h: number): Rgba {
  if (img.width === w && img.height === h) return img;
  return transformBuffer(img, 0, 0, { a: w / img.width, b: 0, c: 0, d: h / img.height, e: 0, f: 0 })
    .px;
}

const blendArg = (v: unknown) => {
  if (v === undefined) return undefined;
  const b = imageBlendOf(String(v));
  if (!b) return bad(`there is no blending «${String(v)}»`);
  return b;
};

const opacityArg = (v: unknown) => {
  const o = opt(v, "opacity");
  if (o === undefined) return undefined;
  // 60 means 60%.
  const k = o > 1 ? o / 100 : o;
  return Math.max(0, Math.min(1, k));
};

/** The font a text is drawn with. */
function fontOfText(t: ImageText) {
  try {
    return textFont(t.font, t.bold, t.italic);
  } catch {
    return bad("the font for texts is not here (pdf.js's standard fonts)");
  }
}

/** A text's look from the agent's words, over `base` (only what is given changes). */
function textSpec(x: Plain, base: ImageText): ImageText {
  const out: ImageText = { ...base };
  const size = opt(x.size ?? x.font_size, "size");
  if (size !== undefined) out.size = Math.max(1, Math.min(2000, size));
  if (x.font !== undefined) {
    const f = String(x.font).toLowerCase();
    // The old names (sans-bold…) still work.
    const fam = f.replace(/-(bold|italic|bold-italic)$/, "");
    if (!TEXT_FONTS.some((t) => t.id === fam))
      return bad(`"font" is ${TEXT_FONTS.map((t) => t.id).join(", ")}`);
    out.font = fam;
    if (f.includes("bold")) out.bold = true;
    if (f.includes("italic")) out.italic = true;
  }
  if (x.bold !== undefined) out.bold = !!x.bold;
  if (x.italic !== undefined) out.italic = !!x.italic;
  if (x.color !== undefined) {
    const c = colorOf(x.color, "color");
    const h = (n: number) => n.toString(16).padStart(2, "0");
    out.color = `#${h(c[0])}${h(c[1])}${h(c[2])}${c[3] < 255 ? h(c[3]) : ""}`;
  }
  if (x.align !== undefined) {
    const a = String(x.align).toLowerCase();
    if (a !== "left" && a !== "center" && a !== "right")
      return bad('"align" is left, center or right');
    out.align = a;
  }
  const lh = opt(x.line_height ?? x.lineHeight, "line_height");
  if (lh !== undefined) out.lineHeight = Math.max(0.5, Math.min(10, lh));
  if (x.box === null) delete out.box;
  else if (x.box !== undefined) {
    if (!Array.isArray(x.box) || x.box.length !== 2) return bad('"box" is [w, h] (or null)');
    const w = num(x.box[0], "box");
    const h = num(x.box[1], "box");
    if (w < 1 || h < 1) return bad('"box" must be at least 1×1');
    out.box = { w: Math.min(100_000, w), h: Math.min(100_000, h) };
  }
  const rot = opt(x.rotate ?? x.angle, "rotate");
  if (rot !== undefined) {
    const r = ((((rot % 360) + 540) % 360) - 180) as number;
    if (r) out.rotate = r;
    else delete out.rotate;
  }
  return out;
}

/** A text layer drawn again with `next`, its box at (bx, by): its text and its pixels. */
function textActions(
  l: RLayer,
  next: ImageText,
  bx: number,
  by: number,
  blobs: ImageBlobs,
  what: What,
): ImagePlainAction[] {
  const r = textLayer(fontOfText(next), next, bx, by);
  return [
    { t: "props", layer: l.id, set: { text: r.text } },
    {
      t: "pixels",
      layer: l.id,
      x: r.x,
      y: r.y,
      w: r.px.width,
      h: r.px.height,
      png: r.px.width && r.px.height ? blobs.hashOf(r.px as Rgba) : null,
      what,
    },
  ];
}

function one(
  m: ImageModel,
  x: Plain,
  ctx: AgentContext,
): { actions: ImagePlainAction[]; what?: What; filter?: string } {
  const blobs = ctx.blobs;
  const name = String(x.op ?? x.action ?? x.type ?? "").toLowerCase();
  const top = () => m.layers.at(-1)?.id ?? null;
  switch (name) {
    case "add_layer":
    case "new_layer":
    case "insert_image":
    case "place_image": {
      const id = newId();
      const above =
        x.above === undefined ? top() : x.above === null ? null : layerOf(m, x.above, "above").id;
      let px: Rgba;
      let lx = opt(x.x, "x");
      let ly = opt(x.y, "y");
      const pic = x.picture as { blob?: string } | undefined;
      if (pic?.blob) {
        const b = blobs.bytes(pic.blob);
        if (!b) return bad("the picture is not here anymore");
        let img: Rgba;
        try {
          img = b[0] === 0xff && b[1] === 0xd8 ? readJpeg(b) : rgbaOf(b);
        } catch {
          return bad(`${String(x.image ?? "the picture")} is not a PNG or a JPEG it can read`);
        }
        const fit = String(x.fit ?? "none").toLowerCase();
        if (fit === "contain" || fit === "cover") {
          const k = (fit === "contain" ? Math.min : Math.max)(
            m.width / img.width,
            m.height / img.height,
          );
          img = scaled(
            img,
            Math.max(1, Math.round(img.width * k)),
            Math.max(1, Math.round(img.height * k)),
          );
        } else if (fit === "stretch") img = scaled(img, m.width, m.height);
        else if (fit !== "none") return bad('"fit" is none, contain, cover or stretch');
        const w = opt(x.w, "w");
        const h = opt(x.h, "h");
        if (w || h) {
          const k = img.width / img.height;
          img = scaled(
            img,
            Math.max(1, Math.round(w ?? (h as number) * k)),
            Math.max(1, Math.round(h ?? (w as number) / k)),
          );
        }
        px = img;
        lx ??= Math.round((m.width - img.width) / 2);
        ly ??= Math.round((m.height - img.height) / 2);
      } else if (x.image !== undefined)
        return bad('"image" must be a file of your workspace (a PNG or JPEG)');
      else {
        px = blank(m.width, m.height);
        if (x.color !== undefined)
          paintCov(px, 0, 0, fullCov(canvasRect(m)), colorOf(x.color, "color"));
        lx ??= 0;
        ly ??= 0;
      }
      const info: ImageLayerInfo = {
        id,
        name:
          typeof x.name === "string" && x.name.trim()
            ? x.name.trim()
            : `Layer ${m.layers.length + 1}`,
        x: Math.round(lx),
        y: Math.round(ly),
        w: px.width,
        h: px.height,
        opacity: opacityArg(x.opacity) ?? 1,
        visible: x.visible !== false && x.hidden !== true,
        blend: blendArg(x.blend) ?? "svg:src-over",
        ...(above &&
          m.layers.find((l) => l.id === above)?.groups.length && {
            groups: (m.layers.find((l) => l.id === above) as RLayer).groups,
          }),
      };
      return {
        actions: [{ t: "add", layer: info, above, png: blobs.hashOf(px), mask: null }],
        ...(pic && { what: "paste" as const }),
      };
    }
    case "delete_layer":
    case "remove_layer":
      return { actions: [{ t: "remove", layer: layerOf(m, x.layer).id }] };
    case "duplicate_layer": {
      const l = layerOf(m, x.layer);
      const info = {
        ...infoOf(l),
        id: newId(),
        name: typeof x.name === "string" && x.name ? x.name : `${l.name} copy`,
      };
      return {
        actions: [
          {
            t: "add",
            layer: info,
            above: l.id,
            png: l.px.width && l.px.height ? blobs.hashOf(l.px) : null,
            mask: l.mask
              ? {
                  x: l.mask.x,
                  y: l.mask.y,
                  w: l.mask.img.width,
                  h: l.mask.img.height,
                  outside: l.mask.outside,
                  png: blobs.hashOf(l.mask.img),
                }
              : null,
          },
        ],
      };
    }
    case "merge_down": {
      const l = layerOf(m, x.layer);
      const i = m.layers.indexOf(l);
      const below = m.layers[i - 1];
      if (!below) return bad(`«${l.name}» is the bottom layer: there is nothing under it`);
      if (below.locked) return bad(`the layer «${below.name}» is locked`);
      const r = union(layerRect(below), layerRect(l));
      // The upper layer drawn on the lower one's own pixels (its mask applied); the lower one
      // keeps its opacity and blending.
      const px = flatten({
        ...m,
        width: r.w,
        height: r.h,
        layers: [
          {
            ...withoutMask(below),
            px: masked(below),
            x: below.x - r.x,
            y: below.y - r.y,
            opacity: 1,
            visible: true,
            blend: "svg:src-over",
            groups: [],
          },
          {
            ...withoutMask(l),
            x: l.x - r.x,
            y: l.y - r.y,
            groups: [],
            ...(l.mask && { mask: { ...l.mask, x: l.mask.x - r.x, y: l.mask.y - r.y } }),
          },
        ],
      });
      return {
        actions: [
          // A text layer under it becomes plain pixels (Photoshop's merge rasterizes it).
          ...(below.text ? [{ t: "props" as const, layer: below.id, set: { text: null } }] : []),
          {
            t: "pixels",
            layer: below.id,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            png: blobs.hashOf(px),
            what: "other",
          },
          ...(below.mask
            ? [
                {
                  t: "pixels" as const,
                  layer: below.id,
                  mask: true,
                  x: 0,
                  y: 0,
                  w: 0,
                  h: 0,
                  png: null,
                },
              ]
            : []),
          { t: "remove", layer: l.id },
        ],
      };
    }
    case "move_layer":
    case "reorder": {
      const l = layerOf(m, x.layer);
      const others = m.layers.filter((o) => o.id !== l.id);
      const i = m.layers.indexOf(l);
      let above: string | null;
      if (x.above !== undefined) above = x.above === null ? null : layerOf(m, x.above, "above").id;
      else {
        const to = String(x.to ?? "").toLowerCase();
        if (to === "top") above = others.at(-1)?.id ?? null;
        else if (to === "bottom") above = null;
        else if (to === "up") {
          const next = m.layers[i + 1];
          if (!next) return { actions: [] };
          above = next.id;
        } else if (to === "down") {
          if (i === 0) return { actions: [] };
          above = i >= 2 ? (m.layers[i - 2] as RLayer).id : null;
        } else return bad('give "to": top, bottom, up or down (or "above")');
      }
      if (above === l.id) return { actions: [] };
      return { actions: [{ t: "move", layer: l.id, above }] };
    }
    case "set_layer":
    case "rename_layer":
    case "layer": {
      const l = layerOf(m, x.layer);
      const set: Extract<ImagePlainAction, { t: "props" }>["set"] = {};
      if (x.name !== undefined) set.name = str(x.name, "name").slice(0, 400);
      const o = opacityArg(x.opacity);
      if (o !== undefined) set.opacity = o;
      const b = blendArg(x.blend);
      if (b) set.blend = b;
      if (x.visible !== undefined) set.visible = !!x.visible;
      if (x.hidden !== undefined) set.visible = !x.hidden;
      if (x.locked !== undefined) set.locked = !!x.locked;
      const nx = opt(x.x, "x");
      const ny = opt(x.y, "y");
      if (nx !== undefined) set.x = Math.round(nx);
      if (ny !== undefined) set.y = Math.round(ny);
      if (!Object.keys(set).length)
        return bad("give what to change: name, opacity, blend, visible, locked, x, y");
      return { actions: [{ t: "props", layer: l.id, set }] };
    }
    case "draw":
    case "shape": {
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const shape = String(x.shape ?? x.kind ?? "").toLowerCase();
      const fill = x.fill === undefined || x.fill === "none" ? undefined : colorOf(x.fill, "fill");
      const stroke =
        x.stroke === undefined || x.stroke === "none" ? undefined : colorOf(x.stroke, "stroke");
      const sw = opt(x.stroke_width ?? x.width_px ?? x.line_width, "stroke_width") ?? 2;
      let outline: number[] | undefined;
      let open: [number, number][] | undefined;
      if (shape === "rect" || shape === "square") {
        outline = rectPoly(num(x.x, "x"), num(x.y, "y"), num(x.w, "w"), num(x.h, "h"));
      } else if (shape === "ellipse" || shape === "circle") {
        const w = num(x.w ?? (x.r !== undefined ? num(x.r, "r") * 2 : undefined), "w");
        const h = num(x.h ?? x.w ?? (x.r !== undefined ? num(x.r, "r") * 2 : undefined), "h");
        const cx = x.cx !== undefined ? num(x.cx, "cx") : num(x.x, "x") + w / 2;
        const cy = x.cy !== undefined ? num(x.cy, "cy") : num(x.y, "y") + h / 2;
        outline = ellipsePoly(cx, cy, w / 2, h / 2);
      } else if (shape === "line") {
        open = [
          [num(x.x1, "x1"), num(x.y1, "y1")],
          [num(x.x2, "x2"), num(x.y2, "y2")],
        ];
      } else if (shape === "polygon") outline = points(x.points, 3).flat();
      else if (shape === "polyline") open = points(x.points, 2);
      else return bad('"shape" is rect, ellipse, line, polygon or polyline');
      const covs: { cov: Cov; c: [number, number, number, number] }[] = [];
      const clip = canvasRect(m);
      if (outline && fill) {
        const c = fillPolys([outline], clip);
        if (c) covs.push({ cov: c, c: fill });
      }
      const sc = stroke ?? (open ? (fill ?? [0, 0, 0, 255]) : undefined);
      if (sc) {
        const c = fillPolys(
          open ? strokePolys(open, sw) : outlinePolys(outline as number[], sw),
          clip,
        );
        if (c) covs.push({ cov: c, c: sc });
      }
      if (!covs.length)
        return bad(outline ? 'give "fill" or "stroke"' : "the shape is outside the picture");
      const need = covs.map((c) => c.cov as Rect).reduce(union);
      return {
        actions: edited(
          l,
          need,
          (px, ox, oy) => {
            for (const c of covs) paintCov(px, ox, oy, c.cov, c.c);
          },
          "shape",
          blobs,
        ),
        what: "shape",
      };
    }
    case "stroke":
    case "brush":
    case "paint": {
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const pts = points(x.points, 1);
      const size = Math.max(0.5, opt(x.size ?? x.width_px ?? x.stroke_width, "size") ?? 6);
      const erase = x.erase === true;
      const c = erase
        ? ([0, 0, 0, 255] as [number, number, number, number])
        : colorOf(x.color ?? "#000000", "color");
      const o = opacityArg(x.opacity) ?? 1;
      const col: [number, number, number, number] = [c[0], c[1], c[2], Math.round(c[3] * o)];
      const mask = x.target === "mask";
      const cov = fillPolys(
        strokePolys(pts, size),
        mask && l.mask
          ? { x: l.mask.x, y: l.mask.y, w: l.mask.img.width, h: l.mask.img.height }
          : canvasRect(m),
      );
      if (!cov) return bad("the stroke is outside the picture");
      const what: What = erase ? "erase" : "paint";
      if (mask)
        return {
          actions: editedMask(
            l,
            (img, ox, oy) => paintCov(img, ox, oy, cov, erase ? [0, 0, 0, col[3]] : greyOf(col)),
            what,
            blobs,
          ),
          what,
        };
      return {
        actions: edited(
          l,
          erase ? undefined : cov,
          (px, ox, oy) => paintCov(px, ox, oy, cov, col, erase ? "erase" : "over"),
          what,
          blobs,
        ),
        what,
      };
    }
    case "gradient": {
      // p3.5.7: the page's Gradient tool, with the same function (imagePx).
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const from = point(x.from);
      const to = point(x.to);
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1)
        return bad('"from" and "to" are the same point');
      const cols = Array.isArray(x.colors) ? x.colors : ["#000000", "#ffffff"];
      if (cols.length !== 2) return bad('"colors" is two colours, [start, end]');
      const kind = x.kind === undefined ? "linear" : x.kind;
      if (kind !== "linear" && kind !== "radial") return bad('"kind" is linear or radial');
      const a = areaCov(x.area, canvasRect(m));
      if (a === null) return bad("the area is outside the picture");
      const sel = a ? selOfCov(a, m.width, m.height) : undefined;
      const spec = {
        from,
        to,
        kind,
        c0: colorOf(cols[0], "colors"),
        c1: colorOf(cols[1], "colors"),
        opacity: Math.max(0, Math.min(1, opt(x.opacity, "opacity") ?? 1)),
      } as const;
      return {
        actions: edited(
          l,
          a ?? canvasRect(m),
          (px, ox, oy) => imagePx.gradientThrough({ x: ox, y: oy, px }, sel, spec),
          "fill",
          blobs,
        ),
        what: "fill",
      };
    }
    case "bucket": {
      // p3.5.7: the page's Paint Bucket: the colour over the pixels like the one at "at".
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const at = point(x.at);
      const tol = Math.max(0, Math.min(255, opt(x.tolerance, "tolerance") ?? 32));
      const sample =
        x.all_layers === true
          ? flatten(m)
          : imagePx.onPicture({ x: l.x, y: l.y, px: l.px }, m.width, m.height);
      let sel: imagePx.Sel | undefined = imagePx.wandSel(
        sample,
        at[0],
        at[1],
        tol,
        x.contiguous !== false,
      );
      const a = areaCov(x.area, canvasRect(m));
      if (a === null) return bad("the area is outside the picture");
      if (a) sel = imagePx.combineSel("intersect", selOfCov(a, m.width, m.height), sel);
      const b = sel && imagePx.selBounds(sel);
      if (!sel || !b) return bad("nothing to fill there");
      const area = sel;
      const c = colorOf(x.color, "color");
      return {
        actions: edited(
          l,
          b,
          (px, ox, oy) => imagePx.fillThrough({ x: ox, y: oy, px }, area, c),
          "fill",
          blobs,
        ),
        what: "fill",
      };
    }
    case "fill":
    case "clear": {
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const clearing = name === "clear";
      const mask = x.target === "mask";
      const clip =
        mask && l.mask
          ? { x: l.mask.x, y: l.mask.y, w: l.mask.img.width, h: l.mask.img.height }
          : clearing
            ? layerRect(l)
            : canvasRect(m);
      const a = areaCov(x.area, clip);
      if (a === null) return bad("the area is outside the layer");
      const cov = a ?? fullCov(clip);
      const what: What = clearing ? "clear" : "fill";
      if (mask)
        return {
          actions: editedMask(
            l,
            (img, ox, oy) =>
              paintCov(
                img,
                ox,
                oy,
                cov,
                clearing ? [0, 0, 0, 255] : greyOf(colorOf(x.color ?? "#ffffff", "color")),
              ),
            what,
            blobs,
          ),
          what,
        };
      if (clearing)
        return {
          actions: edited(
            l,
            undefined,
            (px, ox, oy) => paintCov(px, ox, oy, cov, [0, 0, 0, 255], "erase"),
            what,
            blobs,
          ),
          what,
        };
      const c = colorOf(x.color, "color");
      return {
        actions: edited(l, cov, (px, ox, oy) => paintCov(px, ox, oy, cov, c), what, blobs),
        what,
      };
    }
    case "filter": {
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      const id = str(x.name ?? x.filter, "name")
        .toLowerCase()
        .replace(/[ -]/g, "_");
      const def =
        imageFilter(id) ??
        imageFilter(
          id === "brightness" || id === "contrast"
            ? "brightness_contrast"
            : id === "hue" || id === "saturation"
              ? "hue_saturation"
              : id === "greyscale" || id === "desaturate"
                ? "grayscale"
                : id === "gaussian_blur"
                  ? "blur"
                  : "",
        );
      if (!def)
        return bad(`there is no filter «${id}»: ${IMAGE_FILTERS.map((f) => f.id).join(", ")}`);
      const params = {
        ...x,
        ...(x.params && typeof x.params === "object" ? (x.params as Plain) : {}),
      };
      const a = areaCov(x.area, layerRect(l));
      if (a === null) return bad("the area is outside the layer");
      if (l.px.width === 0 || l.px.height === 0) return bad(`the layer «${l.name}» is empty`);
      const out = runImageFilter(def.id, l.px.data, l.px.width, l.px.height, params);
      return {
        actions: edited(
          l,
          undefined,
          (px, ox, oy) => {
            for (let yy = 0; yy < px.height; yy++)
              for (let xx = 0; xx < px.width; xx++) {
                const k = a ? covAt(a, xx + ox, yy + oy) : 1;
                if (k <= 0) continue;
                const i = (yy * px.width + xx) * 4;
                for (let c = 0; c < 4; c++)
                  px.data[i + c] = Math.round(
                    (px.data[i + c] as number) * (1 - k) + (out[i + c] as number) * k,
                  );
              }
          },
          "filter",
          blobs,
        ),
        what: "filter",
        filter: def.id,
      };
    }
    case "transform":
    case "move":
    case "scale":
    case "rotate":
    case "flip": {
      const l = layerOf(m, x.layer ?? m.layers.at(-1)?.id);
      if (l.locked) return bad(`the layer «${l.name}» is locked`);
      const dx = Math.round(opt(x.dx, "dx") ?? 0);
      const dy = Math.round(opt(x.dy, "dy") ?? 0);
      let sx = 1;
      let sy = 1;
      if (Array.isArray(x.scale)) [sx, sy] = [num(x.scale[0], "scale"), num(x.scale[1], "scale")];
      else if (x.scale !== undefined) sx = sy = num(x.scale, "scale");
      if (sx <= 0 || sy <= 0 || sx > 50 || sy > 50) return bad('"scale" must be between 0 and 50');
      const flip = String(x.flip ?? "").toLowerCase();
      if (flip.startsWith("h")) sx = -sx;
      else if (flip.startsWith("v")) sy = -sy;
      else if (flip) return bad('"flip" is horizontal or vertical');
      const angle = opt(x.rotate ?? x.angle, "rotate") ?? 0;
      // Only the pixels inside an area, cut and put down dx/dy away (p3.5.6, the page's Move
      // with a selection): the layer itself stays where it is.
      if (x.area !== undefined && x.area !== null) {
        if (sx !== 1 || sy !== 1 || angle)
          return bad('with "area" a transform only moves: give dx/dy alone');
        if (!dx && !dy) return bad("give dx/dy to move the area's pixels");
        const a = areaCov(x.area, layerRect(l));
        if (!a) return bad("the area is outside the layer");
        return { actions: movedPixels(l, a, dx, dy, canvasRect(m), blobs), what: "transform" };
      }
      if (sx === 1 && sy === 1 && !angle) {
        if (!dx && !dy) return bad("give dx/dy, scale, rotate or flip");
        return {
          actions: [{ t: "props", layer: l.id, set: { x: l.x + dx, y: l.y + dy } }],
          what: "transform",
        };
      }
      const cx = l.x + l.px.width / 2;
      const cy = l.y + l.px.height / 2;
      const aff = affineAround(cx, cy, sx, sy, angle);
      aff.e += dx;
      aff.f += dy;
      if (l.text) {
        // A text layer stays text (p3.5.8): its size follows the scale, the turn is kept.
        if (sx < 0 || sy < 0)
          return bad(`flipping the text layer «${l.name}»: rasterize_text it first`);
        const [bx, by] = textOrigin(l);
        const lay = layoutText(fontOfText(l.text), l.text);
        const bc = [bx + lay.w / 2, by + lay.h / 2] as const;
        const nc = [aff.a * bc[0] + aff.c * bc[1] + aff.e, aff.b * bc[0] + aff.d * bc[1] + aff.f];
        const next = scaledText(l.text, sx, sy, angle);
        const nl = layoutText(fontOfText(next), next);
        const acts = textActions(
          l,
          next,
          (nc[0] as number) - nl.w / 2,
          (nc[1] as number) - nl.h / 2,
          blobs,
          "transform",
        );
        if (l.mask) {
          const mt = transformBuffer(l.mask.img, l.mask.x, l.mask.y, aff, true, l.mask.outside);
          acts.push({
            t: "pixels",
            layer: l.id,
            mask: true,
            x: mt.x,
            y: mt.y,
            w: mt.px.width,
            h: mt.px.height,
            png: blobs.hashOf(mt.px),
            outside: l.mask.outside,
            what: "transform",
          });
        }
        return { actions: acts, what: "transform" };
      }
      const t = transformBuffer(l.px, l.x, l.y, aff);
      const acts: ImagePlainAction[] = [
        {
          t: "pixels",
          layer: l.id,
          x: t.x,
          y: t.y,
          w: t.px.width,
          h: t.px.height,
          png: t.px.width ? blobs.hashOf(t.px) : null,
          what: "transform",
        },
      ];
      if (l.mask) {
        const mt = transformBuffer(l.mask.img, l.mask.x, l.mask.y, aff, true, l.mask.outside);
        acts.push({
          t: "pixels",
          layer: l.id,
          mask: true,
          x: mt.x,
          y: mt.y,
          w: mt.px.width,
          h: mt.px.height,
          png: blobs.hashOf(mt.px),
          outside: l.mask.outside,
          what: "transform",
        });
      }
      return { actions: acts, what: "transform" };
    }
    case "crop": {
      const w = Math.round(num(x.w ?? x.width, "w"));
      const h = Math.round(num(x.h ?? x.height, "h"));
      if (w < 1 || h < 1 || w > IMAGE_MAX_SIDE || h > IMAGE_MAX_SIDE)
        return bad(`the size must be between 1 and ${IMAGE_MAX_SIDE}`);
      return {
        actions: [
          {
            t: "canvas",
            width: w,
            height: h,
            dx: -Math.round(num(x.x ?? 0, "x")),
            dy: -Math.round(num(x.y ?? 0, "y")),
          },
        ],
      };
    }
    case "resize_canvas":
    case "canvas_size": {
      const w = Math.round(num(x.width ?? x.w, "width"));
      const h = Math.round(num(x.height ?? x.h, "height"));
      if (w < 1 || h < 1 || w > IMAGE_MAX_SIDE || h > IMAGE_MAX_SIDE)
        return bad(`the size must be between 1 and ${IMAGE_MAX_SIDE}`);
      const anchor = String(x.anchor ?? "center").toLowerCase();
      const hx = anchor.includes("left") ? 0 : anchor.includes("right") ? 1 : 0.5;
      const vy = anchor.includes("top") ? 0 : anchor.includes("bottom") ? 1 : 0.5;
      return {
        actions: [
          {
            t: "canvas",
            width: w,
            height: h,
            dx: Math.round((w - m.width) * hx),
            dy: Math.round((h - m.height) * vy),
          },
        ],
      };
    }
    case "resize_image":
    case "scale_image": {
      const ww = opt(x.width ?? x.w, "width");
      const hh = opt(x.height ?? x.h, "height");
      if (ww === undefined && hh === undefined) return bad('give "width", "height" or both');
      const w = Math.round(ww ?? ((hh as number) * m.width) / m.height);
      const h = Math.round(hh ?? ((ww as number) * m.height) / m.width);
      if (w < 1 || h < 1 || w > IMAGE_MAX_SIDE || h > IMAGE_MAX_SIDE)
        return bad(`the size must be between 1 and ${IMAGE_MAX_SIDE}`);
      const aff = { a: w / m.width, b: 0, c: 0, d: h / m.height, e: 0, f: 0 };
      const acts: ImagePlainAction[] = [];
      for (const l of m.layers) {
        if (l.text) {
          // A text layer is drawn again at the new scale (it stays text).
          const [bx, by] = textOrigin(l);
          acts.push(
            ...textActions(
              l,
              scaledText(l.text, aff.a, aff.d),
              bx * aff.a,
              by * aff.d,
              blobs,
              "transform",
            ),
          );
        } else if (l.px.width && l.px.height) {
          const t = transformBuffer(l.px, l.x, l.y, aff);
          acts.push({
            t: "pixels",
            layer: l.id,
            x: t.x,
            y: t.y,
            w: t.px.width,
            h: t.px.height,
            png: t.px.width ? blobs.hashOf(t.px) : null,
            what: "transform",
          });
        }
        if (l.mask) {
          const mt = transformBuffer(l.mask.img, l.mask.x, l.mask.y, aff, true, l.mask.outside);
          acts.push({
            t: "pixels",
            layer: l.id,
            mask: true,
            x: mt.x,
            y: mt.y,
            w: mt.px.width,
            h: mt.px.height,
            png: blobs.hashOf(mt.px),
            outside: l.mask.outside,
          });
        }
      }
      // Pixels of a locked layer are not changed.
      const locked = m.layers.find((l) => l.locked);
      if (locked) return bad(`the layer «${locked.name}» is locked`);
      acts.push({ t: "canvas", width: w, height: h, dx: 0, dy: 0 });
      return { actions: acts, what: "transform" };
    }
    case "add_text":
    case "text": {
      const text = typeof x.text === "string" ? x.text.slice(0, 5000) : bad('give "text"');
      if (!text.trim()) return bad('give "text"');
      const tx = num(x.x ?? 0, "x");
      const ty = num(x.y ?? 0, "y");
      if (x.layer !== undefined) {
        // The text drawn as plain pixels on an existing layer (as before p3.5.8).
        const size = Math.max(2, Math.min(2000, opt(x.size ?? x.font_size, "size") ?? 32));
        const fontName = String(
          x.font && x.font !== "sans"
            ? x.font
            : x.bold
              ? x.italic
                ? "sans-bold-italic"
                : "sans-bold"
              : x.italic
                ? "sans-italic"
                : "sans",
        ).toLowerCase() as FontName;
        if (!(fontName in FONTS)) return bad(`"font" is ${Object.keys(FONTS).join(", ")}`);
        let font: ReturnType<typeof fontNamed>;
        try {
          font = fontNamed(fontName);
        } catch {
          return bad("the font for texts is not here (pdf.js's standard fonts)");
        }
        const align = String(x.align ?? "left").toLowerCase();
        if (!["left", "center", "right"].includes(align))
          return bad('"align" is left, center or right');
        const c = colorOf(x.color ?? "#000000", "color");
        const t = textPolys(
          font,
          text,
          size,
          tx,
          ty,
          align as "left",
          opt(x.line_height, "line_height") ?? 1.2,
        );
        const l = layerOf(m, x.layer);
        const cov = fillPolys(t.polys, canvasRect(m));
        if (!cov) return bad("the text is outside the picture");
        return {
          actions: edited(l, cov, (px, ox, oy) => paintCov(px, ox, oy, cov, c), "text", blobs),
          what: "text",
        };
      }
      const spec = textSpec(x, {
        text,
        font: "sans",
        size: 32,
        color: "#000000",
        align: "left",
        bold: false,
        italic: false,
        lineHeight: 1.2,
        ox: 0,
        oy: 0,
      });
      const r = textLayer(fontOfText(spec), spec, tx, ty);
      const above =
        x.above === undefined ? top() : x.above === null ? null : layerOf(m, x.above, "above").id;
      const info: ImageLayerInfo = {
        id: newId(),
        name:
          typeof x.name === "string" && x.name.trim()
            ? x.name.trim()
            : text.split("\n")[0]?.slice(0, 60) || "Text",
        x: r.x,
        y: r.y,
        w: r.px.width,
        h: r.px.height,
        opacity: opacityArg(x.opacity) ?? 1,
        visible: true,
        blend: blendArg(x.blend) ?? "svg:src-over",
        text: r.text,
      };
      return {
        actions: [
          {
            t: "add",
            layer: info,
            above,
            png: r.px.width && r.px.height ? blobs.hashOf(r.px as Rgba) : null,
            mask: null,
          },
        ],
        what: "text",
      };
    }
    case "edit_text":
    case "set_text": {
      const l = layerOf(m, x.layer);
      if (!l.text)
        return bad(
          `«${l.name}» is not a text layer (add_text makes one; "layer" in add_text draws on it)`,
        );
      if (l.locked) return bad(`the layer «${l.name}» is locked`);
      const text = x.text === undefined ? l.text.text : String(x.text).slice(0, 5000);
      const next = textSpec(x, { ...l.text, text });
      const [bx, by] = textOrigin(l);
      const nx = opt(x.x, "x") ?? bx;
      const ny = opt(x.y, "y") ?? by;
      return { actions: textActions(l, next, nx, ny, blobs, "text"), what: "text" };
    }
    case "rasterize_text":
    case "rasterize": {
      const l = layerOf(m, x.layer);
      if (!l.text) return bad(`«${l.name}» is not a text layer`);
      return { actions: [{ t: "props", layer: l.id, set: { text: null } }] };
    }
    case "add_mask":
    case "mask": {
      const l = layerOf(m, x.layer);
      const r = l.px.width && l.px.height ? layerRect(l) : canvasRect(m);
      const a = areaCov(x.area, r);
      const inv = x.invert === true;
      const img = blank(r.w, r.h);
      for (let yy = 0; yy < r.h; yy++)
        for (let xx = 0; xx < r.w; xx++) {
          let v = a === undefined ? 1 : a === null ? 0 : covAt(a, xx + r.x, yy + r.y);
          if (inv) v = 1 - v;
          const g = Math.round(v * 255);
          img.data.set([g, g, g, 255], (yy * r.w + xx) * 4);
        }
      const outside = inv && a !== undefined ? 255 : a === undefined ? 255 : 0;
      return {
        actions: [
          {
            t: "pixels",
            layer: l.id,
            mask: true,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            png: blobs.hashOf(img),
            outside,
          },
        ],
      };
    }
    case "delete_mask":
    case "remove_mask": {
      const l = layerOf(m, x.layer);
      if (!l.mask) return bad(`the layer «${l.name}» has no mask`);
      return {
        actions: [{ t: "pixels", layer: l.id, mask: true, x: 0, y: 0, w: 0, h: 0, png: null }],
      };
    }
    case "apply_mask": {
      const l = layerOf(m, x.layer);
      if (!l.mask) return bad(`the layer «${l.name}» has no mask`);
      if (l.locked) return bad(`the layer «${l.name}» is locked`);
      const px = masked(l);
      return {
        actions: [
          {
            t: "pixels",
            layer: l.id,
            x: l.x,
            y: l.y,
            w: px.width,
            h: px.height,
            png: px.width ? blobs.hashOf(px) : null,
            what: "other",
          },
          { t: "pixels", layer: l.id, mask: true, x: 0, y: 0, w: 0, h: 0, png: null },
        ],
      };
    }
    default:
      return bad(
        name
          ? `there is no operation «${name}» (call with "help": true)`
          : 'each operation needs "op"',
      );
  }
}

/** The agent's operations as actions, each made on the picture the ones before it left. */
export function imageFromAgent(
  m: ImageModel,
  ops: readonly unknown[],
  ctx: AgentContext,
): { actions: ImageAction[] } | { error: string; index?: number } {
  let cur = m;
  const out: ImagePlainAction[] = [];
  const whats = new Set<string>();
  let filter: string | undefined;
  for (const [index, raw] of ops.entries()) {
    try {
      if (!raw || typeof raw !== "object") bad("an operation is an object");
      const r = one(cur, raw as Plain, ctx);
      for (const a of r.actions) {
        cur = applyAction(cur, a, ctx.blobs);
        out.push(a);
      }
      if (r.what) whats.add(r.what);
      if (r.filter) filter = r.filter;
    } catch (e) {
      if (e instanceof Bad) return { error: e.message, index };
      return { error: (e as Error).message, index };
    }
  }
  if (!out.length) return { error: "nothing would change" };
  const what = whats.size === 1 ? ([...whats][0] as What) : undefined;
  if (out.length === 1 && !(what && out[0]?.t === "add"))
    return { actions: [out[0] as ImagePlainAction] };
  return { actions: [{ t: "batch", ops: out, ...(what && { what }), ...(filter && { filter }) }] };
}

/**
 * Paragraph texts the agent's edit left too long for their box (Photoshop's overflow mark): a
 * line for the agent, on the picture after the edit; undefined when every text fits.
 */
export function textOverflow(after: ImageModel, touched: ReadonlySet<string>): string | undefined {
  const out: string[] = [];
  for (const l of after.layers) {
    if (!l.text?.box || !touched.has(l.id)) continue;
    const hidden = layoutText(fontOfText(l.text), l.text).hidden;
    if (hidden)
      out.push(
        `The text of «${l.name}» does not fit its box: ${hidden} line${hidden === 1 ? " is" : "s are"} hidden (a taller "box" or a smaller "size" with edit_text shows ${hidden === 1 ? "it" : "them"}).`,
      );
  }
  return out.length ? out.join("\n") : undefined;
}

function withoutMask(l: RLayer): RLayer {
  const { mask: _m, ...rest } = l;
  return rest;
}

/** The blends' short names (for the catalog and the structure). */
export const blendWord = imageBlendName;
