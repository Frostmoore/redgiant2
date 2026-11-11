// The layered picture family (G37.5): OpenRaster files edited with their layers, PNG and JPEG
// pictures as one layer (written back flattened; when they hold more than one layer, the layers
// go to an OpenRaster copy beside them, `<file>.open/<name>.ora`), and the OpenRaster copy of a
// Photoshop file (`x.psd.open/x.ora`, made by our own converter). Pixels travel as PNG blobs of
// the host, in tiles; the person paints in the page (viewers/image-island.ts) and sends the
// tiles it changed, the agents' operations are drawn here (image/agent.ts).
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix, win32 } from "node:path";
import type {
  DocOp,
  DocSummary,
  ImageAction,
  ImageDocOp,
  ImagePlainAction,
} from "@redgiant/protocol";
import type { DocFamily, Loaded, PrepareContext, RenderContext } from "./family.js";
import { IMAGE_CATALOG, imageFromAgent, textOverflow } from "./image/agent.js";
import {
  formatOf,
  ImageBlobs,
  type ImageModel,
  needsLayers,
  readImage,
  snapshotOf,
  writeImage,
  writeOra,
} from "./image/model.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  composeActions,
  describe,
  invertAction,
  touchedLayers,
} from "./image/ops.js";
import { imageStructure } from "./image/structure.js";

export const IMAGE_ENGINE_VERSION = "1";
/** Files the family edits itself. */
export const IMAGE_EDITABLE = /\.(ora|png|jpe?g)$/i;
/** Closed layered formats edited on their OpenRaster copy. */
export const IMAGE_COPIES = /\.(psd|psb)$/i;

const wrap = (op: ImageAction): ImageDocOp => ({
  family: "image",
  engine: "redgiant-raster",
  engineVersion: IMAGE_ENGINE_VERSION,
  op,
});
const actionOf = (op: DocOp): ImageAction => {
  if (op.family !== "image") throw new Error("not an operation on a picture");
  return op.op;
};

const stemOf = (path: string) => {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
};

/** Where the OpenRaster copy of a PSD is (`x.psd` → `x.psd.open/x.ora`). */
export function oraCopyOfOriginal(path: string): string | undefined {
  if (!IMAGE_COPIES.test(path)) return undefined;
  return `${path}.open/${stemOf(path)}.ora`;
}

/** Where a PNG's or JPEG's layers are kept (`x.png` → `x.png.open/x.ora`). */
export function layersCopyOf(path: string): string | undefined {
  if (!/\.(png|jpe?g)$/i.test(path)) return undefined;
  return `${path}.open/${stemOf(path)}.ora`;
}

/** The file an OpenRaster copy belongs to (`x.psd.open/x.ora` → `x.psd`), if it is one. */
export function originalOfOraCopy(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  const m = dirname(p).match(/^(.*)\.open$/);
  if (!m?.[1]) return undefined;
  const o = m[1];
  return oraCopyOfOriginal(o) === p || layersCopyOf(o) === p ? o : undefined;
}

/** Krita on this computer, if it is installed (never downloaded: «Apri in Krita»). */
export function findKrita(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
): string | undefined {
  if (platform === "darwin") {
    for (const app of ["/Applications/krita.app", "/Applications/Krita.app"])
      if (exists(app)) return app;
    return undefined;
  }
  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs"),
    ].filter((x): x is string => !!x);
    for (const r of roots)
      for (const dir of ["Krita (x64)", "Krita"]) {
        const p = win32.join(r, dir, "bin", "krita.exe");
        if (exists(p)) return p;
      }
    return undefined;
  }
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const p = posix.join(dir, "krita");
    if (exists(p)) return p;
  }
  for (const d of [
    "/var/lib/flatpak/exports/bin",
    posix.join(env.HOME ?? "/root", ".local/share/flatpak/exports/bin"),
  ])
    if (list(d).includes("org.kde.krita")) return posix.join(d, "org.kde.krita");
  return undefined;
}

export interface ImageFamilyOptions {
  /** RedGiant's data folder (the host's blobs are in `editor/blobs`). */
  dataDir: string;
}

export class ImageFamily implements DocFamily<ImageModel> {
  readonly id = "image" as const;
  readonly engine = "redgiant-raster";
  readonly engineVersion = IMAGE_ENGINE_VERSION;
  readonly blobs: ImageBlobs;

  constructor(o: ImageFamilyOptions) {
    this.blobs = new ImageBlobs(o.dataDir);
  }

  accepts(path: string): boolean {
    return IMAGE_EDITABLE.test(path);
  }

  load(bytes: Uint8Array, path?: string): Loaded<ImageModel> {
    const ext = extname(path ?? "").toLowerCase();
    const want = ext === ".ora" ? "ora" : ext === ".png" ? "png" : ext ? "jpeg" : undefined;
    const got = formatOf(bytes);
    if (want === "ora" && got !== "ora") throw new Error("it is not an OpenRaster file");
    if (want && want !== "ora" && got === "ora") throw new Error("it is a zip, not a picture");
    const model = readImage(bytes);
    // Written back in the format its name says.
    return {
      model: want && want !== model.format ? { ...model, format: want } : model,
      format: {},
    };
  }

  save(model: ImageModel): Uint8Array {
    return writeImage(model, this.blobs);
  }

