// The 3D editor's page side (G37.7), without WebGL: the person's gestures turned into the host's
// actions (each accepted and undone to the very bytes by the server's family), the scene's tree,
// angles as three.js reads them, the queue meeting others' revisions, a GLB's binary chunk, and the
// panel's words in both languages.
import {
  checkModelAction,
  type DocSummary,
  type ModelAction,
  type ModelPlainAction,
} from "@redgiant/protocol";
import { Euler, Quaternion } from "three";
import { describe, expect, it } from "vitest";
import { jsModelToGlb } from "../../server/src/editor/model/convert.js";
import { packGlb, readGltf } from "../../server/src/editor/model/gltf.js";
import { applyAction, invertAction, type ModelModel } from "../../server/src/editor/model/ops.js";
import { modelFamily } from "../../server/src/editor/model-family.js";
import { lang } from "../src/i18n.js";
import { binOfGlb } from "../src/viewers/model-island.js";
import {
  addCameraActions,
  addGroupActions,
  addLightActions,
  addShapeActions,
  applyAll,
  deleteActions,
  duplicateActions,
  ensureMaterial,
  eulerDegToQuat,
  freeName,
  lightActions,
  lightOfNode,
  ModelCollab,
  type ModelOutgoing,
  materialActions,
  materialView,
  modelChangeText,
  parentChoices,
  quatToEulerDeg,
  renameActions,
  reparentActions,
  sceneTree,
  transformActions,
} from "../src/viewers/model-ops.js";

const SCENE = `{
  "asset": { "version": "2.0", "generator": "test" },
  "extensionsUsed": ["VENDOR_x"],
  "scene": 0,
  "scenes": [ { "nodes": [ 0, 2 ] } ],
  "nodes": [
    { "name": "Tavolo", "mesh": 0, "children": [ 1 ], "extras": { "k": 1.0 } },
    { "name": "Gamba", "matrix": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-1,0,1] },
    { "extensions": { "VENDOR_x": { "a": 1 } } }
  ],
  "meshes": [ { "primitives": [ { "attributes": { "POSITION": 0 } } ] } ],
  "accessors": [ { "componentType": 5126, "count": 3, "type": "VEC3", "min": [0,0,0], "max": [1,1,0] } ]
}`;
const model = (): ModelModel => modelFamily.load(new TextEncoder().encode(SCENE)).model;
const text = (m: ModelModel) => new TextDecoder().decode(modelFamily.save(m));
/** The page's actions as the host takes them: accepted, and undone to the very bytes. */
function host(m: ModelModel, acts: ModelPlainAction[]): ModelModel {
  const a: ModelAction = { t: "batch", ops: acts };
  expect(checkModelAction(m.file.json.root, a)).toBeUndefined();
  const inv = invertAction(m, a);
  const after = applyAction(m, a);
  expect(text(applyAction(after, JSON.parse(JSON.stringify(inv))))).toBe(text(m));
  // The page's own copy of the JSON follows the same way.
  expect(applyAll(m.file.json.root, [a])).toEqual(after.file.json.root);
  return after;
}
const GEO = { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], index: [0, 1, 2] };

describe("the scene's tree", () => {
  it("lists the scene's nodes with depth and kind; folded nodes hide their children", () => {
    const root = model().file.json.root;
    expect(sceneTree(root).map((r) => [r.index, r.depth, r.name, r.kind, r.named])).toEqual([
      [0, 0, "Tavolo", "mesh", true],
      [1, 1, "Gamba", "group", true],
      [2, 0, "n2", "group", false],
    ]);
    expect(sceneTree(root, new Set([0])).map((r) => r.index)).toEqual([0, 2]);
    expect(parentChoices(root, 0).map((r) => r.index)).toEqual([2]);
    expect(freeName(root, "Tavolo")).toBe("Tavolo 2");
  });
});

