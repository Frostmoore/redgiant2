// A simple picture of a 3D model for canvas_look (G36.12), drawn in RedGiant's own code: STL
// (text or binary), OBJ and GLB triangles, flat shaded with a z-buffer, seen from the front, a
// side, the top or three quarters. Not a real render (no materials or textures: Blender's
// render does that); enough for an agent to see the shape and how it sits.
import type { Rgba } from "./convert-js.js";

export const MODEL_VIEWS = ["iso", "front", "back", "left", "right", "top", "bottom"] as const;
export type ModelView = (typeof MODEL_VIEWS)[number];

/** Formats drawn here; the others (FBX, PLY, glTF with outside buffers, .blend) need Blender. */
export const SIMPLE_MODELS = new Set(["stl", "obj", "glb"]);

/** Triangles, nine numbers each (x y z three times). */
export type Triangles = Float32Array;

const td = new TextDecoder();

export function readStl(b: Uint8Array): Triangles {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = b.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  // Binary when the size matches its triangle count (some binary files start with "solid" too).
  if (count >= 0 && 84 + count * 50 === b.byteLength) {
    const out = new Float32Array(count * 9);
    for (let i = 0; i < count; i++)
      for (let j = 0; j < 9; j++) out[i * 9 + j] = dv.getFloat32(84 + i * 50 + 12 + j * 4, true);
    return out;
  }
  const nums: number[] = [];
  for (const m of td.decode(b).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g))
    nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
  return new Float32Array(nums.slice(0, nums.length - (nums.length % 9)));
}

export function readObj(b: Uint8Array): Triangles {
  const v: number[][] = [];
  const out: number[] = [];
  for (const line of td.decode(b).split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([Number(p[1]), Number(p[2]), Number(p[3])]);
    else if (p[0] === "f") {
      // Faces of any size as a fan; negative indices count from the end.
      const idx = p.slice(1).map((x) => {
        const n = Number.parseInt(x.split("/")[0] ?? "", 10);
        return n < 0 ? v.length + n : n - 1;
      });
      for (let i = 1; i + 1 < idx.length; i++)
        for (const k of [idx[0], idx[i], idx[i + 1]]) {
          const p3 = v[k as number];
          if (!p3) continue;
          out.push(p3[0] as number, p3[1] as number, p3[2] as number);
        }
    }
  }
  return new Float32Array(out.slice(0, out.length - (out.length % 9)));
}

