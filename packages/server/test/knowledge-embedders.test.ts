import { describe, expect, it } from "vitest";
import {
  EmbeddingError,
  type KeyedFetch,
  makeEmbedder,
  makeReranker,
  normalize,
  vectorLiteral,
} from "../src/knowledge/embedders.js";
import { embedThreads, llamaArgs, llamaAsset } from "../src/knowledge/local-embed.js";
import { knownDims, sameIndex } from "../src/knowledge/service.js";

/** Records each request and answers with what the API in question would (never a real model). */
function recorder(answer: (url: string, body: Record<string, unknown>) => unknown, status = 200) {
  const seen: {
    url: string;
    body: Record<string, unknown>;
    key: unknown;
    headers: Record<string, string>;
  }[] = [];
  const fetch: KeyedFetch = async (url, init, key) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    seen.push({ url, body, key, headers: init.headers });
    return status === 200 ? Response.json(answer(url, body)) : new Response("nope", { status });
  };
  return { fetch, seen };
}

const vec = (n: number, x = 1) => Array.from({ length: n }, (_, i) => (i === 0 ? x : 0.5));

describe("knowledge: embedding APIs", () => {
  it("OpenAI: dimensions asked, vectors in index order, cut and made unit length", async () => {
    const r = recorder((_u, b) => ({
      data: (b.input as string[]).map((_, i) => ({ index: i, embedding: vec(8, i + 1) })).reverse(),
    }));
    const e = makeEmbedder({
      choice: { provider: "openai", model: "text-embedding-3-small", dims: 4 },
      dims: 4,
      fetch: r.fetch,
    });
    const out = await e.embed(["a", "b"], "document");
    expect(r.seen[0]).toMatchObject({
      url: "https://api.openai.com/v1/embeddings",
      body: { model: "text-embedding-3-small", input: ["a", "b"], dimensions: 4 },
      key: { header: "Authorization", format: "Bearer {value}" },
    });
    expect(out.map((v) => v.length)).toEqual([4, 4]);
    expect(out[0]?.[0]).toBeLessThan(out[1]?.[0] as number);
    expect(Math.hypot(...(out[0] as number[]))).toBeCloseTo(1, 6);
  });

  it("Voyage, Cohere, Jina, Mistral and Gemini: their own words for queries and documents", async () => {
    const data = (b: Record<string, unknown>, field: string) =>
      (b[field] as unknown[]).map((_, index) => ({ index, embedding: vec(6) }));
    const voyage = recorder((_u, b) => ({ data: data(b, "input") }));
    await makeEmbedder({
      choice: { provider: "voyage", model: "voyage-3.5", dims: 6 },
      dims: 6,
      fetch: voyage.fetch,
    }).embed(["q"], "query");
    expect(voyage.seen[0]).toMatchObject({
      url: "https://api.voyageai.com/v1/embeddings",
      body: { input_type: "query", output_dimension: 6 },
    });
    const cohere = recorder((_u, b) => ({
      embeddings: { float: (b.texts as string[]).map(() => vec(6)) },
    }));
    await makeEmbedder({
      choice: { provider: "cohere", model: "embed-v4.0" },
      dims: 6,
      fetch: cohere.fetch,
    }).embed(["d"], "document");
    expect(cohere.seen[0]).toMatchObject({
      url: "https://api.cohere.com/v2/embed",
      body: { input_type: "search_document", embedding_types: ["float"] },
    });
    const jina = recorder((_u, b) => ({ data: data(b, "input") }));
    await makeEmbedder({
      choice: { provider: "jina", model: "jina-embeddings-v3" },
      dims: 6,
      fetch: jina.fetch,
    }).embed(["q"], "query");
    expect(jina.seen[0]?.body.task).toBe("retrieval.query");
    const mistral = recorder((_u, b) => ({ data: data(b, "input") }));
    await makeEmbedder({
      choice: { provider: "mistral", model: "mistral-embed", dims: 6 },
      dims: 6,
      fetch: mistral.fetch,
    }).embed(["d"], "document");
    expect(mistral.seen[0]?.url).toBe("https://api.mistral.ai/v1/embeddings");
    // mistral-embed has one size: no size parameter sent.
    expect(mistral.seen[0]?.body).not.toHaveProperty("dimensions");
    expect(mistral.seen[0]?.body).not.toHaveProperty("output_dimension");
    const gemini = recorder((_u, b) => ({
      embeddings: (b.requests as unknown[]).map(() => ({ values: vec(6) })),
    }));
    await makeEmbedder({
      choice: { provider: "gemini", model: "gemini-embedding-001", dims: 6 },
      dims: 6,
      fetch: gemini.fetch,
    }).embed(["q"], "query");
    expect(gemini.seen[0]).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
      key: { header: "x-goog-api-key", format: "{value}" },
    });
    expect(
      (gemini.seen[0]?.body.requests as Record<string, unknown>[] | undefined)?.[0],
    ).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: 6,
      model: "models/gemini-embedding-001",
    });
  });

  it("local models: the catalog's prefixes, no key, the local server's address", async () => {
    const r = recorder((_u, b) => ({
      data: (b.input as string[]).map((_, index) => ({ index, embedding: vec(768) })),
    }));
    const e = makeEmbedder({
      choice: { provider: "local", model: "nomic-embed-text-v2-moe" },
      dims: 768,
      fetch: r.fetch,
      localUrl: async () => "http://127.0.0.1:5000/v1",
    });
    await e.embed(["what is it"], "query");
    await e.embed(["a document"], "document");
    expect(r.seen.map((s) => [s.url, (s.body.input as string[])[0], s.key])).toEqual([
      ["http://127.0.0.1:5000/v1/embeddings", "search_query: what is it", null],
      ["http://127.0.0.1:5000/v1/embeddings", "search_document: a document", null],
    ]);
  });

  it("fails loudly on a short vector, a wrong count or an HTTP error", async () => {
    const short = recorder(() => ({ data: [{ index: 0, embedding: [1, 2] }] }));
    const e = makeEmbedder({
      choice: { provider: "openai", model: "m" },
      dims: 4,
      fetch: short.fetch,
    });
    await expect(e.embed(["x"], "document")).rejects.toMatchObject({ code: "dims" });
    await expect(e.embed(["x", "y"], "document")).rejects.toMatchObject({ code: "bad_answer" });
    const refused = recorder(() => ({}), 401);
    await expect(
      makeEmbedder({
        choice: { provider: "openai", model: "m" },
        dims: 4,
        fetch: refused.fetch,
      }).embed(["x"], "document"),
    ).rejects.toMatchObject({ code: "http", status: 401 });
    expect(() =>
      makeEmbedder({
        choice: { provider: "compatible", model: "m" },
        dims: 4,
        fetch: refused.fetch,
      }),
    ).toThrow(EmbeddingError);
  });

  it("writes vectors as pgvector reads them, at halfvec's precision", () => {
    expect(vectorLiteral([0.123456789, -1, Number.NaN])).toBe("[0.12346,-1,0]");
    expect(normalize([3, 4, 12], 2)).toEqual([0.6, 0.8]);
  });
});

