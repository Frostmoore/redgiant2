// The GLB copy of a 3D file the editor does not keep as it is (G37.7): OBJ, STL and PLY read by
// three.js's own loaders (no program needed) and written as one GLB with a buffer of its own; FBX,
// .blend, USD and Alembic go through Blender (the converter, downloaded once when needed). An
// OBJ's .mtl colours and textures, and every format's animations, need Blender: the copy made
// here keeps the meshes, their groups, normals, UVs and vertex colours.
import type { BufferAttribute, BufferGeometry, Material, Mesh, Object3D, Points } from "three";
import { MeshStandardMaterial, Mesh as ThreeMesh, Points as ThreePoints } from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { packGlb } from "./gltf.js";

/** The 3D files whose GLB copy is made here, without Blender. */
export const JS_COPIES = /\.(obj|stl|ply)$/i;

type Obj = Record<string, unknown>;

class GlbWriter {
  parts: Uint8Array[] = [];
  length = 0;
  json: Obj & {
    bufferViews: Obj[];
    accessors: Obj[];
    meshes: Obj[];
    materials: Obj[];
    nodes: Obj[];
  } = { bufferViews: [], accessors: [], meshes: [], materials: [], nodes: [] };
  private mats = new Map<Material, number>();

  view(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.parts.push(bytes);
    this.json.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.length,
      ...(target && { target }),
    });
    this.length += bytes.length;
    return this.json.bufferViews.length - 1;
  }

  accessor(a: BufferAttribute, type: string, minMax = false, from = 0, count = a.count): number {
    const size = a.itemSize;
    const out = new Float32Array(count * size);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < size; k++) out[i * size + k] = a.getComponent(from + i, k);
    const acc: Obj = {
      bufferView: this.view(new Uint8Array(out.buffer), 34962),
      componentType: 5126,
      count,
      type,
    };
    if (minMax) {
      const min = Array(size).fill(Infinity);
      const max = Array(size).fill(-Infinity);
      for (let i = 0; i < count; i++)
        for (let k = 0; k < size; k++) {
          const v = out[i * size + k] as number;
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      acc.min = min;
      acc.max = max;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  indices(list: ArrayLike<number>, vertices: number): number {
    const big = vertices > 65535;
    const arr = big ? Uint32Array.from(list) : Uint16Array.from(list);
    this.json.accessors.push({
      bufferView: this.view(new Uint8Array(arr.buffer, 0, arr.byteLength), 34963),
      componentType: big ? 5125 : 5123,
      count: list.length,
      type: "SCALAR",
    });
    return this.json.accessors.length - 1;
  }

  material(m: Material | undefined, vertexColors: boolean): number | undefined {
    if (!m) return undefined;
    const have = this.mats.get(m);
    if (have !== undefined) return have;
    const c = (m as Material & { color?: { r: number; g: number; b: number } }).color;
    const json: Obj = {
      ...(m.name && { name: m.name }),
      pbrMetallicRoughness: {
        baseColorFactor: vertexColors
          ? [1, 1, 1, m.opacity]
          : [c?.r ?? 0.8, c?.g ?? 0.8, c?.b ?? 0.8, m.opacity],
        metallicFactor: 0,
        roughnessFactor: 0.7,
      },
      ...(m.opacity < 1 && { alphaMode: "BLEND" }),
      ...(m.side === 2 && { doubleSided: true }),
    };
    this.json.materials.push(json);
    this.mats.set(m, this.json.materials.length - 1);
    return this.json.materials.length - 1;
  }

  mesh(obj: Mesh | Points): number {
    const g = obj.geometry as BufferGeometry;
    const pos = g.getAttribute("position") as BufferAttribute;
    const attributes: Obj = { POSITION: this.accessor(pos, "VEC3", true) };
    const normal = g.getAttribute("normal") as BufferAttribute | undefined;
    if (normal && normal.count === pos.count) attributes.NORMAL = this.accessor(normal, "VEC3");
    const uv = g.getAttribute("uv") as BufferAttribute | undefined;
    if (uv && uv.count === pos.count) attributes.TEXCOORD_0 = this.accessor(uv, "VEC2");
    const color = g.getAttribute("color") as BufferAttribute | undefined;
    if (color && color.count === pos.count)
      attributes.COLOR_0 = this.accessor(color, color.itemSize === 4 ? "VEC4" : "VEC3");
    const points = (obj as Points).isPoints === true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const vc = !!attributes.COLOR_0;
    const primitives: Obj[] = [];
    const groups =
      g.groups.length && mats.length > 1
        ? g.groups
        : [{ start: 0, count: Infinity, materialIndex: 0 }];
    for (const gr of groups) {
      const index = g.index;
      const total = index ? index.count : pos.count;
      const start = Math.min(gr.start, total);
      const count = Math.min(gr.count, total - start);
      if (count <= 0) continue;
      let indices: number | undefined;
      if (index) {
        const list: number[] = [];
        for (let i = start; i < start + count; i++) list.push(index.getX(i));
        indices = this.indices(list, pos.count);
      } else if (groups.length > 1) {
        const list: number[] = [];
        for (let i = start; i < start + count; i++) list.push(i);
        indices = this.indices(list, pos.count);
      }
      const material = this.material(mats[gr.materialIndex ?? 0], vc);
      primitives.push({
        attributes,
        ...(indices !== undefined && { indices }),
        ...(material !== undefined && { material }),
        ...(points && { mode: 0 }),
      });
    }
    this.json.meshes.push({ ...(obj.name && { name: obj.name }), primitives });
    return this.json.meshes.length - 1;
  }

  node(o: Object3D): number | undefined {
    const children = o.children
      .map((c) => this.node(c))
      .filter((x): x is number => x !== undefined);
    const isMesh = (o as Mesh).isMesh === true || (o as Points).isPoints === true;
    const mesh =
      isMesh && (o as Mesh).geometry?.getAttribute("position") ? this.mesh(o as Mesh) : undefined;
    if (mesh === undefined && !children.length) return undefined;
    const t = o.position;
    const q = o.quaternion;
    const s = o.scale;
    this.json.nodes.push({
      ...(o.name && { name: o.name }),
      ...(mesh !== undefined && { mesh }),
      ...(children.length && { children }),
      ...((t.x || t.y || t.z) && { translation: [t.x, t.y, t.z] }),
      ...((q.x || q.y || q.z || q.w !== 1) && { rotation: [q.x, q.y, q.z, q.w] }),
      ...((s.x !== 1 || s.y !== 1 || s.z !== 1) && { scale: [s.x, s.y, s.z] }),
    });
    return this.json.nodes.length - 1;
  }

  glb(top: Object3D, generator: string): Uint8Array {
    const root = this.node(top);
    if (root === undefined) throw new Error("the file has no meshes");
    const bin = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      bin.set(p, at);
      at += p.length;
    }
    const json = {
      asset: { version: "2.0", generator },
      scene: 0,
      scenes: [{ nodes: [root] }],
      nodes: this.json.nodes,
      meshes: this.json.meshes,
      ...(this.json.materials.length && { materials: this.json.materials }),
      accessors: this.json.accessors,
      bufferViews: this.json.bufferViews,
      buffers: [{ byteLength: bin.length }],
    };
    return packGlb(JSON.stringify(json), bin);
  }
}

const arrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** An OBJ, STL or PLY as a GLB (three.js's loaders; colours from vertices, no textures). */
export function jsModelToGlb(bytes: Uint8Array, name: string): Uint8Array {
  const ext = name.toLowerCase().split(".").pop();
  let top: Object3D;
  const plain = () => new MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7 });
  if (ext === "obj") {
    top = new OBJLoader().parse(new TextDecoder().decode(bytes));
  } else if (ext === "stl") {
    const g = new STLLoader().parse(arrayBuffer(bytes));
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const m = plain();
    if (g.getAttribute("color")) m.vertexColors = true;
    top = new ThreeMesh(g, m);
  } else if (ext === "ply") {
    const g = new PLYLoader().parse(arrayBuffer(bytes));
    const m = plain();
    if (g.getAttribute("color")) m.vertexColors = true;
    if (!g.index) top = new ThreePoints(g, m);
    else {
      if (!g.getAttribute("normal")) g.computeVertexNormals();
      top = new ThreeMesh(g, m);
    }
  } else throw new Error(`${name} is not an OBJ, STL or PLY`);
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  if (!top.name) top.name = stem;
  return new GlbWriter().glb(top, "RedGiant (three.js loaders)");
}
