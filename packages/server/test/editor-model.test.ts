// The 3D family (G37.7): the file's own glTF JSON read and written back byte for byte (a .gltf's
// text, a .glb's chunks), the agent's plain operations as actions on it (each undone exactly),
// unknown extensions and extras kept through edits, indices that never shift, conflicts on the
// same object, outside links refused, the GLB copy of OBJ/STL/PLY made with three.js, and the
// family in the editor's host (PGlite) and from end to end with a scripted model (FakeProvider).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import {
  applyModelAction,
  checkModelAction,
  DEFAULT_EDITOR_SETTINGS,
  type DocFile,
  type DocOp,
  type ModelAction,
  modelAddMesh,
  modelTouched,
  PERSON,
  type ServerMessage,
} from "@redgiant/protocol";
import { Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorHost } from "../src/editor/host.js";
import { modelFromAgent, prepareModelOps } from "../src/editor/model/agent.js";
import { jsModelToGlb } from "../src/editor/model/convert.js";
import { packGlb, readGltf, readJson, writeGltf, writeJson } from "../src/editor/model/gltf.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  describe as describeOps,
  invertAction,
  type ModelModel,
  mapAction,
} from "../src/editor/model/ops.js";
import { modelStructure, worldMatrices } from "../src/editor/model/structure.js";
import {
  modelCopyOfOriginal,
  modelFamily,
  originalOfModelCopy,
} from "../src/editor/model-family.js";
import { blenderBridgeArgs, blendOf } from "../src/editor/model-routes.js";
import { startServer, wsClient } from "./helpers.js";
import { memoryDb } from "./pglite.js";

/** A small glTF written by hand, with what other programs put in: extensions, extras, spellings. */
const SCENE = `{
    "asset" : {
        "generator" : "Khronos glTF Blender I/O v4.2.70",
        "version" : "2.0"
    },
    "extensionsUsed" : [ "KHR_materials_clearcoat", "VENDOR_unknown" ],
    "extras" : { "studio": { "take": 3, "note": "ciao \\u00e8" } },
    "scene" : 0,
    "scenes" : [
        {
            "name" : "Scene",
            "nodes" : [ 0, 2 ]
        }
    ],
    "nodes" : [
        {
            "mesh" : 0,
            "name" : "Cube",
            "translation" : [ 1.0, 0.0, -2.50 ],
            "children" : [ 1 ],
            "extras" : { "rig": true }
        },
        {
            "name" : "Child",
            "matrix" : [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1 ]
        },
        {
            "name" : "Empty",
            "extensions" : { "VENDOR_unknown" : { "a" : [1e-7, 2E+3] } }
        }
    ],
    "meshes" : [
        {
            "name" : "CubeMesh",
            "primitives" : [ { "attributes" : { "POSITION" : 0 }, "material" : 0 } ]
        }
    ],
    "materials" : [
        {
            "name" : "Red",
            "pbrMetallicRoughness" : { "baseColorFactor" : [ 0.8, 0.0, 0.0, 1.0 ], "metallicFactor" : 0.0 },
            "extensions" : { "KHR_materials_clearcoat" : { "clearcoatFactor" : 1.0 } }
        }
    ],
    "accessors" : [
        { "bufferView" : 0, "componentType" : 5126, "count" : 3, "type" : "VEC3", "min" : [ -1, -1, 0 ], "max" : [ 1, 1, 0 ] }
    ],
    "bufferViews" : [ { "buffer" : 0, "byteLength" : 36 } ],
    "buffers" : [ { "byteLength" : 36, "uri" : "data:application/octet-stream;base64,AACAvwAAgL8AAAAAAACAPwAAgL8AAAAAAAAAAAAAgD8AAAAA" } ]
}
`;

const load = (text = SCENE): ModelModel => modelFamily.load(new TextEncoder().encode(text)).model;
const text = (m: ModelModel) => new TextDecoder().decode(modelFamily.save(m));
function agent(m: ModelModel, ops: unknown[]): ModelAction {
  const r = modelFromAgent(m.file.json.root, ops);
  if ("error" in r) throw new Error(`${r.index}: ${r.error}`);
  return { t: "batch", ops: r.actions };
}
/** Applies, inverts (through JSON, as the log keeps it), and checks the very same bytes come back. */
function roundTrip(m: ModelModel, a: ModelAction): ModelModel {
  expect(checkAction(m, a)).toBeUndefined();
  const inv = invertAction(m, a);
  const after = applyAction(m, a);
  const back = applyAction(after, JSON.parse(JSON.stringify(inv)));
  expect(text(back)).toBe(text(m));
  return after;
}

