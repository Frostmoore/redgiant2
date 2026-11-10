// 3D models in the editor (G37.7): the `model` family. glTF 2.0 is the open format the editor
// keeps (.gltf text or .glb binary); other formats (OBJ, STL, PLY, FBX, .blend…) are edited on a
// GLB copy beside them. The server keeps the file's own glTF JSON (every member it did not touch
// is written back as it was: unknown extensions, extras, number spellings) and the binary chunk
// as it came; the page shows it with three.js and sends the same actions. Actions are small edits
// of the JSON by path, each with an exact inverse. Indices in glTF's top-level arrays (nodes,
// meshes, materials…) never shift: those arrays only grow at their end (and shrink there, an
// undo), and deleting an object detaches its node from the scene (the node stays in the file,
// out of every scene, which glTF allows).
import { z } from "zod";

export const MODEL_ENGINE = "gltf-json";
export const MODEL_ENGINE_VERSION = "1";

const Key = z.union([z.string().min(1).max(200), z.number().int().nonnegative()]);
const Path = z.array(Key).max(40);

const plain = {
  /**
   * The value at `path` (an object's member or an array's element) replaced; without `value` an
   * object's member is removed. `at`: where a new member goes among its object's members (an undo
   * puts a removed member back in its place).
   */
  set: z.object({
    t: z.literal("set"),
    path: Path.min(1),
    value: z.unknown().optional(),
    at: z.number().int().nonnegative().optional(),
  }),
  /** `value` put into the array at `path`, at index `at`. */
  ins: z.object({
    t: z.literal("ins"),
    path: Path,
    at: z.number().int().nonnegative(),
    value: z.unknown(),
  }),
  /** The element `at` taken out of the array at `path`. */
  del: z.object({ t: z.literal("del"), path: Path, at: z.number().int().nonnegative() }),
  /** The whole JSON (a change from outside, kept to be undone); the binary chunk stays. */
  doc: z.object({ t: z.literal("doc"), json: z.string().max(60_000_000) }),
};

export const ModelPlainAction = z.discriminatedUnion("t", [
  plain.set,
  plain.ins,
  plain.del,
  plain.doc,
]);
export type ModelPlainAction = z.infer<typeof ModelPlainAction>;

export const ModelAction = z.discriminatedUnion("t", [
  ...ModelPlainAction.options,
  z.object({ t: z.literal("batch"), ops: z.array(ModelPlainAction).max(20_000) }),
]);
export type ModelAction = z.infer<typeof ModelAction>;

export const ModelDocOp = z.object({
  family: z.literal("model"),
  engine: z.literal(MODEL_ENGINE),
  engineVersion: z.string().max(40),
  op: ModelAction,
});
export type ModelDocOp = z.infer<typeof ModelDocOp>;

export const ModelSnapshot = z.object({
  family: z.literal("model"),
  /** glb (binary, the page reads the binary chunk from the file) or gltf (text). */
  container: z.enum(["glb", "gltf"]),
  /** The glTF JSON as the host has it now. */
  json: z.string(),
});
export type ModelSnapshot = z.infer<typeof ModelSnapshot>;

/** What a model's change was, for the panel's words (`DocSummary.model`). */
export const ModelChange = z.object({
  action: z.enum([
    "add",
    "delete",
    "transform",
    "material",
    "light",
    "camera",
    "rename",
    "reparent",
    "duplicate",
    "change",
    "replace",
  ]),
  /** Objects touched. */
  n: z.number().int().nonnegative(),
  /** What they are, when they are all of one kind. */
  kind: z.enum(["mesh", "light", "camera", "group", "material"]).optional(),
  /** The one object's name. */
  name: z.string().max(200).optional(),
  /** The one object's id (n3, m2). */
  id: z.string().max(40).optional(),
});
export type ModelChange = z.infer<typeof ModelChange>;

