// Layered pictures in the editor (G37.5): the `image` family. OpenRaster (.ora: a zip of PNG
// layers and a stack.xml) is the native format; a PNG or JPEG opens as a picture of one layer
// (saved back flattened, its layers kept in an OpenRaster copy beside it when there are more),
// and a Photoshop file is edited on its OpenRaster copy. Pixels never travel inside an
// operation: they are PNG blobs of the host, cited by their sha256, cut in tiles of at most
// `IMAGE_TILE` pixels a side («tasselli»), so a brush stroke carries only the tiles it changed
// and its inverse only those tiles as they were. Layers are named by a stable id; every
// coordinate is in pixels, a layer's own (its top left corner is 0,0) for tiles and the
// picture's for positions.
import { z } from "zod";

/** The biggest side of a tile an operation carries. */
export const IMAGE_TILE = 256;
/** The biggest side of a picture the editor opens. */
export const IMAGE_MAX_SIDE = 16_384;

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().min(1).max(120);
const Coord = z.number().int().min(-1_000_000).max(1_000_000);
const Side = z
  .number()
  .int()
  .nonnegative()
  .max(IMAGE_MAX_SIDE * 4);
const Opacity = z.number().min(0).max(1);

/**
 * OpenRaster's compositing operations the editor draws (stack.xml `composite-op`); a file's own
 * other values are kept as written and drawn as normal.
 */
export const IMAGE_BLENDS = [
  "svg:src-over",
  "svg:multiply",
  "svg:screen",
  "svg:overlay",
  "svg:darken",
  "svg:lighten",
  "svg:color-dodge",
  "svg:color-burn",
  "svg:hard-light",
  "svg:soft-light",
  "svg:difference",
  "svg:exclusion",
  "svg:hue",
  "svg:saturation",
  "svg:color",
  "svg:luminosity",
  "svg:plus",
] as const;
export type ImageBlend = (typeof IMAGE_BLENDS)[number];

/** A blend's short name (the agent's and the page's words): "multiply", "normal", "add". */
export const imageBlendName = (op: string): string =>
  op === "svg:src-over" ? "normal" : op === "svg:plus" ? "add" : op.replace(/^svg:/, "");
/** The composite-op of a short name ("normal" → svg:src-over), undefined when unknown. */
export function imageBlendOf(name: string): ImageBlend | undefined {
  const n = name.trim().toLowerCase().replace(/[ _]/g, "-");
  const op =
    n === "normal" || n === "src-over"
      ? "svg:src-over"
      : n === "add" || n === "plus" || n === "linear-dodge"
        ? "svg:plus"
        : `svg:${n.replace(/^svg:/, "")}`;
  return (IMAGE_BLENDS as readonly string[]).includes(op) ? (op as ImageBlend) : undefined;
}
/** The canvas 2D globalCompositeOperation that draws a composite-op. */
export function canvasBlendOf(op: string): string {
  if (op === "svg:plus") return "lighter";
  if (op === "svg:src-over" || !(IMAGE_BLENDS as readonly string[]).includes(op))
    return "source-over";
  return op.slice(4);
}

/** A group (an OpenRaster `stack`) a layer is inside. */
export const ImageGroup = z.object({
  id: Id,
  name: z.string().max(400),
  opacity: Opacity,
  visible: z.boolean(),
  blend: z.string().max(80),
  /** false: a pass-through group (its layers blend with what is under the group). */
  isolate: z.boolean(),
});
export type ImageGroup = z.infer<typeof ImageGroup>;

/** A layer's place and look (its pixels are apart). */
export const ImageLayerInfo = z.object({
  id: Id,
  name: z.string().max(400),
  /** Its top left corner in the picture. */
  x: Coord,
  y: Coord,
  /** Its pixels' size (0 × 0: empty). */
  w: Side,
  h: Side,
  opacity: Opacity,
  visible: z.boolean(),
  blend: z.string().max(80),
  locked: z.boolean().optional(),
  /** The groups it is in, outermost first. */
  groups: z.array(ImageGroup).max(40).optional(),
});
export type ImageLayerInfo = z.infer<typeof ImageLayerInfo>;

/** A layer's mask: grey (white shows the layer, black hides it), on the picture's coordinates. */
export const ImageMask = z.object({
  x: Coord,
  y: Coord,
  w: Side,
  h: Side,
  /** Beyond its rectangle: 0 hides, 255 shows. */
  outside: z.number().int().min(0).max(255),
  png: Hash,
});
export type ImageMask = z.infer<typeof ImageMask>;

export const ImageTile = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive().max(IMAGE_TILE),
  h: z.number().int().positive().max(IMAGE_TILE),
  png: Hash,
});
export type ImageTile = z.infer<typeof ImageTile>;

/** What a change of pixels was, for the panel's words. */
export const IMAGE_WHATS = [
  "paint",
  "erase",
  "fill",
  "clear",
  "filter",
  "shape",
  "text",
  "transform",
  "paste",
  "other",
] as const;
const What = z.enum(IMAGE_WHATS);

