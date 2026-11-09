// @vitest-environment jsdom
// The editor's page side (G37.1): the person's text and the host's stay the same whatever the
// order of typing and of others' revisions (the client does what EditorHost does on the server);
// the panel's state as a table of the host's messages; the words of a change; the shell drawn.
import { ChangeSet, Text } from "@codemirror/state";
import type { DocChange, DocOp, TextDocOp } from "@redgiant/protocol";
import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { changeText, editableInCanvas, groupChanges } from "../src/components/viewers/DocEditor.js";
import { emptyDocView, reduceDoc } from "../src/state.js";
import { type Outgoing, TextCollab, textOp } from "../src/viewers/collab.js";

const file = { scope: "platform", path: "a.txt" };
const cs = (op: DocOp) => ChangeSet.fromJSON(op.family === "text" ? op.op.changes : []);

/** The host of the server in a few lines: rebase over the later revisions, `a.map(b, true)`. */
class MiniHost {
  doc: Text;
  revs: ChangeSet[] = [];
  constructor(text: string) {
    this.doc = Text.of(text.split("\n"));
  }
  get revision() {
    return this.revs.length;
  }
  apply(base: number, c: ChangeSet): { revision: number; applied: ChangeSet } {
    let one = c;
    for (const l of this.revs.slice(base)) one = one.map(l, true);
    this.doc = one.apply(this.doc);
    this.revs.push(one);
    return { revision: this.revs.length, applied: one };
  }
}

describe("TextCollab: the page and the host agree (G37.1)", () => {
  it("the person types while an agent's revisions arrive: same text at both ends", () => {
    const start = "alpha\nbeta\ngamma";
    const host = new MiniHost(start);
    const sent: Outgoing[] = [];
    const collab = new TextCollab((o) => sent.push(o));
    collab.reset(0);
    let view = Text.of(start.split("\n"));
    const type = (spec: { from: number; to?: number; insert?: string }) => {
      const c = ChangeSet.of(spec, view.length);
      view = c.apply(view);
      collab.local(c);
    };
    // The person types twice; the first batch leaves.
    type({ from: 5, insert: "!" });
    collab.flush();
    type({ from: 0, insert: "> " });
    // Meanwhile the agent's revision lands on the host first (made on revision 0).
    const agent = host.apply(0, ChangeSet.of({ from: 6, to: 10, insert: "BETA" }, start.length));
    const r = collab.remote(agent.revision, [textOp(agent.applied)], [[6, 10]]);
    expect(r).toBeDefined();
    view = (r as { changes: ChangeSet }).changes.apply(view);
    // The page's batch reaches the host: moved over the agent's revision there.
    const first = sent[0] as Outgoing;
    const ack1 = host.apply(first.baseRevision, cs(first.ops[0] as DocOp));
    expect(collab.ack(first.clientId, ack1.revision)).toBe(true);
    // The rest leaves after the ack, on revision 2.
    const second = sent[1] as Outgoing;
    expect(second.baseRevision).toBe(2);
    host.apply(second.baseRevision, cs(second.ops[0] as DocOp));
    expect(view.toString()).toBe(host.doc.toString());
    expect(view.toString()).toBe("> alpha!\nBETA\ngamma");
    // What the agent wrote, highlighted where it is in the person's text.
    const [[f, t]] = (r as { wrote: [number, number][] }).wrote as [[number, number]];
    expect(view.sliceString(f, t)).toBe("BETA");
  });

  it("a revision out of order, or an ack not its own, asks for the file again", () => {
    const collab = new TextCollab(() => {});
    collab.reset(3);
    expect(collab.remote(5, [textOp(ChangeSet.of({ from: 0, insert: "x" }, 0))])).toBeUndefined();
    expect(collab.ack("nobody", 4)).toBe(false);
    expect(collab.rejected("nobody")).toBe(false);
  });
});

const change = (revision: number, over: Partial<DocChange> = {}): DocChange => ({
  revision,
  ts: "2026-11-08T10:00:00.000Z",
  author: "person",
  groupId: "g",
  summary: { text: "x", kind: "insert", line: 1, lines: 1, added: 3 },
  ...over,
});

