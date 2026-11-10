// The layered picture editor's engine in the page (G37.5), in its own chunk (loaded when a
// picture is opened for editing): each layer is a canvas at its place, drawn bottom to top with
// its opacity, blending (canvas 2D's composite operations), mask and groups. The person's tools
// (brush, eraser, selections, move, text, colour picker) change the canvases at once; the
// changed pixels are cut in tiles (`imageTilesOf`), only the tiles that differ become PNG blobs,
// and the actions go to the host (the server keeps the file). Others' actions arrive the same
// way and are drawn from their blobs.
import {
  canvasBlendOf,
  type ImageAction,
  type ImageGroup,
  type ImageLayerInfo,
  type ImagePlainAction,
  type ImageSnapshot,
  type ImageTile,
  imageTilesOf,
  runImageFilter,
} from "@redgiant/protocol";

type C = HTMLCanvasElement;
type Ctx = CanvasRenderingContext2D;
type What = NonNullable<Extract<ImagePlainAction, { t: "tiles" }>["what"]>;

export type ImageTool =
  | "move"
  | "brush"
  | "eraser"
  | "rect"
  | "ellipse"
  | "lasso"
  | "text"
  | "picker";

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
  /** Drawn instead of `c` while a stroke or a filter is previewed. */
  preview?: C;
}

export interface IslandOptions {
  area: HTMLElement;
  blob(hash: string): Promise<Blob>;
  upload(png: Blob): Promise<string>;
  /** The person's actions, once their pixels are blobs, in the order they were made. */
  onActions(actions: ImagePlainAction[], what?: What, filter?: string): void;
  onLayers(): void;
  onSelection(box: Rect | undefined): void;
  onEditing(editing: boolean): void;
  onPick(hex: string): void;
  onText(x: number, y: number): void;
  onZoom(zoom: number): void;
  onBusy(n: number): void;
  onError(message: string): void;
}

export interface Brush {
  size: number;
  /** 0…1. */
  opacity: number;
  /** 0…1: soft edges below 1. */
  hardness: number;
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
const union = (a: Rect, b: Rect): Rect => {
  if (!a.w || !a.h) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const inter = (a: Rect, b: Rect): Rect | undefined => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : undefined;
};
const inside = (a: Rect, b: Rect) =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
let ids = 0;
const newId = () => `p-${Date.now().toString(36)}${(ids++).toString(36)}`;

export class ImageIsland {
  width = 1;
  height = 1;
  format: ImageSnapshot["format"] = "ora";
  private layers: Lay[] = [];
  current: string | undefined;
  tool: ImageTool = "brush";
  brush: Brush = { size: 12, opacity: 1, hardness: 1, color: "#e0482e" };
  /** Painting on the current layer's mask instead of its pixels. */
  onMask = false;
  zoom = 1;
  private readonly view: C;
  private readonly over: C;
  private readonly stage: HTMLDivElement;
  /** The selection: its alpha (picture-sized), its outline, its box. */
  private sel: { alpha: C; outline: [number, number][][]; box: Rect } | undefined;
  private chain: Promise<void> = Promise.resolve();
  private busy = 0;
  private frame = 0;
  private gesture:
    | { kind: "paint"; stroke: C; pts: [number, number][]; last: [number, number] }
    | { kind: "move"; from: [number, number]; at: [number, number]; lay: Lay }
    | {
        kind: "select";
        from: [number, number];
        pts: [number, number][];
        shape: "rect" | "ellipse" | "lasso";
      }
    | undefined;
  private filterPreview: { id: string; layer: string } | undefined;
  private disposed = false;

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
    o.area.addEventListener("wheel", this.wheel, { passive: false });
  }

  dispose(): void {
    this.disposed = true;
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
    this.width = s.width;
    this.height = s.height;
    this.format = s.format;
    this.layers = layers;
    if (!this.current || !this.find(this.current)) this.current = layers.at(-1)?.info.id;
    this.resize();
    this.sel = undefined;
    this.o.onSelection(undefined);
    this.render();
    this.o.onLayers();
  }

  private find(id: string) {
    return this.layers.find((l) => l.info.id === id);
  }

  /** Others' actions, drawn from their blobs; "reload" when they do not fit what is here. */
  async remote(actions: readonly ImageAction[]): Promise<"ok" | "reload"> {
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
        this.sel = undefined;
        this.o.onSelection(undefined);
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
    this.o.onZoom(this.zoom);
  }

