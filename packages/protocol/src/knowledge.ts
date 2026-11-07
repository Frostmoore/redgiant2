import { z } from "zod";

/**
 * Knowledge (G36, the RAG): collections of sources (folders, files, web pages, a project's files)
 * cut into pieces with their place (file, page, line), embedded by the model the person chose and
 * searched by meaning and by words together. Shared types of the server, the web page and the
 * `search_knowledge` tool (G36.5).
 */

/** Who a collection is for: every agent, one agent, or the agents working on one project. */
export const KnowledgeScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
]);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

export const KnowledgeCollectionInput = z.object({
  name: z.string().trim().min(1).max(120),
  scope: KnowledgeScope.default({ kind: "all" }),
  /**
   * The language of the words search (a Postgres text search configuration, see
   * `textSearchConfig`); "auto" = the agents' language when the collection is made.
   */
  language: z.string().max(40).default("auto"),
  description: z.string().max(500).optional(),
});
export type KnowledgeCollectionInput = z.input<typeof KnowledgeCollectionInput>;

export interface KnowledgeCollection {
  id: string;
  name: string;
  scope: KnowledgeScope;
  /** The Postgres configuration used for the words (`italian`, `english`, `simple`…). */
  language: string;
  description?: string;
  createdAt: string;
  documents: number;
  chunks: number;
}

/** Folders never looked into, whatever the source says (with `.gitignore` on top). */
export const KNOWLEDGE_SKIPPED_DIRS = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".redgiant",
  ".trash",
  ".Trash",
] as const;

export const KnowledgeSourceInput = z.discriminatedUnion("kind", [
  /** A folder on this computer the person chose (watched for changes). */
  z.object({
    kind: z.literal("folder"),
    path: z.string().min(1),
    /** Extra patterns left out, `.gitignore` style (`*.log`, `secret/`, `!keep.log`). */
    exclude: z.array(z.string().max(200)).max(200).default([]),
    /** Whether the folder's own `.gitignore` files are followed (default yes). */
    gitignore: z.boolean().default(true),
  }),
  /** The files of a project, or of the assistants' desk / God's folder (the Canvas's files). */
  z.object({
    kind: z.literal("workspace"),
    /** `project:<id>`, `assistants` or `platform`. */
    scope: z.string().min(1),
    path: z.string().default("."),
    exclude: z.array(z.string().max(200)).max(200).default([]),
    gitignore: z.boolean().default(true),
  }),
  /** One file (an upload kept in a workspace, or a file on this computer). */
  z.object({ kind: z.literal("file"), path: z.string().min(1), scope: z.string().optional() }),
  /** A web page, read once and again when asked (never with the person's logins). */
  z.object({ kind: z.literal("url"), url: z.url() }),
]);
export type KnowledgeSourceInput = z.input<typeof KnowledgeSourceInput>;

export type KnowledgeSourceState = "waiting" | "scanning" | "ready" | "failed";

export interface KnowledgeSource {
  id: string;
  collectionId: string;
  spec: z.infer<typeof KnowledgeSourceInput>;
  state: KnowledgeSourceState;
  error?: string;
  documents: number;
  lastScanAt: string | null;
}

/** What a document's text came from. */
export type KnowledgeDocKind = "text" | "code" | "markdown" | "pdf" | "office" | "html" | "web";

export type KnowledgeDocState = "pending" | "indexed" | "skipped" | "failed";

export interface KnowledgeDocument {
  id: string;
  sourceId: string;
  collectionId: string;
  /** Path inside the source (folders, workspaces) or the address (web pages). */
  path: string;
  title: string;
  kind: KnowledgeDocKind | null;
  state: KnowledgeDocState;
  /** Why it was skipped or failed (`binary`, `too_big`, `needs_libreoffice`…, or a message). */
  reason?: string;
  pages: number | null;
  chunks: number;
  bytes: number;
  indexedAt: string | null;
}

// ---- Embeddings and rerankers (G36.2) ----

/** Who computes the vectors: llama.cpp on this computer, or a cloud API with a key. */
export const EMBEDDING_PROVIDERS = [
  "local",
  "openai",
  "voyage",
  "cohere",
  "gemini",
  "mistral",
  "jina",
  "compatible",
] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

