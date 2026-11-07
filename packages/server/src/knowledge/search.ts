// Searching the knowledge (G36.4): by meaning (the vectors) and by words (Postgres text search),
// fused with Reciprocal Rank Fusion, then reordered by the reranker when the person chose one.
// The way the vectors are searched is chosen here, not left to Postgres' planner (study 4.2: a
// selective filter after an HNSW scan returns almost nothing, recall 0.04):
//   - a small scope (≤ EXACT_MAX pieces, or no graph yet): exact, perfect and fast;
//   - one big collection with a graph of its own: that partial index;
//   - otherwise: the HNSW graph with iterative scan (relaxed order), re-sorted by distance.

import {
  type KnowledgeHit,
  KnowledgeSearchInput,
  type KnowledgeSearchResult,
  TEXT_SEARCH_CONFIG_NAMES,
} from "@redgiant/protocol";
import { vectorLiteral } from "./embedders.js";
import { vecTable } from "./schema.js";
import {
  CITATION_SELECT,
  type CitationRow,
  citationOf,
  type IndexRow,
  type KnowledgeAsker,
  type KnowledgeService,
} from "./service.js";

/** Up to this many pieces in the scope, the vectors are searched exactly (study 4.2). */
export const EXACT_MAX = 20_000;
/** RRF's constant (study 4.3). */
const RRF_K = 60;

interface Ranked {
  id: string;
  rank: number;
}

/** Fuses ranked lists: each id scores Σ 1 / (k + rank). Pure, tested. */
export function rrf(lists: Ranked[][], k = RRF_K): { id: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists)
    for (const r of list) score.set(r.id, (score.get(r.id) ?? 0) + 1 / (k + r.rank));
  return [...score]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id));
}

/** The vector query for a strategy (pure: the SQL text, tested against the plans). */
export function vectorSql(o: {
  table: string;
  strategy: "exact" | "partial" | "hnsw";
  partialNum?: number;
  filtered: boolean;
}): string {
  const distance = "v.embedding <=> $1::halfvec";
  const where =
    o.strategy === "partial"
      ? `v.collection_num = ${Math.trunc(o.partialNum ?? 0)}`
      : "v.collection_num = ANY($2::int[])";
  const join = o.filtered
    ? `JOIN rg_kb_chunks ch ON ch.id = v.chunk_id JOIN rg_kb_documents d ON d.id = ch.document_id`
    : "";
  const filters = o.filtered
    ? "AND ($4::text[] IS NULL OR d.kind = ANY($4::text[])) AND ($5::text IS NULL OR d.path LIKE $5 || '%')"
    : "";
  // `+ 0` keeps Postgres from using the graph for the exact search.
  const order = o.strategy === "exact" ? `(${distance}) + 0` : distance;
  // The partial index's predicate holds the collection as a literal; $2 is still passed (and used)
  // so the parameters are the same for every strategy.
  const keep = o.strategy === "partial" ? "AND cardinality($2::int[]) >= 1" : "";
  return `WITH c AS MATERIALIZED (
      SELECT v.chunk_id::text AS id, ${distance} AS d
        FROM ${o.table} v ${join}
       WHERE ${where} ${keep} ${filters}
       ORDER BY ${order} LIMIT $3)
    SELECT id, d FROM c ORDER BY d, id`;
}

