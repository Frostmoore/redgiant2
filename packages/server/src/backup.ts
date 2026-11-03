// Backup (2026-11-03): every project with its files, agents, conversations, chats and board,
// in one file to carry to another RedGiant, new or already in use. Importing adds to what is
// there: what is already the same (same id, same creation time) is left alone, a project whose
// name is taken gets a new one, and God and Demi-God stay the ones of this installation, with the
// name the person chooses. Keys and sign-ins are never in a backup: they belong to this computer.
//
// The file is gzip of: a first line "REDGIANT-BACKUP 1", then entries, each a JSON line
// {"name","size"} followed by exactly `size` bytes. Entries: "backup.json" (the rows),
// "events.jsonl" (the log, one event a line), "files/<project>/<path>" (the projects' files).

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { EventStore, SqlClient } from "@redgiant/events";
import type { BackupPreview, EventBody } from "@redgiant/protocol";
import type { JobHandle } from "./jobs.js";
import { slug } from "./projects.js";

const MAGIC = "REDGIANT-BACKUP 1";
/** Folders that are rebuilt from the project itself and only make a backup heavy. */
const SKIP_DIRS = new Set(["node_modules"]);
const EVENTS_PAGE = 1000;

type Row = Record<string, unknown>;

/** The rows of a backup: one array per table. */
export interface BackupData {
  format: 1;
  createdAt: string;
  /** Bytes of all the files, for the import's progress. */
  filesBytes: number;
  events: number;
  tables: Record<string, Row[]>;
}

export interface ImportChoices {
  /** The name God keeps (default: this installation's). */
  godName?: string;
  demigodName?: string;
}

export interface ImportResult {
  projects: { from: string; to: string; name: string }[];
  agents: number;
  conversations: number;
  events: number;
  files: number;
}

export interface BackupDeps {
  db: SqlClient;
  store: EventStore;
  workspacesDir: string;
}

/** The tables of the person's own rows, in the order they are put back (parents first). */
const OWNED = [
  "rg_projects",
  "rg_subprojects",
  "rg_agents",
  "rg_sessions",
  "rg_chats",
  "rg_threads",
];

// --- the file format ---

class Writer {
  private readonly gzip = createGzip();
  private readonly done: Promise<void>;

  constructor(file: string) {
    this.done = pipeline(this.gzip, createWriteStream(file));
    // Seen at `end`; not an unhandled rejection meanwhile.
    this.done.catch(() => {});
  }

  private async write(b: Buffer) {
    if (!this.gzip.write(b)) await once(this.gzip, "drain");
  }

  async start() {
    await this.write(Buffer.from(`${MAGIC}\n`));
  }

  async bytes(name: string, data: Buffer) {
    await this.write(Buffer.from(`${JSON.stringify({ name, size: data.length })}\n`));
    await this.write(data);
  }

  /** A file of `size` bytes (its size when it was looked at): a file that changed meanwhile is cut or padded. */
  async file(name: string, path: string, size: number, read: (n: number) => void) {
    await this.write(Buffer.from(`${JSON.stringify({ name, size })}\n`));
    let left = size;
    for await (const chunk of createReadStream(path, { end: Math.max(0, size - 1) })) {
      const b = (chunk as Buffer).subarray(0, left);
      await this.write(b);
      left -= b.length;
      read(b.length);
      if (left === 0) break;
    }
    if (left > 0 && size > 0) await this.write(Buffer.alloc(left));
  }

  async end() {
    this.gzip.end();
    await this.done;
  }
}

