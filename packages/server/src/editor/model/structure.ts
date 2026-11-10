// A 3D model as an agent reads it (G37.7, canvas_look view "structure"): the scene's tree of
// nodes with their ids (n0, n1…), kind, name, local transform, box in the scene's space, and the
// material each mesh wears; then the materials, the lights, and what the file keeps that the
// editor does not show (extensions, nodes detached from every scene).
import { modelParentOf, modelSceneIndex } from "@redgiant/protocol";
import { Box3, Euler, Matrix4, Quaternion, Vector3 } from "three";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nums = (v: unknown, n: number): number[] | undefined =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number")
    ? (v as number[])
    : undefined;

export const nodesOf = (root: unknown): Obj[] =>
  arr(isObj(root) ? root.nodes : undefined).map((n) => (isObj(n) ? n : {}));

/** A node's own matrix (its matrix, or its translation, rotation and scale). */
export function localMatrix(node: Obj): Matrix4 {
  const m = nums(node.matrix, 16);
  if (m) return new Matrix4().fromArray(m);
  const t = nums(node.translation, 3) ?? [0, 0, 0];
  const r = nums(node.rotation, 4) ?? [0, 0, 0, 1];
  const s = nums(node.scale, 3) ?? [1, 1, 1];
  return new Matrix4().compose(
    new Vector3(t[0], t[1], t[2]),
    new Quaternion(r[0], r[1], r[2], r[3]),
    new Vector3(s[0], s[1], s[2]),
  );
}

/** Every node's matrix in the scene's space (nodes in no scene: their own). */
export function worldMatrices(root: unknown): Map<number, Matrix4> {
  const nodes = nodesOf(root);
  const out = new Map<number, Matrix4>();
  const visit = (i: number, parent: Matrix4, depth: number) => {
    const n = nodes[i];
    if (!n || out.has(i) || depth > 200) return;
    const w = parent.clone().multiply(localMatrix(n));
    out.set(i, w);
    for (const c of arr(n.children)) if (typeof c === "number") visit(c, w, depth + 1);
  };
  const scenes = arr(isObj(root) ? root.scenes : undefined);
  for (const s of scenes)
    for (const n of arr(isObj(s) ? s.nodes : undefined))
      if (typeof n === "number") visit(n, new Matrix4(), 0);
  for (let i = 0; i < nodes.length; i++) if (!out.has(i)) visit(i, new Matrix4(), 0);
  return out;
}

/** The parent's world matrix of a node (identity at the scene's root). */
export function parentWorld(root: unknown, node: number): Matrix4 {
  const p = modelParentOf(root, node);
  if (!p || p.parent === "scene") return new Matrix4();
  return worldMatrices(root).get(p.parent) ?? new Matrix4();
}

/** A mesh's box in its own space (POSITION's min and max). */
export function meshBox(root: unknown, mesh: number): Box3 | undefined {
  const m = arr(isObj(root) ? root.meshes : undefined)[mesh];
  const accessors = arr(isObj(root) ? root.accessors : undefined);
  const box = new Box3();
  let any = false;
  for (const p of arr(isObj(m) ? m.primitives : undefined)) {
    const a = accessors[(isObj(p) && isObj(p.attributes) ? p.attributes.POSITION : -1) as number];
    const min = nums(isObj(a) ? a.min : undefined, 3);
    const max = nums(isObj(a) ? a.max : undefined, 3);
    if (!min || !max) continue;
    box.expandByPoint(new Vector3(...min));
    box.expandByPoint(new Vector3(...max));
    any = true;
  }
  return any ? box : undefined;
}

/** The node's box in the scene's space, its children's included. */
export function nodeBox(
  root: unknown,
  node: number,
  world = worldMatrices(root),
): Box3 | undefined {
  const nodes = nodesOf(root);
  const box = new Box3();
  let any = false;
  const visit = (i: number, depth: number) => {
    const n = nodes[i];
    if (!n || depth > 200) return;
    if (typeof n.mesh === "number") {
      const b = meshBox(root, n.mesh);
      const w = world.get(i);
      if (b && w) {
        box.union(b.clone().applyMatrix4(w));
        any = true;
      }
    }
    for (const c of arr(n.children)) if (typeof c === "number") visit(c, depth + 1);
  };
  visit(node, 0);
  return any ? box : undefined;
}

const f = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
};
const vec = (v: readonly number[]) => `(${v.map(f).join(", ")})`;

