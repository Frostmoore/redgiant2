// Blender (GPL-2.0-or-later, downloaded once when needed: convert-programs.ts) for 3D (G34.3,
// the user: «gli agenti devono poter lavorare su tutti i file che possono aprire»):
//   - conversions of 3D files the canvas cannot open into glTF (the open one): .blend, USD,
//     Alembic, FBX; OBJ/STL/PLY when asked (materials, scale);
//   - the agents' `blender` tool: a Python (bpy) script on an optional file of the project,
//     with a render (still or a 360° turn) as an option, so there is one tool and not two.
// Blender always starts without a window (-b), without the person's settings
// (--factory-startup), with a thread limit and a time limit. A script is code: the tool runs it
// where the agents' commands run (Workspace.execFile, the project as working folder, the agents'
// environment without secrets), so it is exactly as allowed as a command.

import { rm, rmdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, posix } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { type ShowFileHost, showFileTool, type Workspace } from "@redgiant/tools";
import { z } from "zod";
import type { Programs } from "./convert-programs.js";

/** The files Blender's own importers read (5.x: COLLADA, 3DS and X3D are no longer built in). */
export const BLENDER_INPUTS = [
  "blend",
  "glb",
  "gltf",
  "obj",
  "stl",
  "ply",
  "fbx",
  "usd",
  "usda",
  "usdc",
  "usdz",
  "abc",
];

/** Shared Python: import any of BLENDER_INPUTS into the scene. */
const IMPORT_PY = `
import os
import bpy


def load(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext == "blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    if ext in ("glb", "gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == "obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == "stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == "ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == "fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in ("usd", "usda", "usdc", "usdz"):
        bpy.ops.wm.usd_import(filepath=path)
    elif ext == "abc":
        bpy.ops.wm.alembic_import(filepath=path)
    else:
        raise RuntimeError("Blender cannot import ." + ext)


def export_glb(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
`;

/** The conversion: `-- <input> <output.glb>`. */
export const BLENDER_CONVERT_SCRIPT = `# RedGiant: import a 3D file into Blender and export it as glTF (GLB).
import sys
import traceback
${IMPORT_PY}
code = 0
try:
    args = sys.argv[sys.argv.index("--") + 1:]
    load(args[0])
    export_glb(args[1])
    print("REDGIANT done", flush=True)
except Exception:
    traceback.print_exc()
    code = 1
sys.stdout.flush()
os._exit(code)
`;

/**
 * The tool's runner: `-- <spec.json>` with file, script, outputs and render settings. Opens the
 * file, runs the agent's script, saves .blend and .glb, renders if asked; prints REDGIANT_RESULT.
 */
export const BLENDER_RUN_SCRIPT = `# RedGiant: the blender tool (file, the agent's script, outputs, an optional render).
import json
import math
import sys
import traceback
${IMPORT_PY}
from mathutils import Vector


def frame_scene(view):
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type in ("MESH", "CURVE", "SURFACE", "META", "FONT")]
    if scene.camera is None or view:
        pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box] or [Vector((0, 0, 0))]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        centre = (lo + hi) / 2
        radius = max((hi - lo).length / 2, 0.01)
        direction = {
            "front": Vector((0, -1, 0.15)),
            "side": Vector((1, 0, 0.15)),
            "top": Vector((0, -0.01, 1)),
            "iso": Vector((1, -1, 0.8)),
        }.get(view or "iso", Vector((1, -1, 0.8))).normalized()
        cam_data = bpy.data.cameras.new("RedGiant camera")
        cam_data.lens = 50
        cam = bpy.data.objects.new("RedGiant camera", cam_data)
        scene.collection.objects.link(cam)
        distance = radius / math.tan(cam_data.angle / 2) * 1.15
        cam.location = centre + direction * distance
        cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam_data.clip_end = distance * 4 + radius * 4
        scene.camera = cam
        return cam, centre
    return scene.camera, None


def light_scene():
    scene = bpy.context.scene
    if any(o.type == "LIGHT" for o in scene.objects):
        return
    sun = bpy.data.objects.new("RedGiant sun", bpy.data.lights.new("RedGiant sun", "SUN"))
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    if scene.world is None:
        scene.world = bpy.data.worlds.new("RedGiant world")
    scene.world.color = (0.6, 0.6, 0.6)


def render(spec, out):
    scene = bpy.context.scene
    r = spec["render"]
    engine = r.get("engine", "cycles")
    if engine == "eevee":
        try:
            scene.render.engine = "BLENDER_EEVEE"
        except TypeError:
            scene.render.engine = "BLENDER_EEVEE_NEXT"
    else:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = int(r.get("samples", 32))
        scene.cycles.use_denoising = True
    scene.render.resolution_x = int(r.get("width", 960))
    scene.render.resolution_y = int(r.get("height", 720))
    scene.render.resolution_percentage = 100
    cam, centre = frame_scene(r.get("view"))
    light_scene()
    if r.get("turntable"):
        frames = int(r.get("frames", 48))
        scene.frame_start, scene.frame_end = 1, frames
        scene.render.fps = 24
        bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
        pivot = bpy.data.objects.new("RedGiant pivot", None)
        scene.collection.objects.link(pivot)
        pivot.location = centre if centre is not None else Vector((0, 0, 0))
        # The pivot does not turn yet: the camera keeps its place relative to it.
        cam.parent = pivot
        cam.location = cam.location - pivot.location
        pivot.rotation_euler = (0, 0, 0)
        pivot.keyframe_insert("rotation_euler", frame=1)
        pivot.rotation_euler = (0, 0, math.radians(360) * (frames - 1) / frames)
        pivot.keyframe_insert("rotation_euler", frame=frames)
        s = scene.render.image_settings
        if hasattr(s, "media_type"):
            s.media_type = "VIDEO"
        s.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "WEBM"
        scene.render.ffmpeg.codec = "WEBM"
        scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
        scene.render.filepath = out + ".webm"
        bpy.ops.render.render(animation=True)
        return out + ".webm"
    s = scene.render.image_settings
    if hasattr(s, "media_type"):
        s.media_type = "IMAGE"
    s.file_format = "PNG"
    scene.render.filepath = out + ".png"
    bpy.ops.render.render(write_still=True)
    return out + ".png"


def main():
    spec = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
    made = []
    if spec.get("file"):
        load(spec["file"])
    if spec.get("script"):
        code = open(spec["script"], encoding="utf-8").read()
        exec(compile(code, spec["script"], "exec"), {"__name__": "__main__", "bpy": bpy})
    out = spec["out"]
    if spec.get("save_blend"):
        bpy.ops.wm.save_as_mainfile(filepath=out + ".blend", copy=True)
        made.append(out + ".blend")
    if spec.get("glb"):
        export_glb(out + ".glb")
        made.append(out + ".glb")
    if spec.get("render"):
        made.append(render(spec, out))
    print("REDGIANT_RESULT " + json.dumps(made), flush=True)


code = 0
try:
    main()
except Exception:
    traceback.print_exc()
    code = 1
sys.stdout.flush()
sys.stderr.flush()
os._exit(code)
`;

