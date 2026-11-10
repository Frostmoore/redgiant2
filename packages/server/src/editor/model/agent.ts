// An agent's plain operations on a 3D model (G37.7, canvas_edit) turned into the family's actions
// on the glTF JSON, each on the model the one before left. Shapes are made with three.js's own
// geometries (the same the page uses) and kept in small buffers of their own inside the file.
import {
  type ModelMaterialSpec,
  type ModelPlainAction,
  modelAddMesh,
  modelAddNode,
  modelAttach,
  modelBase64,
  modelDetach,
  modelGet,
  modelIndexOf,
  modelMaterialJson,
  modelParentOf,
  modelPush,
  modelRun,
  modelUseExtension,
  round6,
} from "@redgiant/protocol";
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import {
  hexToLinear,
  lightsOf,
  localMatrix,
  materialsOfMesh,
  nodesOf,
  parentWorld,
  worldMatrices,
} from "./structure.js";

export const MODEL_CATALOG = `3D models (glTF/GLB; an OBJ, STL, PLY, FBX or .blend is edited on its GLB copy): canvas_edit "ops", applied in order. Objects are nodes named "n0", "n1"… and materials "m0", "m1"…: canvas_look view "structure" lists them with kind, name, local transform, box and material. Units are metres, +Y is up; "position" [x,y,z], "rotation" [x,y,z] in degrees (XYZ), "scale" [x,y,z] (or one number) are local to the parent. "parent" is a node id or "scene" (the default). Colours are "#rrggbb". Everything not touched stays in the file as it was (unknown extensions, extras, animations).
- {"op":"add_primitive","shape":"box","name":"Tavolo","width":2,"height":0.1,"depth":1,"position":[0,0.75,0],"color":"#8b5a2b","metalness":0,"roughness":0.7}: shapes box (width height depth), sphere (radius), cylinder (radius or radius_top/radius_bottom, height), cone (radius height), plane (width depth, lying flat), torus (radius tube); "segments" for round ones; "material":"m2" wears an existing material instead.
- {"op":"add_mesh","name":"Rampa","positions":[[0,0,0],[1,0,0],[1,1,0]],"triangles":[[0,1,2]],"color":"#cccccc"}: your own triangles (normals computed).
- {"op":"add_light","kind":"point|directional|spot","name":"Lampada","color":"#ffffff","intensity":20,"range":10,"position":[0,3,0],"look_at":[0,0,0],"outer_cone":30,"inner_cone":20}: intensity in candela (point, spot) or lux (directional); lights shine along their -Z ("look_at" turns them).
- {"op":"add_camera","kind":"perspective|orthographic","name":"Vista","yfov":50,"znear":0.1,"zfar":1000,"position":[4,3,4],"look_at":[0,0,0]} (orthographic: "xmag","ymag").
- {"op":"add_group","name":"Arredi","position":[0,0,0]}: an empty node to hang others under.
- {"op":"set_transform","id":"n3","position":[1,0,0],"rotation":[0,45,0],"scale":1.5} (any of them; "by":[dx,dy,dz] moves by that much; "look_at":[x,y,z] for cameras and lights).
- {"op":"set_material","id":"n3","color":"#ff0000","metalness":0.2,"roughness":0.4,"emissive":"#000000","opacity":0.5,"double_sided":true,"texture":"textures/legno.png"} ("id" a node, whose mesh's materials change, or a material "m2"; "texture" a picture of your workspace, null removes it; a node without a material gets one).
- {"op":"set_light","id":"n5","color":"#ffeecc","intensity":15,"range":8,"outer_cone":35}.
- {"op":"rename","id":"n3","name":"Sedia"} (a node or a material).
- {"op":"delete","ids":["n3","n4"]}: taken out of the scene (glTF keeps the node in the file, out of every scene).
- {"op":"reparent","id":"n3","parent":"n1","keep_world":true}: hung under another node or "scene"; with keep_world (the default) it stays where it is in the scene.
- {"op":"duplicate","id":"n3","name":"Sedia 2","by":[1,0,0]}: a copy of the node and its children (they share meshes and materials).`;

type Plain = Record<string, unknown>;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

class Bad extends Error {}
const bad = (why: string): never => {
  throw new Bad(why);
};

const num = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return bad(`"${what}" must be a number`);
  return n;
};
const optNum = (v: unknown, what: string) =>
  v === undefined || v === null ? undefined : num(v, what);
