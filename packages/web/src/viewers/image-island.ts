// The layered picture editor's engine in the page (G37.5), in its own chunk (loaded when a
// picture is opened for editing): each layer is a canvas at its place, drawn bottom to top with
// its opacity, blending (canvas 2D's composite operations), mask and groups. The person's tools
// are Photoshop's (p3.5.7, image-tools.ts): move, marquees, lassos, quick selection and magic
// wand, crop, eyedropper, brush and pencil, clone stamp, eraser, gradient and paint bucket,
// text, shapes, hand and zoom, free transform. Each gesture is one change: the changed pixels
// are cut in tiles (`imageTilesOf`), only the tiles that differ become PNG blobs, and the
// actions go to the host (the server keeps the file). Selections, the Move tool's pixels, the
// bucket, the gradient and the clone stamp are computed by the pure functions the server shares
// (`imagePx`), exact to the pixel. Others' actions arrive the same way and are drawn from their
// blobs.

import {
  canvasBlendOf,
  DEFAULT_TEXT,
  type Font,
  type ImageAction,
  type ImageGroup,
  type ImageLayerInfo,
  type ImagePlainAction,
  type ImageSnapshot,
  type ImageText,
  type ImageTile,
  imageTilesOf,
  layoutText,
  imagePx as P,
  readTrueType,
  renderText,
  runImageFilter,
  scaledText,
  TEXT_FONTS,
  textFontFile,
  textIndexAt,
  textLayer,
  textOrigin,
  textPointIn,
} from "@redgiant/protocol";
import { reducedMotion } from "../a11y.js";
import { Fingers } from "../phone.js";
import {
  TextEditing,
  type TextEditOpen,
  type TextEditResult,
  textEditActions,
} from "./image-text-edit.js";
import {
  DEFAULT_OPTIONS,
  type ImageTool,
  marqueeRect,
  selModeOf,
  snap45,
  type ToolOptions,
  zoomStep,
} from "./image-tools.js";

export type { ImageTool, ToolOptions };

type C = HTMLCanvasElement;
type Ctx = CanvasRenderingContext2D;
type What = NonNullable<Extract<ImagePlainAction, { t: "tiles" }>["what"]>;
type Pt = [number, number];
type Fingertip = readonly [number, number];

export interface IslandLayer extends ImageLayerInfo {
  hasMask: boolean;
  /** A small picture of it (data URL), for the panel. */
  thumb: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Mask {
  x: number;
  y: number;
  outside: number;
  /** Grey (the file's mask). */
  grey: C;
}

interface Lay {
  info: ImageLayerInfo;
  c: C;
  mask?: Mask;
  /** Its alpha for drawing (the mask on the layer's rectangle), made when needed. */
  alpha?: C;
  /** Drawn instead of `c` while a gesture or a filter is previewed (at `previewAt` if given). */
  preview?: C;
  previewAt?: { x: number; y: number };
}

/** Notes the page shows in the person's words. */
export type IslandNote =
  | "locked"
  | "cloneSource"
  | "cloneSet"
  | "nothingSelected"
  | "noLayer"
  | "textLayer";

/** A new text's look (the Text tool's options bar); its colour is the foreground's. */
export type TextLook = Pick<
  ImageText,
  "font" | "size" | "align" | "bold" | "italic" | "lineHeight"
>;

export interface IslandOptions {
  area: HTMLElement;
  blob(hash: string): Promise<Blob>;
  upload(png: Blob): Promise<string>;
  /** The person's actions, once their pixels are blobs, in the order they were made. */
  onActions(actions: ImagePlainAction[], what?: What, filter?: string): void;
  onLayers(): void;
  onSelection(box: Rect | undefined): void;
  onEditing(editing: boolean): void;
  /** A colour picked with the eyedropper: the foreground, or the background (Alt). */
  onPick(hex: string, which: "fg" | "bg"): void;
  /** A font file text layers are drawn with (the server's, p3.5.8). */
  font(file: string): Promise<Uint8Array>;
  /** Typing on the picture started (with the text's look, for the options bar) or ended. */
  onTextEditing?(on: boolean, spec?: ImageText): void;
  onZoom(zoom: number): void;
  onBusy(n: number): void;
  onError(message: string): void;
  onNote?(note: IslandNote): void;
  /** The crop box being drawn (undefined: none), the free transform on or off. */
  onCrop?(box: Rect | undefined): void;
  onTransform?(on: boolean): void;
  /** Names for the layers the tools make (shapes, Layer via Copy). */
  label?(key: "shape-rect" | "shape-ellipse" | "shape-line" | "copy"): string;
}

export interface Brush {
  size: number;
  /** 0…1. */
  opacity: number;
  /** 0…1: soft edges below 1. */
  hardness: number;
  /** 0…1: how much each dab lays down (Photoshop's flow). */
  flow: number;
  /** The foreground colour. */
  color: string;
}

const canvas = (w: number, h: number): C => {
  const c = document.createElement("canvas");
  c.width = Math.max(0, Math.round(w));
  c.height = Math.max(0, Math.round(h));
  return c;
};
const ctx2d = (c: C): Ctx => c.getContext("2d", { willReadFrequently: true }) as Ctx;
const toPng = (c: C): Promise<Blob> =>
  new Promise((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error("PNG"))), "image/png"));
const sameData = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const hexOf = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const greyOfCss = (css: string): number => {
  const c = ctx2d(canvas(1, 1));
  c.fillStyle = css;
  c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data;
  return Math.round(
    0.2126 * (d[0] as number) + 0.7152 * (d[1] as number) + 0.0722 * (d[2] as number),
  );
};
const union = P.union;
const inter = P.inter;
const inside = (a: Rect, b: Rect) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
let ids = 0;
const newId = () => `p-${Date.now().toString(36)}${(ids++).toString(36)}`;
/** A canvas's pixels as `imagePx` pixels. */
const pxOf = (c: C): P.Px =>
  c.width && c.height
    ? {
        width: c.width,
        height: c.height,
        data: ctx2d(c).getImageData(0, 0, c.width, c.height).data,
      }
    : P.blankPx(0, 0);
const canvasOf = (px: P.Px): C => {
  const c = canvas(px.width, px.height);
  if (px.width && px.height)
    ctx2d(c).putImageData(
      new ImageData(
        new Uint8ClampedArray(px.data) as Uint8ClampedArray<ArrayBuffer>,
        px.width,
        px.height,
      ),
      0,
      0,
    );
  return c;
};

/** The free transform: scale and rotation around the box's centre, then a move. */
interface Xform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  rot: number;
}

const HANDLE = 5;

type Gesture =
  | {
      kind: "paint";
      tool: "brush" | "pencil" | "eraser" | "clone";
      stroke: C;
      pts: Pt[];
      last: Pt;
      /** The eraser on a Background paints its colour. */
      color: string;
      erase: boolean;
      /** The clone stamp's source pixels (picture-sized) and offset. */
      src?: C;
      off?: Pt;
    }
  | { kind: "move"; from: Pt; at: Pt; lay: Lay; dup?: Lay }
  | {
      kind: "float";
      from: Pt;
      at: Pt;
      lay: Lay;
      f: P.Floating;
      start: Pt;
      holed: C;
      piece: C;
    }
  | { kind: "outline"; from: Pt; at: Pt }
  | {
      kind: "marquee";
      shape: "rect" | "ellipse";
      from: Pt;
      to: Pt;
      mode: P.SelMode;
      byKeys: boolean;
      square: boolean;
      centre: boolean;
    }
  | { kind: "lasso"; pts: Pt[]; mode: P.SelMode }
  | {
      kind: "poly";
      pts: Pt[];
      mode: P.SelMode;
      magnetic: boolean;
      grad?: Float32Array;
    }
  | { kind: "quick"; mode: P.SelMode; sample: P.Px; acc: P.Sel; last: Pt }
  | { kind: "crop"; from: Pt; start: Rect | undefined; how: string }
  | { kind: "eyedrop"; bg: boolean; sample: P.Px }
  | { kind: "gradient"; from: Pt; to: Pt }
  | {
      kind: "shape";
      shape: "rect" | "ellipse" | "line";
      from: Pt;
      to: Pt;
      shift: boolean;
      alt: boolean;
    }
  | { kind: "hand"; x: number; y: number; sl: number; st: number }
  | { kind: "text"; from: Pt; to: Pt; hit: Lay | undefined }
  | { kind: "xform"; how: string; from: Pt; start: Xform };

export class ImageIsland {
  width = 1;
  height = 1;
  format: ImageSnapshot["format"] = "ora";
  private layers: Lay[] = [];
  current: string | undefined;
  tool: ImageTool = "brush";
  brush: Brush = { size: 12, opacity: 1, hardness: 1, flow: 1, color: "#e0482e" };
  /** The background colour (Photoshop's second swatch). */
  background = "#ffffff";
  opts: ToolOptions = { ...DEFAULT_OPTIONS };
  /** Painting on the current layer's mask instead of its pixels. */
  onMask = false;
  zoom = 1;
  private readonly view: C;
  private readonly over: C;
  private readonly stage: HTMLDivElement;
  /** The selection: its coverage, its outline (a path of the pixels' edges), its box. */
  private sel: { mask: P.Sel; path: Path2D; box: Rect; alpha?: C } | undefined;
  /** The last selection let go (Reselect). */
  private lastSel: P.Sel | undefined;
  /**
   * The Move tool's selected pixels after a drop, still held with the selection: moving them
   * again starts from the same cut (p3.5.7: in 3.5.6 every drop was final, and the next drag cut
   * a new hole where the pixels had landed). Let go when the selection, the layer or the
   * picture change any other way.
   */
  private floating: { lay: Lay; f: P.Floating; dx: number; dy: number } | undefined;
  /** The clone stamp's source (Alt-click) and, aligned, its offset from the strokes. */
  private cloneSrc: Pt | undefined;
  private cloneOff: Pt | undefined;
  /** The crop box being set. */
  private crop: Rect | undefined;
  /** The free transform under way. */
  private xf:
    | {
        lay: Lay;
        /** The pixels transformed (picture coordinates) and their box. */
        src: C;
        box: Rect;
        /** The layer without them (at its place), the selection's cut, or none (the whole layer). */
        f?: P.Floating;
        m: Xform;
      }
    | undefined;
  /** Space held: the hand for a while (Photoshop's). */
  spaceHand = false;
  /** Alt held (the zoom tool zooms out). */
  altHeld = false;
  private hover: Pt | undefined;
  private ants = 0;
  private antsTimer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private busy = 0;
  private frame = 0;
  private gesture: Gesture | undefined;
  /** Fingers on the picture (3.5.11): one draws, two pan and zoom. */
  private readonly fingers = new Fingers();
  private filterPreview: { id: string; layer: string } | undefined;
  private disposed = false;
  /** A new text's look (p3.5.8, the options bar's). */
  textLook: TextLook = {
    font: DEFAULT_TEXT.font,
    size: DEFAULT_TEXT.size,
    align: DEFAULT_TEXT.align,
    bold: false,
    italic: false,
    lineHeight: DEFAULT_TEXT.lineHeight,
  };
  /** The fonts arrived, by file, and those on their way. */
  private readonly fonts = new Map<string, Font>();
  private readonly fontsComing = new Map<string, Promise<Font | undefined>>();
  /** Typing on the picture. */
  private readonly texting: TextEditing;
  /** A new text being typed, drawn over the picture until it is a layer. */
  private draft: { c: C; x: number; y: number } | undefined;

  constructor(private readonly o: IslandOptions) {
    this.stage = document.createElement("div");
    this.stage.className = "img-stage-inner";
    this.view = canvas(1, 1);
    this.view.className = "img-view";
    this.over = canvas(1, 1);
    this.over.className = "img-over";
    this.stage.append(this.view, this.over);
    o.area.append(this.stage);
    this.over.addEventListener("pointerdown", this.down);
    this.over.addEventListener("pointermove", this.moveEv);
    this.over.addEventListener("pointerup", this.up);
    this.over.addEventListener("pointercancel", this.up);
    this.over.addEventListener("pointerleave", this.leave);
    this.over.addEventListener("dblclick", this.dbl);
    o.area.addEventListener("wheel", this.wheel, { passive: false });
    this.texting = new TextEditing({
      stage: this.stage,
      zoom: () => this.zoom,
      measure: (t) => this.measure(t),
      onLive: (st) => this.textLive(st),
      onCommit: (r) => this.textCommit(r),
      onCancel: (id) => this.textCancel(id),
    });
  }

  dispose(): void {
    this.texting.cancel();
    this.disposed = true;
    if (this.antsTimer) clearInterval(this.antsTimer);
    this.o.area.removeEventListener("wheel", this.wheel);
    this.stage.remove();
  }

  // ---------------------------------------------------------------- loading and remote actions

  private async pixels(hash: string | null, w: number, h: number): Promise<C> {
    const c = canvas(w, h);
    if (!hash || !w || !h) return c;
    const bmp = await createImageBitmap(await this.o.blob(hash));
    ctx2d(c).drawImage(bmp, 0, 0);
    bmp.close?.();
    return c;
  }

  async load(s: ImageSnapshot): Promise<void> {
    const layers: Lay[] = [];
    for (const l of s.layers) {
      const { png: _p, mask: m, ...info } = l;
      const lay: Lay = { info, c: await this.pixels(l.png, l.w, l.h) };
      if (m)
        lay.mask = { x: m.x, y: m.y, outside: m.outside, grey: await this.pixels(m.png, m.w, m.h) };
      layers.push(lay);
    }
    if (this.disposed) return;
    this.texting.cancel();
    this.width = s.width;
    this.height = s.height;
    this.format = s.format;
    this.layers = layers;
    const families = layers.flatMap((l) => (l.info.text ? [l.info.text.font] : []));
    if (families.length) this.preloadFonts(families);
    if (!this.current || !this.find(this.current)) this.current = layers.at(-1)?.info.id;
    this.resize();
    this.letGo();
    this.xf = undefined;
    this.crop = undefined;
    this.gesture = undefined;
    this.setSel(undefined);
    this.lastSel = undefined;
    this.render();
    this.o.onLayers();
  }

  private find(id: string) {
    return this.layers.find((l) => l.info.id === id);
  }

  /** Others' actions, drawn from their blobs; "reload" when they do not fit what is here. */
  async remote(actions: readonly ImageAction[]): Promise<"ok" | "reload"> {
    // Others' changes (and the person's undos) end the floating pixels: what they hold changed.
    this.letGo();
    try {
      for (const a of actions)
        for (const op of a.t === "batch" ? a.ops : [a]) await this.applyRemote(op);
    } catch {
      return "reload";
    }
    this.render();
    this.o.onLayers();
    return "ok";
  }