/** Linear 0-1 to sRGB hex (what people and agents write). */
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

/** sRGB hex (#rgb or #rrggbb) to linear 0-1. */
export function hexToLinear(hex: string): [number, number, number] | undefined {
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return undefined;
  const ch = (i: number) => {
    const s = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [ch(0), ch(2), ch(4)];
}

/** A node's kind in words: mesh, light (its type), camera (its type), group. */
export function kindOf(root: unknown, n: Obj): string {
  if (typeof n.mesh === "number") return "mesh";
  const light = isObj(n.extensions) && isObj(n.extensions.KHR_lights_punctual);
  if (light) {
    const li = (n.extensions as Obj).KHR_lights_punctual as Obj;
    const l = lightsOf(root)[li.light as number];
    return `light ${isObj(l) ? String(l.type ?? "?") : "?"}`;
  }
  if (typeof n.camera === "number") {
    const c = arr(isObj(root) ? root.cameras : undefined)[n.camera];
    return `camera ${isObj(c) ? String(c.type ?? "?") : "?"}`;
  }
  return "group";
}

export const lightsOf = (root: unknown): unknown[] =>
  arr(
    isObj(root) && isObj(root.extensions) && isObj(root.extensions.KHR_lights_punctual)
      ? root.extensions.KHR_lights_punctual.lights
      : undefined,
  );

/** The material indices a mesh's primitives wear. */
export function materialsOfMesh(root: unknown, mesh: number): number[] {
  const m = arr(isObj(root) ? root.meshes : undefined)[mesh];
  const out = new Set<number>();
  for (const p of arr(isObj(m) ? m.primitives : undefined))
    if (isObj(p) && typeof p.material === "number") out.add(p.material);
  return [...out];
}

function materialLine(root: unknown, i: number): string {
  const m = arr(isObj(root) ? root.materials : undefined)[i];
  if (!isObj(m)) return `m${i} (missing)`;
  const pbr = isObj(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
  const color = nums(pbr.baseColorFactor, 4) ?? [1, 1, 1, 1];
  const parts = [
    `m${i}${m.name ? ` "${String(m.name)}"` : ""}`,
    `color ${linearToHex(color)}`,
    ...((color[3] ?? 1) < 1 ? [`opacity ${f(color[3] ?? 1)}`] : []),
    `metalness ${f(typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1)}`,
    `roughness ${f(typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1)}`,
  ];
  const em = nums(m.emissiveFactor, 3);
  if (em?.some((x) => x > 0)) parts.push(`emissive ${linearToHex(em)}`);
  if (isObj(pbr.baseColorTexture)) parts.push(`texture t${String(pbr.baseColorTexture.index)}`);
  if (m.doubleSided) parts.push("double-sided");
  if (isObj(m.extensions)) parts.push(`extensions ${Object.keys(m.extensions).join(", ")}`);
  return parts.join(", ");
}

function triangles(root: unknown, mesh: number): number {
  const m = arr(isObj(root) ? root.meshes : undefined)[mesh];
  const accessors = arr(isObj(root) ? root.accessors : undefined);
  let n = 0;
  for (const p of arr(isObj(m) ? m.primitives : undefined)) {
    if (!isObj(p) || (p.mode !== undefined && p.mode !== 4)) continue;
    const a =
      accessors[
        (typeof p.indices === "number"
          ? p.indices
          : isObj(p.attributes)
            ? p.attributes.POSITION
            : -1) as number
      ];
    if (isObj(a) && typeof a.count === "number") n += Math.floor(a.count / 3);
  }
  return n;
}

/** The scene, line by line (from 1). */
export function modelLines(root: unknown, container: "glb" | "gltf"): string[] {
  const nodes = nodesOf(root);
  const r = isObj(root) ? root : {};
  const world = worldMatrices(root);
  const scenes = arr(r.scenes);
  const si = modelSceneIndex(root);
  const scene = isObj(scenes[si]) ? (scenes[si] as Obj) : {};
  const lines: string[] = [
    `glTF ${isObj(r.asset) ? String(r.asset.version ?? "2.0") : "2.0"} (${container}), scene ${si}${scene.name ? ` "${String(scene.name)}"` : ""}: ${nodes.length} nodes, ${arr(r.meshes).length} meshes, ${arr(r.materials).length} materials, ${lightsOf(root).length} lights, ${arr(r.cameras).length} cameras. Units: metres, +Y up. Positions and rotations are local to the parent; "box" is in the scene's space.`,
  ];
  const seen = new Set<number>();
  const visit = (i: number, depth: number) => {
    const n = nodes[i];
    if (!n || seen.has(i) || depth > 60) return;
    seen.add(i);
    const parts = [
      `${"  ".repeat(depth)}n${i} ${kindOf(root, n)}${n.name ? ` "${String(n.name)}"` : ""}`,
    ];
    const m = localMatrix(n);
    const t = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    m.decompose(t, q, s);
    if (t.lengthSq() > 0) parts.push(`pos ${vec(t.toArray())}`);
    const e = new Euler().setFromQuaternion(q, "XYZ");
    if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) > 1e-6)
      parts.push(`rot ${vec([e.x, e.y, e.z].map((x) => (x * 180) / Math.PI))}°`);
    if (Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-6)
      parts.push(`scale ${vec(s.toArray())}`);
    if (typeof n.mesh === "number") {
      const b = nodeBox(root, i, world);
      if (b && !b.isEmpty()) {
        const size = b.getSize(new Vector3());
        parts.push(
          `box ${vec(b.min.toArray())}..${vec(b.max.toArray())} size ${vec(size.toArray())}`,
        );
      }
      const tri = triangles(root, n.mesh);
      if (tri) parts.push(`${tri} triangles`);
      const mats = materialsOfMesh(root, n.mesh);
      parts.push(mats.length ? `material ${mats.map((x) => `m${x}`).join(" ")}` : "no material");
    }
    if (n.skin !== undefined) parts.push("skinned");
    if (isObj(n.extensions)) {
      const other = Object.keys(n.extensions).filter((k) => k !== "KHR_lights_punctual");
      if (other.length) parts.push(`extensions ${other.join(", ")}`);
    }
    lines.push(parts.join(", "));
    for (const c of arr(n.children)) if (typeof c === "number") visit(c, depth + 1);
  };
  for (const n of arr(scene.nodes)) if (typeof n === "number") visit(n, 0);
  if (!arr(scene.nodes).length) lines.push("(the scene is empty)");
  const mats = arr(r.materials);
  if (mats.length) {
    lines.push("Materials:");
    for (let i = 0; i < mats.length; i++) lines.push(`  ${materialLine(root, i)}`);
  }
  const lights = lightsOf(root);
  if (lights.length) {
    lines.push("Lights:");
    lights.forEach((l, i) => {
      if (!isObj(l)) return;
      const c = nums(l.color, 3) ?? [1, 1, 1];
      const spot = isObj(l.spot) ? l.spot : undefined;
      lines.push(
        `  light ${i} ${String(l.type)}${l.name ? ` "${String(l.name)}"` : ""}, color ${linearToHex(c)}, intensity ${f(typeof l.intensity === "number" ? l.intensity : 1)}${typeof l.range === "number" ? `, range ${f(l.range)}` : ""}${spot ? `, cone ${f(((typeof spot.outerConeAngle === "number" ? spot.outerConeAngle : Math.PI / 4) * 180) / Math.PI)}°` : ""}`,
      );
    });
  }
  const detached = nodes.map((_, i) => i).filter((i) => !seen.has(i) && !modelParentOf(root, i));
  if (detached.length)
    lines.push(
      `Detached nodes (deleted, still in the file, out of every scene): ${detached.map((i) => `n${i}`).join(" ")}`,
    );
  if (scenes.length > 1) lines.push(`Other scenes (not shown): ${scenes.length - 1}`);
  const used = arr(r.extensionsUsed).filter((x) => x !== "KHR_lights_punctual");
  if (used.length) lines.push(`Extensions kept as they are: ${used.join(", ")}`);
  if (arr(r.animations).length) lines.push(`Animations: ${arr(r.animations).length} (kept)`);
  return lines;
}

export function modelStructure(
  root: unknown,
  container: "glb" | "gltf",
  ask: { fromLine?: number | undefined; toLine?: number | undefined },
): string {
  const lines = modelLines(root, container);
  const from = Math.max(1, ask.fromLine ?? 1);
  const to = Math.min(lines.length, ask.toLine ?? from + 399);
  const shown = lines.slice(from - 1, to);
  const more =
    to < lines.length ? `\n(lines ${from}-${to} of ${lines.length}: ask from_line ${to + 1})` : "";
  return shown.join("\n") + more;
}
