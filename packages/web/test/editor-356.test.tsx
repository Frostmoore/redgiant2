// @vitest-environment jsdom
// p3.5.6, undoing in the editors (the person's test of 3.5.5 on Windows): the person's Ctrl+Z by
// gesture, a redo that gives a change back, the agents' highlights kept while they edit and
// offered to undo, the text read again without losing them, a 3D change told in all its parts,
// and a model saved by Blender that loads (GLTFLoader's associations, a GLB not yet whole).
import type { DocChange, DocPresence, DocSummary } from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";
import { render } from "@testing-library/preact";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markedAt, minimalChange } from "../src/components/viewers/TextEditor.js";
import { setLang } from "../src/i18n.js";
import {
  agentEditingNow,
  applyMessage,
  emptyDocView,
  markChange,
  markedChanges,
  reduceDoc,
  unmarkChange,
} from "../src/state.js";
import { holdMark } from "../src/viewers/agent-marks.js";
import { glbComplete, indexAssociations } from "../src/viewers/model-island.js";
import { modelChangeText } from "../src/viewers/model-ops.js";
import { OwnUndo } from "../src/viewers/own-undo.js";
import { afterSeen, HIGHLIGHT_SEEN_MS, SEEN_TICK_MS } from "../src/viewers/seen.js";

afterEach(() => {
  vi.useRealTimers();
});

const change = (revision: number, over: Partial<DocChange> = {}): DocChange => ({
  revision,
  ts: new Date().toISOString(),
  author: "god",
  authorName: "God",
  groupId: "turn:t1",
  summary: { text: "changed line 2", kind: "replace", line: 2 },
  wrote: [[0, 2]],
  ...over,
});

describe("the person's Ctrl+Z in the drawing, picture and 3D editors", () => {
  it("takes back the latest gesture whole, then the one before; Ctrl+Shift+Z the undo", () => {
    const u = new OwnUndo();
    // A drag: three batches of one gesture; then a click: another gesture.
    u.made(3, "g-a");
    u.made(4, "g-a");
    u.made(5, "g-a");
    u.made(7, "g-b");
    expect(u.undo()).toEqual({ revision: 7 });
    u.changed({ revision: 8, undoOf: [7] });
    expect(u.undo()).toEqual({ groupId: "g-a" });
    u.changed({ revision: 9, undoOf: [3, 4, 5] });
    expect(u.undo()).toBeUndefined();
    expect(u.redo()).toEqual({ revision: 9 });
    u.changed({ revision: 10, undoOf: [9] });
    expect(u.redo()).toEqual({ revision: 8 });
    u.changed({ revision: 11, undoOf: [8] });
    // The redone ones are undone again, the latest first.
    expect(u.undo()).toEqual({ revision: 11 });
    // A new change of the person clears what could be redone.
    u.changed({ revision: 12, undoOf: [11] });
    u.made(13, "g-c");
    expect(u.redo()).toBeUndefined();
  });

  it("an agent's change is not the person's: Ctrl+Z leaves it, «Annulla questa modifica» takes it", () => {
    const u = new OwnUndo();
    u.made(2, "g-a");
    // God's revision 3 never enters the person's stack.
    u.changed({ revision: 3 });
    expect(u.undo()).toEqual({ revision: 2 });
  });
});

describe("the panel's view of an undo taken back (a redo)", () => {
  it("gives the change back: it can be undone again", () => {
    let v = { ...emptyDocView(), changes: [change(1), change(2, { undoOf: [1] })] };
    v.changes = [change(2, { undoOf: [1] }), change(1, { undoneBy: 2 })];
    v = reduceDoc(v, {
      type: "doc.changed",
      file: { scope: "platform", path: "a.txt" },
      revision: 3,
      ops: [],
      change: change(3, { author: PERSON, undoOf: [2], groupId: "undo:x" }),
    });
    const one = v.changes.find((c) => c.revision === 1);
    const two = v.changes.find((c) => c.revision === 2);
    expect(one?.undoneBy).toBeUndefined();
    expect(two?.undoneBy).toBe(3);
  });
});