/** Half the computer's cores (at least one): Blender never takes the whole machine. */
export const blenderThreads = () => Math.max(1, Math.floor(availableParallelism() / 2));

export const commands = {
  /** `blender -b --factory-startup -noaudio -t <threads> -P <script> -- <args>`: no window, no settings. */
  script(script: string, args: string[], threads: number = blenderThreads()) {
    return [
      "-b",
      "--factory-startup",
      "-noaudio",
      "-t",
      String(threads),
      "-P",
      script,
      "--",
      ...args,
    ];
  },
};

/** A number the model may write as a string ("960"). */
const num = (min: number, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v),
    z.number().int().min(min).max(max),
  );
const flag = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());

const Render = z.object({
  turntable: flag.optional(),
  view: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.enum(["front", "side", "top", "iso"]),
    )
    .optional(),
  width: num(16, 3840).optional(),
  height: num(16, 3840).optional(),
  samples: num(1, 4096).optional(),
  frames: num(2, 240).optional(),
  engine: z
    .preprocess(
      (v) =>
        typeof v === "string"
          ? v
              .toLowerCase()
              .replace(/^blender_/, "")
              .replace(/_next$/, "")
          : v,
      z.enum(["cycles", "eevee"]),
    )
    .optional(),
});

/**
 * What models really send for `render` (p3.3.1, «Invalid input» for every value): true, an
 * object, but often the same as a string ("true", '{"samples": 64}') when the schema had no
 * type, or a word ("png", "turntable"). All of them mean the same render.
 */