describe("the person's gestures", () => {
  it("each one is taken by the host and undone exactly", () => {
    const m = model();
    const root = m.file.json.root;
    host(
      m,
      transformActions(root, 0, {
        translation: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      }),
    );
    host(
      m,
      transformActions(root, 1, {
        translation: [0, -1, 0],
        rotation: [0, 0, 0, 1],
        scale: [2, 2, 2],
      }),
    );
    host(m, renameActions(2, "Perno"));
    host(m, renameActions(0, ""));
    host(m, deleteActions(root, 1));
    host(m, reparentActions(root, 2, 0));
    host(m, duplicateActions(root, 0, "Tavolo 2").acts);
    host(m, addShapeActions(root, GEO, "Cubo", [0, 0, 0]).acts);
    host(
      m,
      addLightActions(root, "spot", "Faretto", [0, 3, 0], [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]).acts,
    );
    host(m, addCameraActions(root, "Vista", [3, 2, 3], [0, 0, 0, 1], 0.8).acts);
    host(m, addGroupActions(root, "Arredi", [1, 0, 0]).acts);
    const made = ensureMaterial(root, 0);
    expect(made?.acts.length).toBe(2);
    const withMat = applyAll(root, [{ t: "batch", ops: made?.acts ?? [] }]);
    host(m, [
      ...(made?.acts ?? []),
      ...materialActions(withMat, made?.index ?? 0, { color: "#ff0000" }),
      ...materialActions(withMat, made?.index ?? 0, { opacity: 0.5 }),
      ...materialActions(withMat, made?.index ?? 0, {
        texture: { mime: "image/png", data: "iVBORw0KGgo=" },
      }),
    ]);
  });

  it("a node with a matrix gets translation, rotation and scale; unchanged values are not written", () => {
    const root = model().file.json.root;
    const same = transformActions(root, 0, {
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(same).toEqual([]);
    const m = transformActions(root, 1, {
      translation: [0, -1, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(m.map((a) => (a.t === "set" ? a.path.join("/") : a.t))).toEqual([
      "nodes/1/matrix",
      "nodes/1/translation",
      "nodes/1/rotation",
      "nodes/1/scale",
    ]);
  });

  it("materials and lights read back as the panel shows them", () => {
    let m = model();
    const made = ensureMaterial(m.file.json.root, 0);
    m = host(m, made?.acts ?? []);
    m = host(m, materialActions(m.file.json.root, 0, { color: "#3366cc" }));
    m = host(m, materialActions(m.file.json.root, 0, { roughness: 0.25 }));
    expect(materialView(m.file.json.root, 0)).toMatchObject({
      color: "#3366cc",
      roughness: 0.25,
      opacity: 1,
    });
    const l = addLightActions(m.file.json.root, "point", "Lampada", [0, 2, 0]);
    m = host(m, l.acts);
    const view = lightOfNode(m.file.json.root, l.node);
    expect(view).toMatchObject({ type: "point", intensity: 20, color: "#ffffff" });
    m = host(m, lightActions(view?.index ?? 0, { color: "#ffcc88" }));
    expect(lightOfNode(m.file.json.root, l.node)?.color).toBe("#ffcc88");
  });
});

describe("angles", () => {
  it("degrees and quaternions as three.js reads them", () => {
    for (const e of [
      [0, 0, 0],
      [30, 45, 60],
      [-90, 10, 170],
      [0, 90, 0],
    ]) {
      const q = eulerDegToQuat(e);
      const three = new Quaternion().setFromEuler(
        new Euler(...(e.map((d) => (d * Math.PI) / 180) as [number, number, number]), "XYZ"),
      );
      expect(q.map((x) => Math.round(x * 1e6))).toEqual(
        three.toArray().map((x) => Math.round(x * 1e6)),
      );
      const back = quatToEulerDeg(q);
      const again = eulerDegToQuat(back);
      // The same rotation (q and -q are one).
      const dot = Math.abs(q.reduce((s, x, i) => s + x * (again[i] as number), 0));
      expect(dot).toBeCloseTo(1, 6);
    }
    expect(quatToEulerDeg([0, Math.SQRT1_2, 0, Math.SQRT1_2])).toEqual([0, 90, 0]);
  });
});

describe("the queue", () => {
  it("merges a dragged value, meets others' revisions, reloads when they touch the same object", () => {
    const sent: ModelOutgoing[] = [];
    const c = new ModelCollab((o) => sent.push(o));
    c.reset(4);
    c.local([
      { t: "set", path: ["materials", 0, "pbrMetallicRoughness", "roughnessFactor"], value: 0.1 },
    ]);
    c.local([
      { t: "set", path: ["materials", 0, "pbrMetallicRoughness", "roughnessFactor"], value: 0.3 },
    ]);
    c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actions[0]).toMatchObject({ value: 0.3 });
    expect(c.remote(5, [{ t: "set", path: ["nodes", 3, "name"], value: "x" }])).toBe("apply");
    expect(c.remote(6, [{ t: "set", path: ["materials", 0, "name"], value: "y" }])).toBe("reload");
    expect(c.remote(9, [{ t: "set", path: ["nodes", 3, "name"], value: "x" }])).toBe("reload");
    expect(c.ack(sent[0]?.clientId ?? "", 7)).toBe(true);
    expect(c.revision).toBe(7);
  });
});

describe("a GLB's binary chunk", () => {
  it("is found in the file's bytes", () => {
    const bin = new Uint8Array([9, 8, 7, 6]);
    expect(Array.from(binOfGlb(packGlb('{"asset":{"version":"2.0"}}', bin)) ?? [])).toEqual([
      9, 8, 7, 6,
    ]);
    const glb = jsModelToGlb(
      new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
      "t.obj",
    );
    expect(binOfGlb(glb)?.length).toBe(readGltf(glb).bin?.length);
    expect(binOfGlb(new TextEncoder().encode("{}"))).toBeUndefined();
  });
});

describe("words", () => {
  it("says what changed, in Italian and English", () => {
    const s = (model: DocSummary["model"]): DocSummary => ({ text: "x", kind: "edit", model });
    lang.value = "it";
    expect(modelChangeText(s({ action: "add", n: 1, kind: "mesh", name: "Tavolo" }))).toBe(
      "Aggiunto: oggetto «Tavolo»",
    );
    expect(modelChangeText(s({ action: "delete", n: 3 }))).toBe("Eliminati 3 oggetti");
    expect(modelChangeText(s({ action: "material", n: 1, kind: "material", name: "Legno" }))).toBe(
      "Cambiato il materiale «Legno»",
    );
    lang.value = "en";
    expect(modelChangeText(s({ action: "transform", n: 1, kind: "light", name: "Sole" }))).toBe(
      "Moved: light «Sole»",
    );
    expect(modelChangeText(s({ action: "light", n: 1 }))).toBe("Changed a light");
    lang.value = "it";
  });
});