  /** A PNG or JPEG with layers: they are kept in an OpenRaster copy beside it. */
  async saved(model: ImageModel, ctx: RenderContext): Promise<void> {
    if (!needsLayers(model)) return;
    const copy = layersCopyOf(ctx.file.path);
    if (!copy) return;
    const abs = join(`${ctx.abs}.open`, basename(copy));
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.part`;
    writeFileSync(tmp, writeOra({ ...model, format: "ora" }, this.blobs));
    renameSync(tmp, abs);
  }

  snapshot(model: ImageModel) {
    return snapshotOf(model, this.blobs);
  }

  check(model: ImageModel, op: DocOp): string | undefined {
    if (op.family !== "image") return "not an operation on a picture";
    return checkAction(model, op.op, this.blobs);
  }

  apply(model: ImageModel, op: DocOp): ImageModel {
    return applyAction(model, actionOf(op), this.blobs);
  }

  invert(model: ImageModel, op: DocOp): DocOp {
    return wrap(invertAction(model, actionOf(op), this.blobs));
  }

  compose(ops: readonly DocOp[]): DocOp {
    return wrap(composeActions(ops.map(actionOf)));
  }

  conflicts(a: DocOp, b: DocOp): boolean {
    return actionsConflict(actionOf(a), actionOf(b));
  }

  /** Layers are named by ids that do not move: what does not conflict applies as it is. */
  map(a: DocOp, b: DocOp): DocOp | undefined {
    return actionsConflict(actionOf(a), actionOf(b)) ? undefined : a;
  }

  /** While the person paints the agents' edits wait (the whole picture is theirs). */
  touches(): boolean {
    return true;
  }

  mapPos(_op: DocOp, pos: number): number {
    return pos;
  }

  lineOf(): number {
    return 1;
  }

  placeOf(): string {
    return "the picture";
  }

  /**
   * A change from outside as operations, when the picture kept its size and its layers (a PNG
   * painted by another program): each changed layer's pixels and properties. Undone like any.
   */
  diff(before: ImageModel, after: ImageModel): DocOp | undefined {
    if (before.width !== after.width || before.height !== after.height) return undefined;
    if (before.layers.length !== after.layers.length) return undefined;
    const ops: ImagePlainAction[] = [];
    for (const [i, a] of after.layers.entries()) {
      const b = before.layers[i];
      if (!b || b.id !== a.id || !!a.mask !== !!b.mask) return undefined;
      const same =
        a.px.width === b.px.width &&
        a.px.height === b.px.height &&
        Buffer.compare(Buffer.from(a.px.data), Buffer.from(b.px.data)) === 0;
      if (!same || a.x !== b.x || a.y !== b.y)
        ops.push({
          t: "pixels",
          layer: a.id,
          x: a.x,
          y: a.y,
          w: a.px.width,
          h: a.px.height,
          png: a.px.width && a.px.height ? this.blobs.hashOf(a.px) : null,
        });
      const set: Extract<ImagePlainAction, { t: "props" }>["set"] = {};
      if (a.name !== b.name) set.name = a.name;
      if (a.opacity !== b.opacity) set.opacity = a.opacity;
      if (a.visible !== b.visible) set.visible = a.visible;
      if (a.blend !== b.blend) set.blend = a.blend;
      if (!!a.locked !== !!b.locked) set.locked = !!a.locked;
      if (Object.keys(set).length) ops.push({ t: "props", layer: a.id, set });
      if (a.mask && b.mask && a.mask.img.data !== b.mask.img.data)
        ops.push({
          t: "pixels",
          layer: a.id,
          mask: true,
          x: a.mask.x,
          y: a.mask.y,
          w: a.mask.img.width,
          h: a.mask.img.height,
          png: this.blobs.hashOf(a.mask.img),
          outside: a.mask.outside,
        });
    }
    if (!ops.length) return undefined;
    return wrap(ops.length === 1 ? (ops[0] as ImagePlainAction) : { t: "batch", ops });
  }

  summarize(model: ImageModel, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary {
    const d = describe(model, ops.map(actionOf));
    const k: DocSummary["kind"] =
      d.change.action === "add_layer"
        ? "insert"
        : d.change.action === "remove_layer"
          ? "delete"
          : "edit";
    const n = ops.flatMap((o) => {
      const a = actionOf(o);
      return a.t === "batch" ? a.ops : [a];
    }).length;
    return {
      text: d.text.slice(0, 500),
      kind: kind ?? k,
      image: d.change,
      ...(n > 1 && { count: n }),
    };
  }

  wrote(): [number, number][] {
    return [];
  }

  fromAgent(model: ImageModel, ops: readonly unknown[]) {
    const r = imageFromAgent(model, ops, { blobs: this.blobs });
    if ("error" in r) return r;
    return { ops: r.actions.map(wrap) };
  }

  /** A paragraph text the agent left too long for its box: said in its result (p3.5.8). */
  advice(model: ImageModel, ops: readonly DocOp[]): string | undefined {
    const actions = ops.map(actionOf);
    let after = model;
    for (const a of actions) after = applyAction(after, a, this.blobs);
    return textOverflow(after, touchedLayers(composeActions(actions)));
  }

  /** Pictures named by path (a generated picture to put in as a layer) become blobs. */
  async prepare(ops: readonly unknown[], ctx: PrepareContext): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const raw of ops) {
      const x = (raw ?? {}) as Record<string, unknown>;
      if (typeof x.image === "string" && x.image.trim()) {
        const bytes = await ctx.read(x.image.trim());
        const f = formatOf(bytes);
        if (f !== "png" && f !== "jpeg")
          throw new Error(`${x.image} is not a PNG or a JPEG (convert it first)`);
        out.push({ ...x, picture: { blob: await ctx.putBlob(bytes) } });
      } else out.push(raw);
    }
    return out;
  }

  catalog(): string {
    return IMAGE_CATALOG;
  }

  structure(
    model: ImageModel,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
  ): string {
    return imageStructure(model, ask);
  }
}

/** The original's name for an OpenRaster copy, for the page («Copia ORA di foto.psd»). */
export const oraOriginalName = (path: string) => {
  const o = originalOfOraCopy(path);
  return o ? basename(o) : undefined;
};
