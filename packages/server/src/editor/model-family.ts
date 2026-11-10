// The 3D family (G37.7): glTF models (.gltf text, .glb binary) edited in place, and the GLB copy of
// the other formats (`x.obj.open/x.glb`, `x.fbx.open/x.glb`) the same way. The host keeps the
// file's own glTF JSON (model/gltf.ts): actions change only the members they name, the binary
// chunk is never rewritten, and saving writes every other byte as it was. The page shows the
// model with three.js and sends the same actions; the server never writes the file from three.js.
import { basename, dirname, extname } from "node:path";
import {
  type DocOp,
  type DocSummary,
  MODEL_ENGINE,
  MODEL_ENGINE_VERSION,
  type ModelAction,
  type ModelDocOp,
} from "@redgiant/protocol";
import type { DocFamily, Loaded, PrepareContext } from "./family.js";
import { MODEL_CATALOG, modelFromAgent, prepareModelOps } from "./model/agent.js";
import { readGltf, writeGltf, writeJson } from "./model/gltf.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  composeActions,
  describe,
  invertAction,
  type ModelModel,
  mapAction,
} from "./model/ops.js";
import { modelStructure } from "./model/structure.js";

/** The biggest model the editor opens. */
export const MAX_MODEL_BYTES = 256 * 1024 * 1024;
/** 3D formats edited on their GLB copy. */
export const MODEL_COPIES = /\.(obj|stl|ply|fbx|blend|usd|usda|usdc|usdz|abc)$/i;

const wrap = (op: ModelAction): ModelDocOp => ({
  family: "model",
  engine: MODEL_ENGINE,
  engineVersion: MODEL_ENGINE_VERSION,
  op,
});
const actionOf = (op: DocOp): ModelAction => {
  if (op.family !== "model") throw new Error("not an operation on a 3D model");
  return op.op;
};

/** Where the GLB copy of another 3D file is (`x.fbx` → `x.fbx.open/x.glb`). */
export function modelCopyOfOriginal(path: string): string | undefined {
  if (!MODEL_COPIES.test(path)) return undefined;
  const b = basename(path);
  return `${path}.open/${b.slice(0, b.lastIndexOf("."))}.glb`;
}

/** The 3D file a GLB copy came from (`x.fbx.open/x.glb` → `x.fbx`). */
export function originalOfModelCopy(path: string): string | undefined {
  const m = dirname(path)
    .replace(/\\/g, "/")
    .match(/^(.*)\.open$/);
  if (!m?.[1] || !MODEL_COPIES.test(m[1])) return undefined;
  return modelCopyOfOriginal(m[1]) === path.replace(/\\/g, "/") ? m[1] : undefined;
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && Buffer.compare(a, b) === 0);

export class ModelFamily implements DocFamily<ModelModel> {
  readonly id = "model" as const;
  readonly engine = MODEL_ENGINE;
  readonly engineVersion = MODEL_ENGINE_VERSION;

  accepts(path: string): boolean {
    const e = extname(path).toLowerCase();
    return e === ".glb" || e === ".gltf";
  }

  load(bytes: Uint8Array): Loaded<ModelModel> {
    if (bytes.length > MAX_MODEL_BYTES)
      throw new Error(`it is over ${MAX_MODEL_BYTES / 1024 / 1024} MB`);
    const file = readGltf(bytes);
    const root = file.json.root as Record<string, unknown> | undefined;
    if (!root || typeof root !== "object" || Array.isArray(root))
      throw new Error("its JSON is not a glTF object");
    const asset = root.asset as { version?: unknown } | undefined;
    if (!asset || !String(asset.version ?? "").startsWith("2"))
      throw new Error("it is not glTF 2.0 (asset.version)");
    return { model: { file }, format: {} };
  }

  save(model: ModelModel): Uint8Array {
    return writeGltf(model.file);
  }

  snapshot(model: ModelModel) {
    return {
      family: "model" as const,
      container: model.file.container,
      json: writeJson(model.file.json),
    };
  }

  check(model: ModelModel, op: DocOp): string | undefined {
    if (op.family !== "model") return "not an operation on a 3D model";
    return checkAction(model, op.op);
  }

  apply(model: ModelModel, op: DocOp): ModelModel {
    return applyAction(model, actionOf(op));
  }

  invert(model: ModelModel, op: DocOp): DocOp {
    return wrap(invertAction(model, actionOf(op)));
  }

  compose(ops: readonly DocOp[]): DocOp {
    return wrap(composeActions(ops.map(actionOf)));
  }

  conflicts(a: DocOp, b: DocOp): boolean {
    return actionsConflict(actionOf(a), actionOf(b));
  }

  map(a: DocOp, b: DocOp): DocOp | undefined {
    const m = mapAction(actionOf(a), actionOf(b));
    return m && wrap(m);
  }

  /** While the person drags or types the agents' edits wait (the whole scene is theirs). */
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
    return "the 3D scene";
  }

  /** A change from outside as one action, when only the JSON changed and it is small. */
  diff(before: ModelModel, after: ModelModel, maxBytes: number): DocOp | undefined {
    if (before.file.container !== after.file.container) return undefined;
    if (!sameBytes(before.file.bin, after.file.bin)) return undefined;
    const json = writeJson(after.file.json);
    return json.length * 2 + writeJson(before.file.json).length * 2 <= maxBytes
      ? wrap({ t: "doc", json })
      : undefined;
  }

  summarize(model: ModelModel, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary {
    const d = describe(model, ops.map(actionOf));
    const k: DocSummary["kind"] =
      d.change.action === "add" || d.change.action === "duplicate"
        ? "insert"
        : d.change.action === "delete"
          ? "delete"
          : d.change.action === "replace"
            ? "replace"
            : "edit";
    return {
      text: d.text,
      kind: kind ?? k,
      model: d.change,
      ...(ops.length > 1 && { count: ops.length }),
    };
  }

  wrote(): [number, number][] {
    return [];
  }

  prepare(ops: readonly unknown[], ctx: PrepareContext): Promise<unknown[]> {
    return prepareModelOps(ops, (p) => ctx.read(p));
  }

  fromAgent(model: ModelModel, ops: readonly unknown[]) {
    const r = modelFromAgent(model.file.json.root, ops);
    if ("error" in r) return r;
    return {
      ops: [
        wrap(
          r.actions.length === 1 ? (r.actions[0] as ModelAction) : { t: "batch", ops: r.actions },
        ),
      ],
    };
  }

  catalog(): string {
    return MODEL_CATALOG;
  }

  structure(
    model: ModelModel,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
  ): string {
    return modelStructure(model.file.json.root, model.file.container, ask);
  }
}

export const modelFamily = new ModelFamily();

/** The original's name for a GLB copy, for the page («Copia GLB di sedia.fbx»). */
export const modelOriginalName = (path: string) => {
  const o = originalOfModelCopy(path);
  return o ? basename(o) : undefined;
};
