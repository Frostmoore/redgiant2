// The editor's host (G37.1): the one owner of every open file on the server. The person's pages
// and the agents send it operations; it applies them one at a time per file (a queue, like a
// WebSocket connection's messages), each batch a revision. An operation made on an older revision
// is rebased onto the head when the family can; if a later revision by someone else touched the
// same place it is refused with the reason (the libraries would merge it in silence, G37.0), and
// while the person types somewhere the agents' edits there are refused too (the person's lead).
// Every revision is a `doc.ops` event of the file's own stream, written before anything else; the
// file is saved a moment later, atomically (written beside, read back, then put in place), and a
// change from outside (write_file, bash, another program) is noticed by its hash: `doc.replaced`.
// Undo is an operation like any other: one revision taken back (`git revert`), a whole turn, or
// back to before a revision. Nothing here talks to the network or runs what a file holds.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { EventStore } from "@redgiant/events";
import {
  type AgentEditMode,
  agentEditMode,
  type DocChange,
  type DocFile,
  type DocOp,
  type DocPresence,
  type DocProposal,
  type DocProposedPayload,
  type DocSnapshot,
  type DocSummary,
  docKey,
  docStreamId,
  type EditorSettings,
  type Event,
  PERSON,
  type ServerMessage,
} from "@redgiant/protocol";
import { type DocFamily, SaveWaits } from "./family.js";
import { textFamily } from "./text-family.js";

/** A page (or a test) that opened a file: it is told every change in the order they applied. */
export interface DocSubscriber {
  id: string;
  send(m: ServerMessage): void;
}

export interface EditorHostOptions {
  store: EventStore;
  /** Where the host keeps its own files: each file's `state.json` and last save, the blobs. */
  dataDir: string;
  /** The file on disk; throws when the owner may not edit it (unknown scope, outside, a link). */
  resolve(ownerId: string, file: DocFile): Promise<string>;
  /** The settings of the rule for the agents' edits. */
  settings(ownerId: string): EditorSettings;
  families?: DocFamily[];
  /** Pause after the last change before the file is written (2 s). */
  saveDelayMs?: number;
  /** How long the person's typing holds a place against the agents (3 s). */
  lockMs?: number;
  /** How often an open file is checked for changes from outside (2 s; 0: only before each op). */
  watchMs?: number;
  now?: () => number;
}

/** Who asks: the person (from a page) or an agent (canvas_edit). */
export interface Author {
  id: string;
  name?: string;
  sessionId?: string;
}

export type Applied = {
  ok: true;
  revision: number;
  /** The revision made (undefined for a dry run). */
  change?: DocChange;
  summary: DocSummary;
  /** Whether the operations had to be moved onto later revisions. */
  rebased: boolean;
};
export type Refused = {
  ok: false;
  code: "conflict" | "busy" | "stale" | "invalid" | "gone" | "nothing";
  reason: string;
  revision: number;
  conflict?: number;
};
export type Outcome = Applied | Refused;

interface Rev {
  revision: number;
  ts: string;
  author: string;
  authorName?: string;
  sessionId?: string;
  groupId: string;
  ops: DocOp[];
  inverse: DocOp[];
  summary: DocSummary;
  undoOf?: number[];
  undoneBy?: number;
  replaced?: boolean;
  wrote: [number, number][];
}

interface Person {
  editing: boolean;
  from: number;
  to: number;
  until: number;
}

interface Doc {
  ownerId: string;
  file: DocFile;
  key: string;
  abs: string;
  family: DocFamily;
  model: unknown;
  format: unknown;
  revision: number;
  /** Revisions since the last one that cannot be undone across (a replace without its difference). */
  history: Rev[];
  /** The first revision `history` reaches back to (its base). */
  floor: number;
  saved: { revision: number; hash: string; size: number; mtimeMs: number };
  saveTimer?: ReturnType<typeof setTimeout> | undefined;
  watchTimer?: ReturnType<typeof setInterval> | undefined;
  queue: Promise<unknown>;
  subs: Map<string, DocSubscriber>;
  people: Map<string, Person>;
  agents: Map<string, { name?: string; at: number }>;
  proposals: Map<string, DocProposedPayload & { ts: string }>;
  usedAt: number;
}

interface StateFile {
  file: DocFile;
  family: string;
  revision: number;
  hash: string;
  savedAt: string;
}