  setZoom(z: number | "fit"): number {
    if (z === "fit") {
      const box = this.o.area.getBoundingClientRect();
      z = Math.min((box.width - 24) / this.width, (box.height - 24) / this.height, 1) || 1;
    }
    this.zoom = Math.max(0.05, Math.min(32, z));
    this.applyZoom();
    this.drawOverlay();
    return this.zoom;
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
    const alpha = this.alphaOf(l);
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
        if (!x.info.visible || !x.c.width || !x.c.height) continue;
        if (only && !only(x.info)) continue;
        c.globalAlpha = x.info.opacity * opacity;
        c.globalCompositeOperation = canvasBlendOf(x.info.blend) as GlobalCompositeOperation;
        c.drawImage(this.drawn(x), x.info.x, x.info.y);
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
      this.drawOverlay();
    });
  }

  private drawOverlay() {
    const c = ctx2d(this.over);
    c.clearRect(0, 0, this.over.width, this.over.height);
    const px = 1 / this.zoom;
    const outline = (pts: [number, number][], close: boolean) => {
      if (pts.length < 2) return;
      c.beginPath();
      c.moveTo(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
      for (const p of pts.slice(1)) c.lineTo(p[0], p[1]);
      if (close) c.closePath();
      c.lineWidth = px;
      c.setLineDash([]);
      c.strokeStyle = "#ffffff";
      c.stroke();
      c.setLineDash([4 * px, 4 * px]);
      c.strokeStyle = "#000000";
      c.stroke();
      c.setLineDash([]);
    };
    for (const p of this.sel?.outline ?? []) outline(p, true);
    const g = this.gesture;
    if (g?.kind === "select") {
      const pts =
        g.shape === "lasso" ? g.pts : this.shapePoints(g.shape, g.from, g.pts.at(-1) ?? g.from);
      outline(pts, true);
    }
    // The current layer's edges.
    const l = this.current ? this.find(this.current) : undefined;
    if (l && (l.c.width !== this.width || l.c.height !== this.height || l.info.x || l.info.y)) {
      c.lineWidth = px;
      c.setLineDash([2 * px, 3 * px]);
      c.strokeStyle = "rgba(90, 160, 255, 0.9)";
      c.strokeRect(l.info.x, l.info.y, l.c.width, l.c.height);
      c.setLineDash([]);
    }
  }

  private shapePoints(
    shape: "rect" | "ellipse",
    a: [number, number],
    b: [number, number],
  ): [number, number][] {
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    if (shape === "rect")
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
    const out: [number, number][] = [];
    for (let i = 0; i < 64; i++) {
      const t = (i / 64) * Math.PI * 2;
      out.push([x + w / 2 + (Math.cos(t) * w) / 2, y + h / 2 + (Math.sin(t) * h) / 2]);
    }
    return out;
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

  /** Pixels and actions made ready in order (blobs first), then sent. */
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
   * A change of a layer's pixels (or mask) drawn by `draw` in the picture's coordinates over
   * `need`: tiles when the layer holds it, the whole layer grown when it does not.
   */
  private change(
    l: Lay,
    need: Rect,
    draw: (c: Ctx, ox: number, oy: number) => void,
    what: What,
  ): void {
    if (l.info.locked) {
      this.o.onError("locked");
      return;
    }
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

  private currentLayer(): Lay | undefined {
    return this.current ? this.find(this.current) : undefined;
  }

  // ---------------------------------------------------------------- pointer

  private at(e: PointerEvent): [number, number] {
    const r = this.over.getBoundingClientRect();
    return [(e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom];
  }

  private readonly down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.at(e);
    const l = this.currentLayer();
    this.over.setPointerCapture?.(e.pointerId);
    switch (this.tool) {
      case "brush":
      case "eraser": {
        if (!l) return;
        if (l.info.locked) {
          this.o.onError("locked");
          return;
        }
        this.o.onEditing(true);
        const stroke = canvas(this.width, this.height);
        this.gesture = { kind: "paint", stroke, pts: [p], last: p };
        this.dab(stroke, p, p);
        this.preview();
        return;
      }
      case "move":
        if (!l) return;
        if (l.info.locked) {
          this.o.onError("locked");
          return;
        }
        this.o.onEditing(true);
        this.gesture = { kind: "move", from: p, at: p, lay: l };
        return;
      case "rect":
      case "ellipse":
      case "lasso":
        this.gesture = { kind: "select", from: p, pts: [p], shape: this.tool };
        return;
      case "text":
        this.o.onText(Math.round(p[0]), Math.round(p[1]));
        return;
      case "picker": {
        const d = ctx2d(this.view).getImageData(Math.floor(p[0]), Math.floor(p[1]), 1, 1).data;
        this.o.onPick(hexOf(d[0] as number, d[1] as number, d[2] as number));
        return;
      }
    }
  };

  private readonly moveEv = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g) return;
    const p = this.at(e);
    if (g.kind === "paint") {
      this.dab(g.stroke, g.last, p);
      g.last = p;
      g.pts.push(p);
      this.preview();
    } else if (g.kind === "move") {
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
    } else {
      if (g.shape === "lasso") g.pts.push(p);
      else g.pts = [g.from, p];
      this.drawOverlay();
    }
  };

  private readonly up = () => {
    const g = this.gesture;
    this.gesture = undefined;
    if (!g) return;
    if (g.kind === "paint") {
      const l = this.currentLayer();
      if (!l) return;
      l.preview = undefined;
      this.clipToSelection(g.stroke, true);
      const r = this.boundsOf(g.pts, this.brush.size / 2 + 2);
      const erase = this.tool === "eraser";
      const onMask = this.onMask && !!l.mask;
      this.change(
        l,
        r,
        (c, ox, oy) => {
          c.save();
          if (onMask) {
            // On a mask the brush shows (its colour's lightness), the eraser hides.
            const v = erase ? 0 : greyOfCss(this.brush.color);
            const tinted = canvas(this.width, this.height);
            const t = ctx2d(tinted);
            t.drawImage(g.stroke, 0, 0);
            t.globalCompositeOperation = "source-in";
            t.fillStyle = `rgb(${v},${v},${v})`;
            t.fillRect(0, 0, this.width, this.height);
            c.drawImage(tinted, -ox, -oy);
          } else {
            c.globalCompositeOperation = erase ? "destination-out" : "source-over";
            c.drawImage(g.stroke, -ox, -oy);
          }
          c.restore();
        },
        erase && !onMask ? "erase" : "paint",
      );
      this.o.onEditing(false);
    } else if (g.kind === "move") {
      const l = g.lay;
      const dx = Math.round(g.at[0] - g.from[0]);
      const dy = Math.round(g.at[1] - g.from[1]);
      this.o.onEditing(false);
      if (dx || dy) {
        const set = { x: l.info.x, y: l.info.y };
        this.emit(async () => [{ t: "props", layer: l.info.id, set }], "transform");
      }
    } else {
      const last = g.pts.at(-1) ?? g.from;
      const pts = g.shape === "lasso" ? g.pts : this.shapePoints(g.shape, g.from, last);
      if (
        g.shape !== "lasso" &&
        (Math.abs(last[0] - g.from[0]) < 1 || Math.abs(last[1] - g.from[1]) < 1)
      )
        this.selectNone();
      else this.setSelection([pts]);
    }
  };

  private readonly wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  private boundsOf(pts: [number, number][], pad: number): Rect {
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

  /** One segment of a stroke (round dabs, softer edges with a lower hardness). */
  private dab(stroke: C, a: [number, number], b: [number, number]) {
    const c = ctx2d(stroke);
    const r = Math.max(0.5, this.brush.size / 2);
    const color = this.tool === "eraser" ? "#000000" : this.brush.color;
    c.save();
    c.globalAlpha = 1;
    if (this.brush.hardness >= 0.99) {
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = r * 2;
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0] + 0.01, b[1]);
      c.stroke();
    } else {
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, r / 4)),
      );
      for (let i = 0; i <= steps; i++) {
        const x = a[0] + ((b[0] - a[0]) * i) / steps;
        const y = a[1] + ((b[1] - a[1]) * i) / steps;
        const g = c.createRadialGradient(x, y, r * this.brush.hardness, x, y, r);
        g.addColorStop(0, color);
        g.addColorStop(1, `${color}00`);
        c.fillStyle = g;
        c.globalCompositeOperation = "lighten";
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
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
    const s = canvas(this.width, this.height);
    const sc = ctx2d(s);
    sc.globalAlpha = this.brush.opacity;
    sc.drawImage(g.stroke, 0, 0);
    this.clipToSelection(s, false);
    const r = union(
      { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height },
      this.boundsOf(g.pts, this.brush.size / 2 + 2),
    );
    const p = canvas(r.w, r.h);
    const pc = ctx2d(p);
    pc.drawImage(l.c, l.info.x - r.x, l.info.y - r.y);
    pc.globalCompositeOperation = this.tool === "eraser" ? "destination-out" : "source-over";
    pc.drawImage(s, -r.x, -r.y);
    // Drawn at the layer's place: the part beyond it shows once the layer grows.
    const q = canvas(l.c.width, l.c.height);
    ctx2d(q).drawImage(p, r.x - l.info.x, r.y - l.info.y);
    l.preview = q;
    this.render();
  }

  /** A stroke's opacity applied and the parts outside the selection taken away. */
  private clipToSelection(stroke: C, opacity: boolean) {
    const c = ctx2d(stroke);
    if (opacity && this.brush.opacity < 1) {
      const t = canvas(stroke.width, stroke.height);
      ctx2d(t).drawImage(stroke, 0, 0);
      c.clearRect(0, 0, stroke.width, stroke.height);
      c.globalAlpha = this.brush.opacity;
      c.drawImage(t, 0, 0);
      c.globalAlpha = 1;
    }
    if (!this.sel) return;
    c.globalCompositeOperation = "destination-in";
    c.drawImage(this.sel.alpha, 0, 0);
    c.globalCompositeOperation = "source-over";
  }

  // ---------------------------------------------------------------- selections

  private setSelection(polys: [number, number][][]) {
    const alpha = canvas(this.width, this.height);
    const c = ctx2d(alpha);
    c.fillStyle = "#000";
    c.beginPath();
    for (const p of polys) {
      if (p.length < 3) continue;
      c.moveTo(p[0]?.[0] ?? 0, p[0]?.[1] ?? 0);
      for (const q of p.slice(1)) c.lineTo(q[0], q[1]);
      c.closePath();
    }
    c.fill();
    const all = polys.flat();
    if (all.length < 3) {
      this.selectNone();
      return;
    }
    const b = this.boundsOf(all, 0);
    const box = inter(b, { x: 0, y: 0, w: this.width, h: this.height });
    if (!box) {
      this.selectNone();
      return;
    }
    this.sel = { alpha, outline: polys, box };
    this.o.onSelection(box);
    this.drawOverlay();
  }

  selectAll(): void {
    this.setSelection([
      [
        [0, 0],
        [this.width, 0],
        [this.width, this.height],
        [0, this.height],
      ],
    ]);
  }

  selectNone(): void {
    this.sel = undefined;
    this.o.onSelection(undefined);
    this.drawOverlay();
  }

  invertSelection(): void {
    if (!this.sel) {
      this.selectAll();
      return;
    }
    const alpha = canvas(this.width, this.height);
    const c = ctx2d(alpha);
    c.fillStyle = "#000";
    c.fillRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = "destination-out";
    c.drawImage(this.sel.alpha, 0, 0);
    const frame: [number, number][] = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
    ];
    this.sel = {
      alpha,
      outline: [frame, ...this.sel.outline],
      box: { x: 0, y: 0, w: this.width, h: this.height },
    };
    this.o.onSelection(this.sel.box);
    this.drawOverlay();
  }

  get selection(): Rect | undefined {
    return this.sel?.box;
  }

  /** The selection (or the whole picture) filled with a colour on the current layer or mask. */
  fillSelection(color: string, clear = false): void {
    const l = this.currentLayer();
    if (!l) return;
    const shape = canvas(this.width, this.height);
    const c = ctx2d(shape);
    c.fillStyle = clear ? "#000" : color;
    c.fillRect(0, 0, this.width, this.height);
    if (this.sel) {
      c.globalCompositeOperation = "destination-in";
      c.drawImage(this.sel.alpha, 0, 0);
    }
    const box = this.sel?.box ?? { x: 0, y: 0, w: this.width, h: this.height };
    const onMask = this.onMask && !!l.mask;
    const v = clear ? 0 : greyOfCss(color);
    this.change(
      l,
      clear && !onMask
        ? (inter(box, { x: l.info.x, y: l.info.y, w: l.c.width, h: l.c.height }) ?? {
            x: 0,
            y: 0,
            w: 0,
            h: 0,
          })
        : box,
      (ctx, ox, oy) => {
        ctx.save();
        if (onMask) {
          const t = canvas(this.width, this.height);
          const tc = ctx2d(t);
          tc.drawImage(shape, 0, 0);
          tc.globalCompositeOperation = "source-in";
          tc.fillStyle = `rgb(${v},${v},${v})`;
          tc.fillRect(0, 0, this.width, this.height);
          ctx.drawImage(t, -ox, -oy);
        } else {
          ctx.globalCompositeOperation = clear ? "destination-out" : "source-over";
          ctx.drawImage(shape, -ox, -oy);
        }
        ctx.restore();
      },
      clear ? "clear" : "fill",
    );
  }

  // ---------------------------------------------------------------- filters

  /** A filter shown on the current layer (in the selection), not applied yet. */
  previewFilter(id: string, params: Record<string, number>): void {
    const l = this.currentLayer();
    if (!l?.c.width || !l.c.height) return;
    l.preview = this.filtered(l, id, params);
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
    if (this.sel) {
      const a = ctx2d(this.sel.alpha).getImageData(l.info.x, l.info.y, w, h).data;
      for (let i = 0; i < out.length; i += 4) {
        const k = (a[i + 3] as number) / 255;
        if (k >= 1) continue;
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
    if (l.info.locked) {
      this.o.onError("locked");
      return;
    }
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
    below.c = c;
    below.info = { ...below.info, x: r.x, y: r.y, w: r.w, h: r.h };
    delete below.mask;
    below.alpha = undefined;
    this.layers = this.layers.filter((x) => x !== l);
    this.current = below.info.id;
    this.render();
    this.o.onLayers();
    const bid = below.info.id;
    const lid = l.info.id;
    this.emit(async () => [
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
      tc.drawImage(this.sel.alpha, 0, 0);
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
    this.render();
    this.o.onLayers();
    const id = l.info.id;
    const { x, y } = l.info;
    this.emit(async () => [
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
    const l = this.currentLayer();
    if (!l?.c.width || !l.c.height) return;
    if (l.info.locked) {
      this.o.onError("locked");
      return;
    }
    const sx = (scale / 100) * (flipH ? -1 : 1);
    const sy = (scale / 100) * (flipV ? -1 : 1);
    const t = (angle * Math.PI) / 180;
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
      if (l.c.width && l.c.height) {
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
    this.sel = undefined;
    this.o.onSelection(undefined);
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

  // ---------------------------------------------------------------- text

  /** A text as a new layer (the browser's fonts), its top left at (x, y). */
  addText(
    text: string,
    x: number,
    y: number,
    o: { size: number; color: string; bold: boolean; italic: boolean; font: string },
  ): void {
    const lines = text.split(/\r?\n/);
    const font = `${o.italic ? "italic " : ""}${o.bold ? "bold " : ""}${o.size}px ${o.font}`;
    const m = ctx2d(canvas(1, 1));
    m.font = font;
    const w = Math.ceil(Math.max(1, ...lines.map((l) => m.measureText(l).width))) + 4;
    const step = Math.round(o.size * 1.2);
    const h = step * lines.length + 4;
    const c = canvas(w, h);
    const g = ctx2d(c);
    g.font = font;
    g.fillStyle = o.color;
    g.textBaseline = "top";
    for (const [i, l] of lines.entries()) g.fillText(l, 2, 2 + i * step);
    const info: ImageLayerInfo = {
      id: newId(),
      name: (lines[0] ?? "").slice(0, 60) || "Text",
      x: x - 2,
      y: y - 2,
      w,
      h,
      opacity: 1,
      visible: true,
      blend: "svg:src-over",
    };
    const above = this.currentLayer()?.info.id ?? this.layers.at(-1)?.info.id ?? null;
    this.place({ info, c }, above);
    this.current = info.id;
    this.render();
    this.o.onLayers();
    this.emit(
      async () => [{ t: "add", layer: { ...info }, above, png: await this.upload(c), mask: null }],
      "text",
    );
  }
}

export function mountImage(o: IslandOptions): ImageIsland {
  return new ImageIsland(o);
}
