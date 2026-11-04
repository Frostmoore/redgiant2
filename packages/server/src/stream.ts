// SSD stream (2026-11-03, inspired by antirez's DwarfStar): a local model whose weights do not
// all stay in the graphics card. The engine keeps the file mapped (mmap): what is used often
// stays in RAM by itself, the rest is read from the SSD when needed. For a mixture of experts the
// experts leave the card (--cpu-moe) and a cache in the card keeps the ones used lately
// (--moe-cache-mib); the card's room goes to the context instead, its keys and values at 8 bits.
// For a dense model llama.cpp fits as many layers as it can in the card (--fit) and the rest
// comes from RAM or the SSD at each token. This file decides the numbers; the engine does the rest.
import type { GgufMeta } from "@redgiant/engine-local";

const GB = 1024 ** 3;

/** What the plan needs to know of the computer. */
export interface StreamHardware {
  kind: "gpu" | "gpu-unknown" | "igpu" | "cpu";
  vramGb: number;
  /** The RAM the model may use now: what is free, not the total (2026-11-04). */
  ramGb: number;
}

export interface EnginePlan {
  /** Tokens of context each conversation can use (one pool shared by the slots). */
  ctx: number;
  /** Flags for llama-server. */
  args: string[];
  /** llama.cpp places the layers itself (no --n-gpu-layers 999). */
  fit: boolean;
  /** The card's cache of experts (MoE only), MiB. */
  moeCacheMib: number;
  /** A mixture of experts with its experts outside the card: the tuning applies. */
  moe: boolean;
  /** Where the weights mostly come from at each token. */
  source: "card" | "ram" | "ssd";
  /** About how many GB are read from the SSD for each token (0 when the model fits in RAM). */
  ssdGbPerWord: number;
  /** The free RAM the plan counted on. */
  ramGb: number;
}

/** Keys and values at 8 bits (q8_0): about 53 % of the 16-bit size. */
const Q8 = 8.5 / 16;
/** Not the model: compute buffers, the system, the other programs. */
const CARD_RESERVE_GB = 1;
/**
 * Tokens read in one pass (2026-11-04). With the experts outside the card, every pass of a long
 * read goes through all of them (sent to the card, or read from RAM and the SSD): measured on
 * gpt-oss 120B with 64 GB of RAM, 22 s a pass of 512 tokens, 22 tokens a second. Passes of 4096
 * make it eight times fewer. The larger buffers take about a GB more of the card.
 */
const MOE_BATCH = 4096;
const MOE_BATCH_GB = 1;
/** Of the free RAM, what the model's pages may keep (the rest for the engine and the system). */
const RAM_FOR_CACHE = 0.9;

const steps = (n: number) => Math.floor(n / 4096) * 4096;

/** The context without streaming: what RedGiant always used (65536, one pool). */
export const NORMAL_CTX = 65536;

export function streamPlan(
  meta: GgufMeta,
  fileGb: number,
  hw: StreamHardware,
  tuning: {
    moeCacheShare?: number | undefined;
    draftGb?: number | undefined;
    /** false: the experts' products of a long read on the processor, not sent to the card. */
    opOffload?: boolean | undefined;
  } = {},
): EnginePlan {
  const moe = meta.experts > 0;
  // A small model for speculative decoding sits in the card too, with its own context.
  const draft = (tuning.draftGb ?? 0) * 1.3;
  const full = hw.kind === "gpu" ? hw.vramGb : hw.kind === "gpu-unknown" ? 8 : 0;
  const card = Math.max(0, full - draft);
  const kvPerToken = Math.max(1, meta.kvBytesPerToken * Q8);
  // What always stays in the card for a mixture of experts: the shared part (attention,
  // embeddings, routers); fine-grained models (64 experts or more) keep about 7 % of the file
  // outside the experts.
  const shared = moe ? fileGb * (meta.experts >= 64 ? 0.07 : 0.12) : 0;
  const free = Math.max(0, card - CARD_RESERVE_GB - (moe && card > 0 ? MOE_BATCH_GB : 0) - shared);
  let kvBudgetGb: number;
  let moeCacheMib = 0;
  if (card > 0 && moe) {
    // The card's room: part to the context, part to the cache of experts.
    // No cache of experts on the card unless the tuning measured it faster (2026-11-04: on
    // Windows, through WSL, copying the missing experts to the card at every token wrote at
    // 4-5 tokens a second where the processor alone wrote 13-14).
    const share = Math.min(0.8, Math.max(0, tuning.moeCacheShare ?? 0));
    moeCacheMib = Math.floor((free * share * 1024) / 64) * 64;
    kvBudgetGb = free * (1 - share);
  } else if (card > 0) {
    // Dense: the context takes up to half of the card, the layers the rest (llama.cpp fits them).
    kvBudgetGb = card * 0.5;
  } else {
    kvBudgetGb = hw.ramGb * 0.25;
  }
  const trained = meta.contextLength || NORMAL_CTX;
  const ctx = Math.max(16384, Math.min(steps(trained), steps((kvBudgetGb * GB) / kvPerToken)));
  // How much of the weights is read at each token, and how much of it is not in RAM.
  const perWord = moe ? fileGb * (meta.expertsUsed / meta.experts) + shared : fileGb;
  const inRam = Math.max(0, hw.ramGb * RAM_FOR_CACHE);
  const inCard = moe
    ? shared + moeCacheMib / 1024
    : Math.max(0, card - kvBudgetGb - CARD_RESERVE_GB);
  const outside = Math.max(0, fileGb - inCard - inRam);
  const ssdGbPerWord = fileGb > 0 ? Math.round(perWord * (outside / fileGb) * 100) / 100 : 0;
  const source: EnginePlan["source"] =
    outside > 0 ? "ssd" : fileGb <= inCard + 0.01 ? "card" : "ram";
  return {
    ctx,
    args: [
      ...(moe ? ["--cpu-moe"] : []),
      ...(moeCacheMib > 0 ? ["--moe-cache-mib", String(moeCacheMib)] : []),
      ...(moe && card > 0 ? ["-b", String(MOE_BATCH), "-ub", String(MOE_BATCH)] : []),
      ...(tuning.opOffload === false ? ["--no-op-offload"] : []),
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
    ],
    fit: true,
    moe: moe && card > 0,
    moeCacheMib,
    source,
    ssdGbPerWord,
    ramGb: hw.ramGb,
  };
}

/**
 * Speculative decoding's flags (2026-11-04, checked in llama.cpp b12034's arguments): a small
 * model of the same family, all in the card, proposes up to 8 tokens, only those it is at least
 * 75 % sure of; or the proposals come from the text already written (n-grams), with no second
 * model. Measured on an RTX 4080 Super with Qwen3 14B and Qwen3 0.6B: code rewritten 59 -> 155
 * tokens a second; new prose 61 -> 56 (without the 75 % it fell to 42).
 */
export function speculativeArgs(
  speculative: "draft" | "ngram" | undefined,
  draftPath: string | undefined,
): string[] {
  if (speculative === "draft" && draftPath)
    return [
      "--spec-type",
      "draft-simple",
      "-md",
      draftPath,
      "-ngld",
      "99",
      "--spec-draft-n-max",
      "8",
      "--spec-draft-p-min",
      "0.75",
    ];
  if (speculative === "ngram") return ["--spec-type", "ngram-mod"];
  return [];
}