const pos = (v: unknown, what: string): number => {
  const n = num(v, what);
  if (n <= 0) bad(`"${what}" must be more than 0`);
  return n;
};
const vec3 = (v: unknown, what: string): [number, number, number] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return [v, v, v];
  if (Array.isArray(v) && v.length === 3)
    return v.map((x) => num(x, what)) as [number, number, number];
  if (isObj(v) && "x" in v) return [num(v.x, what), num(v.y, what), num(v.z, what)];
  return bad(`"${what}" is [x, y, z]`);
};
const color = (v: unknown, what: string): [number, number, number] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return bad(`"${what}" is a colour like "#ff8800"`);
  return hexToLinear(v) ?? bad(`"${what}" is a colour like "#ff8800"`);
};
const deg = (d: number) => (d * Math.PI) / 180;

const quatOf = (r: [number, number, number]) =>
  new Quaternion().setFromEuler(new Euler(deg(r[0]), deg(r[1]), deg(r[2]), "XYZ"));
const q4 = (q: Quaternion) => [q.x, q.y, q.z, q.w].map((x) => Math.round(x * 1e7) / 1e7);
const v3 = (v: Vector3) => [v.x, v.y, v.z].map(round6);

/** A rotation that turns -Z from `eye` towards `target` (cameras and lights). */
function lookRotation(eye: Vector3, target: Vector3): Quaternion {
  const m = new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0));
  if (Math.abs(new Vector3().subVectors(target, eye).normalize().y) > 0.999)
    m.lookAt(eye, target, new Vector3(0, 0, 1));
  return new Quaternion().setFromRotationMatrix(m);
}

/** The node's translation, rotation and scale from the operation (undefined: not given). */
function transformOf(
  o: Plain,
  start?: Obj,
): { translation?: number[]; rotation?: number[]; scale?: number[] } {
  const out: { translation?: number[]; rotation?: number[]; scale?: number[] } = {};
  const p = vec3(o.position, "position");
  if (p) out.translation = p.map(round6);
  const r = vec3(o.rotation, "rotation");
  if (r) out.rotation = q4(quatOf(r));
  if (Array.isArray(o.quaternion) && o.quaternion.length === 4)
    out.rotation = q4(new Quaternion(...o.quaternion.map((x) => num(x, "quaternion"))).normalize());
  const s = vec3(o.scale, "scale");
  if (s) {
    if (s.some((x) => x === 0)) bad('"scale" 0 makes the object vanish: delete it instead');
    out.scale = s.map(round6);
  }
  const look = vec3(o.look_at, "look_at");
  if (look) {
    const eye = new Vector3(
      ...((out.translation ?? (start?.translation as number[]) ?? [0, 0, 0]) as [
        number,
        number,
        number,
      ]),
    );
    out.rotation = q4(lookRotation(eye, new Vector3(...look)));
  }
  return out;
}

const nameOf = (o: Plain): string | undefined => {
  if (o.name === undefined || o.name === null) return undefined;
  if (typeof o.name !== "string" || !o.name.trim()) return bad('"name" is a text');
  return o.name.slice(0, 200);
};

/** A node built from an operation (name and transform). */
const nodeFrom = (o: Plain, extra: Obj = {}): Obj => {
  const name = nameOf(o);
  return { ...(name && { name }), ...transformOf(o), ...extra };
};

function geometryOf(o: Plain): BufferGeometry {
  const shape = String(o.shape ?? o.kind ?? "box").toLowerCase();
  const seg = Math.max(3, Math.min(256, Math.round(optNum(o.segments, "segments") ?? 32)));
  switch (shape) {
    case "box":
    case "cube": {
      const s = optNum(o.size, "size");
      return new BoxGeometry(
        pos(o.width ?? s ?? 1, "width"),
        pos(o.height ?? s ?? 1, "height"),
        pos(o.depth ?? s ?? 1, "depth"),
      );
    }
    case "sphere":
      return new SphereGeometry(
        pos(o.radius ?? 0.5, "radius"),
        seg,
        Math.max(2, Math.round(seg / 2)),
      );
    case "cylinder": {
      const r = optNum(o.radius, "radius");
      return new CylinderGeometry(
        pos(o.radius_top ?? r ?? 0.5, "radius_top"),
        pos(o.radius_bottom ?? r ?? 0.5, "radius_bottom"),
        pos(o.height ?? 1, "height"),
        seg,
      );
    }
    case "cone":
      return new ConeGeometry(pos(o.radius ?? 0.5, "radius"), pos(o.height ?? 1, "height"), seg);
    case "plane":
    case "floor": {
      const s = optNum(o.size, "size");
      const g = new PlaneGeometry(
        pos(o.width ?? s ?? 1, "width"),
        pos(o.depth ?? o.height ?? s ?? 1, "depth"),
      );
      g.rotateX(-Math.PI / 2);
      return g;
    }
    case "torus":
      return new TorusGeometry(
        pos(o.radius ?? 0.5, "radius"),
        pos(o.tube ?? 0.2, "tube"),
        Math.max(3, Math.round(seg / 2)),
        seg,
      );
    default:
      return bad(`no shape "${shape}": box, sphere, cylinder, cone, plane, torus`);
  }
}

