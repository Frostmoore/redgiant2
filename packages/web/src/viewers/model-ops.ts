// The page's side of the 3D editor (G37.7), with no three.js in it (tested alone): the person's
// gestures turned into the same actions on the glTF JSON the agents send (the protocol's own
// builders), the scene's tree as the panel lists it, others' revisions met with the person's
// own still in flight, and a change in the person's words. The server owns the file: the page
// never writes it from three.js.
import {
  applyModelAction,
  type DocSummary,
  MODEL_ENGINE,
  MODEL_ENGINE_VERSION,
  type ModelAction,
  type ModelGeometry,
  type ModelMaterialSpec,
  type ModelPlainAction,
  modelAddMesh,
  modelAddNode,
  modelAttach,
  modelDetach,
  modelGet,
  modelParentOf,
  modelPush,
  modelRun,
  modelSceneIndex,
  modelTouched,
  modelUseExtension,
  round6,
} from "@redgiant/protocol";
import { type Key, t } from "../i18n.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const modelDocOp = (op: ModelAction) => ({
  family: "model" as const,
  engine: MODEL_ENGINE as typeof MODEL_ENGINE,
  engineVersion: MODEL_ENGINE_VERSION,
  op,
});

/** The actions of a host's message (others' revisions). */
export const modelActionsOf = (ops: readonly { family: string; op?: unknown }[]): ModelAction[] =>
  ops.flatMap((o) => (o.family === "model" ? [o.op as ModelAction] : []));

/** The JSON after actions (the page keeps it beside three.js's scene). */
export const applyAll = (root: unknown, list: readonly ModelAction[]): unknown =>
  list.reduce((r, a) => applyModelAction(r, a), root);

// ---- the scene's tree ----------------------------------------------------------------------

export type NodeKind = "mesh" | "light" | "camera" | "group";

export interface TreeRow {
  index: number;
  depth: number;
  name: string;
  /** The file's own name, when it has one. */
  named: boolean;
  kind: NodeKind;
  children: number;
}

const nodesOf = (root: unknown): Obj[] =>
  arr(isObj(root) ? root.nodes : undefined).map((n) => (isObj(n) ? n : {}));

export function nodeKind(n: Obj): NodeKind {
  if (typeof n.mesh === "number") return "mesh";
  if (isObj(n.extensions) && isObj(n.extensions.KHR_lights_punctual)) return "light";
  if (typeof n.camera === "number") return "camera";
  return "group";
}

/** The scene's nodes in order, each with its depth (folded nodes hide their children). */
export function sceneTree(root: unknown, folded: ReadonlySet<number> = new Set()): TreeRow[] {
  const nodes = nodesOf(root);
  const scenes = arr(isObj(root) ? root.scenes : undefined);
  const scene = scenes[modelSceneIndex(root)];
  const out: TreeRow[] = [];
  const seen = new Set<number>();
  const visit = (i: number, depth: number) => {
    const n = nodes[i];
    if (!n || seen.has(i) || depth > 60) return;
    seen.add(i);
    const kids = arr(n.children).filter((c): c is number => typeof c === "number");
    out.push({
      index: i,
      depth,
      name: typeof n.name === "string" && n.name ? n.name : `n${i}`,
      named: typeof n.name === "string" && !!n.name,
      kind: nodeKind(n),
      children: kids.length,
    });
    if (!folded.has(i)) for (const c of kids) visit(c, depth + 1);
  };
  for (const n of arr(isObj(scene) ? scene.nodes : undefined))
    if (typeof n === "number") visit(n, 0);
  return out;
}

/** Nodes a node can hang under (not itself, nor its own children). */
export function parentChoices(root: unknown, node: number): TreeRow[] {
  const below = new Set<number>([node]);
  const nodes = nodesOf(root);
  const grow = (i: number, depth: number) => {
    if (depth > 60) return;
    for (const c of arr(nodes[i]?.children))
      if (typeof c === "number" && !below.has(c)) {
        below.add(c);
        grow(c, depth + 1);
      }
  };
  grow(node, 0);
  return sceneTree(root).filter((r) => !below.has(r.index));
}

