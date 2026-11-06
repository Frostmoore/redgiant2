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
  /** Tokens read in one pass (`-b`/`-ub`), when the plan sets them (absent in older plans). */
  batch?: number;
  /** With bigger passes turned on (G32.1): those the card has room for, for the tuning. */
  bigBatches?: number[];
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
export const MOE_BATCH = 4096;
const MOE_BATCH_GB = 1;
/**
 * Bigger passes (G32.1, 2026-11-06, an experimental option after Strata's "layer-major" reading):
 * the experts go through the card once a pass, so a long message read in passes of 16384 moves
 * them a quarter as often as in passes of 4096. Tried by the tuning only when they fit.
 */
// Never above 16384: on CUDA a pass of a mixture of experts over 25344 tokens stops llama.cpp
// b12034 (`nbytes_shared <= smpbo` in mmid.cu, 4 bytes a token in 101376 of shared memory).
export const BIG_BATCHES = [8192, 16384] as const;
/** The words a model knows when its header does not say (Qwen's 151936, among the larger). */
const VOCAB = 151936;
/**
 * The card's room llama.cpp's compute buffers take for a pass of `batch` tokens: about a GB for
 * 4096 (the estimate used since 2026-11-04); past it, measured on Rig with Qwen3 30B A3B
 * (2026-11-06: 7.1 / 10.0 / 15.7 GB of the card at 4096 / 8192 / 16384), the logits of every
 * token of the pass (4 bytes a word of the vocabulary) and about 140 KB more a token.
 */
export const batchGb = (batch: number, vocab = VOCAB) =>
  MOE_BATCH_GB + (Math.max(0, batch - MOE_BATCH) * (vocab * 4 + 140_000)) / GB;
/** The context a plan never goes below. */
const MIN_CTX = 16384;
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
    /** Tokens a pass for a mixture of experts on a card (default `MOE_BATCH`, G32.1). */
    batch?: number | undefined;
    /**
     * The weights loaded in RAM instead of mapped from the file, when they fit (G32.1): measured
     * on Rig the experts reach the card faster (a long read 3217 -> 3801 tokens a second).
     */
    loadInRam?: boolean | undefined;
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
  const batch = moe && card > 0 ? Math.max(MOE_BATCH, tuning.batch ?? MOE_BATCH) : 0;
  const free = Math.max(
    0,
    card - CARD_RESERVE_GB - (batch > 0 ? batchGb(batch, meta.vocabSize) : 0) - shared,
  );
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
  const ctx = Math.max(MIN_CTX, Math.min(steps(trained), steps((kvBudgetGb * GB) / kvPerToken)));
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
  // Loaded whole only with a good margin of free RAM: never when part is read from the SSD.
  const loadInRam =
    !!tuning.loadInRam && moe && card > 0 && source === "ram" && fileGb - inCard <= hw.ramGb * 0.8;
  return {
    ctx,
    args: [
      ...(moe ? ["--cpu-moe"] : []),
      ...(moeCacheMib > 0 ? ["--moe-cache-mib", String(moeCacheMib)] : []),
      ...(batch > 0 ? ["-b", String(batch), "-ub", String(batch)] : []),
      ...(tuning.opOffload === false ? ["--no-op-offload"] : []),
      ...(loadInRam ? ["-lm", "none"] : []),
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
    ...(batch > 0 && { batch }),
  };
}

/**
 * The bigger passes that fit in the card with this tuning (G32.1): their compute buffers leave
 * room for the shortest context a plan accepts (16384 tokens of keys and values at 8 bits, after
 * the experts' cache), and a pass is never longer than the context. Only for a mixture of experts
 * with its experts outside a card: that is where a pass moves them all.
 */
export function bigBatches(
  meta: GgufMeta,
  fileGb: number,
  hw: StreamHardware,
  tuning: {
    moeCacheShare?: number | undefined;
    draftGb?: number | undefined;
    loadInRam?: boolean | undefined;
  } = {},
): number[] {
  if (meta.experts <= 0) return [];
  const base = streamPlan(meta, fileGb, hw, tuning);
  if (!base.moe) return [];
  const kvPerToken = Math.max(1, meta.kvBytesPerToken * Q8);
  const share = Math.min(0.8, Math.max(0, tuning.moeCacheShare ?? 0));
  const draft = (tuning.draftGb ?? 0) * 1.3;
  const full = hw.kind === "gpu" ? hw.vramGb : hw.kind === "gpu-unknown" ? 8 : 0;
  const card = Math.max(0, full - draft);
  const shared = fileGb * (meta.experts >= 64 ? 0.07 : 0.12);
  return BIG_BATCHES.filter((b) => {
    const free = card - CARD_RESERVE_GB - batchGb(b, meta.vocabSize) - shared;
    if (free <= 0) return false;
    const kvTokens = (free * (1 - share) * GB) / kvPerToken;
    const ctx = streamPlan(meta, fileGb, hw, { ...tuning, batch: b }).ctx;
    return kvTokens >= MIN_CTX && b <= ctx;
  });
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