/** A geometry's arrays as the protocol's mesh builder takes them. */
export function geometryArrays(g: BufferGeometry) {
  const a = g.attributes;
  return {
    position: (a.position?.array ?? []) as ArrayLike<number>,
    normal: a.normal?.array as ArrayLike<number> | undefined,
    uv: a.uv?.array as ArrayLike<number> | undefined,
    index: g.index?.array as ArrayLike<number> | undefined,
  };
}

/** The material an operation asks for (its colour, metalness…), or an existing one ("m2"). */
function materialSpec(root: unknown, o: Plain): ModelMaterialSpec | number {
  if (o.material !== undefined) {
    const m = modelIndexOf(o.material, "m");
    const all = modelGet(root, ["materials"]);
    if (m === undefined || !Array.isArray(all) || m >= all.length)
      bad(`no material ${String(o.material)}`);
    return m as number;
  }
  const c = color(o.color, "color") ?? [0.8, 0.8, 0.8];
  const opacity = optNum(o.opacity, "opacity") ?? 1;
  const em = color(o.emissive, "emissive");
  return {
    name: typeof o.material_name === "string" ? o.material_name : nameOf(o),
    color: [c[0], c[1], c[2], Math.max(0, Math.min(1, opacity))],
    metallic: Math.max(0, Math.min(1, optNum(o.metalness, "metalness") ?? 0)),
    roughness: Math.max(0, Math.min(1, optNum(o.roughness, "roughness") ?? 0.6)),
    emissive: em,
    doubleSided: o.double_sided === true,
  };
}