describe("the file's own glTF", () => {
  it.each([
    [SCENE],
    ['{"asset":{"version":"2.0"},"nodes":[{"name":"a"}],"x":1.50}'],
    ['﻿{ "asset" : {"version":"2.0"} ,"a":[ ],"b":{ } }\r\n'],
    ['{\n\t"asset": {\n\t\t"version": "2.0"\n\t},\n\t"n": [1,2,  3]\n}'],
  ])("reads and writes %# byte for byte", (t) => {
    const j = readJson(t);
    expect(writeJson(j)).toBe(t);
  });

  it("a change touches only what it names; the rest keeps its spelling", () => {
    const m = load();
    const after = roundTrip(m, { t: "set", path: ["nodes", 2, "name"], value: "Vuoto" });
    const before = SCENE.split("\n");
    const now = text(after).split("\n");
    expect(now.length).toBe(before.length);
    const diff = now.filter((l, i) => l !== before[i]);
    expect(diff).toEqual(['            "name" : "Vuoto",']);
    expect(text(after)).toContain('"translation" : [ 1.0, 0.0, -2.50 ]');
    expect(text(after)).toContain('"a" : [1e-7, 2E+3]');
  });

  it("a GLB: the same bytes when nothing changed; the binary chunk kept when the JSON changes", () => {
    const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const json = '{"asset":{"version":"2.0"},"buffers":[{"byteLength":9}],"nodes":[{"name":"a"}]}';
    const glb = packGlb(json, bin);
    const f = readGltf(glb);
    expect(f.container).toBe("glb");
    expect(writeGltf(f)).toBe(glb);
    const m: ModelModel = { file: f };
    const after = applyAction(m, { t: "set", path: ["nodes", 0, "name"], value: "bb" });
    const out = writeGltf(after.file);
    expect(out.length % 4).toBe(0);
    const again = readGltf(out);
    expect(Buffer.from(again.bin?.subarray(0, 9) ?? [])).toEqual(Buffer.from(bin));
    expect(writeJson(again.json)).toBe(json.replace('"a"', '"bb"'));
    // Reading back and saving does not grow the padding.
    expect(writeGltf({ ...again, json: readJson(writeJson(again.json)) }).length).toBe(out.length);
  });

  it("refuses what is not glTF 2.0", () => {
    expect(() => load('{"asset":{"version":"1.0"}}')).toThrow(/glTF 2.0/);
    expect(() => load("[1]")).toThrow(/glTF object/);
    expect(() => load("{nope")).toThrow(/not readable/);
  });
});