describe("knowledge: rerankers", () => {
  it("Cohere-shaped answers (Cohere, Jina, llama.cpp) and Voyage's", async () => {
    const results = {
      results: [
        { index: 1, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.2 },
      ],
    };
    const cohere = recorder(() => results);
    expect(
      await makeReranker({ provider: "cohere", model: "rerank-v3.5" }, cohere.fetch).rerank("q", [
        "a",
        "b",
      ]),
    ).toEqual([0.2, 0.9]);
    expect(cohere.seen[0]).toMatchObject({
      url: "https://api.cohere.com/v2/rerank",
      body: { top_n: 2 },
    });
    const local = recorder(() => results);
    await makeReranker(
      { provider: "local", model: "bge-reranker-v2-m3" },
      local.fetch,
      async () => "http://127.0.0.1:9/v1",
    ).rerank("q", ["a", "b"]);
    expect(local.seen[0]).toMatchObject({ url: "http://127.0.0.1:9/v1/rerank", key: null });
    const voyage = recorder(() => ({ data: [{ index: 0, relevance_score: 0.5 }] }));
    expect(
      await makeReranker({ provider: "voyage", model: "rerank-2.5" }, voyage.fetch).rerank("q", [
        "a",
        "b",
      ]),
    ).toEqual([0.5, Number.NEGATIVE_INFINITY]);
    expect(voyage.seen[0]?.body).toMatchObject({ top_k: 2 });
  });
});

describe("knowledge: local llama.cpp server", () => {
  it("runs the embedding and rerank modes with few threads and fixed slots", () => {
    const a = llamaArgs({
      model: "/m/x.gguf",
      role: "embed",
      pooling: "last",
      port: 5001,
      threads: 2,
      gpu: false,
    });
    expect(a).toEqual(
      expect.arrayContaining([
        "--embedding",
        "--pooling",
        "last",
        "-t",
        "2",
        "--n-gpu-layers",
        "0",
        "--host",
        "127.0.0.1",
      ]),
    );
    expect(a[a.indexOf("-ub") + 1]).toBe("2048");
    const r = llamaArgs({ model: "/m/r.gguf", role: "rerank", port: 5002, threads: 4, gpu: true });
    expect(r).toContain("--reranking");
    expect(r).not.toContain("--pooling");
    expect(r[r.indexOf("--n-gpu-layers") + 1]).toBe("999");
  });

  it("picks the build of each system, with its sha256", () => {
    expect(llamaAsset(false, "win32", "x64")?.file).toBe("llama-b12034-bin-win-cpu-x64.zip");
    expect(llamaAsset(true, "win32", "x64")?.file).toBe("llama-b12034-bin-win-vulkan-x64.zip");
    expect(llamaAsset(true, "darwin", "arm64")?.file).toBe("llama-b12034-bin-macos-arm64.tar.gz");
    expect(llamaAsset(false, "linux", "arm64")?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(llamaAsset(false, "freebsd", "x64")).toBeUndefined();
  });

  it("leaves most of the processor free", () => {
    expect(embedThreads(0, 2)).toBe(1);
    expect(embedThreads(0, 8)).toBe(4);
    expect(embedThreads(0, 32)).toBe(4);
    expect(embedThreads(6, 4)).toBe(4);
  });
});

describe("knowledge: index identity", () => {
  it("knows the sizes of catalog models and when two choices share an index", () => {
    expect(knownDims({ provider: "local", model: "qwen3-embedding-8b" })).toBe(2048);
    expect(knownDims({ provider: "openai", model: "text-embedding-3-large" })).toBe(3072);
    expect(
      knownDims({ provider: "compatible", model: "x", baseUrl: "http://h/v1" }),
    ).toBeUndefined();
    const a = { provider: "openai" as const, model: "m" };
    expect(sameIndex(a, { ...a, credential: "k" }, 8, 8)).toBe(true);
    expect(sameIndex(a, a, 8, 16)).toBe(false);
  });
});