/** Sets a value deep down, making the objects above it when they are missing. */
export function setAt(root: unknown, path: (string | number)[], value: unknown): ModelPlainAction {
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

class Builder {
  out: ModelPlainAction[] = [];
  constructor(public root: unknown) {}
  push(acts: readonly ModelPlainAction[]) {
    this.out.push(...acts);
    this.root = modelRun(this.root, acts);
  }
  node(ref: unknown, what = "id"): number {
    const i = modelIndexOf(ref, "n");
    if (i === undefined) return bad(`"${what}" is a node like "n3"`);
    if (i >= nodesOf(this.root).length) bad(`there is no node n${i}`);
    return i;
  }
  parent(ref: unknown): number | "scene" {
    if (ref === undefined || ref === null || ref === "scene" || ref === "") return "scene";
    return this.node(ref, "parent");
  }
  get(path: (string | number)[]) {
    return modelGet(this.root, path);
  }
}

/** Sets a node's transform: a node with a matrix gets translation, rotation and scale. */
function setTransform(
  b: Builder,
  i: number,
  t: { translation?: number[]; rotation?: number[]; scale?: number[] },
) {
  const n = nodesOf(b.root)[i] as Obj;
  const acts: ModelPlainAction[] = [];
  if (Array.isArray(n.matrix)) {
    const m = localMatrix(n);
    const tt = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    m.decompose(tt, q, s);
    acts.push({ t: "set", path: ["nodes", i, "matrix"] });
    acts.push({ t: "set", path: ["nodes", i, "translation"], value: t.translation ?? v3(tt) });
    acts.push({ t: "set", path: ["nodes", i, "rotation"], value: t.rotation ?? q4(q) });
    acts.push({ t: "set", path: ["nodes", i, "scale"], value: t.scale ?? v3(s) });
  } else {
    if (t.translation)
      acts.push({ t: "set", path: ["nodes", i, "translation"], value: t.translation });
    if (t.rotation) acts.push({ t: "set", path: ["nodes", i, "rotation"], value: t.rotation });
    if (t.scale) acts.push({ t: "set", path: ["nodes", i, "scale"], value: t.scale });
  }
  b.push(acts);
}

/** The materials an operation's "id" names: a material, or a node's mesh's (one made if none). */
function materialsFor(b: Builder, ref: unknown): number[] {
  const m =
    typeof ref === "string" && /^m\d+$/.test(ref.trim()) ? modelIndexOf(ref, "m") : undefined;
  if (m !== undefined) {
    const all = b.get(["materials"]);
    if (!Array.isArray(all) || m >= all.length) bad(`there is no material m${m}`);
    return [m];
  }
  const i = b.node(ref);
  const n = nodesOf(b.root)[i] as Obj;
  if (typeof n.mesh !== "number") bad(`n${i} is not a mesh (it has no material)`);
  const mesh = n.mesh as number;
  const have = materialsOfMesh(b.root, mesh);
  const prims = b.get(["meshes", mesh, "primitives"]);
  const bare = (Array.isArray(prims) ? prims : []).flatMap((p, k) =>
    isObj(p) && typeof p.material !== "number" ? [k] : [],
  );
  if (!bare.length) return have;
  const made = modelPush(b.root, ["materials"], modelMaterialJson({ color: [0.8, 0.8, 0.8, 1] }));
  b.push(made.acts);
  b.push(
    bare.map((k) => ({
      t: "set",
      path: ["meshes", mesh, "primitives", k, "material"],
      value: made.index,
    })),
  );
  return [...have, made.index];
}

function setMaterial(b: Builder, o: Plain) {
  const mats = materialsFor(b, o.id);
  const c = color(o.color, "color");
  const opacity = optNum(o.opacity, "opacity");
  const metal = optNum(o.metalness ?? o.metallic, "metalness");
  const rough = optNum(o.roughness, "roughness");
  const em = color(o.emissive, "emissive");
  const tex = o.texture as { image?: number; mime: string; data: string } | null | undefined;
  for (const m of mats) {
    const base = ["materials", m, "pbrMetallicRoughness"];
    if (c || opacity !== undefined) {
      const old = (b.get([...base, "baseColorFactor"]) as number[] | undefined) ?? [1, 1, 1, 1];
      const a = opacity === undefined ? (old[3] ?? 1) : Math.max(0, Math.min(1, opacity));
      b.push([
        setAt(b.root, [...base, "baseColorFactor"], [...(c ?? old.slice(0, 3)), a].map(round6)),
      ]);
      if (opacity !== undefined) {
        const mode = b.get(["materials", m, "alphaMode"]);
        if (a < 1 && mode !== "BLEND")
          b.push([{ t: "set", path: ["materials", m, "alphaMode"], value: "BLEND" }]);
        if (a >= 1 && mode === "BLEND") b.push([{ t: "set", path: ["materials", m, "alphaMode"] }]);
      }
    }
    if (metal !== undefined)
      b.push([setAt(b.root, [...base, "metallicFactor"], round6(Math.max(0, Math.min(1, metal))))]);
    if (rough !== undefined)
      b.push([
        setAt(b.root, [...base, "roughnessFactor"], round6(Math.max(0, Math.min(1, rough)))),
      ]);
    if (em) b.push([{ t: "set", path: ["materials", m, "emissiveFactor"], value: em.map(round6) }]);
    if (o.double_sided !== undefined)
      b.push([
        o.double_sided
          ? { t: "set", path: ["materials", m, "doubleSided"], value: true }
          : { t: "set", path: ["materials", m, "doubleSided"] },
      ]);
    if (tex === null) {
      if (b.get([...base, "baseColorTexture"]) !== undefined)
        b.push([{ t: "set", path: [...base, "baseColorTexture"] }]);
    } else if (tex) {
      let image = tex.image;
      if (image === undefined) {
        const img = modelPush(b.root, ["images"], {
          mimeType: tex.mime,
          uri: `data:${tex.mime};base64,${tex.data}`,
        });
        b.push(img.acts);
        image = img.index;
        tex.image = image;
      }
      const t = modelPush(b.root, ["textures"], { source: image });
      b.push(t.acts);
      b.push([setAt(b.root, [...base, "baseColorTexture"], { index: t.index })]);
    }
    if (typeof o.material_name === "string")
      b.push([{ t: "set", path: ["materials", m, "name"], value: o.material_name }]);
  }
}

function lightOf(b: Builder, i: number): number {
  const n = nodesOf(b.root)[i] as Obj;
  const l =
    isObj(n.extensions) && isObj(n.extensions.KHR_lights_punctual)
      ? n.extensions.KHR_lights_punctual.light
      : undefined;
  if (typeof l !== "number" || l >= lightsOf(b.root).length) bad(`n${i} is not a light`);
  return l as number;
}

function lightJson(o: Plain, kind: string): Obj {
  if (!["point", "directional", "spot"].includes(kind)) bad('"kind" is point, directional or spot');
  const c = color(o.color, "color");
  const out: Obj = {
    ...(nameOf(o) && { name: nameOf(o) }),
    type: kind,
    ...(c && { color: c.map(round6) }),
    intensity: round6(optNum(o.intensity, "intensity") ?? (kind === "directional" ? 3 : 20)),
  };
  const range = optNum(o.range, "range");
  if (range !== undefined && kind !== "directional") out.range = round6(pos(range, "range"));
  if (kind === "spot") {
    const outer = deg(optNum(o.outer_cone, "outer_cone") ?? 45);
    const inner = deg(optNum(o.inner_cone, "inner_cone") ?? 0);
    if (outer <= 0 || outer > Math.PI / 2) bad('"outer_cone" is between 0 and 90 degrees');
    out.spot = {
      innerConeAngle: round6(Math.min(inner, outer - 1e-4)),
      outerConeAngle: round6(outer),
    };
  }
  return out;
}

/** A copy of a node and its children as new nodes (meshes, cameras and lights shared). */
function duplicate(b: Builder, i: number, parent: number | "scene", top: Obj): number {
  const copyOne = (k: number, extra: Obj): number => {
    const n = { ...(nodesOf(b.root)[k] as Obj), ...extra };
    const kids = Array.isArray(n.children) ? (n.children as number[]) : [];
    delete n.children;
    const p = modelPush(b.root, ["nodes"], n);
    b.push(p.acts);
    for (const c of kids) {
      const ci = copyOne(c, {});
      b.push(modelAttach(b.root, ci, p.index));
    }
    return p.index;
  };
  const idx = copyOne(i, top);
  b.push(modelAttach(b.root, idx, parent));
  return idx;
}

function one(b: Builder, o: Plain): void {
  const name = String(o.op ?? o.action ?? o.type ?? "").toLowerCase();
  switch (name) {
    case "add_primitive":
    case "add_shape": {
      const g = geometryOf(o);
      const r = modelAddMesh(b.root, geometryArrays(g), {
        node: nodeFrom(o),
        material: materialSpec(b.root, o),
        parent: b.parent(o.parent),
        meshName: nameOf(o),
      });
      b.push(r.acts);
      return;
    }
    case "add_mesh": {
      const raw = o.positions;
      if (!Array.isArray(raw) || !raw.length) bad('"positions" is a list of [x, y, z]');
      const flat = (raw as unknown[])
        .flatMap((p) => (Array.isArray(p) ? p : [p]))
        .map((x) => num(x, "positions"));
      if (flat.length % 3) bad('"positions" is a list of [x, y, z]');
      if (flat.length / 3 > 200_000) bad("at most 200000 points");
      const tri = o.triangles ?? o.indices;
      const index = Array.isArray(tri)
        ? (tri as unknown[]).flat().map((x) => num(x, "triangles"))
        : undefined;
      if (index && index.length % 3) bad('"triangles" is a list of [a, b, c]');
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(flat, 3));
      if (index) g.setIndex(index);
      g.computeVertexNormals();
      const r = modelAddMesh(b.root, geometryArrays(g), {
        node: nodeFrom(o),
        material: materialSpec(b.root, o),
        parent: b.parent(o.parent),
        meshName: nameOf(o),
      });
      b.push(r.acts);
      return;
    }
    case "add_light": {
      const kind = String(o.kind ?? o.type_of ?? "point").toLowerCase();
      const l = modelPush(
        b.root,
        ["extensions", "KHR_lights_punctual", "lights"],
        lightJson(o, kind),
      );
      b.push(l.acts);
      b.push(modelUseExtension(b.root, "KHR_lights_punctual"));
      b.push(
        modelAddNode(
          b.root,
          nodeFrom(o, { extensions: { KHR_lights_punctual: { light: l.index } } }),
          b.parent(o.parent),
        ).acts,
      );
      return;
    }
    case "add_camera": {
      const kind = String(o.kind ?? "perspective").toLowerCase();
      let cam: Obj;
      const znear = pos(o.znear ?? 0.1, "znear");
      const zfar = pos(o.zfar ?? 1000, "zfar");
      if (zfar <= znear) bad('"zfar" must be beyond "znear"');
      if (kind === "perspective") {
        const yfov = optNum(o.yfov, "yfov") ?? 50;
        if (yfov <= 0 || yfov >= 180) bad('"yfov" is between 0 and 180 degrees');
        const aspect = optNum(o.aspect, "aspect");
        cam = {
          type: "perspective",
          perspective: {
            yfov: round6(deg(yfov)),
            znear,
            zfar,
            ...(aspect && { aspectRatio: aspect }),
          },
        };
      } else if (kind === "orthographic") {
        cam = {
          type: "orthographic",
          orthographic: {
            xmag: pos(o.xmag ?? 5, "xmag"),
            ymag: pos(o.ymag ?? 5, "ymag"),
            znear,
            zfar,
          },
        };
      } else throw new Bad('"kind" is perspective or orthographic');
      const name = nameOf(o);
      const c = modelPush(b.root, ["cameras"], { ...(name && { name }), ...cam });
      b.push(c.acts);
      b.push(modelAddNode(b.root, nodeFrom(o, { camera: c.index }), b.parent(o.parent)).acts);
      return;
    }
    case "add_group":
    case "add_empty":
      b.push(modelAddNode(b.root, nodeFrom(o), b.parent(o.parent)).acts);
      return;
    case "set_transform":
    case "move":
    case "rotate":
    case "scale": {
      const i = b.node(o.id);
      const n = nodesOf(b.root)[i] as Obj;
      const t = transformOf(o, n);
      const by = vec3(o.by, "by");
      if (by) {
        const cur = new Vector3();
        localMatrix(n).decompose(cur, new Quaternion(), new Vector3());
        const base = t.translation ?? [cur.x, cur.y, cur.z];
        t.translation = base.map((x, k) => round6(x + (by[k] as number)));
      }
      if (!t.translation && !t.rotation && !t.scale)
        bad("give position, rotation, scale, by or look_at");
      setTransform(b, i, t);
      return;
    }
    case "set_material":
      setMaterial(b, o);
      return;
    case "set_light": {
      const i = b.node(o.id);
      const l = lightOf(b, i);
      const base = ["extensions", "KHR_lights_punctual", "lights", l];
      const c = color(o.color, "color");
      if (c) b.push([{ t: "set", path: [...base, "color"], value: c.map(round6) }]);
      const inten = optNum(o.intensity, "intensity");
      if (inten !== undefined)
        b.push([{ t: "set", path: [...base, "intensity"], value: round6(Math.max(0, inten)) }]);
      const range = optNum(o.range, "range");
      if (range !== undefined)
        b.push([{ t: "set", path: [...base, "range"], value: round6(pos(range, "range")) }]);
      const type = b.get([...base, "type"]);
      for (const [k, key] of [
        ["outer_cone", "outerConeAngle"],
        ["inner_cone", "innerConeAngle"],
      ] as const) {
        const v = optNum(o[k], k);
        if (v === undefined) continue;
        if (type !== "spot") bad(`"${k}" is for spot lights`);
        b.push([setAt(b.root, [...base, "spot", key], round6(deg(v)))]);
      }
      if (typeof o.name === "string")
        b.push([{ t: "set", path: [...base, "name"], value: o.name }]);
      return;
    }
    case "rename": {
      const name = nameOf(o) ?? bad('give "name"');
      if (typeof o.id === "string" && /^m\d+$/.test(o.id.trim())) {
        const m = materialsFor(b, o.id)[0] as number;
        b.push([{ t: "set", path: ["materials", m, "name"], value: name }]);
      } else b.push([{ t: "set", path: ["nodes", b.node(o.id), "name"], value: name }]);
      return;
    }
    case "delete":
    case "remove": {
      const ids = Array.isArray(o.ids) ? o.ids : o.id !== undefined ? [o.id] : bad('give "ids"');
      for (const ref of ids as unknown[]) {
        const i = b.node(ref);
        const acts = modelDetach(b.root, i);
        if (!acts.length) bad(`n${i} is not in the scene (already deleted?)`);
        b.push(acts);
      }
      return;
    }
    case "reparent": {
      const i = b.node(o.id);
      const parent = b.parent(o.parent);
      if (parent !== "scene") {
        // Not under itself or its own children.
        let p: number | "scene" | undefined = parent;
        for (let k = 0; p !== undefined && p !== "scene" && k < 200; k++) {
          if (p === i) bad(`n${i} cannot hang under itself or its own children`);
          p = modelParentOf(b.root, p)?.parent;
        }
      }
      const keep = o.keep_world !== false;
      const world = worldMatrices(b.root).get(i);
      b.push(modelDetach(b.root, i));
      b.push(
        modelAttach(
          b.root,
          i,
          parent,
          o.before === undefined ? undefined : b.node(o.before, "before"),
        ),
      );
      if (keep && world) {
        const local = parentWorld(b.root, i).invert().multiply(world);
        const t = new Vector3();
        const q = new Quaternion();
        const s = new Vector3();
        local.decompose(t, q, s);
        const n = nodesOf(b.root)[i] as Obj;
        const before = localMatrix(n);
        if (!before.equals(local))
          setTransform(b, i, { translation: v3(t), rotation: q4(q), scale: v3(s) });
      }
      return;
    }
    case "duplicate":
    case "copy": {
      const i = b.node(o.id);
      const where = modelParentOf(b.root, i);
      const n = nodesOf(b.root)[i] as Obj;
      const t = transformOf(o, n);
      const by = vec3(o.by, "by");
      if (by) {
        const cur = new Vector3();
        localMatrix(n).decompose(cur, new Quaternion(), new Vector3());
        t.translation = (t.translation ?? [cur.x, cur.y, cur.z]).map((x, k) =>
          round6(x + (by[k] as number)),
        );
      }
      const name = nameOf(o) ?? (typeof n.name === "string" ? `${n.name} 2` : undefined);
      const top: Obj = { ...(name && { name }) };
      if (Array.isArray(n.matrix) && (t.translation || t.rotation || t.scale))
        bad(`n${i} has a matrix: set its transform first`);
      Object.assign(top, t);
      duplicate(
        b,
        i,
        o.parent !== undefined
          ? b.parent(o.parent)
          : where && where.parent !== "scene"
            ? where.parent
            : "scene",
        top,
      );
      return;
    }
    default:
      bad(
        `no operation "${name}": add_primitive, add_mesh, add_light, add_camera, add_group, set_transform, set_material, set_light, rename, delete, reparent, duplicate`,
      );
  }
}