export async function searchKnowledge(
  k: KnowledgeService,
  owner: string,
  raw: unknown,
  asker: KnowledgeAsker,
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult> {
  const started = performance.now();
  const input = KnowledgeSearchInput.parse(raw);
  const collections = await k.visible(owner, asker, input.collections);
  const done = (r: Omit<KnowledgeSearchResult, "ms">): KnowledgeSearchResult => ({
    ...r,
    ms: Math.round(performance.now() - started),
  });
  if (!collections.length) return done({ hits: [], strategy: "words", indexId: null });
  const nums = collections.map((c) => c.num);
  const kinds = input.kinds?.length ? input.kinds : null;
  const prefix = input.pathPrefix ? input.pathPrefix.replace(/[\\%_]/g, (m) => `\\${m}`) : null;
  const pool = Math.max(input.limit * 5, 40);

  // ---- Meaning ----
  let meaning: Ranked[] = [];
  let strategy: KnowledgeSearchResult["strategy"] = "words";
  let wordsOnly: string | undefined;
  let index: IndexRow | undefined;
  if (input.mode !== "words") {
    index = k.vector.ok ? (await k.indexes(owner)).find((i) => i.active) : undefined;
    if (!k.vector.ok) wordsOnly = `pgvector is not available: ${k.vector.reason}`;
    else if (!index) wordsOnly = "No embedding model chosen";
    else if (
      index.choice.provider === "local" &&
      !(await k.deps.local.ready("embed", index.choice.model, index.choice.gpu ?? false))
    )
      // Never wait for a download inside a search: words now, meaning once it is here.
      wordsOnly = "The local model is still downloading";
    else {
      try {
        meaning = await searchVectors(k, owner, index, input.query, nums, {
          kinds,
          prefix,
          pool,
          accurate: input.accurate,
          signal,
        }).then((r) => {
          strategy = r.strategy;
          return r.ranked;
        });
      } catch (err) {
        wordsOnly = `The embedding model failed: ${(err as Error).message}`;
      }
    }
  }

  // ---- Words ----
  const words =
    input.mode === "meaning"
      ? []
      : await searchWords(k, input.query, collections, kinds, prefix, pool);

  const fused =
    input.mode === "meaning" || (input.mode === "both" && !words.length)
      ? meaning.map((r) => ({ id: r.id, score: 1 / (RRF_K + r.rank) }))
      : input.mode === "words" || !meaning.length
        ? words.map((r) => ({ id: r.id, score: 1 / (RRF_K + r.rank) }))
        : rrf([meaning, words]);

  // ---- Rerank and details ----
  const candidates = fused.slice(0, input.rerank ? Math.max(input.limit * 3, 20) : input.limit);
  if (!candidates.length)
    return done({
      hits: [],
      strategy: meaning.length ? strategy : "words",
      indexId: index?.id ?? null,
      ...(wordsOnly && { wordsOnly }),
    });
  const rows = await k.db.query<CitationRow>(`${CITATION_SELECT} WHERE ch.id = ANY($1::bigint[])`, [
    candidates.map((c) => c.id),
  ]);
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const meaningRank = new Map(meaning.map((r) => [r.id, r.rank]));
  const wordsRank = new Map(words.map((r) => [r.id, r.rank]));
  let hits: KnowledgeHit[] = candidates.flatMap((c) => {
    const r = byId.get(c.id);
    if (!r) return [];
    return [
      {
        citation: citationOf(r),
        text: r.body,
        score: c.score,
        ranks: {
          ...(meaningRank.has(c.id) && { meaning: meaningRank.get(c.id) as number }),
          ...(wordsRank.has(c.id) && { words: wordsRank.get(c.id) as number }),
        },
      },
    ];
  });
  if (input.rerank && hits.length > 1) {
    const reranker = await k.rerankerFor(owner).catch(() => undefined);
    if (reranker) {
      const scores = await reranker
        .rerank(
          input.query,
          hits.map(
            (h) =>
              `${h.citation.title}${h.citation.heading ? ` › ${h.citation.heading}` : ""}\n${h.text}`,
          ),
          signal,
        )
        .catch(() => undefined);
      if (scores) {
        hits = hits
          .map((h, i) => ({ ...h, score: scores[i] ?? Number.NEGATIVE_INFINITY }))
          .sort((a, b) => b.score - a.score);
        hits.forEach((h, i) => {
          h.ranks.rerank = i + 1;
        });
      }
    }
  }
  return done({
    hits: hits.slice(0, input.limit),
    strategy: meaning.length ? strategy : "words",
    indexId: index?.id ?? null,
    ...(wordsOnly && { wordsOnly }),
  });
}

async function searchVectors(
  k: KnowledgeService,
  owner: string,
  index: IndexRow,
  query: string,
  nums: number[],
  o: {
    kinds: string[] | null;
    prefix: string | null;
    pool: number;
    accurate: boolean;
    signal?: AbortSignal | undefined;
  },
): Promise<{ ranked: Ranked[]; strategy: "exact" | "partial" | "hnsw" }> {
  const embedder = await k.embedderFor(owner, index);
  const [v] = await embedder.embed([query], "query", o.signal);
  if (!v) throw new Error("no vector for the query");
  const table = vecTable(index.id);
  // Pieces in the scope, from the documents' counts (cheaper than counting a million vectors).
  const sizes = await k.db.query<{ n: string | null }>(
    "SELECT sum(chunks)::text AS n FROM rg_kb_documents WHERE collection_num = ANY($1::int[])",
    [nums],
  );
  const inScope = Number(sizes[0]?.n ?? 0);
  const exactMax = k.deps.exactMax ?? EXACT_MAX;
  const strategy: "exact" | "partial" | "hnsw" =
    !index.ann || inScope <= exactMax
      ? "exact"
      : nums.length === 1 && index.partials.includes(nums[0] as number)
        ? "partial"
        : "hnsw";
  const filtered = o.kinds !== null || o.prefix !== null;
  const sql = vectorSql({
    table,
    strategy,
    ...(strategy === "partial" && { partialNum: nums[0] as number }),
    filtered,
  });
  const params: unknown[] = [
    vectorLiteral(v),
    nums,
    o.pool,
    ...(filtered ? [o.kinds, o.prefix] : []),
  ];
  const rows = await k.db.transaction(async (tx) => {
    if (strategy !== "exact") {
      await tx.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      await tx.query(`SET LOCAL hnsw.ef_search = ${o.accurate ? 200 : 100}`);
      // The strategy is ours (study 4.2): the graph gives the order, no sort of the scope.
      await tx.query("SET LOCAL enable_sort = off");
    }
    return tx.query<{ id: string; d: number }>(sql, params);
  });
  return { ranked: rows.map((r, i) => ({ id: r.id, rank: i + 1 })), strategy };
}

/**
 * Words, in each collection's own language (stems: «case» finds «casa») and as written
 * (`simple`: names, code identifiers), ranked by ts_rank_cd. One query per language, each able to
 * use the GIN index (its configuration is a constant).
 */
async function searchWords(
  k: KnowledgeService,
  query: string,
  collections: { num: number; language: string }[],
  kinds: string[] | null,
  prefix: string | null,
  pool: number,
): Promise<Ranked[]> {
  const byLanguage = new Map<string, number[]>();
  for (const c of collections) {
    const l = TEXT_SEARCH_CONFIG_NAMES.includes(c.language) ? c.language : "simple";
    byLanguage.set(l, [...(byLanguage.get(l) ?? []), c.num]);
  }
  const found: { id: string; r: number }[] = [];
  for (const [language, nums] of byLanguage) {
    const rows = await k.db.query<{ id: string; r: number }>(
      `SELECT ch.id::text AS id, ts_rank_cd(ch.tsv, q, 32) AS r
         FROM rg_kb_chunks ch
         JOIN rg_kb_documents d ON d.id = ch.document_id,
              (SELECT websearch_to_tsquery('${language}', $1) || websearch_to_tsquery('simple', $1) AS q) w
        WHERE ch.collection_num = ANY($2::int[]) AND ch.tsv @@ q
          AND ($3::text[] IS NULL OR d.kind = ANY($3::text[]))
          AND ($4::text IS NULL OR d.path LIKE $4 || '%')
        ORDER BY r DESC, ch.id LIMIT $5`,
      [query, nums, kinds, prefix, pool],
    );
    found.push(...rows);
  }
  return found
    .sort((a, b) => b.r - a.r || Number(a.id) - Number(b.id))
    .slice(0, pool)
    .map((r, i) => ({ id: r.id, rank: i + 1 }));
}