/** History kept for undo and rebasing; older revisions stay in the log. */
const MAX_HISTORY = 2000;
/** A difference from outside kept as operations (undoable) up to this size. */
const MAX_DIFF = 256 * 1024;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Writes a file so it is never half-written: beside it, read back, then put in its place. */
export async function atomicWrite(abs: string, bytes: Uint8Array): Promise<void> {
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomUUID().slice(0, 8)}.rg-save`);
  const mode = await stat(abs).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  try {
    await writeFile(tmp, bytes, mode !== undefined ? { mode } : {});
    const back = await readFile(tmp);
    if (back.length !== bytes.length || sha256(back) !== sha256(bytes))
      throw new Error("The file read back is not the one written");
    // Windows may hold the file a moment (an antivirus, an indexer): a few tries.
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, abs);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (i >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const projectOf = (file: DocFile) => file.scope.match(/^project:(.+)$/)?.[1] ?? null;

export class EditorHost {
  private readonly docs = new Map<string, Doc>();
  private readonly loading = new Map<string, Promise<Doc>>();
  private readonly families: DocFamily[];
  private readonly now: () => number;
  /** The agent's turn: one group per turn («Annulla tutto il turno»). */
  private readonly turns = new Map<string, string>();
  /** The revision each conversation last saw of each file. */
  private readonly seenBy = new Map<string, Map<string, number>>();
  /** Lines waiting for a conversation: the person changed a file it edits, a proposal decided. */
  private readonly pending = new Map<string, Map<string, string>>();
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly o: EditorHostOptions) {
    this.families = o.families ?? [textFamily];
    this.now = o.now ?? Date.now;
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  /** The family that edits this file, if any. */
  familyFor(path: string): DocFamily | undefined {
    return this.families.find((f) => f.accepts(path));
  }

  allFamilies(): readonly DocFamily[] {
    return this.families;
  }

  // ---- opening ------------------------------------------------------------------------------

  private keyOf(ownerId: string, file: DocFile) {
    return `${ownerId}\u0000${docKey(file)}`;
  }

  private stateDir(ownerId: string, file: DocFile) {
    const id = createHash("sha256").update(docKey(file)).digest("hex").slice(0, 24);
    return join(this.o.dataDir, "editor", ownerId.replace(/[^a-zA-Z0-9_-]/g, "_"), id);
  }

  /** The file open on the server (loaded once, rebuilt from the log and the disk). */
  async open(ownerId: string, file: DocFile): Promise<Doc> {
    const key = this.keyOf(ownerId, file);
    const d = this.docs.get(key);
    if (d) {
      d.usedAt = this.now();
      return d;
    }
    let p = this.loading.get(key);
    if (!p) {
      p = this.load(ownerId, file).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p;
  }

  private async load(ownerId: string, file: DocFile): Promise<Doc> {
    const family = this.familyFor(file.path);
    if (!family) throw new Error(`No editor for ${basename(file.path)} yet`);
    const abs = await this.o.resolve(ownerId, file);
    const bytes = await readFile(abs);
    const st = await stat(abs);
    const disk = family.load(bytes, file.path);
    const hash = sha256(bytes);
    const dir = this.stateDir(ownerId, file);
    const state = await readFile(join(dir, "state.json"), "utf8")
      .then((t) => JSON.parse(t) as StateFile)
      .catch(() => undefined);
    const events = (
      await this.o.store.list({
        sessionId: docStreamId(file),
        types: ["doc.ops", "doc.replaced", "doc.proposed", "doc.decided"],
      })
    ).filter((e) => e.ownerId === ownerId && e.payload);
    const doc: Doc = {
      ownerId,
      file,
      key: this.keyOf(ownerId, file),
      abs,
      family,
      model: disk.model,
      format: disk.format,
      revision: 0,
      history: [],
      floor: 0,
      saved: { revision: 0, hash, size: st.size, mtimeMs: st.mtimeMs },
      queue: Promise.resolve(),
      subs: new Map(),
      people: new Map(),
      agents: new Map(),
      proposals: new Map(),
      usedAt: this.now(),
    };
    this.rebuild(doc, events);
    const head = doc.revision;
    if (head === 0) await this.writeState(doc, bytes);
    else {
      // The file as last saved here (the disk, or the copy beside the state when the disk changed),
      // then the revisions accepted after that save: durable in the log before the file is written.
      let base: { model: unknown; format: unknown } | undefined;
      if (state?.hash === hash) base = disk;
      else if (state) {
        const last = await readFile(join(dir, "content")).catch(() => undefined);
        if (last && sha256(last) === state.hash) base = family.load(last, file.path);
      }
      const replay = base && state ? this.after(doc, state.revision) : undefined;
      if (base && state && replay) {
        let model = base.model;
        for (const r of replay) for (const op of r.ops) model = family.apply(model, op);
        doc.model = model;
        doc.format = base.format;
        doc.saved = {
          revision: state.revision,
          hash: state.hash,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
        // Changed on disk while nobody had it open: told as its difference from what the log knew.
        if (state.hash !== hash) await this.replaced(doc, bytes, st, "outside");
        else if (state.revision < head) this.scheduleSave(doc, 0);
      } else {
        // Nothing to rebuild it from: the disk is the truth from here, and the log says so.
        doc.saved = { revision: head, hash: "", size: st.size, mtimeMs: st.mtimeMs };
        await this.replaced(doc, bytes, st, "outside");
      }
    }
    this.docs.set(doc.key, doc);
    if ((this.o.watchMs ?? 2000) > 0) {
      doc.watchTimer = setInterval(() => {
        if (doc.subs.size === 0) return;
        void this.enqueue(doc, () => this.checkDisk(doc)).catch(() => {});
      }, this.o.watchMs ?? 2000);
      doc.watchTimer.unref?.();
    }
    return doc;
  }

  /** The file's stream read back: revisions, what was undone, the proposals still open. */
  private rebuild(doc: Doc, events: Event[]): void {
    for (const e of events) {
      if (e.type === "doc.ops" && e.payload) {
        const p = e.payload;
        doc.revision = p.revision;
        const rev: Rev = {
          revision: p.revision,
          ts: e.ts,
          author: p.author,
          ...(p.authorName && { authorName: p.authorName }),
          ...(p.sessionId && { sessionId: p.sessionId }),
          groupId: p.groupId,
          ops: p.ops,
          inverse: p.inverse,
          summary: p.summary,
          ...(p.undoOf && { undoOf: p.undoOf.revisions }),
          wrote: [],
        };
        for (const u of p.undoOf?.revisions ?? []) {
          const t = doc.history.find((r) => r.revision === u);
          if (t) t.undoneBy = p.revision;
        }
        this.remember(doc, rev);
        if (p.proposalId) doc.proposals.delete(p.proposalId);
      } else if (e.type === "doc.replaced" && e.payload) {
        const p = e.payload;
        doc.revision = p.revision;
        if (p.ops?.length && p.inverse?.length)
          this.remember(doc, {
            revision: p.revision,
            ts: e.ts,
            author: p.by,
            groupId: `replaced:${p.revision}`,
            ops: p.ops,
            inverse: p.inverse,
            summary: p.summary,
            replaced: true,
            wrote: [],
          });
        else {
          // Without its difference nothing before it can be undone or rebased.
          doc.history = [];
          doc.floor = p.revision;
        }
      } else if (e.type === "doc.proposed" && e.payload)
        doc.proposals.set(e.payload.proposalId, { ...e.payload, ts: e.ts });
      else if (e.type === "doc.decided" && e.payload) doc.proposals.delete(e.payload.proposalId);
    }
  }

  private remember(doc: Doc, rev: Rev) {
    doc.history.push(rev);
    if (doc.history.length > MAX_HISTORY) {
      const dropped = doc.history.splice(0, doc.history.length - MAX_HISTORY);
      doc.floor = dropped.at(-1)?.revision ?? doc.floor;
    }
  }

  /** The revisions after `base`, all of them, or undefined when the history does not reach. */
  private after(doc: Doc, base: number): Rev[] | undefined {
    if (base < doc.floor) return undefined;
    const later = doc.history.filter((r) => r.revision > base);
    return later.length === doc.revision - base ? later : undefined;
  }

  /** The model as it was at an earlier revision (inverses applied from the head back). */
  private modelAt(doc: Doc, revision: number): unknown {
    if (revision === doc.revision) return doc.model;
    const later = this.after(doc, revision);
    if (!later) return undefined;
    let m = doc.model;
    for (const r of [...later].reverse()) for (const op of r.inverse) m = doc.family.apply(m, op);
    return m;
  }

  private enqueue<T>(doc: Doc, fn: () => Promise<T>): Promise<T> {
    const run = doc.queue.then(fn, fn);
    doc.queue = run.catch(() => {});
    return run;
  }

  // ---- what the page and the agent are told -------------------------------------------------

  private changeOf(r: Rev): DocChange {
    return {
      revision: r.revision,
      ts: r.ts,
      author: r.author,
      ...(r.authorName && { authorName: r.authorName }),
      groupId: r.groupId,
      summary: r.summary,
      ...(r.undoOf && { undoOf: r.undoOf }),
      ...(r.undoneBy && { undoneBy: r.undoneBy }),
      ...(r.replaced && { replaced: true }),
      ...(r.wrote.length > 0 && { wrote: r.wrote }),
    };
  }

  private proposalsOf(doc: Doc): DocProposal[] {
    return [...doc.proposals.values()].map((p) => ({
      proposalId: p.proposalId,
      ts: p.ts,
      author: p.author,
      ...(p.authorName && { authorName: p.authorName }),
      baseRevision: p.baseRevision,
      summary: p.summary,
    }));
  }

  private presenceOf(doc: Doc): DocPresence[] {
    const now = this.now();
    const out: DocPresence[] = [];
    for (const p of doc.people.values())
      out.push({
        who: PERSON,
        editing: p.editing && p.until > now,
        line: doc.family.lineOf(doc.model, p.from),
      });
    if (doc.subs.size > doc.people.size)
      for (let i = doc.people.size; i < doc.subs.size; i++)
        out.push({ who: PERSON, editing: false });
    for (const [id, a] of doc.agents)
      if (now - a.at < 60_000)
        out.push({ who: id, ...(a.name && { name: a.name }), editing: true });
    return out.slice(0, 50);
  }

  private modeOf(doc: Doc): { mode: AgentEditMode; modeOwn: boolean } {
    const files = this.o.settings(doc.ownerId).files;
    const own = files[docKey(doc.file)];
    return { mode: own ?? "now", modeOwn: own !== undefined };
  }

  private broadcast(doc: Doc, m: ServerMessage, except?: string) {
    for (const s of doc.subs.values()) if (s.id !== except) s.send(m);
  }

  /** A page opens the file: what it shows first; from then on it is told every change. */
  async subscribe(ownerId: string, file: DocFile, sub: DocSubscriber): Promise<void> {
    const doc = await this.open(ownerId, file);
    await this.enqueue(doc, async () => {
      await this.checkDisk(doc);
      doc.subs.set(sub.id, sub);
      sub.send({
        type: "doc.opened",
        file,
        family: doc.family.id,
        revision: doc.revision,
        snapshot: doc.family.snapshot(doc.model),
        changes: doc.history
          .slice(-200)
          .reverse()
          .map((r) => this.changeOf(r)),
        proposals: this.proposalsOf(doc),
        presence: this.presenceOf(doc),
        ...this.modeOf(doc),
      });
      this.broadcast(doc, { type: "doc.presence", file, presence: this.presenceOf(doc) }, sub.id);
    });
  }

  async unsubscribe(ownerId: string, file: DocFile, subId: string): Promise<void> {
    const doc = this.docs.get(this.keyOf(ownerId, file));
    if (!doc) return;
    doc.subs.delete(subId);
    doc.people.delete(subId);
    this.broadcast(doc, { type: "doc.presence", file, presence: this.presenceOf(doc) });
    // The last page closed it: written now rather than in a moment.
    if (doc.subs.size === 0 && doc.saved.revision < doc.revision) this.scheduleSave(doc, 0);
  }

  /** The rule for the agents' edits changed: every page that has the file open is told. */
  modeChanged(ownerId: string): void {
    for (const d of this.docs.values())
      if (d.ownerId === ownerId)
        this.broadcast(d, { type: "doc.mode", file: d.file, ...this.modeOf(d) });
  }

  // ---- presence -----------------------------------------------------------------------------

  /** Where the person is typing: the agents' edits there wait a moment (`lockMs`). */
  async presence(
    ownerId: string,
    file: DocFile,
    subId: string,
    p: { editing: boolean; from?: number | undefined; to?: number | undefined },
  ): Promise<void> {
    const doc = this.docs.get(this.keyOf(ownerId, file));
    if (!doc?.subs.has(subId)) return;
    const before = doc.people.get(subId);
    const from = Math.max(0, p.from ?? before?.from ?? 0);
    const to = Math.max(from, p.to ?? from);
    doc.people.set(subId, {
      editing: p.editing,
      from,
      to,
      until: p.editing ? this.now() + (this.o.lockMs ?? 3000) : 0,
    });
    if (before?.editing !== p.editing)
      this.broadcast(doc, { type: "doc.presence", file, presence: this.presenceOf(doc) }, subId);
  }

  /** The place the person holds now, if they are typing. */
  private heldBy(doc: Doc, op: DocOp): string | undefined {
    const now = this.now();
    for (const p of doc.people.values())
      if (p.editing && p.until > now && doc.family.touches(op, p.from, p.to))
        return (
          doc.family.placeOf?.(doc.model, p.from) ?? `line ${doc.family.lineOf(doc.model, p.from)}`
        );
    return undefined;
  }

  // ---- applying -----------------------------------------------------------------------------

  /**
   * Applies a batch made on `baseRevision`. The person's batches are always rebased (theirs is
   * the lead); an agent's is refused when someone else changed the same place after its base, or
   * when the person is typing there now.
   */
  apply(
    ownerId: string,
    file: DocFile,
    req: {
      author: Author;
      baseRevision: number;
      ops: DocOp[];
      groupId: string;
      /** The page that sent it: it gets `doc.ack` in its place in the order. */
      origin?: { subId: string; clientId: string };
      dryRun?: boolean;
      proposalId?: string;
    },
  ): Promise<Outcome> {
    return this.open(ownerId, file).then((doc) =>
      this.enqueue(doc, async () => {
        await this.checkDisk(doc);
        return this.applyNow(doc, req);
      }),
    );
  }

  private async applyNow(
    doc: Doc,
    req: {
      author: Author;
      baseRevision: number;
      ops: DocOp[];
      groupId: string;
      origin?: { subId: string; clientId: string };
      dryRun?: boolean;
      proposalId?: string;
      undoOf?: { revisions: number[]; toBefore?: boolean };
      kind?: DocSummary["kind"];
    },
  ): Promise<Outcome> {
    const refuse = (code: Refused["code"], reason: string, conflict?: number): Refused => ({
      ok: false,
      code,
      reason,
      revision: doc.revision,
      ...(conflict !== undefined && { conflict }),
    });
    const f = doc.family;
    const person = req.author.id === PERSON;
    if (req.baseRevision > doc.revision)
      return refuse(
        "invalid",
        `revision ${req.baseRevision} does not exist yet (the head is ${doc.revision})`,
      );
    let ops = req.ops;
    let rebased = false;
    if (req.baseRevision < doc.revision) {
      const later = this.after(doc, req.baseRevision);
      if (!later)
        return refuse(
          "stale",
          `the file was replaced since revision ${req.baseRevision}: read it again (revision ${doc.revision})`,
        );
      let one = f.compose(ops);
      if (!one) return refuse("stale", "these operations cannot be moved onto the later revisions");
      for (const l of later) {
        const lc = f.compose(l.ops);
        if (!lc) return refuse("stale", "a later revision cannot be read back");
        if (!person && l.author !== req.author.id && f.conflicts(one, lc))
          return refuse(
            "conflict",
            `${l.author === PERSON ? "the person" : (l.authorName ?? l.author)} changed the same place at revision ${l.revision} (${l.summary.text}) after your revision ${req.baseRevision}: look again and redo it on revision ${doc.revision}`,
            l.revision,
          );
        const moved = f.map(one, lc);
        if (!moved)
          return refuse(
            person ? "stale" : "conflict",
            `revision ${l.revision} (${l.summary.text}) moved what these operations touch: look again and redo it on revision ${doc.revision}`,
            l.revision,
          );
        one = moved;
      }
      ops = [one];
      rebased = true;
    }
    // Checked on the model they apply to.
    let model = doc.model;
    const inverse: DocOp[] = [];
    for (const [i, op] of ops.entries()) {
      const bad = f.check(model, op);
      if (bad) return refuse("invalid", `operation ${i + 1}: ${bad}`);
      inverse.unshift(f.invert(model, op));
      model = f.apply(model, op);
    }
    // Where the person is typing, the whole batch (G37.2: every operation of it, not the first).
    if (!person && !req.undoOf && !req.proposalId) {
      const all = ops.length > 1 ? f.compose(ops) : ops[0];
      const line = all ? this.heldBy(doc, all) : undefined;
      if (line !== undefined)
        return refuse(
          "busy",
          `the person is typing at ${line} right now: their edit comes first. Try again in a few seconds, or change another place`,
        );
    }
    const summary = f.summarize(doc.model, ops, req.kind);
    if (req.dryRun) return { ok: true, revision: doc.revision, summary, rebased };
    const revision = doc.revision + 1;
    const event = await this.o.store.append({
      ownerId: doc.ownerId,
      projectId: projectOf(doc.file),
      agentId: person ? null : req.author.id,
      sessionId: docStreamId(doc.file),
      body: {
        type: "doc.ops",
        payload: {
          file: doc.file,
          family: f.id,
          baseRevision: req.baseRevision,
          revision,
          author: req.author.id,
          ...(req.author.name && { authorName: req.author.name }),
          ...(req.author.sessionId && { sessionId: req.author.sessionId }),
          groupId: req.groupId,
          ops,
          inverse,
          summary,
          ...(req.undoOf && { undoOf: req.undoOf }),
          ...(req.proposalId && { proposalId: req.proposalId }),
        },
      },
    });
    // Committed: the model moves, the places held move with it.
    doc.model = model;
    doc.revision = revision;
    for (const p of doc.people.values())
      for (const op of ops) {
        p.from = f.mapPos(op, p.from, -1);
        p.to = f.mapPos(op, p.to, 1);
      }
    const rev: Rev = {
      revision,
      ts: event.ts,
      author: req.author.id,
      ...(req.author.name && { authorName: req.author.name }),
      ...(req.author.sessionId && { sessionId: req.author.sessionId }),
      groupId: req.groupId,
      ops,
      inverse,
      summary,
      ...(req.undoOf && { undoOf: req.undoOf.revisions }),
      wrote: f.wrote(ops),
    };
    for (const u of req.undoOf?.revisions ?? []) {
      const t = doc.history.find((r) => r.revision === u);
      if (t) t.undoneBy = revision;
    }
    this.remember(doc, rev);
    if (!person)
      doc.agents.set(req.author.id, {
        ...(req.author.name && { name: req.author.name }),
        at: this.now(),
      });
    const change = this.changeOf(rev);
    for (const s of doc.subs.values())
      if (req.origin && s.id === req.origin.subId)
        s.send({
          type: "doc.ack",
          file: doc.file,
          clientId: req.origin.clientId,
          revision,
          change,
        });
      else s.send({ type: "doc.changed", file: doc.file, revision, ops, change });
    if (!person)
      this.broadcast(doc, { type: "doc.presence", file: doc.file, presence: this.presenceOf(doc) });
    if (person) this.tellAgents(doc, rev);
    this.scheduleSave(doc);
    return { ok: true, revision, change, summary, rebased };
  }

  /** The person changed a file agents are editing: each of their conversations gets a line. */
  private tellAgents(doc: Doc, rev: Rev) {
    const key = docKey(doc.file);
    for (const [sessionId, files] of this.seenBy) {
      const seen = files.get(`${doc.ownerId}\u0000${key}`);
      if (seen === undefined) continue;
      this.note(
        sessionId,
        key,
        `The person changed ${doc.file.path} since you last saw it (revision ${seen}): now at revision ${rev.revision}, last «${rev.summary.text}». Look again (canvas_look view "structure") before editing the same place.`,
      );
    }
  }

  private note(sessionId: string, key: string, line: string) {
    let m = this.pending.get(sessionId);
    if (!m) {
      m = new Map();
      this.pending.set(sessionId, m);
    }
    m.set(key, line);
  }

  // ---- undo ---------------------------------------------------------------------------------

  /**
   * «Annulla questa modifica» (one revision, even not the last: its inverse moved over what came
   * after, refused when someone changed the same place since), «Torna a prima di questa
   * modifica» (`toBefore`: every revision from it to the head taken back), «Annulla tutto il
   * turno» (`groupId`: the group's revisions, the last first).
   */
  undo(
    ownerId: string,
    file: DocFile,
    what: { revision?: number; toBefore?: boolean; groupId?: string },
    by: Author,
  ): Promise<Outcome> {
    return this.open(ownerId, file).then((doc) =>
      this.enqueue(doc, async () => {
        await this.checkDisk(doc);
        const refuse = (code: Refused["code"], reason: string, conflict?: number): Refused => ({
          ok: false,
          code,
          reason,
          revision: doc.revision,
          ...(conflict !== undefined && { conflict }),
        });
        const f = doc.family;
        const group = `undo:${randomUUID()}`;
        if (what.toBefore && what.revision) {
          const later = this.after(doc, what.revision - 1);
          if (!later)
            return refuse(
              "stale",
              "that revision is before the file was replaced: it cannot be gone back to",
            );
          const ops = [...later].reverse().flatMap((r) => r.inverse);
          return this.applyNow(doc, {
            author: by,
            baseRevision: doc.revision,
            ops,
            groupId: group,
            undoOf: {
              revisions: later.filter((r) => !r.undoneBy).map((r) => r.revision),
              toBefore: true,
            },
            kind: "undo",
          });
        }
        const targets = what.revision
          ? doc.history.filter((r) => r.revision === what.revision)
          : doc.history.filter((r) => r.groupId === what.groupId && !r.undoneBy && !r.undoOf);
        if (targets.length === 0)
          return refuse(
            "nothing",
            what.revision
              ? `revision ${what.revision} is not in the history`
              : "nothing of that turn to undo",
          );
        const done = targets.find((t) => t.undoneBy);
        if (done)
          return refuse(
            "nothing",
            `revision ${done.revision} was already undone (revision ${done.undoneBy})`,
          );
        const ids = new Set(targets.map((t) => t.revision));
        const made: DocOp[] = [];
        for (const t of [...targets].reverse()) {
          let inv = f.compose(t.inverse);
          if (!inv) return refuse("stale", `revision ${t.revision} cannot be undone`);
          // Over what came after it, then over the undo's own operations made so far.
          for (const l of doc.history.filter((r) => r.revision > t.revision)) {
            const lc = f.compose(l.ops);
            if (!lc) return refuse("stale", "a later revision cannot be read back");
            if (!ids.has(l.revision) && f.conflicts(inv, lc))
              return refuse(
                "conflict",
                `revision ${l.revision} (${l.author === PERSON ? "the person" : (l.authorName ?? l.author)}: ${l.summary.text}) changed the same place later: go back to before revision ${t.revision} instead, or undo ${l.revision} first`,
                l.revision,
              );
            const moved = f.map(inv, lc);
            if (!moved)
              return refuse(
                "conflict",
                `revision ${l.revision} (${l.summary.text}) moved what revision ${t.revision} changed: go back to before revision ${t.revision} instead`,
                l.revision,
              );
            inv = moved;
          }
          for (const m of made) {
            const moved = f.map(inv, m);
            if (!moved)
              return refuse("stale", `revision ${t.revision} cannot be undone with the others`);
            inv = moved;
          }
          made.push(inv);
        }
        return this.applyNow(doc, {
          author: by,
          baseRevision: doc.revision,
          ops: made,
          groupId: group,
          undoOf: { revisions: targets.map((t) => t.revision) },
          kind: "undo",
        });
      }),
    );
  }

  // ---- proposals ----------------------------------------------------------------------------

  /** An agent's batch kept for the person (the rule «come proposte»). */
  propose(
    ownerId: string,
    file: DocFile,
    req: { author: Author; baseRevision: number; ops: DocOp[]; groupId: string },
  ): Promise<{ proposalId: string; summary: DocSummary }> {
    return this.open(ownerId, file).then((doc) =>
      this.enqueue(doc, async () => {
        const base = this.modelAt(doc, req.baseRevision);
        if (base === undefined) throw new Error("That revision cannot be read back");
        const summary = doc.family.summarize(base, req.ops);
        const proposalId = randomUUID().slice(0, 12);
        const payload: DocProposedPayload = {
          file,
          family: doc.family.id,
          proposalId,
          baseRevision: req.baseRevision,
          author: req.author.id,
          ...(req.author.name && { authorName: req.author.name }),
          ...(req.author.sessionId && { sessionId: req.author.sessionId }),
          groupId: req.groupId,
          ops: req.ops,
          summary,
        };
        const e = await this.o.store.append({
          ownerId,
          projectId: projectOf(file),
          agentId: req.author.id,
          sessionId: docStreamId(file),
          body: { type: "doc.proposed", payload },
        });
        doc.proposals.set(proposalId, { ...payload, ts: e.ts });
        this.broadcast(doc, { type: "doc.proposals", file, proposals: this.proposalsOf(doc) });
        return { proposalId, summary };
      }),
    );
  }

  /** The person accepts (applied as the agent's, refused on a conflict) or rejects a proposal. */
  async decide(
    ownerId: string,
    file: DocFile,
    proposalId: string,
    accept: boolean,
  ): Promise<Outcome> {
    const doc = await this.open(ownerId, file);
    return this.enqueue(doc, async () => {
      await this.checkDisk(doc);
      const p = doc.proposals.get(proposalId);
      if (!p)
        return {
          ok: false as const,
          code: "gone" as const,
          reason: "That proposal is not open anymore",
          revision: doc.revision,
        };
      let out: Outcome = { ok: true, revision: doc.revision, summary: p.summary, rebased: false };
      if (accept) {
        out = await this.applyNow(doc, {
          author: {
            id: p.author,
            ...(p.authorName && { name: p.authorName }),
            ...(p.sessionId && { sessionId: p.sessionId }),
          },
          baseRevision: p.baseRevision,
          ops: p.ops,
          groupId: p.groupId,
          proposalId,
        });
        if (!out.ok) return out;
      }
      await this.o.store.append({
        ownerId,
        projectId: projectOf(file),
        sessionId: docStreamId(file),
        body: {
          type: "doc.decided",
          payload: {
            file,
            proposalId,
            decision: accept ? "accepted" : "rejected",
            ...(accept && out.ok && out.change && { revision: out.revision }),
          },
        },
      });
      doc.proposals.delete(proposalId);
      this.broadcast(doc, { type: "doc.proposals", file, proposals: this.proposalsOf(doc) });
      if (p.sessionId)
        this.note(
          p.sessionId,
          docKey(file),
          accept
            ? `The person accepted your proposed edit of ${file.path} (${p.summary.text}): it is revision ${out.revision}.`
            : `The person rejected your proposed edit of ${file.path} (${p.summary.text}).`,
        );
      return out;
    });
  }

  // ---- outside changes and saving -----------------------------------------------------------

  /** A change on disk not made here becomes `doc.replaced`; the host starts from it. */
  private async checkDisk(doc: Doc): Promise<void> {
    const st = await stat(doc.abs).catch(() => undefined);
    if (!st) return;
    if (st.size === doc.saved.size && st.mtimeMs === doc.saved.mtimeMs) return;
    const bytes = await readFile(doc.abs);
    const hash = sha256(bytes);
    if (hash === doc.saved.hash) {
      doc.saved = { ...doc.saved, size: st.size, mtimeMs: st.mtimeMs };
      return;
    }
    await this.replaced(doc, bytes, st, "outside");
  }

  private async replaced(
    doc: Doc,
    bytes: Uint8Array,
    st: { size: number; mtimeMs: number },
    by: string,
  ): Promise<void> {
    const f = doc.family;
    let next: { model: unknown; format: unknown };
    try {
      next = f.load(bytes, doc.file.path);
    } catch {
      // Not a file this family edits anymore: the editor keeps what it had, unsaved.
      doc.saved = { ...doc.saved, size: st.size, mtimeMs: st.mtimeMs };
      return;
    }
    const op = f.diff(doc.model, next.model, MAX_DIFF);
    const inverse = op ? f.invert(doc.model, op) : undefined;
    const same =
      !op && JSON.stringify(f.snapshot(doc.model)) === JSON.stringify(f.snapshot(next.model));
    const summary = op
      ? f.summarize(doc.model, [op], "replaced")
      : ({ text: "changed from outside", kind: "replaced" } as DocSummary);
    const revision = doc.revision + 1;
    const hash = sha256(bytes);
    if (same) doc.format = next.format;
    else {
      const e = await this.o.store.append({
        ownerId: doc.ownerId,
        projectId: projectOf(doc.file),
        sessionId: docStreamId(doc.file),
        body: {
          type: "doc.replaced",
          payload: {
            file: doc.file,
            family: f.id,
            revision,
            ...(doc.saved.hash && { hashBefore: doc.saved.hash }),
            hashAfter: hash,
            by,
            summary,
            ...(op && inverse && { ops: [op], inverse: [inverse] }),
          },
        },
      });
      doc.revision = revision;
      doc.model = next.model;
      doc.format = next.format;
      if (op && inverse)
        this.remember(doc, {
          revision,
          ts: e.ts,
          author: by,
          groupId: `replaced:${revision}`,
          ops: [op],
          inverse: [inverse],
          summary,
          replaced: true,
          wrote: f.wrote([op]),
        });
      else {
        doc.history = [];
        doc.floor = revision;
      }
      const change: DocChange = {
        revision,
        ts: e.ts,
        author: by,
        groupId: `replaced:${revision}`,
        summary,
        replaced: true,
      };
      // Pages start again from the file as it is now.
      this.broadcast(doc, {
        type: "doc.replaced",
        file: doc.file,
        revision,
        snapshot: f.snapshot(doc.model),
        change,
      });
    }
    doc.saved = { revision: doc.revision, hash, size: st.size, mtimeMs: st.mtimeMs };
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    doc.saveTimer = undefined;
    await this.writeState(doc, bytes);
  }

  private scheduleSave(doc: Doc, delay = this.o.saveDelayMs ?? 2000) {
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    doc.saveTimer = setTimeout(() => {
      doc.saveTimer = undefined;
      void this.enqueue(doc, () => this.saveNow(doc)).catch((err: unknown) =>
        this.saveFailed(doc, err),
      );
    }, delay);
    doc.saveTimer.unref?.();
  }

  /** Writes the file if it is behind (a change from outside first wins). */
  private async saveNow(doc: Doc): Promise<void> {
    await this.checkDisk(doc);
    if (doc.saved.revision >= doc.revision) return;
    const f = doc.family;
    const ctx = {
      ownerId: doc.ownerId,
      file: doc.file,
      abs: doc.abs,
      blob: (hash: string) => this.blob(hash),
    };
    let bytes: Uint8Array;
    if (f.render) {
      // A family with an outside engine (G37.4) writes through it, and may say what it made.
      const r = await f.render(doc.model, doc.format, ctx);
      bytes = r.bytes;
      if (r.model !== undefined) doc.model = r.model;
    } else if (f.saveTo) {
      // A family that saves by itself (a sheet's «toppa»): the model as last saved and the
      // operations since then.
      const later = this.after(doc, doc.saved.revision) ?? [];
      bytes = await f.saveTo({
        ownerId: doc.ownerId,
        file: doc.file,
        abs: doc.abs,
        model: doc.model,
        format: doc.format,
        before: this.modelAt(doc, doc.saved.revision),
        ops: later.flatMap((r) => r.ops),
        bytes: await readFile(doc.abs),
      });
    } else bytes = f.save(doc.model, doc.format);
    await atomicWrite(doc.abs, bytes);
    const st = await stat(doc.abs);
    doc.saved = { revision: doc.revision, hash: sha256(bytes), size: st.size, mtimeMs: st.mtimeMs };
    await this.writeState(doc, bytes);
    if (f.saved) await f.saved(doc.model, ctx).catch(() => {});
    if (f.saveTo || f.render)
      this.broadcast(doc, { type: "doc.saved", file: doc.file, revision: doc.revision });
  }

  /** A save that failed: the pages are told why, and it is tried again in a while. */
  private saveFailed(doc: Doc, err: unknown) {
    const waits = err instanceof SaveWaits ? err.waitsFor : undefined;
    this.broadcast(doc, {
      type: "doc.saved",
      file: doc.file,
      revision: doc.saved.revision,
      error: String((err as Error)?.message ?? err).slice(0, 2000),
      ...(waits && { waitsFor: waits }),
    });
    if (!this.closed && this.docs.get(doc.key) === doc)
      this.scheduleSave(doc, waits ? 15_000 : 30_000);
  }

  private async writeState(doc: Doc, bytes: Uint8Array): Promise<void> {
    const dir = this.stateDir(doc.ownerId, doc.file);
    await mkdir(dir, { recursive: true });
    // The last save beside it: a change from outside is told as its difference from it.
    await atomicWrite(join(dir, "content"), bytes);
    const state: StateFile = {
      file: doc.file,
      family: doc.family.id,
      revision: doc.saved.revision,
      hash: doc.saved.hash || sha256(bytes),
      savedAt: new Date(this.now()).toISOString(),
    };
    await atomicWrite(
      join(dir, "state.json"),
      new TextEncoder().encode(JSON.stringify(state, null, 2)),
    );
  }

  /** Every file written now (shutdown, tests). */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.docs.values()].map((d) => {
        if (d.saveTimer) clearTimeout(d.saveTimer);
        d.saveTimer = undefined;
        return this.enqueue(d, () => this.saveNow(d)).catch((err: unknown) =>
          this.saveFailed(d, err),
        );
      }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await this.flush();
    for (const d of this.docs.values()) if (d.watchTimer) clearInterval(d.watchTimer);
    this.docs.clear();
  }

  /** Files nobody has open for a while leave memory (written first). */
  private async sweep(): Promise<void> {
    const old = this.now() - 10 * 60_000;
    for (const d of [...this.docs.values()])
      if (d.subs.size === 0 && d.usedAt < old) {
        await this.enqueue(d, () => this.saveNow(d)).catch(() => {});
        if (d.watchTimer) clearInterval(d.watchTimer);
        this.docs.delete(d.key);
      }
  }

  // ---- the agents ---------------------------------------------------------------------------

  /** A new turn of a conversation: its edits are one group. */
  turnStarted(sessionId: string): void {
    this.turns.set(sessionId, randomUUID());
  }

  groupOf(sessionId: string): string {
    let g = this.turns.get(sessionId);
    if (!g) {
      g = randomUUID();
      this.turns.set(sessionId, g);
    }
    return `turn:${g}`;
  }

  /** A conversation saw this revision of the file (it read it, or wrote it). */
  seen(sessionId: string, ownerId: string, file: DocFile, revision: number): void {
    let m = this.seenBy.get(sessionId);
    if (!m) {
      m = new Map();
      this.seenBy.set(sessionId, m);
    }
    m.set(`${ownerId}\u0000${docKey(file)}`, revision);
    this.pending.get(sessionId)?.delete(docKey(file));
  }

  lastSeen(sessionId: string, ownerId: string, file: DocFile): number | undefined {
    return this.seenBy.get(sessionId)?.get(`${ownerId}\u0000${docKey(file)}`);
  }

  /** The lines waiting for a conversation, taken (the next message or tool result carries them). */
  notesFor(sessionId: string): string[] {
    const m = this.pending.get(sessionId);
    if (!m?.size) return [];
    this.pending.delete(sessionId);
    return [...m.values()];
  }

  /** The head of a file and its model as an agent reads it. */
  async read(
    ownerId: string,
    file: DocFile,
  ): Promise<{
    revision: number;
    family: DocFamily;
    model: unknown;
    modelAt: (r: number) => unknown;
  }> {
    const doc = await this.open(ownerId, file);
    return this.enqueue(doc, async () => {
      await this.checkDisk(doc);
      const model = doc.model;
      return {
        revision: doc.revision,
        family: doc.family,
        model,
        modelAt: (r: number) => this.modelAt(doc, r),
      };
    });
  }

  /**
   * The file before and after a revision, an agent's turn (a group) or a proposal (G37.2): what
   * the page's difference view shows. A group spans from before its first revision to its last.
   */
  async diffOf(
    ownerId: string,
    file: DocFile,
    what: {
      revision?: number | undefined;
      groupId?: string | undefined;
      proposalId?: string | undefined;
    },
  ): Promise<{ before: DocSnapshot; after: DocSnapshot; from: number; to: number }> {
    const doc = await this.open(ownerId, file);
    return this.enqueue(doc, async () => {
      await this.checkDisk(doc);
      const f = doc.family;
      const at = (r: number): unknown => {
        const m = this.modelAt(doc, r);
        if (m === undefined) throw new Error(`Revision ${r} cannot be read back anymore`);
        return m;
      };
      if (what.proposalId) {
        const p = doc.proposals.get(what.proposalId);
        if (!p) throw new Error("That proposal is not open anymore");
        const base = at(p.baseRevision);
        let after = base;
        for (const op of p.ops) {
          const bad = f.check(after, op);
          if (bad) throw new Error(`The proposal cannot be read: ${bad}`);
          after = f.apply(after, op);
        }
        return {
          before: f.snapshot(base),
          after: f.snapshot(after),
          from: p.baseRevision,
          to: p.baseRevision,
        };
      }
      const revs = what.groupId
        ? doc.history.filter((r) => r.groupId === what.groupId).map((r) => r.revision)
        : what.revision !== undefined
          ? [what.revision]
          : [];
      if (revs.length === 0) throw new Error("Say which change: a revision, a group or a proposal");
      const from = Math.min(...revs);
      const to = Math.max(...revs);
      if (from < 1 || to > doc.revision) throw new Error(`Revision ${to} does not exist`);
      return { before: f.snapshot(at(from - 1)), after: f.snapshot(at(to)), from, to };
    });
  }

  /** The agents' rule on this file. */
  modeFor(ownerId: string, agentId: string, file: DocFile): AgentEditMode {
    return agentEditMode(this.o.settings(ownerId), agentId, file);
  }

  // ---- blobs ---------------------------------------------------------------------------------

  /** Big data of an operation (pixels, pictures) kept apart, cited by its hash. */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = sha256(bytes);
    const dir = join(this.o.dataDir, "editor", "blobs");
    await mkdir(dir, { recursive: true });
    const p = join(dir, hash);
    if (!(await stat(p).catch(() => undefined))) await atomicWrite(p, bytes);
    return hash;
  }

  async blob(hash: string): Promise<Uint8Array | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const b = await readFile(join(this.o.dataDir, "editor", "blobs", hash)).catch(() => undefined);
    return b && sha256(b) === hash ? b : undefined;
  }
}
