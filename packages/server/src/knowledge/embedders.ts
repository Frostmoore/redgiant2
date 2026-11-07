// Embeddings and rerankers the person chooses (G36.2): llama.cpp on this computer (an
// OpenAI-compatible server we start, see local-embed.ts) or a cloud API. Every one turns texts
// into unit vectors of the index's dimensions; queries and documents are told apart where the
// model wants it (prefixes, `input_type`, task types). Keys never reach the code here: requests
// go through `KeyedFetch`, which puts the key on (setup key or keychain entry) for that host only.

import {
  EMBEDDING_API_URLS,
  type EmbeddingChoice,
  LOCAL_EMBEDDING_MODELS,
  type LocalEmbeddingModel,
  type RerankChoice,
} from "@redgiant/protocol";

/** A request with the key put on by the caller: `key` marks where it goes in the headers. */
export type KeyedFetch = (
  url: string,
  init: { method: "POST" | "GET"; headers: Record<string, string>; body?: string },
  key: { header: string; format: string } | null,
  signal?: AbortSignal,
) => Promise<Response>;

export type EmbedKind = "document" | "query";

export interface Embedder {
  /** Dimensions of the vectors returned (after cutting a Matryoshka model). */
  readonly dims: number;
  /** Most texts sent in one request. */
  readonly batch: number;
  /** Longest text sent, characters (longer ones are cut: the piece's start carries its meaning). */
  readonly maxChars: number;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<number[][]>;
}

export interface Reranker {
  /** Scores of each document for the query, same order, higher = better. */
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>;
}

export class EmbeddingError extends Error {
  constructor(
    readonly code: "key_missing" | "http" | "bad_answer" | "dims" | "unreachable",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** The vector cut to `dims` (Matryoshka) and made unit length (cosine = dot product). */
export function normalize(v: number[], dims?: number): number[] {
  const cut = dims && v.length > dims ? v.slice(0, dims) : v;
  let s = 0;
  for (const x of cut) s += x * x;
  const n = Math.sqrt(s);
  return n > 0 ? cut.map((x) => x / n) : cut;
}

/** A vector as pgvector reads it, at the precision halfvec keeps. */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toPrecision(5)) : 0)).join(",")}]`;
}

export function localModel(id: string): LocalEmbeddingModel | undefined {
  return LOCAL_EMBEDDING_MODELS.find((m) => m.id === id);
}

const bearer = { header: "Authorization", format: "Bearer {value}" };

async function postJson(
  fetchKeyed: KeyedFetch,
  url: string,
  body: unknown,
  key: { header: string; format: string } | null,
  signal?: AbortSignal,
): Promise<unknown> {
  let r: Response;
  try {
    r = await fetchKeyed(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      },
      key,
      signal,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    if (err instanceof EmbeddingError) throw err;
    throw new EmbeddingError("unreachable", `${url}: ${(err as Error).message}`);
  }
  const text = await r.text();
  if (!r.ok)
    throw new EmbeddingError(
      "http",
      `${new URL(url).host} answered ${r.status}: ${text.slice(0, 300)}`,
      r.status,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new EmbeddingError("bad_answer", `${new URL(url).host} did not answer JSON`);
  }
}

function vectorsOf(raw: unknown, count: number, pick: (raw: unknown) => unknown): number[][] {
  const list = pick(raw);
  if (!Array.isArray(list) || list.length !== count)
    throw new EmbeddingError("bad_answer", `Expected ${count} vectors`);
  return list.map((v) => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "number"))
      throw new EmbeddingError("bad_answer", "A vector is not a list of numbers");
    return v as number[];
  });
}

/** `data: [{index, embedding}]` (OpenAI, Mistral, Jina, Voyage, llama.cpp), in index order. */
function openAiData(raw: unknown): unknown {
  const data = (raw as { data?: { index?: number; embedding?: unknown }[] }).data;
  if (!Array.isArray(data)) return undefined;
  return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
}

const cut = (texts: string[], max: number) =>
  texts.map((t) => (t.length > max ? t.slice(0, max) : t));

/** The API's own vector size for models with known sizes, else what it returns. */
interface EmbedderSpec {
  choice: EmbeddingChoice;
  dims: number;
  fetch: KeyedFetch;
  /** Address of the local server (`http://127.0.0.1:<port>/v1`) for `local`. */
  localUrl?: () => Promise<string>;
}

