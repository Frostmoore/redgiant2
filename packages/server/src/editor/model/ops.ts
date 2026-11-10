// The 3D family's actions on the server (G37.7): applied to the file's own glTF (its layout kept,
// gltf.ts), inverted exactly, checked, rebased, told apart when they meet, and described in words
// for the panel «Modifiche» and the agent.
import {
  applyModelAction,
  checkModelAction,
  invertModelAction,
  type ModelAction,
  type ModelChange,
  type ModelHooks,
  type ModelPlainAction,
  modelGet,
  modelParentOf,
  modelPlainOf,
  modelTouched,
} from "@redgiant/protocol";
import { copiedLayout, type GltfFile, readJson, writeJson } from "./gltf.js";
import { kindOf, nodesOf } from "./structure.js";

export interface ModelModel {
  file: GltfFile;
}

const hooksFor = (f: GltfFile): ModelHooks => ({
  copied: copiedLayout,
  parse: (json) => readJson(json).root,
  print: (root) => writeJson({ ...f.json, root }),
});

export function applyAction(m: ModelModel, a: ModelAction): ModelModel {
  let json = m.file.json;
  for (const p of modelPlainOf(a)) {
    if (p.t === "doc") json = readJson(p.json);
    else json = { ...json, root: applyModelAction(json.root, p, hooksFor(m.file)) };
  }
  return { file: { ...m.file, json } };
}

export const invertAction = (m: ModelModel, a: ModelAction): ModelAction =>
  invertModelAction(m.file.json.root, a, hooksFor(m.file));

export const checkAction = (m: ModelModel, a: ModelAction): string | undefined =>
  checkModelAction(m.file.json.root, a);

export const composeActions = (list: readonly ModelAction[]): ModelAction => ({
  t: "batch",
  ops: list.flatMap(modelPlainOf),
});

/** The places each plain action touches. */
const keyOf = (p: ModelPlainAction): Set<string> => modelTouched([p]);

/**
 * `a`, made on the same model as `b`, moved to apply after it; undefined when they truly meet.
 * Two cases pass although they touch the same places: lists both only grow or shrink by one
 * element (a scene's or a node's children: indices are moved past `b`'s insertions), and an undo
 * of an addition after `b` added to the same collections (its removals at their end are dropped:
 * those elements stay in the file, referenced by nothing, which glTF allows; the object leaves the
 * scene all the same).
 */
function mapSmart(a: ModelAction, b: ModelAction): ModelAction | undefined {
  const x = modelTouched([a]);
  const y = modelTouched([b]);
  if (x.has("*") || y.has("*")) return undefined;
  const overlap = [...x].filter((k) => y.has(k));
  if (!overlap.length) return a;
  const bOps = modelPlainOf(b);
  const out: ModelPlainAction[] = [];
  for (const op of modelPlainOf(a)) {
    const keys = [...keyOf(op)].filter((k) => overlap.includes(k));
    if (!keys.length) {
      out.push(op);
      continue;
    }
    if (keys.length > 1 || op.t === "doc") return undefined;
    const k = keys[0] as string;
    if (k.endsWith("/+")) {
      // A removal at a collection's end, which `b` grew since: left in place.
      if (op.t !== "del") return undefined;
      continue;
    }
    if (op.t !== "del" && op.t !== "ins") return undefined;
    const path = op.path.join("/");
    let at = op.at;
    for (const o of bOps) {
      if (!keyOf(o).has(k)) continue;
      if (o.t !== "ins" || o.path.join("/") !== path) return undefined;
      if (op.t === "del" ? o.at <= at : o.at < at) at++;
    }
    out.push({ ...op, at });
  }
  return out.length === 1 ? (out[0] as ModelPlainAction) : { t: "batch", ops: out };
}

/** Two actions on the same object, or growing the same list, that cannot be moved past each other. */
export function actionsConflict(a: ModelAction, b: ModelAction): boolean {
  return mapSmart(a, b) === undefined;
}

export const mapAction = (a: ModelAction, b: ModelAction): ModelAction | undefined =>
  mapSmart(a, b);

type Obj = Record<string, unknown>;

const nodeKind = (root: unknown, n: Obj): ModelChange["kind"] => {
  const k = kindOf(root, n);
  return k === "mesh"
    ? "mesh"
    : k.startsWith("light")
      ? "light"
      : k.startsWith("camera")
        ? "camera"
        : "group";
};

