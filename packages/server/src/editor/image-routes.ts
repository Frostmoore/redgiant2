// The layered picture editor's routes (G37.5).
//   GET  /api/editor/image/info?scope&path    {krita, original?, layers?}: Krita installed, the
//                                             file an .ora copy belongs to, a PNG's layers copy
//   POST /api/editor/image/blob?scope&path     a PNG the page made (a tile, a layer): a blob
//   POST /api/editor/image/export             «Esporta come…» OpenRaster or Photoshop (the
//                                             layers); PNG, JPEG and WebP are made in the page
//   POST /api/editor/image/krita              «Apri in Krita»: the file as last saved, in the
//                                             Krita installed on this computer
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { DocFile } from "@redgiant/protocol";
import { type BlendMode, initializeCanvas, type Layer, writePsd } from "ag-psd";
import type { Context, Hono } from "hono";
import { openInApp } from "../convert-programs.js";
import { BadRequestError, NotFoundError, type RedGiantCore } from "../core.js";
import {
  flatten,
  type ImageBlobs,
  type ImageModel,
  isNode,
  type Node,
  type RLayer,
  treeOf,
  writeOra,
} from "./image/model.js";
import {
  findKrita,
  IMAGE_EDITABLE,
  type ImageFamily,
  layersCopyOf,
  oraOriginalName,
} from "./image-family.js";

/** The biggest PNG a page sends at once (a whole layer). */
const MAX_BLOB = 128 * 1024 * 1024;

const PSD_BLEND: Record<string, BlendMode> = {
  "svg:src-over": "normal",
  "svg:multiply": "multiply",
  "svg:screen": "screen",
  "svg:overlay": "overlay",
  "svg:darken": "darken",
  "svg:lighten": "lighten",
  "svg:color-dodge": "color dodge",
  "svg:color-burn": "color burn",
  "svg:hard-light": "hard light",
  "svg:soft-light": "soft light",
  "svg:difference": "difference",
  "svg:exclusion": "exclusion",
  "svg:hue": "hue",
  "svg:saturation": "saturation",
  "svg:color": "color",
  "svg:luminosity": "luminosity",
  "svg:plus": "linear dodge",
};

let psdReady = false;

/** The picture as a Photoshop file: its layers, groups, opacity, blending and masks (ag-psd). */
export function imageToPsd(m: ImageModel): Uint8Array {
  if (!psdReady) {
    initializeCanvas(
      () => {
        throw new Error("No canvas on the server");
      },
      (width, height) =>
        ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as never,
    );
    psdReady = true;
  }
  const px = (img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }) => ({
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength),
  });
  const layerOf = (l: RLayer): Layer => ({
    name: l.name,
    left: l.x,
    top: l.y,
    right: l.x + l.px.width,
    bottom: l.y + l.px.height,
    opacity: l.opacity,
    hidden: !l.visible,
    blendMode: PSD_BLEND[l.blend] ?? "normal",
    ...(l.px.width && l.px.height && { imageData: px(l.px) }),
    ...(l.mask && {
      mask: {
        left: l.mask.x,
        top: l.mask.y,
        right: l.mask.x + l.mask.img.width,
        bottom: l.mask.y + l.mask.img.height,
        defaultColor: l.mask.outside,
        imageData: px(l.mask.img),
      },
    }),
  });
  const children = (n: Node): Layer[] =>
    n.children.map((c) =>
      isNode(c)
        ? {
            name: c.group?.name ?? "",
            opacity: c.group?.opacity ?? 1,
            hidden: c.group ? !c.group.visible : false,
            blendMode:
              c.group && !c.group.isolate
                ? "pass through"
                : (PSD_BLEND[c.group?.blend ?? ""] ?? "normal"),
            opened: true,
            children: children(c),
          }
        : layerOf(c),
    );
  const out = writePsd(
    {
      width: m.width,
      height: m.height,
      children: children(treeOf(m.layers)),
      imageData: px(flatten(m)),
    },
    { generateThumbnail: false, noBackground: true },
  );
  return new Uint8Array(out);
}

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function imageRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  family: () => ImageFamily,
): void {
  const fileOf = (scope: unknown, path: unknown): DocFile => {
    if (typeof scope !== "string" || typeof path !== "string" || !scope || !path)
      throw new BadRequestError("Give scope and path");
    if (!IMAGE_EDITABLE.test(path)) throw new BadRequestError("Not a picture the editor edits");
    return { scope, path };
  };

  app.get("/api/editor/image/info", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const original = oraOriginalName(file.path);
    const copy = layersCopyOf(file.path);
    let layers: string | undefined;
    if (copy) {
      const abs = await core.docAbs(o, file).catch(() => undefined);
      if (abs && (await stat(`${abs}.open/${basename(copy)}`).catch(() => undefined))?.isFile())
        layers = copy;
    }
    return c.json(
      { krita: !!findKrita(), ...(original && { original }), ...(layers && { layers }) },
      200,
    );
  });

  app.post("/api/editor/image/blob", async (c) => {
    const o = owner(c);
    await core.docAbs(o, fileOf(c.req.query("scope"), c.req.query("path")));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BLOB)
      throw new BadRequestError("The pixels are empty or too big (128 MB at most)");
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47))
      throw new BadRequestError("Only PNG pixels go into a picture");
    return c.json({ blob: await core.editor.putBlob(bytes) }, 200);
  });

  app.post("/api/editor/image/export", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string; to?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    if (b.to !== "ora" && b.to !== "psd")
      throw new BadRequestError(
        "A picture is exported here as ora or psd (PNG, JPEG and WebP are made in the page)",
      );
    const read = await core.editor.read(o, file);
    if (read.family.id !== "image") throw new BadRequestError("Not a picture");
    const m = read.model as ImageModel;
    const blobs: ImageBlobs = family().blobs;
    const bytes = b.to === "ora" ? writeOra({ ...m, format: "ora" }, blobs) : imageToPsd(m);
    const name = `${basename(file.path, extname(file.path))}.${b.to}`;
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": b.to === "ora" ? "image/openraster" : "image/vnd.adobe.photoshop",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  });

  app.post("/api/editor/image/krita", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    const exe = findKrita();
    if (!exe) throw new NotFoundError("Krita is not installed on this computer");
    await core.editor.flush();
    openInApp(exe, await core.docAbs(o, file));
    return c.json({ opened: true }, 200);
  });
}