// -------------------------------------------------------------------------------------------
// The JSON, read and changed without touching what an action does not name.

type Json = unknown;
type Obj = Record<string, unknown>;
type Seg = string | number;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** glTF's arrays whose indices other parts point at: they only grow or shrink at their end. */
const COLLECTIONS = new Set([
  "accessors",
  "animations",
  "buffers",
  "bufferViews",
  "cameras",
  "images",
  "materials",
  "meshes",
  "nodes",
  "samplers",
  "scenes",
  "skins",
  "textures",
]);

/** Whether `path` names one of the collections (KHR_lights_punctual's lights included). */
export function isModelCollection(path: readonly Seg[]): boolean {
  if (path.length === 1) return COLLECTIONS.has(String(path[0]));
  return (
    path.length === 3 &&
    path[0] === "extensions" &&
    path[1] === "KHR_lights_punctual" &&
    path[2] === "lights"
  );
}

/** The value at a path (undefined when there is none). */
export function modelGet(root: Json, path: readonly Seg[]): Json {
  let at: Json = root;
  for (const k of path) {
    if (Array.isArray(at) && typeof k === "number") at = at[k];
    else if (isObj(at) && typeof k === "string") at = Object.hasOwn(at, k) ? at[k] : undefined;
    else return undefined;
  }
  return at;
}

/** What applying gets told: a container copied (the server keeps its layout for the copy). */
export interface ModelHooks {
  copied?(from: object, to: object): void;
  /** A `doc` action's JSON read (the server's reader keeps the text's layout). */
  parse?(json: string): Json;
  /** The JSON as text (a `doc` action's inverse). */
  print?(root: Json): string;
}

function copyOf<T extends object>(v: T, hooks?: ModelHooks): T {
  const c = (Array.isArray(v) ? v.slice() : { ...v }) as T;
  hooks?.copied?.(v, c);
  return c;
}

/** An object with a member set, kept at its place, or put at `at` among the others. */
function withMember(o: Obj, key: string, value: Json, at: number | undefined, hooks?: ModelHooks) {
  if (Object.hasOwn(o, key) || at === undefined || at >= Object.keys(o).length) {
    const c = copyOf(o, hooks);
    c[key] = value;
    return c;
  }
  const out: Obj = {};
  let i = 0;
  for (const [k, v] of Object.entries(o)) {
    if (i === at) out[key] = value;
    out[k] = v;
    i++;
  }
  hooks?.copied?.(o, out);
  return out;
}

function withoutMember(o: Obj, key: string, hooks?: ModelHooks): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) if (k !== key) out[k] = v;
  hooks?.copied?.(o, out);
  return out;
}

/** Copies the containers along `path` and gives the last one to `change` (copy on write). */
function update(root: Json, path: readonly Seg[], change: (c: Json) => Json, hooks?: ModelHooks) {
  if (path.length === 0) return change(root);
  const [k, ...rest] = path as [Seg, ...Seg[]];
  if (Array.isArray(root) && typeof k === "number") {
    const c = copyOf(root, hooks);
    c[k] = update(root[k], rest, change, hooks);
    return c;
  }
  if (isObj(root) && typeof k === "string") {
    const c = copyOf(root, hooks);
    c[k] = update(root[k], rest, change, hooks);
    return c;
  }
  throw new Error(`no ${String(k)} there`);
}

