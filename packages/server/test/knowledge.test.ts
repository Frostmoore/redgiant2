import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, migrate, pgPoolClient, type SqlClient } from "@redgiant/events";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { EmbeddingError, type KeyedFetch, normalize } from "../src/knowledge/embedders.js";
import { capMemory, Indexer } from "../src/knowledge/indexer.js";
import { LocalEmbedServers } from "../src/knowledge/local-embed.js";
import { rrf, vectorSql } from "../src/knowledge/search.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { OTHER, startServer } from "./helpers.js";
import { memoryDb } from "./pglite.js";

/**
 * A fake embedding API (never a real model): each word lights a few dimensions chosen by its
 * hash, so texts sharing words are close. Counts the texts it was asked for.
 */
function fakeApi(dims: number) {
  const calls = { texts: 0, requests: 0, fail: 0 as number };
  const embed = (t: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const w of t.toLowerCase().match(/[a-zà-ú0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      for (let j = 0; j < 3; j++) {
        const i = Math.abs(h + j * 7919) % dims;
        v[i] = (v[i] ?? 0) + ((h >> j) & 1 ? 1 : -1) * (j === 0 ? 2 : 1);
      }
    }
    return normalize(v);
  };
  const keyed: KeyedFetch = async (url, init) => {
    calls.requests++;
    if (calls.fail) {
      calls.fail--;
      return new Response("bad key", { status: 401 });
    }
    if (!url.endsWith("/embeddings")) return new Response("no", { status: 404 });
    const body = JSON.parse(init.body ?? "{}") as { input: string[] };
    calls.texts += body.input.length;
    return Response.json({ data: body.input.map((t, index) => ({ index, embedding: embed(t) })) });
  };
  return { keyed, calls, embed };
}

let dir: string;
let cleanup: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-kb-"));
});
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

/**
 * The database of a test: PGlite with pgvector, or a real Postgres when REDGIANT_KB_PG_URL is set
 * (a fresh database each time; the same tests run against Postgres 17 in Docker and the native 18).
 */