describe("actions", () => {
  it("collections only grow and shrink at their end; outside links are refused", () => {
    const root = load().file.json.root;
    expect(checkModelAction(root, { t: "ins", path: ["nodes"], at: 0, value: {} })).toMatch(/end/);
    expect(checkModelAction(root, { t: "del", path: ["nodes"], at: 0 })).toMatch(/last/);
    expect(checkModelAction(root, { t: "set", path: ["nodes"], value: [] })).toMatch(/whole/);
    expect(
      checkModelAction(root, {
        t: "ins",
        path: ["buffers"],
        at: 1,
        value: { uri: "https://x.y/a.bin" },
      }),
    ).toMatch(/uri/);
    expect(
      checkModelAction(root, { t: "set", path: ["buffers", 0, "uri"], value: "../../etc/passwd" }),
    ).toMatch(/uri/);
    expect(
      checkModelAction(root, { t: "set", path: ["buffers", 0, "uri"], value: "parts/a.bin" }),
    ).toBeUndefined();
  });

  it("an undo puts a removed member back in its place", () => {
    const m = load();
    roundTrip(m, { t: "set", path: ["nodes", 0, "mesh"] });
    roundTrip(m, { t: "set", path: ["materials", 0, "extensions"] });
  });

  it("conflicts: the same object, or the same list growing; elsewhere they pass", () => {
    const a: ModelAction = { t: "set", path: ["nodes", 0, "translation"], value: [0, 0, 0] };
    const b: ModelAction = { t: "set", path: ["nodes", 0, "name"], value: "x" };
    const c: ModelAction = { t: "set", path: ["nodes", 2, "name"], value: "y" };
    expect(actionsConflict(a, b)).toBe(true);
    expect(actionsConflict(a, c)).toBe(false);
    expect([...modelTouched([{ t: "ins", path: ["nodes"], at: 3, value: {} }])]).toEqual([
      "nodes/+",
    ]);
    expect(
      actionsConflict(
        { t: "ins", path: ["nodes"], at: 3, value: {} },
        { t: "ins", path: ["nodes"], at: 3, value: {} },
      ),
    ).toBe(true);
    expect(actionsConflict({ t: "doc", json: "{}" }, c)).toBe(true);
  });

  it("an undo of an addition passes over later additions: the object leaves the scene", () => {
    const m = load();
    const sphere = agent(m, [{ op: "add_primitive", shape: "sphere", name: "Sfera" }]);
    const inv = invertAction(m, sphere);
    const m1 = applyAction(m, sphere);
    const vase = agent(m1, [{ op: "add_primitive", shape: "cylinder", name: "Vaso" }]);
    const m2 = applyAction(m1, vase);
    expect(actionsConflict(inv, vase)).toBe(false);
    const moved = mapAction(inv, vase) as ModelAction;
    expect(checkAction(m2, moved)).toBeUndefined();
    const m3 = applyAction(m2, moved);
    const s = modelStructure(m3.file.json.root, "gltf", {});
    expect(s).not.toMatch(/mesh "Sfera"/);
    expect(s).toMatch(/mesh "Vaso"/);
    expect(s).toContain("Detached nodes (deleted, still in the file, out of every scene): n3");
    // Two additions made on the same revision still meet (their indices would collide).
    expect(actionsConflict(sphere, agent(m, [{ op: "add_group" }]))).toBe(true);
    // A deletion moves past an object added before it in the same list.
    const del = agent(m, [{ op: "delete", ids: ["n2"] }]);
    const front: ModelAction = { t: "ins", path: ["scenes", 0, "nodes"], at: 0, value: 1 };
    expect(mapAction(del, front)).toEqual({ t: "del", path: ["scenes", 0, "nodes"], at: 2 });
  });

  it("a mesh from plain arrays: its own data: buffer, POSITION with min and max", () => {
    const root = load().file.json.root;
    const r = modelAddMesh(
      root,
      { position: [0, 0, 0, 1, 0, 0, 0, 2, 0], index: [0, 1, 2] },
      { node: { name: "T" }, material: { color: [1, 0, 0, 1] } },
    );
    const after = applyModelAction(root, { t: "batch", ops: r.acts }) as Record<string, unknown[]>;
    expect(r.node).toBe(3);
    expect(after.accessors?.[1]).toMatchObject({ min: [0, 0, 0], max: [1, 2, 0], count: 3 });
    expect(String((after.buffers?.[1] as { uri: string } | undefined)?.uri)).toMatch(
      /^data:application\/octet-stream;base64,/,
    );
    expect((after.scenes?.[0] as { nodes: number[] } | undefined)?.nodes).toEqual([0, 2, 3]);
  });
});