function applyPlain(root: Json, a: ModelPlainAction, hooks?: ModelHooks): Json {
  switch (a.t) {
    case "doc":
      return hooks?.parse ? hooks.parse(a.json) : JSON.parse(a.json);
    case "set": {
      const key = a.path[a.path.length - 1] as Seg;
      return update(
        root,
        a.path.slice(0, -1),
        (c) => {
          if (Array.isArray(c) && typeof key === "number") {
            const x = copyOf(c, hooks);
            x[key] = a.value;
            return x;
          }
          if (isObj(c) && typeof key === "string")
            return a.value === undefined
              ? withoutMember(c, key, hooks)
              : withMember(c, key, a.value, a.at, hooks);
          throw new Error("no such place");
        },
        hooks,
      );
    }
    case "ins":
      return update(
        root,
        a.path,
        (c) => {
          if (!Array.isArray(c)) throw new Error("not a list");
          const x = copyOf(c, hooks);
          x.splice(a.at, 0, a.value);
          return x;
        },
        hooks,
      );
    case "del":
      return update(
        root,
        a.path,
        (c) => {
          if (!Array.isArray(c)) throw new Error("not a list");
          const x = copyOf(c, hooks);
          x.splice(a.at, 1);
          return x;
        },
        hooks,
      );
  }
}

export const modelPlainOf = (a: ModelAction): ModelPlainAction[] => (a.t === "batch" ? a.ops : [a]);

/** The JSON after an action (the one before is never changed). */
export function applyModelAction(root: Json, a: ModelAction, hooks?: ModelHooks): Json {
  return modelPlainOf(a).reduce((r, p) => applyPlain(r, p, hooks), root);
}

const keyIndex = (o: Obj, key: string) => Object.keys(o).indexOf(key);

function invertPlain(root: Json, a: ModelPlainAction, hooks?: ModelHooks): ModelPlainAction {
  switch (a.t) {
    case "doc":
      return { t: "doc", json: hooks?.print ? hooks.print(root) : JSON.stringify(root) };
    case "set": {
      const parent = modelGet(root, a.path.slice(0, -1));
      const key = a.path[a.path.length - 1] as Seg;
      const old = modelGet(root, a.path);
      if (old === undefined) return { t: "set", path: a.path };
      const at = isObj(parent) && typeof key === "string" ? keyIndex(parent, key) : undefined;
      return {
        t: "set",
        path: a.path,
        value: old,
        ...(at !== undefined && at >= 0 && a.value === undefined && { at }),
      };
    }
    case "ins":
      return { t: "del", path: a.path, at: a.at };
    case "del":
      return { t: "ins", path: a.path, at: a.at, value: modelGet(root, [...a.path, a.at]) };
  }
}

/** The action that undoes `a`, made on the JSON before it. */
export function invertModelAction(root: Json, a: ModelAction, hooks?: ModelHooks): ModelAction {
  if (a.t !== "batch") return invertPlain(root, a, hooks);
  const out: ModelPlainAction[] = [];
  let r = root;
  for (const p of a.ops) {
    out.unshift(invertPlain(r, p, hooks));
    r = applyPlain(r, p, hooks);
  }
  return { t: "batch", ops: out };
}