async function testDb(): Promise<SqlClient> {
  const url = process.env.REDGIANT_KB_PG_URL;
  if (!url) return (await memoryDb()).db;
  const name = `kb_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 4 });
  cleanup.push(async () => {
    await pool.end();
    const a = new pg.Client({ connectionString: url });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return pgPoolClient(pool);
}

async function setup(dims = 32, api = fakeApi(dims)) {
  const db = await testDb();
  await migrate(db);
  const store = new EventStore(db);
  const jobs = new Jobs();
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  const k = new KnowledgeService({
    db,
    store,
    jobs,
    dataDir,
    local: new LocalEmbedServers({ dataDir, jobs }),
    keyedFetch: () => api.keyed,
    scopeRoot: async (_o, scope) => {
      if (scope === "project:alpha") return join(dir, "alpha");
      throw new Error(`no scope ${scope}`);
    },
    agentLanguage: () => "it",
    manual: true,
  });
  await k.start();
  cleanup.push(() => k.stop());
  return { k, db, store, api };
}

const fake = { provider: "compatible" as const, model: "fake", baseUrl: "http://fake.test/v1" };

async function folder(files: Record<string, string>) {
  const root = join(dir, "docs");
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), text);
  }
  // The citation gives the real path (macOS: /var is /private/var; Windows: no short names).
  return realpath(root);
}

describe("knowledge: schema, indexing and search", () => {
  it("indexes a folder and finds pieces by meaning and by words, with their place", async () => {
    const { k, store, api } = await setup();
    expect(k.vector).toEqual({ ok: true, version: "0.8.7" });
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Manuali" });
    expect(c.language).toBe("italian");
    const root = await folder({
      "install.md":
        "# Installare\n\nScarica il programma.\n\n## Windows\n\nApri RedGiant-Setup.exe e segui i passi.\n\n## Mac\n\nTrascina l'app nella cartella Applicazioni.\n",
      "src/db.ts":
        "import x from 'y';\n\nexport function startDatabase(port: number) {\n  return port + 1;\n}\n\nexport function stopDatabase() {\n  return 0;\n}\n",
      "node_modules/skip.js": "export const nothing = 1;\n",
      ".env": "SECRET=1\n",
      "logo.png": "\u0089PNG\r\n",
    });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    const docs = await k.documents("me", c.id);
    expect(docs.map((d) => [d.path, d.state])).toEqual([
      ["install.md", "indexed"],
      ["logo.png", "skipped"],
      ["src/db.ts", "indexed"],
    ]);
    const status = await k.status("me");
    expect(status.indexes[0]).toMatchObject({
      active: true,
      state: "ready",
      embedded: status.indexes[0]?.total,
    });
    expect(api.calls.texts).toBeGreaterThan(0);

    const r = await k.search("me", { query: "trascina app cartella applicazioni mac" });
    expect(r.strategy).toBe("exact");
    // Small sections of one chapter travel together: the piece starts at its chapter.
    expect(r.hits[0]?.citation).toMatchObject({
      source: "folder",
      heading: "Installare",
      lineStart: 1,
    });
    expect(r.hits[0]?.text).toContain("Trascina");
    expect(r.hits[0]?.ranks.meaning).toBe(1);

    const words = await k.search("me", { query: "stopDatabase", mode: "words" });
    expect(words.hits[0]?.citation.heading).toContain("stopDatabase");
    expect(words.hits[0]?.citation.path).toBe(join(root, "src", "db.ts"));

    const opened = await k.open("me", words.hits[0]?.citation.chunkId as string);
    expect(opened).toMatchObject({ target: { kind: "file", scope: "outside", at: { line: 7 } } });
    expect(await k.holds("me", join(root, "src", "db.ts"))).toBe(true);
    expect(await k.holds("me", join(dir, "elsewhere.txt"))).toBe(false);

    const events = await store.list({ types: ["knowledge.changed"] });
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual([
      "index.started",
      "settings.changed",
      "collection.created",
      "source.added",
      "index.ready",
    ]);
  });

  it("re-reads only what changed, keeps the vectors of unchanged pieces, follows moves and deletions", async () => {
    const { k, api } = await setup();
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Note", language: "simple" });
    const long = Array.from({ length: 12 }, (_, i) =>
      `Paragraph ${i} talks about topic${i} at length. `.repeat(8),
    ).join("\n\n");
    const root = await folder({
      "a.txt": long,
      "b.txt": "Something about bees and honey.\n",
      "c.txt": "Cats sleep a lot.\n",
    });
    const src = await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    const before = await k.documents("me", c.id);
    const first = api.calls.texts;
    expect(first).toBeGreaterThan(4);

    // a.txt changes at the end only: one piece is new, the others keep their vectors.
    await writeFile(join(root, "a.txt"), `${long}\n\nA new closing paragraph about zebras.`);
    // b.txt moves (same content): renamed in place, nothing read or embedded again.
    await mkdir(join(root, "sub"));
    await rename(join(root, "b.txt"), join(root, "sub", "b.txt"));
    // c.txt goes.
    await rm(join(root, "c.txt"));
    k.indexer.rescan(src.id, false);
    await k.indexer.drain();
    const after = await k.documents("me", c.id);
    expect(after.map((d) => d.path)).toEqual(["a.txt", "sub/b.txt"]);
    expect(after.find((d) => d.path === "sub/b.txt")?.id).toBe(
      before.find((d) => d.path === "b.txt")?.id,
    );
    expect(api.calls.texts - first).toBeLessThanOrEqual(2);
    const s = await k.status("me");
    expect(s.indexes[0]?.embedded).toBe(s.indexes[0]?.total);
    const z = await k.search("me", { query: "zebras closing paragraph" });
    expect(z.hits[0]?.text).toContain("zebras");
    const gone = await k.search("me", { query: "cats sleep", mode: "words" });
    expect(gone.hits).toEqual([]);
  });

  it("changes model in the background: the old index answers until the new one is complete", async () => {
    const api = fakeApi(32);
    const { k, store } = await setup(32, api);
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Docs" });
    const root = await folder({
      "x.md": "# Alpha\n\nalpha beta gamma\n\n# Delta\n\ndelta epsilon\n",
    });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    const old = (await k.status("me")).indexes[0];
    // Another model of 24 dimensions: a new table, filled while the old one answers.
    await k.setSettings("me", { embedding: { ...fake, model: "fake-2", dims: 24 } });
    let s = await k.status("me");
    expect(s.indexes.map((i) => [i.dims, i.active, i.state])).toEqual([
      [32, true, "ready"],
      [24, false, "building"],
    ]);
    const during = await k.search("me", { query: "delta epsilon" });
    expect(during.indexId).toBe(old?.id);
    expect(during.hits[0]?.text).toContain("delta");
    await k.indexer.drain();
    s = await k.status("me");
    expect(s.indexes.map((i) => [i.dims, i.active, i.state])).toEqual([[24, true, "ready"]]);
    const after = await k.search("me", { query: "delta epsilon" });
    expect(after.indexId).not.toBe(old?.id);
    expect(after.hits[0]?.text).toContain("delta");
    const actions = (await store.list({ types: ["knowledge.changed"] })).map(
      (e) => (e.payload as { action: string }).action,
    );
    expect(actions.slice(-2)).toEqual(["index.ready", "index.retired"]);
    // The same choice again is no new index.
    await k.setSettings("me", { embedding: { ...fake, model: "fake-2", dims: 24 } });
    expect((await k.status("me")).indexes).toHaveLength(1);
  });

  it("shows each agent only the collections of its scope", async () => {
    const { k } = await setup();
    await k.setSettings("me", { embedding: fake });
    const all = await k.createCollection("me", { name: "All", language: "simple" });
    const mine = await k.createCollection("me", {
      name: "Agent",
      language: "simple",
      scope: { kind: "agent", agentId: "a1" },
    });
    const proj = await k.createCollection("me", {
      name: "Proj",
      language: "simple",
      scope: { kind: "project", projectId: "alpha" },
    });
    for (const [col, word] of [
      [all, "shared"],
      [mine, "private"],
      [proj, "project"],
    ] as const) {
      const root = join(dir, col.name);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "f.txt"), `the ${word} word lives here\n`);
      await k.addSource("me", col.id, { kind: "folder", path: root });
    }
    await k.indexer.drain();
    const names = async (asker: Parameters<KnowledgeService["search"]>[2]) =>
      (await k.search("me", { query: "word lives here", mode: "words", limit: 10 }, asker)).hits
        .map((h) => h.citation.collectionId)
        .sort();
    expect(await names({ kind: "human" })).toEqual([all.id, mine.id, proj.id].sort());
    expect(await names({ kind: "agent", agentId: "a1", projectIds: [] })).toEqual(
      [all.id, mine.id].sort(),
    );
    expect(await names({ kind: "agent", agentId: "a2", projectIds: ["alpha"] })).toEqual(
      [all.id, proj.id].sort(),
    );
    expect(await names({ kind: "agent", agentId: "a2", projectIds: [] })).toEqual([all.id]);
    // Someone else's collections are never seen.
    expect((await k.search("other", { query: "word" })).hits).toEqual([]);
  });

  it("reads a project's files through its workspace and opens a citation there", async () => {
    const { k } = await setup();
    await k.setSettings("me", { embedding: fake });
    await mkdir(join(dir, "alpha", "notes"), { recursive: true });
    await writeFile(join(dir, "alpha", "notes", "todo.md"), "# Todo\n\nBuy milk and bread.\n");
    const c = await k.createCollection("me", {
      name: "Alpha",
      scope: { kind: "project", projectId: "alpha" },
    });
    await k.addSource("me", c.id, { kind: "workspace", scope: "project:alpha", path: "notes" });
    await k.indexer.drain();
    const hit = (await k.search("me", { query: "milk bread" })).hits[0];
    expect(hit?.citation).toMatchObject({
      source: "workspace",
      scope: "project:alpha",
      path: "notes/todo.md",
    });
    const o = await k.open("me", hit?.citation.chunkId as string);
    expect(o).toMatchObject({
      target: { kind: "file", scope: "project:alpha", path: "notes/todo.md", at: { line: 1 } },
    });
  });

  it("refuses RedGiant's own folders as sources", async () => {
    const { k } = await setup();
    const c = await k.createCollection("me", { name: "X" });
    await expect(
      k.addSource("me", c.id, { kind: "folder", path: join(dir, "data") }),
    ).rejects.toThrow(/RedGiant's own data/);
    await expect(k.addSource("me", c.id, { kind: "folder", path: dir })).rejects.toThrow(
      /RedGiant's own data/,
    );
    await expect(k.addSource("me", c.id, { kind: "folder", path: "relative" })).rejects.toThrow(
      /full path/,
    );
  });

  it("falls back to words when the model fails, and waits after a refused key", async () => {
    const api = fakeApi(32);
    const { k } = await setup(32, api);
    await k.setSettings("me", { embedding: fake });
    const c = await k.createCollection("me", { name: "Docs", language: "english" });
    const root = await folder({ "x.txt": "Houses are built of bricks.\n" });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    api.calls.fail = 100;
    await k.indexer.drain();
    const s = await k.status("me");
    expect(s.queue.error).toMatch(/401/);
    expect(s.indexes[0]?.embedded).toBe(0);
    // English stems: «house» finds «Houses».
    const r = await k.search("me", { query: "house" });
    expect(r.wordsOnly).toMatch(/failed/);
    expect(r.hits[0]?.text).toContain("Houses");
    const requests = api.calls.requests;
    await k.indexer.drain();
    expect(api.calls.requests).toBe(requests);
    // New settings: tried again.
    api.calls.fail = 0;
    await k.setSettings("me", { threads: 2 });
    await k.indexer.drain();
    expect((await k.status("me")).indexes[0]?.embedded).toBe(1);
  });

  it("searches by words while a local model is not downloaded yet, never waiting for it", async () => {
    const { k } = await setup();
    // A local model: the queue would download it in the background; here nothing is fetched.
    k.deps.local.ensure = () => new Promise<void>(() => {});
    await k.setSettings("me", { embedding: { provider: "local", model: "embeddinggemma-300m" } });
    const c = await k.createCollection("me", { name: "Docs", language: "english" });
    const root = await folder({ "x.txt": "Lighthouses guide ships at night.\n" });
    await k.addSource("me", c.id, { kind: "folder", path: root });
    await k.indexer.drain();
    const r = await k.search("me", { query: "lighthouse" });
    expect(r.wordsOnly).toMatch(/downloading/);
    expect(r.hits[0]?.text).toContain("Lighthouses");
    expect((await k.status("me")).queue.doing).toBe("download");
  });

  it("checks the key and the size before making an index", async () => {
    const api = fakeApi(32);
    const { k } = await setup(32, api);
    api.calls.fail = 1;
    await expect(k.setSettings("me", { embedding: fake })).rejects.toThrow(/401/);
    await expect(k.setSettings("me", { embedding: { ...fake, dims: 64 } })).rejects.toThrow(
      /fewer than the 64/,
    );
    expect((await k.status("me")).indexes).toEqual([]);
  });
});

describe("knowledge: strategies for scopes (study 4.2)", () => {
  /**
   * 3 000 pieces in three collections (70%, 25%, 5%) with clustered vectors written straight in
   * the tables, an HNSW graph and a partial one, then recall@10 against exact search per scope.
   */
  it("keeps recall in small and large scopes, choosing exact, partial and HNSW searches", async () => {
    const dims = 16;
    const api = fakeApi(dims);
    const { k, db } = await setup(dims, api);
    k.indexer.thresholds = { annMin: 500, partialMin: 600 };
    (k.deps as { exactMax?: number }).exactMax = 200;
    await k.setSettings("me", { embedding: { ...fake, dims } });
    const big = await k.createCollection("me", { name: "big", language: "simple" });
    const mid = await k.createCollection("me", { name: "mid", language: "simple" });
    const small = await k.createCollection("me", { name: "small", language: "simple" });
    const nums = (
      await db.query<{ id: string; num: number }>("SELECT id, num FROM rg_kb_collections")
    ).reduce((m, r) => m.set(r.id, r.num), new Map<string, number>());
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const centers = Array.from({ length: 40 }, () =>
      normalize(Array.from({ length: dims }, () => rand() - 0.5)),
    );
    const vec = () => {
      const c = centers[Math.floor(rand() * centers.length)] as number[];
      return normalize(c.map((x) => x + (rand() - 0.5) * 0.3));
    };
    const plan: [string, number][] = [
      [big.id, 2200],
      [mid.id, 650],
      [small.id, 150],
    ];
    const index = (await k.indexes("me"))[0];
    const table = `rg_kb_vec_${index?.id}`;
    const all: { id: string; num: number; v: number[] }[] = [];
    for (const [cid, n] of plan) {
      const num = nums.get(cid) as number;
      const src = `src_${cid}`;
      await db.query(
        "INSERT INTO rg_kb_sources (id, collection_id, spec) VALUES ($1, $2, $3::jsonb)",
        [src, cid, JSON.stringify({ kind: "folder", path: "/x", exclude: [], gitignore: true })],
      );
      const doc = await db.query<{ id: string }>(
        "INSERT INTO rg_kb_documents (source_id, collection_num, path, state, chunks) VALUES ($1, $2, 'f.txt', 'indexed', $3) RETURNING id::text AS id",
        [src, num, n],
      );
      const ids = await db.query<{ id: string }>(
        `INSERT INTO rg_kb_chunks (document_id, collection_num, ord, body, hash, tsv)
         SELECT $1::bigint, $2, g, 'piece ' || g, md5(g::text), to_tsvector('simple', 'piece')
           FROM generate_series(1, $3::int) g RETURNING id::text AS id`,
        [doc[0]?.id, num, n],
      );
      const vs = ids.map(() => vec());
      await db.query(
        `INSERT INTO ${table} (chunk_id, collection_num, embedding)
         SELECT x.id, $2, x.e::halfvec FROM unnest($1::bigint[], $3::text[]) AS x(id, e)`,
        [ids.map((r) => r.id), num, vs.map((v) => `[${v.join(",")}]`)],
      );
      ids.forEach((r, i) => {
        all.push({ id: r.id, num, v: vs[i] as number[] });
      });
    }
    await k.indexer.drain();
    const idx = (await k.indexes("me"))[0];
    expect(idx?.ann).toBe(true);
    // The big collection is 70% of the index: no graph of its own; the middle one gets one.
    expect(idx?.partials).toEqual([nums.get(mid.id)]);

    // Queries are vectors near random centres: search through the SQL the service runs.
    const recallOf = async (collections: string[], expectStrategy: string) => {
      const wanted = new Set(collections.map((c) => nums.get(c)));
      let found = 0;
      for (let q = 0; q < 20; q++) {
        const v = vec();
        const exact = all
          .filter((p) => wanted.has(p.num))
          .map((p) => ({ id: p.id, d: 1 - p.v.reduce((s, x, i) => s + x * (v[i] ?? 0), 0) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 10)
          .map((p) => p.id);
        // Bypass the embedder: the query vector goes straight into the strategy's SQL.
        const strategy = expectStrategy as "exact" | "partial" | "hnsw";
        const sql = vectorSql({
          table,
          strategy,
          ...(strategy === "partial" && {
            partialNum: nums.get(collections[0] as string) as number,
          }),
          filtered: false,
        });
        const rows = await db.transaction(async (tx) => {
          if (strategy !== "exact") {
            await tx.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
            await tx.query("SET LOCAL hnsw.ef_search = 100");
            await tx.query("SET LOCAL enable_sort = off");
          }
          return tx.query<{ id: string }>(sql, [`[${v.join(",")}]`, [...wanted], 10]);
        });
        const got = new Set(rows.map((r) => r.id));
        found += exact.filter((id) => got.has(id)).length;
      }
      return found / 200;
    };
    expect(await recallOf([small.id], "exact")).toBe(1);
    expect(await recallOf([mid.id], "partial")).toBeGreaterThanOrEqual(0.95);
    expect(await recallOf([big.id, small.id], "hnsw")).toBeGreaterThanOrEqual(0.9);
    // Each strategy really uses its graph (and the exact one none).
    const planOf = async (strategy: "exact" | "partial" | "hnsw", cols: string[]) => {
      const sql = vectorSql({
        table,
        strategy,
        ...(strategy === "partial" && { partialNum: nums.get(cols[0] as string) as number }),
        filtered: false,
      });
      const v = `[${vec().join(",")}]`;
      const rows = await db.transaction(async (tx) => {
        if (strategy !== "exact") await tx.query("SET LOCAL enable_sort = off");
        return tx.query<{ "QUERY PLAN": string }>(
          `EXPLAIN ${sql
            .replaceAll("$1::halfvec", `'${v}'::halfvec`)
            .replaceAll("$2::int[]", `'{${cols.map((c) => nums.get(c)).join(",")}}'::int[]`)
            .replace("$3", "10")}`,
        );
      });
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    };
    expect(await planOf("hnsw", [big.id, small.id])).toContain(`${table}_hnsw`);
    expect(await planOf("partial", [mid.id])).toContain(`${table}_c${nums.get(mid.id)}`);
    expect(await planOf("exact", [small.id])).not.toMatch(/_hnsw|_c\d/);

    // And the service picks the strategy by itself.
    const pick = async (collections: string[]) =>
      (await k.search("me", { query: "piece", collections, mode: "meaning", rerank: false }))
        .strategy;
    expect(await pick([small.id])).toBe("exact");
    expect(await pick([mid.id])).toBe("partial");
    expect(await pick([big.id])).toBe("hnsw");
  }, 120_000);
});

describe("knowledge: pure parts", () => {
  it("fuses ranked lists with RRF", () => {
    const fused = rrf([
      [
        { id: "1", rank: 1 },
        { id: "2", rank: 2 },
      ],
      [
        { id: "2", rank: 1 },
        { id: "3", rank: 2 },
      ],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["2", "1", "3"]);
  });

  it("writes each strategy's vector query", () => {
    expect(vectorSql({ table: "t", strategy: "exact", filtered: false })).toMatch(
      /\) \+ 0 LIMIT \$3/,
    );
    expect(vectorSql({ table: "t", strategy: "partial", partialNum: 7, filtered: false })).toMatch(
      /v\.collection_num = 7 AND cardinality\(\$2/,
    );
    expect(vectorSql({ table: "t", strategy: "hnsw", filtered: true })).toMatch(
      /\$5::text IS NULL/,
    );
  });

  it("embeds a piece with its place", () => {
    expect(
      Indexer.embedText({
        path: "src/a.ts",
        title: "a.ts",
        heading: "function f",
        body: "body",
        kind: "code",
      }),
    ).toBe("src/a.ts › function f\n\nbody");
    expect(
      Indexer.embedText({
        path: "guide.pdf",
        title: "User guide",
        heading: null,
        body: "b",
        kind: "pdf",
      }),
    ).toBe("User guide (guide.pdf)\n\nb");
  });

  it("names a wrong size loudly", () => {
    expect(new EmbeddingError("dims", "x").code).toBe("dims");
  });

  it("keeps the build memory under Postgres' ceiling", () => {
    expect(capMemory("4GB", 2097151)).toBe("2046MB");
    expect(capMemory("512MB", 2097151)).toBe("512MB");
    expect(capMemory("4GB", 0)).toBe("4GB");
  });
});

describe("knowledge: HTTP API", () => {
  it("chooses a model, makes a collection, indexes, searches and opens a citation in the Canvas", async () => {
    const api = fakeApi(32);
    let k: KnowledgeService | undefined;
    const server = await startServer([], {}, {}, undefined, undefined, async (core, sdir) => {
      k = new KnowledgeService({
        db: core.db,
        store: core.store,
        jobs: core.jobs,
        dataDir: join(sdir, "data"),
        local: new LocalEmbedServers({ dataDir: join(sdir, "data"), jobs: core.jobs }),
        keyedFetch: () => api.keyed,
        scopeRoot: (o, scope) => core.scopeFolder(o, scope),
        manual: true,
      });
      await k.start();
      core.knowledge = k;
      return {};
    });
    cleanup.push(async () => {
      await k?.stop();
      await server.close();
    });
    const root = await folder({
      "guide.md": "# Guide\n\nThe lighthouse keeper lights the lamp at dusk.\n",
    });
    expect((await server.api("PUT", "/api/knowledge/settings", { embedding: fake })).status).toBe(
      200,
    );
    const made = await server.api<{ id: string }>("POST", "/api/knowledge/collections", {
      name: "Guides",
    });
    expect(made.status).toBe(201);
    const src = await server.api("POST", `/api/knowledge/collections/${made.body.id}/sources`, {
      kind: "folder",
      path: root,
    });
    expect(src.status).toBe(201);
    await k?.indexer.drain();
    const st = await server.api<{ indexes: { state: string }[]; vector: { ok: boolean } }>(
      "GET",
      "/api/knowledge",
    );
    expect(st.body.vector.ok).toBe(true);
    expect(st.body.indexes[0]?.state).toBe("ready");
    const found = await server.api<{ hits: { citation: { chunkId: string; path: string } }[] }>(
      "POST",
      "/api/knowledge/search",
      { query: "lighthouse lamp" },
    );
    expect(found.body.hits[0]?.citation.path).toBe(join(root, "guide.md"));
    const opened = await server.api<{ target: { scope: string; path: string } }>(
      "GET",
      `/api/knowledge/open/${found.body.hits[0]?.citation.chunkId}`,
    );
    expect(opened.body.target).toMatchObject({
      scope: "outside",
      path: join(root, "guide.md"),
      at: { line: 1 },
    });
    // The Canvas may show it: it belongs to a folder the person gave the knowledge.
    const link = await server.api<{ url: string }>("POST", "/api/canvas/link", opened.body.target);
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/^\/preview\/.+\/guide\.md$/);
    // Not another file of the computer.
    const other = await server.api("POST", "/api/canvas/link", {
      kind: "file",
      scope: "outside",
      path: join(dir, "x.txt"),
    });
    expect(other.status).toBe(400);
    // Someone else sees none of it.
    const theirs = await server.api(
      "GET",
      `/api/knowledge/collections/${made.body.id}/sources`,
      undefined,
      OTHER,
    );
    expect(theirs.status).toBe(404);
    const models = await server.api<{ local: { id: string; here: boolean }[] }>(
      "GET",
      "/api/knowledge/models",
    );
    expect(models.body.local.find((m) => m.id === "qwen3-embedding-0.6b")?.here).toBe(false);
    expect((await server.api("POST", "/api/knowledge/search", { query: "" })).status).toBe(400);
  });
});
