// The knowledge (G36): collections of sources, indexed in the background and searched by meaning
// and by words. This is the part the rest of the server talks to (routes, the core, and the
// `search_knowledge` tool of G36.5); the queue lives in indexer.ts, the search in search.ts.
//
// What is kept where: collections, sources, documents and pieces (text, place, words) in shared
// tables; vectors in one table per index (schema.ts). The person chooses the model; changing it
// makes a new index filled in the background while the old one keeps answering, then swaps
// (`index.ready` / `index.retired` in the event log). Vectors are derived data: never in the log.

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { EventStore, SqlClient } from "@redgiant/events";
import {
  CLOUD_EMBEDDING_MODELS,
  type EmbeddingChoice,
  EmbeddingChoice as EmbeddingChoiceSchema,
  type KnowledgeCitation,
  type KnowledgeCollection,
  KnowledgeCollectionInput,
  type KnowledgeDocument,
  type KnowledgeIndexInfo,
  type KnowledgeScope,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSettings,
  type KnowledgeSource,
  KnowledgeSourceInput,
  type KnowledgeStatus,
  RerankChoice,
  TEXT_SEARCH_CONFIG_NAMES,
  textSearchConfig,
} from "@redgiant/protocol";
import type { Jobs } from "../jobs.js";
import {
  type Embedder,
  EmbeddingError,
  type KeyedFetch,
  localModel,
  makeEmbedder,
  makeReranker,
  type Reranker,
} from "./embedders.js";
import { Indexer } from "./indexer.js";
import type { LocalEmbedServers } from "./local-embed.js";
import { createVectorTable, migrateKnowledge, type VectorState, vecTable } from "./schema.js";
import { searchKnowledge } from "./search.js";

export class KnowledgeError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "bad_source"
      | "bad_choice"
      | "no_vector"
      | "embedding_failed"
      | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeError";
  }
}

/** Who asks a search: the person (every collection) or an agent (its scope). */
export type KnowledgeAsker =
  | { kind: "human" }
  | { kind: "agent"; agentId: string; projectIds: string[] };

export interface KnowledgeDeps {
  db: SqlClient;
  store: EventStore;
  jobs: Jobs;
  /** Where downloads and the database live: never indexed. */
  dataDir: string;
  /** Folders a source may never be (the keychain, the database), besides `dataDir`. */
  forbidden?: string[];
  local: LocalEmbedServers;
  /**
   * A request with a key put on: the keychain entry `credential`, or the setup's key of the
   * provider. Throws `EmbeddingError("key_missing")` when there is none.
   */
  keyedFetch: (owner: string, provider: string, credential?: string) => KeyedFetch;
  /** The folder behind a workspace scope (`project:<id>`, `assistants`, `platform`). */
  scopeRoot: (owner: string, scope: string) => Promise<string>;
  /** The agents' language (BCP-47), for a collection's words. */
  agentLanguage?: () => string | undefined;
  /** The PDF of an Office file made by LibreOffice when it is on this computer. */
  officePdf?: (owner: string, abs: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Tests: no folder watching, no timers. */
  manual?: boolean;
  /** Pieces in a scope searched exactly (default `EXACT_MAX`, 20 000; tests lower it). */
  exactMax?: number;
  now?: () => Date;
}

export interface IndexRow {
  id: number;
  owner_id: string;
  provider: string;
  model: string;
  dims: number;
  choice: EmbeddingChoice;
  state: KnowledgeIndexInfo["state"];
  active: boolean;
  ann: boolean;
  partials: number[];
  error: string | null;
  created_at: string;
  ready_at: string | null;
}

interface CollectionRow {
  id: string;
  num: number;
  owner_id: string;
  name: string;
  scope_kind: KnowledgeScope["kind"];
  scope_id: string | null;
  language: string;
  description: string | null;
  created_at: string;
}

const DEFAULT_SETTINGS: KnowledgeSettings = { embedding: null, rerank: null, threads: 0 };

const parseJson = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

function scopeOfRow(r: CollectionRow): KnowledgeScope {
  if (r.scope_kind === "agent") return { kind: "agent", agentId: r.scope_id ?? "" };
  if (r.scope_kind === "project") return { kind: "project", projectId: r.scope_id ?? "" };
  return { kind: "all" };
}

/** Same model, same size, same place: an index made for one choice answers for the other. */
export function sameIndex(a: EmbeddingChoice, b: EmbeddingChoice, dimsA: number, dimsB: number) {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    dimsA === dimsB &&
    (a.baseUrl ?? "") === (b.baseUrl ?? "")
  );
}