export function renderValue(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (/^[{[]/.test(t)) {
      try {
        return renderValue(JSON.parse(t));
      } catch {
        return v;
      }
    }
    const w = t.toLowerCase();
    if (["", "false", "no", "none", "0"].includes(w)) return false;
    if (["true", "yes", "1", "png", "still", "image"].includes(w)) return true;
    if (["turntable", "360", "webm", "video", "turn"].includes(w)) return { turntable: true };
    return v;
  }
  if (v === null) return false;
  return v;
}

const BlenderInput = z.object({
  script: z.string().max(200_000).optional(),
  file: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  render: z.preprocess(renderValue, z.union([z.boolean(), Render])).optional(),
  show: flag.optional(),
  timeout_s: num(10, 1800).optional(),
});

export interface BlenderToolDeps {
  programs: Programs;
  /** The canvas (show_file's host): the result opens there when asked. */
  show?: ShowFileHost;
  threads?: number;
}

const fail = (content: string) => ({ content, isError: true });
const stemOf = (p: string) => posix.basename(p).replace(/\.[^.]+$/, "");

/** The agents' Blender: a bpy script and/or a render, on a file of the project or a new scene. */
export function blenderTool(ws: Workspace, d: BlenderToolDeps): Tool {
  return {
    def: {
      name: "blender",
      description:
        "Run Blender without a window in your workspace: a bpy script, optionally on a 3D file (blend, glb, obj, fbx, stl, ply, usd, abc). Saves out.blend and out.glb; render: a PNG or a 360° WebM. show: open the result in the canvas.",
      inputSchema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Python using bpy" },
          file: { type: "string" },
          out: { type: "string", description: "Output path without extension" },
          render: {
            type: "object",
            description:
              "Render too: {} for a still PNG (or true), {turntable: true} for a 360° WebM. All optional.",
            properties: {
              turntable: { type: "boolean" },
              view: { type: "string", enum: ["front", "side", "top", "iso"] },
              width: { type: "integer", description: "pixels, default 960" },
              height: { type: "integer", description: "pixels, default 720" },
              samples: { type: "integer", description: "Cycles samples, default 32" },
              frames: { type: "integer", description: "turntable frames, default 48" },
              engine: { type: "string", enum: ["cycles", "eevee"] },
            },
          },
          show: { type: "boolean" },
          timeout_s: { type: "number" },
        },
      },
    },
    schema: BlenderInput,
    async run(i: z.infer<typeof BlenderInput>, ctx: ToolContext) {
      if (ws.readOnly) return fail("This workspace is read-only.");
      if (!i.script && !i.file && !i.render)
        return fail("Give a script, a file, or render (or several).");
      if (i.file) {
        if (!(await ws.isFile(i.file).catch(() => false)))
          return fail(`There is no file "${i.file}" in your workspace.`);
        const ext = posix.extname(i.file).slice(1).toLowerCase();
        if (!BLENDER_INPUTS.includes(ext))
          return fail(`Blender reads ${BLENDER_INPUTS.join(", ")}; not .${ext}.`);
      }
      const out = (i.out ?? posix.join("blender", stemOf(i.file ?? "scene"))).replace(
        /\.(blend|glb|png|webm)$/i,
        "",
      );
      // The outputs stay inside the workspace (its own path checks).
      if (!(await ws.exists(posix.dirname(out) || ".").catch(() => false)))
        await ws.writeText(posix.join(posix.dirname(out), ".keep"), "").catch(() => {});
      let program: string;
      try {
        program = await d.programs.ensure(ctx.ownerId, "blender");
      } catch (err) {
        return fail((err as Error).message);
      }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const tmp = `.redgiant-blender/${id}`;
      const render = i.render === true ? {} : i.render || undefined;
      const spec = {
        ...(i.file && { file: i.file }),
        ...(i.script && { script: `${tmp}/script.py` }),
        out,
        // A .blend is saved when something changed it, or it came from another format.
        save_blend: Boolean(i.script) || !i.file?.toLowerCase().endsWith(".blend"),
        glb: true,
        ...(render && { render }),
      };
      try {
        await ws.writeText(`${tmp}/run.py`, BLENDER_RUN_SCRIPT);
        await ws.writeText(`${tmp}/spec.json`, JSON.stringify(spec));
        if (i.script) await ws.writeText(`${tmp}/script.py`, i.script);
        const r = await ws.execFile(
          program,
          commands.script(`${tmp}/run.py`, [`${tmp}/spec.json`], d.threads ?? blenderThreads()),
          { timeoutMs: (i.timeout_s ?? 600) * 1000, signal: ctx.signal },
        );
        const log = `${r.stdout}\n${r.stderr}`;
        const made = log.match(/REDGIANT_RESULT (\[.*\])/)?.[1];
        const own = log
          .split("\n")
          .filter((l) => !/^(Blender |Read |Fra:|Saved:|Time:|REDGIANT_RESULT|\s*$)/.test(l))
          .slice(-30)
          .join("\n");
        if (r.timedOut)
          return fail(`Blender went past ${i.timeout_s ?? 600} s and was stopped.\n${own}`);
        if (r.exitCode !== 0 || !made)
          return fail(
            r.exitCode === 127
              ? "Blender cannot run where your commands run (this sandbox has no Blender)."
              : `Blender stopped (${r.exitCode ?? "killed"}):\n${own.slice(-3000)}`,
          );
        const files = (JSON.parse(made) as string[]).map((p) => p.replace(/\\/g, "/"));
        let shown = "";
        if (i.show && d.show) {
          const pick =
            files.find((f) => /\.(png|webm)$/.test(f)) ?? files.find((f) => f.endsWith(".glb"));
          if (pick) {
            const res = await showFileTool(ws, "compact", d.show)
              .run({ path: pick }, ctx)
              .catch((err: Error) => ({ content: err.message }));
            shown = `\n${typeof res === "string" ? res : (res as { content: string }).content}`;
          }
        }
        return (
          [
            "Blender finished:",
            ...files.map((f) => `- ${f}`),
            ...(own.trim() ? ["Output:", own.slice(-2000)] : []),
          ].join("\n") + shown
        );
      } finally {
        await rm(join(ws.root, tmp), { recursive: true, force: true }).catch(() => {});
        // The parent too, once empty (another run may still use it).
        await rmdir(join(ws.root, ".redgiant-blender")).catch(() => {});
      }
    },
  } as Tool;
}