describe("the agent's operations", () => {
  it("each one is undone to the very bytes", () => {
    const m = load();
    for (const ops of [
      [
        {
          op: "add_primitive",
          shape: "box",
          name: "Tavolo",
          width: 2,
          height: 0.1,
          depth: 1,
          position: [0, 0.75, 0],
          color: "#8b5a2b",
        },
      ],
      [
        {
          op: "add_primitive",
          shape: "sphere",
          radius: 0.3,
          segments: 12,
          parent: "n0",
          material: "m0",
        },
      ],
      [
        {
          op: "add_light",
          kind: "spot",
          name: "Lampada",
          position: [0, 3, 0],
          look_at: [0, 0, 0],
          outer_cone: 30,
        },
      ],
      [{ op: "add_camera", name: "Vista", position: [4, 3, 4], look_at: [0, 0, 0] }],
      [{ op: "add_group", name: "Arredi" }],
      [
        {
          op: "add_mesh",
          positions: [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
          ],
          triangles: [[0, 1, 2]],
        },
      ],
      [{ op: "set_transform", id: "n0", rotation: [0, 90, 0], scale: 2 }],
      [{ op: "set_transform", id: "n1", by: [1, 0, 0] }],
      [{ op: "set_material", id: "n0", color: "#00ff00", roughness: 0.2, opacity: 0.5 }],
      [{ op: "set_material", id: "m0", metalness: 1, double_sided: true }],
      [{ op: "rename", id: "n2", name: "Perno" }],
      [{ op: "rename", id: "m0", name: "Rosso" }],
      [{ op: "delete", ids: ["n2"] }],
      [{ op: "delete", ids: ["n1"] }],
      [{ op: "reparent", id: "n2", parent: "n0" }],
      [{ op: "duplicate", id: "n0", by: [3, 0, 0] }],
    ])
      roundTrip(m, agent(m, ops));
  });

  it("a whole scene built by an agent, as the structure tells it", () => {
    let m = load();
    m = applyAction(
      m,
      agent(m, [
        { op: "add_group", name: "Arredi" },
        {
          op: "add_primitive",
          shape: "box",
          name: "Tavolo",
          width: 2,
          height: 0.1,
          depth: 1,
          position: [0, 0.75, 0],
          color: "#8b5a2b",
          parent: "n3",
        },
        { op: "add_light", kind: "point", name: "Lampada", position: [0, 3, 0], intensity: 15 },
        { op: "set_material", id: "n4", roughness: 0.9 },
        { op: "delete", ids: ["n2"] },
      ]),
    );
    const s = modelStructure(m.file.json.root, "gltf", {});
    expect(s).toContain('n3 group "Arredi"');
    expect(s).toContain(
      '  n4 mesh "Tavolo", pos (0, 0.75, 0), box (-1, 0.7, -0.5)..(1, 0.8, 0.5) size (2, 0.1, 1)',
    );
    expect(s).toMatch(/n5 light point "Lampada", pos \(0, 3, 0\)/);
    expect(s).toMatch(/m1 "Tavolo", color #8b5a2b, metalness 0, roughness 0\.9/);
    expect(s).toContain("Detached nodes (deleted, still in the file, out of every scene): n2");
    expect(s).toContain("Extensions kept as they are: KHR_materials_clearcoat, VENDOR_unknown");
    // The file still has everything it had.
    const out = text(m);
    expect(out).toContain('"VENDOR_unknown" : { "a" : [1e-7, 2E+3] }');
    expect(out).toContain('"extras" : { "studio": { "take": 3, "note": "ciao \\u00e8" } }');
    expect(out).toContain('"KHR_lights_punctual"');
  });

  it("reparent keeps the object where it is in the scene; a matrix becomes TRS when moved", () => {
    let m = load();
    const where = (mm: ModelModel, i: number) =>
      new Vector3()
        .setFromMatrixPosition(worldMatrices(mm.file.json.root).get(i) as never)
        .toArray()
        .map((x) => Math.round(x * 1000) / 1000);
    expect(where(m, 1)).toEqual([1, 2, -2.5]);
    m = applyAction(m, agent(m, [{ op: "reparent", id: "n1", parent: "scene" }]));
    expect(where(m, 1)).toEqual([1, 2, -2.5]);
    expect(text(m)).not.toContain('"matrix"');
    m = applyAction(m, agent(m, [{ op: "set_transform", id: "n1", by: [0, 1, 0] }]));
    expect(where(m, 1)).toEqual([1, 3, -2.5]);
  });

  it("words for the panel", () => {
    const m = load();
    const d = (ops: unknown[]) => describeOps(m, [agent(m, ops)]);
    expect(d([{ op: "add_primitive", shape: "box", name: "Cubo" }])).toMatchObject({
      text: 'Added mesh "Cubo"',
      change: { action: "add", kind: "mesh", n: 1, name: "Cubo", id: "n3" },
    });
    expect(d([{ op: "delete", ids: ["n0", "n2"] }]).change).toMatchObject({
      action: "delete",
      n: 2,
    });
    expect(d([{ op: "set_transform", id: "n0", position: [0, 0, 0] }]).change).toMatchObject({
      action: "transform",
      name: "Cube",
    });
    expect(d([{ op: "set_material", id: "n0", color: "#ffffff" }]).change).toMatchObject({
      action: "material",
      name: "Red",
      id: "m0",
    });
    expect(d([{ op: "duplicate", id: "n0" }]).change).toMatchObject({
      action: "duplicate",
      name: "Cube 2",
    });
    expect(d([{ op: "reparent", id: "n2", parent: "n0" }]).change).toMatchObject({
      action: "reparent",
    });
    expect(d([{ op: "add_light", kind: "point" }]).change).toMatchObject({
      action: "add",
      kind: "light",
    });
  });

  it("says what is wrong, with the operation's index", () => {
    const root = load().file.json.root;
    expect(
      modelFromAgent(root, [
        { op: "add_group" },
        { op: "set_transform", id: "n9", position: [0, 0, 0] },
      ]),
    ).toEqual({ error: "there is no node n9", index: 1 });
    expect(modelFromAgent(root, [{ op: "nope" }])).toMatchObject({
      error: expect.stringMatching(/no operation "nope"/),
      index: 0,
    });
    expect(modelFromAgent(root, [{ op: "add_primitive", shape: "teapot" }])).toMatchObject({
      error: expect.stringMatching(/no shape/),
    });
    expect(modelFromAgent(root, [{ op: "set_material", id: "n2", color: "#fff" }])).toMatchObject({
      error: "n2 is not a mesh (it has no material)",
    });
    expect(modelFromAgent(root, [{ op: "reparent", id: "n0", parent: "n1" }])).toMatchObject({
      error: expect.stringMatching(/under itself/),
    });
    expect(
      modelFromAgent(root, [
        { op: "delete", ids: ["n1"] },
        { op: "delete", ids: ["n1"] },
      ]),
    ).toMatchObject({ error: expect.stringMatching(/not in the scene/), index: 1 });
  });

  it("a texture from the workspace goes inside the file", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const ops = await prepareModelOps(
      [{ op: "set_material", id: "n0", texture: "legno.png" }],
      async (p) => {
        expect(p).toBe("legno.png");
        return png;
      },
    );
    const m = load();
    const after = roundTrip(m, agent(m, ops));
    const t = text(after);
    expect(t).toContain('"uri": "data:image/png;base64,iVBORw0KGgoAAAAA"');
    expect(t).toMatch(/"baseColorTexture"\s*:\s*\{\s*"index"\s*:\s*0\s*\}/);
    await expect(
      prepareModelOps(
        [{ op: "set_material", id: "n0", texture: "x.txt" }],
        async () => new Uint8Array([1, 2, 3]),
      ),
    ).rejects.toThrow(/not a PNG/);
  });
});