/** What a batch does, in English (the log and the agent) and as the page's words. */
export function describe(
  m: ModelModel,
  list: readonly ModelAction[],
): { text: string; change: ModelChange } {
  const plain: ModelPlainAction[] = list.flatMap(modelPlainOf);
  const before = m.file.json.root;
  if (plain.some((a) => a.t === "doc"))
    return { text: "Replaced the whole model", change: { action: "replace", n: 0 } };
  const after = list.reduce((mm, a) => applyAction(mm, a), m).file.json.root;
  const nodesBefore = nodesOf(before).length;
  const added = nodesOf(after).slice(nodesBefore);
  const name = (i: number) => {
    const n = nodesOf(after)[i] ?? nodesOf(before)[i];
    return typeof n?.name === "string" ? n.name : undefined;
  };
  const one = (
    action: ModelChange["action"],
    nodes: number[],
    kinds: ModelChange["kind"][],
    words: string,
  ) => {
    const kind = kinds.length && kinds.every((k) => k === kinds[0]) ? kinds[0] : undefined;
    const nm = nodes.length === 1 ? name(nodes[0] as number) : undefined;
    const change: ModelChange = {
      action,
      n: nodes.length,
      ...(kind && { kind }),
      ...(nm && { name: nm }),
      ...(nodes.length === 1 && { id: `n${nodes[0]}` }),
    };
    const what =
      nodes.length === 1 ? `${kind ?? "object"}${nm ? ` "${nm}"` : ""}` : `${nodes.length} objects`;
    return { text: `${words} ${what}`.trim(), change };
  };

  if (added.length) {
    const meshesBefore = Array.isArray(modelGet(before, ["meshes"]))
      ? (modelGet(before, ["meshes"]) as unknown[]).length
      : 0;
    // Only the top new nodes (their children came with them).
    const tops = added
      .map((_, k) => nodesBefore + k)
      .filter((i) => {
        const p = modelParentOf(after, i);
        return !p || p.parent === "scene" || p.parent < nodesBefore;
      });
    const kinds = tops.map((i) => nodeKind(after, nodesOf(after)[i] as Obj));
    // A copy wears meshes the file had: none of its own.
    const meshesAfter = Array.isArray(modelGet(after, ["meshes"]))
      ? (modelGet(after, ["meshes"]) as unknown[]).length
      : 0;
    const dup =
      meshesAfter === meshesBefore &&
      tops.every((i) => typeof (nodesOf(after)[i] as Obj).mesh === "number");
    return dup && tops.length
      ? one("duplicate", tops, kinds, "Duplicated")
      : one("add", tops, kinds, "Added");
  }

  // Nodes taken out of where they hung, and put back somewhere else.
  const detached = new Set<number>();
  const attached = new Set<number>();
  for (const a of plain) {
    if (a.t === "doc") continue;
    const p = a.path;
    const isList =
      (p.length === 3 && p[0] === "scenes" && p[2] === "nodes") ||
      (p.length === 3 && p[0] === "nodes" && p[2] === "children");
    if (!isList) continue;
    const was = modelGet(before, p);
    const now = modelGet(after, p);
    const w = Array.isArray(was) ? (was as number[]) : [];
    const n = Array.isArray(now) ? (now as number[]) : [];
    for (const x of w) if (!n.includes(x)) detached.add(x);
    for (const x of n) if (!w.includes(x)) attached.add(x);
  }
  const moved = [...detached].filter((x) => attached.has(x) || modelParentOf(after, x));
  const gone = [...detached].filter((x) => !modelParentOf(after, x));
  const kindsOf = (ids: number[]) =>
    ids.map((i) => nodeKind(before, (nodesOf(before)[i] ?? {}) as Obj));
  if (gone.length) return one("delete", gone, kindsOf(gone), "Deleted");
  if (moved.length) return one("reparent", moved, kindsOf(moved), "Moved into another group:");

  const touchedNodes = new Set<number>();
  let transform = false;
  let rename = false;
  let material = false;
  let light = false;
  let camera = false;
  const mats = new Set<number>();
  for (const a of plain) {
    if (a.t === "doc") continue;
    const p = a.path;
    if (p[0] === "nodes" && typeof p[1] === "number") {
      touchedNodes.add(p[1]);
      if (["translation", "rotation", "scale", "matrix"].includes(String(p[2]))) transform = true;
      else if (p[2] === "name") rename = true;
    } else if (
      p[0] === "materials" ||
      p[0] === "textures" ||
      p[0] === "images" ||
      p[0] === "samplers"
    ) {
      material = true;
      if (p[0] === "materials" && typeof p[1] === "number") mats.add(p[1]);
    } else if (p[0] === "meshes" && p.includes("material")) material = true;
    else if (p[0] === "extensions" && p[2] === "lights") light = true;
    else if (p[0] === "cameras") camera = true;
  }
  const nodes = [...touchedNodes];
  if (material) {
    const ms = [...mats];
    const nm =
      ms.length === 1 ? modelGet(after, ["materials", ms[0] as number, "name"]) : undefined;
    return {
      text: `Changed ${ms.length === 1 ? `material${typeof nm === "string" ? ` "${nm}"` : ` m${ms[0]}`}` : `${ms.length || 1} materials`}`,
      change: {
        action: "material",
        n: ms.length || 1,
        kind: "material",
        ...(typeof nm === "string" && { name: nm }),
        ...(ms.length === 1 && { id: `m${ms[0]}` }),
      },
    };
  }
  if (light) return { text: "Changed a light", change: { action: "light", n: 1, kind: "light" } };
  if (camera)
    return { text: "Changed a camera", change: { action: "camera", n: 1, kind: "camera" } };
  const kinds = kindsOf(nodes);
  if (transform) return one("transform", nodes, kinds, "Moved");
  if (rename) return one("rename", nodes, kinds, "Renamed");
  return { text: "Changed the model", change: { action: "change", n: nodes.length } };
}
