// The editor's host (G37.1) on its own: a real event log (PGlite), a folder of files, no model.
// One queue per file and consecutive revisions; the person's batches rebased, an agent's refused
// on the same place or where the person types; undo of one revision, of a turn, back to before;
// a change from outside as doc.replaced; atomic saving; the file rebuilt from the log.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSet, Text } from "@codemirror/state";
import { EventStore, migrate } from "@redgiant/events";
import {
  DEFAULT_EDITOR_SETTINGS,
  type DocFile,
  type DocOp,
  type EditorSettings,
  PERSON,
  type ServerMessage,
} from "@redgiant/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, EditorHost } from "../src/editor/host.js";
import { textFamily } from "../src/editor/text-family.js";
import { memoryDb } from "./pglite.js";

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
let settings: EditorSettings;
const file: DocFile = { scope: "platform", path: "notes.txt" };
const ME = "me";
const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };
const PERSONA = { id: PERSON };

function host(o: { saveDelayMs?: number; lockMs?: number; now?: () => number } = {}) {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_owner, f) => join(dir, "ws", f.path),
    settings: () => settings,
    saveDelayMs: o.saveDelayMs ?? 60_000,
    watchMs: 0,
    ...(o.lockMs !== undefined && { lockMs: o.lockMs }),
    ...(o.now && { now: o.now }),
  });
  hosts.push(h);
  return h;
}

const disk = () => readFile(join(dir, "ws", file.path), "utf8");

/** The agent's plain operations as the engine's, on the text at hand. */
function agentOps(text: string, ops: unknown[]): DocOp[] {
  const out = textFamily.fromAgent(Text.of(text.split("\n")), ops);
  if ("error" in out) throw new Error(out.error);
  return out.ops;
}

/** A change made by the person's page: CodeMirror's own change set. */
function personOp(text: string, spec: { from: number; to?: number; insert?: string }): DocOp {
  const c = ChangeSet.of(spec, text.length);
  return {
    family: "text",
    engine: "codemirror-state",
    engineVersion: "6",
    op: { changes: c.toJSON() as never },
  };
}