/**
 * The embedder for a choice. `dims` is the index's: vectors are cut (Matryoshka) and checked
 * against it, so a model answering with another size fails loudly instead of filling the table
 * with nonsense.
 */
export function makeEmbedder(s: EmbedderSpec): Embedder {
  const { choice, dims } = s;
  const check = (vs: number[][]) =>
    vs.map((v) => {
      if (v.length < dims)
        throw new EmbeddingError("dims", `The model gave ${v.length} dimensions, not ${dims}`);
      return normalize(v, dims);
    });
  const base = (
    choice.baseUrl ??
    (choice.provider === "local" || choice.provider === "compatible"
      ? ""
      : EMBEDDING_API_URLS[choice.provider])
  ).replace(/\/+$/, "");
  switch (choice.provider) {
    case "local": {
      const m = localModel(choice.model);
      // ~3 characters a token, the server's slot is 2048 tokens (local-embed.ts).
      const maxChars = Math.min(6000, Math.floor((m?.context ?? 2048) * 3));
      return {
        dims,
        batch: 16,
        maxChars,
        async embed(texts, kind, signal) {
          const url = `${await (s.localUrl?.() ?? Promise.reject(new EmbeddingError("unreachable", "No local server")))}/embeddings`;
          const prefix = kind === "query" ? m?.queryPrefix : m?.documentPrefix;
          const input = cut(texts, maxChars).map((t) => (prefix ? prefix + t : t));
          const raw = await postJson(
            s.fetch,
            url,
            { input, encoding_format: "float" },
            null,
            signal,
          );
          return check(vectorsOf(raw, texts.length, openAiData));
        },
      };
    }
    case "openai":
    case "compatible":
    case "mistral": {
      if (!base) throw new EmbeddingError("unreachable", "The server's address is missing");
      const sizeParam =
        choice.dims === undefined
          ? {}
          : choice.provider === "mistral"
            ? choice.model.startsWith("codestral-embed")
              ? { output_dimension: choice.dims }
              : {}
            : { dimensions: choice.dims };
      return {
        dims,
        batch: choice.provider === "mistral" ? 64 : 128,
        maxChars: 8000,
        async embed(texts, _kind, signal) {
          const raw = await postJson(
            s.fetch,
            `${base}/embeddings`,
            {
              model: choice.model,
              input: cut(texts, 8000),
              encoding_format: "float",
              ...sizeParam,
            },
            bearer,
            signal,
          );
          return check(vectorsOf(raw, texts.length, openAiData));
        },
      };
    }
    case "jina":
      return {
        dims,
        batch: 128,
        maxChars: 8000,
        async embed(texts, kind, signal) {
          const raw = await postJson(
            s.fetch,
            `${base}/embeddings`,
            {
              model: choice.model,
              input: cut(texts, 8000),
              task: kind === "query" ? "retrieval.query" : "retrieval.passage",
              ...(choice.dims !== undefined && { dimensions: choice.dims }),
            },
            bearer,
            signal,
          );
          return check(vectorsOf(raw, texts.length, openAiData));
        },
      };
    case "voyage":
      return {
        dims,
        batch: 128,
        maxChars: 8000,
        async embed(texts, kind, signal) {
          const raw = await postJson(
            s.fetch,
            `${base}/embeddings`,
            {
              model: choice.model,
              input: cut(texts, 8000),
              input_type: kind,
              ...(choice.dims !== undefined && { output_dimension: choice.dims }),
            },
            bearer,
            signal,
          );
          return check(vectorsOf(raw, texts.length, openAiData));
        },
      };
    case "cohere":
      return {
        dims,
        batch: 96,
        maxChars: 8000,
        async embed(texts, kind, signal) {
          const raw = await postJson(
            s.fetch,
            `${base}/embed`,
            {
              model: choice.model,
              texts: cut(texts, 8000),
              input_type: kind === "query" ? "search_query" : "search_document",
              embedding_types: ["float"],
              ...(choice.dims !== undefined && { output_dimension: choice.dims }),
            },
            bearer,
            signal,
          );
          return check(
            vectorsOf(
              raw,
              texts.length,
              (r) => (r as { embeddings?: { float?: unknown } }).embeddings?.float,
            ),
          );
        },
      };
    case "gemini":
      return {
        dims,
        batch: 100,
        maxChars: 6000,
        async embed(texts, kind, signal) {
          const model = choice.model.startsWith("models/")
            ? choice.model
            : `models/${choice.model}`;
          const raw = await postJson(
            s.fetch,
            `${base}/${model}:batchEmbedContents`,
            {
              requests: cut(texts, 6000).map((t) => ({
                model,
                content: { parts: [{ text: t }] },
                taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
                ...(choice.dims !== undefined && { outputDimensionality: choice.dims }),
              })),
            },
            { header: "x-goog-api-key", format: "{value}" },
            signal,
          );
          return check(
            vectorsOf(raw, texts.length, (r) =>
              (r as { embeddings?: { values?: unknown }[] }).embeddings?.map((e) => e.values),
            ),
          );
        },
      };
  }
}

