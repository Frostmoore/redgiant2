// The knowledge's quality bench (G36.6): known questions over a small set of free documents,
// each naming the file that answers it; recall@k and MRR for the words, the meaning and the two
// fused. The tests run it with simulated embeddings (never a model); `scripts/knowledge-bench.mjs`
// runs the same questions with a real local model.

import type { KnowledgeSearchInput } from "@redgiant/protocol";
import type { KnowledgeService } from "./service.js";

export interface BenchQuestion {
  q: string;
  /** The file (its name, or the end of its path) that answers it. */
  doc: string;
}

export type BenchMode = NonNullable<KnowledgeSearchInput["mode"]>;

export interface BenchScore {
  mode: BenchMode;
  questions: number;
  /** Share of questions whose file is the first one found. */
  recallAt1: number;
  /** Share whose file is among the first `k` files found. */
  recallAtK: number;
  k: number;
  /** Mean reciprocal rank of the file (0 when not in the first ten). */
  mrr: number;
  /** Questions whose file was not in the first `k`. */
  misses: string[];
  ms: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The rank (1-based) of a file among the files of the hits, distinct, in order. */
export function fileRank(paths: string[], doc: string): number {
  const files: string[] = [];
  for (const p of paths) {
    const name = p.replace(/\\/g, "/");
    if (!files.includes(name)) files.push(name);
  }
  const i = files.findIndex((f) => f === doc || f.endsWith(`/${doc}`));
  return i < 0 ? 0 : i + 1;
}

export async function runBench(
  k: KnowledgeService,
  owner: string,
  questions: readonly BenchQuestion[],
  o: { modes?: BenchMode[]; k?: number; rerank?: boolean; collections?: string[] } = {},
): Promise<BenchScore[]> {
  const at = o.k ?? 5;
  const out: BenchScore[] = [];
  for (const mode of o.modes ?? (["words", "meaning", "both"] as BenchMode[])) {
    let first = 0;
    let within = 0;
    let rr = 0;
    const misses: string[] = [];
    const t0 = Date.now();
    for (const q of questions) {
      const r = await k.search(owner, {
        query: q.q,
        mode,
        limit: 20,
        rerank: o.rerank ?? false,
        ...(o.collections && { collections: o.collections }),
      });
      const rank = fileRank(
        r.hits.map((h) => h.citation.path),
        q.doc,
      );
      if (rank === 1) first++;
      if (rank > 0 && rank <= at) within++;
      else misses.push(q.q);
      if (rank > 0 && rank <= 10) rr += 1 / rank;
    }
    const n = questions.length || 1;
    out.push({
      mode,
      questions: questions.length,
      recallAt1: round(first / n),
      recallAtK: round(within / n),
      k: at,
      mrr: round(rr / n),
      misses,
      ms: Date.now() - t0,
    });
  }
  return out;
}