/** A URI an agent or the page may write: inside the file (data:) or a file beside it. */
export function modelUriAllowed(uri: string): boolean {
  if (/^data:/i.test(uri)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/") || uri.startsWith("\\")) return false;
  return !decodeURIComponent(uri)
    .split(/[\\/]/)
    .some((p) => p === "..");
}

function badUri(v: Json, depth = 0): string | undefined {
  if (depth > 60) return "the value is nested too deep";
  if (Array.isArray(v)) {
    for (const x of v) {
      const b = badUri(x, depth + 1);
      if (b) return b;
    }
    return undefined;
  }
  if (!isObj(v)) return undefined;
  for (const [k, x] of Object.entries(v)) {
    if (k === "uri" && typeof x === "string" && !modelUriAllowed(x))
      return `a uri must stay inside the model or beside it (data: or a relative path): ${x.slice(0, 80)}`;
    const b = badUri(x, depth + 1);
    if (b) return b;
  }
  return undefined;
}

function checkPlain(root: Json, a: ModelPlainAction): string | undefined {
  if (a.t === "doc") {
    try {
      const v = JSON.parse(a.json);
      if (!isObj(v)) return "the JSON is not an object";
      return badUri(v);
    } catch {
      return "the JSON is not readable";
    }
  }
  if (a.t === "set") {
    const parent = modelGet(root, a.path.slice(0, -1));
    const key = a.path[a.path.length - 1] as Seg;
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key >= parent.length)
        return `there is no element ${String(key)} at ${a.path.slice(0, -1).join("/")}`;
      if (a.value === undefined) return "an element of a list is taken out with del";
    } else if (!isObj(parent) || typeof key !== "string")
      return `there is nothing at ${a.path.slice(0, -1).join("/") || "the root"}`;
    if (isModelCollection(a.path) && a.value !== undefined && modelGet(root, a.path) !== undefined)
      return `${a.path.join("/")} is not replaced whole (its indices are used elsewhere)`;
    if (key === "uri" && typeof a.value === "string" && !modelUriAllowed(a.value))
      return badUri({ uri: a.value });
    return a.value === undefined ? undefined : badUri(a.value);
  }
  const list = modelGet(root, a.path);
  if (!Array.isArray(list)) return `there is no list at ${a.path.join("/")}`;
  const coll = isModelCollection(a.path);
  if (a.t === "ins") {
    if (a.at > list.length) return `${a.path.join("/")} has ${list.length} elements`;
    if (coll && a.at !== list.length)
      return `${a.path.join("/")} only grows at its end (it has ${list.length})`;
    return badUri(a.value);
  }
  if (a.at >= list.length) return `${a.path.join("/")} has no element ${a.at}`;
  if (coll && a.at !== list.length - 1)
    return `only the last of ${a.path.join("/")} can be taken out (others point at the rest)`;
  return undefined;
}

/** Why an action cannot apply (undefined: it can). */
export function checkModelAction(root: Json, a: ModelAction): string | undefined {
  let r = root;
  for (const p of modelPlainOf(a)) {
    const why = checkPlain(r, p);
    if (why) return why;
    try {
      r = applyPlain(r, p);
    } catch (e) {
      return (e as Error).message;
    }
  }
  return undefined;
}

/**
 * The places an action touches: an element of a collection (nodes/3, materials/1, lights/0), a
 * collection growing (nodes/+), another top member (asset, extensionsUsed), or "*" (all).
 */
export function modelTouched(list: readonly ModelAction[]): Set<string> {
  const out = new Set<string>();
  for (const a of list.flatMap(modelPlainOf)) {
    if (a.t === "doc") {
      out.add("*");
      continue;
    }
    const p = a.path;
    const lights = p[0] === "extensions" && p[1] === "KHR_lights_punctual" && p[2] === "lights";
    const base = lights ? ["lights", ...p.slice(3)] : p;
    const coll = lights || COLLECTIONS.has(String(p[0]));
    if (!coll) {
      out.add(String(base[0]));
      continue;
    }
    if (base.length === 1 || (lights && p.length === 3)) out.add(`${base[0]}/+`);
    else out.add(`${base[0]}/${String(base[1])}`);
  }
  return out;
}

/** Node indices an action names (the page outlines the agents' changes). */
export function modelTouchedNodes(list: readonly ModelAction[]): Set<number> {
  const out = new Set<number>();
  for (const a of list.flatMap(modelPlainOf)) {
    if (a.t === "doc") continue;
    if (a.path[0] === "nodes" && typeof a.path[1] === "number") out.add(a.path[1]);
    if (a.t === "ins" && (a.path[0] === "nodes" || a.path[0] === "scenes") && a.path.length >= 2)
      if (typeof a.value === "number") out.add(a.value);
    if (a.t === "set" && Array.isArray(a.value) && a.path[a.path.length - 1] === "children")
      for (const n of a.value) if (typeof n === "number") out.add(n);
    if (
      a.t === "set" &&
      a.path.length === 3 &&
      a.path[0] === "scenes" &&
      a.path[2] === "nodes" &&
      Array.isArray(a.value)
    )
      for (const n of a.value) if (typeof n === "number") out.add(n);
  }
  return out;
}