// ---- the person's gestures as actions ---------------------------------------------------------

export interface Trs {
  translation: number[];
  rotation: number[];
  scale: number[];
}

const q7 = (x: number) => {
  const r = Math.round(x * 1e7) / 1e7;
  return Object.is(r, -0) ? 0 : r;
};

/** A node's new transform (a node with a matrix gets translation, rotation and scale). */
export function transformActions(root: unknown, node: number, t: Trs): ModelPlainAction[] {
  const n = nodesOf(root)[node] ?? {};
  const out: ModelPlainAction[] = [];
  const value = {
    translation: t.translation.map(round6),
    rotation: t.rotation.map(q7),
    scale: t.scale.map(round6),
  };
  if (Array.isArray(n.matrix)) out.push({ t: "set", path: ["nodes", node, "matrix"] });
  for (const k of ["translation", "rotation", "scale"] as const) {
    const was = n[k];
    const same =
      Array.isArray(was) &&
      was.length === value[k].length &&
      was.every((x, i) => Math.abs((x as number) - (value[k][i] as number)) < 1e-9);
    const isDefault =
      was === undefined &&
      value[k].every((x, i) => x === (k === "scale" ? 1 : k === "rotation" && i === 3 ? 1 : 0));
    if (Array.isArray(n.matrix) || (!same && !isDefault))
      out.push({ t: "set", path: ["nodes", node, k], value: value[k] });
  }
  return out;
}

export const renameActions = (node: number, name: string): ModelPlainAction[] => [
  name.trim()
    ? { t: "set", path: ["nodes", node, "name"], value: name.trim().slice(0, 200) }
    : { t: "set", path: ["nodes", node, "name"] },
];

export const deleteActions = (root: unknown, node: number): ModelPlainAction[] =>
  modelDetach(root, node);

/** Hangs a node elsewhere, keeping its own transform as it is (the island keeps the world one). */
export function reparentActions(
  root: unknown,
  node: number,
  parent: number | "scene",
): ModelPlainAction[] {
  const off = modelDetach(root, node);
  return [...off, ...modelAttach(modelRun(root, off), node, parent)];
}

/** A copy of a node and its children beside it (sharing meshes and materials). */
export function duplicateActions(
  root: unknown,
  node: number,
  name: string | undefined,
): { acts: ModelPlainAction[]; index: number } {
  let r = root;
  const acts: ModelPlainAction[] = [];
  const copy = (k: number, extra: Obj): number => {
    const n = { ...(nodesOf(r)[k] ?? {}), ...extra };
    const kids = arr(n.children).filter((c): c is number => typeof c === "number");
    delete n.children;
    const p = modelPush(r, ["nodes"], n);
    acts.push(...p.acts);
    r = modelRun(r, p.acts);
    for (const c of kids) {
      const ci = copy(c, {});
      const a = modelAttach(r, ci, p.index);
      acts.push(...a);
      r = modelRun(r, a);
    }
    return p.index;
  };
  const index = copy(node, name ? { name } : {});
  const where = modelParentOf(root, node);
  const a = modelAttach(r, index, where && where.parent !== "scene" ? where.parent : "scene");
  acts.push(...a);
  return { acts, index };
}

/** The materials a node's mesh wears (index list), and whether a primitive has none. */
export function materialsOfNode(root: unknown, node: number): { list: number[]; bare: number[] } {
  const n = nodesOf(root)[node];
  if (!n || typeof n.mesh !== "number") return { list: [], bare: [] };
  const prims = arr(modelGet(root, ["meshes", n.mesh, "primitives"]));
  const list = new Set<number>();
  const bare: number[] = [];
  prims.forEach((p, k) => {
    if (isObj(p) && typeof p.material === "number") list.add(p.material);
    else bare.push(k);
  });
  return { list: [...list], bare };
}