describe("copies and Blender", () => {
  it("names the GLB copy beside the original, and back", () => {
    expect(modelCopyOfOriginal("a/sedia.fbx")).toBe("a/sedia.fbx.open/sedia.glb");
    expect(originalOfModelCopy("a/sedia.fbx.open/sedia.glb")).toBe("a/sedia.fbx");
    expect(originalOfModelCopy("a/sedia.glb")).toBeUndefined();
    expect(modelCopyOfOriginal("a/sedia.glb")).toBeUndefined();
    expect(blendOf("/w/a.glb")).toBe(join("/w/a.glb.open", "a.blend"));
    expect(blenderBridgeArgs("s.py", "/w/a.glb", "/w/a.blend")).toEqual([
      "--python",
      "s.py",
      "--",
      "/w/a.glb",
      "/w/a.blend",
    ]);
  });

  it("OBJ, STL and PLY become a GLB the family opens", () => {
    const obj =
      "o Tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\no Quad\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 4 5 6 7\n";
    const stl =
      "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    const ply =
      "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n";
    for (const [name, src, tri] of [
      ["m.obj", obj, 3],
      ["m.stl", stl, 1],
      ["m.ply", ply, 1],
    ] as const) {
      const glb = jsModelToGlb(new TextEncoder().encode(src), name);
      const m = modelFamily.load(glb).model;
      expect(m.file.container).toBe("glb");
      const s = modelStructure(m.file.json.root, "glb", {});
      expect(
        s
          .match(/(\d+) triangles/g)
          ?.map((x) => Number.parseInt(x, 10))
          .reduce((a, b) => a + b, 0),
      ).toBe(tri);
    }
    expect(() => jsModelToGlb(new TextEncoder().encode("solid\nendsolid\n"), "e.stl")).toThrow();
  });
});

// ---- in the host ----------------------------------------------------------------------------

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };
const BOB = { id: "bob", name: "Bob", sessionId: "s-bob" };

