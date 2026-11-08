// The quality bench (G36.6) with simulated embeddings: no model, but vectors that behave like a
// small multilingual one (a thesaurus folds words of the same meaning, in Italian and English,
// into one concept; other words count as themselves). The words search alone misses what is said
// otherwise or in the other language; the meaning alone misses little; fused they must find
// almost everything. The same questions run against a real model in scripts/knowledge-bench.mjs.
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import { type BenchQuestion, fileRank, runBench } from "../src/knowledge/bench.js";
import { type KeyedFetch, normalize } from "../src/knowledge/embedders.js";
import { LocalEmbedServers } from "../src/knowledge/local-embed.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { memoryDb } from "./pglite.js";

const BENCH = join(import.meta.dirname, "fixtures", "knowledge", "bench");

/** Word beginnings that mean the same thing, in both languages. */
const CONCEPTS: Record<string, string[]> = {
  light: ["lampad", "lantern", "light", "accend", "switch", "lamp"],
  lighthouse: ["faro", "lighthouse"],
  keeper: ["guardian", "keeper"],
  fog: ["nebbi", "fog"],
  bread: ["pane", "bread"],
  sourdough: ["lievito", "sourdough"],
  rise: ["lievitazion", "rise", "riposa"],
  salt: ["sale", "salt"],
  washer: ["lavatric", "washing"],
  warranty: ["garanzi", "warranty", "copert", "copre", "cover"],
  duration: ["dura", "length", "long", "tempo"],
  seal: ["guarnizion", "oblò", "seal"],
  puncture: ["puncture", "bucat", "flat"],
  repair: ["ripar", "fix", "repair", "patch"],
  tube: ["camera", "tube"],
  bike: ["bici", "bicycle", "bike", "tyre", "wheel"],
  income: ["income", "reddit"],
  declaration: ["declaration", "dichiarazion"],
  due: ["scadenz", "due", "deadline", "filed"],
  tomato: ["pomodor", "tomato"],
  sow: ["semin", "sow"],
  water: ["annaff", "water"],
  garden: ["orto", "garden", "vegetable"],
  summer: ["estate", "luglio", "summer"],
  copy: ["copi", "copy", "copies"],
  monthly: ["monthly", "mensil"],
  key: ["chiave", "key"],
  encrypt: ["cifratur", "encrypt"],
  ticket: ["bigliett", "ticket"],
  daily: ["giornalier", "daily"],
  lisbon: ["lisbon"],
  tart: ["nata", "custard", "tart", "pastéis"],
  kitten: ["gattin", "kitten"],
  eat: ["eat", "mangi", "meal", "pasti", "food"],
  vaccine: ["vaccin"],
  notice: ["preavviso", "notice"],
  leave: ["lasciar", "leave"],
  rent: ["affitt", "rent", "inquilin", "tenant"],
  extra: ["straordinar", "extraordinary"],
  condo: ["condomin", "condominium"],
  pay: ["pays", "paga", "spese", "costs"],
  solar: ["solar", "solari", "pannell", "panel"],
  pressure: ["idropulitric", "pressure"],
  wash: ["lavar", "wash", "rinse"],
  coffee: ["coffee", "caff", "espresso", "shot"],
  fast: ["fast", "veloc"],
  grind: ["grind", "macin"],
};

const STOP = new Set(
  "a al alla con da del della dei di e è il in la le lo per si un una che the a an of to on in is it do i how what when where who should does with and for".split(
    " ",
  ),
);

function conceptOf(word: string): string {
  for (const [c, starts] of Object.entries(CONCEPTS))
    if (starts.some((s) => word.startsWith(s))) return `#${c}`;
  return word;
}

/** A "multilingual model" made of a thesaurus and hashing. */
function simulatedModel(dims: number) {
  const embed = (t: string) => {
    const v = new Array<number>(dims).fill(0);
    for (const w of t.toLowerCase().match(/[\p{L}0-9]+/gu) ?? []) {
      if (STOP.has(w)) continue;
      const token = conceptOf(w);
      let h = 2166136261;
      for (const c of token) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
      // Concepts weigh more than plain words, as meaning does for a real model.
      const weight = token.startsWith("#") ? 3 : 1;
      for (let j = 0; j < 4; j++) {
        const i = Math.abs(h + j * 7919) % dims;
        v[i] = (v[i] ?? 0) + ((h >> j) & 1 ? 1 : -1) * weight;
      }
    }
    return normalize(v);
  };
  const keyed: KeyedFetch = async (url, init) => {
    if (!url.endsWith("/embeddings")) return new Response("no", { status: 404 });
    const body = JSON.parse(init.body ?? "{}") as { input: string[] };
    return Response.json({ data: body.input.map((t, index) => ({ index, embedding: embed(t) })) });
  };
  return keyed;
}

let dir: string;
let k: KnowledgeService;
let questions: BenchQuestion[];

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "rg-bench-")));
  const { db } = await memoryDb();
  await migrate(db);
  const jobs = new Jobs();
  const dataDir = join(dir, "data");
  await mkdir(dataDir, { recursive: true });
  k = new KnowledgeService({
    db,
    store: new EventStore(db),
    jobs,
    dataDir,
    local: new LocalEmbedServers({ dataDir, jobs }),
    keyedFetch: () => simulatedModel(256),
    scopeRoot: async () => {
      throw new Error("no scopes");
    },
    manual: true,
  });
  await k.start();
  await k.setSettings("me", {
    embedding: { provider: "compatible", model: "simulated", baseUrl: "http://fake.test/v1" },
  });
  const c = await k.createCollection("me", { name: "Bench", language: "italian" });
  await k.addSource("me", c.id, { kind: "folder", path: join(BENCH, "docs") });
  await k.indexer.drain();
  questions = (
    JSON.parse(await readFile(join(BENCH, "questions.json"), "utf8")) as {
      questions: BenchQuestion[];
    }
  ).questions;
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("knowledge quality bench (G36.6)", () => {
  it("finds the file that answers known questions: fused better than either alone", async () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    expect((await k.documents("me", (await k.collections("me"))[0]?.id as string)).length).toBe(12);
    const [words, meaning, both] = await runBench(k, "me", questions, { k: 5 });
    // Printed for the record (the numbers go in the study).
    console.info(
      JSON.stringify(
        [words, meaning, both].map((s) => ({
          mode: s?.mode,
          r1: s?.recallAt1,
          r5: s?.recallAtK,
          mrr: s?.mrr,
          misses: s?.misses,
        })),
      ),
    );
    expect(both?.recallAtK).toBeGreaterThanOrEqual(0.95);
    expect(both?.recallAt1).toBeGreaterThanOrEqual(0.8);
    expect(meaning?.recallAtK).toBeGreaterThanOrEqual(0.9);
    // Words alone miss questions said otherwise or in the other language.
    expect(words?.recallAtK).toBeLessThan(both?.recallAtK ?? 0);
    expect(both?.mrr).toBeGreaterThanOrEqual(words?.mrr ?? 1);
  });

  it("ranks files, not pieces", () => {
    expect(fileRank(["/d/a.md", "/d/a.md", "/d/b.md"], "b.md")).toBe(2);
    expect(fileRank(["/d/a.md"], "c.md")).toBe(0);
    expect(fileRank(["C:\\d\\b.md"], "b.md")).toBe(1);
  });
});