const LINES = "one\ntwo\nthree\nfour\nfive";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-editor-"));
  await mkdir(join(dir, "ws"), { recursive: true });
  await writeFile(join(dir, "ws", file.path), LINES);
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
  settings = DEFAULT_EDITOR_SETTINGS;
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe("EditorHost: the queue and the revisions", () => {
  it("batches sent together take consecutive revisions, in order, each a doc.ops event", async () => {
    const h = host();
    const [a, b, c] = await Promise.all([
      h.apply(ME, file, {
        author: ADA,
        baseRevision: 0,
        ops: agentOps(LINES, [{ op: "insert", line: 1, text: "zero\n" }]),
        groupId: "g1",
      }),
      h.apply(ME, file, {
        author: PERSONA,
        baseRevision: 0,
        ops: [personOp(LINES, { from: LINES.length, insert: "\nsix" })],
        groupId: "p1",
      }),
      h.apply(ME, file, {
        author: PERSONA,
        baseRevision: 0,
        ops: [personOp(LINES, { from: 4, to: 7, insert: "TWO" })],
        groupId: "p1",
      }),
    ]);
    expect([a, b, c].map((r) => r.ok && r.revision)).toEqual([1, 2, 3]);
    // The person's batches made on revision 0 were moved over the later ones.
    expect(b.ok && b.rebased).toBe(true);
    const read = await h.read(ME, file);
    expect(read.model?.toString()).toBe("zero\none\nTWO\nthree\nfour\nfive\nsix");
    const events = await store.list({ sessionId: "file:platform:notes.txt" });
    expect(events.map((e) => e.type)).toEqual(["doc.ops", "doc.ops", "doc.ops"]);
    expect(events.map((e) => (e.payload as { revision: number }).revision)).toEqual([1, 2, 3]);
    expect(events[0]?.agentId).toBe("ada");
    expect(events[1]?.agentId).toBeNull();
  });

  it("an agent's batch on the same place the person changed meanwhile is refused, with why", async () => {
    const h = host();
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 0,
      ops: [personOp(LINES, { from: 4, to: 7, insert: "deux" })],
      groupId: "p",
    });
    const out = await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "two", text: "TWO" }]),
      groupId: "g",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("conflict");
    expect(out.conflict).toBe(1);
    expect(out.reason).toMatch(/the person changed the same place at revision 1/);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\ndeux\nthree\nfour\nfive");
    // Elsewhere it is moved over the person's change and applied.
    const ok = await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "five", text: "FIVE" }]),
      groupId: "g",
    });
    expect(ok.ok && ok.rebased).toBe(true);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\ndeux\nthree\nfour\nFIVE");
  });

  it("where the person is typing, the agent waits: refused as busy until the moment passes", async () => {
    let now = 1000;
    const h = host({ lockMs: 3000, now: () => now });
    const sent: ServerMessage[] = [];
    await h.subscribe(ME, file, { id: "page", send: (m) => sent.push(m) });
    await h.presence(ME, file, "page", { editing: true, from: 9, to: 9 });
    const ops = agentOps(LINES, [{ op: "replace", find: "three", text: "3" }]);
    const busy = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(busy.ok === false && busy.code).toBe("busy");
    expect(busy.ok === false && busy.reason).toMatch(/typing at line 3/);
    // Another line is free.
    const other = await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "one", text: "1" }]),
      groupId: "g",
    });
    expect(other.ok).toBe(true);
    now += 3001;
    const later = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(later.ok).toBe(true);
    expect((await h.read(ME, file)).model?.toString()).toBe("1\ntwo\n3\nfour\nfive");
    // The page was told each change, in order.
    expect(
      sent
        .filter((m) => m.type === "doc.changed")
        .map((m) => m.type === "doc.changed" && m.revision),
    ).toEqual([1, 2]);
  });

  it("p3.5.4: the person typing there now is said as such, an older change as a conflict; the page is told", async () => {
    let now = 1000;
    const h = host({ lockMs: 3000, now: () => now });
    const sent: ServerMessage[] = [];
    await h.subscribe(ME, file, { id: "page", send: (m) => sent.push(m) });
    const held = () => sent.filter((m) => m.type === "doc.held");
    // The person changes line 3 and keeps typing there; the agent made its edit on revision 0.
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 0,
      ops: [personOp(LINES, { from: 8, to: 13, insert: "tre" })],
      groupId: "p",
      origin: { subId: "page", clientId: "c1" },
    });
    await h.presence(ME, file, "page", { editing: true, from: 11, to: 11 });
    const ops = agentOps(LINES, [{ op: "replace", find: "three", text: "3" }]);
    const typing = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(typing.ok === false && typing.code).toBe("busy");
    expect(typing.ok === false && typing.reason).toMatch(/^the person is typing there right now/);
    expect(held()).toEqual([
      { type: "doc.held", file, who: "ada", name: "Ada", code: "busy", line: 3, revision: 1 },
    ]);
    // Between two keys (the place's hold over, still in the text): still typing there.
    now += 4000;
    const pause = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(pause.ok === false && pause.code).toBe("busy");
    sent.length = 0;
    await h.presence(ME, file, "page", { editing: true, from: 11, to: 11 });
    // An agent's own dry run tells nobody; a proposal's check does.
    await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g", dryRun: true });
    expect(held()).toHaveLength(0);
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops,
      groupId: "g",
      dryRun: true,
      tell: true,
    });
    expect(held()).toHaveLength(1);
    // The person stopped typing a while ago: the same edit is a conflict with revision 1.
    now += 60_000;
    await h.presence(ME, file, "page", { editing: false });
    const old = await h.apply(ME, file, { author: ADA, baseRevision: 0, ops, groupId: "g" });
    expect(old.ok === false && old.code).toBe("conflict");
    expect(old.ok === false && old.reason).toMatch(
      /^the person changed the same place at revision 1/,
    );
    expect(held().at(-1)).toMatchObject({ code: "conflict", line: 3, revision: 1 });
    // Typing where the agent writes, with no revision in between: busy, with the line.
    await h.presence(ME, file, "page", { editing: true, from: 1, to: 1 });
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 1,
      ops: agentOps("one\ntwo\ntre\nfour\nfive", [{ op: "replace", find: "one", text: "1" }]),
      groupId: "g",
    });
    expect(held().at(-1)).toMatchObject({ code: "busy", line: 1 });
    expect(held().at(-1)).not.toHaveProperty("revision");
  });

  it("the page that sent a batch gets doc.ack in its place, the others doc.changed", async () => {
    const h = host();
    const a: ServerMessage[] = [];
    const b: ServerMessage[] = [];
    await h.subscribe(ME, file, { id: "a", send: (m) => a.push(m) });
    await h.subscribe(ME, file, { id: "b", send: (m) => b.push(m) });
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 0,
      ops: [personOp(LINES, { from: 0, insert: "> " })],
      groupId: "p",
      origin: { subId: "a", clientId: "c1" },
    });
    expect(a.map((m) => m.type)).toEqual(["doc.opened", "doc.presence", "doc.ack"]);
    expect(b.filter((m) => m.type !== "doc.presence").map((m) => m.type)).toEqual([
      "doc.opened",
      "doc.changed",
    ]);
    expect(a.at(-1)).toMatchObject({ type: "doc.ack", clientId: "c1", revision: 1 });
  });

  it("an operation for another text, or past the head, is refused as invalid", async () => {
    const h = host();
    const wrong = await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 0,
      ops: [personOp("abc", { from: 0, insert: "x" })],
      groupId: "p",
    });
    expect(wrong.ok === false && wrong.code).toBe("invalid");
    const ahead = await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 5,
      ops: [personOp(LINES, { from: 0, insert: "x" })],
      groupId: "p",
    });
    expect(ahead.ok === false && ahead.code).toBe("invalid");
  });
});