  private async applyRemote(a: ImagePlainAction): Promise<void> {
    const no = () => {
      throw new Error("no layer");
    };
    switch (a.t) {
      case "add": {
        const lay: Lay = {
          info: { ...a.layer },
          c: await this.pixels(a.png, a.layer.w, a.layer.h),
        };
        if (a.mask)
          lay.mask = {
            x: a.mask.x,
            y: a.mask.y,
            outside: a.mask.outside,
            grey: await this.pixels(a.mask.png, a.mask.w, a.mask.h),
          };
        this.place(lay, a.above);
        return;
      }
      case "remove":
        if (!this.find(a.layer)) no();
        if (this.texting.layer === a.layer) this.texting.cancel();
        this.layers = this.layers.filter((l) => l.info.id !== a.layer);
        if (this.current === a.layer) this.current = this.layers.at(-1)?.info.id;
        return;
      case "props": {
        const l = this.find(a.layer) ?? no();
        const { x, y, ...rest } = a.set;
        Object.assign(
          l.info,
          Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
        );
        if (a.set.locked === false) delete l.info.locked;
        if (a.set.text === null) delete l.info.text;
        const dx = x === undefined ? 0 : x - l.info.x;
        const dy = y === undefined ? 0 : y - l.info.y;
        l.info.x += dx;
        l.info.y += dy;
        if (l.mask && (dx || dy)) {
          l.mask.x += dx;
          l.mask.y += dy;
        }
        l.alpha = undefined;
        return;
      }
      case "move": {
        const l = this.find(a.layer) ?? no();
        this.place(l, a.above);
        return;
      }
      case "tiles": {
        const l = this.find(a.layer) ?? no();
        const target = a.mask ? (l.mask ?? no()).grey : l.c;
        const c = ctx2d(target);
        for (const t of a.tiles) {
          const bmp = await createImageBitmap(await this.o.blob(t.png));
          c.clearRect(t.x, t.y, t.w, t.h);
          c.drawImage(bmp, t.x, t.y);
          bmp.close?.();
        }
        l.alpha = undefined;
        return;
      }
      case "pixels": {
        const l = this.find(a.layer) ?? no();
        if (a.mask) {
          if (a.png)
            l.mask = {
              x: a.x,
              y: a.y,
              outside: a.outside ?? 0,
              grey: await this.pixels(a.png, a.w, a.h),
            };
          else delete l.mask;
        } else {
          l.c = await this.pixels(a.png, a.w, a.h);
          l.info.x = a.x;
          l.info.y = a.y;
          l.info.w = a.w;
          l.info.h = a.h;
        }
        l.alpha = undefined;
        return;
      }
      case "canvas":
        this.width = a.width;
        this.height = a.height;
        for (const l of this.layers) {
          l.info.x += a.dx;
          l.info.y += a.dy;
          if (l.mask) {
            l.mask.x += a.dx;
            l.mask.y += a.dy;
          }
        }
        this.setSel(undefined);
        this.lastSel = undefined;
        this.resize();
        return;
    }
  }

  private place(lay: Lay, above: string | null) {
    const rest = this.layers.filter((l) => l !== lay && l.info.id !== lay.info.id);
    const i = above === null ? -1 : rest.findIndex((l) => l.info.id === above);
    rest.splice(i + 1, 0, lay);
    this.layers = rest;
  }

  // ---------------------------------------------------------------- drawing the picture

  private resize() {
    for (const c of [this.view, this.over]) {
      c.width = this.width;
      c.height = this.height;
    }
    this.applyZoom();
  }

  private applyZoom() {
    const w = `${Math.max(1, Math.round(this.width * this.zoom))}px`;
    const h = `${Math.max(1, Math.round(this.height * this.zoom))}px`;
    for (const c of [this.view, this.over]) {
      c.style.width = w;
      c.style.height = h;
    }
    this.stage.style.width = w;
    this.stage.style.height = h;
    this.view.style.imageRendering = this.zoom >= 2 ? "pixelated" : "auto";
    this.texting?.restyle();
    this.o.onZoom(this.zoom);
  }

  setZoom(z: number | "fit"): number {
    if (z === "fit") {
      const box = this.o.area.getBoundingClientRect();
      z = Math.min((box.width - 24) / this.width, (box.height - 24) / this.height, 1) || 1;
    }
    this.zoom = Math.max(0.01, Math.min(32, z));
    this.applyZoom();
    this.drawOverlay();
    return this.zoom;
  }

  /** Zoom in or out a step keeping a picture's point under the pointer (the zoom tool). */
  zoomAt(dir: 1 | -1, p?: Pt): void {
    const area = this.o.area;
    const before = this.over.getBoundingClientRect();
    const at = p ?? [this.width / 2, this.height / 2];
    const cx = before.left + at[0] * this.zoom;
    const cy = before.top + at[1] * this.zoom;
    this.setZoom(zoomStep(this.zoom, dir));
    const after = this.over.getBoundingClientRect();
    area.scrollLeft += after.left + at[0] * this.zoom - cx;
    area.scrollTop += after.top + at[1] * this.zoom - cy;
  }