/** The material the panel edits for a node (made when its mesh has none): actions and index. */
export function ensureMaterial(
  root: unknown,
  node: number,
): { acts: ModelPlainAction[]; index: number } | undefined {
  const n = nodesOf(root)[node];
  if (!n || typeof n.mesh !== "number") return undefined;
  const { list, bare } = materialsOfNode(root, node);
  if (list.length) return { acts: [], index: list[0] as number };
  const p = modelPush(root, ["materials"], {
    pbrMetallicRoughness: {
      baseColorFactor: [0.8, 0.8, 0.8, 1],
      metallicFactor: 0,
      roughnessFactor: 0.6,
    },
  });
  return {
    acts: [
      ...p.acts,
      ...bare.map(
        (k): ModelPlainAction => ({
          t: "set",
          path: ["meshes", n.mesh as number, "primitives", k, "material"],
          value: p.index,
        }),
      ),
    ],
    index: p.index,
  };
}

/** Sets a value deep in the JSON, making the objects above it when missing. */
export function setDeep(
  root: unknown,
  path: (string | number)[],
  value: unknown,
): ModelPlainAction {
  for (let i = path.length - 1; i > 0; i--) {
    const above = modelGet(root, path.slice(0, i));
    if (isObj(above) || Array.isArray(above)) {
      let v: unknown = value;
      for (let j = path.length - 1; j > i; j--) v = { [String(path[j])]: v };
      return { t: "set", path: path.slice(0, i + 1), ...(v !== undefined && { value: v }) };
    }
  }
  return { t: "set", path: path.slice(0, 1), ...(value !== undefined && { value }) };
}

export interface MaterialView {
  index: number;
  name?: string;
  /** sRGB hex, as the colour field shows it. */
  color: string;
  opacity: number;
  metalness: number;
  roughness: number;
  emissive: string;
  doubleSided: boolean;
  texture: boolean;
}