/** An agent's operations as actions, each on the model the one before left. */
export function modelFromAgent(
  root: unknown,
  ops: readonly unknown[],
): { actions: ModelPlainAction[] } | { error: string; index: number } {
  const b = new Builder(root);
  for (const [index, raw] of ops.entries()) {
    try {
      if (!raw || typeof raw !== "object") bad("an operation is an object");
      one(b, raw as Plain);
    } catch (err) {
      if (!(err instanceof Bad) && !(err instanceof Error)) throw err;
      return { error: (err as Error).message, index };
    }
  }
  if (!b.out.length) return { error: "these operations change nothing", index: 0 };
  return { actions: b.out };
}

/** The pictures an agent names for textures, read from its workspace (canvas_edit prepare). */
export async function prepareModelOps(
  ops: readonly unknown[],
  read: (path: string) => Promise<Uint8Array>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const cache = new Map<string, { mime: string; data: string }>();
  for (const raw of ops) {
    const x = raw as Plain;
    if (x && typeof x === "object" && typeof x.texture === "string") {
      const path = x.texture;
      let t = cache.get(path);
      if (!t) {
        const bytes = await read(path);
        if (bytes.length > 8 * 1024 * 1024)
          throw new Error(`${path} is over 8 MB: make it smaller first`);
        const mime =
          bytes[0] === 0x89 && bytes[1] === 0x50
            ? "image/png"
            : bytes[0] === 0xff && bytes[1] === 0xd8
              ? "image/jpeg"
              : bytes[0] === 0x52 && bytes[8] === 0x57
                ? "image/webp"
                : undefined;
        if (!mime) throw new Error(`${path} is not a PNG, JPEG or WebP picture`);
        t = { mime, data: modelBase64(bytes) };
        cache.set(path, t);
      }
      out.push({ ...x, texture: { ...t } });
    } else out.push(raw);
  }
  return out;
}