class Reader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private readonly it: AsyncIterator<Buffer>;

  constructor(file: string) {
    const gunzip = createGunzip();
    createReadStream(file)
      .on("error", (e) => gunzip.destroy(e))
      .pipe(gunzip);
    this.it = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  private async fill(n: number) {
    while (this.length < n && !this.ended) {
      const r = await this.it.next();
      if (r.done) this.ended = true;
      else {
        this.chunks.push(r.value);
        this.length += r.value.length;
      }
    }
  }

  /** Up to `n` bytes that are already in memory or come next. */
  private async some(n: number): Promise<Buffer> {
    await this.fill(1);
    if (this.length === 0) throw new BackupError("The backup file is cut short");
    const first = this.chunks[0] as Buffer;
    const b = first.subarray(0, n);
    if (b.length === first.length) this.chunks.shift();
    else this.chunks[0] = first.subarray(b.length);
    this.length -= b.length;
    return b;
  }

  async line(): Promise<string | null> {
    const parts: Buffer[] = [];
    for (;;) {
      await this.fill(1);
      if (this.length === 0) return parts.length ? Buffer.concat(parts).toString() : null;
      const first = this.chunks[0] as Buffer;
      const nl = first.indexOf(10);
      if (nl >= 0) {
        parts.push(await this.some(nl + 1));
        return Buffer.concat(parts).toString().slice(0, -1);
      }
      parts.push(await this.some(first.length));
    }
  }

  async *body(size: number): AsyncGenerator<Buffer> {
    let left = size;
    while (left > 0) {
      const b = await this.some(left);
      left -= b.length;
      yield b;
    }
  }

  async read(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const b of this.body(size)) parts.push(b);
    return Buffer.concat(parts);
  }

  async next(): Promise<{ name: string; size: number } | null> {
    const l = await this.line();
    if (l === null || l === "") return null;
    const h = JSON.parse(l) as { name?: unknown; size?: unknown };
    if (typeof h.name !== "string" || typeof h.size !== "number" || h.size < 0)
      throw new BackupError("The backup file is damaged");
    return { name: h.name, size: h.size };
  }

  async close() {
    await this.it.return?.();
  }
}

export class BackupError extends Error {}

async function open(file: string): Promise<{ r: Reader; data: BackupData }> {
  const r = new Reader(file);
  try {
    if ((await r.line()) !== MAGIC) throw new BackupError("This is not a RedGiant backup");
    const h = await r.next();
    if (h?.name !== "backup.json") throw new BackupError("The backup file is damaged");
    const data = JSON.parse((await r.read(h.size)).toString()) as BackupData;
    if (data.format !== 1) throw new BackupError("This backup comes from a newer RedGiant");
    return { r, data };
  } catch (err) {
    await r.close();
    if (err instanceof SyntaxError || (err as { code?: string }).code === "Z_DATA_ERROR")
      throw new BackupError("This is not a RedGiant backup");
    throw err;
  }
}

// --- export ---

const exists = async (db: SqlClient, table: string) =>
  (await db.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [table]))[0]?.t !=
  null;

/** The files of a folder, without the heavy rebuilt ones and without links. */
async function walk(
  root: string,
  dir = root,
): Promise<{ rel: string; path: string; size: number }[]> {
  const out: { rel: string; path: string; size: number }[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => undefined);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...(await walk(root, path)));
    } else if (st.isFile())
      out.push({ rel: relative(root, path).split(sep).join("/"), path, size: st.size });
  }
  return out;
}

export async function exportBackup(
  deps: BackupDeps,
  ownerId: string,
  file: string,
  h: JobHandle,
): Promise<void> {
  const { db } = deps;
  h.step("data");
  const tables: Record<string, Row[]> = {};
  for (const t of OWNED)
    if (await exists(db, t))
      tables[t] = await db.query<Row>(`SELECT * FROM ${t} WHERE owner_id = $1`, [ownerId]);
  const chats = (tables.rg_chats ?? []).map((c) => c.id as string);
  tables.rg_chat_messages = chats.length
    ? await db.query<Row>("SELECT * FROM rg_chat_messages WHERE chat_id = ANY($1) ORDER BY id", [
        chats,
      ])
    : [];
  tables.rg_posts = (await exists(db, "rg_posts"))
    ? await db.query<Row>("SELECT * FROM rg_posts WHERE owner_id = $1 ORDER BY created_at", [
        ownerId,
      ])
    : [];
  const keys = [
    ...(tables.rg_projects ?? []),
    ...(tables.rg_subprojects ?? []),
    ...(tables.rg_agents ?? []),
  ].map((r) => r.id as string);
  // Only the limits: what was spent belongs to this installation.
  tables.rg_budgets = keys.length
    ? await db.query<Row>(
        "SELECT scope, key, limit_usd, limit_tok FROM rg_budgets WHERE key = ANY($1)",
        [keys],
      )
    : [];
  const [{ n } = { n: 0 }] = await db.query<{ n: string | number }>(
    "SELECT count(*) AS n FROM rg_events WHERE owner_id = $1 AND NOT erased",
    [ownerId],
  );
  const files = (tables.rg_projects ?? []).map((p) => ({
    id: p.id as string,
    path: p.path as string,
  }));
  const listed = await Promise.all(files.map(async (p) => ({ ...p, files: await walk(p.path) })));
  const filesBytes = listed.reduce((s, p) => s + p.files.reduce((x, f) => x + f.size, 0), 0);
  const data: BackupData = {
    format: 1,
    createdAt: new Date().toISOString(),
    filesBytes,
    events: Number(n),
    tables,
  };

  await mkdir(dirname(file), { recursive: true });
  const w = new Writer(file);
  try {
    await w.start();
    await w.bytes("backup.json", Buffer.from(JSON.stringify(data)));
    // The log, a page at a time: it can be the biggest part.
    h.step("conversations");
    const lines: Buffer[] = [];
    let seq = -1;
    let done = 0;
    for (;;) {
      if (h.signal.aborted) throw new Error("Cancelled");
      const page = await db.query<Row>(
        "SELECT seq, id, ts, project_id, agent_id, session_id, type, payload FROM rg_events WHERE owner_id = $1 AND seq > $2 AND NOT erased ORDER BY seq LIMIT 1000",
        [ownerId, seq],
      );
      for (const e of page) {
        const { seq: _, ...rest } = e;
        lines.push(Buffer.from(`${JSON.stringify(rest)}\n`));
      }
      done += page.length;
      h.progress(done, data.events);
      if (page.length < EVENTS_PAGE) break;
      seq = Number(page.at(-1)?.seq);
    }
    await w.bytes("events.jsonl", Buffer.concat(lines));
    h.step("files");
    let read = 0;
    for (const p of listed)
      for (const f of p.files) {
        if (h.signal.aborted) throw new Error("Cancelled");
        await w.file(`files/${p.id}/${f.rel}`, f.path, f.size, (k) => {
          read += k;
          h.progress(read, filesBytes);
        });
      }
  } finally {
    await w.end();
  }
}