const RERANK_URLS: Record<"cohere" | "voyage" | "jina", string> = {
  cohere: "https://api.cohere.com/v2",
  voyage: "https://api.voyageai.com/v1",
  jina: "https://api.jina.ai/v1",
};

/** `results: [{index, relevance_score}]` (Cohere, Jina, llama.cpp) or `data: […]` (Voyage). */
function scoresOf(raw: unknown, count: number): number[] {
  const r = raw as {
    results?: { index: number; relevance_score?: number; score?: number }[];
    data?: { index: number; relevance_score?: number }[];
  };
  const list = r.results ?? r.data;
  if (!Array.isArray(list)) throw new EmbeddingError("bad_answer", "No rerank results");
  const out = new Array<number>(count).fill(Number.NEGATIVE_INFINITY);
  for (const x of list) {
    const score = x.relevance_score ?? (x as { score?: number }).score;
    if (typeof x.index === "number" && x.index >= 0 && x.index < count && typeof score === "number")
      out[x.index] = score;
  }
  return out;
}

export function makeReranker(
  choice: RerankChoice,
  fetchKeyed: KeyedFetch,
  localUrl?: () => Promise<string>,
): Reranker {
  return {
    async rerank(query, documents, signal) {
      if (documents.length === 0) return [];
      const docs = cut(documents, 4000);
      if (choice.provider === "local" || choice.provider === "compatible") {
        const base =
          choice.provider === "local"
            ? await (localUrl?.() ??
                Promise.reject(new EmbeddingError("unreachable", "No local server")))
            : (choice.baseUrl ?? "").replace(/\/+$/, "");
        const raw = await postJson(
          fetchKeyed,
          `${base}/rerank`,
          { model: choice.model, query, documents: docs, top_n: docs.length },
          choice.provider === "local" ? null : bearer,
          signal,
        );
        return scoresOf(raw, docs.length);
      }
      const base = (choice.baseUrl ?? RERANK_URLS[choice.provider]).replace(/\/+$/, "");
      const body =
        choice.provider === "voyage"
          ? { model: choice.model, query, documents: docs, top_k: docs.length }
          : { model: choice.model, query, documents: docs, top_n: docs.length };
      const raw = await postJson(fetchKeyed, `${base}/rerank`, body, bearer, signal);
      return scoresOf(raw, docs.length);
    },
  };
}