type Mat = number[];
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major 4×4 product a·b (glTF's order). */
function mul(a: Mat, b: Mat): Mat {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        o[c * 4 + r] += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
  return o;
}
function trs(n: { translation?: number[]; rotation?: number[]; scale?: number[] }): Mat {
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = [x as number, y as number, z as number, w as number];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * (sx as number),
    2 * (qx * qy + qz * qw) * (sx as number),
    2 * (qx * qz - qy * qw) * (sx as number),
    0,
    2 * (qx * qy - qz * qw) * (sy as number),
    (1 - 2 * (qx * qx + qz * qz)) * (sy as number),
    2 * (qy * qz + qx * qw) * (sy as number),
    0,
    2 * (qx * qz + qy * qw) * (sz as number),
    2 * (qy * qz - qx * qw) * (sz as number),
    (1 - 2 * (qx * qx + qy * qy)) * (sz as number),
    0,
    tx as number,
    ty as number,
    tz as number,
    1,
  ];
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes?: {
    primitives: { attributes: { POSITION?: number }; indices?: number; mode?: number }[];
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

/** A binary glTF's triangles, every node's transform applied. */
export function readGlb(b: Uint8Array): Triangles {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("Not a GLB file");
  let json: Gltf | undefined;
  let bin: Uint8Array | undefined;
  for (let at = 12; at + 8 <= b.byteLength; ) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const body = b.subarray(at + 8, at + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(td.decode(body)) as Gltf;
    else if (type === 0x004e4942) bin = body;
    at += 8 + len;
  }
  if (!json) throw new Error("This GLB has no JSON chunk");
  const g = json;
  const read = (i: number): number[] => {
    const a = g.accessors?.[i];
    const view = a?.bufferView !== undefined ? g.bufferViews?.[a.bufferView] : undefined;
    if (!a || !view || !bin) return [];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] ?? 1;
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] ?? 4;
    const stride = view.byteStride || width * size;
    const base = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const v = new DataView(bin.buffer);
    const out: number[] = [];
    for (let k = 0; k < a.count; k++)
      for (let c = 0; c < width; c++) {
        const o = base + k * stride + c * size;
        if (o + size > bin.byteOffset + bin.byteLength) return out;
        out.push(
          a.componentType === 5126
            ? v.getFloat32(o, true)
            : a.componentType === 5125
              ? v.getUint32(o, true)
              : a.componentType === 5123
                ? v.getUint16(o, true)
                : a.componentType === 5122
                  ? v.getInt16(o, true)
                  : a.componentType === 5121
                    ? v.getUint8(o)
                    : v.getInt8(o),
        );
      }
    return out;
  };
  const out: number[] = [];
  const visit = (n: number, parent: Mat, depth: number) => {
    const node = g.nodes?.[n];
    if (!node || depth > 64) return;
    const m = mul(parent, node.matrix ?? trs(node));
    const mesh = node.mesh !== undefined ? g.meshes?.[node.mesh] : undefined;
    for (const p of mesh?.primitives ?? []) {
      if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
      const pos = read(p.attributes.POSITION);
      const idx =
        p.indices !== undefined ? read(p.indices) : pos.map((_, i) => i).slice(0, pos.length / 3);
      for (const i of idx.slice(0, idx.length - (idx.length % 3))) {
        const [x, y, z] = [pos[i * 3] ?? 0, pos[i * 3 + 1] ?? 0, pos[i * 3 + 2] ?? 0];
        out.push(
          (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
          (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
          (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
        );
      }
    }
    for (const c of node.children ?? []) visit(c, m, depth + 1);
  };
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY, 0);
  return new Float32Array(out);
}

export function readModel(ext: string, b: Uint8Array): Triangles {
  if (ext === "stl") return readStl(b);
  if (ext === "obj") return readObj(b);
  if (ext === "glb") return readGlb(b);
  throw new Error(`${ext.toUpperCase()} is not drawn here`);
}

/** Yaw and pitch (degrees) of each view; Y is up, the camera looks along −Z at yaw 0. */
const ANGLES: Record<ModelView, [number, number]> = {
  front: [0, 0],
  back: [180, 0],
  left: [-90, 0],
  right: [90, 0],
  top: [0, 90],
  bottom: [0, -90],
  iso: [35, 25],
};

export interface ModelPicture {
  img: Rgba;
  triangles: number;
  /** The model's size along X, Y and Z. */
  size: [number, number, number];
}

/** The triangles drawn at `width`×`height` from a view, light grey background. */
export function renderModel(
  tris: Triangles,
  view: ModelView = "iso",
  width = 800,
  height = 600,
): ModelPicture {
  const n = Math.floor(tris.length / 9);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 9; i++) {
    const v = tris[i] as number;
    const c = i % 3;
    if (v < (lo[c] as number)) lo[c] = v;
    if (v > (hi[c] as number)) hi[c] = v;
  }
  const size: [number, number, number] = n
    ? [
        (hi[0] as number) - (lo[0] as number),
        (hi[1] as number) - (lo[1] as number),
        (hi[2] as number) - (lo[2] as number),
      ]
    : [0, 0, 0];
  const centre = [0, 1, 2].map((c) => (n ? ((lo[c] as number) + (hi[c] as number)) / 2 : 0));
  const [yawD, pitchD] = ANGLES[view];
  const yaw = (yawD * Math.PI) / 180;
  const pitch = (pitchD * Math.PI) / 180;
  const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  // Rotate about Y (yaw), then about X (pitch): camera space, x right, y up, z towards the eye.
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const [dx, dy, dz] = [
      x - (centre[0] as number),
      y - (centre[1] as number),
      z - (centre[2] as number),
    ];
    const x1 = cy * dx - sy * dz;
    const z1 = sy * dx + cy * dz;
    return [x1, cp * dy - sp * z1, sp * dy + cp * z1];
  };
  const img: Rgba = { width, height, data: new Uint8Array(width * height * 4) };
  // Background: a light grey, opaque.
  for (let i = 0; i < width * height; i++) img.data.set([236, 238, 242, 255], i * 4);
  if (!n) return { img, triangles: 0, size };
  const pts = new Float32Array(n * 9);
  let ext = 0;
  for (let i = 0; i < n * 3; i++) {
    const [x, y, z] = project(
      tris[i * 3] as number,
      tris[i * 3 + 1] as number,
      tris[i * 3 + 2] as number,
    );
    pts.set([x, y, z], i * 3);
    ext = Math.max(ext, Math.abs(x) / width, Math.abs(y) / height);
  }
  const k = ext > 0 ? 0.45 / ext : 1;
  const zbuf = new Float32Array(width * height).fill(-Infinity);
  // Light from the viewer's upper left; a soft floor of ambient light.
  const light = [-0.4, 0.6, 0.7];
  const ll = Math.hypot(...light);
  for (let t = 0; t < n; t++) {
    const p = (j: number) => {
      const o = t * 9 + j * 3;
      return [
        width / 2 + (pts[o] as number) * k,
        height / 2 - (pts[o + 1] as number) * k,
        pts[o + 2] as number,
      ] as [number, number, number];
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    // The face's normal in camera space (both sides lit: models are not always closed).
    const o = t * 9;
    const ux = (pts[o + 3] as number) - (pts[o] as number);
    const uy = (pts[o + 4] as number) - (pts[o + 1] as number);
    const uz = (pts[o + 5] as number) - (pts[o + 2] as number);
    const vx = (pts[o + 6] as number) - (pts[o] as number);
    const vy = (pts[o + 7] as number) - (pts[o + 1] as number);
    const vz = (pts[o + 8] as number) - (pts[o + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const lambert = Math.abs(
      (nx * (light[0] as number) + ny * (light[1] as number) + nz * (light[2] as number)) /
        (nl * ll),
    );
    const shade = 0.28 + 0.72 * lambert;
    const colour = [
      Math.round(70 * shade + 30),
      Math.round(120 * shade + 30),
      Math.round(190 * shade + 40),
    ];
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const i = y * width + x;
        if (z <= (zbuf[i] as number)) continue;
        zbuf[i] = z;
        img.data.set([colour[0] as number, colour[1] as number, colour[2] as number, 255], i * 4);
      }
  }
  return { img, triangles: n, size };
}
