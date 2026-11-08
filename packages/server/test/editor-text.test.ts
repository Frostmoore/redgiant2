// Text and code in the editor (G37.2): changes told in lines, mixed line ends kept, the person's
// place held against every operation of an agent's batch, and the file before and after a change,
// a turn or a proposal for the page's difference view. A real event log (PGlite), no model.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSet, Text } from "@codemirror/state";
import { EventStore, migrate } from "@redgiant/events";
import {
  DEFAULT_EDITOR_SETTINGS,
  type DocFile,
  type DocOp,
  DocSummary,
  PERSON,
} from "@redgiant/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorHost } from "../src/editor/host.js";
import { endsFor, lineCounts, textFamily } from "../src/editor/text-family.js";
import { memoryDb } from "./pglite.js";

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
const ME = "me";
const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };
const PERSONA = { id: PERSON };
const LINES = "one\ntwo\nthree\nfour\nfive";

function host(o: { lockMs?: number; now?: () => number } = {}) {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_owner, f) => join(dir, "ws", f.path),
    settings: () => DEFAULT_EDITOR_SETTINGS,
    saveDelayMs: 60_000,
    watchMs: 0,
    ...(o.lockMs !== undefined && { lockMs: o.lockMs }),
    ...(o.now && { now: o.now }),
  });
  hosts.push(h);
  return h;
}

const doc = (s: string) => Text.of(s.split("\n"));

function agentOps(text: string, ops: unknown[]): DocOp[] {
  const out = textFamily.fromAgent(doc(text), ops);
  if ("error" in out) throw new Error(out.error);
  return out.ops;
}

function personOp(text: string, spec: { from: number; to?: number; insert?: string }): DocOp {
  return {
    family: "text",
    engine: "codemirror-state",
    engineVersion: "6",
    op: { changes: ChangeSet.of(spec, text.length).toJSON() as never },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-editor-text-"));
  await mkdir(join(dir, "ws"), { recursive: true });
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe("text family: changes told in lines", () => {
  // [what the agent does, the summary's English text, changed, added, removed]
  const table: [unknown[], string, number, number, number][] = [
    [[{ op: "replace", find: "two", text: "TWO" }], "changed line 2", 1, 0, 0],
    [[{ op: "insert", line: 3, text: "a\nb\n" }], "added 2 lines at line 3-4", 0, 2, 0],
    [[{ op: "insert", text: "six\n" }], "added 1 line at line 6", 0, 1, 0],
    [[{ op: "delete", from_line: 2, to_line: 3 }], "removed 2 lines from line 2", 0, 0, 2],
    [[{ op: "delete", from_line: 5 }], "removed 1 line from line 5", 0, 0, 1],
    [
      [{ op: "replace", from_line: 2, to_line: 3, text: "2\n2b\n3" }],
      "changed 2 lines and added 1 line at line 2-4",
      2,
      1,
      0,
    ],
    [[{ op: "replace", find: "o", all: true, text: "0" }], "changed lines 1-4", 3, 0, 0],
    [
      [
        { op: "replace", find: "one", text: "1" },
        { op: "insert", line: 5, text: "x\n" },
      ],
      "made 2 changes from line 1 (changed 1 line and added 1 line)",
      1,
      1,
      0,
    ],
  ];
  it.each(table)("%j → %s", (ops, text, changed, added, removed) => {
    const s = textFamily.summarize(doc(LINES), agentOps(LINES, ops));
    expect(s.text).toBe(text);
    expect([s.linesChanged, s.linesAdded, s.linesRemoved]).toEqual([changed, added, removed]);
    expect(DocSummary.safeParse(s).success).toBe(true);
  });

  it("two edits on one line are one changed line; a typed letter is a changed line", () => {
    const c = ChangeSet.of(
      [
        { from: 0, to: 1, insert: "O" },
        { from: 2, to: 3, insert: "E" },
      ],
      LINES.length,
    );
    expect(lineCounts(doc(LINES), c)).toMatchObject({ changed: 1, added: 0, removed: 0, first: 1 });
    const typed = ChangeSet.of({ from: 7, insert: "!" }, LINES.length);
    expect(lineCounts(doc(LINES), typed)).toMatchObject({ changed: 1, first: 2 });
    const enter = ChangeSet.of({ from: 6, insert: "\n" }, LINES.length);
    // Splitting a line: «tw» stays, «o» becomes a line of its own.
    expect(lineCounts(doc(LINES), enter)).toMatchObject({ changed: 1, added: 1, removed: 0 });
  });
});

describe("text family: line ends", () => {
  it("endsFor keeps each line's end through edits, new lines get the usual one", () => {
    const base = doc("a\nb\nc\nd");
    const ends = ["\r\n", "\n", "\r\n"] as const;
    // b changed to B (it keeps b's end) and a line added after it (the usual end).
    expect(endsFor(base, ends, doc("a\nB\nx\nc\nd"), "\r\n")).toEqual([
      "\r\n",
      "\n",
      "\r\n",
      "\r\n",
    ]);
    // A line moved within the middle keeps its own end.
    expect(endsFor(base, ends, doc("a\nc\nb\nd"), "\r\n")).toEqual(["\r\n", "\r\n", "\n"]);
    // Nothing changed: the same ends.
    expect(endsFor(base, ends, base, "\r\n")).toEqual([...ends]);
  });

  it("a file with mixed line ends is saved with the ends it had, edited lines included", async () => {
    const mixed = "one\r\ntwo\nthree\r\nfour\nfive\r\n";
    const file: DocFile = { scope: "platform", path: "mixed.md" };
    await writeFile(join(dir, "ws", file.path), mixed);
    const h = host();
    const text = (await h.read(ME, file)).model?.toString() as string;
    expect(text).toBe("one\ntwo\nthree\nfour\nfive\n");
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(text, [
        { op: "replace", find: "four", text: "FOUR" },
        { op: "insert", line: 2, text: "new\n" },
      ]),
      groupId: "g",
    });
    await h.flush();
    // «new» takes the end most lines have (CRLF: 3 against 2); the others keep theirs, the changed
    // line too.
    expect(await readFile(join(dir, "ws", file.path), "utf8")).toBe(
      "one\r\nnew\r\ntwo\nthree\r\nFOUR\nfive\r\n",
    );
    // A second save compares with the first, not with the file as opened.
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 1,
      ops: agentOps("one\nnew\ntwo\nthree\nFOUR\nfive\n", [{ op: "delete", from_line: 1 }]),
      groupId: "g",
    });
    await h.flush();
    expect(await readFile(join(dir, "ws", file.path), "utf8")).toBe(
      "new\r\ntwo\nthree\r\nFOUR\nfive\r\n",
    );
  });

  it("a file with one kind of line end stays as it was", () => {
    const bytes = new TextEncoder().encode("a\nb\n");
    const { model, format } = textFamily.load(bytes);
    expect(new TextDecoder().decode(textFamily.save(model, format))).toBe("a\nb\n");
    expect((format as { mixed?: unknown }).mixed).toBeUndefined();
  });
});

