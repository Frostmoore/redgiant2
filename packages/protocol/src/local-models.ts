/**
 * Models suggested for this computer (G24.3), from the smallest to the largest: well known,
 * good with RedGiant's tools, from publishers who keep their files tidy. The wizard picks the
 * best quantisation that fits; what each one is good at is in the UI's words (`lm_<id>`).
 * Checked on Hugging Face on 2026-11-03.
 *
 * Scores (2026-11-03, the person's request: "stars or a bar, not ambiguous words") are 1 to 5
 * and compare these models with each other, not with the big hosted ones: how well each one
 * reasons, writes code, uses tools and writes languages other than English. Speed depends on the computer and is
 * estimated by `estimatedSpeed`.
 */
export interface LocalModel {
  id: string;
  name: string;
  repo: string;
  /** Billions of parameters in all, and those working on each token (mixture of experts). */
  totalB: number;
  activeB: number;
  scores: { smart: number; code: number; tools: number; languages: number };
  /**
   * A small model of the same family (same vocabulary) for speculative decoding (2026-11-04):
   * it proposes a few tokens, the big one checks them all in one pass. Its file is the one with
   * this quantisation in the repository.
   */
  draft?: { repo: string; quant: string };
}

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: "gemma-4-e2b",
    name: "Gemma 4 E2B",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    totalB: 5,
    activeB: 2,
    scores: { smart: 1, code: 1, tools: 2, languages: 3 },
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    totalB: 8,
    activeB: 4,
    scores: { smart: 2, code: 2, tools: 2, languages: 3 },
  },
  {
    id: "qwen3-4b",
    name: "Qwen3 4B 2507",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    totalB: 4,
    activeB: 4,
    scores: { smart: 2, code: 2, tools: 3, languages: 3 },
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    repo: "unsloth/gemma-4-12b-it-GGUF",
    totalB: 12,
    activeB: 12,
    scores: { smart: 3, code: 2, tools: 3, languages: 4 },
  },
  {
    id: "qwen3-14b",
    name: "Qwen3 14B",
    repo: "unsloth/Qwen3-14B-GGUF",
    totalB: 14.8,
    activeB: 14.8,
    scores: { smart: 3, code: 3, tools: 3, languages: 3 },
    draft: { repo: "unsloth/Qwen3-0.6B-GGUF", quant: "Q8_0" },
  },
  {
    id: "gpt-oss-20b",
    name: "gpt-oss 20B",
    repo: "unsloth/gpt-oss-20b-GGUF",
    totalB: 21,
    activeB: 3.6,
    scores: { smart: 3, code: 3, tools: 4, languages: 2 },
  },
  {
    id: "gemma-4-26b",
    name: "Gemma 4 26B A4B",
    repo: "unsloth/gemma-4-26B-A4B-it-GGUF",
    totalB: 26,
    activeB: 4,
    scores: { smart: 4, code: 3, tools: 3, languages: 4 },
  },
  {
    id: "mistral-small-24b",
    name: "Mistral Small 3.2 24B",
    repo: "unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF",
    totalB: 24,
    activeB: 24,
    scores: { smart: 3, code: 3, tools: 4, languages: 4 },
  },
  {
    id: "devstral-small-24b",
    name: "Devstral Small 24B",
    repo: "unsloth/Devstral-Small-2507-GGUF",
    totalB: 24,
    activeB: 24,
    scores: { smart: 3, code: 4, tools: 4, languages: 3 },
  },
  {
    id: "qwen3-30b-a3b",
    name: "Qwen3 30B A3B 2507",
    repo: "unsloth/Qwen3-30B-A3B-Instruct-2507-GGUF",
    totalB: 30.5,
    activeB: 3.3,
    scores: { smart: 4, code: 3, tools: 4, languages: 3 },
  },
  {
    id: "qwen3-coder-30b",
    name: "Qwen3 Coder 30B A3B",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    totalB: 30.5,
    activeB: 3.3,
    scores: { smart: 3, code: 5, tools: 4, languages: 2 },
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    totalB: 27,
    activeB: 27,
    scores: { smart: 5, code: 4, tools: 5, languages: 3 },
  },
  {
    id: "qwen3-next-80b",
    name: "Qwen3 Next 80B A3B",
    repo: "unsloth/Qwen3-Next-80B-A3B-Instruct-GGUF",
    totalB: 80,
    activeB: 3,
    scores: { smart: 4, code: 4, tools: 4, languages: 3 },
  },
  {
    id: "glm-4.5-air",
    name: "GLM-4.5 Air 106B A12B",
    repo: "unsloth/GLM-4.5-Air-GGUF",
    totalB: 106,
    activeB: 12,
    scores: { smart: 5, code: 5, tools: 5, languages: 3 },
  },
  {
    id: "gpt-oss-120b",
    name: "gpt-oss 120B",
    repo: "unsloth/gpt-oss-120b-GGUF",
    totalB: 117,
    activeB: 5.1,
    scores: { smart: 5, code: 4, tools: 5, languages: 2 },
  },
  // Large dense models (2026-11-04): every token reads all their weights, so they need a lot of
  // memory and are slow beyond the card; for those who have it, with speculative decoding.
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    repo: "unsloth/Llama-3.3-70B-Instruct-GGUF",
    totalB: 70,
    activeB: 70,
    scores: { smart: 4, code: 4, tools: 4, languages: 4 },
    draft: { repo: "unsloth/Llama-3.2-1B-Instruct-GGUF", quant: "Q8_0" },
  },
  {
    id: "qwen2.5-72b",
    name: "Qwen2.5 72B",
    repo: "bartowski/Qwen2.5-72B-Instruct-GGUF",
    totalB: 72,
    activeB: 72,
    scores: { smart: 4, code: 4, tools: 4, languages: 4 },
    draft: { repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", quant: "Q8_0" },
  },
  {
    id: "mistral-large-2411",
    name: "Mistral Large 2411 123B",
    repo: "bartowski/Mistral-Large-Instruct-2411-GGUF",
    totalB: 123,
    activeB: 123,
    scores: { smart: 5, code: 4, tools: 4, languages: 5 },
  },
];

