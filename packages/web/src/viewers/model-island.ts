// The 3D editor's stage (G37.7), loaded only when a model opens (three.js and its examples, MIT):
// the model read from the host's glTF JSON (and the file's binary chunk) with three.js's GLTFLoader,
// orbit controls, the transform handles (TransformControls), picking, outlines of what the agents
// just changed, a soft studio environment, and the exporters for «Esporta come…». Others' changes
// to transforms, names and materials are patched in place; anything else reloads the scene from
// the JSON (the view and the selection stay).
import type { ModelAction, ModelGeometry } from "@redgiant/protocol";
import { modelPlainOf } from "@redgiant/protocol";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AddWhat, Trs } from "./model-ops.js";

export type GizmoMode = "translate" | "rotate" | "scale";

export interface ModelIslandHooks {
  onSelect(node: number | undefined): void;
  /** A drag of the handles ended: the node's new local transform. */
  onTransform(node: number, trs: Trs): void;
  /** The person holds the handles (presence: the agents' edits wait). */
  onDragging(on: boolean): void;
}

export interface ModelIsland {
  /** The model from its JSON (and a GLB's binary chunk); `base` resolves a .gltf's files. */
  load(json: string, bin: Uint8Array | undefined, base: string, frame: boolean): Promise<void>;
  /** The JSON changed by these actions: patched in place when it can be, reloaded otherwise. */
  changed(root: unknown, actions: readonly ModelAction[]): void;
  /** A node's local transform as the scene has it now. */
  trsOf(node: number): Trs | undefined;
  select(node: number | undefined): void;
  setMode(m: GizmoMode): void;
  setSpace(local: boolean): void;
  frame(): void;
  /** Outlines nodes a while (an agent's change); returns a function that takes them away. */
  outline(nodes: readonly number[]): () => void;
  /** Where the camera looks from now (a camera added from the view). */
  view(): { position: number[]; rotation: number[]; yfov: number; target: number[] };
  /** A point in front of the view, on the ground (where new things go). */
  spot(): number[];
  /** A node's local transform that keeps its place in the scene under another parent. */
  keepWorld(node: number, parent: number | "scene"): Trs | undefined;
  geometry(shape: AddWhat): ModelGeometry;
  setStudio(on: boolean): void;
  picture(): Promise<Blob>;
  exportAs(format: "glb" | "obj" | "stl" | "ply" | "usdz"): Promise<Blob>;
  stats(): { triangles: number; nodes: number };
  dispose(): void;
}

const GLB_MAGIC = 0x46546c67;

/** A GLB from JSON text and a binary chunk (what GLTFLoader reads). */
function glbOf(json: string, bin: Uint8Array | undefined): ArrayBuffer {
  let j = new TextEncoder().encode(json);
  if (j.length % 4) {
    const p = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
    p.set(j);
    j = p;
  }
  const bl = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 20 + j.length + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  if (bin) {
    dv.setUint32(20 + j.length, bl, true);
    dv.setUint32(24 + j.length, 0x004e4942, true);
    out.set(bin, 28 + j.length);
  }
  return out.buffer;
}

/** The binary chunk of a GLB file's bytes. */
export function binOfGlb(bytes: Uint8Array): Uint8Array | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint32(0, true) !== GLB_MAGIC) return undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const len = dv.getUint32(at, true);
    if (dv.getUint32(at + 4, true) === 0x004e4942)
      // A chunk cut short (the file still being written, p3.5.6) is no chunk.
      return at + 8 + len <= bytes.length ? bytes.subarray(at + 8, at + 8 + len) : undefined;
    at += 8 + len;
  }
  return undefined;
}

/** Whether a GLB's bytes are whole: its declared length there, and every chunk inside it. */
export function glbComplete(bytes: Uint8Array): boolean {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint32(0, true) !== GLB_MAGIC) return false;
  if (dv.getUint32(8, true) > bytes.length) return false;
  let at = 12;
  while (at + 8 <= bytes.length) at += 8 + dv.getUint32(at, true);
  return at === bytes.length || at === dv.getUint32(8, true);
}

/**
 * Which three.js object is which glTF node and material (GLTFLoader's associations). Tolerant
 * (p3.5.6, a model saved by Blender: «Cannot read properties of undefined (reading 'nodes')»):
 * GLTFLoader leaves an entry without mapping for the variant of its default material (vertex
 * colours, flat shading on a primitive without a material).
 */