export const EmbeddingChoice = z.object({
  provider: z.enum(EMBEDDING_PROVIDERS),
  /** The API's model name, or the catalog id of a local model (`qwen3-embedding-0.6b`). */
  model: z.string().min(1).max(200),
  /**
   * Dimensions of the stored vectors. Models trained for it (Matryoshka) are cut down to this;
   * at most 4000 (pgvector's `halfvec` HNSW limit). Unset = the model's own.
   */
  dims: z.number().int().min(16).max(4000).optional(),
  /** `compatible` (and local servers the person runs): the API's address (`…/v1`). */
  baseUrl: z.url().optional(),
  /**
   * The keychain entry holding the key. Unset for openai/gemini/mistral = the provider's key
   * given in the setup.
   */
  credential: z.string().max(48).optional(),
  /** Local only: run on the graphics card (default: the processor, leaving the card to chat). */
  gpu: z.boolean().optional(),
});
export type EmbeddingChoice = z.infer<typeof EmbeddingChoice>;

export const RERANK_PROVIDERS = ["local", "cohere", "voyage", "jina", "compatible"] as const;
export type RerankProviderId = (typeof RERANK_PROVIDERS)[number];

export const RerankChoice = z.object({
  provider: z.enum(RERANK_PROVIDERS),
  model: z.string().min(1).max(200),
  baseUrl: z.url().optional(),
  credential: z.string().max(48).optional(),
  gpu: z.boolean().optional(),
});
export type RerankChoice = z.infer<typeof RerankChoice>;

export interface LocalEmbeddingModel {
  id: string;
  name: string;
  repo: string;
  file: string;
  /** Size of the file, MB (Hugging Face, 2026-11-07). */
  sizeMb: number;
  dims: number;
  /** Matryoshka: the vector can be cut to fewer dimensions. */
  matryoshka: boolean;
  /** Dimensions stored by default (≤ 4000). */
  defaultDims: number;
  /** llama.cpp `--pooling`. */
  pooling: "mean" | "cls" | "last";
  /** Longest input it was trained on, tokens. */
  context: number;
  queryPrefix?: string;
  documentPrefix?: string;
  multilingual: boolean;
  license: string;
  recommended?: boolean;
}

/**
 * Local embedding models (GGUF on Hugging Face, checked 2026-11-07). Multilingual first: the
 * person writes in Italian, the files are often in English.
 */
export const LOCAL_EMBEDDING_MODELS: readonly LocalEmbeddingModel[] = [
  {
    id: "qwen3-embedding-0.6b",
    name: "Qwen3-Embedding 0.6B",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    sizeMb: 639,
    dims: 1024,
    matryoshka: true,
    defaultDims: 1024,
    pooling: "last",
    context: 32768,
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ",
    multilingual: true,
    license: "Apache-2.0",
    recommended: true,
  },
  {
    id: "embeddinggemma-300m",
    name: "EmbeddingGemma 300M",
    repo: "ggml-org/embeddinggemma-300M-GGUF",
    file: "embeddinggemma-300M-Q8_0.gguf",
    sizeMb: 334,
    dims: 768,
    matryoshka: true,
    defaultDims: 768,
    pooling: "mean",
    context: 2048,
    queryPrefix: "task: search result | query: ",
    documentPrefix: "title: none | text: ",
    multilingual: true,
    license: "Gemma",
  },
  {
    id: "bge-m3",
    name: "BGE-M3",
    repo: "ggml-org/bge-m3-Q8_0-GGUF",
    file: "bge-m3-q8_0.gguf",
    sizeMb: 635,
    dims: 1024,
    matryoshka: false,
    defaultDims: 1024,
    pooling: "cls",
    context: 8192,
    multilingual: true,
    license: "MIT",
  },
  {
    id: "nomic-embed-text-v2-moe",
    name: "Nomic Embed Text v2 (MoE)",
    repo: "nomic-ai/nomic-embed-text-v2-moe-GGUF",
    file: "nomic-embed-text-v2-moe.Q8_0.gguf",
    sizeMb: 512,
    dims: 768,
    matryoshka: true,
    defaultDims: 768,
    pooling: "mean",
    context: 512,
    queryPrefix: "search_query: ",
    documentPrefix: "search_document: ",
    multilingual: true,
    license: "Apache-2.0",
  },
  {
    id: "qwen3-embedding-4b",
    name: "Qwen3-Embedding 4B",
    repo: "Qwen/Qwen3-Embedding-4B-GGUF",
    file: "Qwen3-Embedding-4B-Q4_K_M.gguf",
    sizeMb: 2497,
    dims: 2560,
    matryoshka: true,
    defaultDims: 2560,
    pooling: "last",
    context: 32768,
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ",
    multilingual: true,
    license: "Apache-2.0",
  },
  {
    id: "qwen3-embedding-8b",
    name: "Qwen3-Embedding 8B",
    repo: "Qwen/Qwen3-Embedding-8B-GGUF",
    file: "Qwen3-Embedding-8B-Q4_K_M.gguf",
    sizeMb: 4677,
    dims: 4096,
    matryoshka: true,
    // 4096 is beyond halfvec's HNSW limit (4000): cut to half, as the model allows.
    defaultDims: 2048,
    pooling: "last",
    context: 32768,
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ",
    multilingual: true,
    license: "Apache-2.0",
  },
];