  private alphaOf(l: Lay): C | undefined {
    const m = l.mask;
    if (!m) return undefined;
    if (l.alpha && l.alpha.width === l.c.width && l.alpha.height === l.c.height) return l.alpha;
    const w = l.c.width;
    const h = l.c.height;
    const a = canvas(w, h);
    if (!w || !h) return a;
    const img = new ImageData(w, h);
    const grey =
      m.grey.width && m.grey.height
        ? ctx2d(m.grey).getImageData(0, 0, m.grey.width, m.grey.height).data
        : undefined;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const mx = l.info.x + x - m.x;
        const my = l.info.y + y - m.y;
        const v =
          grey && mx >= 0 && my >= 0 && mx < m.grey.width && my < m.grey.height
            ? (grey[(my * m.grey.width + mx) * 4] as number)
            : m.outside;
        img.data[(y * w + x) * 4 + 3] = v;
      }
    ctx2d(a).putImageData(img, 0, 0);
    l.alpha = a;
    return a;
  }

  /** A layer's pixels as they are drawn (its mask applied). */
  private drawn(l: Lay): C {
    const src = l.preview ?? l.c;
    // A preview placed elsewhere (a move, a transform) is drawn without the mask while it lasts.
    const alpha = l.preview && l.previewAt ? undefined : this.alphaOf(l);
    if (!alpha || !src.width || !src.height) return src;
    const t = canvas(src.width, src.height);
    const c = ctx2d(t);
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(alpha, 0, 0);
    return t;
  }

  /** The layers drawn into a canvas of the picture's size (`only`: some of them). */
  composite(only?: (l: ImageLayerInfo) => boolean): C {
    const out = canvas(this.width, this.height);
    type N = { group?: ImageGroup; children: (N | Lay)[] };
    const root: N = { children: [] };
    const open: N[] = [root];
    for (const l of this.layers) {
      const gs = l.info.groups ?? [];
      let k = 0;
      while (k < gs.length && k + 1 < open.length && (open[k + 1] as N).group?.id === gs[k]?.id)
        k++;
      open.length = k + 1;
      for (let g = k; g < gs.length; g++) {
        const n: N = { group: gs[g] as ImageGroup, children: [] };
        (open[open.length - 1] as N).children.push(n);
        open.push(n);
      }
      (open[open.length - 1] as N).children.push(l);
    }
    const draw = (n: N, c: Ctx, opacity: number) => {
      for (const x of n.children) {
        if ("children" in x) {
          const g = x.group as ImageGroup;
          if (!g.visible) continue;
          if (g.isolate || g.opacity < 1 || g.blend !== "svg:src-over") {
            const sub = canvas(this.width, this.height);
            draw(x, ctx2d(sub), 1);
            c.globalAlpha = g.opacity * opacity;
            c.globalCompositeOperation = canvasBlendOf(g.blend) as GlobalCompositeOperation;
            c.drawImage(sub, 0, 0);
          } else draw(x, c, opacity * g.opacity);
          continue;
        }
        const src = x.preview ?? x.c;
        if (!x.info.visible || !src.width || !src.height) continue;
        if (only && !only(x.info)) continue;
        c.globalAlpha = x.info.opacity * opacity;
        c.globalCompositeOperation = canvasBlendOf(x.info.blend) as GlobalCompositeOperation;
        const at = x.preview && x.previewAt ? x.previewAt : x.info;
        c.drawImage(this.drawn(x), at.x, at.y);
      }
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
    };
    draw(root, ctx2d(out), 1);
    return out;
  }

  render(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      const c = ctx2d(this.view);
      c.clearRect(0, 0, this.width, this.height);
      c.drawImage(this.composite(), 0, 0);
      const d = this.draft;
      if (d?.c.width && d.c.height) c.drawImage(d.c, d.x, d.y);
      this.drawOverlay();
    });
  }

  private drawOverlay() {
    const c = ctx2d(this.over);
    c.clearRect(0, 0, this.over.width, this.over.height);
    const px = 1 / this.zoom;
    /** A path in black and white dashes (the marching ants when `march`). */
    const ants = (path: Path2D, march = true) => {
      c.lineWidth = px;
      c.setLineDash([]);
      c.strokeStyle = "#ffffff";
      c.stroke(path);
      c.setLineDash([4 * px, 4 * px]);
      c.lineDashOffset = march ? -this.ants * px : 0;
      c.strokeStyle = "#000000";
      c.stroke(path);
      c.setLineDash([]);
      c.lineDashOffset = 0;
    };
    const poly = (pts: Pt[], close: boolean) => {
      const p = new Path2D();
      if (pts.length < 2) return p;
      p.moveTo((pts[0] as Pt)[0], (pts[0] as Pt)[1]);
      for (const q of pts.slice(1)) p.lineTo(q[0], q[1]);
      if (close) p.closePath();
      return p;
    };
    const g = this.gesture;
    // While the selection (or its pixels) is dragged, its outline goes along.
    const off =
      g?.kind === "float"
        ? [g.start[0] + g.at[0] - g.from[0], g.start[1] + g.at[1] - g.from[1]]
        : g?.kind === "outline"
          ? [g.at[0] - g.from[0], g.at[1] - g.from[1]]
          : [0, 0];
    if (this.sel && !this.xf) {
      c.save();
      if (g?.kind === "float" && this.floating?.f === g.f)
        c.translate((off[0] as number) - this.floating.dx, (off[1] as number) - this.floating.dy);
      else c.translate(off[0] as number, off[1] as number);
      ants(this.sel.path);
      c.restore();
    }
    if (g?.kind === "marquee") {
      const r = marqueeRect(g.from, g.to, g.square, g.centre);
      const p = new Path2D();
      if (g.shape === "rect")
        p.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      else p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ants(p, false);
    } else if (g?.kind === "lasso") ants(poly(g.pts, false), false);
    else if (g?.kind === "poly") {
      ants(poly(this.hover ? [...g.pts, this.hover] : g.pts, false), false);
      // The first point: clicking it closes the shape.
      const f = g.pts[0] as Pt;
      c.strokeStyle = "#000";
      c.fillStyle = "#fff";
      c.lineWidth = px;
      c.beginPath();
      c.rect(f[0] - 3 * px, f[1] - 3 * px, 6 * px, 6 * px);
      c.fill();
      c.stroke();
    } else if (g?.kind === "gradient") {
      c.lineWidth = 2 * px;
      c.strokeStyle = "#ffffff";
      c.beginPath();
      c.moveTo(g.from[0], g.from[1]);
      c.lineTo(g.to[0], g.to[1]);
      c.stroke();
      c.lineWidth = px;
      c.strokeStyle = "#000000";
      c.stroke();
    } else if (g?.kind === "shape") ants(this.shapePath(g), false);
    else if (g?.kind === "text" && this.dragged(g)) {
      // The paragraph text's box being drawn.
      const r = marqueeRect(g.from, g.to, false, false);
      const p = new Path2D();
      p.rect(r.x, r.y, r.w, r.h);
      ants(p, false);
    }
    // The crop box: the rest dimmed, its handles.
    if (this.crop) {
      const r = this.crop;
      c.fillStyle = "rgba(0, 0, 0, 0.45)";
      c.beginPath();
      c.rect(0, 0, this.width, this.height);
      c.rect(r.x, r.y, r.w, r.h);
      c.fill("evenodd");
      const p = new Path2D();
      p.rect(r.x, r.y, r.w, r.h);
      ants(p, false);
      for (const h of this.handles(this.cornersOf(r))) this.drawHandle(c, h, px);
    }
    if (this.xf) {
      const q = this.xfCorners();
      ants(poly(q, true), false);
      for (const h of this.handles(q)) this.drawHandle(c, h, px);
    }
    // The brush's outline under the pointer.
    const brushed =
      this.tool === "brush" ||
      this.tool === "pencil" ||
      this.tool === "eraser" ||
      this.tool === "clone" ||
      this.tool === "quick-select";
    if (brushed && this.hover && !this.spaceHand) {
      const r = (this.tool === "quick-select" ? this.opts.quickSize : this.brush.size) / 2;
      c.lineWidth = px;
      c.strokeStyle = "rgba(255,255,255,0.9)";
      c.beginPath();
      c.arc(this.hover[0], this.hover[1], Math.max(r, 1.5 * px), 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = "rgba(0,0,0,0.8)";
      c.beginPath();
      c.arc(this.hover[0], this.hover[1], Math.max(r + px, 2.5 * px), 0, Math.PI * 2);
      c.stroke();
    }
    if (this.tool === "clone" && this.cloneSrc) {
      const [x, y] = this.cloneSrc;
      c.lineWidth = px;
      c.strokeStyle = "#000";
      c.beginPath();
      c.moveTo(x - 6 * px, y);
      c.lineTo(x + 6 * px, y);
      c.moveTo(x, y - 6 * px);
      c.lineTo(x, y + 6 * px);
      c.stroke();
    }
    // The current layer's edges (Move).
    const l = this.currentLayer();
    // A paragraph text longer than its box: Photoshop's overflow mark in its corner.
    const lt = l?.info.text;
    if (l && lt?.box && !this.texting.active && (this.tool === "text" || this.tool === "move")) {
      const m = this.measure(lt);
      if (m.hidden) {
        const [bx, by] = textOrigin(l.info);
        const a = ((lt.rotate ?? 0) * Math.PI) / 180;
        const dx = lt.box.w / 2;
        const dy = lt.box.h / 2;
        const cx = bx + dx + dx * Math.cos(a) - dy * Math.sin(a);
        const cy = by + dy + dx * Math.sin(a) + dy * Math.cos(a);
        const r = 5 * px;
        c.lineWidth = px;
        c.fillStyle = "#ffffff";
        c.strokeStyle = "#000000";
        c.fillRect(cx - r, cy - r, 2 * r, 2 * r);
        c.strokeRect(cx - r, cy - r, 2 * r, 2 * r);
        c.beginPath();
        c.moveTo(cx - r * 0.6, cy);
        c.lineTo(cx + r * 0.6, cy);
        c.moveTo(cx, cy - r * 0.6);
        c.lineTo(cx, cy + r * 0.6);
        c.stroke();
      }
    }
    if (
      this.tool === "move" &&
      l &&
      !this.xf &&
      (l.c.width !== this.width || l.c.height !== this.height || l.info.x || l.info.y)
    ) {
      c.lineWidth = px;
      c.setLineDash([2 * px, 3 * px]);
      c.strokeStyle = "rgba(90, 160, 255, 0.9)";
      c.strokeRect(l.info.x, l.info.y, l.c.width, l.c.height);
      c.setLineDash([]);
    }
  }

  private drawHandle(c: Ctx, h: Pt, px: number) {
    c.fillStyle = "#ffffff";
    c.strokeStyle = "#000000";
    c.lineWidth = px;
    c.beginPath();
    c.rect(h[0] - HANDLE * px, h[1] - HANDLE * px, 2 * HANDLE * px, 2 * HANDLE * px);
    c.fill();
    c.stroke();
  }

  private cornersOf(r: Rect): Pt[] {
    return [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ];
  }

  /** Eight handles: the corners, then the middles of the sides (top, right, bottom, left). */
  private handles(q: Pt[]): Pt[] {
    const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const [a, b, cc, d] = q as [Pt, Pt, Pt, Pt];
    return [a, b, cc, d, mid(a, b), mid(b, cc), mid(cc, d), mid(d, a)];
  }

  private shapePath(g: {
    shape: "rect" | "ellipse" | "line";
    from: Pt;
    to: Pt;
    shift: boolean;
    alt: boolean;
  }) {
    const p = new Path2D();
    if (g.shape === "line") {
      const to = g.shift ? snap45(g.from, g.to) : g.to;
      p.moveTo(g.from[0], g.from[1]);
      p.lineTo(to[0], to[1]);
      return p;
    }
    const r = marqueeRect(g.from, g.to, g.shift, g.alt);
    if (g.shape === "rect") p.rect(r.x, r.y, r.w, r.h);
    else p.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return p;
  }

  // ---------------------------------------------------------------- the panel's view

  layerList(): IslandLayer[] {
    return [...this.layers].reverse().map((l) => {
      const t = canvas(36, 36);
      const k = Math.min(36 / Math.max(1, this.width), 36 / Math.max(1, this.height));
      const c = ctx2d(t);
      if (l.c.width && l.c.height)
        c.drawImage(l.c, l.info.x * k, l.info.y * k, l.c.width * k, l.c.height * k);
      return { ...l.info, w: l.c.width, h: l.c.height, hasMask: !!l.mask, thumb: t.toDataURL() };
    });
  }

  layerInfo(id: string | undefined): (ImageLayerInfo & { hasMask: boolean }) | undefined {
    const l = id ? this.find(id) : undefined;
    return l && { ...l.info, w: l.c.width, h: l.c.height, hasMask: !!l.mask };
  }

  setCurrent(id: string): void {
    if (id !== this.current) this.letGo();
    if (this.texting.active && this.texting.layer !== id) this.texting.commit();
    this.current = id;
    if (!this.find(id)?.mask) this.onMask = false;
    this.drawOverlay();
    this.o.onLayers();
  }

  /** Where the agent's actions are on the screen (relative to the stage), to outline them. */
  boxesOf(actions: readonly ImageAction[]): Rect[] {
    const out: Rect[] = [];
    for (const a of actions)
      for (const op of a.t === "batch" ? a.ops : [a]) {
        let r: Rect | undefined;
        if (op.t === "canvas") r = { x: 0, y: 0, w: this.width, h: this.height };
        else if (op.t === "pixels")
          r = op.mask ? undefined : { x: op.x, y: op.y, w: op.w, h: op.h };
        else if (op.t === "add") r = { x: op.layer.x, y: op.layer.y, w: op.layer.w, h: op.layer.h };
        else if (op.t === "tiles") {
          const l = this.find(op.layer);
          const ox = op.mask ? (l?.mask?.x ?? 0) : (l?.info.x ?? 0);
          const oy = op.mask ? (l?.mask?.y ?? 0) : (l?.info.y ?? 0);
          r = op.tiles
            .map((t) => ({ x: ox + t.x, y: oy + t.y, w: t.w, h: t.h }))
            .reduce(union, { x: 0, y: 0, w: 0, h: 0 });
        } else if (op.t !== "remove") {
          const l = this.find(op.layer);
          if (l) r = { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height };
        }
        const v = r && inter(r, { x: 0, y: 0, w: this.width, h: this.height });
        if (v) out.push(v);
      }
    const merged = out.length > 6 ? [out.reduce(union)] : out;
    const base = this.stage.getBoundingClientRect();
    const area = this.o.area.getBoundingClientRect();
    return merged.map((r) => ({
      x: base.left - area.left + this.o.area.scrollLeft + r.x * this.zoom,
      y: base.top - area.top + this.o.area.scrollTop + r.y * this.zoom,
      w: r.w * this.zoom,
      h: r.h * this.zoom,
    }));
  }

  // ---------------------------------------------------------------- sending the person's edits

  /** Pixels and actions made ready in order (blobs first), then sent: one gesture each. */
  private emit(make: () => Promise<ImagePlainAction[]>, what?: What, filter?: string): void {
    this.o.onBusy(++this.busy);
    this.chain = this.chain
      .then(make)
      .then(
        (acts) => {
          if (acts.length && !this.disposed) this.o.onActions(acts, what, filter);
        },
        (e: unknown) => this.o.onError((e as Error).message),
      )
      .finally(() => this.o.onBusy(--this.busy));
  }

  /** Waits for the edits being made ready (before an undo). */
  settled(): Promise<void> {
    return this.chain;
  }

  private async upload(c: C): Promise<string> {
    return this.o.upload(await toPng(c));
  }

  /** The tiles of a canvas that differ from what it held (`before`: its pixels then). */
  private async tilesOf(c: C, before: ImageData, box: Rect): Promise<ImageTile[]> {
    const out: ImageTile[] = [];
    const ctx = ctx2d(c);
    for (const t of imageTilesOf(box.x, box.y, box.w, box.h)) {
      const now = ctx.getImageData(t.x, t.y, t.w, t.h);
      const was = new Uint8ClampedArray(t.w * t.h * 4);
      for (let row = 0; row < t.h; row++) {
        const from = ((t.y - box.y + row) * box.w + (t.x - box.x)) * 4;
        was.set(before.data.subarray(from, from + t.w * 4), row * t.w * 4);
      }
      if (sameData(now.data, was)) continue;
      const tc = canvas(t.w, t.h);
      ctx2d(tc).putImageData(now, 0, 0);
      out.push({ ...t, png: await this.upload(tc) });
    }
    return out;
  }

  /** The grid-aligned box of tiles around a rectangle, inside a canvas. */
  private tileBox(r: Rect, c: C): Rect | undefined {
    const T = 256;
    const x = Math.max(0, Math.floor(r.x / T) * T);
    const y = Math.max(0, Math.floor(r.y / T) * T);
    return inter(
      { x, y, w: Math.ceil((r.x + r.w - x) / T) * T, h: Math.ceil((r.y + r.h - y) / T) * T },
      { x: 0, y: 0, w: c.width, h: c.height },
    );
  }

  /**
   * A layer that refuses the change (locked; a text layer refuses its pixels being changed, as
   * Photoshop's type layers: «Rasterizza testo» first): says so.
   */
  private refuses(l: Lay | undefined, pixels = true): l is undefined {
    if (!l) {
      this.o.onNote?.("noLayer");
      return true;
    }
    if (l.info.locked) {
      this.o.onError("locked");
      return true;
    }
    if (pixels && l.info.text && !(this.onMask && l.mask)) {
      this.o.onNote?.("textLayer");
      return true;
    }
    return false;
  }

  /**
   * A change of a layer's pixels (or mask) drawn by `draw` in the picture's coordinates over
   * `need`: tiles when the layer holds it, the whole layer grown when it does not.
   */
  private change(
    l: Lay,
    need: Rect,
    draw: (c: Ctx, ox: number, oy: number) => void,
    what: What,
  ): void {
    if (this.refuses(l)) return;
    this.letGo();
    const mask = this.onMask && l.mask ? l.mask : undefined;
    const target = mask ? mask.grey : l.c;
    const ox = mask ? mask.x : l.info.x;
    const oy = mask ? mask.y : l.info.y;
    const here = { x: ox, y: oy, w: target.width, h: target.height };
    const want = inter(need, { x: 0, y: 0, w: this.width, h: this.height });
    if (!want) return;
    if (!mask && !inside(want, here)) {
      // The layer grows to hold the change: all its pixels go.
      const r = union(here, want);
      const grown = canvas(r.w, r.h);
      const g = ctx2d(grown);
      g.drawImage(l.c, here.x - r.x, here.y - r.y);
      draw(g, r.x, r.y);
      l.c = grown;
      l.info.x = r.x;
      l.info.y = r.y;
      l.info.w = r.w;
      l.info.h = r.h;
      l.alpha = undefined;
      this.render();
      const id = l.info.id;
      this.emit(
        async () => [
          {
            t: "pixels",
            layer: id,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            png: await this.upload(grown),
            what,
          },
        ],
        what,
      );
      return;
    }
    const local = inter(
      { x: want.x - ox, y: want.y - oy, w: want.w, h: want.h },
      { x: 0, y: 0, w: target.width, h: target.height },
    );
    const box = local && this.tileBox(local, target);
    if (!box) return;
    const ctx = ctx2d(target);
    const before = ctx.getImageData(box.x, box.y, box.w, box.h);
    draw(ctx, ox, oy);
    if (mask) {
      // A mask stays grey and opaque.
      const d = ctx.getImageData(box.x, box.y, box.w, box.h);
      for (let i = 0; i < d.data.length; i += 4) {
        const a = (d.data[i + 3] as number) / 255;
        const v = Math.round((d.data[i] as number) * a);
        d.data[i] = v;
        d.data[i + 1] = v;
        d.data[i + 2] = v;
        d.data[i + 3] = 255;
      }
      ctx.putImageData(d, box.x, box.y);
    }
    l.alpha = undefined;
    this.render();
    const id = l.info.id;
    this.emit(async () => {
      const tiles = await this.tilesOf(target, before, box);
      return tiles.length
        ? [{ t: "tiles", layer: id, ...(mask && { mask: true }), tiles, what }]
        : [];
    }, what);
  }

  /** A layer's pixels at its place, grown (inside the picture) to hold `need`. */
  private placedOf(l: Lay, need?: Rect): P.Placed {
    const here = { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height };
    const want = need && inter(need, { x: 0, y: 0, w: this.width, h: this.height });
    const own: P.Placed = { x: here.x, y: here.y, px: pxOf(l.c) };
    if (!want || inside(want, here)) return own;
    const r = union(here, want);
    const out: P.Placed = { x: r.x, y: r.y, px: P.blankPx(r.w, r.h) };
    for (let y = 0; y < here.h; y++)
      out.px.data.set(
        own.px.data.subarray(y * here.w * 4, (y + 1) * here.w * 4),
        ((here.y - r.y + y) * r.w + (here.x - r.x)) * 4,
      );
    return out;
  }

  /**
   * A layer's pixels replaced by `next` (computed by `imagePx`): the tiles that differ when its
   * place and size stay, the whole layer when they change. One gesture, one action.
   */
  private replaceLayer(l: Lay, next: P.Placed, what: What, keepFloat = false): void {
    if (!keepFloat) this.letGo();
    const same =
      next.x === l.info.x &&
      next.y === l.info.y &&
      next.px.width === l.c.width &&
      next.px.height === l.c.height;
    const id = l.info.id;
    if (!same) {
      const c = canvasOf(next.px);
      l.c = c;
      l.info.x = next.x;
      l.info.y = next.y;
      l.info.w = c.width;
      l.info.h = c.height;
      l.alpha = undefined;
      this.render();
      this.emit(
        async () => [
          {
            t: "pixels",
            layer: id,
            x: next.x,
            y: next.y,
            w: c.width,
            h: c.height,
            png: c.width && c.height ? await this.upload(c) : null,
            what,
          },
        ],
        what,
      );
      return;
    }
    const { width: w, height: h } = next.px;
    if (!w || !h) return;
    const ctx = ctx2d(l.c);
    const before = ctx.getImageData(0, 0, w, h);
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(next.px.data) as Uint8ClampedArray<ArrayBuffer>, w, h),
      0,
      0,
    );
    l.alpha = undefined;
    this.render();
    const target = l.c;
    this.emit(async () => {
      const tiles = await this.tilesOf(target, before, { x: 0, y: 0, w, h });
      return tiles.length ? [{ t: "tiles", layer: id, tiles, what }] : [];
    }, what);
  }

  private currentLayer(): Lay | undefined {
    return this.current ? this.find(this.current) : undefined;
  }

  /** The Background's colour for holes and the eraser: a JPEG's bottom layer has no transparency. */
  private holeFill(l: Lay): P.RGBA | undefined {
    return this.format === "jpeg" && this.layers[0] === l
      ? P.rgbaOfHex(this.background)
      : undefined;
  }

  /** What the wand, the bucket, the eyedropper and the clone stamp look at (picture-sized). */
  private sample(): P.Px {
    if (this.opts.sampleAll) return pxOf(this.composite());
    const l = this.currentLayer();
    if (!l) return P.blankPx(this.width, this.height);
    return P.onPicture({ x: l.info.x, y: l.info.y, px: pxOf(l.c) }, this.width, this.height);
  }

  /** The Move tool's floating pixels and the crop box let go (the layer or the selection changed). */
  private letGo() {
    this.floating = undefined;
  }

  // ---------------------------------------------------------------- pointer

  private at(e: { clientX: number; clientY: number }): Pt {
    const r = this.over.getBoundingClientRect();
    return [(e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom];
  }

  private readonly down = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      const k = this.fingers.down(e.pointerId, [e.clientX, e.clientY]);
      if (k === "ignore") return;
      if (k === "pinch") {
        this.over.setPointerCapture?.(e.pointerId);
        this.dropForPinch();
        return;
      }
    }
    const p = this.at(e);
    this.hover = p;
    if (e.button === 1 || (e.button === 0 && (this.spaceHand || this.tool === "hand"))) {
      e.preventDefault();
      const a = this.o.area;
      this.gesture = {
        kind: "hand",
        x: e.clientX,
        y: e.clientY,
        sl: a.scrollLeft,
        st: a.scrollTop,
      };
      this.over.setPointerCapture?.(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    this.over.setPointerCapture?.(e.pointerId);
    if (this.xf) {
      this.xfDown(p);
      return;
    }
    const l = this.currentLayer();
    const sel = this.sel;
    const keys = { shift: e.shiftKey, alt: e.altKey };
    switch (this.tool) {
      case "brush":
      case "pencil":
      case "eraser":
      case "clone": {
        if (this.refuses(l)) return;
        if (this.tool === "clone") {
          if (e.altKey) {
            this.cloneSrc = [Math.round(p[0]), Math.round(p[1])];
            this.cloneOff = undefined;
            this.o.onNote?.("cloneSet");
            this.drawOverlay();
            return;
          }
          if (!this.cloneSrc) {
            this.o.onNote?.("cloneSource");
            return;
          }
        }
        this.o.onEditing(true);
        const hole = this.tool === "eraser" ? this.holeFill(l) : undefined;
        const erase = this.tool === "eraser" && !hole;
        const color =
          this.tool === "eraser" ? (hole ? this.background : "#000000") : this.brush.color;
        const stroke = canvas(this.width, this.height);
        const tool = this.tool;
        const g: Extract<Gesture, { kind: "paint" }> = {
          kind: "paint",
          tool,
          stroke,
          pts: [p],
          last: p,
          color,
          erase,
        };
        if (tool === "clone" && this.cloneSrc) {
          g.src = canvasOf(this.sample());
          const start: Pt = [Math.round(p[0]), Math.round(p[1])];
          const off: Pt =
            this.opts.cloneAligned && this.cloneOff
              ? this.cloneOff
              : [this.cloneSrc[0] - start[0], this.cloneSrc[1] - start[1]];
          this.cloneOff = off;
          g.off = off;
        }
        this.gesture = g;
        this.dab(stroke, p, p, g.tool, color);
        this.preview();
        return;
      }
      case "move": {
        let lay = l;
        if (this.opts.autoSelect && !sel) {
          const hit = this.layerAt(p);
          if (hit && hit !== lay) {
            this.setCurrent(hit.info.id);
            lay = hit;
          }
        }
        if (this.refuses(lay, !!sel)) return;
        this.o.onEditing(true);
        if (sel && !(this.onMask && lay.mask)) {
          this.startFloat(lay, p, e.altKey);
          return;
        }
        if (e.altKey) {
          // Alt: a copy of the layer moves (Photoshop's), the layer stays.
          const c = canvas(lay.c.width, lay.c.height);
          ctx2d(c).drawImage(lay.c, 0, 0);
          const info: ImageLayerInfo = {
            ...lay.info,
            id: newId(),
            name: this.o.label?.("copy") ?? lay.info.name,
          };
          delete info.locked;
          const dup: Lay = { info, c };
          this.place(dup, lay.info.id);
          this.current = info.id;
          this.gesture = { kind: "move", from: p, at: p, lay: dup, dup };
          this.o.onLayers();
          return;
        }
        this.gesture = { kind: "move", from: p, at: p, lay };
        return;
      }
      case "marquee-rect":
      case "marquee-ellipse":
      case "lasso": {
        const { mode, byKeys } = selModeOf(this.opts.selMode, keys, !!sel);
        // Dragging inside the selection with a selection tool moves its outline (Photoshop's).
        if (sel && mode === "new" && P.inSel(sel.mask, p[0], p[1])) {
          this.gesture = { kind: "outline", from: p, at: p };
          return;
        }
        if (this.tool === "lasso") this.gesture = { kind: "lasso", pts: [p], mode };
        else
          this.gesture = {
            kind: "marquee",
            shape: this.tool === "marquee-rect" ? "rect" : "ellipse",
            from: p,
            to: p,
            mode,
            byKeys,
            square: false,
            centre: false,
          };
        return;
      }
      case "lasso-poly":
      case "lasso-magnetic": {
        const g = this.gesture;
        if (g?.kind === "poly") {
          const first = g.pts[0] as Pt;
          if (g.pts.length > 2 && Math.hypot(p[0] - first[0], p[1] - first[1]) * this.zoom < 8)
            this.closePoly();
          else g.pts.push(g.magnetic ? this.snapEdge(g, p) : p);
          this.drawOverlay();
          return;
        }
        const { mode } = selModeOf(this.opts.selMode, keys, !!sel);
        const magnetic = this.tool === "lasso-magnetic";
        const ng: Extract<Gesture, { kind: "poly" }> = {
          kind: "poly",
          pts: [],
          mode,
          magnetic,
        };
        if (magnetic) ng.grad = this.edgeMap();
        ng.pts.push(magnetic ? this.snapEdge(ng, p) : p);
        this.gesture = ng;
        this.drawOverlay();
        return;
      }
      case "quick-select": {
        const mode: P.SelMode = e.altKey ? "subtract" : sel ? "add" : "new";
        const acc = P.emptySel(this.width, this.height);
        if (sel && mode !== "new") acc.a.set(sel.mask.a);
        const g = { kind: "quick" as const, mode, sample: this.sample(), acc, last: p };
        this.gesture = g;
        this.quickAt(g, p);
        return;
      }
      case "wand": {
        const { mode } = selModeOf(this.opts.selMode, keys, !!sel);
        const o = this.opts;
        this.applySel(
          mode,
          P.wandSel(this.sample(), p[0], p[1], o.tolerance, o.contiguous, o.antialias),
        );
        return;
      }
      case "crop": {
        const c = this.crop;
        let how = "new";
        if (c) {
          const hs = this.handles(this.cornersOf(c));
          const tol = (HANDLE + 3) / this.zoom;
          const i = hs.findIndex(
            (h) => Math.abs(h[0] - p[0]) <= tol && Math.abs(h[1] - p[1]) <= tol,
          );
          if (i >= 0) how = `h${i}`;
          else if (p[0] > c.x && p[1] > c.y && p[0] < c.x + c.w && p[1] < c.y + c.h) how = "move";
        }
        this.gesture = { kind: "crop", from: p, start: c && { ...c }, how };
        return;
      }
      case "eyedropper": {
        const g = { kind: "eyedrop" as const, bg: e.altKey, sample: this.sample() };
        this.gesture = g;
        this.pick(g, p);
        return;
      }
      case "gradient":
        if (this.refuses(l)) return;
        this.gesture = { kind: "gradient", from: p, to: p };
        return;
      case "bucket":
        this.bucket(p);
        return;
      case "shape-rect":
      case "shape-ellipse":
      case "shape-line":
        this.gesture = {
          kind: "shape",
          shape:
            this.tool === "shape-rect"
              ? "rect"
              : this.tool === "shape-ellipse"
                ? "ellipse"
                : "line",
          from: p,
          to: p,
          shift: false,
          alt: false,
        };
        return;
      case "text":
        // A click away from the text being typed commits it (Photoshop's).
        if (this.texting.active) {
          this.texting.commit();
          return;
        }
        this.preloadFonts();
        this.gesture = { kind: "text", from: p, to: p, hit: this.textAt(p) };
        return;
      case "zoom":
        this.zoomAt(e.altKey || this.altHeld ? -1 : 1, p);
        return;
      case "hand":
        return;
    }
  };

  private readonly moveEv = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      const step = this.fingers.move(e.pointerId, [e.clientX, e.clientY]);
      if (this.fingers.active) {
        if (step) this.pinchBy(step.factor, step.mid, step.pan);
        return;
      }
    }
    const p = this.at(e);
    this.hover = p;
    const g = this.gesture;
    if (!g) {
      if (
        this.tool === "brush" ||
        this.tool === "pencil" ||
        this.tool === "eraser" ||
        this.tool === "clone" ||
        this.tool === "quick-select"
      )
        this.drawOverlay();
      return;
    }
    switch (g.kind) {
      case "hand": {
        const a = this.o.area;
        a.scrollLeft = g.sl - (e.clientX - g.x);
        a.scrollTop = g.st - (e.clientY - g.y);
        return;
      }
      case "paint":
        this.dab(g.stroke, g.last, p, g.tool, g.color);
        g.last = p;
        g.pts.push(p);
        this.preview();
        return;
      case "float":
      case "outline": {
        const at: Pt = [
          g.from[0] + Math.round(p[0] - g.from[0]),
          g.from[1] + Math.round(p[1] - g.from[1]),
        ];
        if (at[0] === g.at[0] && at[1] === g.at[1]) return;
        g.at = at;
        if (g.kind === "float") this.floatPreview(g);
        else this.drawOverlay();
        return;
      }
      case "move": {
        const dx = Math.round(p[0] - g.at[0]);
        const dy = Math.round(p[1] - g.at[1]);
        if (!dx && !dy) return;
        g.at = [g.at[0] + dx, g.at[1] + dy];
        g.lay.info.x += dx;
        g.lay.info.y += dy;
        if (g.lay.mask) {
          g.lay.mask.x += dx;
          g.lay.mask.y += dy;
        }
        this.render();
        return;
      }
      case "marquee":
        g.to = p;
        g.square = e.shiftKey && !g.byKeys;
        g.centre = e.altKey && !g.byKeys;
        this.drawOverlay();
        return;
      case "lasso":
        g.pts.push(p);
        this.drawOverlay();
        return;
      case "poly":
        if (g.magnetic) {
          const last = g.pts[g.pts.length - 1] as Pt;
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= Math.max(4, 10 / this.zoom))
            g.pts.push(this.snapEdge(g, p));
        }
        this.drawOverlay();
        return;
      case "quick": {
        const r = this.opts.quickSize / 2;
        if (Math.hypot(p[0] - g.last[0], p[1] - g.last[1]) < Math.max(1, r / 3)) return;
        g.last = p;
        this.quickAt(g, p);
        return;
      }
      case "crop":
        this.cropMove(g, p, e.shiftKey, e.altKey);
        return;
      case "eyedrop":
        this.pick(g, p);
        return;
      case "gradient":
        g.to = e.shiftKey ? snap45(g.from, p) : p;
        this.drawOverlay();
        return;
      case "shape":
        g.to = p;
        g.shift = e.shiftKey;
        g.alt = e.altKey;
        this.drawOverlay();
        return;
      case "xform":
        this.xfMove(g, p, e.shiftKey, e.altKey);
        return;
      case "text":
        g.to = p;
        this.drawOverlay();
        return;
    }
  };

  private readonly leave = () => {
    this.hover = undefined;
    if (!this.gesture) this.drawOverlay();
  };

  private readonly dbl = (e: MouseEvent) => {
    // A double click on a text layer (Move or Type) types in it again.
    if ((this.tool === "move" || this.tool === "text") && !this.xf && !this.texting.active) {
      const p = this.at(e);
      const hit = this.textAt(p);
      if (hit) {
        this.editText(hit.info.id, p);
        return;
      }
    }
    if (this.gesture?.kind === "poly") this.closePoly();
    else if (this.xf) this.commitTransform();
    else if (this.crop) this.applyCrop();
  };

  private readonly up = (e?: PointerEvent) => {
    if (e?.pointerType === "touch" && this.fingers.up(e.pointerId)) return;
    const g = this.gesture;
    if (!g || g.kind === "poly") return;
    this.gesture = undefined;
    switch (g.kind) {
      case "paint":
        this.endPaint(g);
        return;
      case "float":
        this.endFloat(g);
        return;
      case "outline":
        this.setSel(
          this.sel && P.shiftSel(this.sel.mask, g.at[0] - g.from[0], g.at[1] - g.from[1]),
        );
        return;
      case "move": {
        const l = g.lay;
        const dx = Math.round(g.at[0] - g.from[0]);
        const dy = Math.round(g.at[1] - g.from[1]);
        this.o.onEditing(false);
        if (g.dup) {
          const dup = g.dup;
          const above = this.layers[this.layers.indexOf(dup) - 1]?.info.id ?? null;
          this.emit(
            async () => [
              {
                t: "add",
                layer: { ...dup.info, w: dup.c.width, h: dup.c.height },
                above,
                png: dup.c.width && dup.c.height ? await this.upload(dup.c) : null,
                mask: null,
              },
            ],
            "transform",
          );
        } else if (dx || dy) {
          this.letGo();
          const set = { x: l.info.x, y: l.info.y };
          this.emit(async () => [{ t: "props", layer: l.info.id, set }], "transform");
        }
        return;
      }
      case "marquee": {
        const r = marqueeRect(g.from, g.to, g.square, g.centre);
        if (r.w < 1 || r.h < 1) {
          if (g.mode === "new") this.setSel(undefined);
          else this.drawOverlay();
          return;
        }
        const m =
          g.shape === "rect"
            ? P.selOfRect(this.width, this.height, r)
            : P.selOfEllipse(this.width, this.height, r, this.opts.antialias);
        this.applySel(g.mode, P.featherSel(m, this.opts.feather));
        return;
      }
      case "lasso": {
        if (g.pts.length < 3) {
          if (g.mode === "new") this.setSel(undefined);
          else this.drawOverlay();
          return;
        }
        const m = P.selOfPolys(this.width, this.height, [g.pts.flat()], this.opts.antialias);
        this.applySel(g.mode, P.featherSel(m, this.opts.feather));
        return;
      }
      case "quick":
        this.setSel(P.selBounds(g.acc) ? g.acc : undefined);
        return;
      case "crop":
        if (this.crop && (this.crop.w < 2 || this.crop.h < 2)) this.crop = undefined;
        this.o.onCrop?.(this.crop);
        this.drawOverlay();
        return;
      case "gradient":
        this.applyGradient(g.from, g.to);
        this.drawOverlay();
        return;
      case "shape":
        this.addShape(g);
        return;
      case "hand":
      case "eyedrop":
      case "xform":
        this.drawOverlay();
        return;
      case "text": {
        this.drawOverlay();
        // On a text: the caret where it was clicked, or what the drag covered selected.
        if (g.hit) {
          const moved = Math.hypot(g.to[0] - g.from[0], g.to[1] - g.from[1]) * this.zoom >= 4;
          this.editText(g.hit.info.id, g.from, moved ? g.to : undefined);
        } else if (this.dragged(g)) {
          const r = marqueeRect(g.from, g.to, false, false);
          this.newText(r.x, r.y, {
            w: Math.max(1, Math.round(r.w)),
            h: Math.max(1, Math.round(r.h)),
          });
        } else this.newText(g.from[0], g.from[1]);
        return;
      }
    }
  };

  /**
   * A second finger came (3.5.11): what the first began is given up with nothing changed (a
   * stroke's preview dropped, a layer put back), as the pinch is not an edit.
   */
  private dropForPinch() {
    const g = this.gesture;
    if (!g || g.kind === "poly") return;
    if (g.kind === "move" || g.kind === "float" || g.kind === "outline") {
      if (g.kind === "move") {
        const dx = g.at[0] - g.from[0];
        const dy = g.at[1] - g.from[1];
        g.lay.info.x -= dx;
        g.lay.info.y -= dy;
        if (g.lay.mask) {
          g.lay.mask.x -= dx;
          g.lay.mask.y -= dy;
        }
      }
      g.at = [g.from[0], g.from[1]];
      if (g.kind === "float") this.floatPreview(g);
      this.up();
      this.render();
      return;
    }
    this.gesture = undefined;
    if (g.kind === "paint") {
      const l = this.currentLayer();
      if (l) {
        l.preview = undefined;
        l.previewAt = undefined;
      }
      this.o.onEditing(false);
      this.render();
    }
    this.drawOverlay();
  }

  /** Two fingers: zoom by `factor` around `mid` (on screen) and pan by `pan`. */
  private pinchBy(factor: number, mid: Fingertip, pan: Fingertip) {
    const area = this.o.area;
    const z0 = this.zoom;
    const before = this.over.getBoundingClientRect();
    // The picture's point under the fingers, to keep there after the zoom.
    const pic: Pt = [(mid[0] - pan[0] - before.left) / z0, (mid[1] - pan[1] - before.top) / z0];
    const z1 = this.setZoom(z0 * factor);
    const after = this.over.getBoundingClientRect();
    area.scrollLeft += after.left + pic[0] * z1 - mid[0];
    area.scrollTop += after.top + pic[1] * z1 - mid[1];
  }

  private readonly wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
    e.preventDefault();
    this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  /** The topmost visible layer with a pixel under the point (Move's auto-select). */
  private layerAt(p: Pt): Lay | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i] as Lay;
      if (!l.info.visible || l.info.groups?.some((g) => !g.visible)) continue;
      const x = Math.floor(p[0] - l.info.x);
      const y = Math.floor(p[1] - l.info.y);
      if (x < 0 || y < 0 || x >= l.c.width || y >= l.c.height) continue;
      if ((ctx2d(this.drawn(l)).getImageData(x, y, 1, 1).data[3] as number) > 0) return l;
    }
    return undefined;
  }

  private pick(g: { bg: boolean; sample: P.Px }, p: Pt) {
    const x = Math.floor(p[0]);
    const y = Math.floor(p[1]);
    if (x < 0 || y < 0 || x >= g.sample.width || y >= g.sample.height) return;
    const i = (y * g.sample.width + x) * 4;
    const d = g.sample.data;
    this.o.onPick(
      hexOf(d[i] as number, d[i + 1] as number, d[i + 2] as number),
      g.bg ? "bg" : "fg",
    );
  }

  private boundsOf(pts: Pt[], pad: number): Rect {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.floor(Math.min(...xs) - pad);
    const y = Math.floor(Math.min(...ys) - pad);
    return {
      x,
      y,
      w: Math.ceil(Math.max(...xs) + pad) - x,
      h: Math.ceil(Math.max(...ys) + pad) - y,
    };
  }

  // ---------------------------------------------------------------- brushes

  /** One segment of a stroke: round dabs (softer with a lower hardness, by the flow), or the pencil's hard pixels. */
  private dab(stroke: C, a: Pt, b: Pt, tool: string, color: string) {
    const c = ctx2d(stroke);
    const r = Math.max(0.5, this.brush.size / 2);
    c.save();
    c.fillStyle = color;
    c.strokeStyle = color;
    if (tool === "pencil") {
      // Whole pixels, no soft edge (Photoshop's pencil).
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let i = 0; i <= steps; i++) {
        const x = a[0] + ((b[0] - a[0]) * i) / steps;
        const y = a[1] + ((b[1] - a[1]) * i) / steps;
        if (r <= 0.75) {
          c.fillRect(Math.floor(x), Math.floor(y), 1, 1);
          continue;
        }
        for (let py = Math.floor(y - r); py <= Math.ceil(y + r); py++) {
          const dy = py + 0.5 - y;
          if (Math.abs(dy) > r) continue;
          const half = Math.sqrt(r * r - dy * dy);
          const x0 = Math.ceil(x - half - 0.5);
          const x1 = Math.floor(x + half - 0.5);
          if (x1 >= x0) c.fillRect(x0, py, x1 - x0 + 1, 1);
        }
      }
      c.restore();
      return;
    }
    const flow = Math.max(0.01, Math.min(1, this.brush.flow));
    if (this.brush.hardness >= 0.99 && flow >= 0.999) {
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = r * 2;
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0] + 0.01, b[1]);
      c.stroke();
      c.restore();
      return;
    }
    const spacing = Math.max(1, r / 4);
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing));
    c.globalAlpha = flow;
    for (let i = a === b ? 0 : 1; i <= steps; i++) {
      const x = a[0] + ((b[0] - a[0]) * i) / steps;
      const y = a[1] + ((b[1] - a[1]) * i) / steps;
      if (this.brush.hardness >= 0.99) c.fillStyle = color;
      else {
        const gr = c.createRadialGradient(x, y, r * this.brush.hardness, x, y, r);
        gr.addColorStop(0, color);
        gr.addColorStop(1, `${color}00`);
        c.fillStyle = gr;
      }
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /** What a paint stroke adds, picture-sized (the stroke, or the clone stamp's pixels through it). */
  private strokeLayer(g: Extract<Gesture, { kind: "paint" }>): C {
    const s = canvas(this.width, this.height);
    const sc = ctx2d(s);
    if (g.tool === "clone" && g.src && g.off) {
      sc.drawImage(g.src, -g.off[0], -g.off[1]);
      sc.globalCompositeOperation = "destination-in";
    }
    sc.globalAlpha = this.brush.opacity;
    sc.drawImage(g.stroke, 0, 0);
    sc.globalAlpha = 1;
    sc.globalCompositeOperation = "source-over";
    if (this.sel) {
      sc.globalCompositeOperation = "destination-in";
      sc.drawImage(this.selAlpha(), 0, 0);
      sc.globalCompositeOperation = "source-over";
    }
    return s;
  }

  /** The stroke drawn over the current layer, as it will be (opacity, selection, eraser). */
  private preview() {
    const g = this.gesture;
    const l = this.currentLayer();
    if (g?.kind !== "paint" || !l) return;
    if (this.onMask && l.mask) {
      this.render();
      return;
    }
    const s = this.strokeLayer(g);
    const q = canvas(this.width, this.height);
    const qc = ctx2d(q);
    qc.drawImage(l.c, l.info.x, l.info.y);
    qc.globalCompositeOperation = g.erase ? "destination-out" : "source-over";
    qc.drawImage(s, 0, 0);
    l.preview = q;
    l.previewAt = { x: 0, y: 0 };
    this.render();
  }

  private endPaint(g: Extract<Gesture, { kind: "paint" }>) {
    const l = this.currentLayer();
    this.o.onEditing(false);
    if (!l) return;
    l.preview = undefined;
    l.previewAt = undefined;
    const r = this.boundsOf(g.pts, this.brush.size / 2 + 2);
    if (g.tool === "clone") {
      // Exact: the source's pixels through the strokes' coverage (imagePx.stampThrough).
      const cover = this.strokeLayer({ ...g, tool: "brush" });
      const a = ctx2d(cover).getImageData(0, 0, this.width, this.height).data;
      const sel = P.emptySel(this.width, this.height);
      for (let i = 0; i < sel.a.length; i++) sel.a[i] = a[i * 4 + 3] as number;
      const placed = this.placedOf(l, r);
      P.stampThrough(placed, pxOf(g.src as C), g.off as Pt, sel, 1);
      this.replaceLayer(l, placed, "paint");
      return;
    }
    const s = this.strokeLayer(g);
    const onMask = this.onMask && !!l.mask;
    const erase = g.erase;
    this.change(
      l,
      r,
      (c, ox, oy) => {
        c.save();
        if (onMask) {
          // On a mask the brush shows (its colour's lightness), the eraser hides.
          const v = erase ? 0 : greyOfCss(g.color);
          const tinted = canvas(this.width, this.height);
          const t = ctx2d(tinted);
          t.drawImage(s, 0, 0);
          t.globalCompositeOperation = "source-in";
          t.fillStyle = `rgb(${v},${v},${v})`;
          t.fillRect(0, 0, this.width, this.height);
          c.drawImage(tinted, -ox, -oy);
        } else {
          c.globalCompositeOperation = erase ? "destination-out" : "source-over";
          c.drawImage(s, -ox, -oy);
        }
        c.restore();
      },
      erase && !onMask ? "erase" : "paint",
    );
  }

  // ---------------------------------------------------------------- the Move tool's pixels

  /** The floating pixels of the current layer (held after a drop, or cut now). */
  private floatOf(l: Lay, copy: boolean): { f: P.Floating; dx: number; dy: number } | undefined {
    const sel = this.sel;
    if (!sel) return undefined;
    const fl = this.floating;
    if (fl && fl.lay === l && !copy) return fl;
    this.letGo();
    return {
      f: P.float({ x: l.info.x, y: l.info.y, px: pxOf(l.c) }, sel.mask, copy, this.holeFill(l)),
      dx: 0,
      dy: 0,
    };
  }

  private startFloat(l: Lay, p: Pt, copy: boolean) {
    const fl = this.floatOf(l, copy);
    if (!fl) return;
    const f = fl.f;
    const holedPx = P.copyPlaced(f.base);
    if (!f.copy) P.clearThrough(holedPx, f.sel, f.fill);
    const holed = canvas(this.width, this.height);
    ctx2d(holed).drawImage(canvasOf(holedPx.px), holedPx.x, holedPx.y);
    this.gesture = {
      kind: "float",
      from: p,
      at: p,
      lay: l,
      f,
      start: [fl.dx, fl.dy],
      holed,
      piece: canvasOf(f.piece),
    };
  }

  private floatPreview(g: Extract<Gesture, { kind: "float" }>) {
    const q = canvas(this.width, this.height);
    const qc = ctx2d(q);
    qc.drawImage(g.holed, 0, 0);
    qc.drawImage(g.piece, g.start[0] + g.at[0] - g.from[0], g.start[1] + g.at[1] - g.from[1]);
    g.lay.preview = q;
    g.lay.previewAt = { x: 0, y: 0 };
    this.render();
  }

  private endFloat(g: Extract<Gesture, { kind: "float" }>) {
    const l = g.lay;
    l.preview = undefined;
    l.previewAt = undefined;
    this.o.onEditing(false);
    const dx = g.start[0] + g.at[0] - g.from[0];
    const dy = g.start[1] + g.at[1] - g.from[1];
    const held = this.floating?.f === g.f;
    if (held && dx === g.start[0] && dy === g.start[1]) {
      this.render();
      return;
    }
    if (!held && !g.f.copy && !dx && !dy) {
      this.render();
      return;
    }
    this.dropFloat(l, g.f, dx, dy);
  }

  /** The floating pixels put down at (dx, dy) from their cut: one change, still held. */
  private dropFloat(l: Lay, f: P.Floating, dx: number, dy: number) {
    this.replaceLayer(l, P.floatAt(f, dx, dy), "transform", true);
    this.floating = { lay: l, f, dx, dy };
    this.setSel(P.shiftSel(f.sel, dx, dy), true);
  }

  /** The arrow keys: Move nudges the layer or its selected pixels, a selection tool the outline. */
  nudge(dx: number, dy: number): void {
    if (this.xf) {
      this.xf.m.tx += dx;
      this.xf.m.ty += dy;
      this.renderXf();
      return;
    }
    if (this.tool !== "move") {
      if (this.sel) this.setSel(P.shiftSel(this.sel.mask, dx, dy));
      return;
    }
    const l = this.currentLayer();
    if (this.refuses(l, !!this.sel)) return;
    if (this.sel && !(this.onMask && l.mask)) {
      const fl = this.floatOf(l, false);
      if (fl) this.dropFloat(l, fl.f, fl.dx + dx, fl.dy + dy);
      return;
    }
    l.info.x += dx;
    l.info.y += dy;
    if (l.mask) {
      l.mask.x += dx;
      l.mask.y += dy;
    }
    this.render();
    const set = { x: l.info.x, y: l.info.y };
    this.emit(async () => [{ t: "props", layer: l.info.id, set }], "transform");
  }

  // ---------------------------------------------------------------- selections

  /** The selection's coverage as a canvas's alpha (for the brushes and masks), made once. */
  private selAlpha(): C {
    const s = this.sel as NonNullable<typeof this.sel>;
    if (s.alpha) return s.alpha;
    const c = canvas(this.width, this.height);
    const img = new ImageData(this.width, this.height);
    for (let i = 0; i < s.mask.a.length; i++) img.data[i * 4 + 3] = s.mask.a[i] as number;
    ctx2d(c).putImageData(img, 0, 0);
    s.alpha = c;
    return c;
  }

  /** The selection now (undefined: none), its outline drawn as marching ants. */
  private setSel(mask: P.Sel | undefined, keepFloat = false) {
    if (!keepFloat) this.letGo();
    const box = mask && P.selBounds(mask);
    if (!mask || !box) {
      if (this.sel) this.lastSel = this.sel.mask;
      this.sel = undefined;
      if (this.antsTimer) clearInterval(this.antsTimer);
      this.antsTimer = undefined;
      this.o.onSelection(undefined);
      this.drawOverlay();
      return;
    }
    const segs = P.selOutline(mask);
    const path = new Path2D();
    for (let i = 0; i + 3 < segs.length; i += 4) {
      path.moveTo(segs[i] as number, segs[i + 1] as number);
      path.lineTo(segs[i + 2] as number, segs[i + 3] as number);
    }
    this.sel = { mask, path, box };
    // Less motion asked for (p3.5.11): the ants stay dashed, still.
    if (!this.antsTimer && !reducedMotion())
      this.antsTimer = setInterval(() => {
        if (this.disposed || !this.sel) return;
        this.ants = (this.ants + 1) % 8;
        if (!this.gesture || this.gesture.kind === "hand") this.drawOverlay();
      }, 140);
    this.o.onSelection(box);
    this.drawOverlay();
  }

  /** A new selection combined with the one there is (Photoshop's modes). */
  private applySel(mode: P.SelMode, next: P.Sel) {
    this.setSel(P.combineSel(mode, this.sel?.mask, next));
  }

  private quickAt(g: Extract<Gesture, { kind: "quick" }>, p: Pt) {
    const region = P.quickSel(
      g.sample,
      p[0],
      p[1],
      this.opts.quickSize / 2,
      this.opts.tolerance,
      P.emptySel(this.width, this.height),
    );
    const a = g.acc.a;
    const b = region.a;
    if (g.mode === "subtract") {
      for (let i = 0; i < a.length; i++)
        if (b[i]) a[i] = Math.round(((a[i] as number) * (255 - (b[i] as number))) / 255);
    } else
      for (let i = 0; i < a.length; i++)
        if ((b[i] as number) > (a[i] as number)) a[i] = b[i] as number;
    this.setSel(P.selBounds(g.acc) ? g.acc : undefined);
  }

  /** The polygonal or magnetic lasso closed: its selection. */
  closePoly(): void {
    const g = this.gesture;
    if (g?.kind !== "poly") return;
    this.gesture = undefined;
    if (g.pts.length < 3) {
      this.drawOverlay();
      return;
    }
    const m = P.selOfPolys(this.width, this.height, [g.pts.flat()], this.opts.antialias);
    this.applySel(g.mode, P.featherSel(m, this.opts.feather));
  }

  /** The polygon under way given up (another tool picked). */
  cancelPolygon(): void {
    if (this.gesture?.kind !== "poly") return;
    this.gesture = undefined;
    this.drawOverlay();
  }

  /** The polygonal lasso's last point taken back (Backspace). */
  polyBack(): boolean {
    const g = this.gesture;
    if (g?.kind !== "poly") return false;
    g.pts.pop();
    if (!g.pts.length) this.gesture = undefined;
    this.drawOverlay();
    return true;
  }

  /** Esc: the gesture under way, the crop or the free transform given up. */
  cancel(): boolean {
    if (this.gesture?.kind === "poly") {
      this.gesture = undefined;
      this.drawOverlay();
      return true;
    }
    if (this.xf) {
      this.cancelTransform();
      return true;
    }
    if (this.crop) {
      this.crop = undefined;
      this.o.onCrop?.(undefined);
      this.drawOverlay();
      return true;
    }
    return false;
  }

  /** Enter: the polygon closed, the crop or the transform applied. */
  commit(): boolean {
    if (this.gesture?.kind === "poly") {
      this.closePoly();
      return true;
    }
    if (this.xf) {
      this.commitTransform();
      return true;
    }
    if (this.crop) {
      this.applyCrop();
      return true;
    }
    return false;
  }

  /** How strong the edges are at each pixel (the composite's lightness, Sobel), for the magnetic lasso. */
  private edgeMap(): Float32Array {
    const { width: w, height: h, data: d } = pxOf(this.composite());
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++)
      lum[i] =
        ((0.2126 * (d[i * 4] as number) +
          0.7152 * (d[i * 4 + 1] as number) +
          0.0722 * (d[i * 4 + 2] as number)) *
          (d[i * 4 + 3] as number)) /
        255;
    const out = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const L = (k: number) => lum[k] as number;
        const gx =
          L(i - w + 1) + 2 * L(i + 1) + L(i + w + 1) - L(i - w - 1) - 2 * L(i - 1) - L(i + w - 1);
        const gy =
          L(i + w - 1) + 2 * L(i + w) + L(i + w + 1) - L(i - w - 1) - 2 * L(i - w) - L(i - w + 1);
        out[i] = Math.hypot(gx, gy);
      }
    return out;
  }

  /** A point moved to the strongest edge near it (the magnetic lasso's width, 8 pixels). */
  private snapEdge(g: { grad?: Float32Array }, p: Pt): Pt {
    const m = g.grad;
    if (!m) return p;
    const R = 8;
    let best = 40;
    let at: Pt = p;
    const cx = Math.round(p[0]);
    const cy = Math.round(p[1]);
    for (let y = cy - R; y <= cy + R; y++)
      for (let x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        // Nearer edges count more: the pointer still guides.
        const v =
          (m[y * this.width + x] as number) * (1 - Math.hypot(x - p[0], y - p[1]) / (R * 2));
        if (v > best) {
          best = v;
          at = [x + 0.5, y + 0.5];
        }
      }
    return at;
  }

  selectAll(): void {
    this.setSel(
      P.selOfRect(this.width, this.height, { x: 0, y: 0, w: this.width, h: this.height }),
    );
  }

  selectNone(): void {
    this.setSel(undefined);
  }

  /** The last selection let go, back (Ctrl+Shift+D). */
  reselect(): void {
    if (this.lastSel && this.lastSel.width === this.width && this.lastSel.height === this.height)
      this.setSel(this.lastSel);
  }

  invertSelection(): void {
    if (!this.sel) {
      this.selectAll();
      return;
    }
    this.setSel(P.invertSel(this.sel.mask));
  }

  get selection(): Rect | undefined {
    return this.sel?.box;
  }

  /** The selection (or the whole picture) filled with a colour on the current layer or mask, or cleared. */
  fillSelection(color: string, clear = false): void {
    const l = this.currentLayer();
    if (this.refuses(l)) return;
    if (clear && !this.sel) {
      this.o.onNote?.("nothingSelected");
      return;
    }
    if (!(this.onMask && l.mask)) {
      // Pixels: exact (imagePx); a Background's hole takes its colour.
      const box = this.sel?.box ?? { x: 0, y: 0, w: this.width, h: this.height };
      const placed = this.placedOf(l, clear ? undefined : box);
      if (clear)
        P.clearThrough(placed, (this.sel as NonNullable<typeof this.sel>).mask, this.holeFill(l));
      else P.fillThrough(placed, this.sel?.mask, P.rgbaOfHex(color));
      this.replaceLayer(l, placed, clear ? "clear" : "fill");
      return;
    }
    const shape = canvas(this.width, this.height);
    const c = ctx2d(shape);
    c.fillStyle = "#000";
    c.fillRect(0, 0, this.width, this.height);
    if (this.sel) {
      c.globalCompositeOperation = "destination-in";
      c.drawImage(this.selAlpha(), 0, 0);
    }
    const box = this.sel?.box ?? { x: 0, y: 0, w: this.width, h: this.height };
    const v = clear ? 0 : greyOfCss(color);
    this.change(
      l,
      box,
      (ctx, ox, oy) => {
        ctx.save();
        const t = canvas(this.width, this.height);
        const tc = ctx2d(t);
        tc.drawImage(shape, 0, 0);
        tc.globalCompositeOperation = "source-in";
        tc.fillStyle = `rgb(${v},${v},${v})`;
        tc.fillRect(0, 0, this.width, this.height);
        ctx.drawImage(t, -ox, -oy);
        ctx.restore();
      },
      clear ? "clear" : "fill",
    );
  }

  /** Layer via Copy (Ctrl+J): the selected pixels as a new layer above, or the layer copied. */
  layerViaCopy(name: string): void {
    const l = this.currentLayer();
    if (!l) return;
    if (!this.sel) {
      this.duplicateLayer(name);
      return;
    }
    const f = P.float({ x: l.info.x, y: l.info.y, px: pxOf(l.c) }, this.sel.mask, true);
    const b = this.sel.box;
    const c = canvas(b.w, b.h);
    ctx2d(c).drawImage(canvasOf(f.piece), -b.x, -b.y);
    const info: ImageLayerInfo = {
      id: newId(),
      name,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
      ...(l.info.groups?.length && { groups: l.info.groups }),
    };
    this.place({ info, c }, l.info.id);
    this.current = info.id;
    this.letGo();
    this.render();
    this.o.onLayers();
    const above = l.info.id;
    this.emit(async () => [
      { t: "add", layer: { ...info }, above, png: await this.upload(c), mask: null },
    ]);
  }

  // ---------------------------------------------------------------- bucket, gradient, shapes, crop

  private bucket(p: Pt) {
    const l = this.currentLayer();
    if (this.refuses(l)) return;
    const o = this.opts;
    let area: P.Sel | undefined = P.wandSel(this.sample(), p[0], p[1], o.tolerance, o.contiguous);
    if (this.sel) area = P.combineSel("intersect", this.sel.mask, area);
    const box = area && P.selBounds(area);
    if (!area || !box) return;
    const placed = this.placedOf(l, box);
    P.fillThrough(placed, area, P.rgbaOfHex(this.brush.color), this.brush.opacity);
    this.replaceLayer(l, placed, "fill");
  }

  private applyGradient(from: Pt, to: Pt) {
    const l = this.currentLayer();
    if (this.refuses(l)) return;
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1) return;
    const fg = P.rgbaOfHex(this.brush.color);
    const placed = this.placedOf(l, this.sel?.box ?? { x: 0, y: 0, w: this.width, h: this.height });
    P.gradientThrough(placed, this.sel?.mask, {
      from,
      to,
      kind: this.opts.gradient,
      c0: fg,
      c1: this.opts.gradientTransparent ? [fg[0], fg[1], fg[2], 0] : P.rgbaOfHex(this.background),
      reverse: this.opts.gradientReverse,
      opacity: this.brush.opacity,
    });
    this.replaceLayer(l, placed, "fill");
  }

  private addShape(g: Extract<Gesture, { kind: "shape" }>) {
    const sw = Math.max(1, this.opts.shapeStroke);
    const line = g.shape === "line";
    const to = line && g.shift ? snap45(g.from, g.to) : g.to;
    const r = line
      ? this.boundsOf([g.from, to], sw / 2 + 2)
      : (() => {
          const m = marqueeRect(g.from, g.to, g.shift, g.alt);
          const pad = this.opts.shapeFill ? 1 : sw / 2 + 1;
          return this.boundsOf(
            [
              [m.x, m.y],
              [m.x + m.w, m.y + m.h],
            ],
            pad,
          );
        })();
    const m = marqueeRect(g.from, g.to, g.shift, g.alt);
    if (line ? Math.hypot(to[0] - g.from[0], to[1] - g.from[1]) < 1 : m.w < 1 || m.h < 1) {
      this.drawOverlay();
      return;
    }
    const c = canvas(r.w, r.h);
    const x = ctx2d(c);
    x.translate(-r.x, -r.y);
    x.fillStyle = this.brush.color;
    x.strokeStyle = this.brush.color;
    x.lineWidth = sw;
    x.lineCap = "round";
    x.beginPath();
    if (line) {
      x.moveTo(g.from[0], g.from[1]);
      x.lineTo(to[0], to[1]);
      x.stroke();
    } else {
      if (g.shape === "rect") x.rect(m.x, m.y, m.w, m.h);
      else x.ellipse(m.x + m.w / 2, m.y + m.h / 2, m.w / 2, m.h / 2, 0, 0, Math.PI * 2);
      if (this.opts.shapeFill) x.fill();
      else x.stroke();
    }
    const cur = this.currentLayer();
    const info: ImageLayerInfo = {
      id: newId(),
      name: this.o.label?.(`shape-${g.shape}` as "shape-rect") ?? g.shape,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
      ...(cur?.info.groups?.length && { groups: cur.info.groups }),
    };
    const above = cur?.info.id ?? this.layers.at(-1)?.info.id ?? null;
    this.place({ info, c }, above);
    this.current = info.id;
    this.render();
    this.o.onLayers();
    this.emit(async () => [
      { t: "add", layer: { ...info }, above, png: await this.upload(c), mask: null },
    ]);
  }

  private cropMove(g: Extract<Gesture, { kind: "crop" }>, p: Pt, shift: boolean, alt: boolean) {
    const s = g.start;
    const dx = p[0] - g.from[0];
    const dy = p[1] - g.from[1];
    let r: Rect;
    if (g.how === "new" || !s) r = marqueeRect(g.from, p, shift, alt);
    else if (g.how === "move") r = { ...s, x: s.x + dx, y: s.y + dy };
    else {
      const i = Number(g.how.slice(1));
      // Corners 0-3 (top left clockwise), sides 4-7 (top, right, bottom, left).
      let x0 = s.x;
      let y0 = s.y;
      let x1 = s.x + s.w;
      let y1 = s.y + s.h;
      if (i === 0 || i === 3 || i === 7) x0 += dx;
      if (i === 1 || i === 2 || i === 5) x1 += dx;
      if (i === 0 || i === 1 || i === 4) y0 += dy;
      if (i === 2 || i === 3 || i === 6) y1 += dy;
      r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    }
    this.crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    this.drawOverlay();
  }

  /** The crop box applied (Enter): the picture's size and place, layers kept. */
  applyCrop(): void {
    const c = this.crop;
    this.crop = undefined;
    this.o.onCrop?.(undefined);
    if (!c || c.w < 1 || c.h < 1) {
      this.drawOverlay();
      return;
    }
    this.setCanvas(c.w, c.h, -c.x, -c.y);
  }

  /** The crop box set to the selection (the options bar's button, or Image > Crop). */
  cropBox(r: Rect | undefined): void {
    this.crop = r && { ...r };
    this.o.onCrop?.(this.crop);
    this.drawOverlay();
  }

  // ---------------------------------------------------------------- free transform

  /** Ctrl+T: the selected pixels (or the whole layer) in a box with handles. */
  freeTransform(): void {
    if (this.xf) return;
    const l = this.currentLayer();
    if (this.refuses(l, false) || !l.c.width || !l.c.height) return;
    this.texting.commit();
    // A text layer is transformed whole (it stays text), whatever is selected.
    if (this.sel && !(this.onMask && l.mask) && !l.info.text) {
      const fl = this.floatOf(l, false);
      if (!fl) return;
      this.xf = {
        lay: l,
        src: canvasOf(fl.f.piece),
        box: fl.f.box,
        f: fl.f,
        m: { tx: fl.dx, ty: fl.dy, sx: 1, sy: 1, rot: 0 },
      };
    } else
      this.xf = {
        lay: l,
        src: l.c,
        box: { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height },
        m: { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 },
      };
    this.o.onTransform?.(true);
    this.renderXf();
  }

  get transforming(): boolean {
    return !!this.xf;
  }

  private xfCorners(xf = this.xf as NonNullable<typeof this.xf>): Pt[] {
    const b = xf.box;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const { tx, ty, sx, sy, rot } = xf.m;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return this.cornersOf(b).map(([px, py]): Pt => {
      const x = (px - cx) * sx;
      const y = (py - cy) * sy;
      return [cx + tx + x * cos - y * sin, cy + ty + x * sin + y * cos];
    });
  }

  private xfDown(p: Pt) {
    const xf = this.xf as NonNullable<typeof this.xf>;
    const q = this.xfCorners();
    const tol = (HANDLE + 3) / this.zoom;
    const i = this.handles(q).findIndex(
      (h) => Math.abs(h[0] - p[0]) <= tol && Math.abs(h[1] - p[1]) <= tol,
    );
    let how = i >= 0 ? `h${i}` : "rotate";
    if (i < 0) {
      // Inside the box: move it.
      const fill = new Path2D();
      fill.moveTo((q[0] as Pt)[0], (q[0] as Pt)[1]);
      for (const c of q.slice(1)) fill.lineTo(c[0], c[1]);
      fill.closePath();
      if (ctx2d(this.over).isPointInPath(fill, p[0], p[1])) how = "move";
    }
    this.gesture = { kind: "xform", how, from: p, start: { ...xf.m } };
  }

  private xfMove(g: Extract<Gesture, { kind: "xform" }>, p: Pt, shift: boolean, alt: boolean) {
    const xf = this.xf;
    if (!xf) return;
    const s = g.start;
    const b = xf.box;
    const m: Xform = { ...s };
    const cc: Pt = [b.x + b.w / 2 + s.tx, b.y + b.h / 2 + s.ty];
    if (g.how === "move") {
      m.tx = s.tx + Math.round(p[0] - g.from[0]);
      m.ty = s.ty + Math.round(p[1] - g.from[1]);
    } else if (g.how === "rotate") {
      const a0 = Math.atan2(g.from[1] - cc[1], g.from[0] - cc[0]);
      const a1 = Math.atan2(p[1] - cc[1], p[0] - cc[0]);
      m.rot = s.rot + a1 - a0;
      if (shift) m.rot = Math.round(m.rot / (Math.PI / 12)) * (Math.PI / 12);
    } else {
      const i = Number(g.how.slice(1));
      const ux = [-1, 1, 1, -1, 0, 1, 0, -1][i] as number;
      const uy = [-1, -1, 1, 1, -1, 0, 1, 0][i] as number;
      // The pointer in the box's own axes (unrotated, from its centre).
      const cos = Math.cos(s.rot);
      const sin = Math.sin(s.rot);
      const vx = p[0] - cc[0];
      const vy = p[1] - cc[1];
      const lx = vx * cos + vy * sin;
      const ly = -vx * sin + vy * cos;
      const hw = (b.w / 2) * s.sx;
      const hh = (b.h / 2) * s.sy;
      // From the opposite side (Alt: from the centre).
      const ax = alt ? 0 : -ux * hw;
      const ay = alt ? 0 : -uy * hh;
      let sx = s.sx;
      let sy = s.sy;
      if (ux) sx = (lx - ax) / (alt ? ux * (b.w / 2) : ux * b.w);
      if (uy) sy = (ly - ay) / (alt ? uy * (b.h / 2) : uy * b.h);
      // Corners keep the proportions (Photoshop's default), Shift lets them go.
      if (ux && uy && !shift) {
        const k = (sx / s.sx + sy / s.sy) / 2;
        sx = s.sx * k;
        sy = s.sy * k;
      }
      if (Math.abs(sx) < 0.01) sx = 0.01 * Math.sign(sx || 1);
      if (Math.abs(sy) < 0.01) sy = 0.01 * Math.sign(sy || 1);
      m.sx = sx;
      m.sy = sy;
      if (!alt) {
        // The opposite side stays put: the centre moves.
        const ncx = ux ? ax + (ux * b.w * sx) / 2 : 0;
        const ncy = uy ? ay + (uy * b.h * sy) / 2 : 0;
        m.tx = s.tx + ncx * cos - ncy * sin;
        m.ty = s.ty + ncx * sin + ncy * cos;
      }
    }
    xf.m = m;
    this.renderXf();
  }

  /** Draws `src` transformed into a context whose origin is the picture's (0, 0). */
  private drawXf(c: Ctx, src: C, at: Pt, xf = this.xf as NonNullable<typeof this.xf>) {
    const b = xf.box;
    const m = xf.m;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    c.save();
    c.imageSmoothingQuality = "high";
    c.translate(cx + m.tx, cy + m.ty);
    c.rotate(m.rot);
    c.scale(m.sx, m.sy);
    c.translate(-cx, -cy);
    c.drawImage(src, at[0], at[1]);
    c.restore();
  }

  private renderXf() {
    const xf = this.xf;
    if (!xf) return;
    const q = canvas(this.width, this.height);
    const qc = ctx2d(q);
    if (xf.f) {
      const h = P.copyPlaced(xf.f.base);
      P.clearThrough(h, xf.f.sel, xf.f.fill);
      qc.drawImage(canvasOf(h.px), h.x, h.y);
      this.drawXf(qc, xf.src, [0, 0]);
    } else this.drawXf(qc, xf.src, [xf.box.x, xf.box.y]);
    xf.lay.preview = q;
    xf.lay.previewAt = { x: 0, y: 0 };
    this.render();
  }

  commitTransform(): void {
    const xf = this.xf;
    if (!xf) return;
    this.xf = undefined;
    const l = xf.lay;
    l.preview = undefined;
    l.previewAt = undefined;
    this.o.onTransform?.(false);
    const m = xf.m;
    if (m.sx === 1 && m.sy === 1 && !m.rot && !m.tx && !m.ty) {
      this.render();
      return;
    }
    const q = this.xfCorners(xf);
    const xs = q.map((p) => p[0]);
    const ys = q.map((p) => p[1]);
    const tb = {
      x: Math.floor(Math.min(...xs)),
      y: Math.floor(Math.min(...ys)),
      w: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
      h: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
    };
    if (xf.f) {
      const f = xf.f;
      const h = P.copyPlaced(f.base);
      P.clearThrough(h, f.sel, f.fill);
      const land = inter(tb, { x: 0, y: 0, w: this.width, h: this.height });
      const r = land
        ? union({ x: h.x, y: h.y, w: h.px.width, h: h.px.height }, land)
        : { x: h.x, y: h.y, w: h.px.width, h: h.px.height };
      const c = canvas(r.w, r.h);
      const cc = ctx2d(c);
      cc.drawImage(canvasOf(h.px), h.x - r.x, h.y - r.y);
      cc.save();
      cc.beginPath();
      cc.rect(-r.x, -r.y, this.width, this.height);
      cc.clip();
      cc.translate(-r.x, -r.y);
      this.drawXf(cc, xf.src, [0, 0], xf);
      // The selection goes along.
      const sa = canvas(this.width, this.height);
      const img = new ImageData(this.width, this.height);
      for (let i = 0; i < f.sel.a.length; i++) img.data[i * 4 + 3] = f.sel.a[i] as number;
      const plain = canvas(this.width, this.height);
      ctx2d(plain).putImageData(img, 0, 0);
      this.drawXf(ctx2d(sa), plain, [0, 0], xf);
      cc.restore();
      this.replaceLayer(l, { x: r.x, y: r.y, px: pxOf(c) }, "transform");
      const a = ctx2d(sa).getImageData(0, 0, this.width, this.height).data;
      const ns = P.emptySel(this.width, this.height);
      for (let i = 0; i < ns.a.length; i++) ns.a[i] = a[i * 4 + 3] as number;
      this.setSel(ns);
      return;
    }
    const text = l.info.text;
    if (text && m.sx > 0 && m.sy > 0) {
      // A text layer stays text: its size follows the scale, its turn is kept (p3.5.8).
      const b = xf.box;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const next = scaledText(text, m.sx, m.sy, (m.rot * 180) / Math.PI);
      const [bx, by] = textOrigin(l.info);
      const was = this.measure(text);
      const now = this.measure(next);
      const x = (bx + was.w / 2 - cx) * m.sx;
      const y = (by + was.h / 2 - cy) * m.sy;
      const cos = Math.cos(m.rot);
      const sin = Math.sin(m.rot);
      const nx = cx + m.tx + x * cos - y * sin;
      const ny = cy + m.ty + x * sin + y * cos;
      this.textReplace(l, next, nx - now.w / 2, ny - now.h / 2, "transform");
      return;
    }
    const c = canvas(tb.w, tb.h);
    const cc = ctx2d(c);
    cc.translate(-tb.x, -tb.y);
    this.drawXf(cc, xf.src, [xf.box.x, xf.box.y], xf);
    // A flip makes a text layer plain pixels (stated, in the same gesture).
    if (text) this.rasterizeNow(l);
    this.replaceLayer(l, { x: tb.x, y: tb.y, px: pxOf(c) }, "transform");
  }

  cancelTransform(): void {
    const xf = this.xf;
    if (!xf) return;
    this.xf = undefined;
    xf.lay.preview = undefined;
    xf.lay.previewAt = undefined;
    this.o.onTransform?.(false);
    this.render();
  }

  // ---------------------------------------------------------------- filters

  /** A filter shown on the current layer (in the selection), not applied yet. */
  previewFilter(id: string, params: Record<string, number>): void {
    const l = this.currentLayer();
    if (!l?.c.width || !l.c.height) return;
    l.preview = this.filtered(l, id, params);
    l.previewAt = undefined;
    this.filterPreview = { id, layer: l.info.id };
    this.render();
  }

  cancelFilter(): void {
    const f = this.filterPreview;
    this.filterPreview = undefined;
    const l = f && this.find(f.layer);
    if (l) l.preview = undefined;
    this.render();
  }

  private filtered(l: Lay, id: string, params: Record<string, number>): C {
    const w = l.c.width;
    const h = l.c.height;
    const src = ctx2d(l.c).getImageData(0, 0, w, h);
    const out = runImageFilter(id, src.data, w, h, params);
    const sel = this.sel?.mask;
    if (sel) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const px = l.info.x + x;
          const py = l.info.y + y;
          const k =
            px < 0 || py < 0 || px >= sel.width || py >= sel.height
              ? 0
              : (sel.a[py * sel.width + px] as number) / 255;
          if (k >= 1) continue;
          const i = (y * w + x) * 4;
          for (let c = 0; c < 4; c++)
            out[i + c] = Math.round(
              (src.data[i + c] as number) * (1 - k) + (out[i + c] as number) * k,
            );
        }
    }
    const c = canvas(w, h);
    ctx2d(c).putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    return c;
  }

  applyFilter(id: string, params: Record<string, number>): void {
    const l = this.currentLayer();
    this.filterPreview = undefined;
    if (!l?.c.width || !l.c.height) return;
    if (this.refuses(l)) return;
    this.letGo();
    const f = this.filtered(l, id, params);
    l.preview = undefined;
    const ctx = ctx2d(l.c);
    const box = { x: 0, y: 0, w: l.c.width, h: l.c.height };
    const before = ctx.getImageData(0, 0, box.w, box.h);
    ctx.clearRect(0, 0, box.w, box.h);
    ctx.drawImage(f, 0, 0);
    this.render();
    const target = l.c;
    const lid = l.info.id;
    this.emit(
      async () => {
        const tiles = await this.tilesOf(target, before, box);
        return tiles.length ? [{ t: "tiles", layer: lid, tiles, what: "filter" }] : [];
      },
      "filter",
      id,
    );
  }

  // ---------------------------------------------------------------- layers

  addLayer(name: string): void {
    const c = canvas(this.width, this.height);
    const info: ImageLayerInfo = {
      id: newId(),
      name,
      x: 0,
      y: 0,
      w: this.width,
      h: this.height,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
    };
    const cur = this.currentLayer();
    if (cur?.info.groups?.length) info.groups = cur.info.groups;
    const above = cur?.info.id ?? this.layers.at(-1)?.info.id ?? null;
    this.place({ info, c }, above);
    this.current = info.id;
    this.render();
    this.o.onLayers();
    // A new empty layer travels without pixels.
    this.emit(async () => [{ t: "add", layer: { ...info }, above, png: null, mask: null }]);
  }

  duplicateLayer(name: string): void {
    const l = this.currentLayer();
    if (!l) return;
    const c = canvas(l.c.width, l.c.height);
    ctx2d(c).drawImage(l.c, 0, 0);
    const info: ImageLayerInfo = { ...l.info, id: newId(), name };
    delete info.locked;
    const mask = l.mask && {
      ...l.mask,
      grey: (() => {
        const g = canvas(l.mask.grey.width, l.mask.grey.height);
        ctx2d(g).drawImage(l.mask.grey, 0, 0);
        return g;
      })(),
    };
    this.place({ info, c, ...(mask && { mask }) }, l.info.id);
    this.current = info.id;
    this.render();
    this.o.onLayers();
    const above = l.info.id;
    this.emit(async () => [
      {
        t: "add",
        layer: { ...info },
        above,
        png: c.width && c.height ? await this.upload(c) : null,
        mask: mask
          ? {
              x: mask.x,
              y: mask.y,
              w: mask.grey.width,
              h: mask.grey.height,
              outside: mask.outside,
              png: await this.upload(mask.grey),
            }
          : null,
      },
    ]);
  }

  deleteLayer(): void {
    this.letGo();
    const l = this.currentLayer();
    if (!l) return;
    const i = this.layers.indexOf(l);
    this.layers = this.layers.filter((x) => x !== l);
    this.current = (this.layers[i - 1] ?? this.layers[i] ?? this.layers.at(-1))?.info.id;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    this.emit(async () => [{ t: "remove", layer: id }]);
  }

  /** The current layer one step up (+1) or down (-1) in the stack. */
  stepLayer(dir: 1 | -1): void {
    const l = this.currentLayer();
    if (!l) return;
    const i = this.layers.indexOf(l);
    const j = i + dir;
    if (j < 0 || j >= this.layers.length) return;
    const above =
      dir > 0
        ? (this.layers[j] as Lay).info.id
        : j > 0
          ? (this.layers[j - 1] as Lay).info.id
          : null;
    this.place(l, above);
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    this.emit(async () => [{ t: "move", layer: id, above }]);
  }

  setProps(id: string, set: Extract<ImagePlainAction, { t: "props" }>["set"]): void {
    const l = this.find(id);
    if (!l) return;
    Object.assign(l.info, set);
    if (set.locked === false) delete l.info.locked;
    this.render();
    this.o.onLayers();
    this.emit(async () => [{ t: "props", layer: id, set }]);
  }

  mergeDown(): void {
    this.letGo();
    const l = this.currentLayer();
    if (!l) return;
    const i = this.layers.indexOf(l);
    const below = this.layers[i - 1];
    if (!below) return;
    if (below.info.locked) {
      this.o.onError("locked");
      return;
    }
    const r = union(
      { x: below.info.x, y: below.info.y, w: below.c.width, h: below.c.height },
      { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height },
    );
    const c = canvas(r.w, r.h);
    const g = ctx2d(c);
    g.drawImage(this.drawn(below), below.info.x - r.x, below.info.y - r.y);
    if (l.info.visible) {
      g.globalAlpha = l.info.opacity;
      g.globalCompositeOperation = canvasBlendOf(l.info.blend) as GlobalCompositeOperation;
      g.drawImage(this.drawn(l), l.info.x - r.x, l.info.y - r.y);
    }
    const hadMask = !!below.mask;
    // A text layer under it becomes plain pixels (Photoshop's merge rasterizes it).
    const wasText = !!below.info.text;
    below.c = c;
    below.info = { ...below.info, x: r.x, y: r.y, w: r.w, h: r.h };
    delete below.info.text;
    delete below.mask;
    below.alpha = undefined;
    this.layers = this.layers.filter((x) => x !== l);
    this.current = below.info.id;
    this.render();
    this.o.onLayers();
    const bid = below.info.id;
    const lid = l.info.id;
    this.emit(async () => [
      ...(wasText ? [{ t: "props" as const, layer: bid, set: { text: null } }] : []),
      {
        t: "pixels",
        layer: bid,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        png: await this.upload(c),
        what: "other",
      },
      ...(hadMask
        ? [{ t: "pixels" as const, layer: bid, mask: true, x: 0, y: 0, w: 0, h: 0, png: null }]
        : []),
      { t: "remove", layer: lid },
    ]);
  }

  // ---------------------------------------------------------------- masks

  addMask(): void {
    const l = this.currentLayer();
    if (!l || l.mask) return;
    const r =
      l.c.width && l.c.height
        ? { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height }
        : { x: 0, y: 0, w: this.width, h: this.height };
    const grey = canvas(r.w, r.h);
    const g = ctx2d(grey);
    g.fillStyle = this.sel ? "#000" : "#fff";
    g.fillRect(0, 0, r.w, r.h);
    if (this.sel) {
      // White where the selection is.
      const t = canvas(this.width, this.height);
      const tc = ctx2d(t);
      tc.drawImage(this.selAlpha(), 0, 0);
      tc.globalCompositeOperation = "source-in";
      tc.fillStyle = "#fff";
      tc.fillRect(0, 0, this.width, this.height);
      g.drawImage(t, -r.x, -r.y);
    }
    const outside = this.sel ? 0 : 255;
    l.mask = { x: r.x, y: r.y, outside, grey };
    l.alpha = undefined;
    this.onMask = true;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    this.emit(
      async () => [
        {
          t: "pixels",
          layer: id,
          mask: true,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          png: await this.upload(grey),
          outside,
        },
      ],
      undefined,
    );
  }

  deleteMask(): void {
    const l = this.currentLayer();
    if (!l?.mask) return;
    delete l.mask;
    l.alpha = undefined;
    this.onMask = false;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    this.emit(async () => [
      { t: "pixels", layer: id, mask: true, x: 0, y: 0, w: 0, h: 0, png: null },
    ]);
  }

  applyMask(): void {
    this.letGo();
    const l = this.currentLayer();
    if (!l?.mask) return;
    if (l.info.locked) {
      this.o.onError("locked");
      return;
    }
    const c = this.drawn(l);
    l.c = c;
    delete l.mask;
    l.alpha = undefined;
    this.onMask = false;
    const wasText = !!l.info.text;
    delete l.info.text;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    const { x, y } = l.info;
    this.emit(async () => [
      ...(wasText ? [{ t: "props" as const, layer: id, set: { text: null } }] : []),
      {
        t: "pixels",
        layer: id,
        x,
        y,
        w: c.width,
        h: c.height,
        png: c.width && c.height ? await this.upload(c) : null,
        what: "other",
      },
      { t: "pixels", layer: id, mask: true, x: 0, y: 0, w: 0, h: 0, png: null },
    ]);
  }

  // ---------------------------------------------------------------- transforms and the canvas

  /** The current layer scaled (percent), rotated (degrees) and flipped around its centre. */
  transform(scale: number, angle: number, flipH: boolean, flipV: boolean): void {
    this.letGo();
    const l = this.currentLayer();
    if (!l?.c.width || !l.c.height) return;
    if (l.info.locked) {
      this.o.onError("locked");
      return;
    }
    const sx = (scale / 100) * (flipH ? -1 : 1);
    const sy = (scale / 100) * (flipV ? -1 : 1);
    const t = (angle * Math.PI) / 180;
    if (l.info.text && !flipH && !flipV) {
      // A text layer stays text: drawn again at its new size and turn, around its centre.
      const next = scaledText(l.info.text, sx, sy, angle);
      const lx = l.info.x + l.c.width / 2;
      const ly = l.info.y + l.c.height / 2;
      const [bx, by] = textOrigin(l.info);
      const was = this.measure(l.info.text);
      const now = this.measure(next);
      const ux = (bx + was.w / 2 - lx) * sx;
      const uy = (by + was.h / 2 - ly) * sy;
      const ncx = lx + ux * Math.cos(t) - uy * Math.sin(t);
      const ncy = ly + ux * Math.sin(t) + uy * Math.cos(t);
      this.textReplace(l, next, ncx - now.w / 2, ncy - now.h / 2, "transform");
      return;
    }
    const wasText = !!l.info.text;
    const cx = l.info.x + l.c.width / 2;
    const cy = l.info.y + l.c.height / 2;
    const map = (u: number, v: number): [number, number] => {
      const x = (u - cx) * sx;
      const y = (v - cy) * sy;
      return [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)];
    };
    const draw = (src: C, ox: number, oy: number, fill?: string) => {
      const pts = [
        map(ox, oy),
        map(ox + src.width, oy),
        map(ox, oy + src.height),
        map(ox + src.width, oy + src.height),
      ];
      const nx = Math.floor(Math.min(...pts.map((p) => p[0])) + 1e-6);
      const ny = Math.floor(Math.min(...pts.map((p) => p[1])) + 1e-6);
      const nw = Math.ceil(Math.max(...pts.map((p) => p[0])) - 1e-6) - nx;
      const nh = Math.ceil(Math.max(...pts.map((p) => p[1])) - 1e-6) - ny;
      const out = canvas(Math.max(0, nw), Math.max(0, nh));
      const c = ctx2d(out);
      if (fill) {
        c.fillStyle = fill;
        c.fillRect(0, 0, out.width, out.height);
      }
      c.imageSmoothingQuality = "high";
      c.translate(cx - nx, cy - ny);
      c.rotate(t);
      c.scale(sx, sy);
      c.drawImage(src, ox - cx, oy - cy);
      return { c: out, x: nx, y: ny };
    };
    const r = draw(l.c, l.info.x, l.info.y);
    l.c = r.c;
    l.info = { ...l.info, x: r.x, y: r.y, w: r.c.width, h: r.c.height };
    delete l.info.text;
    let mr: ReturnType<typeof draw> | undefined;
    if (l.mask) {
      const o = l.mask.outside;
      mr = draw(l.mask.grey, l.mask.x, l.mask.y, `rgb(${o},${o},${o})`);
      l.mask = { ...l.mask, x: mr.x, y: mr.y, grey: mr.c };
    }
    l.alpha = undefined;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    const outside = l.mask?.outside;
    this.emit(
      async () => [
        ...(wasText ? [{ t: "props" as const, layer: id, set: { text: null } }] : []),
        {
          t: "pixels",
          layer: id,
          x: r.x,
          y: r.y,
          w: r.c.width,
          h: r.c.height,
          png: r.c.width && r.c.height ? await this.upload(r.c) : null,
          what: "transform",
        },
        ...(mr
          ? [
              {
                t: "pixels" as const,
                layer: id,
                mask: true,
                x: mr.x,
                y: mr.y,
                w: mr.c.width,
                h: mr.c.height,
                png: await this.upload(mr.c),
                outside: outside ?? 0,
              },
            ]
          : []),
      ],
      "transform",
    );
  }

  /** The picture's size: crop (to the selection) or canvas size (anchored), layers kept. */
  setCanvas(width: number, height: number, dx: number, dy: number): void {
    this.letGo();
    const a: ImagePlainAction = {
      t: "canvas",
      width: Math.round(width),
      height: Math.round(height),
      dx: Math.round(dx),
      dy: Math.round(dy),
    };
    void this.applyRemote(a).then(() => {
      this.render();
      this.o.onLayers();
    });
    this.emit(async () => [a]);
  }

  cropToSelection(): void {
    const b = this.sel?.box;
    if (!b) return;
    this.setCanvas(Math.ceil(b.w), Math.ceil(b.h), -Math.floor(b.x), -Math.floor(b.y));
  }

  /** Every layer scaled to a new picture size. */
  scaleImage(width: number, height: number): void {
    this.letGo();
    const kx = width / this.width;
    const ky = height / this.height;
    if (this.layers.some((l) => l.info.locked)) {
      this.o.onError("locked");
      return;
    }
    const acts: (() => Promise<ImagePlainAction>)[] = [];
    const scale = (src: C, x: number, y: number, fill?: string) => {
      const nx = Math.floor(x * kx);
      const ny = Math.floor(y * ky);
      const out = canvas(
        Math.max(1, Math.round((x + src.width) * kx) - nx),
        Math.max(1, Math.round((y + src.height) * ky) - ny),
      );
      const c = ctx2d(out);
      if (fill) {
        c.fillStyle = fill;
        c.fillRect(0, 0, out.width, out.height);
      }
      c.imageSmoothingQuality = "high";
      c.drawImage(src, x * kx - nx, y * ky - ny, src.width * kx, src.height * ky);
      return { c: out, x: nx, y: ny };
    };
    for (const l of this.layers) {
      const font = l.info.text && this.fontNow(l.info.text);
      if (l.info.text && font) {
        // A text layer is drawn again at the new scale (it stays text).
        const [bx, by] = textOrigin(l.info);
        const out = textLayer(font, scaledText(l.info.text, kx, ky), bx * kx, by * ky);
        const c = canvasOf(out.px);
        l.c = c;
        l.info = { ...l.info, x: out.x, y: out.y, w: c.width, h: c.height, text: out.text };
        const id = l.info.id;
        const text = out.text;
        acts.push(async () => ({ t: "props", layer: id, set: { text } }));
        acts.push(async () => ({
          t: "pixels",
          layer: id,
          x: out.x,
          y: out.y,
          w: c.width,
          h: c.height,
          png: c.width && c.height ? await this.upload(c) : null,
          what: "transform",
        }));
      } else if (l.c.width && l.c.height) {
        if (l.info.text) {
          // Its font is not here: it becomes plain pixels, said in the same change.
          const id = l.info.id;
          delete l.info.text;
          acts.push(async () => ({ t: "props", layer: id, set: { text: null } }));
        }
        const r = scale(l.c, l.info.x, l.info.y);
        l.c = r.c;
        l.info = { ...l.info, x: r.x, y: r.y, w: r.c.width, h: r.c.height };
        const id = l.info.id;
        acts.push(async () => ({
          t: "pixels",
          layer: id,
          x: r.x,
          y: r.y,
          w: r.c.width,
          h: r.c.height,
          png: await this.upload(r.c),
          what: "transform",
        }));
      }
      if (l.mask) {
        const o = l.mask.outside;
        const r = scale(l.mask.grey, l.mask.x, l.mask.y, `rgb(${o},${o},${o})`);
        l.mask = { ...l.mask, x: r.x, y: r.y, grey: r.c };
        const id = l.info.id;
        acts.push(async () => ({
          t: "pixels",
          layer: id,
          mask: true,
          x: r.x,
          y: r.y,
          w: r.c.width,
          h: r.c.height,
          png: await this.upload(r.c),
          outside: o,
        }));
      }
      l.alpha = undefined;
    }
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.setSel(undefined);
    this.resize();
    this.render();
    this.o.onLayers();
    const w = this.width;
    const h = this.height;
    this.emit(async () => {
      const out: ImagePlainAction[] = [];
      for (const a of acts) out.push(await a());
      out.push({ t: "canvas", width: w, height: h, dx: 0, dy: 0 });
      return out;
    }, "transform");
  }

  // ---------------------------------------------------------------- text (p3.5.8)

  /** The font of a text, when it has arrived. */
  private fontNow(t: Pick<ImageText, "font" | "bold" | "italic">): Font | undefined {
    return this.fonts.get(textFontFile(t.font, t.bold, t.italic));
  }

  /** The font of a text from the server (once), also given to the page's text area. */
  private loadFont(t: Pick<ImageText, "font" | "bold" | "italic">): Promise<Font | undefined> {
    const file = textFontFile(t.font, t.bold, t.italic);
    const have = this.fontsComing.get(file);
    if (have) return have;
    const p = this.o.font(file).then(
      async (bytes) => {
        const f = readTrueType(bytes);
        this.fonts.set(file, f);
        if (typeof FontFace !== "undefined" && typeof document !== "undefined")
          try {
            const face = new FontFace(`RG ${t.font}`, bytes.slice().buffer as ArrayBuffer, {
              weight: t.bold ? "700" : "400",
              style: t.italic ? "italic" : "normal",
            });
            await face.load();
            document.fonts.add(face);
          } catch {
            // The text area keeps Arial's metrics; the letters are ours anyway.
          }
        return f;
      },
      () => {
        this.fontsComing.delete(file);
        return undefined;
      },
    );
    this.fontsComing.set(file, p);
    return p;
  }

  /**
   * The four files of some families on their way (the new text's family when none is given: the
   * Text tool chosen, a picture with text layers).
   */
  preloadFonts(families: readonly string[] = [this.textLook.font]): void {
    for (const font of new Set(families))
      for (const bold of [false, true])
        for (const italic of [false, true]) void this.loadFont({ font, bold, italic });
  }

  /** Every family's regular file (the font menu shows each name in its own font). */
  preloadMenu(): Promise<unknown> {
    return Promise.all(
      TEXT_FONTS.map((f) => this.loadFont({ font: f.id, bold: false, italic: false })),
    );
  }

  /** A text's box in the picture's pixels (its font's lines; a guess until it has arrived). */
  private measure(t: ImageText): { w: number; h: number; hidden?: number } {
    const font = this.fontNow(t);
    if (font) {
      const l = layoutText(font, t);
      return { w: l.w, h: l.h, hidden: l.hidden };
    }
    const lines = t.text.split(/\r\n|\r|\n/);
    const step = t.size * t.lineHeight;
    if (t.box) return { w: t.box.w, h: t.box.h };
    return {
      w: Math.max(0, ...lines.map((l) => l.length * t.size * 0.55)),
      h: lines.length * step,
    };
  }

  /** The topmost visible text layer whose box or pixels hold the point. */
  private textAt(p: Pt): Lay | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i] as Lay;
      const t = l.info.text;
      if (!t || !l.info.visible || l.info.groups?.some((g) => !g.visible)) continue;
      const [bx, by] = textOrigin(l.info);
      const m = this.measure(t);
      const boxes = [
        { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height },
        ...(t.rotate ? [] : [{ x: bx, y: by, w: m.w, h: m.h }]),
      ];
      if (boxes.some((r) => p[0] >= r.x && p[1] >= r.y && p[0] < r.x + r.w && p[1] < r.y + r.h))
        return l;
    }
    return undefined;
  }

  private dragged(g: { from: Pt; to: Pt }): boolean {
    return (
      Math.abs(g.to[0] - g.from[0]) * this.zoom >= 6 &&
      Math.abs(g.to[1] - g.from[1]) * this.zoom >= 6
    );
  }

  /** Whether the person is typing on the picture. */
  get typing(): boolean {
    return this.texting.active;
  }

  /** A new text: point text with its first baseline at (x, y), or paragraph text in `box`. */
  newText(x: number, y: number, box?: { w: number; h: number }): void {
    const spec: ImageText = {
      ...DEFAULT_TEXT,
      ...this.textLook,
      color: this.brush.color,
      text: "",
      ox: 0,
      oy: 0,
      ...(box && { box }),
    };
    let by = y;
    if (!box) {
      // Photoshop's point text: the click is on the first line's baseline.
      const font = this.fontNow(spec);
      const step = spec.size * spec.lineHeight;
      by = font
        ? y - layoutText(font, { ...spec, text: "x" }).ascent
        : y - ((step - 1.117 * spec.size) / 2 + 0.905 * spec.size);
    }
    this.texting.open({ spec, bx: x, by });
    this.o.onTextEditing?.(true, spec);
  }

  /**
   * Typing in a text layer again (a click or double click on it, its T in the panel); with a
   * point, the caret goes to the character there (a drag to `to` selects what it covers, mapped
   * by the same lines the text is drawn with); false: not a text.
   */
  editText(id: string, at?: Pt, to?: Pt): boolean {
    const l = this.find(id);
    const t = l?.info.text;
    if (!l || !t) return false;
    if (l.info.locked) {
      this.o.onError("locked");
      return false;
    }
    if (this.current !== id) this.setCurrent(id);
    this.preloadFonts([t.font]);
    const [bx, by] = textOrigin(l.info);
    const font = this.fontNow(t);
    const index = (p: Pt) => {
      const box = this.measure(t);
      const [x, y] = textPointIn(t, box, bx, by, p[0], p[1]);
      return textIndexAt(font as Font, t, x, y);
    };
    const sel: number | [number, number] | undefined =
      font && at ? (to ? [index(at), index(to)] : index(at)) : undefined;
    this.texting.open({ layer: id, spec: { ...t }, bx, by }, sel);
    this.o.onTextEditing?.(true, { ...t });
    return true;
  }

  /** The options bar changed while typing: the whole text takes it (its colour too). */
  setTextSpec(o: Partial<ImageText>): void {
    this.texting.setSpec(o);
  }

  /** Typing ends, the text kept (a tool change, a layer chosen, the editor closing). */
  endText(): void {
    this.texting.commit();
  }

  private textLive(st: TextEditOpen): void {
    const font = this.fontNow(st.spec);
    this.texting.live = !!font;
    this.texting.restyle();
    if (!font) {
      void this.loadFont(st.spec).then((f) => {
        const now = this.texting.state;
        if (f && now) this.textLive(now);
      });
      return;
    }
    const r = renderText(font, st.spec, st.bx, st.by);
    const c = canvasOf(r.px);
    const l = st.layer ? this.find(st.layer) : undefined;
    if (l) {
      l.preview = c;
      l.previewAt = { x: r.x, y: r.y };
    } else this.draft = { c, x: r.x, y: r.y };
    this.render();
  }

  private textCancel(id: string | undefined): void {
    const l = id ? this.find(id) : undefined;
    if (l) {
      l.preview = undefined;
      l.previewAt = undefined;
    }
    this.draft = undefined;
    this.render();
    this.o.onTextEditing?.(false);
  }

  private textCommit(r: TextEditResult): void {
    const font = this.fontNow(r.spec);
    if (!font) {
      void this.loadFont(r.spec).then((f) => {
        if (f) this.textCommit(r);
        else this.o.onError("font");
      });
      return;
    }
    this.draft = undefined;
    this.o.onTextEditing?.(false);
    const l = r.layer ? this.find(r.layer) : undefined;
    if (l) {
      l.preview = undefined;
      l.previewAt = undefined;
      // A text emptied goes away with its layer (Photoshop's).
      if (!r.spec.text.trim()) {
        this.current = l.info.id;
        this.deleteLayer();
        return;
      }
      const was = l.info.text;
      const name = was && l.info.name === firstLine(was.text) ? firstLine(r.spec.text) : undefined;
      this.textReplace(l, r.spec, r.bx, r.by, "text", name);
      return;
    }
    if (r.layer) return;
    const out = textLayer(font, r.spec, r.bx, r.by);
    const c = canvasOf(out.px);
    const info: ImageLayerInfo = {
      id: newId(),
      name: firstLine(r.spec.text),
      x: out.x,
      y: out.y,
      w: c.width,
      h: c.height,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
      text: out.text,
    };
    const above = this.currentLayer()?.info.id ?? this.layers.at(-1)?.info.id ?? null;
    this.place({ info, c }, above);
    this.current = info.id;
    this.render();
    this.o.onLayers();
    this.emit(
      async () =>
        textEditActions(
          undefined,
          { ...info, text: out.text },
          c.width && c.height ? await this.upload(c) : null,
          { id: info.id, name: info.name, above },
        ),
      "text",
    );
  }

  /**
   * A text layer drawn again with `next`, its box at (bx, by): its text and its pixels in one
   * gesture (one revision, one Ctrl+Z).
   */
  private textReplace(
    l: Lay,
    next: ImageText,
    bx: number,
    by: number,
    what: What,
    name?: string,
  ): void {
    const font = this.fontNow(next);
    if (!font) {
      void this.loadFont(next).then((f) => {
        if (f) this.textReplace(l, next, bx, by, what, name);
        else this.o.onError("font");
      });
      return;
    }
    this.letGo();
    const out = textLayer(font, next, bx, by);
    const c = canvasOf(out.px);
    l.c = c;
    l.info = {
      ...l.info,
      x: out.x,
      y: out.y,
      w: c.width,
      h: c.height,
      text: out.text,
      ...(name !== undefined && { name }),
    };
    l.alpha = undefined;
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    const text = out.text;
    this.emit(
      async () =>
        textEditActions(
          id,
          { x: out.x, y: out.y, w: c.width, h: c.height, text },
          c.width && c.height ? await this.upload(c) : null,
          {
            ...(name !== undefined && { rename: name }),
            what: what === "text" ? "text" : "transform",
          },
        ),
      what,
    );
  }

  /** The text layer's text dropped here (its pixels stay): Photoshop's Rasterize Type. */
  private rasterizeNow(l: Lay): void {
    delete l.info.text;
    const id = l.info.id;
    this.emit(async () => [{ t: "props", layer: id, set: { text: null } }]);
  }

  /** «Rasterizza testo» on the current layer. */
  rasterizeText(): void {
    const l = this.currentLayer();
    if (!l?.info.text) return;
    if (this.texting.layer === l.info.id) this.texting.commit();
    this.rasterizeNow(l);
    this.o.onLayers();
  }
}

const firstLine = (text: string) => (text.split(/\r\n|\r|\n/)[0] ?? "").slice(0, 60) || "Text";

export function mountImage(o: IslandOptions): ImageIsland {
  return new ImageIsland(o);
}