/** What the computer has, as the setup describes it. */
export interface SpeedHardware {
  kind: "gpu" | "gpu-unknown" | "igpu" | "cpu";
  vramGb: number;
  /** For SSD stream: the RAM free now (not the total); what does not fit is read from the SSD. */
  ramGb?: number;
}

/**
 * What each place gives to a model's reads at each token, in GB a second, as llama.cpp really
 * reaches it (2026-11-04, measured: Qwen3 Next 80B A3B, 39.7 GB, on a 16 GB RTX 4080 Super with
 * 64 GB of RAM writes 22 tokens a second): the card, the computer's memory, a GPU in the
 * processor, the processor alone, and an NVMe SSD (spread reads, not one long file).
 */
const BANDWIDTH = { card: 500, ram: 30, igpu: 60, cpu: 40, unknown: 120, ssd: 3 } as const;

/**
 * About how many tokens a second a model writes here, and that as 1 to 5. Writing one token
 * reads the working part of the model once (all of it for a dense model, the active experts
 * and the shared part for a mixture of experts). The model fills the card first, then the RAM,
 * then (SSD stream) the SSD: each part of the reads goes at its place's speed. The experts used
 * most stay in RAM, so the SSD serves about half of its share. A rough estimate, said as such.
 */
export function estimatedSpeed(
  m: Pick<LocalModel, "totalB" | "activeB">,
  fileGb: number,
  hw: SpeedHardware,
): { tokensPerSec: number; stars: number } {
  const perToken = Math.max(0.2, (fileGb * m.activeB) / m.totalB);
  const size = Math.max(fileGb, 0.1);
  const card = hw.kind === "gpu" ? hw.vramGb * 0.8 : 0;
  const memory = (hw.ramGb ?? 16) * 0.9;
  const inCard = Math.min(size, card);
  const inRam = Math.min(size - inCard, memory);
  const onSsd = (size - inCard - inRam) * 0.5;
  const ramSpeed =
    hw.kind === "gpu"
      ? BANDWIDTH.ram
      : hw.kind === "igpu"
        ? BANDWIDTH.igpu
        : hw.kind === "gpu-unknown"
          ? BANDWIDTH.unknown
          : BANDWIDTH.cpu;
  const seconds =
    (perToken / size) *
    (inCard / BANDWIDTH.card + (size - inCard - onSsd) / ramSpeed + onSsd / BANDWIDTH.ssd);
  const tokensPerSec = Math.max(0, Math.round(1 / Math.max(seconds, 0.001)));
  return { tokensPerSec, stars: starsFor(tokensPerSec) };
}

const starsFor = (n: number) => (n >= 80 ? 5 : n >= 40 ? 4 : n >= 20 ? 3 : n >= 10 ? 2 : 1);