export function linearToHex(c: readonly number[]): string {
  const ch = (x: number) => {
    const v = Math.max(0, Math.min(1, x));
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(s * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(c[0] ?? 0)}${ch(c[1] ?? 0)}${ch(c[2] ?? 0)}`;
}

export function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "").padEnd(6, "0");
  const ch = (i: number) => {
    const s = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return round6(s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  };
  return [ch(0), ch(2), ch(4)];
}

export function materialView(root: unknown, index: number): MaterialView | undefined {
  const m = modelGet(root, ["materials", index]);
  if (!isObj(m)) return undefined;
  const pbr = isObj(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
  const c = Array.isArray(pbr.baseColorFactor) ? (pbr.baseColorFactor as number[]) : [1, 1, 1, 1];
  const em = Array.isArray(m.emissiveFactor) ? (m.emissiveFactor as number[]) : [0, 0, 0];
  return {
    index,
    ...(typeof m.name === "string" && { name: m.name }),
    color: linearToHex(c),
    opacity: c[3] ?? 1,
    metalness: typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1,
    roughness: typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1,
    emissive: linearToHex(em),
    doubleSided: m.doubleSided === true,
    texture: isObj(pbr.baseColorTexture),
  };
}

export type MaterialEdit =
  | { color: string }
  | { opacity: number }
  | { metalness: number }
  | { roughness: number }
  | { emissive: string }
  | { doubleSided: boolean }
  | { texture: { mime: string; data: string } | null };

/** One field of the material panel as actions. */
export function materialActions(root: unknown, index: number, e: MaterialEdit): ModelPlainAction[] {
  const base = ["materials", index, "pbrMetallicRoughness"];
  const was = modelGet(root, [...base, "baseColorFactor"]);
  const old = Array.isArray(was) ? (was as number[]) : [1, 1, 1, 1];
  if ("color" in e)
    return [setDeep(root, [...base, "baseColorFactor"], [...hexToLinear(e.color), old[3] ?? 1])];
  if ("opacity" in e) {
    const a = round6(Math.max(0, Math.min(1, e.opacity)));
    const out: ModelPlainAction[] = [
      setDeep(root, [...base, "baseColorFactor"], [...old.slice(0, 3), a]),
    ];
    const mode = modelGet(root, ["materials", index, "alphaMode"]);
    if (a < 1 && mode !== "BLEND")
      out.push({ t: "set", path: ["materials", index, "alphaMode"], value: "BLEND" });
    if (a >= 1 && mode === "BLEND") out.push({ t: "set", path: ["materials", index, "alphaMode"] });
    return out;
  }
  if ("metalness" in e)
    return [
      setDeep(root, [...base, "metallicFactor"], round6(Math.max(0, Math.min(1, e.metalness)))),
    ];
  if ("roughness" in e)
    return [
      setDeep(root, [...base, "roughnessFactor"], round6(Math.max(0, Math.min(1, e.roughness)))),
    ];
  if ("emissive" in e)
    return [
      { t: "set", path: ["materials", index, "emissiveFactor"], value: hexToLinear(e.emissive) },
    ];
  if ("doubleSided" in e)
    return [
      e.doubleSided
        ? { t: "set", path: ["materials", index, "doubleSided"], value: true }
        : { t: "set", path: ["materials", index, "doubleSided"] },
    ];
  if (e.texture === null)
    return modelGet(root, [...base, "baseColorTexture"]) === undefined
      ? []
      : [{ t: "set", path: [...base, "baseColorTexture"] }];
  let r = root;
  const acts: ModelPlainAction[] = [];
  const img = modelPush(r, ["images"], {
    mimeType: e.texture.mime,
    uri: `data:${e.texture.mime};base64,${e.texture.data}`,
  });
  acts.push(...img.acts);
  r = modelRun(r, img.acts);
  const tex = modelPush(r, ["textures"], { source: img.index });
  acts.push(...tex.acts);
  r = modelRun(r, tex.acts);
  acts.push(setDeep(r, [...base, "baseColorTexture"], { index: tex.index }));
  return acts;
}

export interface LightView {
  index: number;
  type: string;
  color: string;
  intensity: number;
  range?: number;
}

export function lightOfNode(root: unknown, node: number): LightView | undefined {
  const n = nodesOf(root)[node];
  const ext = n && isObj(n.extensions) ? n.extensions.KHR_lights_punctual : undefined;
  const index = isObj(ext) && typeof ext.light === "number" ? ext.light : undefined;
  if (index === undefined) return undefined;
  const l = modelGet(root, ["extensions", "KHR_lights_punctual", "lights", index]);
  if (!isObj(l)) return undefined;
  return {
    index,
    type: String(l.type ?? "point"),
    color: linearToHex(Array.isArray(l.color) ? (l.color as number[]) : [1, 1, 1]),
    intensity: typeof l.intensity === "number" ? l.intensity : 1,
    ...(typeof l.range === "number" && { range: l.range }),
  };
}

export function lightActions(
  index: number,
  e: { color: string } | { intensity: number },
): ModelPlainAction[] {
  const base = ["extensions", "KHR_lights_punctual", "lights", index];
  return "color" in e
    ? [{ t: "set", path: [...base, "color"], value: hexToLinear(e.color) }]
    : [{ t: "set", path: [...base, "intensity"], value: round6(Math.max(0, e.intensity)) }];
}

export type AddWhat = "box" | "sphere" | "cylinder" | "cone" | "plane" | "torus";

/** A shape the person adds: three.js's geometry (made by the island), a material, a node. */
export function addShapeActions(
  root: unknown,
  geo: ModelGeometry,
  name: string,
  at: number[],
  parent: number | "scene" = "scene",
): { acts: ModelPlainAction[]; node: number } {
  const material: ModelMaterialSpec = { name, color: [0.8, 0.8, 0.8, 1], roughness: 0.6 };
  const r = modelAddMesh(root, geo, {
    node: { name, ...(at.some((x) => x !== 0) && { translation: at.map(round6) }) },
    material,
    parent,
    meshName: name,
  });
  return { acts: r.acts, node: r.node };
}

/** A light the person adds, above the scene, looking down at it. */
export function addLightActions(
  root: unknown,
  kind: "point" | "directional" | "spot",
  name: string,
  at: number[],
  rotation?: number[],
): { acts: ModelPlainAction[]; node: number } {
  const light: Obj = {
    name,
    type: kind,
    intensity: kind === "directional" ? 3 : 20,
    ...(kind === "spot" && { spot: { innerConeAngle: 0, outerConeAngle: round6(Math.PI / 4) } }),
  };
  let r = root;
  const acts: ModelPlainAction[] = [];
  const l = modelPush(r, ["extensions", "KHR_lights_punctual", "lights"], light);
  acts.push(...l.acts);
  r = modelRun(r, l.acts);
  const used = modelUseExtension(r, "KHR_lights_punctual");
  acts.push(...used);
  r = modelRun(r, used);
  const n = modelAddNode(r, {
    name,
    translation: at.map(round6),
    ...(rotation && { rotation: rotation.map(q7) }),
    extensions: { KHR_lights_punctual: { light: l.index } },
  });
  acts.push(...n.acts);
  return { acts, node: n.index };
}

/** A camera where the person looks from now. */
export function addCameraActions(
  root: unknown,
  name: string,
  at: number[],
  rotation: number[],
  yfov: number,
): { acts: ModelPlainAction[]; node: number } {
  let r = root;
  const acts: ModelPlainAction[] = [];
  const c = modelPush(r, ["cameras"], {
    name,
    type: "perspective",
    perspective: { yfov: round6(yfov), znear: 0.05, zfar: 1000 },
  });
  acts.push(...c.acts);
  r = modelRun(r, c.acts);
  const n = modelAddNode(r, {
    name,
    translation: at.map(round6),
    rotation: rotation.map(q7),
    camera: c.index,
  });
  acts.push(...n.acts);
  return { acts, node: n.index };
}

/** An empty node to hang others under. */
export function addGroupActions(
  root: unknown,
  name: string,
  at: number[],
): { acts: ModelPlainAction[]; node: number } {
  const n = modelAddNode(root, {
    name,
    ...(at.some((x) => x !== 0) && { translation: at.map(round6) }),
  });
  return { acts: n.acts, node: n.index };
}

/** A name not yet used in the file («Cubo 2»). */
export function freeName(root: unknown, base: string): string {
  const taken = new Set(nodesOf(root).map((n) => n.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

// ---- others' revisions and the person's own --------------------------------------------------

export interface ModelOutgoing {
  clientId: string;
  baseRevision: number;
  actions: ModelAction[];
}

let ids = 0;
const newId = () => `m${Date.now().toString(36)}${(ids++).toString(36)}`;

/**
 * The person's actions on their way to the host, one batch at a time; others' revisions apply on
 * the page unless they meet the person's own still in flight (then the page loads the model again).
 */
export class ModelCollab {
  revision = 0;
  private inflight: { id: string; actions: ModelAction[] } | undefined;
  private buffer: ModelPlainAction[] = [];

  constructor(private readonly send: (o: ModelOutgoing) => void) {}

  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = [];
  }

  get pending(): boolean {
    return !!this.inflight || this.buffer.length > 0;
  }

  local(actions: readonly ModelPlainAction[]): void {
    for (const a of actions) {
      // Dragging a slider or a colour: the last value of the same place is enough.
      const last = this.buffer.at(-1);
      if (
        last &&
        a.t === "set" &&
        last.t === "set" &&
        a.value !== undefined &&
        last.value !== undefined &&
        a.path.join("/") === last.path.join("/")
      )
        this.buffer[this.buffer.length - 1] = a;
      else this.buffer.push(a);
    }
  }

  flush(): void {
    if (this.inflight || !this.buffer.length) return;
    const ops = this.buffer;
    this.buffer = [];
    const one: ModelAction = ops.length === 1 ? (ops[0] as ModelPlainAction) : { t: "batch", ops };
    this.inflight = { id: newId(), actions: [one] };
    this.send({ clientId: this.inflight.id, baseRevision: this.revision, actions: [one] });
  }

  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
    return true;
  }

  /** Others' revision: "apply" on the page, or "reload" (not the next one, or it meets mine). */
  remote(revision: number, actions: readonly ModelAction[]): "apply" | "reload" {
    if (revision !== this.revision + 1) return "reload";
    const mine = [...(this.inflight?.actions ?? []), ...this.buffer];
    if (mine.length) {
      const a = modelTouched(mine);
      for (const x of modelTouched(actions)) if (x === "*" || a.has(x)) return "reload";
    }
    this.revision = revision;
    return "apply";
  }

  rejected(clientId: string): boolean {
    return this.inflight?.id === clientId;
  }
}

// ---- words -----------------------------------------------------------------------------------

/** A 3D model's change in the person's words: «Aggiunto: cubo «Tavolo»», «Spostati 3 oggetti». */
export function modelChangeText(s: DocSummary): string {
  const c = s.model;
  if (!c) return s.text;
  const kind = t(`model3dKind_${c.kind ?? "object"}` as Key);
  const what = c.name ? `${kind} «${c.name}»` : kind;
  const one = c.n <= 1;
  const pick = (a: Key, many: Key) => (one ? t(a, { what }) : t(many, { n: String(c.n) }));
  switch (c.action) {
    case "add":
      return pick("model3dChAdd", "model3dChAddN");
    case "duplicate":
      return pick("model3dChDuplicate", "model3dChAddN");
    case "delete":
      return pick("model3dChDelete", "model3dChDeleteN");
    case "transform":
      return pick("model3dChTransform", "model3dChTransformN");
    case "material":
      return c.name ? t("model3dChMaterial", { what: `«${c.name}»` }) : t("model3dChMaterialAny");
    case "light":
      return t("model3dChLight");
    case "camera":
      return t("model3dChCamera");
    case "rename":
      return pick("model3dChRename", "model3dChEditN");
    case "reparent":
      return pick("model3dChReparent", "model3dChEditN");
    case "replace":
      return t("docReplaced");
    default:
      return one ? t("model3dChChange") : t("model3dChEditN", { n: String(c.n) });
  }
}

// ---- angles ----------------------------------------------------------------------------------

/** A quaternion [x, y, z, w] as XYZ angles in degrees (three.js's order). */
export function quatToEulerDeg(q: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  // The rotation matrix's terms three.js's Euler.setFromRotationMatrix reads (order XYZ).
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m32 = 2 * (y * z + x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  let ex: number;
  let ez: number;
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33);
    ez = Math.atan2(-m12, m11);
  } else {
    ex = Math.atan2(m32, m22);
    ez = 0;
  }
  const d = (r: number) => {
    const v = Math.round(((r * 180) / Math.PI) * 1000) / 1000;
    return Object.is(v, -0) ? 0 : v;
  };
  return [d(ex), d(ey), d(ez)];
}

/** XYZ angles in degrees as a quaternion [x, y, z, w] (three.js's order). */
export function eulerDegToQuat(e: readonly number[]): number[] {
  const [a = 0, b = 0, c = 0] = e.map((v) => (v * Math.PI) / 360);
  const c1 = Math.cos(a);
  const c2 = Math.cos(b);
  const c3 = Math.cos(c);
  const s1 = Math.sin(a);
  const s2 = Math.sin(b);
  const s3 = Math.sin(c);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}
