// The knowledge's tables (G36.1). Texts, places and words live in tables shared by every model;
// vectors live in one table per index (`rg_kb_vec_<id>`), made once with the model's dimensions
// and never altered: a new model means a new table filled in the background (study 4.1: an
// ALTER TABLE on a full table rewrites it and rebuilds the HNSW graph, minutes to hours).

import type { SqlClient } from "@redgiant/events";
import { enableVector } from "./pgvector.js";

/** Name of an index's vector table (ids are integers we made: safe inside SQL). */
export const vecTable = (indexId: number) => `rg_kb_vec_${Math.trunc(indexId)}`;
/** Name of the HNSW graph over a whole vector table. */
export const annIndex = (indexId: number) => `${vecTable(indexId)}_hnsw`;
/** Name of the HNSW graph of one big collection inside an index (a partial index). */
export const partialIndex = (indexId: number, collectionNum: number) =>
  `${vecTable(indexId)}_c${Math.trunc(collectionNum)}`;

/** HNSW parameters (study 7.1): m 16, ef_construction 64, cosine distance on halfvec. */
export const HNSW_WITH = "WITH (m = 16, ef_construction = 64)";

export type VectorState = { ok: true; version: string } | { ok: false; reason: string };

/**
 * Creates the shared tables, and turns pgvector on. Without pgvector the tables still exist and
 * the words search works; vector tables are made only once it is there.
 */
export async function migrateKnowledge(db: SqlClient): Promise<VectorState> {
  const vector = await enableVector(db);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_collections (
      id          text PRIMARY KEY,
      num         integer GENERATED ALWAYS AS IDENTITY UNIQUE,
      owner_id    text NOT NULL,
      name        text NOT NULL,
      scope_kind  text NOT NULL CHECK (scope_kind IN ('all', 'agent', 'project')),
      scope_id    text,
      language    text NOT NULL DEFAULT 'simple',
      description text,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_kb_collections_owner ON rg_kb_collections (owner_id)",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_sources (
      id            text PRIMARY KEY,
      collection_id text NOT NULL REFERENCES rg_kb_collections (id) ON DELETE CASCADE,
      spec          jsonb NOT NULL,
      state         text NOT NULL DEFAULT 'waiting',
      error         text,
      last_scan_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_kb_sources_collection ON rg_kb_sources (collection_id)",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_documents (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_id      text NOT NULL REFERENCES rg_kb_sources (id) ON DELETE CASCADE,
      collection_num integer NOT NULL,
      path           text NOT NULL,
      title          text NOT NULL DEFAULT '',
      kind           text,
      state          text NOT NULL DEFAULT 'pending',
      reason         text,
      hash           text,
      size           bigint NOT NULL DEFAULT 0,
      mtime_ms       double precision NOT NULL DEFAULT 0,
      pages          integer,
      chunks         integer NOT NULL DEFAULT 0,
      note           text,
      indexed_at     timestamptz,
      UNIQUE (source_id, path)
    )`);
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_kb_documents_pending ON rg_kb_documents (state) WHERE state = 'pending'",
  );
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_kb_documents_collection ON rg_kb_documents (collection_num)",
  );
  // Pictures and scans waiting for the OCR (G36.6): found without reading every document.
  await db.query(
    `CREATE INDEX IF NOT EXISTS rg_kb_documents_ocr ON rg_kb_documents (collection_num)
      WHERE state = 'skipped' AND reason = 'needs_ocr'`,
  );
  // The words column is born with the table (never added later: study 4.1).
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_chunks (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      document_id    bigint NOT NULL REFERENCES rg_kb_documents (id) ON DELETE CASCADE,
      collection_num integer NOT NULL,
      ord            integer NOT NULL,
      body           text NOT NULL,
      heading        text,
      page           integer,
      line_start     integer,
      line_end       integer,
      hash           text NOT NULL,
      tsv            tsvector NOT NULL
    )`);
  await db.query("CREATE INDEX IF NOT EXISTS rg_kb_chunks_document ON rg_kb_chunks (document_id)");
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_kb_chunks_collection ON rg_kb_chunks (collection_num, id)",
  );
  await db.query("CREATE INDEX IF NOT EXISTS rg_kb_chunks_tsv ON rg_kb_chunks USING gin (tsv)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_indexes (
      id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id   text NOT NULL,
      provider   text NOT NULL,
      model      text NOT NULL,
      dims       integer NOT NULL CHECK (dims BETWEEN 1 AND 4000),
      choice     jsonb NOT NULL,
      state      text NOT NULL DEFAULT 'building',
      active     boolean NOT NULL DEFAULT false,
      ann        boolean NOT NULL DEFAULT false,
      partials   integer[] NOT NULL DEFAULT '{}',
      error      text,
      created_at timestamptz NOT NULL DEFAULT now(),
      ready_at   timestamptz
    )`);
  // At most one active index per person: searches use it while a new one fills.
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rg_kb_indexes_active ON rg_kb_indexes (owner_id) WHERE active",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_settings (
      owner_id text PRIMARY KEY,
      value    jsonb NOT NULL
    )`);
  await migrateCounts(db);
  return vector;
}

