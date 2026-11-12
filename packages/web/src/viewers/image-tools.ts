// The picture editor's tools as Photoshop's (p3.5.7, the user's decision of 2026-11-11): the same
// tools in the same groups and order, one slot per group on the left bar (its last tool shown,
// the others in a flyout), the same letters (the letter picks the group's tool in use,
// Shift+letter the next one of the group). Pure: tested on its own.

export type ImageTool =
  | "move"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "lasso-poly"
  | "lasso-magnetic"
  | "quick-select"
  | "wand"
  | "crop"
  | "eyedropper"
  | "brush"
  | "pencil"
  | "clone"
  | "eraser"
  | "gradient"
  | "bucket"
  | "text"
  | "shape-rect"
  | "shape-ellipse"
  | "shape-line"
  | "hand"
  | "zoom";

export interface ToolGroup {
  id: string;
  key: string;
  tools: readonly ImageTool[];
}

/** Photoshop's order, top to bottom. */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: "move", key: "v", tools: ["move"] },
  { id: "marquee", key: "m", tools: ["marquee-rect", "marquee-ellipse"] },
  { id: "lasso", key: "l", tools: ["lasso", "lasso-poly", "lasso-magnetic"] },
  { id: "select", key: "w", tools: ["quick-select", "wand"] },
  { id: "crop", key: "c", tools: ["crop"] },
  { id: "eyedropper", key: "i", tools: ["eyedropper"] },
  { id: "brush", key: "b", tools: ["brush", "pencil"] },
  { id: "clone", key: "s", tools: ["clone"] },
  { id: "eraser", key: "e", tools: ["eraser"] },
  { id: "fill", key: "g", tools: ["gradient", "bucket"] },
  { id: "text", key: "t", tools: ["text"] },
  { id: "shape", key: "u", tools: ["shape-rect", "shape-ellipse", "shape-line"] },
  { id: "hand", key: "h", tools: ["hand"] },
  { id: "zoom", key: "z", tools: ["zoom"] },
];

export const groupOf = (tool: ImageTool): ToolGroup =>
  TOOL_GROUPS.find((g) => g.tools.includes(tool)) as ToolGroup;

/** The tool each group shows (its last used), first ones at the start. */
export const defaultShown = (): Record<string, ImageTool> =>
  Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0] as ImageTool]));

/**
 * A letter pressed: the tool it picks (Shift: the next in the group, from the one in use or
 * shown), or undefined when the letter is no tool's.
 */
export function toolForKey(
  key: string,
  shift: boolean,
  current: ImageTool,
  shown: Record<string, ImageTool>,
): ImageTool | undefined {
  const g = TOOL_GROUPS.find((x) => x.key === key.toLowerCase());
  if (!g) return undefined;
  const at = g.tools.includes(current) ? current : (shown[g.id] ?? g.tools[0]);
  if (!shift || g.tools.length === 1) return at;
  const i = g.tools.indexOf(at as ImageTool);
  return g.tools[(i + 1) % g.tools.length];
}

/**
 * What Delete or Backspace does on the picture or the layers panel (p3.5.12, the person's test of
 * 3.5.11), as Photoshop: with pixels selected they are cleared; with none, the layer chosen goes
 * away (one revision, one Ctrl+Z), after a question only when it is the last one. Nothing while a
 * text is typed (the keys are the text's) or with no layer chosen.
 */
export function deleteKeyDoes(o: {
  selection: boolean;
  typing: boolean;
  layers: number;
  current: boolean;
}): "clear" | "layer" | "last-layer" | undefined {
  if (o.typing) return undefined;
  if (o.selection) return "clear";
  if (!o.current || o.layers < 1) return undefined;
  return o.layers === 1 ? "last-layer" : "layer";
}

/** Tools that draw a selection (Shift adds, Alt takes away, both intersect). */
export const SELECTING: ReadonlySet<ImageTool> = new Set([
  "marquee-rect",
  "marquee-ellipse",
  "lasso",
  "lasso-poly",
  "lasso-magnetic",
  "quick-select",
  "wand",
]);