export interface LocalRerankModel {
  id: string;
  name: string;
  repo: string;
  file: string;
  sizeMb: number;
  context: number;
  multilingual: boolean;
  license: string;
  recommended?: boolean;
}

export const LOCAL_RERANK_MODELS: readonly LocalRerankModel[] = [
  {
    id: "bge-reranker-v2-m3",
    name: "BGE Reranker v2 M3",
    repo: "gpustack/bge-reranker-v2-m3-GGUF",
    file: "bge-reranker-v2-m3-Q8_0.gguf",
    sizeMb: 636,
    context: 8192,
    multilingual: true,
    license: "Apache-2.0",
    recommended: true,
  },
  {
    id: "qwen3-reranker-0.6b",
    name: "Qwen3-Reranker 0.6B",
    repo: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
    file: "qwen3-reranker-0.6b-q8_0.gguf",
    sizeMb: 639,
    context: 32768,
    multilingual: true,
    license: "Apache-2.0",
  },
];

export interface CloudEmbeddingModel {
  provider: Exclude<EmbeddingProviderId, "local" | "compatible">;
  model: string;
  dims: number;
  /** Dimensions the API can return instead (Matryoshka); the first is the suggested one. */
  sizes?: number[];
  multilingual: boolean;
}

/** Suggestions for the page; any other model name of these APIs is accepted too. */
export const CLOUD_EMBEDDING_MODELS: readonly CloudEmbeddingModel[] = [
  {
    provider: "openai",
    model: "text-embedding-3-small",
    dims: 1536,
    sizes: [1536, 512],
    multilingual: true,
  },
  {
    provider: "openai",
    model: "text-embedding-3-large",
    dims: 3072,
    sizes: [1536, 3072, 1024],
    multilingual: true,
  },
  {
    provider: "voyage",
    model: "voyage-3.5",
    dims: 1024,
    sizes: [1024, 2048, 512, 256],
    multilingual: true,
  },
  {
    provider: "voyage",
    model: "voyage-3.5-lite",
    dims: 1024,
    sizes: [1024, 512, 256],
    multilingual: true,
  },
  {
    provider: "cohere",
    model: "embed-v4.0",
    dims: 1536,
    sizes: [1536, 1024, 512, 256],
    multilingual: true,
  },
  { provider: "cohere", model: "embed-multilingual-v3.0", dims: 1024, multilingual: true },
  {
    provider: "gemini",
    model: "gemini-embedding-001",
    dims: 3072,
    sizes: [1536, 3072, 768],
    multilingual: true,
  },
  { provider: "mistral", model: "mistral-embed", dims: 1024, multilingual: true },
  {
    provider: "jina",
    model: "jina-embeddings-v3",
    dims: 1024,
    sizes: [1024, 512, 256],
    multilingual: true,
  },
];

/** The cloud APIs' addresses (`compatible` brings its own). */
export const EMBEDDING_API_URLS: Record<
  Exclude<EmbeddingProviderId, "local" | "compatible">,
  string
> = {
  openai: "https://api.openai.com/v1",
  voyage: "https://api.voyageai.com/v1",
  cohere: "https://api.cohere.com/v2",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  mistral: "https://api.mistral.ai/v1",
  jina: "https://api.jina.ai/v1",
};