// --- import ---

export async function previewBackup(
  deps: Pick<BackupDeps, "db">,
  ownerId: string,
  file: string,
): Promise<BackupPreview> {
  const { r, data } = await open(file);
  await r.close();
  const t = data.tables;
  const here = await deps.db.query<{ kind: string; name: string }>(
    "SELECT kind, name FROM rg_agents WHERE owner_id = $1 AND kind IN ('god', 'demigod') AND status = 'active'",
    [ownerId],
  );
  const projects = await Promise.all(
    (t.rg_projects ?? []).map(async (p) => ({
      id: p.id as string,
      name: p.name as string,
      exists: !!(await sameProject(deps.db, ownerId, p)),
    })),
  );
  return {
    createdAt: data.createdAt,
    projects,
    agents: (t.rg_agents ?? []).filter((a) => a.status === "active").length,
    conversations: (t.rg_sessions ?? []).length,
    chats: (t.rg_chats ?? []).length,
    filesBytes: data.filesBytes,
    names: (["god", "demigod"] as const).flatMap((kind) => {
      const a = (t.rg_agents ?? []).find((x) => x.kind === kind && x.status === "active");
      return a
        ? [
            {
              kind,
              backup: a.name as string,
              here: here.find((x) => x.kind === kind)?.name ?? null,
            },
          ]
        : [];
    }),
  };
}

const time = (v: unknown) => (v ? new Date(v as string).getTime() : Number.NaN);

/**
 * This installation's project that is the backup's one: created at the same moment, under the
 * same id or one an earlier import gave it ("sito-2").
 */
async function sameProject(db: SqlClient, ownerId: string, p: Row) {
  const rows = await db.query<{ id: string; created_at: unknown }>(
    "SELECT id, created_at FROM rg_projects WHERE owner_id = $1 AND (id = $2 OR id LIKE $3)",
    [ownerId, p.id, `${p.id as string}-%`],
  );
  return rows.find((r) => time(r.created_at) === time(p.created_at));
}

interface Column {
  type: string;
  generated: boolean;
}

async function columnsOf(db: SqlClient, table: string): Promise<Map<string, Column>> {
  const rows = await db.query<{ column_name: string; data_type: string; is_generated: string }>(
    "SELECT column_name, data_type, is_generated FROM information_schema.columns WHERE table_name = $1",
    [table],
  );
  return new Map(
    rows.map((c) => [c.column_name, { type: c.data_type, generated: c.is_generated === "ALWAYS" }]),
  );
}

/** Ids keyed "...Id"/"...Ids" in an event's payload, moved to their new names. */
export function remapIds(v: unknown, ids: ReadonlyMap<string, string>, key = ""): unknown {
  if (ids.size === 0) return v;
  const isId = /(?:^id|Id|_id|Ids|_ids)$/.test(key);
  if (typeof v === "string") return isId ? (ids.get(v) ?? v) : v;
  if (Array.isArray(v)) return v.map((x) => remapIds(x, ids, isId ? key : ""));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapIds(x, ids, k)]));
  return v;
}