/** Tools with a brush (its size changes with [ and ]). */
export const BRUSHED: ReadonlySet<ImageTool> = new Set([
  "brush",
  "pencil",
  "clone",
  "eraser",
  "quick-select",
]);

/** The mode a selection gesture takes, from the keys held when it starts (and the bar's mode). */
export function selModeOf(
  bar: "new" | "add" | "subtract" | "intersect",
  keys: { shift: boolean; alt: boolean },
  hasSelection: boolean,
): { mode: "new" | "add" | "subtract" | "intersect"; byKeys: boolean } {
  if (hasSelection && (keys.shift || keys.alt))
    return {
      mode: keys.shift && keys.alt ? "intersect" : keys.shift ? "add" : "subtract",
      byKeys: true,
    };
  return { mode: bar, byKeys: false };
}

/** A marquee's rectangle from where it started to the pointer: Shift square, Alt from the centre. */
export function marqueeRect(
  from: [number, number],
  to: [number, number],
  square: boolean,
  centre: boolean,
): { x: number; y: number; w: number; h: number } {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  if (centre)
    return {
      x: from[0] - Math.abs(dx),
      y: from[1] - Math.abs(dy),
      w: Math.abs(dx) * 2,
      h: Math.abs(dy) * 2,
    };
  return {
    x: Math.min(from[0], from[0] + dx),
    y: Math.min(from[1], from[1] + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  };
}

/** A line's end with Shift: at the nearest 45 degrees. */
export function snap45(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
}

/** Photoshop's zoom steps (percent). */
export const ZOOM_STEPS = [
  1, 2, 3, 4, 5, 6.25, 8.33, 12.5, 16.67, 25, 33.33, 50, 66.67, 100, 200, 300, 400, 500, 600, 700,
  800, 1200, 1600, 3200,
];

/** The next zoom step in (+1) or out (-1) from a zoom (a factor, 1 = 100%). */
export function zoomStep(zoom: number, dir: 1 | -1): number {
  const pct = zoom * 100;
  if (dir > 0) return (ZOOM_STEPS.find((s) => s > pct + 0.01) ?? 3200) / 100;
  return ([...ZOOM_STEPS].reverse().find((s) => s < pct - 0.01) ?? 1) / 100;
}

/** The options bar's settings (Photoshop's, per tool). */
export interface ToolOptions {
  selMode: "new" | "add" | "subtract" | "intersect";
  feather: number;
  antialias: boolean;
  tolerance: number;
  contiguous: boolean;
  /** Wand, bucket, eyedropper, clone stamp and quick selection look at every layer. */
  sampleAll: boolean;
  /** Move: the layer under the pointer becomes the current one. */
  autoSelect: boolean;
  gradient: "linear" | "radial";
  /** Gradient: foreground to transparent instead of to the background colour. */
  gradientTransparent: boolean;
  gradientReverse: boolean;
  /** Shapes: the line's width; rectangles and ellipses are filled, or outlined this wide. */
  shapeStroke: number;
  shapeFill: boolean;
  cloneAligned: boolean;
  quickSize: number;
}

export const DEFAULT_OPTIONS: ToolOptions = {
  selMode: "new",
  feather: 0,
  antialias: true,
  tolerance: 32,
  contiguous: true,
  sampleAll: false,
  autoSelect: false,
  gradient: "linear",
  gradientTransparent: false,
  gradientReverse: false,
  shapeStroke: 4,
  shapeFill: true,
  cloneAligned: true,
  quickSize: 20,
};

/** Brush size one step down (`[`) or up (`]`), in Photoshop's steps. */
export function brushStep(size: number, dir: 1 | -1): number {
  const s = dir > 0 ? size : size - 1;
  const step = s < 10 ? 1 : s < 50 ? 5 : s < 100 ? 10 : s < 200 ? 25 : 50;
  return Math.max(1, Math.min(1000, dir > 0 ? size + step : size - step));
}