const LayerProps = z.object({
  name: z.string().max(400).optional(),
  x: Coord.optional(),
  y: Coord.optional(),
  opacity: Opacity.optional(),
  visible: z.boolean().optional(),
  blend: z.string().max(80).optional(),
  locked: z.boolean().optional(),
});

const plain = {
  /** A layer put directly above `above` (at the bottom when null), with its pixels (null: none). */
  add: z.object({
    t: z.literal("add"),
    layer: ImageLayerInfo,
    above: Id.nullable(),
    png: Hash.nullable(),
    mask: ImageMask.nullable().optional(),
  }),
  remove: z.object({ t: z.literal("remove"), layer: Id }),
  /** Its name, place, opacity, blending, visibility or lock (its mask moves with it). */
  props: z.object({ t: z.literal("props"), layer: Id, set: LayerProps }),
  /** It goes directly above `above` (at the bottom when null). */
  move: z.object({ t: z.literal("move"), layer: Id, above: Id.nullable() }),
  /** Tiles of its pixels (or of its mask) replaced, in its own (or the mask's) coordinates. */
  tiles: z.object({
    t: z.literal("tiles"),
    layer: Id,
    mask: z.boolean().optional(),
    tiles: z.array(ImageTile).min(1).max(20_000),
    what: What.optional(),
  }),
  /**
   * All its pixels and their place replaced (a transform, a layer grown to take a stroke); with
   * `mask`, the mask set (or taken away with `png` null).
   */
  pixels: z.object({
    t: z.literal("pixels"),
    layer: Id,
    mask: z.boolean().optional(),
    x: Coord,
    y: Coord,
    w: Side,
    h: Side,
    png: Hash.nullable(),
    outside: z.number().int().min(0).max(255).optional(),
    what: What.optional(),
  }),
  /** The picture's size changed, every layer (and mask) moved by dx, dy: crop, canvas size. */
  canvas: z.object({
    t: z.literal("canvas"),
    width: z.number().int().positive().max(IMAGE_MAX_SIDE),
    height: z.number().int().positive().max(IMAGE_MAX_SIDE),
    dx: Coord,
    dy: Coord,
  }),
};

export const ImagePlainAction = z.discriminatedUnion("t", [
  plain.add,
  plain.remove,
  plain.props,
  plain.move,
  plain.tiles,
  plain.pixels,
  plain.canvas,
]);
export type ImagePlainAction = z.infer<typeof ImagePlainAction>;

export const ImageAction = z.discriminatedUnion("t", [
  ...ImagePlainAction.options,
  z.object({
    t: z.literal("batch"),
    ops: z.array(ImagePlainAction).max(2000),
    /** What the whole batch was, for the panel's words (a filter, a transform…). */
    what: What.optional(),
    /** The filter's name, when it was one. */
    filter: z.string().max(60).optional(),
  }),
]);
export type ImageAction = z.infer<typeof ImageAction>;

export const ImageDocOp = z.object({
  family: z.literal("image"),
  engine: z.literal("redgiant-raster"),
  engineVersion: z.string().max(40),
  op: ImageAction,
});
export type ImageDocOp = z.infer<typeof ImageDocOp>;

/** A layer as the page loads it: its look, and its pixels' blob. */
export const ImageSnapshotLayer = ImageLayerInfo.extend({
  png: Hash.nullable(),
  mask: ImageMask.optional(),
});
export type ImageSnapshotLayer = z.infer<typeof ImageSnapshotLayer>;

export const ImageSnapshot = z.object({
  family: z.literal("image"),
  /** What the file is: an OpenRaster keeps layers; a PNG or JPEG is written flattened. */
  format: z.enum(["ora", "png", "jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Bottom first, as they are drawn. */
  layers: z.array(ImageSnapshotLayer).max(2000),
});
export type ImageSnapshot = z.infer<typeof ImageSnapshot>;

/** A picture's change, for the panel's words (`DocSummary.image`). */
export const ImageChange = z.object({
  action: z.enum([
    ...IMAGE_WHATS,
    "mask",
    "add_layer",
    "remove_layer",
    "layer",
    "order",
    "canvas",
    "edit",
  ]),
  /** Layers touched. */
  n: z.number().int().nonnegative(),
  /** The one layer's name. */
  layer: z.string().max(400).optional(),
  /** A filter's name (its id in the catalog). */
  filter: z.string().max(60).optional(),
});
export type ImageChange = z.infer<typeof ImageChange>;

/** The tiles that cover a rectangle (its own coordinates), at most `IMAGE_TILE` a side. */
export function imageTilesOf(
  x: number,
  y: number,
  w: number,
  h: number,
  tile = IMAGE_TILE,
): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let ty = Math.floor(y / tile) * tile; ty < y + h; ty += tile)
    for (let tx = Math.floor(x / tile) * tile; tx < x + w; tx += tile) {
      const x0 = Math.max(x, tx);
      const y0 = Math.max(y, ty);
      const x1 = Math.min(x + w, tx + tile);
      const y1 = Math.min(y + h, ty + tile);
      if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  return out;
}