export const modelNodeId = (i: number) => `n${i}`;
export const modelMaterialId = (i: number) => `m${i}`;

/** n3 → 3; a plain number too. */
export function modelIndexOf(ref: unknown, prefix: "n" | "m"): number | undefined {
  if (typeof ref === "number" && Number.isInteger(ref) && ref >= 0) return ref;
  if (typeof ref !== "string") return undefined;
  const m = ref.trim().match(new RegExp(`^${prefix}?(\\d+)$`));
  return m ? Number(m[1]) : undefined;
}

// -------------------------------------------------------------------------------------------
// Building blocks the page and the agents' operations share: the actions that add things.

type Act = ModelPlainAction;

const arr = (v: Json): unknown[] => (Array.isArray(v) ? v : []);

/** Appends to a collection (making it when the file has none): the actions and the new index. */
export function modelPush(root: Json, path: Seg[], value: Json): { acts: Act[]; index: number } {
  const list = modelGet(root, path);
  if (Array.isArray(list))
    return { acts: [{ t: "ins", path, at: list.length, value }], index: list.length };
  // The containers above it, made when missing (extensions → KHR_lights_punctual → lights).
  for (let i = path.length - 1; i >= 0; i--) {
    const above = path.slice(0, i);
    if (isObj(modelGet(root, above))) {
      let v: Json = [value];
      for (let j = path.length - 1; j > i; j--) v = { [String(path[j])]: v };
      return { acts: [{ t: "set", path: path.slice(0, i + 1), value: v }], index: 0 };
    }
  }
  throw new Error("the model has no root object");
}

/** The scene the editor shows (the file's default, else the first). */
export const modelSceneIndex = (root: Json): number => {
  const s = isObj(root) ? root.scene : undefined;
  return typeof s === "number" ? s : 0;
};

/** Where a node is attached now: its parent node, or the scene (undefined: nowhere). */
export function modelParentOf(
  root: Json,
  node: number,
): { path: Seg[]; at: number; parent: number | "scene" } | undefined {
  const nodes = arr(isObj(root) ? root.nodes : undefined);
  for (const [i, n] of nodes.entries()) {
    const c = arr(isObj(n) ? n.children : undefined);
    const at = c.indexOf(node);
    if (at >= 0) return { path: ["nodes", i, "children"], at, parent: i };
  }
  const scenes = arr(isObj(root) ? root.scenes : undefined);
  const s = modelSceneIndex(root);
  const order = [s, ...scenes.keys()].filter((x, k, all) => all.indexOf(x) === k);
  for (const si of order) {
    const sc = scenes[si];
    const at = arr(isObj(sc) ? sc.nodes : undefined).indexOf(node);
    if (at >= 0) return { path: ["scenes", si, "nodes"], at, parent: "scene" };
  }
  return undefined;
}

/** The actions that take a node out of where it hangs (glTF lists are never left empty). */
export function modelDetach(root: Json, node: number): Act[] {
  const p = modelParentOf(root, node);
  if (!p) return [];
  const list = arr(modelGet(root, p.path));
  return list.length === 1 ? [{ t: "set", path: p.path }] : [{ t: "del", path: p.path, at: p.at }];
}

/** The actions that hang a node under `parent` (a node, or the scene), before `before` or last. */
export function modelAttach(
  root: Json,
  node: number,
  parent: number | "scene",
  before?: number,
): Act[] {
  let path: Seg[];
  if (parent === "scene") {
    const scenes = arr(isObj(root) ? root.scenes : undefined);
    if (!scenes.length) {
      const acts: Act[] = [{ t: "set", path: ["scenes"], value: [{ nodes: [node] }] }];
      if (!isObj(root) || root.scene === undefined)
        acts.push({ t: "set", path: ["scene"], value: 0 });
      return acts;
    }
    path = ["scenes", modelSceneIndex(root), "nodes"];
  } else path = ["nodes", parent, "children"];
  const list = modelGet(root, path);
  if (!Array.isArray(list)) return [{ t: "set", path, value: [node] }];
  const at = before === undefined ? -1 : list.indexOf(before);
  return [{ t: "ins", path, at: at < 0 ? list.length : at, value: node }];
}

