// The 3D editor's routes (G37.7).
//   GET  /api/editor/model/info?scope&path  {blender, original?} (a GLB copy says where it came from)
//   POST /api/editor/model/copy             the GLB copy of an OBJ/STL/PLY/FBX/.blend…: made here for
//                                           OBJ, STL and PLY (three.js), {convert: true} when it needs
//                                           Blender (the page runs the converter's job, with its bar)
//   POST /api/editor/model/blender          «Apri in Blender»: the model imported into the Blender
//                                           installed here; every save in Blender writes the glTF back
//                                           (the editor sees a change from outside, and can undo it)
// GLB, OBJ, STL, PLY, USDZ and a picture are made in the page (three.js's exporters).

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { DocFile } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { detached, type Launcher } from "../convert-programs.js";
import { BadRequestError, NotFoundError, type RedGiantCore } from "../core.js";
import { JS_COPIES, jsModelToGlb } from "./model/convert.js";
import { MODEL_COPIES, modelCopyOfOriginal, modelOriginalName } from "./model-family.js";

/** Blender's side of «Apri in Blender»: import, keep a .blend, write the glTF back on every save. */
export const BLENDER_BRIDGE_PY = `
import os
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, blend = argv[0], argv[1]

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
os.makedirs(os.path.dirname(blend), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=blend)


def redgiant_write_back(*_):
    fmt = "GLB" if src.lower().endswith(".glb") else "GLTF_SEPARATE"
    bpy.ops.export_scene.gltf(filepath=src, export_format=fmt)
    print("REDGIANT_WROTE", src)


bpy.app.handlers.save_post.append(redgiant_write_back)
`;

/** The arguments that start Blender's window on a model with the bridge. */
export const blenderBridgeArgs = (script: string, model: string, blend: string) => [
  "--python",
  script,
  "--",
  model,
  blend,
];

/** Where «Apri in Blender» keeps its .blend: beside the model, in its open folder. */
export const blendOf = (abs: string) => {
  const b = basename(abs);
  return join(`${abs}.open`, `${b.slice(0, b.lastIndexOf(".")) || b}.blend`);
};

/** Makes the GLB copy of an OBJ/STL/PLY here (atomic), unless it is there already. */
export async function writeJsCopy(abs: string): Promise<boolean> {
  const out = join(dirname(abs), modelCopyOfOriginal(basename(abs)) as string);
  if (existsSync(out)) return false;
  const glb = jsModelToGlb(new Uint8Array(await readFile(abs)), basename(abs));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(`${out}.part`, glb);
  await rename(`${out}.part`, out);
  return true;
}

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function modelRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  o: { launch?: Launcher; workDir?: string } = {},
): void {
  const launch = o.launch ?? detached;
  const workDir = o.workDir ?? join(tmpdir(), "redgiant-model");
  const fileOf = (scope: unknown, path: unknown, ok: RegExp): DocFile => {
    if (typeof scope !== "string" || typeof path !== "string" || !scope || !path)
      throw new BadRequestError("Give scope and path");
    if (!ok.test(path)) throw new BadRequestError("Not a 3D model this editor takes");
    return { scope, path };
  };
  const blender = () => core.programs.find("blender");

  app.get("/api/editor/model/info", async (c) => {
    const file = fileOf(c.req.query("scope"), c.req.query("path"), /\.(glb|gltf)$/i);
    const original = modelOriginalName(file.path);
    return c.json({ blender: !!blender(), ...(original && { original }) }, 200);
  });

  app.post("/api/editor/model/copy", async (c) => {
    const o2 = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path, MODEL_COPIES);
    const copy = modelCopyOfOriginal(file.path) as string;
    const abs = await core.docAbs(o2, file);
    const outAbs = join(dirname(abs), modelCopyOfOriginal(basename(abs)) as string);
    if (
      await stat(outAbs).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return c.json({ path: copy }, 200);
    // OBJ, STL and PLY: three.js here, unless Blender is installed (it reads an OBJ's .mtl too).
    if (JS_COPIES.test(file.path) && !blender()) {
      try {
        await writeJsCopy(abs);
      } catch (e) {
        throw new BadRequestError(`The GLB copy was not made: ${(e as Error).message}`);
      }
      return c.json({ path: copy, by: "three.js" }, 200);
    }
    return c.json({ path: copy, convert: true }, 200);
  });

  app.post("/api/editor/model/blender", async (c) => {
    const o2 = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path, /\.(glb|gltf)$/i);
    const exe = blender();
    if (!exe) throw new NotFoundError("Blender is not installed on this computer");
    // What the editor holds, written first.
    await core.editor.flush();
    const abs = await core.docAbs(o2, file);
    await mkdir(workDir, { recursive: true });
    const script = join(workDir, "redgiant_blender_bridge.py");
    await writeFile(script, BLENDER_BRIDGE_PY);
    launch(exe, blenderBridgeArgs(script, abs, blendOf(abs)));
    return c.json({ opened: true, ext: extname(abs).slice(1) }, 200);
  });
}