describe("EditorHost: undo", () => {
  async function three(h: EditorHost) {
    const t1 = LINES;
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(t1, [{ op: "replace", find: "one", text: "ONE" }]),
      groupId: "turn:1",
    });
    const t2 = "ONE\ntwo\nthree\nfour\nfive";
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 1,
      ops: [personOp(t2, { from: t2.length, insert: "\nsix" })],
      groupId: "p",
    });
    const t3 = `${t2}\nsix`;
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 2,
      ops: agentOps(t3, [{ op: "replace", find: "three", text: "THREE" }]),
      groupId: "turn:1",
    });
  }

  it("«Annulla questa modifica» takes back one revision that is not the last", async () => {
    const h = host();
    await three(h);
    const out = await h.undo(ME, file, { revision: 1 }, PERSONA);
    expect(out.ok && out.revision).toBe(4);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\ntwo\nTHREE\nfour\nfive\nsix");
    const again = await h.undo(ME, file, { revision: 1 }, PERSONA);
    expect(again.ok === false && again.reason).toMatch(/already undone \(revision 4\)/);
    const [e] = (await store.list({ types: ["doc.ops"] })).slice(-1);
    expect(e?.payload).toMatchObject({ undoOf: { revisions: [1] }, summary: { kind: "undo" } });
  });

  it("refused when a later change touched the same place; «Torna a prima» goes back anyway", async () => {
    const h = host();
    await three(h);
    // The person edits what the agent wrote at revision 3.
    const t = "ONE\ntwo\nTHREE\nfour\nfive\nsix";
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 3,
      ops: [personOp(t, { from: 8, to: 13, insert: "Three" })],
      groupId: "p2",
    });
    const out = await h.undo(ME, file, { revision: 3 }, PERSONA);
    expect(out.ok === false && out.code).toBe("conflict");
    expect(out.ok === false && out.conflict).toBe(4);
    const back = await h.undo(ME, file, { revision: 3, toBefore: true }, PERSONA);
    expect(back.ok).toBe(true);
    expect((await h.read(ME, file)).model?.toString()).toBe("ONE\ntwo\nthree\nfour\nfive\nsix");
  });

  it("«Annulla tutto il turno» takes back the whole group, the person's change in between stays", async () => {
    const h = host();
    await three(h);
    const out = await h.undo(ME, file, { groupId: "turn:1" }, PERSONA);
    expect(out.ok).toBe(true);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\ntwo\nthree\nfour\nfive\nsix");
    const e = (await store.list({ types: ["doc.ops"] })).at(-1);
    expect(e?.payload).toMatchObject({ undoOf: { revisions: [1, 3] } });
    const none = await h.undo(ME, file, { groupId: "turn:1" }, PERSONA);
    expect(none.ok === false && none.code).toBe("nothing");
  });
});

