// The knowledge in a backup, when the person wants it (G36.6, study 7.6): the pieces and their
// vectors, so a restore pays no model again. One open file per collection, JSON lines inside the
// backup ("knowledge/<collection>.jsonl"): first the collection, its sources and the model, then
// one line per document with its pieces, each vector as float16 in base64. On restore the
// pieces come back as they were; the vectors go into the person's index when it is the same
// model (or into a new one for that model when there is none), and the sources are looked at
// again: files that did not change keep their pieces (same sha256), the rest is read anew.

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EmbeddingChoice, type KnowledgeSource } from "@redgiant/protocol";
import { createVectorTable, vecTable } from "./schema.js";
import { type KnowledgeService, sameIndex, tsvSql } from "./service.js";

/** Documents read from the database at a time. */
const PAGE = 200;

const view = new DataView(new ArrayBuffer(4));

/** A number as IEEE float16 bits (exact for values that came out of a `halfvec`). */
export function toHalf(v: number): number {
  view.setFloat32(0, v);
  const x = view.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m |= 0x800000;
    const shift = 14 - e;
    let h = m >> shift;
    if ((m >> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (m >> 13);
  // Round to nearest, ties to even.
  if (m & 0x1000 && (m & 0xfff || m & 0x2000)) h++;
  return h;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return sign * (m / 1024) * 2 ** -14;
  if (e === 31) return m ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

/** `[0.1,0.2,…]` (a halfvec as Postgres writes it) as float16 in base64. */
export function packVector(text: string): string {
  const values = text
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(Number);
  const out = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => {
    out.writeUInt16LE(toHalf(v), i * 2);
  });
  return out.toString("base64");
}

export function unpackVector(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const values: string[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) values.push(String(fromHalf(buf.readUInt16LE(i))));
  return `[${values.join(",")}]`;
}

interface Head {
  collection: {
    id: string;
    name: string;
    scope_kind: string;
    scope_id: string | null;
    language: string;
    description: string | null;
  };
  sources: { id: string; spec: KnowledgeSource["spec"] }[];
  index: { choice: EmbeddingChoice; dims: number } | null;
}

interface DocLine {
  doc: {
    source_id: string;
    path: string;
    title: string;
    kind: string | null;
    state: string;
    reason: string | null;
    hash: string | null;
    size: number;
    mtime_ms: number;
    pages: number | null;
    note: string | null;
  };
  chunks: {
    ord: number;
    body: string;
    heading: string | null;
    page: number | null;
    ls: number | null;
    le: number | null;
    hash: string;
    v?: string;
  }[];
}

const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

/** A project, agent or scope id after the import renamed it. */
function remapScope(scope: string, ids: ReadonlyMap<string, string>): string {
  const m = /^project:(.+)$/.exec(scope);
  return m ? `project:${ids.get(m[1] as string) ?? m[1]}` : scope;
}

export class KnowledgeBackup {
  constructor(private readonly k: KnowledgeService) {}

  /** Writes one file per collection into `dir`; their names and sizes for the backup. */
  async exportTo(
    owner: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; path: string; size: number }[]> {
    const db = this.k.db;
    await mkdir(dir, { recursive: true });
    const active = (await this.k.indexes(owner)).find((i) => i.active);
    const out: { name: string; path: string; size: number }[] = [];
    const collections = await db.query<Head["collection"] & { num: number }>(
      `SELECT id, num, name, scope_kind, scope_id, language, description
         FROM rg_kb_collections WHERE owner_id = $1 ORDER BY id`,
      [owner],
    );
    for (const c of collections) {
      const sources = await db.query<{ id: string; spec: unknown }>(
        "SELECT id, spec FROM rg_kb_sources WHERE collection_id = $1 ORDER BY id",
        [c.id],
      );
      const path = join(dir, `${c.id}.jsonl`);
      const file = createWriteStream(path);
      const write = async (line: unknown) => {
        if (!file.write(`${JSON.stringify(line)}\n`)) await once(file, "drain");
      };
      const { num, ...collection } = c;
      const head: Head = {
        collection,
        sources: sources.map((s) => ({ id: s.id, spec: json(s.spec) })),
        index: active ? { choice: active.choice, dims: active.dims } : null,
      };
      await write(head);
      let after = 0;
      for (;;) {
        if (signal?.aborted) throw new Error("Cancelled");
        const docs = await db.query<DocLine["doc"] & { id: string; size: string }>(
          `SELECT id::text AS id, source_id, path, title, kind, state, reason, hash, size::text AS size,
                  mtime_ms, pages, note
             FROM rg_kb_documents WHERE collection_num = $1 AND id > $2::bigint
            ORDER BY id LIMIT ${PAGE}`,
          [num, after],
        );
        if (!docs.length) break;
        after = Number(docs.at(-1)?.id);
        const chunks = await db.query<
          DocLine["chunks"][number] & { document_id: string; e: string | null }
        >(
          `SELECT ch.document_id::text AS document_id, ch.ord, ch.body, ch.heading, ch.page,
                  ch.line_start AS ls, ch.line_end AS le, ch.hash,
                  ${active ? "v.embedding::text" : "NULL::text"} AS e
             FROM rg_kb_chunks ch
             ${active ? `LEFT JOIN ${vecTable(active.id)} v ON v.chunk_id = ch.id` : ""}
            WHERE ch.document_id = ANY($1::bigint[]) ORDER BY ch.document_id, ch.ord`,
          [docs.map((d) => d.id)],
        );
        const byDoc = new Map<string, DocLine["chunks"]>();
        for (const ch of chunks) {
          const { document_id, e, ...rest } = ch;
          const list = byDoc.get(document_id) ?? [];
          list.push({ ...rest, ...(e && { v: packVector(e) }) });
          byDoc.set(document_id, list);
        }
        for (const d of docs) {
          const { id, size, ...doc } = d;
          await write({ doc: { ...doc, size: Number(size) }, chunks: byDoc.get(id) ?? [] });
        }
      }
      file.end();
      await once(file, "close");
      out.push({ name: `knowledge/${c.id}.jsonl`, path, size: (await stat(path)).size });
    }
    return out;
  }

  /**
   * One collection's file back (its lines, in order). A collection already here is left alone;
   * returns the pieces put back.
   */
  async importLines(
    owner: string,
    lines: AsyncIterable<string>,
    ids: ReadonlyMap<string, string>,
  ): Promise<number> {
    const db = this.k.db;
    let head: Head | undefined;
    let num = 0;
    let target: number | undefined;
    const sources = new Map<string, string>();
    let pieces = 0;
    let skip = false;
    for await (const line of lines) {
      if (!line.trim() || skip) continue;
      if (!head) {
        head = JSON.parse(line) as Head;
        const c = head.collection;
        const [had] = await db.query("SELECT 1 FROM rg_kb_collections WHERE id = $1", [c.id]);
        if (had) {
          skip = true;
          continue;
        }
        const scopeId = c.scope_id ? (ids.get(c.scope_id) ?? c.scope_id) : null;
        const [row] = await db.query<{ num: number }>(
          `INSERT INTO rg_kb_collections (id, owner_id, name, scope_kind, scope_id, language, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING num`,
          [c.id, owner, c.name, c.scope_kind, scopeId, c.language, c.description],
        );
        num = Number(row?.num);
        for (const s of head.sources) {
          const spec = { ...s.spec } as KnowledgeSource["spec"] & { scope?: string };
          if (spec.scope) spec.scope = remapScope(spec.scope, ids);
          await db.query(
            "INSERT INTO rg_kb_sources (id, collection_id, spec) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING",
            [s.id, c.id, JSON.stringify(spec)],
          );
          sources.set(s.id, s.id);
        }
        target = head.index ? await this.indexFor(owner, head.index) : undefined;
        continue;
      }
      const d = JSON.parse(line) as DocLine;
      if (!sources.has(d.doc.source_id)) continue;
      const language = head.collection.language.replace(/[^a-z_]/g, "");
      await db.transaction(async (tx) => {
        const [doc] = await tx.query<{ id: string }>(
          `INSERT INTO rg_kb_documents (source_id, collection_num, path, title, kind, state, reason,
                                       hash, size, mtime_ms, pages, chunks, note, indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
           ON CONFLICT (source_id, path) DO NOTHING RETURNING id::text AS id`,
          [
            d.doc.source_id,
            num,
            d.doc.path,
            d.doc.title,
            d.doc.kind,
            d.doc.state === "pending" ? "pending" : d.doc.state,
            d.doc.reason,
            d.doc.hash,
            d.doc.size,
            d.doc.mtime_ms,
            d.doc.pages,
            d.chunks.length,
            d.doc.note,
          ],
        );
        if (!doc || !d.chunks.length) return;
        const made = await tx.query<{ id: string; ord: number }>(
          `INSERT INTO rg_kb_chunks
             (document_id, collection_num, ord, body, heading, page, line_start, line_end, hash, tsv)
           SELECT $1::bigint, $2, x.ord, x.body, x.heading, x.page, x.ls, x.le, x.hash,
                  ${tsvSql(`'${language}'`, "$3::text", "$4::text", "x.heading", "x.body")}
             FROM unnest($5::int[], $6::text[], $7::text[], $8::int[], $9::int[], $10::int[], $11::text[])
                  AS x(ord, body, heading, page, ls, le, hash)
           RETURNING id::text AS id, ord`,
          [
            doc.id,
            num,
            d.doc.title,
            d.doc.path,
            d.chunks.map((c) => c.ord),
            d.chunks.map((c) => c.body),
            d.chunks.map((c) => c.heading),
            d.chunks.map((c) => c.page),
            d.chunks.map((c) => c.ls),
            d.chunks.map((c) => c.le),
            d.chunks.map((c) => c.hash),
          ],
        );
        pieces += made.length;
        if (target === undefined) return;
        const byOrd = new Map(made.map((m) => [m.ord, m.id]));
        const withVector = d.chunks.filter((c) => c.v && byOrd.has(c.ord));
        if (withVector.length)
          await tx.query(
            `INSERT INTO ${vecTable(target)} (chunk_id, collection_num, embedding)
             SELECT x.id, $2, x.e::halfvec FROM unnest($1::bigint[], $3::text[]) AS x(id, e)
             ON CONFLICT (chunk_id) DO NOTHING`,
            [
              withVector.map((c) => byOrd.get(c.ord)),
              num,
              withVector.map((c) => unpackVector(c.v as string)),
            ],
          );
      });
    }
    if (!head || skip) return 0;
    await this.k.record(owner, {
      action: "vectors.restored",
      collectionId: head.collection.id,
      detail: { pieces, vectors: target !== undefined },
    });
    for (const id of sources.keys()) this.k.indexer.sourceAdded(owner, id);
    return pieces;
  }

  /**
   * The index the vectors go into: the person's active one when it is the same model; a new
   * one for that model when the person has none (the backup's model becomes theirs); otherwise
   * none (the pieces are embedded again by the person's model).
   */
  private async indexFor(
    owner: string,
    want: { choice: EmbeddingChoice; dims: number },
  ): Promise<number | undefined> {
    if (!this.k.vector.ok) return undefined;
    const choice = EmbeddingChoice.safeParse(want.choice);
    if (!choice.success) return undefined;
    const indexes = await this.k.indexes(owner);
    const active = indexes.find((i) => i.active);
    if (active)
      return sameIndex(active.choice, choice.data, active.dims, want.dims) ? active.id : undefined;
    const [row] = await this.k.db.query<{ id: number }>(
      `INSERT INTO rg_kb_indexes (owner_id, provider, model, dims, choice, state, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'building', true) RETURNING id`,
      [owner, choice.data.provider, choice.data.model, want.dims, JSON.stringify(choice.data)],
    );
    if (!row) return undefined;
    await createVectorTable(this.k.db, row.id, want.dims);
    const s = await this.k.settings(owner);
    if (!s.embedding) await this.k.adoptEmbedding(owner, choice.data);
    await this.k.record(owner, {
      action: "index.started",
      indexId: row.id,
      detail: { restored: true },
    });
    return row.id;
  }
}
