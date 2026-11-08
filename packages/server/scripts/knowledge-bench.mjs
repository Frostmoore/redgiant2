// The knowledge's quality bench with a real model (G36.6): the known questions of
// test/fixtures/knowledge/bench over its free documents, searched by words, by meaning and both,
// with a local model run by llama.cpp (downloaded the first time with its bar, as in RedGiant).
// Never part of the tests. Heavy on a small computer: run it through pesante.sh.
//
//   pnpm build
//   node packages/server/scripts/knowledge-bench.mjs [--model embeddinggemma-300m] [--rerank bge-reranker-v2-m3]
//        [--data <folder for the downloads>] [--threads 2]
//
// Prints one JSON line per mode: recall@1, recall@5, MRR, the questions missed, the time.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "..");
const { values } = parseArgs({
  options: {
    model: { type: "string", default: "embeddinggemma-300m" },
    rerank: { type: "string" },
    data: { type: "string", default: join(server, ".bench-data") },
    threads: { type: "string", default: "2" },
  },
});

const { PGlite } = await import("@electric-sql/pglite");
const { vector } = await import("@electric-sql/pglite-pgvector");
const { EventStore, migrate } = await import("@redgiant/events");
const { Jobs } = await import(join(server, "dist/jobs.js"));
const { LocalEmbedServers } = await import(join(server, "dist/knowledge/local-embed.js"));
const { KnowledgeService } = await import(join(server, "dist/knowledge/service.js"));
const { runBench } = await import(join(server, "dist/knowledge/bench.js"));

const pg = await PGlite.create({ extensions: { vector } });
const wrap = (q) => ({
  query: async (text, params) => (await q.query(text, params)).rows,
  transaction: (fn) => (q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q))),
});
const db = wrap(pg);
await migrate(db);
const dataDir = resolve(values.data);
await mkdir(dataDir, { recursive: true });
const jobs = new Jobs();
// The download's bar, on one line.
let shown = "";
const bar = setInterval(() => {
  for (const j of jobs.list("bench")) {
    const p = j.steps?.find((x) => x.state === "running")?.progress;
    if (j.state !== "running" || !p) continue;
    const { done, total, rate } = p;
    const eta = rate && total ? ` ${Math.round((total - done) / rate)} s left` : "";
    const speed = rate ? ` ${(rate / 1e6).toFixed(1)} MB/s` : "";
    const pct = total ? Math.round((done / total) * 100) : 0;
    const line = `${j.kind} ${pct}% ${(done / 1e6).toFixed(0)}/${total ? (total / 1e6).toFixed(0) : "?"} MB${speed}${eta}`;
    if (line !== shown) process.stderr.write(`\r${line}   `);
    shown = line;
  }
}, 500);
const local = new LocalEmbedServers({ dataDir, jobs });
const k = new KnowledgeService({
  db,
  store: new EventStore(db),
  jobs,
  dataDir,
  local,
  keyedFetch: () => {
    throw new Error("local only");
  },
  scopeRoot: async () => {
    throw new Error("no scopes");
  },
  manual: true,
});
await k.start();
const t0 = Date.now();
await k.setSettings("bench", {
  embedding: { provider: "local", model: values.model },
  threads: Number(values.threads),
  ...(values.rerank && { rerank: { provider: "local", model: values.rerank } }),
});
await local.ensure("bench", "embed", values.model, false);
if (values.rerank) await local.ensure("bench", "rerank", values.rerank, false);
clearInterval(bar);
process.stderr.write("\n");
const bench = join(server, "test/fixtures/knowledge/bench");
const c = await k.createCollection("bench", { name: "Bench", language: "italian" });
await k.addSource("bench", c.id, { kind: "folder", path: join(bench, "docs") });
await k.indexer.drain();
const indexed = Date.now();
const { questions } = JSON.parse(await readFile(join(bench, "questions.json"), "utf8"));
const scores = await runBench(k, "bench", questions, { k: 5 });
if (values.rerank) {
  const [reranked] = await runBench(k, "bench", questions, { k: 5, modes: ["both"], rerank: true });
  scores.push({ ...reranked, mode: "both+rerank" });
}
console.log(
  JSON.stringify({
    model: values.model,
    rerank: values.rerank ?? null,
    pieces: (await k.status("bench")).chunks,
    indexSeconds: Math.round((indexed - t0) / 100) / 10,
  }),
);
for (const s of scores) console.log(JSON.stringify(s));
await k.stop();
await pg.close();