/** The dimensions an index gets for a choice, when they are known without asking the API. */
export function knownDims(c: EmbeddingChoice): number | undefined {
  if (c.dims) return c.dims;
  if (c.provider === "local") return localModel(c.model)?.defaultDims;
  const m = CLOUD_EMBEDDING_MODELS.find((x) => x.provider === c.provider && x.model === c.model);
  return m ? Math.min(m.dims, 4000) : undefined;
}

export class KnowledgeService {
  vector: VectorState = { ok: false, reason: "not started" };
  readonly indexer: Indexer;
  private readonly embedders = new Map<string, Embedder>();

  constructor(readonly deps: KnowledgeDeps) {
    this.indexer = new Indexer(this);
  }

  get db() {
    return this.deps.db;
  }

  now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Tables and pgvector; then the queue starts (unless `manual`). */
  async start(): Promise<void> {
    this.vector = await migrateKnowledge(this.db);
    if (!this.deps.manual) this.indexer.start();
  }

  /** pgvector arrived after the start (a download): turns it on and carries on. */
  async vectorArrived(): Promise<VectorState> {
    this.vector = await migrateKnowledge(this.db);
    this.indexer.wake();
    return this.vector;
  }

  async stop(): Promise<void> {
    await this.indexer.stop();
    this.deps.local.stop();
  }

  async record(
    owner: string,
    payload: {
      action:
        | "collection.created"
        | "collection.changed"
        | "collection.removed"
        | "source.added"
        | "source.removed"
        | "index.started"
        | "index.ready"
        | "index.failed"
        | "index.retired"
        | "settings.changed";
      collectionId?: string;
      sourceId?: string;
      indexId?: number;
      detail?: Record<string, string | number | boolean>;
      by?: string;
    },
  ): Promise<void> {
    await this.deps.store.append({
      ownerId: owner,
      body: { type: "knowledge.changed", payload: { ...payload, by: payload.by ?? "human" } },
    });
  }

  // ---- Settings and indexes ----

  async settings(owner: string): Promise<KnowledgeSettings> {
    const rows = await this.db.query<{ value: unknown }>(
      "SELECT value FROM rg_kb_settings WHERE owner_id = $1",
      [owner],
    );
    return { ...DEFAULT_SETTINGS, ...(rows[0] ? parseJson<KnowledgeSettings>(rows[0].value) : {}) };
  }

  private async saveSettings(owner: string, s: KnowledgeSettings) {
    await this.db.query(
      `INSERT INTO rg_kb_settings (owner_id, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (owner_id) DO UPDATE SET value = EXCLUDED.value`,
      [owner, JSON.stringify(s)],
    );
  }

  async indexes(owner: string): Promise<IndexRow[]> {
    const rows = await this.db.query<IndexRow>(
      `SELECT id, owner_id, provider, model, dims, choice, state, active, ann, partials, error,
              to_json(created_at) #>> '{}' AS created_at, to_json(ready_at) #>> '{}' AS ready_at
         FROM rg_kb_indexes WHERE owner_id = $1 AND state <> 'retired' ORDER BY id`,
      [owner],
    );
    return rows.map((r) => ({ ...r, choice: parseJson<EmbeddingChoice>(r.choice) }));
  }

  /** Owners with an index that is not retired (the queue's round). */
  async owners(): Promise<string[]> {
    const rows = await this.db.query<{ owner_id: string }>(
      `SELECT DISTINCT owner_id FROM rg_kb_collections
       UNION SELECT DISTINCT owner_id FROM rg_kb_indexes WHERE state IN ('building', 'ready')`,
    );
    return rows.map((r) => r.owner_id);
  }

