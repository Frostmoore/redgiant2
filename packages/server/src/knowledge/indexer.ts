// The knowledge's queue (G36.2-G36.3): looks at the sources, reads what changed, cuts it into
// pieces, embeds the pieces and keeps the search graphs. Everything it has to do is in the
// database (documents `pending`, pieces without a vector in an index), so a restart carries on
// where it stopped. One unit of work at a time, with short pauses, and writes in batches
// (study 4.4: one row at a time is slow): it must never take the whole machine.

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { KnowledgeSource } from "@redgiant/protocol";
import { chunkDocument } from "./chunk.js";
import { EmbeddingError, vectorLiteral } from "./embedders.js";
import { extractFile, extractHtml, extractPdfData, extractText } from "./extract.js";
import { hashFile, listFiles } from "./files.js";
import { indexBuildSettings, indexBuildSql } from "./pgvector.js";
import { annIndex, HNSW_WITH, partialIndex, vecTable } from "./schema.js";
import { type IndexRow, type KnowledgeService, tsvSql } from "./service.js";
import type { Chunk, Extracted, ExtractOutcome } from "./types.js";
import { fetchPage } from "./web.js";

/** Below this many vectors an index needs no HNSW graph: exact search is fast and perfect. */
export const ANN_MIN = 20_000;
/** A collection this big inside a larger index gets a graph of its own (partial index). */
export const PARTIAL_MIN = 50_000;
/** Folder sources are looked at again this often even without a change notice. */
const RESCAN_MS = 15 * 60_000;
/** Documents read in one step. */
const READ_BATCH = 4;
/** Characters sent to an embedding model in one request, at most. */
const EMBED_CHARS = 60_000;

export interface Thresholds {
  annMin: number;
  partialMin: number;
}

interface OwnerState {
  paused: boolean;
  doing?: string | undefined;
  error?: string | undefined;
  /** No embedding until then (a failing API waits a while). */
  until?: number | undefined;
  failures: number;
  graph?: { index: number; table: string } | undefined;
}