/** Applies a list of plain actions (to build the next on the JSON the first left). */
export const modelRun = (root: Json, acts: readonly Act[]): Json =>
  acts.reduce((r, a) => applyPlain(r, a), root);

/** A node added and hung under `parent`: the actions and its index. */
export function modelAddNode(
  root: Json,
  node: Obj,
  parent: number | "scene" = "scene",
): { acts: Act[]; index: number } {
  const push = modelPush(root, ["nodes"], node);
  const after = modelRun(root, push.acts);
  return { acts: [...push.acts, ...modelAttach(after, push.index, parent)], index: push.index };
}

/** Marks an extension as used (once). */
export function modelUseExtension(root: Json, name: string): Act[] {
  const used = isObj(root) ? root.extensionsUsed : undefined;
  if (!Array.isArray(used)) return [{ t: "set", path: ["extensionsUsed"], value: [name] }];
  return used.includes(name)
    ? []
    : [{ t: "ins", path: ["extensionsUsed"], at: used.length, value: name }];
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes as base64 (no Buffer, no btoa: the same in the page and in Node). */
export function modelBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    out += B64[n >> 18] + (B64[(n >> 12) & 63] as string) + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = ((b[i] as number) << 16) | ((i + 1 < b.length ? (b[i + 1] as number) : 0) << 8);
    out += B64[n >> 18] + (B64[(n >> 12) & 63] as string);
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

/** Geometry as plain arrays (three.js's attributes, or the agent's numbers). */
export interface ModelGeometry {
  position: ArrayLike<number>;
  normal?: ArrayLike<number> | undefined;
  uv?: ArrayLike<number> | undefined;
  index?: ArrayLike<number> | undefined;
  /** glTF's primitive mode: 4 triangles (the default), 0 points, 1 lines. */
  mode?: number | undefined;
}

/** A PBR material in glTF's words. */
export interface ModelMaterialSpec {
  name?: string | undefined;
  /** Linear RGBA, 0-1. */
  color?: [number, number, number, number] | undefined;
  metallic?: number | undefined;
  roughness?: number | undefined;
  emissive?: [number, number, number] | undefined;
  doubleSided?: boolean | undefined;
}

export const round6 = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

export function modelMaterialJson(m: ModelMaterialSpec): Obj {
  const pbr: Obj = {};
  if (m.color) pbr.baseColorFactor = m.color.map(round6);
  pbr.metallicFactor = round6(m.metallic ?? 0);
  pbr.roughnessFactor = round6(m.roughness ?? 0.6);
  return {
    ...(m.name && { name: m.name }),
    pbrMetallicRoughness: pbr,
    ...(m.emissive && { emissiveFactor: m.emissive.map(round6) }),
    ...(m.color && m.color[3] < 1 && { alphaMode: "BLEND" }),
    ...(m.doubleSided && { doubleSided: true }),
  };
}

/**
 * A mesh from plain arrays as glTF: its own buffer (a data: URI inside the file, so nothing else
 * in the file moves), views, accessors (POSITION with its min and max), the mesh and, when
 * asked, a material; then a node for it under `parent`.
 */
export function modelAddMesh(
  root: Json,
  geo: ModelGeometry,
  o: {
    node: Obj;
    material?: ModelMaterialSpec | number | undefined;
    parent?: number | "scene" | undefined;
    meshName?: string | undefined;
  },
): { acts: Act[]; node: number; mesh: number; material?: number } {
  const count = Math.floor(geo.position.length / 3);
  if (count < 1) throw new Error("a mesh needs at least one point");
  const parts: { bytes: Uint8Array; target?: number; stride?: number }[] = [];
  const f32 = (a: ArrayLike<number>) => new Uint8Array(Float32Array.from(a).buffer);
  const pos = Float32Array.from(geo.position);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k] as number;
      if (!Number.isFinite(v)) throw new Error("a point is not a number");
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  parts.push({ bytes: new Uint8Array(pos.buffer), target: 34962 });
  const hasNormal = !!geo.normal && geo.normal.length === count * 3;
  if (hasNormal) parts.push({ bytes: f32(geo.normal as ArrayLike<number>), target: 34962 });
  const hasUv = !!geo.uv && geo.uv.length === count * 2;
  if (hasUv) parts.push({ bytes: f32(geo.uv as ArrayLike<number>), target: 34962 });
  let indexType = 0;
  if (geo.index?.length) {
    for (let i = 0; i < geo.index.length; i++) {
      const n = geo.index[i] as number;
      if (!Number.isInteger(n) || n < 0 || n >= count)
        throw new Error("an index is out of the points");
    }
    const big = count > 65535;
    indexType = big ? 5125 : 5123;
    const ix = big ? Uint32Array.from(geo.index) : Uint16Array.from(geo.index);
    parts.push({ bytes: new Uint8Array(ix.buffer, 0, ix.byteLength), target: 34963 });
  }
  let total = 0;
  const offsets: number[] = [];
  for (const p of parts) {
    offsets.push(total);
    total += Math.ceil(p.bytes.length / 4) * 4;
  }
  const all = new Uint8Array(total);
  parts.forEach((p, i) => {
    all.set(p.bytes, offsets[i]);
  });

  let r = root;
  const acts: Act[] = [];
  const add = (path: Seg[], value: Json) => {
    const p = modelPush(r, path, value);
    acts.push(...p.acts);
    r = modelRun(r, p.acts);
    return p.index;
  };
  const buffer = add(["buffers"], {
    byteLength: total,
    uri: `data:application/octet-stream;base64,${modelBase64(all)}`,
  });
  const views = parts.map((p, i) =>
    add(["bufferViews"], {
      buffer,
      byteOffset: offsets[i],
      byteLength: p.bytes.length,
      ...(p.target && { target: p.target }),
    }),
  );
  let v = 0;
  const attributes: Obj = {};
  attributes.POSITION = add(["accessors"], {
    bufferView: views[v++],
    componentType: 5126,
    count,
    type: "VEC3",
    min: min.map(round6),
    max: max.map(round6),
  });
  if (hasNormal)
    attributes.NORMAL = add(["accessors"], {
      bufferView: views[v++],
      componentType: 5126,
      count,
      type: "VEC3",
    });
  if (hasUv)
    attributes.TEXCOORD_0 = add(["accessors"], {
      bufferView: views[v++],
      componentType: 5126,
      count,
      type: "VEC2",
    });
  const indices = indexType
    ? add(["accessors"], {
        bufferView: views[v++],
        componentType: indexType,
        count: geo.index?.length ?? 0,
        type: "SCALAR",
      })
    : undefined;
  let material: number | undefined;
  if (typeof o.material === "number") material = o.material;
  else if (o.material) material = add(["materials"], modelMaterialJson(o.material));
  const mesh = add(["meshes"], {
    ...(o.meshName && { name: o.meshName }),
    primitives: [
      {
        attributes,
        ...(indices !== undefined && { indices }),
        ...(material !== undefined && { material }),
        ...(geo.mode !== undefined && geo.mode !== 4 && { mode: geo.mode }),
      },
    ],
  });
  const n = modelAddNode(r, { ...o.node, mesh }, o.parent ?? "scene");
  acts.push(...n.acts);
  return { acts, node: n.index, mesh, ...(material !== undefined && { material }) };
}