  /** The embedder of an index (the local model downloaded first, as a job with its bar). */
  async embedderFor(owner: string, index: IndexRow): Promise<Embedder> {
    const key = `${owner}:${index.id}`;
    const have = this.embedders.get(key);
    if (have) return have;
    const c = index.choice;
    if (c.provider === "local") {
      await this.deps.local.ensure(owner, "embed", c.model, c.gpu ?? false);
      this.deps.local.threads = (await this.settings(owner)).threads;
    }
    const e = makeEmbedder({
      choice: c,
      dims: index.dims,
      fetch:
        c.provider === "local" ? localFetch : this.deps.keyedFetch(owner, c.provider, c.credential),
      localUrl: () => this.deps.local.url("embed", c.model, c.gpu ?? false),
    });
    this.embedders.set(key, e);
    return e;
  }

  async rerankerFor(owner: string): Promise<Reranker | undefined> {
    const c = (await this.settings(owner)).rerank;
    if (!c) return undefined;
    if (c.provider === "local")
      await this.deps.local.ensure(owner, "rerank", c.model, c.gpu ?? false);
    return makeReranker(
      c,
      c.provider === "local" ? localFetch : this.deps.keyedFetch(owner, c.provider, c.credential),
      () => this.deps.local.url("rerank", c.model, c.gpu ?? false),
    );
  }

  /**
   * The person's choice of models. A new embedding model (or size) starts a new index filled in
   * the background; the active one answers until it is complete. The cloud APIs are tried once
   * first (a wrong key is said now, not in an hour).
   */
  async setSettings(
    owner: string,
    raw: { embedding?: unknown; rerank?: unknown; threads?: unknown },
    signal?: AbortSignal,
  ): Promise<KnowledgeSettings> {
    const before = await this.settings(owner);
    const next: KnowledgeSettings = { ...before };
    if (raw.threads !== undefined) {
      const t = Number(raw.threads);
      if (!Number.isInteger(t) || t < 0 || t > 256)
        throw new KnowledgeError("bad_choice", "threads: a whole number from 0 to 256");
      next.threads = t;
      this.deps.local.threads = t;
    }
    if (raw.rerank !== undefined)
      next.rerank = raw.rerank === null ? null : RerankChoice.parse(raw.rerank);
    if (raw.embedding !== undefined) {
      const choice = raw.embedding === null ? null : EmbeddingChoiceSchema.parse(raw.embedding);
      next.embedding = choice;
      if (choice) await this.useModel(owner, choice, signal);
    }
    await this.saveSettings(owner, next);
    await this.record(owner, {
      action: "settings.changed",
      detail: {
        embedding: next.embedding ? `${next.embedding.provider}/${next.embedding.model}` : "none",
        rerank: next.rerank ? `${next.rerank.provider}/${next.rerank.model}` : "none",
        threads: next.threads,
      },
    });
    this.indexer.retry(owner);
    return next;
  }