describe("EditorHost: the disk", () => {
  it("saves atomically: written beside, read back, renamed; nothing left beside it", async () => {
    const h = host();
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "insert", text: "\nsix" }]),
      groupId: "g",
    });
    expect(await disk()).toBe(LINES);
    await h.flush();
    expect(await disk()).toBe(`${LINES}\nsix`);
    expect((await readdir(join(dir, "ws"))).sort()).toEqual(["notes.txt"]);
    const states = await readdir(join(dir, "data", "editor", "me"));
    const state = JSON.parse(
      await readFile(join(dir, "data", "editor", "me", states[0] as string, "state.json"), "utf8"),
    );
    expect(state).toMatchObject({ revision: 1, family: "text", file });
  });

  it("atomicWrite leaves the old file and no temporary file when it cannot rename", async () => {
    const target = join(dir, "ws", "folder");
    await mkdir(target);
    await expect(atomicWrite(target, new TextEncoder().encode("x"))).rejects.toThrow();
    expect((await readdir(join(dir, "ws"))).sort()).toEqual(["folder", "notes.txt"]);
  });

  it("keeps CRLF line ends and a byte order mark", async () => {
    await writeFile(join(dir, "ws", file.path), "﻿a\r\nb\r\n");
    const h = host();
    const read = await h.read(ME, file);
    expect(read.model?.toString()).toBe("a\nb\n");
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps("a\nb\n", [{ op: "insert", line: 2, text: "x\n" }]),
      groupId: "g",
    });
    await h.flush();
    expect(await disk()).toBe("﻿a\r\nx\r\nb\r\n");
  });

  it("a change from outside becomes doc.replaced with its difference; older bases are moved over it", async () => {
    const h = host();
    const sent: ServerMessage[] = [];
    await h.subscribe(ME, file, { id: "page", send: (m) => sent.push(m) });
    await writeFile(join(dir, "ws", file.path), "one\ntwo\nthree\nfour\nfive\nsix (bash)");
    const out = await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "two", text: "2" }]),
      groupId: "g",
    });
    expect(out.ok && out.revision).toBe(2);
    const replaced = sent.find((m) => m.type === "doc.replaced");
    expect(replaced).toMatchObject({
      revision: 1,
      snapshot: { text: "one\ntwo\nthree\nfour\nfive\nsix (bash)" },
    });
    const [e] = await store.list({ types: ["doc.replaced"] });
    expect(e?.payload).toMatchObject({ by: "outside", revision: 1, summary: { kind: "replaced" } });
    expect((e?.payload as { ops?: unknown[] } | undefined)?.ops).toHaveLength(1);
    expect((await h.read(ME, file)).model?.toString()).toBe(
      "one\n2\nthree\nfour\nfive\nsix (bash)",
    );
    // Even the outside change can be undone.
    expect((await h.undo(ME, file, { revision: 1 }, PERSONA)).ok).toBe(true);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\n2\nthree\nfour\nfive");
  });

  it("rebuilt from the log: revisions accepted but not yet written come back after a restart", async () => {
    const h1 = host();
    await h1.read(ME, file);
    await h1.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "four", text: "4" }]),
      groupId: "g",
    });
    await h1.apply(ME, file, {
      author: PERSONA,
      baseRevision: 1,
      ops: [personOp("one\ntwo\nthree\n4\nfive", { from: 0, to: 3, insert: "1" })],
      groupId: "p",
    });
    // A crash before the save: the disk still has the first text.
    expect(await disk()).toBe(LINES);
    const h2 = host();
    const read = await h2.read(ME, file);
    expect(read.revision).toBe(2);
    expect(read.model?.toString()).toBe("1\ntwo\nthree\n4\nfive");
    // The history is back too: the agent's revision can be undone.
    expect((await h2.undo(ME, file, { revision: 1 }, PERSONA)).ok).toBe(true);
    await h2.flush();
    expect(await disk()).toBe("1\ntwo\nthree\nfour\nfive");
    // Nothing was recorded as a change from outside.
    expect(await store.list({ types: ["doc.replaced"] })).toHaveLength(0);
  });

  it("a file changed while no editor had it is told on the next opening, as its difference", async () => {
    const h1 = host();
    await h1.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "insert", text: "\nsix" }]),
      groupId: "g",
    });
    await h1.close();
    await writeFile(join(dir, "ws", file.path), "one\ntwo\nthree\nfour\nfive\nsix\nseven");
    const h2 = host();
    const read = await h2.read(ME, file);
    expect(read.revision).toBe(2);
    const [e] = await store.list({ types: ["doc.replaced"] });
    expect(e?.payload).toMatchObject({ revision: 2, summary: { kind: "replaced", added: 6 } });
  });
});