/** The counters' row for the pieces themselves; an index's vectors count under its id. */
export const PIECES = 0;

/**
 * Counters kept by the database (G36.6): pieces per collection (`index_id` 0) and vectors per
 * collection and index, moved by statement triggers with transition tables, so the status page
 * never counts a million rows. Made once; the first time they are filled from the tables.
 */
async function migrateCounts(db: SqlClient) {
  const [had] = await db.query<{ t: string | null }>(
    "SELECT to_regclass('rg_kb_counts')::text AS t",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_kb_counts (
      collection_num integer NOT NULL,
      index_id       integer NOT NULL,
      n              bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (collection_num, index_id)
    )`);
  await db.query(`
    CREATE OR REPLACE FUNCTION rg_kb_count_added() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      INSERT INTO rg_kb_counts (collection_num, index_id, n)
        SELECT collection_num, TG_ARGV[0]::integer, count(*) FROM added GROUP BY collection_num
      ON CONFLICT (collection_num, index_id) DO UPDATE SET n = rg_kb_counts.n + EXCLUDED.n;
      RETURN NULL;
    END $f$`);
  await db.query(`
    CREATE OR REPLACE FUNCTION rg_kb_count_removed() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      UPDATE rg_kb_counts c SET n = c.n - g.n
        FROM (SELECT collection_num, count(*) AS n FROM removed GROUP BY collection_num) g
       WHERE c.collection_num = g.collection_num AND c.index_id = TG_ARGV[0]::integer;
      RETURN NULL;
    END $f$`);
  await countTriggers(db, "rg_kb_chunks", PIECES);
  const tables = await db.query<{ t: string }>(
    "SELECT tablename AS t FROM pg_tables WHERE tablename ~ '^rg_kb_vec_[0-9]+$'",
  );
  for (const { t } of tables) await countTriggers(db, t, Number(t.slice("rg_kb_vec_".length)));
  if (had?.t) return;
  // First time: what is there already, counted once.
  await db.query(`INSERT INTO rg_kb_counts (collection_num, index_id, n)
    SELECT collection_num, ${PIECES}, count(*) FROM rg_kb_chunks GROUP BY collection_num
    ON CONFLICT (collection_num, index_id) DO UPDATE SET n = EXCLUDED.n`);
  for (const { t } of tables)
    await db.query(`INSERT INTO rg_kb_counts (collection_num, index_id, n)
      SELECT collection_num, ${Number(t.slice("rg_kb_vec_".length))}, count(*) FROM ${t}
       GROUP BY collection_num
      ON CONFLICT (collection_num, index_id) DO UPDATE SET n = EXCLUDED.n`);
}

/** The two statement triggers of a counted table (made once; their names say the table). */
async function countTriggers(db: SqlClient, table: string, indexId: number) {
  const have = await db.query<{ tgname: string }>(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname LIKE 'rg_kb_count_%'",
    [table],
  );
  const names = new Set(have.map((r) => r.tgname));
  const id = Math.trunc(indexId);
  if (!names.has("rg_kb_count_added"))
    await db.query(`CREATE TRIGGER rg_kb_count_added AFTER INSERT ON ${table}
      REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION rg_kb_count_added('${id}')`);
  if (!names.has("rg_kb_count_removed"))
    await db.query(`CREATE TRIGGER rg_kb_count_removed AFTER DELETE ON ${table}
      REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION rg_kb_count_removed('${id}')`);
}

/** Makes an index's vector table (once, with its dimensions). */
export async function createVectorTable(db: SqlClient, indexId: number, dims: number) {
  const d = Math.trunc(dims);
  if (!(d >= 1 && d <= 4000)) throw new Error(`Bad dimensions: ${dims}`);
  const t = vecTable(indexId);
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${t} (
      chunk_id       bigint PRIMARY KEY REFERENCES rg_kb_chunks (id) ON DELETE CASCADE,
      collection_num integer NOT NULL,
      embedding      halfvec(${d}) NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${t}_collection ON ${t} (collection_num)`);
  await countTriggers(db, t, indexId);
}

/** An index's vector table goes: its table and its counters. */
export async function dropVectorTable(db: SqlClient, indexId: number) {
  await db.query(`DROP TABLE IF EXISTS ${vecTable(indexId)}`);
  await db.query("DELETE FROM rg_kb_counts WHERE index_id = $1", [Math.trunc(indexId)]);
}