export interface KnowledgeIndexInfo {
  id: number;
  provider: EmbeddingProviderId;
  model: string;
  dims: number;
  /** `building`: being filled (the active one still answers); `ready`: answers searches. */
  state: "building" | "ready" | "retired" | "failed";
  active: boolean;
  /** Pieces with their vector / all pieces. */
  embedded: number;
  total: number;
  /** HNSW graph built (otherwise searches are exact, fine while small). */
  ann: boolean;
  error?: string;
  createdAt: string;
  readyAt: string | null;
}

export interface KnowledgeSettings {
  embedding: EmbeddingChoice | null;
  rerank: RerankChoice | null;
  /** Processor threads the local models and the indexer may use (0 = decided by RedGiant). */
  threads: number;
}

export interface KnowledgeStatus {
  /** pgvector is there and loaded (`version`), or why not. */
  vector: { ok: true; version: string } | { ok: false; reason: string };
  settings: KnowledgeSettings;
  indexes: KnowledgeIndexInfo[];
  queue: {
    /** Documents waiting to be read and cut. */
    documents: number;
    /** Pieces waiting for a vector, in the index being filled first. */
    chunks: number;
    running: boolean;
    paused: boolean;
    /** What it is doing now, for the page. */
    doing?: string;
    error?: string;
  };
  collections: number;
}

// ---- Search (G36.4) ----

export const KnowledgeSearchInput = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Only these collections (otherwise every one the asker can see). */
  collections: z.array(z.string()).max(100).optional(),
  /** Only documents of these kinds. */
  kinds: z.array(z.enum(["text", "code", "markdown", "pdf", "office", "html", "web"])).optional(),
  /** Only paths starting with this (inside the source). */
  pathPrefix: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(50).default(8),
  /** `meaning` only vectors, `words` only text, `both` (default) fused with RRF. */
  mode: z.enum(["both", "meaning", "words"]).default("both"),
  /** Use the reranker when one is set (default yes). */
  rerank: z.boolean().default(true),
  /** Search harder (HNSW ef_search 200 instead of 100). */
  accurate: z.boolean().default(false),
});
export type KnowledgeSearchInput = z.input<typeof KnowledgeSearchInput>;

/** Where a piece is: enough to open it in the Canvas at the right point. */
export interface KnowledgeCitation {
  collectionId: string;
  documentId: string;
  chunkId: string;
  /** The source's kind and where the file is (a workspace scope, a folder, a web address). */
  source: "folder" | "workspace" | "file" | "url";
  /** `project:<id>` / `assistants` / `platform` for workspace files. */
  scope?: string;
  /** Path inside the scope or folder, or the address. */
  path: string;
  title: string;
  /** Section or symbol the piece belongs to. */
  heading?: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
}

export interface KnowledgeHit {
  citation: KnowledgeCitation;
  text: string;
  score: number;
  /** Ranks before fusion (1 = first), for the page's explanation. */
  ranks: { meaning?: number; words?: number; rerank?: number };
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** How it searched: exact inside a small scope, partial index, HNSW with iterative scan. */
  strategy: "exact" | "partial" | "hnsw" | "words";
  indexId: number | null;
  ms: number;
  /** Search done with words only, and why (no model chosen, the model failing…). */
  wordsOnly?: string;
}

/** Postgres text search configuration for a BCP-47 language (`simple` when Postgres has none). */
export function textSearchConfig(code: string | undefined): string {
  const base = (code ?? "").toLowerCase().split("-")[0] ?? "";
  return TEXT_SEARCH_CONFIGS[base] ?? "simple";
}

const TEXT_SEARCH_CONFIGS: Record<string, string> = {
  ar: "arabic",
  hy: "armenian",
  eu: "basque",
  ca: "catalan",
  da: "danish",
  nl: "dutch",
  en: "english",
  et: "estonian",
  fi: "finnish",
  fr: "french",
  de: "german",
  el: "greek",
  hi: "hindi",
  hu: "hungarian",
  id: "indonesian",
  ga: "irish",
  it: "italian",
  lt: "lithuanian",
  ne: "nepali",
  nb: "norwegian",
  nn: "norwegian",
  no: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sr: "serbian",
  es: "spanish",
  sv: "swedish",
  ta: "tamil",
  tr: "turkish",
  yi: "yiddish",
};

/** The configurations a collection may use (the ones in every Postgres RedGiant runs). */
export const TEXT_SEARCH_CONFIG_NAMES = [
  "simple",
  ...new Set(Object.values(TEXT_SEARCH_CONFIGS)),
].sort();