describe("EditorHost: proposals, notes, blobs", () => {
  it("a proposal waits; accepted it is the agent's revision, rejected it is gone; the agent is told", async () => {
    const h = host();
    const p = await h.propose(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "replace", find: "two", text: "TWO" }]),
      groupId: "g",
    });
    expect((await h.read(ME, file)).model?.toString()).toBe(LINES);
    const ok = await h.decide(ME, file, p.proposalId, true);
    expect(ok.ok && ok.revision).toBe(1);
    expect((await h.read(ME, file)).model?.toString()).toBe("one\nTWO\nthree\nfour\nfive");
    const [ops] = await store.list({ types: ["doc.ops"] });
    expect(ops?.payload).toMatchObject({ author: "ada", proposalId: p.proposalId });
    expect(h.notesFor("s-ada")[0]).toMatch(/accepted your proposed edit of notes\.txt/);
    const q = await h.propose(ME, file, {
      author: ADA,
      baseRevision: 1,
      ops: agentOps("one\nTWO\nthree\nfour\nfive", [{ op: "delete", from_line: 5 }]),
      groupId: "g",
    });
    expect((await h.decide(ME, file, q.proposalId, false)).ok).toBe(true);
    expect(h.notesFor("s-ada")[0]).toMatch(/rejected/);
    expect((await h.decide(ME, file, q.proposalId, true)).ok).toBe(false);
    expect(
      (await store.list({ types: ["doc.decided"] })).map(
        (e) => (e.payload as { decision: string }).decision,
      ),
    ).toEqual(["accepted", "rejected"]);
  });

  it("the person changing a file an agent edits leaves a line for the agent's conversation", async () => {
    const h = host();
    await h.apply(ME, file, {
      author: ADA,
      baseRevision: 0,
      ops: agentOps(LINES, [{ op: "insert", text: "\nsix" }]),
      groupId: "g",
    });
    h.seen("s-ada", ME, file, 1);
    expect(h.notesFor("s-ada")).toEqual([]);
    await h.apply(ME, file, {
      author: PERSONA,
      baseRevision: 1,
      ops: [personOp(`${LINES}\nsix`, { from: 0, insert: "# " })],
      groupId: "p",
    });
    const [note] = h.notesFor("s-ada");
    expect(note).toMatch(
      /The person changed notes\.txt since you last saw it \(revision 1\): now at revision 2/,
    );
    expect(h.notesFor("s-ada")).toEqual([]);
  });

  it("keeps big data apart, by its hash", async () => {
    const h = host();
    const bytes = new Uint8Array([1, 2, 3, 255]);
    const hash = await h.putBlob(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect([...((await h.blob(hash)) ?? [])]).toEqual([1, 2, 3, 255]);
    expect(await h.blob("../../etc/passwd")).toBeUndefined();
  });
});
