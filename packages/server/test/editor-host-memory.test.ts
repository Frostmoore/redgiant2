// The editor host's memory (3.5.11): files with nobody on them leave memory beyond a cap (least
// recently used first, after a grace time, written first, back from the log when opened again);
// a file's undo history is capped by weight as well as by count.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeSet } from "@codemirror/state";
import { EventStore, migrate } from "@redgiant/events";
import { DEFAULT_EDITOR_SETTINGS, type DocFile, type DocOp, PERSON } from "@redgiant/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorHost } from "../src/editor/host.js";
import { memoryDb } from "./pglite.js";

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
const ME = "me";
const PERSONA = { id: PERSON };

function host(o: Partial<ConstructorParameters<typeof EditorHost>[0]> = {}) {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_owner, f) => join(dir, "ws", f.path),
    settings: () => DEFAULT_EDITOR_SETTINGS,
    saveDelayMs: 60_000,
    watchMs: 0,
    ...o,
  });
  hosts.push(h);
  return h;
}

const fileN = (n: number): DocFile => ({ scope: "platform", path: `f${n}.txt` });

function insert(text: string, at: number, what: string): DocOp {
  return {
    family: "text",
    engine: "codemirror-state",
    engineVersion: "6",
    op: { changes: ChangeSet.of({ from: at, insert: what }, text.length).toJSON() as never },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-editor-mem-"));
  await mkdir(join(dir, "ws"), { recursive: true });
  for (let n = 0; n < 6; n++) await writeFile(join(dir, "ws", `f${n}.txt`), `file ${n}`);
  const { db } = await memoryDb();
  await migrate(db);
  store = new EventStore(db);
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  await rm(dir, { recursive: true, force: true });
});

/** The host's background work (eviction) done. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("EditorHost's memory (3.5.11)", () => {
  it("keeps at most maxIdleDocs files nobody has open, the least recently used out first", async () => {
    let now = 1_000_000;
    const h = host({ maxIdleDocs: 2, idleGraceMs: 1000, now: () => now });
    for (let n = 0; n < 5; n++) {
      await h.open(ME, fileN(n));
      now += 5000;
    }
    await settle();
    // f4 just opened is within its grace; of the others, the two most recent stay.
    expect(h.stats().docs).toBeLessThanOrEqual(3);
    now += 5000;
    await h.open(ME, fileN(5));
    await settle();
    // The two most recent (f4, f5) stay.
    expect(h.stats()).toMatchObject({ docs: 2, idle: 2 });
  });

  it("never sends away a file someone has open, nor one used within the grace time", async () => {
    let now = 1_000_000;
    const h = host({ maxIdleDocs: 0, idleGraceMs: 10_000, now: () => now });
    await h.subscribe(ME, fileN(0), { id: "page", send: () => {} });
    await h.open(ME, fileN(1));
    now += 1000;
    await h.open(ME, fileN(2));
    await settle();
    expect(h.stats()).toMatchObject({ docs: 3, idle: 2 });
    now += 20_000;
    await h.open(ME, fileN(3));
    await settle();
    // f1 and f2 left; f3 is new, f0 has the page on it.
    expect(h.stats()).toMatchObject({ docs: 2, idle: 1 });
  });

  it("writes a file before it leaves memory and brings it back with its revisions", async () => {
    let now = 1_000_000;
    const h = host({ maxIdleDocs: 0, idleGraceMs: 1000, now: () => now });
    const out = await h.apply(ME, fileN(0), {
      author: PERSONA,
      baseRevision: 0,
      ops: [insert("file 0", 6, "!")],
      groupId: "p",
    });
    expect(out.ok).toBe(true);
    now += 5000;
    await h.open(ME, fileN(1));
    await settle();
    expect(await readFile(join(dir, "ws", "f0.txt"), "utf8")).toBe("file 0!");
    expect(h.stats().docs).toBe(1);
    const back = await h.read(ME, fileN(0));
    expect(back.model?.toString()).toBe("file 0!");
    expect(back.revision).toBe(1);
    // Its revision can still be undone: the log keeps it.
    expect((await h.undo(ME, fileN(0), { revision: 1 }, PERSONA)).ok).toBe(true);
  });

  it("caps a file's undo history by weight: the oldest revisions go, the newest stay", async () => {
    const h = host({ maxHistoryBytes: 20_000 });
    const f = fileN(0);
    let text = "file 0";
    const chunk = "x".repeat(1000);
    for (let i = 0; i < 40; i++) {
      const r = await h.apply(ME, f, {
        author: PERSONA,
        baseRevision: i,
        ops: [insert(text, text.length, chunk)],
        groupId: `p${i}`,
      });
      expect(r.ok).toBe(true);
      text += chunk;
    }
    expect(h.stats().historyBytes).toBeLessThanOrEqual(20_000);
    expect(h.stats().historyBytes).toBeGreaterThan(10_000);
    // The newest is undone; the first is beyond what memory keeps.
    expect((await h.undo(ME, f, { revision: 40 }, PERSONA)).ok).toBe(true);
    expect((await h.undo(ME, f, { revision: 1 }, PERSONA)).ok).toBe(false);
  });
});