  private async useModel(owner: string, choice: EmbeddingChoice, signal?: AbortSignal) {
    if (!this.vector.ok)
      throw new KnowledgeError("no_vector", `pgvector is not available: ${this.vector.reason}`);
    if (choice.provider === "local" && !localModel(choice.model))
      throw new KnowledgeError("bad_choice", `Unknown local model "${choice.model}"`);
    if (choice.provider === "compatible" && !choice.baseUrl)
      throw new KnowledgeError("bad_choice", "A compatible server needs its address");
    let dims = knownDims(choice);
    if (choice.provider !== "local") {
      // One short request: checks the key and learns the size the API really gives (an
      // embedder of 0 dimensions returns the whole vector).
      const probe = makeEmbedder({
        choice,
        dims: 0,
        fetch: this.deps.keyedFetch(owner, choice.provider, choice.credential),
      });
      let v: number[] | undefined;
      try {
        v = (await probe.embed(["RedGiant"], "query", signal))[0];
      } catch (err) {
        throw new KnowledgeError(
          "embedding_failed",
          err instanceof EmbeddingError ? err.message : String((err as Error).message),
        );
      }
      if (!v?.length) throw new KnowledgeError("embedding_failed", "The model gave no vector");
      if (dims && v.length < dims)
        throw new KnowledgeError(
          "bad_choice",
          `The model gives ${v.length} dimensions, fewer than the ${dims} asked`,
        );
      dims ??= v.length;
    }
    if (!dims || dims > 4000)
      throw new KnowledgeError(
        "bad_choice",
        `The model gives ${dims ?? "unknown"} dimensions: choose at most 4000 (dims)`,
      );
    const all = await this.indexes(owner);
    const active = all.find((i) => i.active);
    if (active && sameIndex(active.choice, choice, active.dims, dims)) {
      // Same index: only the key or the card changed.
      await this.db.query("UPDATE rg_kb_indexes SET choice = $2::jsonb WHERE id = $1", [
        active.id,
        JSON.stringify(choice),
      ]);
      this.embedders.delete(`${owner}:${active.id}`);
      for (const i of all.filter((x) => !x.active)) await this.dropIndex(owner, i, "replaced");
      return;
    }
    const building = all.find((i) => !i.active && sameIndex(i.choice, choice, i.dims, dims));
    for (const i of all.filter((x) => !x.active && x !== building))
      await this.dropIndex(owner, i, "replaced");
    if (building) return;
    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO rg_kb_indexes (owner_id, provider, model, dims, choice, state, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'building', $6) RETURNING id`,
      [owner, choice.provider, choice.model, dims, JSON.stringify(choice), !active],
    );
    const id = rows[0]?.id as number;
    await createVectorTable(this.db, id, dims);
    await this.record(owner, {
      action: "index.started",
      indexId: id,
      detail: { provider: choice.provider, model: choice.model, dims, replaces: active?.id ?? 0 },
    });
  }

  /** Builds the active model's index again from the pieces (a new table, swapped at the end). */
  async rebuild(owner: string): Promise<void> {
    const all = await this.indexes(owner);
    const active = all.find((i) => i.active);
    if (!active) throw new KnowledgeError("bad_choice", "No model chosen yet");
    for (const i of all.filter((x) => !x.active)) await this.dropIndex(owner, i, "replaced");
    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO rg_kb_indexes (owner_id, provider, model, dims, choice, state, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'building', false) RETURNING id`,
      [owner, active.provider, active.model, active.dims, JSON.stringify(active.choice)],
    );
    const id = rows[0]?.id as number;
    await createVectorTable(this.db, id, active.dims);
    await this.record(owner, { action: "index.started", indexId: id, detail: { rebuild: true } });
    this.indexer.wake();
  }

  async dropIndex(owner: string, i: IndexRow, why: string) {
    await this.db.query(
      "UPDATE rg_kb_indexes SET state = 'retired', active = false WHERE id = $1",
      [i.id],
    );
    await this.db.query(`DROP TABLE IF EXISTS ${vecTable(i.id)}`);
    this.embedders.delete(`${owner}:${i.id}`);
    await this.record(owner, { action: "index.retired", indexId: i.id, detail: { why } });
  }

  // ---- Collections ----

  private async collectionRows(owner: string): Promise<CollectionRow[]> {
    return this.db.query<CollectionRow>(
      `SELECT id, num, owner_id, name, scope_kind, scope_id, language, description,
              to_json(created_at) #>> '{}' AS created_at
         FROM rg_kb_collections WHERE owner_id = $1 ORDER BY name, id`,
      [owner],
    );
  }

  async collections(owner: string): Promise<KnowledgeCollection[]> {
    const rows = await this.collectionRows(owner);
    const counts = await this.db.query<{ num: number; documents: string; chunks: string | null }>(
      `SELECT d.collection_num AS num, count(*)::text AS documents, sum(d.chunks)::text AS chunks
         FROM rg_kb_documents d JOIN rg_kb_collections c ON c.num = d.collection_num
        WHERE c.owner_id = $1 GROUP BY d.collection_num`,
      [owner],
    );
    const by = new Map(counts.map((c) => [c.num, c]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scope: scopeOfRow(r),
      language: r.language,
      ...(r.description && { description: r.description }),
      createdAt: r.created_at,
      documents: Number(by.get(r.num)?.documents ?? 0),
      chunks: Number(by.get(r.num)?.chunks ?? 0),
    }));
  }

  async collection(owner: string, id: string): Promise<CollectionRow> {
    const r = (await this.collectionRows(owner)).find((c) => c.id === id);
    if (!r) throw new KnowledgeError("not_found", `No collection "${id}"`);
    return r;
  }

  private language(raw: string): string {
    const l = raw === "auto" ? textSearchConfig(this.deps.agentLanguage?.()) : raw;
    if (!TEXT_SEARCH_CONFIG_NAMES.includes(l))
      throw new KnowledgeError("bad_choice", `Unknown language "${raw}"`);
    return l;
  }

  async createCollection(owner: string, raw: unknown, by = "human"): Promise<KnowledgeCollection> {
    const input = KnowledgeCollectionInput.parse(raw);
    const id = `kc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const scope = input.scope;
    await this.db.query(
      `INSERT INTO rg_kb_collections (id, owner_id, name, scope_kind, scope_id, language, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        owner,
        input.name,
        scope.kind,
        scope.kind === "agent" ? scope.agentId : scope.kind === "project" ? scope.projectId : null,
        this.language(input.language),
        input.description ?? null,
      ],
    );
    await this.record(owner, {
      action: "collection.created",
      collectionId: id,
      detail: { name: input.name, scope: scope.kind },
      by,
    });
    const made = (await this.collections(owner)).find((c) => c.id === id);
    if (!made) throw new KnowledgeError("not_found", "The collection vanished");
    return made;
  }

  /**
   * Name, scope and description change in place. The language too, but then every piece's words
   * are computed again (one UPDATE of that collection's rows; vectors stay).
   */
  async updateCollection(owner: string, id: string, raw: unknown): Promise<KnowledgeCollection> {
    const now = await this.collection(owner, id);
    const input = KnowledgeCollectionInput.partial().parse(raw);
    const language = input.language ? this.language(input.language) : now.language;
    const scope = input.scope ?? scopeOfRow(now);
    await this.db.query(
      `UPDATE rg_kb_collections SET name = $2, scope_kind = $3, scope_id = $4, language = $5,
              description = $6 WHERE id = $1`,
      [
        id,
        input.name ?? now.name,
        scope.kind,
        scope.kind === "agent" ? scope.agentId : scope.kind === "project" ? scope.projectId : null,
        language,
        input.description ?? now.description,
      ],
    );
    if (language !== now.language)
      await this.db.query(
        `UPDATE rg_kb_chunks ch SET tsv = ${tsvSql(`'${language}'`, "d.title", "d.path", "ch.heading", "ch.body")}
           FROM rg_kb_documents d WHERE d.id = ch.document_id AND ch.collection_num = $1`,
        [now.num],
      );
    await this.record(owner, { action: "collection.changed", collectionId: id });
    return (await this.collections(owner)).find((c) => c.id === id) as KnowledgeCollection;
  }

  async removeCollection(owner: string, id: string): Promise<void> {
    const c = await this.collection(owner, id);
    this.indexer.forget(id);
    // Pieces first (their vectors follow through the foreign keys), then the rest.
    await this.db.query("DELETE FROM rg_kb_chunks WHERE collection_num = $1", [c.num]);
    await this.db.query("DELETE FROM rg_kb_collections WHERE id = $1", [id]);
    await this.record(owner, {
      action: "collection.removed",
      collectionId: id,
      detail: { name: c.name },
    });
  }

  // ---- Sources ----

  /** Refuses folders RedGiant keeps for itself (data, keychain, database). */
  private async checkFolder(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new KnowledgeError("bad_source", "Give the folder's full path");
    const real = await realpath(resolve(path)).catch(() => undefined);
    if (!real) throw new KnowledgeError("bad_source", `No such folder or file: ${path}`);
    for (const f of [this.deps.dataDir, ...(this.deps.forbidden ?? [])]) {
      const keep = await realpath(resolve(f)).catch(() => resolve(f));
      const rel = relative(keep, real);
      const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      const contains = !relative(real, keep).startsWith("..");
      if (inside || contains)
        throw new KnowledgeError("bad_source", "That folder holds RedGiant's own data");
    }
    return real;
  }

  /** The folder (or file) a source reads, on disk. */
  async sourceRoot(owner: string, spec: KnowledgeSource["spec"]): Promise<string> {
    if (spec.kind === "folder") return this.checkFolder(spec.path);
    if (spec.kind === "workspace") {
      const root = await this.deps.scopeRoot(owner, spec.scope);
      const abs = normalize(join(root, spec.path));
      if (abs !== root && !abs.startsWith(root + sep))
        throw new KnowledgeError("bad_source", "Outside the workspace");
      return abs;
    }
    if (spec.kind === "file") {
      if (spec.scope) {
        const root = await this.deps.scopeRoot(owner, spec.scope);
        const abs = normalize(join(root, spec.path));
        if (!abs.startsWith(root + sep))
          throw new KnowledgeError("bad_source", "Outside the workspace");
        return abs;
      }
      return this.checkFolder(spec.path);
    }
    return spec.url;
  }

  async sources(owner: string, collectionId: string): Promise<KnowledgeSource[]> {
    await this.collection(owner, collectionId);
    const rows = await this.db.query<{
      id: string;
      collection_id: string;
      spec: unknown;
      state: KnowledgeSource["state"];
      error: string | null;
      last_scan_at: string | null;
      documents: string;
    }>(
      `SELECT s.id, s.collection_id, s.spec, s.state, s.error, to_json(s.last_scan_at) #>> '{}' AS last_scan_at,
              (SELECT count(*) FROM rg_kb_documents d WHERE d.source_id = s.id)::text AS documents
         FROM rg_kb_sources s WHERE s.collection_id = $1 ORDER BY s.created_at, s.id`,
      [collectionId],
    );
    return rows.map((r) => ({
      id: r.id,
      collectionId: r.collection_id,
      spec: parseJson<KnowledgeSource["spec"]>(r.spec),
      state: r.state,
      ...(r.error && { error: r.error }),
      documents: Number(r.documents),
      lastScanAt: r.last_scan_at,
    }));
  }

  async addSource(owner: string, collectionId: string, raw: unknown, by = "human") {
    await this.collection(owner, collectionId);
    const spec = KnowledgeSourceInput.parse(raw);
    const root = await this.sourceRoot(owner, spec);
    if (spec.kind === "folder" || spec.kind === "workspace") {
      const st = await stat(root).catch(() => undefined);
      if (!st?.isDirectory()) throw new KnowledgeError("bad_source", "Not a folder");
    }
    if (spec.kind === "file") {
      const st = await stat(root).catch(() => undefined);
      if (!st?.isFile()) throw new KnowledgeError("bad_source", "Not a file");
    }
    const id = `ks_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const kept = spec.kind === "folder" ? { ...spec, path: root } : spec;
    await this.db.query(
      "INSERT INTO rg_kb_sources (id, collection_id, spec) VALUES ($1, $2, $3::jsonb)",
      [id, collectionId, JSON.stringify(kept)],
    );
    await this.record(owner, {
      action: "source.added",
      collectionId,
      sourceId: id,
      detail: { kind: spec.kind },
      by,
    });
    this.indexer.sourceAdded(owner, id);
    return (await this.sources(owner, collectionId)).find((s) => s.id === id) as KnowledgeSource;
  }

  async removeSource(owner: string, collectionId: string, sourceId: string) {
    await this.collection(owner, collectionId);
    this.indexer.forget(sourceId);
    await this.db.query(
      "DELETE FROM rg_kb_chunks WHERE document_id IN (SELECT id FROM rg_kb_documents WHERE source_id = $1)",
      [sourceId],
    );
    const gone = await this.db.query(
      "DELETE FROM rg_kb_sources WHERE id = $1 AND collection_id = $2 RETURNING id",
      [sourceId, collectionId],
    );
    if (!gone.length) throw new KnowledgeError("not_found", `No source "${sourceId}"`);
    await this.record(owner, { action: "source.removed", collectionId, sourceId });
  }

  /** Looks at a source again now (a web page is read again too). */
  async rescan(owner: string, collectionId: string, sourceId?: string) {
    const list = await this.sources(owner, collectionId);
    for (const s of list) if (!sourceId || s.id === sourceId) this.indexer.rescan(s.id, true);
  }

  async documents(
    owner: string,
    collectionId: string,
    o: { state?: string; limit?: number; offset?: number } = {},
  ): Promise<KnowledgeDocument[]> {
    const c = await this.collection(owner, collectionId);
    const rows = await this.db.query<{
      id: string;
      source_id: string;
      path: string;
      title: string;
      kind: KnowledgeDocument["kind"];
      state: KnowledgeDocument["state"];
      reason: string | null;
      pages: number | null;
      chunks: number;
      size: string;
      indexed_at: string | null;
    }>(
      `SELECT id::text AS id, source_id, path, title, kind, state, reason, pages, chunks,
              size::text AS size, to_json(indexed_at) #>> '{}' AS indexed_at
         FROM rg_kb_documents WHERE collection_num = $1 AND ($2::text IS NULL OR state = $2)
        ORDER BY path LIMIT $3 OFFSET $4`,
      [c.num, o.state ?? null, Math.min(o.limit ?? 200, 1000), o.offset ?? 0],
    );
    return rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      collectionId,
      path: r.path,
      title: r.title,
      kind: r.kind,
      state: r.state,
      ...(r.reason && { reason: r.reason }),
      pages: r.pages,
      chunks: r.chunks,
      bytes: Number(r.size),
      indexedAt: r.indexed_at,
    }));
  }

  // ---- Status ----

  async status(owner: string): Promise<KnowledgeStatus> {
    const [settings, indexes] = await Promise.all([this.settings(owner), this.indexes(owner)]);
    const totals = await this.db.query<{ chunks: string }>(
      `SELECT count(*)::text AS chunks FROM rg_kb_chunks ch
         JOIN rg_kb_collections c ON c.num = ch.collection_num WHERE c.owner_id = $1`,
      [owner],
    );
    const total = Number(totals[0]?.chunks ?? 0);
    const infos: KnowledgeIndexInfo[] = [];
    for (const i of indexes) {
      const n = await this.db
        .query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${vecTable(i.id)} v
             JOIN rg_kb_collections c ON c.num = v.collection_num WHERE c.owner_id = $1`,
          [owner],
        )
        .catch(() => [{ n: "0" }]);
      infos.push({
        id: i.id,
        provider: i.provider as KnowledgeIndexInfo["provider"],
        model: i.model,
        dims: i.dims,
        state: i.state,
        active: i.active,
        embedded: Number(n[0]?.n ?? 0),
        total,
        ann: i.ann,
        ...(i.error && { error: i.error }),
        createdAt: i.created_at,
        readyAt: i.ready_at,
      });
    }
    const pending = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rg_kb_documents d
         JOIN rg_kb_collections c ON c.num = d.collection_num
        WHERE c.owner_id = $1 AND d.state = 'pending'`,
      [owner],
    );
    const filling =
      infos.find((i) => !i.active && i.state === "building") ?? infos.find((i) => i.active);
    const collections = await this.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM rg_kb_collections WHERE owner_id = $1",
      [owner],
    );
    const q = this.indexer.state(owner);
    return {
      vector: this.vector,
      settings,
      indexes: infos,
      queue: {
        documents: Number(pending[0]?.n ?? 0),
        chunks: filling ? Math.max(0, filling.total - filling.embedded) : 0,
        running: q.running,
        paused: q.paused,
        ...(q.doing && { doing: q.doing }),
        ...(q.error && { error: q.error }),
      },
      collections: Number(collections[0]?.n ?? 0),
    };
  }

  pause(owner: string, paused: boolean) {
    this.indexer.pause(owner, paused);
  }

  // ---- Search and citations ----

  /** The collections an asker may search (numbers), narrowed by the ids asked for. */
  async visible(owner: string, asker: KnowledgeAsker, only?: string[]): Promise<CollectionRow[]> {
    const rows = await this.collectionRows(owner);
    return rows.filter((r) => {
      if (only && !only.includes(r.id)) return false;
      if (asker.kind === "human") return true;
      if (r.scope_kind === "all") return true;
      if (r.scope_kind === "agent") return r.scope_id === asker.agentId;
      return r.scope_id !== null && asker.projectIds.includes(r.scope_id);
    });
  }

  async search(
    owner: string,
    input: KnowledgeSearchInput,
    asker: KnowledgeAsker = { kind: "human" },
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> {
    return searchKnowledge(this, owner, input, asker, signal);
  }

  /**
   * Where a piece opens: a workspace file (`scope`, `path`, `at`), a file on this computer
   * (`outside`, its full path, allowed because a source holds it), or a web address.
   */
  async open(
    owner: string,
    chunkId: string,
  ): Promise<
    | {
        title: string;
        target: {
          kind: "file";
          scope: string;
          path: string;
          at?: { page?: number; line?: number };
        };
        citation: KnowledgeCitation;
      }
    | { title: string; url: string; citation: KnowledgeCitation }
  > {
    if (!/^\d+$/.test(chunkId)) throw new KnowledgeError("not_found", "No such piece");
    const rows = await this.db.query<CitationRow>(
      `${CITATION_SELECT} WHERE ch.id = $1::bigint AND c.owner_id = $2`,
      [chunkId, owner],
    );
    const row = rows[0];
    if (!row) throw new KnowledgeError("not_found", "No such piece");
    const citation = citationOf(row);
    const at = {
      ...(citation.page && { page: citation.page }),
      ...(citation.lineStart && { line: citation.lineStart }),
    };
    if (citation.source === "url") return { title: citation.title, url: citation.path, citation };
    if (citation.scope)
      return {
        title: citation.title,
        target: {
          kind: "file",
          scope: citation.scope,
          path: citation.path,
          ...(Object.keys(at).length && { at }),
        },
        citation,
      };
    return {
      title: citation.title,
      target: {
        kind: "file",
        scope: "outside",
        path: citation.path,
        ...(Object.keys(at).length && { at }),
      },
      citation,
    };
  }

  /** Whether a file on this computer belongs to one of the person's folder sources (Canvas). */
  async holds(owner: string, abs: string): Promise<boolean> {
    const rows = await this.db.query<{ spec: unknown }>(
      `SELECT s.spec FROM rg_kb_sources s JOIN rg_kb_collections c ON c.id = s.collection_id
        WHERE c.owner_id = $1 AND s.spec->>'kind' IN ('folder', 'file')`,
      [owner],
    );
    const target = resolve(abs);
    return rows.some((r) => {
      const spec = parseJson<{ kind: string; path: string; scope?: string }>(r.spec);
      if (spec.scope) return false;
      const rel = relative(resolve(spec.path), target);
      return rel === "" ? spec.kind === "file" : !rel.startsWith("..") && !isAbsolute(rel);
    });
  }
}

/** The local servers need no key. */
const localFetch: KeyedFetch = (url, init, _key, signal) =>
  fetch(url, { ...init, ...(signal && { signal }) });

/** The words of a piece: title and place weigh more than the body (A, then B). */
export function tsvSql(config: string, title: string, path: string, heading: string, body: string) {
  return `setweight(to_tsvector(${config}::regconfig, coalesce(${title}, '') || ' ' || translate(coalesce(${path}, ''), '/._-', '    ') || ' ' || coalesce(${heading}, '')), 'A') || setweight(to_tsvector(${config}::regconfig, ${body}), 'B')`;
}

export interface CitationRow {
  chunk_id: string;
  body: string;
  heading: string | null;
  page: number | null;
  line_start: number | null;
  line_end: number | null;
  document_id: string;
  path: string;
  title: string;
  kind: string | null;
  collection_id: string;
  spec: unknown;
}

export const CITATION_SELECT = `
  SELECT ch.id::text AS chunk_id, ch.body, ch.heading, ch.page, ch.line_start, ch.line_end,
         d.id::text AS document_id, d.path, d.title, d.kind, c.id AS collection_id, s.spec
    FROM rg_kb_chunks ch
    JOIN rg_kb_documents d ON d.id = ch.document_id
    JOIN rg_kb_sources s ON s.id = d.source_id
    JOIN rg_kb_collections c ON c.num = ch.collection_num`;

export function citationOf(r: CitationRow): KnowledgeCitation {
  const spec = parseJson<KnowledgeSource["spec"]>(r.spec);
  const base = {
    collectionId: r.collection_id,
    documentId: r.document_id,
    chunkId: r.chunk_id,
    title: r.title || r.path,
    ...(r.heading && { heading: r.heading }),
    ...(r.page && { page: r.page }),
    ...(r.line_start && { lineStart: r.line_start }),
    ...(r.line_end && { lineEnd: r.line_end }),
  };
  if (spec.kind === "url") return { ...base, source: "url", path: r.path };
  if (spec.kind === "workspace") {
    const inScope = join(spec.path, r.path).split(sep).join("/").replace(/^\.\//, "");
    return { ...base, source: "workspace", scope: spec.scope, path: inScope };
  }
  if (spec.kind === "file")
    return spec.scope
      ? { ...base, source: "file", scope: spec.scope, path: spec.path }
      : { ...base, source: "file", path: spec.path };
  return { ...base, source: "folder", path: join(spec.path, ...r.path.split("/")) };
}
