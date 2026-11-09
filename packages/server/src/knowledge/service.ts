// The knowledge (G36): collections of sources, indexed in the background and searched by meaning
// and by words. This is the part the rest of the server talks to (routes, the core, and the
// `search_knowledge` tool of G36.5); the queue lives in indexer.ts, the search in search.ts.
//
// What is kept where: collections, sources, documents and pieces (text, place, words) in shared
// tables; vectors in one table per index (schema.ts). The person chooses the model; changing it
// makes a new index filled in the background while the old one keeps answering, then swaps
// (`index.ready` / `index.retired` in the event log). Vectors are derived data: never in the log.

import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { EventStore, SqlClient } from "@redgiant/events";
import {
  CLOUD_EMBEDDING_MODELS,
  type EmbeddingChoice,
  EmbeddingChoice as EmbeddingChoiceSchema,
  type KnowledgeAgentCollection,
  type KnowledgeCitation,
  type KnowledgeCollection,
  KnowledgeCollectionInput,
  type KnowledgeDisk,
  type KnowledgeDocument,
  type KnowledgeIndexInfo,
  KnowledgeOcr,
  type KnowledgeOpenTarget,
  type KnowledgeScope,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSettings,
  type KnowledgeSource,
  KnowledgeSourceInput,
  type KnowledgeStatus,
  OCR_LANGUAGES,
  RerankChoice,
  TEXT_SEARCH_CONFIG_NAMES,
  textSearchConfig,
} from "@redgiant/protocol";
import type { Jobs } from "../jobs.js";
import { KnowledgeBackup } from "./backup.js";
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
import {
  createVectorTable,
  dropVectorTable,
  migrateKnowledge,
  PIECES,
  type VectorState,
  vecTable,
} from "./schema.js";
import { meaningOf, searchKnowledge } from "./search.js";

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
  /**
   * The person's workspaces with their names (3.5.3): God's folder, the assistants' desk and each
   * project. A scope may then be given by a project's name or id, and a path inside one of them
   * becomes that workspace's source (a project lives inside RedGiant's data, and must be a source).
   */
  places?: (owner: string) => Promise<KnowledgePlace[]>;
  /** The agents' language (BCP-47), for a collection's words. */
  agentLanguage?: () => string | undefined;
  /** The PDF of an Office file made by LibreOffice when it is on this computer. */
  officePdf?: (owner: string, abs: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Reading text in pictures and scanned PDFs on this computer (G36.6, `LocalOcr`). */
  ocr?: OcrEngine;
  /** The person's mailboxes, read for a `mail` source (G36.6). */
  mail?: MailSource;
  /** The person's conversations, read for a `chats` source (G36.6). */
  chats?: ChatSource;
  /** The projects an agent works on (its own, the one it is assigned to), for its scope. */
  agentProjects?: (owner: string, agentId: string) => Promise<string[]>;
  /** Tests: no folder watching, no timers. */
  manual?: boolean;
  /** Pieces in a scope searched exactly (default `EXACT_MAX`, 20 000; tests lower it). */
  exactMax?: number;
  now?: () => Date;
}

/** A workspace a source can read: its scope (`project:<id>`, `platform`, `assistants`). */
export interface KnowledgePlace {
  scope: string;
  name: string;
  root: string;
}

/** What the knowledge needs from the OCR (G36.6). */
export interface OcrEngine {
  /** The program and these languages are on this computer. */
  ready(languages: string[]): Promise<boolean>;
  /** Downloads what is missing (a job with its bar). */
  ensure(owner: string, languages: string[]): Promise<void>;
  /** The text in a picture (PNG, JPEG, TIFF, BMP, WebP…). */
  recognize(image: Uint8Array, languages: string[], signal?: AbortSignal): Promise<string>;
  /** Bytes it takes on disk. */
  bytes(): Promise<number>;
  stop(): Promise<void>;
}

/** One message or conversation of a mail or chats source, as listed. */
export interface ItemRef {
  /** Stable inside the source (a mail's UID, a conversation's id). */
  id: string;
  title: string;
  /** Last change, ms (a conversation's last message). */
  at: number;
  size: number;
}