describe("reduceDoc: the panel as the host tells it", () => {
  it("opened, changed, an undo marking what it took back, ack, presence, mode, a refusal", () => {
    let v = reduceDoc(emptyDocView(), {
      type: "doc.opened",
      file,
      family: "text",
      revision: 2,
      snapshot: { family: "text", text: "" },
      changes: [
        change(2, { author: "ada", groupId: "turn:1" }),
        change(1, { author: "ada", groupId: "turn:1" }),
      ],
      proposals: [],
      presence: [],
      mode: "now",
      modeOwn: false,
    });
    expect(v.status).toBe("ready");
    v = reduceDoc(v, {
      type: "doc.changed",
      file,
      revision: 3,
      ops: [],
      change: change(3, { undoOf: [1, 2], summary: { text: "u", kind: "undo" } }),
    } as never);
    expect(v.revision).toBe(3);
    expect(v.changes.map((c) => [c.revision, c.undoneBy])).toEqual([
      [3, undefined],
      [2, 3],
      [1, 3],
    ]);
    v = reduceDoc(v, { type: "doc.ack", file, clientId: "c", revision: 4, change: change(4) });
    expect(v.changes[0]?.revision).toBe(4);
    v = reduceDoc(v, {
      type: "doc.presence",
      file,
      presence: [{ who: "ada", name: "Ada", editing: true }],
    });
    expect(v.presence).toHaveLength(1);
    v = reduceDoc(v, { type: "doc.mode", file, mode: "propose", modeOwn: true });
    expect(v.mode).toBe("propose");
    v = reduceDoc(v, {
      type: "doc.rejected",
      file,
      clientId: "u1",
      code: "conflict",
      reason: "r",
      revision: 4,
      conflict: 4,
    });
    expect(v.refusal).toEqual({ clientId: "u1", code: "conflict", reason: "r", conflict: 4 });
  });

  it("groups the panel by turn and gesture, in order", () => {
    const g = groupChanges([
      change(4, { groupId: "turn:b" }),
      change(3, { groupId: "turn:b" }),
      change(2, { groupId: "p" }),
      change(1, { groupId: "turn:a" }),
    ]);
    expect(g.map((x) => [x.groupId, x.items.length])).toEqual([
      ["turn:b", 2],
      ["p", 1],
      ["turn:a", 1],
    ]);
  });

  it("says a change in words, and knows the files it edits", () => {
    expect(changeText({ text: "", kind: "insert", line: 4, lines: 2, added: 23 })).toMatch(/23/);
    expect(changeText({ text: "", kind: "insert", line: 4, lines: 2, added: 23 })).toMatch(/4-5/);
    expect(editableInCanvas({ scope: "platform", path: "notes/a.txt" })).toBe(true);
    expect(editableInCanvas({ scope: "outside", path: "/x/a.txt" })).toBe(false);
    // G37.2: code, Markdown, JSON/YAML/XML too; tables, sites and images are other editors.
    for (const p of ["a.py", "README.md", "conf/app.json", "k8s.yaml", "x.xml", "Makefile"])
      expect(editableInCanvas({ scope: "platform", path: p }), p).toBe(true);
    // G37.3: sheets (csv, tsv, ods) open in the sheet editor; an xlsx through its ODS copy.
    for (const p of ["a.csv", "b.tsv", "c.ods"])
      expect(editableInCanvas({ scope: "platform", path: p }), p).toBe(true);
    for (const p of ["a.xlsx", "index.html", "logo.svg", "a.png", "a.docx"])
      expect(editableInCanvas({ scope: "platform", path: p }), p).toBe(false);
  });
});

describe("the shell", () => {
  it("draws its bar and the panel «Modifiche», with no symbol characters as icons", async () => {
    const { DocEditor } = await import("../src/components/viewers/DocEditor.js");
    const { container } = render(<DocEditor file={file} />);
    expect(container.querySelector(".doc-bar")).toBeTruthy();
    expect(container.querySelector(".doc-mode select")).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[←-⇿☀-➿\u{1f300}-\u{1faff}]/u);
  });
});
