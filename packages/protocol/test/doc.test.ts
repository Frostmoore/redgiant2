// The editor's common model (G37.1): the envelope of operations, the events, the page's messages,
// the encoding of what JSON cannot hold, the rule for the agents' edits, RedGiant's notes.
import { describe, expect, it } from "vitest";
import {
  agentEditMode,
  ClientMessage,
  DEFAULT_EDITOR_SETTINGS,
  DocOp,
  decodeDocValue,
  docKey,
  docStreamId,
  EditorSettings,
  EventBody,
  encodeDocValue,
  notedText,
  quotedText,
  ServerMessage,
} from "../src/index.js";

const file = { scope: "platform", path: "notes/todo.txt" };
const op = {
  family: "text",
  engine: "codemirror-state",
  engineVersion: "6",
  op: { changes: [5, [0, "hi", ""], 3] },
  target: [[5, 5]],
} as const;

describe("DocOp and the doc events (G37.1)", () => {
  it("a text operation is a CodeMirror change set; other shapes are refused", () => {
    expect(DocOp.parse(op)).toEqual(op);
    expect(() => DocOp.parse({ ...op, family: "sheet" })).toThrow();
    expect(() => DocOp.parse({ ...op, op: { changes: [[-1]] } })).toThrow();
    expect(() => DocOp.parse({ ...op, op: { changes: ["x"] } })).toThrow();
  });

  it("doc.ops, doc.replaced, doc.proposed and doc.decided are events", () => {
    const summary = { text: "inserted 2 characters at line 1", kind: "insert", line: 1, lines: 1 };
    const ops = {
      type: "doc.ops",
      payload: {
        file,
        family: "text",
        baseRevision: 3,
        revision: 4,
        author: "agent-1",
        authorName: "Ada",
        sessionId: "s1",
        groupId: "turn:x",
        ops: [op],
        inverse: [op],
        summary,
        undoOf: { revisions: [2, 3] },
      },
    };
    expect(EventBody.parse(ops)).toEqual(ops);
    expect(() => EventBody.parse({ ...ops, payload: { ...ops.payload, ops: [] } })).toThrow();
    const replaced = {
      type: "doc.replaced",
      payload: {
        file,
        family: "text",
        revision: 5,
        hashAfter: "a".repeat(64),
        by: "outside",
        summary: { text: "changed", kind: "replaced" },
      },
    };
    expect(EventBody.parse(replaced)).toEqual(replaced);
    expect(
      EventBody.parse({
        type: "doc.decided",
        payload: { file, proposalId: "p1", decision: "rejected" },
      }).type,
    ).toBe("doc.decided");
  });

  it("the page's messages: open, operations, undo, presence, decide; the host's answers", () => {
    expect(
      ClientMessage.parse({
        type: "doc.ops",
        file,
        clientId: "c1",
        baseRevision: 0,
        ops: [op],
        groupId: "g",
      }).type,
    ).toBe("doc.ops");
    expect(
      ClientMessage.parse({ type: "doc.undo", file, clientId: "c", groupId: "turn:x" }).type,
    ).toBe("doc.undo");
    expect(() =>
      ClientMessage.parse({
        type: "doc.ops",
        file,
        clientId: "c",
        baseRevision: 0,
        ops: [],
        groupId: "g",
      }),
    ).toThrow();
    expect(
      ServerMessage.parse({
        type: "doc.rejected",
        file,
        clientId: "c1",
        code: "conflict",
        reason: "the person changed it",
        revision: 7,
        conflict: 6,
      }).type,
    ).toBe("doc.rejected");
  });

  it("a file's stream and key", () => {
    expect(docStreamId(file)).toBe("file:platform:notes/todo.txt");
    expect(docKey(file)).toBe(docStreamId(file));
  });
});

describe("values JSON cannot hold (G37.0: NaN in pdf.js, bytes)", () => {
  it("round-trips NaN, the infinities, -0 and bytes through JSON", () => {
    const v = {
      a: [1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
      b: new Uint8Array([0, 1, 254, 255]),
      c: { d: "text", e: null, f: true },
    };
    const back = decodeDocValue(JSON.parse(JSON.stringify(encodeDocValue(v)))) as typeof v;
    expect(back.a[1]).toBeNaN();
    expect(back.a[2]).toBe(Number.POSITIVE_INFINITY);
    expect(back.a[3]).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(back.a[4], -0)).toBe(true);
    expect([...back.b]).toEqual([0, 1, 254, 255]);
    expect(back.c).toEqual(v.c);
  });

  it("refuses a key that would read back as an encoding", () => {
    expect(() => encodeDocValue({ $num: "NaN" })).toThrow(/\$/);
  });
});

describe("the rule for the agents' edits", () => {
  const s = EditorSettings.parse({
    agents: { ada: "propose" },
    files: { [docKey(file)]: "now", [docKey({ scope: "platform", path: "b.txt" })]: "propose" },
  });
  it.each([
    ["no choice: at once", DEFAULT_EDITOR_SETTINGS, "bob", file, "now"],
    ["the agent's choice", s, "ada", { scope: "platform", path: "c.txt" }, "propose"],
    ["the file's choice wins over the agent's", s, "ada", file, "now"],
    ["the file's choice for any agent", s, "bob", { scope: "platform", path: "b.txt" }, "propose"],
  ] as const)("%s", (_l, settings, agent, f, want) => {
    expect(agentEditMode(settings, agent, f)).toBe(want);
  });
});

describe("RedGiant's notes after a message", () => {
  it("one line, several lines, with quotes", () => {
    expect(notedText("hi", [])).toBe("hi");
    expect(notedText("hi", ["The person changed a.txt."])).toBe(
      "hi\n\n[RedGiant: The person changed a.txt.]",
    );
    expect(notedText("", ["x", "y"])).toBe("[RedGiant: \n- x\n- y]");
    expect(quotedText("ok", [{ text: "earlier" }], ["n"])).toBe(
      "[The person replies to this passage of your message. They received the whole message; this answers that passage specifically.]\n> earlier\n\nok\n\n[RedGiant: n]",
    );
  });
});