export interface MailSource {
  /** The person's mailboxes (to check a source's mailbox and name it). */
  boxes(owner: string): Promise<{ id: string; name: string }[]>;
  list(owner: string, mailbox: string, sinceMs: number, signal?: AbortSignal): Promise<ItemRef[]>;
  read(
    owner: string,
    mailbox: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<
    { subject: string; from: string; to?: string; date: string; text: string } | undefined
  >;
}

export interface ChatSource {
  list(owner: string, agents: string[], sinceMs: number): Promise<ItemRef[]>;
  read(
    owner: string,
    sessionId: string,
  ): Promise<
    | {
        title: string;
        agentId: string;
        agentName: string;
        messages: { who: "person" | "agent"; at: string; text: string }[];
      }
    | undefined
  >;
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

const DEFAULT_SETTINGS: KnowledgeSettings = {
  embedding: null,
  rerank: null,
  threads: 0,
  agents: {},
  ocr: { on: false, languages: ["eng"] },
  backupVectors: false,
};

const parseJson = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

/**
 * Whether `child` is `parent` or inside it. On Windows two drives have no relative path
 * (`relative` gives the other's absolute one): not inside (G36.6, seen in CI with C: and D:).
 */
export function within(
  parent: string,
  child: string,
  p: { relative(a: string, b: string): string; isAbsolute(a: string): boolean } = {
    relative,
    isAbsolute,
  },
): boolean {
  const rel = p.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Whether a collection's scope alone lets an agent read it. */
function byScope(r: CollectionRow, asker: Extract<KnowledgeAsker, { kind: "agent" }>): boolean {
  if (r.scope_kind === "all") return true;
  if (r.scope_kind === "agent") return r.scope_id === asker.agentId;
  return r.scope_id !== null && asker.projectIds.includes(r.scope_id);
}

/** Bytes of the files under a folder (0 when it is not there). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile())
      total += await stat(p).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

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
    await this.deps.ocr?.stop();
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
        | "settings.changed"
        | "access.changed"
        | "vectors.restored";
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
    const saved = rows[0] ? parseJson<Partial<KnowledgeSettings>>(rows[0].value) : {};
    const ocr = KnowledgeOcr.safeParse(saved.ocr ?? {});
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      agents: saved.agents ?? {},
      ocr: ocr.success ? ocr.data : DEFAULT_SETTINGS.ocr,
      backupVectors: saved.backupVectors === true,
    };
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
    raw: {
      embedding?: unknown;
      rerank?: unknown;
      threads?: unknown;
      ocr?: unknown;
      backupVectors?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<KnowledgeSettings> {
    const before = await this.settings(owner);
    const next: KnowledgeSettings = { ...before };
    if (raw.backupVectors !== undefined) next.backupVectors = raw.backupVectors === true;
    if (raw.ocr !== undefined) {
      const ocr = KnowledgeOcr.parse(raw.ocr);
      const unknown = ocr.languages.filter((l) => !OCR_LANGUAGES.some((x) => x.id === l));
      if (unknown.length)
        throw new KnowledgeError("bad_choice", `Unknown OCR language: ${unknown.join(", ")}`);
      next.ocr = ocr;
    }
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
        ocr: next.ocr.on ? next.ocr.languages.join("+") : "off",
        backupVectors: next.backupVectors,
      },
    });
    // OCR turned on (or another language): its program comes down, then the pictures and
    // scans that waited for it are read again.
    if (next.ocr.on && this.deps.ocr) {
      const langs = next.ocr.languages;
      void this.deps.ocr
        .ensure(owner, langs)
        .then(() => this.ocrArrived(owner))
        .catch(() => {});
    }
    this.indexer.retry(owner);
    return next;
  }

  /** The backup's model becomes the person's choice (its index came with the restore). */
  async adoptEmbedding(owner: string, choice: EmbeddingChoice) {
    await this.saveSettings(owner, { ...(await this.settings(owner)), embedding: choice });
  }

  /** The knowledge in a backup (G36.6, the person's choice `backupVectors`). */
  get backup(): KnowledgeBackup {
    this.backupHelper ??= new KnowledgeBackup(this);
    return this.backupHelper;
  }
  private backupHelper: KnowledgeBackup | undefined;

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
    await dropVectorTable(this.db, i.id);
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
    const counts = await this.db.query<{ num: number; documents: string }>(
      `SELECT d.collection_num AS num, count(*)::text AS documents
         FROM rg_kb_documents d JOIN rg_kb_collections c ON c.num = d.collection_num
        WHERE c.owner_id = $1 GROUP BY d.collection_num`,
      [owner],
    );
    const pieces = await this.pieceCounts(owner);
    const by = new Map(counts.map((c) => [c.num, c]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      scope: scopeOfRow(r),
      language: r.language,
      ...(r.description && { description: r.description }),
      createdAt: r.created_at,
      documents: Number(by.get(r.num)?.documents ?? 0),
      chunks: pieces.get(r.num) ?? 0,
    }));
  }