function host() {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_o, f) => join(dir, "ws", f.path),
    settings: () => DEFAULT_EDITOR_SETTINGS,
    families: [modelFamily],
    saveDelayMs: 60_000,
    watchMs: 0,
  });
  hosts.push(h);
  return h;
}
const opsOf = (m: ModelModel, list: unknown[]): DocOp[] => {
  const r = modelFamily.fromAgent(m, list);
  if ("error" in r) throw new Error(r.error);
  return r.ops;
};

describe("a model in the editor's host", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rg-model-"));
    await mkdir(join(dir, "ws"), { recursive: true });
    const { db } = await memoryDb();
    await migrate(db);
    store = new EventStore(db);
  });
  afterEach(async () => {
    for (const h of hosts) await h.close();
    hosts = [];
    await rm(dir, { recursive: true, force: true });
  });

  it("agents and the person: applied, refused on the same object, rebased elsewhere, undone, saved, rebuilt", async () => {
    const file: DocFile = { scope: "platform", path: "scena.gltf" };
    await writeFile(join(dir, "ws", "scena.gltf"), SCENE);
    const h = host();
    const read = await h.read("me", file);
    const m0 = read.model as ModelModel;
    expect(modelFamily.snapshot(m0)).toMatchObject({
      family: "model",
      container: "gltf",
      json: SCENE,
    });
    const r1 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: opsOf(m0, [{ op: "set_material", id: "n0", color: "#0000ff" }]),
      groupId: "turn:1",
    });
    expect(r1).toMatchObject({
      ok: true,
      revision: 1,
      summary: { model: { action: "material", id: "m0" } },
    });
    // Bob, on revision 0, on the same material: refused.
    const r2 = await h.apply("me", file, {
      author: BOB,
      baseRevision: 0,
      ops: opsOf(m0, [{ op: "set_material", id: "m0", roughness: 0.1 }]),
      groupId: "turn:2",
    });
    expect(r2).toMatchObject({ ok: false, code: "conflict" });
    // Bob on another object: moved over Ada's.
    const r3 = await h.apply("me", file, {
      author: BOB,
      baseRevision: 0,
      ops: opsOf(m0, [{ op: "rename", id: "n2", name: "Perno" }]),
      groupId: "turn:2",
    });
    expect(r3).toMatchObject({
      ok: true,
      revision: 2,
      rebased: true,
      summary: { model: { action: "rename" } },
    });
    // The person drags the cube, as the page sends it.
    const r4 = await h.apply("me", file, {
      author: { id: PERSON },
      baseRevision: 2,
      ops: [
        {
          family: "model",
          engine: "gltf-json",
          engineVersion: "1",
          op: { t: "set", path: ["nodes", 0, "translation"], value: [0, 1, 0] },
        },
      ],
      groupId: "g1",
    });
    expect(r4).toMatchObject({ ok: true, revision: 3 });
    // «Annulla questa modifica» on Ada's, not the last.
    expect(await h.undo("me", file, { revision: 1 }, { id: PERSON })).toMatchObject({
      ok: true,
      revision: 4,
    });
    await h.flush();
    const disk = await readFile(join(dir, "ws", "scena.gltf"), "utf8");
    expect(disk).toContain('"baseColorFactor" : [ 0.8, 0.0, 0.0, 1.0 ]');
    expect(disk).toContain('"name" : "Perno"');
    expect(disk).toContain('"translation" : [0, 1, 0]');
    // Undo everything back: the very same bytes.
    await h.undo("me", file, { revision: 3 }, { id: PERSON });
    await h.undo("me", file, { revision: 2 }, { id: PERSON });
    await h.flush();
    expect(await readFile(join(dir, "ws", "scena.gltf"), "utf8")).toBe(SCENE);
    const h2 = host();
    expect((await h2.read("me", file)).revision).toBe(6);
  });

  it("a GLB edited and saved keeps its binary chunk; a change from outside can be undone", async () => {
    const file: DocFile = { scope: "platform", path: "t.glb" };
    const glb = jsModelToGlb(
      new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
      "t.obj",
    );
    await writeFile(join(dir, "ws", "t.glb"), glb);
    const h = host();
    const read = await h.read("me", file);
    const m0 = read.model as ModelModel;
    await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: opsOf(m0, [{ op: "add_primitive", shape: "cone", name: "Cono" }]),
      groupId: "turn:1",
    });
    await h.flush();
    const saved = readGltf(new Uint8Array(await readFile(join(dir, "ws", "t.glb"))));
    expect(Buffer.from(saved.bin as Uint8Array)).toEqual(
      Buffer.from(readGltf(glb).bin as Uint8Array),
    );
    expect(writeJson(saved.json)).toContain('"name":"Cono"');
    // From outside: the JSON changed (the same binary chunk), kept as its difference.
    const outside = packGlb(writeJson(saved.json).replace('"Cono"', '"Altro"'), saved.bin);
    await writeFile(join(dir, "ws", "t.glb"), outside);
    const again = await h.read("me", file);
    expect(again.revision).toBe(2);
    expect(await h.undo("me", file, { revision: 2 }, { id: PERSON })).toMatchObject({ ok: true });
    await h.flush();
    expect(
      writeJson(readGltf(new Uint8Array(await readFile(join(dir, "ws", "t.glb")))).json),
    ).toContain('"Cono"');
  });
});