/** A memory setting (`512MB`, `4GB`) kept under Postgres' ceiling (kB, 0 = unknown). */
export function capMemory(value: string, maxKb: number): string {
  const m = value.match(/^(\d+)(MB|GB)$/);
  if (!m || maxKb <= 0) return value;
  const kb = Number(m[1]) * (m[2] === "GB" ? 1024 * 1024 : 1024);
  return kb <= maxKb ? value : `${Math.floor(maxKb / 1024) - 1}MB`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Indexer {
  thresholds: Thresholds = { annMin: ANN_MIN, partialMin: PARTIAL_MIN };
  private readonly wanted = new Map<string, boolean>();
  private readonly owners = new Map<string, OwnerState>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  /** Last piece looked at for each index: pieces below it all have their vector. */
  private readonly cursors = new Map<number, number>();
  /** When each index's upkeep last ran (counts are not free on a million rows). */
  private readonly upkeepAt = new Map<number, number>();
  private readonly downloads = new Map<string, Promise<void>>();
  private loop: Promise<void> | undefined;
  private stopped = false;
  private wakeUp: (() => void) | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly abort = new AbortController();

  constructor(private readonly k: KnowledgeService) {}

  private owner(o: string): OwnerState {
    let s = this.owners.get(o);
    if (!s) {
      s = { paused: false, failures: 0 };
      this.owners.set(o, s);
    }
    return s;
  }

  state(owner: string) {
    const s = this.owner(owner);
    return {
      running: this.loop !== undefined && !this.stopped,
      paused: s.paused,
      ...(s.doing && { doing: s.doing }),
      ...(s.error && { error: s.error }),
      ...(s.graph && { graph: s.graph }),
    };
  }

  /** Every source looked at once (what changed while RedGiant was off), then watched. */
  start() {
    if (this.loop) return;
    this.stopped = false;
    void this.watchAll().catch(() => {});
    this.rescanTimer = setInterval(() => {
      void this.markAll(false);
    }, RESCAN_MS);
    this.rescanTimer.unref?.();
    this.loop = this.run();
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.wake();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.debounce.values()) clearTimeout(t);
    await this.loop?.catch(() => {});
    this.loop = undefined;
  }

  wake() {
    this.wakeUp?.();
  }

  pause(owner: string, paused: boolean) {
    this.owner(owner).paused = paused;
    if (!paused) this.wake();
  }

  /** The settings changed: a failing API gets another try now. */
  retry(owner: string) {
    const s = this.owner(owner);
    s.error = undefined;
    s.until = undefined;
    s.failures = 0;
    this.wake();
  }

  sourceAdded(owner: string, id: string) {
    this.owner(owner);
    this.wanted.set(id, true);
    void this.watchSource(id).catch(() => {});
    this.wake();
  }

  rescan(id: string, force: boolean) {
    this.wanted.set(id, force || (this.wanted.get(id) ?? false));
    this.wake();
  }

  forget(id: string) {
    this.wanted.delete(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }

  private async markAll(force: boolean) {
    const rows = await this.k.db.query<{ id: string }>("SELECT id FROM rg_kb_sources");
    for (const r of rows) this.wanted.set(r.id, force || (this.wanted.get(r.id) ?? false));
    this.wake();
  }

  private async watchAll() {
    await this.markAll(false);
    const rows = await this.k.db.query<{ id: string }>(
      "SELECT id FROM rg_kb_sources WHERE spec->>'kind' IN ('folder', 'workspace')",
    );
    for (const r of rows) await this.watchSource(r.id).catch(() => {});
  }

  /** Folder changes start a look (a few seconds after the last one); polling backs it up. */
  private async watchSource(id: string) {
    if (this.k.deps.manual || this.watchers.has(id)) return;
    const s = await this.sourceRow(id);
    if (!s || (s.spec.kind !== "folder" && s.spec.kind !== "workspace")) return;
    const root = await this.k.sourceRoot(s.owner_id, s.spec).catch(() => undefined);
    if (!root) return;
    try {
      const w = watch(root, { recursive: true, persistent: false }, () => {
        clearTimeout(this.debounce.get(id));
        this.debounce.set(
          id,
          setTimeout(() => this.rescan(id, false), 3000),
        );
      });
      w.on("error", () => {
        w.close();
        this.watchers.delete(id);
      });
      this.watchers.set(id, w);
    } catch {
      // Too many folders to watch (inotify) or no recursive watching: polling does it.
    }
  }

  private async run() {
    while (!this.stopped) {
      let did = false;
      try {
        did = await this.step();
      } catch (err) {
        console.warn(`knowledge: ${message(err)}`);
        await sleep(2000);
      }
      if (this.stopped) break;
      if (did) {
        // A breath between units of work: other requests, and a processor left to the person.
        await sleep(15);
        continue;
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 30_000);
        this.wakeUp = () => {
          clearTimeout(t);
          r();
        };
      });
      this.wakeUp = undefined;
    }
  }

  /** Runs until there is nothing left to do (tests; also used by «index now»). */
  async drain(maxSteps = 100_000): Promise<number> {
    let n = 0;
    while (n < maxSteps && (await this.step())) n++;
    return n;
  }

  /** One unit of work: a source looked at, a few documents read, a batch embedded, upkeep. */
  async step(): Promise<boolean> {
    const next = this.wanted.entries().next();
    if (!next.done) {
      const [id, force] = next.value;
      this.wanted.delete(id);
      await this.scan(id, force);
      return true;
    }
    if (await this.readSome()) return true;
    if (!this.k.vector.ok) return false;
    for (const owner of await this.k.owners()) {
      const s = this.owner(owner);
      if (s.paused) continue;
      if (await this.embedSome(owner)) return true;
      if (await this.upkeep(owner)) return true;
    }
    return false;
  }

  // ---- Looking at sources ----

  private async sourceRow(id: string) {
    const rows = await this.k.db.query<{
      id: string;
      spec: unknown;
      owner_id: string;
      num: number;
      language: string;
    }>(
      `SELECT s.id, s.spec, c.owner_id, c.num, c.language FROM rg_kb_sources s
         JOIN rg_kb_collections c ON c.id = s.collection_id WHERE s.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return undefined;
    const spec = (
      typeof r.spec === "string" ? JSON.parse(r.spec) : r.spec
    ) as KnowledgeSource["spec"];
    return { ...r, spec };
  }

  /**
   * What a source holds now against what is known: new files waiting to be read, changed ones
   * read again (size or time changed; `force`: all), moved ones renamed in place (same content:
   * pieces and vectors kept), gone ones removed.
   */
  async scan(id: string, force: boolean) {
    const s = await this.sourceRow(id);
    if (!s) return;
    const st = this.owner(s.owner_id);
    st.doing = "scan";
    const setState = (state: string, error: string | null) =>
      this.k.db.query(
        `UPDATE rg_kb_sources SET state = $2, error = $3,
                last_scan_at = CASE WHEN $2 = 'ready' THEN now() ELSE last_scan_at END WHERE id = $1`,
        [id, state, error],
      );
    let root: string;
    try {
      root = await this.k.sourceRoot(s.owner_id, s.spec);
    } catch (err) {
      await setState("failed", message(err));
      return;
    }
    await setState("scanning", null);
    const known = await this.k.db.query<{
      id: string;
      path: string;
      size: string;
      mtime_ms: number;
      hash: string | null;
    }>(
      "SELECT id::text AS id, path, size::text AS size, mtime_ms, hash FROM rg_kb_documents WHERE source_id = $1",
      [id],
    );
    const byPath = new Map(known.map((d) => [d.path, d]));
    const found: { rel: string; abs: string; size: number; mtimeMs: number }[] = [];
    try {
      if (s.spec.kind === "url") {
        found.push({ rel: s.spec.url, abs: s.spec.url, size: 0, mtimeMs: 0 });
      } else if (s.spec.kind === "file") {
        const f = await stat(root);
        found.push({ rel: basename(root), abs: root, size: f.size, mtimeMs: f.mtimeMs });
      } else {
        for await (const f of listFiles(root, {
          exclude: s.spec.exclude,
          gitignore: s.spec.gitignore,
          signal: this.abort.signal,
        }))
          found.push(f);
      }
    } catch (err) {
      await setState("failed", message(err));
      return;
    }
    const seen = new Set(found.map((f) => f.rel));
    const missing = known.filter((d) => !seen.has(d.path));
    const changed: string[] = [];
    const fresh: typeof found = [];
    for (const f of found) {
      const d = byPath.get(f.rel);
      if (!d) fresh.push(f);
      else if (force || Number(d.size) !== f.size || d.mtime_ms !== f.mtimeMs) changed.push(d.id);
    }
    // Moves: a new path with the content of a path that went.
    const gone = new Map<string, (typeof missing)[number][]>();
    for (const d of missing) {
      const list = gone.get(d.size) ?? [];
      list.push(d);
      gone.set(d.size, list);
    }
    const moved = new Set<string>();
    const added: typeof found = [];
    for (const f of fresh) {
      const candidates = (gone.get(String(f.size)) ?? []).filter((d) => d.hash && !moved.has(d.id));
      if (candidates.length && s.spec.kind !== "url") {
        const h = await hashFile(f.abs).catch(() => undefined);
        const same = candidates.find((d) => d.hash === h);
        if (same) {
          moved.add(same.id);
          await this.k.db.query(
            "UPDATE rg_kb_documents SET path = $2, mtime_ms = $3 WHERE id = $1::bigint",
            [same.id, f.rel, f.mtimeMs],
          );
          continue;
        }
      }
      added.push(f);
    }
    const removed = missing.filter((d) => !moved.has(d.id)).map((d) => d.id);
    if (removed.length) {
      await this.k.db.query("DELETE FROM rg_kb_chunks WHERE document_id = ANY($1::bigint[])", [
        removed,
      ]);
      await this.k.db.query("DELETE FROM rg_kb_documents WHERE id = ANY($1::bigint[])", [removed]);
    }
    if (changed.length)
      await this.k.db.query(
        "UPDATE rg_kb_documents SET state = 'pending' WHERE id = ANY($1::bigint[])",
        [changed],
      );
    for (let i = 0; i < added.length; i += 1000) {
      const part = added.slice(i, i + 1000);
      await this.k.db.query(
        `INSERT INTO rg_kb_documents (source_id, collection_num, path, title, size, mtime_ms)
         SELECT $1, $2, x.path, x.title, x.size, x.mtime
           FROM unnest($3::text[], $4::text[], $5::bigint[], $6::float8[]) AS x(path, title, size, mtime)
         ON CONFLICT (source_id, path) DO NOTHING`,
        [
          id,
          s.num,
          part.map((f) => f.rel),
          part.map((f) => (s.spec.kind === "url" ? f.rel : basename(f.rel))),
          part.map((f) => f.size),
          part.map((f) => f.mtimeMs),
        ],
      );
    }
    await setState("ready", null);
    st.doing = undefined;
  }

  // ---- Reading and cutting ----

  private async readSome(): Promise<boolean> {
    const paused = [...this.owners].filter(([, s]) => s.paused).map(([o]) => o);
    const docs = await this.k.db.query<{
      id: string;
      path: string;
      hash: string | null;
      chunks: number;
      source_id: string;
      spec: unknown;
      owner_id: string;
      num: number;
      language: string;
    }>(
      `SELECT d.id::text AS id, d.path, d.hash, d.chunks, d.source_id, s.spec, c.owner_id, c.num,
              c.language
         FROM rg_kb_documents d JOIN rg_kb_sources s ON s.id = d.source_id
         JOIN rg_kb_collections c ON c.num = d.collection_num
        WHERE d.state = 'pending' AND NOT (c.owner_id = ANY($1::text[]))
        ORDER BY d.id LIMIT $2`,
      [paused, READ_BATCH],
    );
    if (!docs.length) return false;
    for (const d of docs) {
      if (this.stopped) break;
      const spec = (
        typeof d.spec === "string" ? JSON.parse(d.spec) : d.spec
      ) as KnowledgeSource["spec"];
      this.owner(d.owner_id).doing = "read";
      await this.readOne(d, spec).catch(async (err) => {
        await this.k.db.query(
          "UPDATE rg_kb_documents SET state = 'failed', reason = $2 WHERE id = $1::bigint",
          [d.id, message(err).slice(0, 500)],
        );
      });
    }
    return true;
  }

  private async readOne(
    d: {
      id: string;
      path: string;
      hash: string | null;
      chunks: number;
      owner_id: string;
      num: number;
      language: string;
    },
    spec: KnowledgeSource["spec"],
  ) {
    const signal = this.abort.signal;
    let outcome: ExtractOutcome;
    let hash: string;
    let size = 0;
    let mtime = 0;
    if (spec.kind === "url") {
      const page = await fetchPage(spec.url, { signal });
      size = page.bytes.length;
      const { createHash } = await import("node:crypto");
      hash = createHash("sha256").update(page.bytes).digest("hex");
      if (hash === d.hash && d.chunks > 0) return this.unchanged(d.id, size, mtime);
      outcome =
        page.kind === "pdf"
          ? await extractPdfData(page.bytes, page.finalUrl, signal)
          : page.kind === "text"
            ? {
                ok: true,
                doc: extractText(
                  basename(new URL(page.finalUrl).pathname) || "page.txt",
                  page.html,
                ),
              }
            : { ok: true, doc: extractHtml(page.html, page.finalUrl) };
    } else {
      const root = await this.k.sourceRoot(d.owner_id, spec);
      const abs = spec.kind === "file" ? root : join(root, ...d.path.split("/"));
      const st = await stat(abs).catch(() => undefined);
      if (!st?.isFile()) {
        // Gone since the look: the next look removes it.
        await this.k.db.query(
          "UPDATE rg_kb_documents SET state = 'indexed' WHERE id = $1::bigint",
          [d.id],
        );
        return;
      }
      size = st.size;
      mtime = st.mtimeMs;
      hash = await hashFile(abs);
      if (hash === d.hash && d.chunks > 0) return this.unchanged(d.id, size, mtime);
      outcome = await extractFile(abs, {
        signal,
        ...(this.k.deps.officePdf && {
          officePdf: (a: string, sig?: AbortSignal) =>
            this.k.deps.officePdf?.(d.owner_id, a, sig) ?? Promise.resolve(undefined),
        }),
      });
    }
    if (!outcome.ok) {
      await this.k.db.query("DELETE FROM rg_kb_chunks WHERE document_id = $1::bigint", [d.id]);
      await this.k.db.query(
        `UPDATE rg_kb_documents SET state = 'skipped', reason = $2, hash = $3, size = $4,
                mtime_ms = $5, chunks = 0, indexed_at = now() WHERE id = $1::bigint`,
        [d.id, outcome.skipped, hash, size, mtime],
      );
      return;
    }
    const chunks = chunkDocument(outcome.doc);
    await this.replaceChunks(d, outcome.doc, chunks, { hash, size, mtime });
  }

  private async unchanged(id: string, size: number, mtime: number) {
    await this.k.db.query(
      "UPDATE rg_kb_documents SET state = 'indexed', size = $2, mtime_ms = $3 WHERE id = $1::bigint",
      [id, size, mtime],
    );
  }

  /**
   * The document's new pieces in one transaction: inserted together (one statement), the vectors
   * of pieces whose text did not change copied over in every index (no model asked again), then
   * the old pieces removed.
   */
  async replaceChunks(
    d: { id: string; path: string; num: number; language: string },
    doc: Extracted,
    chunks: Chunk[],
    file: { hash: string; size: number; mtime: number },
  ) {
    const indexes = (
      await this.k.db.query<{ id: number }>(
        "SELECT id FROM rg_kb_indexes WHERE state IN ('building', 'ready')",
      )
    ).map((r) => r.id);
    const config = `'${d.language.replace(/[^a-z_]/g, "")}'`;
    await this.k.db.transaction(async (tx) => {
      const old = (
        await tx.query<{ id: string }>(
          "SELECT id::text AS id FROM rg_kb_chunks WHERE document_id = $1::bigint",
          [d.id],
        )
      ).map((r) => r.id);
      const made = chunks.length
        ? await tx.query<{ id: string; hash: string }>(
            `INSERT INTO rg_kb_chunks
               (document_id, collection_num, ord, body, heading, page, line_start, line_end, hash, tsv)
             SELECT $1::bigint, $2, x.ord, x.body, x.heading, x.page, x.ls, x.le, x.hash,
                    ${tsvSql(config, "$3::text", "$4::text", "x.heading", "x.body")}
               FROM unnest($5::int[], $6::text[], $7::text[], $8::int[], $9::int[], $10::int[], $11::text[])
                    AS x(ord, body, heading, page, ls, le, hash)
             RETURNING id::text AS id, hash`,
            [
              d.id,
              d.num,
              doc.title,
              d.path,
              chunks.map((c) => c.ord),
              chunks.map((c) => c.text),
              chunks.map((c) => c.heading ?? null),
              chunks.map((c) => c.page ?? null),
              chunks.map((c) => c.lineStart ?? null),
              chunks.map((c) => c.lineEnd ?? null),
              chunks.map((c) => c.hash),
            ],
          )
        : [];
      if (old.length && made.length)
        for (const i of indexes) {
          const t = vecTable(i);
          await tx
            .query(
              `INSERT INTO ${t} (chunk_id, collection_num, embedding)
               SELECT n.id, $3, v.embedding
                 FROM unnest($1::bigint[], $2::text[]) AS n(id, hash)
                 JOIN rg_kb_chunks o ON o.hash = n.hash AND o.id = ANY($4::bigint[])
                 JOIN ${t} v ON v.chunk_id = o.id
               ON CONFLICT (chunk_id) DO NOTHING`,
              [made.map((m) => m.id), made.map((m) => m.hash), d.num, old],
            )
            .catch(() => {});
        }
      if (old.length)
        await tx.query("DELETE FROM rg_kb_chunks WHERE id = ANY($1::bigint[])", [old]);
      await tx.query(
        `UPDATE rg_kb_documents SET state = 'indexed', reason = NULL, kind = $2, title = $3,
                pages = $4, chunks = $5, hash = $6, size = $7, mtime_ms = $8, note = $9,
                indexed_at = now() WHERE id = $1::bigint`,
        [
          d.id,
          doc.kind,
          doc.title,
          doc.pages ?? null,
          chunks.length,
          file.hash,
          file.size,
          file.mtime,
          doc.note ?? null,
        ],
      );
    });
  }

  // ---- Embedding ----

  /** What a piece is embedded as: where it is, then its text (the place carries meaning). */
  static embedText(r: {
    path: string;
    title: string;
    heading: string | null;
    body: string;
    kind: string | null;
  }) {
    const where =
      r.kind === "web"
        ? r.title
        : r.title && r.title !== basename(r.path)
          ? `${r.title} (${r.path})`
          : r.path;
    return `${where}${r.heading ? ` › ${r.heading}` : ""}\n\n${r.body}`;
  }

  private async embedSome(owner: string): Promise<boolean> {
    const s = this.owner(owner);
    if (s.until && Date.now() < s.until) return false;
    const indexes = (await this.k.indexes(owner))
      .filter((i) => i.state === "building" || i.state === "ready")
      .sort((a, b) => Number(b.active) - Number(a.active));
    for (const idx of indexes) {
      if (idx.choice.provider === "local") {
        const gpu = idx.choice.gpu ?? false;
        if (!(await this.k.deps.local.ready("embed", idx.choice.model, gpu))) {
          this.download(owner, idx);
          continue;
        }
      }
      const cursor = this.cursors.get(idx.id) ?? 0;
      const rows = await this.k.db.query<{
        id: string;
        num: number;
        body: string;
        heading: string | null;
        title: string;
        path: string;
        kind: string | null;
      }>(
        `SELECT ch.id::text AS id, ch.collection_num AS num, ch.body, ch.heading, d.title, d.path, d.kind
           FROM rg_kb_chunks ch
           JOIN rg_kb_documents d ON d.id = ch.document_id
           JOIN rg_kb_collections c ON c.num = ch.collection_num
          WHERE c.owner_id = $1 AND ch.id > $2::bigint
            AND NOT EXISTS (SELECT 1 FROM ${vecTable(idx.id)} v WHERE v.chunk_id = ch.id)
          ORDER BY ch.id LIMIT 256`,
        [owner, cursor],
      );
      if (!rows.length) {
        const top = await this.k.db.query<{ m: string | null }>(
          "SELECT max(id)::text AS m FROM rg_kb_chunks",
        );
        this.cursors.set(idx.id, Number(top[0]?.m ?? 0));
        continue;
      }
      let embedder: Awaited<ReturnType<KnowledgeService["embedderFor"]>>;
      try {
        embedder = await this.k.embedderFor(owner, idx);
      } catch (err) {
        this.fail(owner, idx, err);
        return false;
      }
      const batch: typeof rows = [];
      let chars = 0;
      for (const r of rows) {
        const text = Indexer.embedText(r);
        if (batch.length >= embedder.batch || (batch.length && chars + text.length > EMBED_CHARS))
          break;
        batch.push(r);
        chars += Math.min(text.length, embedder.maxChars);
      }
      s.doing = `embed:${idx.id}`;
      let vectors: number[][];
      try {
        vectors = await embedder.embed(batch.map(Indexer.embedText), "document", this.abort.signal);
        if (idx.choice.provider === "local") this.k.deps.local.touch("embed");
      } catch (err) {
        if (this.stopped) return false;
        this.fail(owner, idx, err);
        return false;
      }
      s.failures = 0;
      s.error = undefined;
      await this.k.db.query(
        `INSERT INTO ${vecTable(idx.id)} (chunk_id, collection_num, embedding)
         SELECT x.id, x.num, x.e::halfvec
           FROM unnest($1::bigint[], $2::int[], $3::text[]) AS x(id, num, e)
           JOIN rg_kb_chunks ch ON ch.id = x.id
         ON CONFLICT (chunk_id) DO NOTHING`,
        [batch.map((r) => r.id), batch.map((r) => r.num), vectors.map(vectorLiteral)],
      );
      this.cursors.set(idx.id, Number(batch.at(-1)?.id ?? cursor));
      s.doing = undefined;
      return true;
    }
    return false;
  }

  /** A local model not here yet: downloaded in the background (its bar is a job). */
  private download(owner: string, idx: IndexRow) {
    const key = `${owner}:${idx.choice.model}:${idx.choice.gpu ?? false}`;
    if (this.downloads.has(key)) return;
    const s = this.owner(owner);
    s.doing = "download";
    const p = this.k.deps.local
      .ensure(owner, "embed", idx.choice.model, idx.choice.gpu ?? false)
      .then(
        () => {
          s.doing = undefined;
          this.wake();
        },
        (err) => this.fail(owner, idx, err),
      )
      .finally(() => this.downloads.delete(key));
    this.downloads.set(key, p);
  }

  /**
   * A failing model: a wrong key or a refused request waits for the person (the page says why);
   * a busy or unreachable API is tried again later, longer each time (30 s to 10 minutes).
   */
  private fail(owner: string, idx: IndexRow, err: unknown) {
    const s = this.owner(owner);
    s.error = message(err).slice(0, 500);
    s.doing = undefined;
    const status = err instanceof EmbeddingError ? err.status : undefined;
    const hard =
      (err instanceof EmbeddingError && (err.code === "key_missing" || err.code === "dims")) ||
      status === 400 ||
      status === 401 ||
      status === 403 ||
      status === 404;
    s.failures++;
    s.until =
      Date.now() + (hard ? 60 * 60_000 : Math.min(10 * 60_000, 30_000 * 2 ** (s.failures - 1)));
    if (hard)
      void this.k.db
        .query("UPDATE rg_kb_indexes SET error = $2 WHERE id = $1", [idx.id, s.error])
        .catch(() => {});
  }

  // ---- Upkeep: graphs and swaps ----

  private async upkeep(owner: string): Promise<boolean> {
    for (const idx of await this.k.indexes(owner)) {
      if (idx.state !== "building" && idx.state !== "ready") continue;
      const last = this.upkeepAt.get(idx.id) ?? 0;
      if (Date.now() - last < (this.k.deps.manual ? 0 : 30_000)) continue;
      this.upkeepAt.set(idx.id, Date.now());
      const counts = await this.k.db.query<{ total: string; embedded: string; pending: string }>(
        `SELECT
           (SELECT count(*) FROM rg_kb_chunks ch JOIN rg_kb_collections c ON c.num = ch.collection_num
             WHERE c.owner_id = $1)::text AS total,
           (SELECT count(*) FROM ${vecTable(idx.id)})::text AS embedded,
           (SELECT count(*) FROM rg_kb_documents d JOIN rg_kb_collections c ON c.num = d.collection_num
             WHERE c.owner_id = $1 AND d.state = 'pending')::text AS pending`,
        [owner],
      );
      const total = Number(counts[0]?.total ?? 0);
      const embedded = Number(counts[0]?.embedded ?? 0);
      const complete = embedded >= total && Number(counts[0]?.pending ?? 0) === 0;
      // The graph is built once the first fill is done (study 4.4: load, then build), or as soon
      // as an index grows past four times the threshold while still filling.
      if (
        !idx.ann &&
        embedded >= this.thresholds.annMin &&
        (complete || embedded >= 4 * this.thresholds.annMin)
      ) {
        await this.buildGraph(owner, idx, annIndex(idx.id), "");
        await this.k.db.query("UPDATE rg_kb_indexes SET ann = true WHERE id = $1", [idx.id]);
        return true;
      }
      if (idx.ann && (await this.partials(owner, idx, embedded))) return true;
      if (!complete) continue;
      if (idx.active && idx.state === "building") {
        await this.k.db.query(
          "UPDATE rg_kb_indexes SET state = 'ready', ready_at = now(), error = NULL WHERE id = $1",
          [idx.id],
        );
        await this.k.record(owner, {
          action: "index.ready",
          indexId: idx.id,
          detail: { pieces: embedded },
        });
        return true;
      }
      if (!idx.active) {
        await this.swap(owner, idx, embedded);
        return true;
      }
    }
    return false;
  }

  /** Big collections get a graph of their own (study 4.2: recall 1.0 and 2 ms on a 5% scope). */
  private async partials(owner: string, idx: IndexRow, embedded: number): Promise<boolean> {
    const rows = await this.k.db.query<{ num: number; n: string }>(
      `SELECT v.collection_num AS num, count(*)::text AS n FROM ${vecTable(idx.id)} v
         GROUP BY v.collection_num HAVING count(*) >= $1`,
      [this.thresholds.partialMin],
    );
    for (const r of rows) {
      const n = Number(r.n);
      if (idx.partials.includes(r.num) || n > 0.7 * embedded) continue;
      await this.buildGraph(
        owner,
        idx,
        partialIndex(idx.id, r.num),
        `WHERE collection_num = ${Math.trunc(r.num)}`,
      );
      await this.k.db.query(
        "UPDATE rg_kb_indexes SET partials = array_append(partials, $2) WHERE id = $1",
        [idx.id, r.num],
      );
      return true;
    }
    return false;
  }

  /**
   * An HNSW graph with memory and workers sized for this machine; a parallel build that runs out
   * of shared memory (Docker's /dev/shm) is done again by one worker.
   */
  private async buildGraph(owner: string, idx: IndexRow, name: string, where: string) {
    const s = this.owner(owner);
    s.doing = "graph";
    s.graph = { index: idx.id, table: vecTable(idx.id) };
    const sql = `CREATE INDEX IF NOT EXISTS ${name} ON ${vecTable(idx.id)}
                 USING hnsw (embedding halfvec_cosine_ops) ${HNSW_WITH} ${where}`;
    const wanted = indexBuildSettings();
    // The ceiling is 2 GB where `long` has 32 bits (Windows builds, PGlite): ask Postgres.
    const max = await this.k.db
      .query<{ max_val: string }>(
        "SELECT max_val FROM pg_settings WHERE name = 'maintenance_work_mem'",
      )
      .then((r) => Number(r[0]?.max_val) || 0)
      .catch(() => 0);
    const settings = { ...wanted, maintenanceWorkMem: capMemory(wanted.maintenanceWorkMem, max) };
    const build = (workers: number) =>
      this.k.db.transaction(async (tx) => {
        for (const q of indexBuildSql({ ...settings, workers })) await tx.query(q);
        await tx.query(sql);
      });
    try {
      // Fresh statistics first: after a bulk fill the planner would guess (and skip the graph).
      await this.k.db.query(`ANALYZE ${vecTable(idx.id)}`);
      await build(settings.workers);
    } catch (err) {
      if (
        settings.workers > 0 &&
        /shared memory|could not resize|No space left/i.test(message(err))
      )
        await build(0);
      else throw err;
    } finally {
      s.doing = undefined;
      s.graph = undefined;
    }
  }

  /** The new index is complete: it takes the old one's place in one transaction. */
  private async swap(owner: string, idx: IndexRow, embedded: number) {
    const old = (await this.k.indexes(owner)).find((i) => i.active);
    await this.k.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE rg_kb_indexes SET active = false, state = 'retired' WHERE owner_id = $1 AND active",
        [owner],
      );
      await tx.query(
        "UPDATE rg_kb_indexes SET active = true, state = 'ready', ready_at = now(), error = NULL WHERE id = $1",
        [idx.id],
      );
    });
    await this.k.record(owner, {
      action: "index.ready",
      indexId: idx.id,
      detail: { pieces: embedded, replaces: old?.id ?? 0 },
    });
    if (old) {
      await this.k.db.query(`DROP TABLE IF EXISTS ${vecTable(old.id)}`).catch(() => {});
      await this.k.record(owner, {
        action: "index.retired",
        indexId: old.id,
        detail: { why: "replaced" },
      });
    }
  }
}