  /** Pieces per collection number, from the database's counters (never counted). */
  async pieceCounts(owner: string, indexId = PIECES): Promise<Map<number, number>> {
    const rows = await this.db.query<{ num: number; n: string }>(
      `SELECT n.collection_num AS num, n.n::text AS n FROM rg_kb_counts n
         JOIN rg_kb_collections c ON c.num = n.collection_num
        WHERE c.owner_id = $1 AND n.index_id = $2`,
      [owner, indexId],
    );
    return new Map(rows.map((r) => [r.num, Number(r.n)]));
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
    const scope = await this.projectScope(owner, input.scope);
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
    const scope = input.scope ? await this.projectScope(owner, input.scope) : scopeOfRow(now);
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
    await this.db.query("DELETE FROM rg_kb_counts WHERE collection_num = $1", [c.num]);
    await this.record(owner, {
      action: "collection.removed",
      collectionId: id,
      detail: { name: c.name },
    });
  }

  /** A collection's project given by name or id becomes its id (3.5.3). */
  private async projectScope(owner: string, scope: KnowledgeScope): Promise<KnowledgeScope> {
    if (scope.kind !== "project" || !this.deps.places) return scope;
    const id = (await this.resolveScope(owner, `project:${scope.projectId}`)).slice(
      "project:".length,
    );
    return { kind: "project", projectId: id };
  }

  /**
   * A workspace scope as written by a person or an agent (3.5.3): `platform`, `assistants`, or a
   * project as `project:<id>`, its id or its name. Unknown ones say what can be given.
   */
  async resolveScope(owner: string, raw: string): Promise<string> {
    const given = raw.trim();
    if (given === "platform" || given === "assistants") return given;
    const places = (await this.deps.places?.(owner)) ?? [];
    if (!this.deps.places) return given;
    const want = given
      .replace(/^project:/i, "")
      .trim()
      .toLowerCase();
    const projects = places.filter((p) => p.scope.startsWith("project:"));
    const hit =
      projects.find((p) => p.scope.slice(8).toLowerCase() === want) ??
      projects.find((p) => p.name.trim().toLowerCase() === want);
    if (hit) return hit.scope;
    const list = projects.map((p) => `${p.name} (${p.scope})`).join(", ");
    throw new KnowledgeError(
      "bad_source",
      `No project "${given.replace(/^project:/i, "")}". Give a project's name or id${list ? ` (${list})` : " (there is no project yet)"}, or "platform" for God's folder, "assistants" for the assistants' desk.`,
    );
  }

  /** The workspace an absolute path is in, with the path inside it (3.5.3). */
  async placeOf(owner: string, abs: string): Promise<{ scope: string; path: string } | undefined> {
    if (!this.deps.places || !isAbsolute(abs)) return undefined;
    const real = await realpath(resolve(abs)).catch(() => resolve(abs));
    // The deepest first: a project inside God's folder is the project.
    const places = await Promise.all(
      (await this.deps.places(owner)).map(async (p) => ({
        ...p,
        root: await realpath(resolve(p.root)).catch(() => resolve(p.root)),
      })),
    );
    places.sort((a, b) => b.root.length - a.root.length);
    for (const p of places)
      if (within(p.root, real)) {
        const inside = relative(p.root, real).split(sep).join("/");
        return { scope: p.scope, path: inside === "" ? "." : inside };
      }
    return undefined;
  }

  // ---- Sources ----