// ---- from end to end ----------------------------------------------------------------------

type Req = { messages: { role: string; parts: { type: string; content?: string }[] }[] };
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

describe("a model from end to end (FakeProvider)", () => {
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("help, structure, an edit the page sees, the file written in place; an OBJ edited on its copy", async () => {
    const seen: string[] = [];
    const file = { scope: "platform", path: "3d/scena.gltf" };
    s = await startServer(
      calls(
        [
          { name: "canvas_edit", input: { path: file.path, help: true } },
          { name: "canvas_look", input: { path: file.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              ops: [
                {
                  op: "add_primitive",
                  shape: "box",
                  name: "Tavolo",
                  position: [0, 0.5, 0],
                  color: "#8b5a2b",
                },
                {
                  op: "add_light",
                  kind: "directional",
                  name: "Sole",
                  position: [3, 5, 2],
                  look_at: [0, 0, 0],
                },
              ],
            },
          },
          {
            name: "canvas_edit",
            input: { path: file.path, ops: [{ op: "delete", ids: ["n42"] }] },
          },
          {
            name: "canvas_edit",
            input: { path: "3d/pezzo.obj", ops: [{ op: "rename", id: "n0", name: "Pezzo" }] },
          },
        ],
        seen,
      ) as never,
      { contextWindow: 65_536 },
      { editor: { saveDelayMs: 0, watchMs: 0 } },
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sessionId = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), SCENE);
    await writeFile(join(root, "3d/pezzo.obj"), "o Pezzo\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    const page = await wsClient(s.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({
      family: "model",
      revision: 0,
      snapshot: { family: "model", container: "gltf", json: SCENE },
    });
    await (await s.core.send("me", sessionId, "Aggiungi un tavolo")).done;
    expect(seen[0]).toMatch(/^3D models \(glTF\/GLB/);
    expect(seen[0]).toContain('"op":"add_primitive"');
    expect(seen[1]).toContain('n0 mesh "Cube"');
    expect(seen[2]).toMatch(/^Applied as revision 1/);
    expect(seen[3]).toMatch(/Nothing applied: operation 1: there is no node n42/);
    expect(seen[4]).toMatch(/Applied as revision 1/);
    const changed = page.messages.filter(
      (m): m is Extract<ServerMessage, { type: "doc.changed" }> => m.type === "doc.changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change.summary.model).toMatchObject({ action: "add", n: 2 });
    await s.core.editor.flush();
    const disk = await readFile(join(root, file.path), "utf8");
    expect(disk).toContain('"name": "Tavolo"');
    expect(disk).toContain('"extras" : { "studio": { "take": 3, "note": "ciao \\u00e8" } }');
    const copy = readGltf(
      new Uint8Array(await readFile(join(root, "3d/pezzo.obj.open/pezzo.glb"))),
    );
    expect(writeJson(copy.json)).toContain('"name":"Pezzo"');
    const info = await s.api<{ blender: boolean; original?: string }>(
      "GET",
      `/api/editor/model/info?scope=platform&path=${encodeURIComponent("3d/pezzo.obj.open/pezzo.glb")}`,
    );
    expect(info.body).toMatchObject({ original: "pezzo.obj" });
    expect(typeof info.body.blender).toBe("boolean");
    page.close();
  }, 30_000);
});