export function indexAssociations(associations: ReadonlyMap<unknown, unknown>): {
  byNode: Map<number, THREE.Object3D>;
  nodeOf: Map<THREE.Object3D, number>;
  mats: Map<number, THREE.Material[]>;
} {
  const byNode = new Map<number, THREE.Object3D>();
  const nodeOf = new Map<THREE.Object3D, number>();
  const mats = new Map<number, THREE.Material[]>();
  for (const [o, a] of associations) {
    if (!o || !a || typeof a !== "object") continue;
    const x = a as { nodes?: number; materials?: number };
    if (typeof x.nodes === "number" && (o as THREE.Object3D).isObject3D) {
      byNode.set(x.nodes, o as THREE.Object3D);
      nodeOf.set(o as THREE.Object3D, x.nodes);
    }
    if (typeof x.materials === "number" && (o as THREE.Material).isMaterial) {
      const list = mats.get(x.materials) ?? [];
      list.push(o as THREE.Material);
      mats.set(x.materials, list);
    }
  }
  return { byNode, nodeOf, mats };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** What patching in place knows how to follow; everything else reloads. */
function patchable(actions: readonly ModelAction[]): boolean {
  return actions.flatMap(modelPlainOf).every((a) => {
    if (a.t !== "set") return false;
    const p = a.path;
    if (p[0] === "nodes" && typeof p[1] === "number" && p.length === 3)
      return ["translation", "rotation", "scale", "matrix", "name"].includes(String(p[2]));
    if (p[0] === "materials" && typeof p[1] === "number")
      return !p.includes("baseColorTexture") && !p.includes("extensions");
    return false;
  });
}

export function mountModel(area: HTMLElement, hooks: ModelIslandHooks): ModelIsland {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.domElement.className = "model-canvas";
  area.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  const studio = new THREE.Group();
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 6, 4);
  studio.add(sun, new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.6));
  scene.add(studio);
  const grid = new THREE.GridHelper(10, 20, 0x8890a0, 0xb8bec8);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.45;
  scene.add(grid);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
  camera.position.set(3, 2.4, 4);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSize(0.9);
  const gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);

  let gltf: GLTF | undefined;
  let content: THREE.Object3D | undefined;
  let byNode = new Map<number, THREE.Object3D>();
  let nodeOf = new Map<THREE.Object3D, number>();
  let mats = new Map<number, THREE.Material[]>();
  let root: Obj = {};
  let selected: number | undefined;
  let selBox: THREE.BoxHelper | undefined;
  const marks = new Set<THREE.BoxHelper>();
  let base = "";
  let bin: Uint8Array | undefined;
  let loading: Promise<void> = Promise.resolve();
  let disposed = false;

  const resize = () => {
    const w = Math.max(1, area.clientWidth);
    const h = Math.max(1, area.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(area);
  resize();

  let frameId = 0;
  const loop = () => {
    frameId = requestAnimationFrame(loop);
    orbit.update();
    selBox?.update();
    for (const m of marks) m.update();
    renderer.render(scene, camera);
  };
  loop();

  const index = (g: GLTF) => {
    ({ byNode, nodeOf, mats } = indexAssociations(g.parser.associations));
  };

  const bounds = () => {
    const b = new THREE.Box3();
    if (content) b.setFromObject(content);
    return b;
  };

  const frame = () => {
    const b = bounds();
    if (b.isEmpty()) return;
    const size = b.getSize(new THREE.Vector3());
    const center = b.getCenter(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 0.01);
    const d = r / Math.sin((camera.fov * Math.PI) / 360);
    const dir = new THREE.Vector3(0.9, 0.7, 1.1).normalize();
    camera.position.copy(center).addScaledVector(dir, d * 1.05);
    camera.near = Math.max(d / 1000, 0.001);
    camera.far = d * 100;
    camera.updateProjectionMatrix();
    orbit.target.copy(center);
    orbit.update();
    // The ground: under the model, sized to it.
    const s = Math.max(1, 10 ** Math.ceil(Math.log10(Math.max(size.x, size.z) * 2)));
    grid.scale.setScalar(s / 10);
    grid.position.set(center.x, b.min.y, center.z);
  };

  const showSelection = () => {
    if (selBox) {
      scene.remove(selBox);
      selBox.dispose();
      selBox = undefined;
    }
    const o = selected === undefined ? undefined : byNode.get(selected);
    if (o) {
      gizmo.attach(o);
      selBox = new THREE.BoxHelper(o, 0x3b82f6);
      scene.add(selBox);
    } else gizmo.detach();
  };

  const build = async (json: string, frameIt: boolean) => {
    const loader = new GLTFLoader();
    const data: ArrayBuffer | string = bin ? glbOf(json, bin) : json;
    const g = await loader.parseAsync(data, base);
    if (disposed) return;
    if (content) {
      scene.remove(content);
      content.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
    }
    gltf = g;
    // A glTF without scenes (allowed) shows nothing rather than failing.
    content = g.scene ?? g.scenes?.[0] ?? new THREE.Group();
    scene.add(content);
    index(g);
    showSelection();
    if (frameIt) frame();
  };

  const patch = (actions: readonly ModelAction[]) => {
    const nodes = (Array.isArray(root.nodes) ? root.nodes : []) as Obj[];
    for (const a of actions.flatMap(modelPlainOf)) {
      if (a.t !== "set") continue;
      const p = a.path;
      if (p[0] === "nodes" && typeof p[1] === "number") {
        const o = byNode.get(p[1]);
        const n = nodes[p[1]];
        if (!o || !n) continue;
        if (p[2] === "name") {
          o.name = typeof n.name === "string" ? n.name : "";
          continue;
        }
        const m = Array.isArray(n.matrix)
          ? new THREE.Matrix4().fromArray(n.matrix as number[])
          : new THREE.Matrix4().compose(
              new THREE.Vector3(...((n.translation as [number, number, number]) ?? [0, 0, 0])),
              new THREE.Quaternion(
                ...((n.rotation as [number, number, number, number]) ?? [0, 0, 0, 1]),
              ),
              new THREE.Vector3(...((n.scale as [number, number, number]) ?? [1, 1, 1])),
            );
        m.decompose(o.position, o.quaternion, o.scale);
      } else if (p[0] === "materials" && typeof p[1] === "number") {
        const m = ((root.materials as Obj[] | undefined) ?? [])[p[1]];
        if (!isObj(m)) continue;
        const pbr = isObj(m.pbrMetallicRoughness) ? m.pbrMetallicRoughness : {};
        const c = (pbr.baseColorFactor as number[] | undefined) ?? [1, 1, 1, 1];
        const em = (m.emissiveFactor as number[] | undefined) ?? [0, 0, 0];
        for (const mat of mats.get(p[1]) ?? []) {
          const s = mat as THREE.MeshStandardMaterial;
          s.color?.setRGB(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, THREE.LinearSRGBColorSpace);
          s.opacity = c[3] ?? 1;
          s.transparent = m.alphaMode === "BLEND";
          if ("metalness" in s)
            s.metalness = typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1;
          if ("roughness" in s)
            s.roughness = typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1;
          s.emissive?.setRGB(em[0] ?? 0, em[1] ?? 0, em[2] ?? 0, THREE.LinearSRGBColorSpace);
          s.side = m.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
          s.needsUpdate = true;
        }
      }
    }
  };

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const rebuildSoon = () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      const json = JSON.stringify(root);
      loading = loading.then(() => build(json, false)).catch(() => {});
    }, 40);
  };

  // Picking: a click (not a drag) selects the node under the pointer.
  let down: { x: number; y: number } | undefined;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!down || gizmo.dragging) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = undefined;
    if (moved > 4 || !content) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(content, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !nodeOf.has(o)) o = o.parent;
    const n = o ? nodeOf.get(o) : undefined;
    selected = n;
    showSelection();
    hooks.onSelect(n);
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);

  gizmo.addEventListener("dragging-changed", (e) => {
    const on = (e as unknown as { value: boolean }).value;
    orbit.enabled = !on;
    hooks.onDragging(on);
    if (on || selected === undefined) return;
    const o = byNode.get(selected);
    if (!o) return;
    hooks.onTransform(selected, {
      translation: o.position.toArray(),
      rotation: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
      scale: o.scale.toArray(),
    });
  });

  return {
    async load(json, b, resourceBase, frameIt) {
      bin = b;
      base = resourceBase;
      root = JSON.parse(json) as Obj;
      const run = loading.then(() => build(json, frameIt));
      loading = run.catch(() => {});
      await run;
    },
    changed(next, actions) {
      root = (isObj(next) ? next : {}) as Obj;
      if (patchable(actions) && gltf) patch(actions);
      else rebuildSoon();
    },
    trsOf(n) {
      const o = byNode.get(n);
      if (!o) return undefined;
      return {
        translation: o.position.toArray(),
        rotation: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
        scale: o.scale.toArray(),
      };
    },
    select(n) {
      selected = n;
      showSelection();
    },
    setMode(m) {
      gizmo.setMode(m);
    },
    setSpace(local) {
      gizmo.setSpace(local ? "local" : "world");
    },
    frame,
    outline(nodes) {
      const made: THREE.BoxHelper[] = [];
      for (const n of nodes) {
        const o = byNode.get(n);
        if (!o) continue;
        const h = new THREE.BoxHelper(o, 0xe0562b);
        scene.add(h);
        marks.add(h);
        made.push(h);
      }
      return () => {
        for (const h of made) {
          scene.remove(h);
          marks.delete(h);
          h.dispose();
        }
      };
    },
    view() {
      return {
        position: camera.position.toArray(),
        rotation: [
          camera.quaternion.x,
          camera.quaternion.y,
          camera.quaternion.z,
          camera.quaternion.w,
        ],
        yfov: (camera.fov * Math.PI) / 180,
        target: orbit.target.toArray(),
      };
    },
    spot() {
      const t = orbit.target.clone();
      const b = bounds();
      if (!b.isEmpty()) t.y = b.min.y;
      return t.toArray().map((x) => Math.round(x * 1000) / 1000);
    },
    keepWorld(node, parent) {
      const o = byNode.get(node);
      if (!o) return undefined;
      o.updateWorldMatrix(true, false);
      const world = o.matrixWorld.clone();
      const p = parent === "scene" ? content : byNode.get(parent);
      if (!p) return undefined;
      p.updateWorldMatrix(true, false);
      const local = p.matrixWorld.clone().invert().multiply(world);
      const t = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      local.decompose(t, q, s);
      return { translation: t.toArray(), rotation: [q.x, q.y, q.z, q.w], scale: s.toArray() };
    },
    geometry(shape) {
      const g =
        shape === "sphere"
          ? new THREE.SphereGeometry(0.5, 32, 16)
          : shape === "cylinder"
            ? new THREE.CylinderGeometry(0.5, 0.5, 1, 32)
            : shape === "cone"
              ? new THREE.ConeGeometry(0.5, 1, 32)
              : shape === "torus"
                ? new THREE.TorusGeometry(0.4, 0.15, 16, 48)
                : shape === "plane"
                  ? new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)
                  : new THREE.BoxGeometry(1, 1, 1);
      // Shapes sit on the ground where they go.
      if (shape !== "plane") {
        g.computeBoundingBox();
        g.translate(0, -(g.boundingBox?.min.y ?? 0), 0);
      }
      return {
        position: g.attributes.position?.array as ArrayLike<number>,
        normal: g.attributes.normal?.array as ArrayLike<number>,
        uv: g.attributes.uv?.array as ArrayLike<number>,
        index: g.index?.array as ArrayLike<number> | undefined,
      };
    },
    setStudio(on) {
      studio.visible = on;
      scene.environment = on ? env : null;
    },
    async picture() {
      renderer.render(scene, camera);
      return new Promise<Blob>((ok, ko) =>
        renderer.domElement.toBlob((b) => (b ? ok(b) : ko(new Error("PNG"))), "image/png"),
      );
    },
    async exportAs(format) {
      if (!content) throw new Error("nothing to export");
      const target = content;
      if (format === "glb") {
        const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
        const out = await new GLTFExporter().parseAsync(target, { binary: true });
        return new Blob([out as ArrayBuffer], { type: "model/gltf-binary" });
      }
      if (format === "obj") {
        const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
        return new Blob([new OBJExporter().parse(target)], { type: "text/plain" });
      }
      if (format === "stl") {
        const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
        const out = new STLExporter().parse(target, { binary: true }) as unknown as DataView;
        return new Blob([out.buffer as ArrayBuffer], { type: "model/stl" });
      }
      if (format === "ply") {
        const { PLYExporter } = await import("three/examples/jsm/exporters/PLYExporter.js");
        const out = await new Promise<ArrayBuffer>((ok) =>
          new PLYExporter().parse(target, (r) => ok(r as ArrayBuffer), { binary: true }),
        );
        return new Blob([out], { type: "application/octet-stream" });
      }
      const { USDZExporter } = await import("three/examples/jsm/exporters/USDZExporter.js");
      const out = await new USDZExporter().parseAsync(target);
      return new Blob([out as Uint8Array<ArrayBuffer>], { type: "model/vnd.usdz+zip" });
    },
    stats() {
      let triangles = 0;
      content?.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g || !(o as THREE.Mesh).isMesh) return;
        triangles += Math.floor(
          (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3,
        );
      });
      return { triangles, nodes: byNode.size };
    },
    dispose() {
      disposed = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      cancelAnimationFrame(frameId);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      gizmo.detach();
      gizmo.dispose();
      orbit.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