  /** Refuses folders RedGiant keeps for itself (data, keychain, database). */
  private async checkFolder(path: string): Promise<string> {
    if (!isAbsolute(path))
      throw new KnowledgeError(
        "bad_source",
        `Give the folder's full path ("${path}" is relative), or a project's files as kind "workspace" with its scope`,
      );
    const real = await realpath(resolve(path)).catch(() => undefined);
    if (!real) throw new KnowledgeError("bad_source", `No such folder or file: ${path}`);
    for (const f of [this.deps.dataDir, ...(this.deps.forbidden ?? [])]) {
      const keep = await realpath(resolve(f)).catch(() => resolve(f));
      if (within(keep, real) || within(real, keep))
        throw new KnowledgeError(
          "bad_source",
          within(keep, real)
            ? `${path} is inside RedGiant's own data (its database, keychain and downloads are never read). A project's files can be: add them as kind "workspace" with scope "project:<id>"`
            : `${path} holds RedGiant's own data (its database, keychain and downloads are never read): choose a folder inside it`,
        );
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
    // Mail and conversations are not on disk: their «root» names them (G36.6).
    if (spec.kind === "mail") {
      if (!this.deps.mail) throw new KnowledgeError("bad_source", "Mail is not available here");
      const boxes = await this.deps.mail.boxes(owner);
      if (!boxes.some((b) => b.id === spec.mailbox))
        throw new KnowledgeError("bad_source", `No mailbox "${spec.mailbox}"`);
      return `mail:${spec.mailbox}`;
    }
    if (spec.kind === "chats") {
      if (!this.deps.chats)
        throw new KnowledgeError("bad_source", "Conversations are not available here");
      return "chats:";
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

  /**
   * A source as given, made exact (3.5.3): a scope by a project's name or id, and a folder or file
   * by a full path inside a workspace (a project lives inside RedGiant's data) read as that
   * workspace's files.
   */
  async normalizeSource(
    owner: string,
    spec: KnowledgeSource["spec"],
  ): Promise<KnowledgeSource["spec"]> {
    if (spec.kind === "workspace")
      return { ...spec, scope: await this.resolveScope(owner, spec.scope) };
    if (spec.kind === "file" && spec.scope)
      return { ...spec, scope: await this.resolveScope(owner, spec.scope) };
    if (spec.kind === "folder" || spec.kind === "file") {
      const place = await this.placeOf(owner, spec.path);
      if (!place) return spec;
      return spec.kind === "folder"
        ? {
            kind: "workspace",
            scope: place.scope,
            path: place.path,
            exclude: spec.exclude,
            gitignore: spec.gitignore,
          }
        : { kind: "file", scope: place.scope, path: place.path };
    }
    return spec;
  }

  async addSource(owner: string, collectionId: string, raw: unknown, by = "human") {
    await this.collection(owner, collectionId);
    const spec = await this.normalizeSource(owner, KnowledgeSourceInput.parse(raw));
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
    // Counters kept by the database (G36.6): fast with a million pieces, nothing counted here.
    const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const total = sum(await this.pieceCounts(owner));
    const infos: KnowledgeIndexInfo[] = [];
    for (const i of indexes) {
      const embedded = sum(await this.pieceCounts(owner, i.id));
      infos.push({
        id: i.id,
        provider: i.provider as KnowledgeIndexInfo["provider"],
        model: i.model,
        dims: i.dims,
        state: i.state,
        active: i.active,
        embedded,
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
    const left = filling ? Math.max(0, filling.total - filling.embedded) : 0;
    const pace = this.indexer.pace(owner);
    const waiting = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rg_kb_documents d
         JOIN rg_kb_collections c ON c.num = d.collection_num
        WHERE c.owner_id = $1 AND d.state = 'skipped' AND d.reason = 'needs_ocr'`,
      [owner],
    );
    return {
      meaning: (await meaningOf(this, owner)).meaning,
      vector: this.vector,
      settings,
      indexes: infos,
      queue: {
        documents: Number(pending[0]?.n ?? 0),
        chunks: left,
        running: q.running,
        paused: q.paused,
        ...(q.doing && { doing: q.doing }),
        ...(q.error && { error: q.error }),
        // Paused, nothing moves: no pace and no time left to tell.
        ...(pace && !q.paused && { perMinute: Math.round(pace) }),
        ...(pace && !q.paused && left > 0 && { etaSeconds: Math.round((left / pace) * 60) }),
      },
      collections: Number(collections[0]?.n ?? 0),
      chunks: total,
      ocr: {
        on: settings.ocr.on,
        languages: settings.ocr.languages,
        ready: (await this.deps.ocr?.ready(settings.ocr.languages)) ?? false,
        waiting: Number(waiting[0]?.n ?? 0),
      },
    };
  }

  pause(owner: string, paused: boolean) {
    this.indexer.pause(owner, paused);
  }

  // ---- Search and citations ----

  /** The collections an asker may search (numbers), narrowed by the ids asked for. */
  async visible(owner: string, asker: KnowledgeAsker, only?: string[]): Promise<CollectionRow[]> {
    const rows = await this.collectionRows(owner);
    const access =
      asker.kind === "agent" ? (await this.settings(owner)).agents[asker.agentId] : undefined;
    return rows.filter((r) => {
      if (only && !only.includes(r.id)) return false;
      if (asker.kind === "human") return true;
      // The person's own choice for this agent comes first (its window's Knowledge tab).
      if (access?.off.includes(r.id)) return false;
      if (access?.on.includes(r.id)) return true;
      return byScope(r, asker);
    });
  }

  /** Every collection as one agent sees it: by its scope, the person's choice, what it gets. */
  async agentCollections(owner: string, agentId: string): Promise<KnowledgeAgentCollection[]> {
    const projectIds = (await this.deps.agentProjects?.(owner, agentId)) ?? [];
    const asker: KnowledgeAsker = { kind: "agent", agentId, projectIds };
    const [rows, access, pieces] = await Promise.all([
      this.collectionRows(owner),
      this.settings(owner).then((s) => s.agents[agentId]),
      this.pieceCounts(owner),
    ]);
    return rows.map((r) => {
      const scoped = byScope(r, asker);
      const own = access?.off.includes(r.id) ? "off" : access?.on.includes(r.id) ? "on" : null;
      return {
        id: r.id,
        name: r.name,
        scope: scopeOfRow(r),
        byScope: scoped,
        own,
        on: own ? own === "on" : scoped,
        chunks: pieces.get(r.num) ?? 0,
      };
    });
  }

  /** The person's choice for one agent and one collection; null goes back to the scope. */
  async setAgentAccess(
    owner: string,
    agentId: string,
    collectionId: string,
    pick: "on" | "off" | null,
  ): Promise<KnowledgeAgentCollection[]> {
    await this.collection(owner, collectionId);
    const s = await this.settings(owner);
    const now = s.agents[agentId] ?? { on: [], off: [] };
    const next = {
      on: now.on.filter((id) => id !== collectionId),
      off: now.off.filter((id) => id !== collectionId),
    };
    if (pick) next[pick].push(collectionId);
    const agents = { ...s.agents };
    if (next.on.length || next.off.length) agents[agentId] = next;
    else delete agents[agentId];
    await this.saveSettings(owner, { ...s, agents });
    await this.record(owner, {
      action: "access.changed",
      collectionId,
      detail: { agent: agentId, pick: pick ?? "scope" },
    });
    return this.agentCollections(owner, agentId);
  }

  /** What the knowledge takes on disk: Postgres' own sizes (no row is counted) and the downloads. */
  async disk(): Promise<KnowledgeDisk> {
    const size = async (sql: string) =>
      Number((await this.db.query<{ b: string | null }>(sql).catch(() => []))[0]?.b ?? 0) || 0;
    const texts =
      await size(`SELECT (coalesce(pg_total_relation_size(to_regclass('rg_kb_chunks')), 0)
        + coalesce(pg_total_relation_size(to_regclass('rg_kb_documents')), 0)
        + coalesce(pg_total_relation_size(to_regclass('rg_kb_sources')), 0))::text AS b`);
    const vectors = await size(`SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::text AS b
        FROM pg_class c WHERE c.relkind = 'r' AND c.relname ~ '^rg_kb_vec_[0-9]+$'`);
    return {
      texts,
      vectors,
      models: await folderBytes(join(this.deps.dataDir, "models", "knowledge")),
      ocr: (await this.deps.ocr?.bytes().catch(() => 0)) ?? 0,
    };
  }

  /** The OCR is here now: pictures and scans skipped while it was off are read again. */
  async ocrArrived(owner: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE rg_kb_documents d SET state = 'pending', hash = NULL
         FROM rg_kb_collections c
        WHERE c.num = d.collection_num AND c.owner_id = $1
          AND d.state = 'skipped' AND d.reason = 'needs_ocr'
        RETURNING d.id::text AS id`,
      [owner],
    );
    this.indexer.wake();
    return rows.length;
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
  async open(owner: string, chunkId: string): Promise<KnowledgeOpenTarget> {
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
    // A conversation opens as itself; a mail as its text (it lives in the mailbox, not here).
    if (citation.source === "chats") {
      const chat = await this.deps.chats?.read(owner, citation.path);
      if (chat)
        return {
          title: citation.title,
          chat: { sessionId: citation.path, agentId: chat.agentId },
          citation,
        };
    }
    if (citation.source === "mail" || citation.source === "chats") {
      const parts = await this.db.query<{ body: string }>(
        "SELECT body FROM rg_kb_chunks WHERE document_id = $1::bigint ORDER BY ord",
        [citation.documentId],
      );
      return { title: citation.title, text: joinPieces(parts.map((p) => p.body)), citation };
    }
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

/** A document's pieces back as one text: the overlap a long part repeats is said once. */
export function joinPieces(bodies: string[]): string {
  let out = "";
  for (const b of bodies) {
    if (!out) {
      out = b;
      continue;
    }
    let cut = 0;
    for (let n = Math.min(300, b.length, out.length); n >= 20; n--)
      if (out.endsWith(b.slice(0, n))) {
        cut = n;
        break;
      }
    out += cut ? b.slice(cut) : `\n\n${b}`;
  }
  return out;
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
  if (spec.kind === "mail") return { ...base, source: "mail", path: `${spec.mailbox}/${r.path}` };
  if (spec.kind === "chats") return { ...base, source: "chats", path: r.path };
  return { ...base, source: "folder", path: join(spec.path, ...r.path.split("/")) };
}