describe("the person's place against an agent's whole batch", () => {
  it("refused as busy when a later operation of the batch reaches the line the person types", async () => {
    const file: DocFile = { scope: "platform", path: "notes.txt" };
    await writeFile(join(dir, "ws", file.path), LINES);
    let now = 1000;
    const h = host({ lockMs: 3000, now: () => now });
    await h.subscribe(ME, file, { id: "page", send: () => {} });
    // The person types in «four» (offset 15).
    await h.presence(ME, file, "page", { editing: true, from: 15, to: 15 });
    // The first operation is far from it, the second lands on it.
    const ops = agentOps(LINES, [
      { op: "replace", find: "one", text: "1" },
      { op: "replace", find: "four", text: "4" },
    ]);
    const busy = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(busy.ok === false && busy.code).toBe("busy");
    expect(busy.ok === false && busy.reason).toMatch(/typing at line 4/);
    expect((await h.read(ME, file)).model?.toString()).toBe(LINES);
    now += 3001;
    expect((await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" })).ok).toBe(
      true,
    );
  });
});

describe("the file before and after (the difference view)", () => {
  it("of one revision, of an agent's turn with the person's change in between, of a proposal", async () => {
    const file: DocFile = { scope: "platform", path: "app.ts" };
    await writeFile(join(dir, "ws", file.path), LINES);
    const h = host();
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "one", text: "1" }]),
      groupId: "turn:a",
    });
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 1,
      ops: [personOp("1\ntwo\nthree\nfour\nfive", { from: 2, to: 5, insert: "2" })],
      groupId: "p",
    });
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 2,
      ops: agentOps("1\n2\nthree\nfour\nfive", [{ op: "delete", from_line: 5 }]),
      groupId: "turn:a",
    });
    const one = await h.diffOf(ME, file, { revision: 2 });
    expect(one).toMatchObject({
      before: { family: "text", text: "1\ntwo\nthree\nfour\nfive" },
      after: { family: "text", text: "1\n2\nthree\nfour\nfive" },
      from: 2,
      to: 2,
    });
    const turn = await h.diffOf(ME, file, { groupId: "turn:a" });
    expect(turn).toMatchObject({
      before: { text: LINES },
      after: { text: "1\n2\nthree\nfour" },
      from: 1,
      to: 3,
    });
    const p = await h.propose(ME, file, {
      author: ADA,
      baseRevision: 3,
      ops: agentOps("1\n2\nthree\nfour", [{ op: "insert", text: "\nfive" }]),
      groupId: "turn:b",
    });
    const proposal = await h.diffOf(ME, file, { proposalId: p.proposalId });
    expect(proposal).toMatchObject({
      before: { text: "1\n2\nthree\nfour" },
      after: { text: "1\n2\nthree\nfour\nfive" },
    });
    await expect(h.diffOf(ME, file, { revision: 9 })).rejects.toThrow(/does not exist/);
    await expect(h.diffOf(ME, file, { proposalId: "nope" })).rejects.toThrow(/not open/);
  });
});