describe("the agents' highlights", () => {
  const god: DocPresence = { who: "god", name: "God", editing: true };
  it("an agent counts as editing for its minute after the host said so", () => {
    const v = { presence: [god], presenceAt: 1000 };
    expect(agentEditingNow(v, 1000 + 59_000)).toBe(true);
    expect(agentEditingNow(v, 1000 + 61_000)).toBe(false);
    expect(
      agentEditingNow({ presence: [{ who: PERSON, editing: true }], presenceAt: 1000 }, 1500),
    ).toBe(false);
  });

  it("the time seen does not count while an agent edits (God sta modificando)", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    let busy = true;
    afterSeen(
      2000,
      done,
      () => true,
      () => busy,
    );
    vi.advanceTimersByTime(30_000);
    expect(done).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(2000 + SEEN_TICK_MS);
    expect(done).toHaveBeenCalledOnce();
  });

  it("a held highlight is told to the shell while it lasts, and goes with its undo", () => {
    vi.useFakeTimers();
    const file = { scope: "platform", path: "marks.txt" };
    const el = document.createElement("div");
    document.body.append(el);
    // jsdom lays nothing out: a rectangle says it is on screen.
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    const fade = vi.fn();
    const drop = holdMark(file, 4, () => el, fade);
    expect(markedChanges(file).value).toEqual([4]);
    vi.advanceTimersByTime(HIGHLIGHT_SEEN_MS + SEEN_TICK_MS);
    expect(fade).toHaveBeenCalledOnce();
    expect(markedChanges(file).value).toEqual([]);
    holdMark(file, 5, () => el, fade);
    const cut = holdMark(file, 6, () => el, fade);
    cut();
    expect(markedChanges(file).value).toEqual([5]);
    drop();
    unmarkChange(file);
    expect(markedChanges(file).value).toEqual([]);
  });

  it("the shell offers «Annulla questa modifica» on each highlighted change of the agent", async () => {
    setLang("it");
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const f = { scope: "platform", path: "evid.txt" };
    const { container, rerender } = render(<DocEditor file={f} />);
    applyMessage({
      type: "doc.opened",
      file: f,
      family: "text",
      revision: 3,
      snapshot: { family: "text", text: "a,b" },
      changes: [change(3), change(2, { author: PERSON }), change(1)],
      proposals: [],
      presence: [{ who: "god", name: "God", editing: true }],
      mode: "now",
      modeOwn: false,
    });
    markChange(f, 1);
    markChange(f, 3);
    rerender(<DocEditor file={f} />);
    const strip = container.querySelector(".doc-marks");
    expect(strip?.textContent).toContain("2 modifiche evidenziate, di God");
    expect(strip?.querySelectorAll(".doc-mark-undo")).toHaveLength(2);
    expect(strip?.querySelector(".doc-mark-undo")?.textContent).toBe("Annulla questa modifica");
    // «God sta modificando» and the highlights together.
    expect(container.querySelector(".doc-who.agent")?.textContent).toContain("God sta modificando");
    unmarkChange(f);
  });

  it("the text read again changes only what differs: the highlights stay", () => {
    expect(minimalChange("one\ntwo\nthree", "one\nTWO\nthree")).toEqual({
      from: 4,
      to: 7,
      insert: "TWO",
    });
    expect(minimalChange("abc", "abc")).toEqual({ from: 3, to: 3, insert: "" });
    expect(minimalChange("aaa", "aaaa")).toEqual({ from: 3, to: 3, insert: "a" });
  });

  it("the revision under the pointer is found in the marks", async () => {
    const { Decoration } = await import("@codemirror/view");
    const { RangeSet } = await import("@codemirror/state");
    const m = (id: number) => Decoration.mark({ attributes: { "data-mark": String(id) } });
    const set = RangeSet.of([m(3).range(0, 5), m(7).range(3, 9)]);
    expect(markedAt(set, 1)).toBe(3);
    expect(markedAt(set, 4)).toBe(7);
    expect(markedAt(set, 12)).toBeUndefined();
  });
});

describe("a 3D change in all its parts", () => {
  it("a move and a new colour together", () => {
    const s: DocSummary = {
      text: 'Moved mesh "Cubo" and changed material "Cubo"',
      kind: "edit",
      model: {
        action: "transform",
        n: 1,
        kind: "mesh",
        name: "Cubo",
        also: [{ action: "material", n: 1, kind: "material", name: "Cubo" }],
      },
    };
    setLang("it");
    expect(modelChangeText(s)).toBe("Spostato: oggetto «Cubo» e cambiato il materiale «Cubo»");
    setLang("en");
    expect(modelChangeText(s)).toBe("Moved: object «Cubo» and changed the material «Cubo»");
  });
});

/** A GLB from a glTF object and its binary chunk. */
function glb(json: object, bin: Uint8Array): Uint8Array {
  let j = new TextEncoder().encode(JSON.stringify(json));
  if (j.length % 4) {
    const p = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
    p.set(j);
    j = p;
  }
  const total = 20 + j.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

describe("a model saved by Blender loads (p3.5.6)", () => {
  // A triangle with vertex colours and no material: what Blender writes for a mesh with a colour
  // attribute; GLTFLoader's variant of its default material has no mapping.
  const bin = new Uint8Array(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer,
  );
  const tri = {
    asset: { version: "2.0", generator: "Khronos glTF Blender I/O" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Cubo" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: "VEC3" },
    ],
    bufferViews: [{ buffer: 0, byteLength: 72 }],
    buffers: [{ byteLength: 72 }],
  };

  it("an association without mapping is passed over: the node is still found", async () => {
    const bytes = glb(tri, bin);
    const g = await new GLTFLoader().parseAsync(bytes.slice().buffer, "");
    expect([...g.parser.associations.values()].some((v) => v === undefined)).toBe(true);
    const { byNode } = indexAssociations(g.parser.associations);
    expect(byNode.get(0)?.name).toBe("Cubo");
  });

  it("a glTF without nodes or scenes parses (nothing to show, no error)", async () => {
    const g = await new GLTFLoader().parseAsync(JSON.stringify({ asset: { version: "2.0" } }), "");
    expect(g.scene).toBeUndefined();
    expect(indexAssociations(g.parser.associations).byNode.size).toBe(0);
  });

  it("a GLB not yet whole waits", () => {
    const bytes = glb(tri, bin);
    expect(glbComplete(bytes)).toBe(true);
    expect(glbComplete(bytes.subarray(0, bytes.length - 10))).toBe(false);
    expect(glbComplete(bytes.subarray(0, 40))).toBe(false);
  });
});