export async function importBackup(
  deps: BackupDeps,
  ownerId: string,
  file: string,
  choices: ImportChoices,
  h: JobHandle,
): Promise<ImportResult> {
  const { db, store } = deps;
  const { r, data } = await open(file);
  try {
    h.step("data");
    const t = data.tables;
    /** Ids that change here: projects whose name was taken, God and Demi-God, kept orchestrators. */
    const ids = new Map<string, string>();
    const to = (v: unknown) => (typeof v === "string" ? (ids.get(v) ?? v) : v);
    const cols = new Map<string, Map<string, Column>>();
    const insert = async (table: string, row: Row, omit: string[] = []) => {
      let c = cols.get(table);
      if (!c) {
        c = await columnsOf(db, table);
        cols.set(table, c);
      }
      const names = Object.keys(row).filter((k) => {
        const col = c.get(k);
        return col && !col.generated && !omit.includes(k);
      });
      const values = names.map((k) => {
        const v = row[k];
        return c.get(k)?.type === "jsonb" && v !== null && v !== undefined ? JSON.stringify(v) : v;
      });
      const got = await db.query(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
        values,
      );
      return got.length > 0;
    };
    const result: ImportResult = { projects: [], agents: 0, conversations: 0, events: 0, files: 0 };

    // Projects: the same one stays, a different one with a taken name gets the next free name.
    const newProjects = new Map<string, string>();
    for (const p of t.rg_projects ?? []) {
      const old = p.id as string;
      const same = await sameProject(db, ownerId, p);
      if (same) {
        if (same.id !== old) ids.set(old, same.id);
        continue;
      }
      let id = old;
      for (let n = 2; ; n++) {
        const [taken] = await db.query(
          "SELECT 1 FROM rg_projects WHERE owner_id = $1 AND id = $2",
          [ownerId, id],
        );
        if (!taken) break;
        id = `${old}-${n}`;
      }
      if (id !== old) ids.set(old, id);
      const path = join(deps.workspacesDir, slug(ownerId) || "owner", id);
      const name =
        id === old ? (p.name as string) : `${p.name as string} (${id.slice(old.length + 1)})`;
      await insert("rg_projects", { ...p, id, owner_id: ownerId, path, name });
      await mkdir(path, { recursive: true });
      newProjects.set(old, path);
      result.projects.push({ from: old, to: id, name });
    }
    for (const s of t.rg_subprojects ?? []) {
      const pid = to(s.project_id) as string;
      const id = (s.id as string).replace(/^.*?--/, `${pid}--`);
      if (id !== s.id) ids.set(s.id as string, id);
      await insert("rg_subprojects", { ...s, id, owner_id: ownerId, project_id: pid });
    }

    // Agents, parents first. God and Demi-God are this installation's ones, if there are.
    const here = await db.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM rg_agents WHERE owner_id = $1 AND kind IN ('god', 'demigod') AND status = 'active'",
      [ownerId],
    );
    const named = { god: choices.godName?.trim(), demigod: choices.demigodName?.trim() };
    let agents = [...(t.rg_agents ?? [])].sort((a, b) => time(a.created_at) - time(b.created_at));
    for (let round = 0; agents.length && round < 20; round++) {
      const later: Row[] = [];
      for (const a of agents) {
        const kind = a.kind as string;
        const mine = here.find((x) => x.kind === kind);
        const id = a.id as string;
        if ((kind === "god" || kind === "demigod") && a.status === "active" && mine) {
          if (mine.id !== id) ids.set(id, mine.id);
          continue;
        }
        const parent = to(a.parent_id) as string | null;
        if (parent) {
          const [p] = await db.query("SELECT 1 FROM rg_agents WHERE id = $1", [parent]);
          if (!p) {
            later.push(a);
            continue;
          }
        }
        const projects = a.projects
          ? JSON.stringify((JSON.parse(a.projects as string) as string[]).map((x) => to(x)))
          : a.projects;
        const row = {
          ...a,
          owner_id: ownerId,
          parent_id: parent,
          project_id: to(a.project_id),
          subproject_id: to(a.subproject_id),
          projects,
          ...((kind === "god" || kind === "demigod") && named[kind] && { name: named[kind] }),
        };
        if (await insert("rg_agents", row)) result.agents++;
        else {
          // One orchestrator (or inspector) a project: the one already there takes its place.
          const [same] = await db.query<{ id: string }>("SELECT id FROM rg_agents WHERE id = $1", [
            id,
          ]);
          if (!same) {
            const [other] = await db.query<{ id: string }>(
              "SELECT id FROM rg_agents WHERE owner_id = $1 AND kind = $2 AND project_id = $3 AND status = 'active' LIMIT 1",
              [ownerId, kind, row.project_id],
            );
            if (other) ids.set(id, other.id);
          }
        }
      }
      if (later.length === agents.length) break;
      agents = later;
    }
    for (const kind of ["god", "demigod"] as const) {
      const mine = here.find((x) => x.kind === kind);
      if (mine && named[kind])
        await db.query("UPDATE rg_agents SET name = $2 WHERE id = $1", [mine.id, named[kind]]);
    }

    for (const s of t.rg_sessions ?? [])
      if (
        await insert("rg_sessions", {
          ...s,
          owner_id: ownerId,
          agent_id: to(s.agent_id),
          project_id: to(s.project_id),
        })
      )
        result.conversations++;
    const newChats = new Set<string>();
    for (const c of t.rg_chats ?? [])
      if (await insert("rg_chats", { ...c, owner_id: ownerId, project_id: to(c.project_id) }))
        newChats.add(c.id as string);
    for (const m of t.rg_chat_messages ?? [])
      if (newChats.has(m.chat_id as string)) await insert("rg_chat_messages", m, ["id"]);
    const newThreads = new Set<string>();
    for (const th of t.rg_threads ?? [])
      if (
        await insert("rg_threads", {
          ...th,
          owner_id: ownerId,
          project_id: to(th.project_id),
          subproject_id: to(th.subproject_id),
          created_by: to(th.created_by),
        })
      )
        newThreads.add(th.id as string);
    for (const p of t.rg_posts ?? [])
      if (newThreads.has(p.thread_id as string))
        await insert("rg_posts", {
          ...p,
          owner_id: ownerId,
          project_id: to(p.project_id),
          author: to(p.author),
        });
    for (const b of t.rg_budgets ?? [])
      await insert("rg_budgets", { ...b, key: to(b.key), spent_usd: 0, spent_tok: 0 });

    // The log: events already here (same id) are skipped; the rest keep their id and time.
    h.step("conversations");
    let entry = await r.next();
    if (entry?.name === "events.jsonl") {
      let pending: Row[] = [];
      let seen = 0;
      const flush = async () => {
        const have = new Set(
          (
            await db.query<{ id: string }>("SELECT id FROM rg_events WHERE id = ANY($1)", [
              pending.map((e) => e.id),
            ])
          ).map((x) => x.id),
        );
        for (const e of pending) {
          if (have.has(e.id as string)) continue;
          const payload = e.payload === null ? null : JSON.parse(e.payload as string);
          await store.append({
            id: e.id as string,
            ts: e.ts as string,
            ownerId,
            projectId: to(e.project_id) as string | null,
            agentId: to(e.agent_id) as string | null,
            sessionId: e.session_id as string | null,
            body: { type: e.type, payload: remapIds(payload, ids) } as EventBody,
          });
          result.events++;
        }
        seen += pending.length;
        h.progress(seen, data.events);
        pending = [];
      };
      // Read line by line from the entry's bytes.
      let rest = "";
      for await (const chunk of r.body(entry.size)) {
        if (h.signal.aborted) throw new Error("Cancelled");
        const lines = (rest + chunk.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) {
          if (!l) continue;
          pending.push(JSON.parse(l) as Row);
          if (pending.length >= 500) await flush();
        }
      }
      if (rest) pending.push(JSON.parse(rest) as Row);
      await flush();
      entry = await r.next();
    }

    // The files, into the projects that are new here.
    h.step("files");
    let written = 0;
    for (; entry; entry = await r.next()) {
      if (h.signal.aborted) throw new Error("Cancelled");
      const m = /^files\/([^/]+)\/(.+)$/.exec(entry.name);
      const root = m ? newProjects.get(m[1] as string) : undefined;
      const target = root && m ? resolve(root, m[2] as string) : undefined;
      if (!root || !target?.startsWith(resolve(root) + sep)) {
        for await (const b of r.body(entry.size)) written += b.length;
        h.progress(written, data.filesBytes);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const out = createWriteStream(target);
      for await (const b of r.body(entry.size)) {
        if (!out.write(b)) await once(out, "drain");
        written += b.length;
        h.progress(written, data.filesBytes);
      }
      out.end();
      await once(out, "close");
      result.files++;
    }
    return result;
  } finally {
    await r.close();
  }
}

/** Removes a backup file (after it was downloaded or imported). */
export const removeBackup = (file: string) => rm(file, { force: true });
