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
  // The catalogue renewed on 2026-11-05 (the person approved the list): the newest open models
  // as unsloth publishes them, by size. Scores are estimates from published benchmarks, not
  // measured here; speeds are the page's estimates until a model is started.
  // Small: up to about 6 GB, laptops and small cards, the processor alone too.
  {
    id: "gemma-4-e2b",
    name: "Gemma 4 E2B",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    totalB: 5,
    activeB: 2,
    scores: { smart: 1, code: 1, tools: 2, languages: 3 },
  },
  {
    id: "qwen3.5-4b",
    name: "Qwen3.5 4B",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    totalB: 4.2,
    activeB: 4.2,
    scores: { smart: 2, code: 2, tools: 3, languages: 3 },
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    totalB: 8,
    activeB: 4,
    scores: { smart: 2, code: 2, tools: 3, languages: 4 },
  },
  {
    id: "nemotron-3.5-bolt-e4b",
    name: "Nemotron 3.5 Bolt E4B",
    repo: "unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF",
    totalB: 8,
    activeB: 4,
    scores: { smart: 2, code: 2, tools: 4, languages: 3 },
  },
  {
    id: "lfm2.5-8b-a1b",
    name: "LFM2.5 8B A1B",
    repo: "unsloth/LFM2.5-8B-A1B-GGUF",
    totalB: 8.5,
    activeB: 1,
    scores: { smart: 2, code: 2, tools: 3, languages: 2 },
  },
  {
    id: "qwen3.5-9b",
    name: "Qwen3.5 9B",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    totalB: 9,
    activeB: 9,
    scores: { smart: 3, code: 3, tools: 4, languages: 3 },
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    repo: "unsloth/gemma-4-12b-it-GGUF",
    totalB: 12,
    activeB: 12,
    scores: { smart: 3, code: 3, tools: 3, languages: 4 },
  },
  // Medium mixtures of experts: 14-24 GB, one card of 16-24 GB, or card and RAM.
  {
    id: "lfm2.5-24b-a2b",
    name: "LFM2.5 24B A2B",
    repo: "unsloth/LFM2.5-24B-A2B-GGUF",
    totalB: 24,
    activeB: 2,
    scores: { smart: 3, code: 3, tools: 3, languages: 2 },
  },
  {
    id: "gemma-4-26b",
    name: "Gemma 4 26B A4B",
    repo: "unsloth/gemma-4-26B-A4B-it-GGUF",
    totalB: 26,
    activeB: 4,
    scores: { smart: 4, code: 3, tools: 4, languages: 4 },
  },
  {
    id: "glm-4.7-flash",
    name: "GLM-4.7 Flash 30B A3B",
    repo: "unsloth/GLM-4.7-Flash-GGUF",
    totalB: 30,
    activeB: 3,
    scores: { smart: 4, code: 5, tools: 4, languages: 3 },
  },
  {
    id: "nemotron-3.5-lightning-30b",
    name: "Nemotron 3.5 Lightning 30B A3B",
    repo: "unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
    totalB: 33,
    activeB: 3,
    scores: { smart: 4, code: 4, tools: 4, languages: 3 },
  },
  {
    id: "qwen3.6-35b-a3b",
    name: "Qwen3.6 35B A3B",
    repo: "unsloth/Qwen3.6-35B-A3B-GGUF",
    totalB: 35,
    activeB: 3,
    scores: { smart: 4, code: 4, tools: 5, languages: 3 },
  },
  // Dense, for safety: every token reads all their weights.
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8 27B",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    totalB: 27,
    activeB: 27,
    scores: { smart: 5, code: 4, tools: 5, languages: 3 },
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B",
    repo: "unsloth/gemma-4-31B-it-GGUF",
    totalB: 31,
    activeB: 31,
    scores: { smart: 4, code: 4, tools: 4, languages: 5 },
  },
  // Large mixtures of experts: 45-81 GB, card and RAM, or SSD stream.
  {
    id: "nemotron-3.5-bolt-74b",
    name: "Nemotron 3.5 Bolt 74B A9B",
    repo: "unsloth/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-GGUF",
    totalB: 74,
    activeB: 9,
    scores: { smart: 4, code: 4, tools: 5, languages: 3 },
  },
  {
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next 80B A3B",
    repo: "unsloth/Qwen3-Coder-Next-GGUF",
    totalB: 80,
    activeB: 3,
    scores: { smart: 4, code: 5, tools: 5, languages: 2 },
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
    id: "mistral-small-4",
    name: "Mistral Small 4 119B A6.5B",
    repo: "unsloth/Mistral-Small-4-119B-2603-GGUF",
    totalB: 119,
    activeB: 6.5,
    scores: { smart: 4, code: 4, tools: 4, languages: 5 },
  },
  {
    id: "nemotron-3.5-super-120b",
    name: "Nemotron 3.5 Super 120B A12B",
    repo: "unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF",
    totalB: 120,
    activeB: 12,
    scores: { smart: 5, code: 5, tools: 5, languages: 3 },
  },
  {
    id: "qwen3.5-122b",
    name: "Qwen3.5 122B A10B",
    repo: "unsloth/Qwen3.5-122B-A10B-GGUF",
    totalB: 122,
    activeB: 10,
    scores: { smart: 5, code: 5, tools: 5, languages: 4 },
    draft: { repo: "unsloth/Qwen3.5-0.8B-GGUF", quant: "Q8_0" },
  },
  // A large dense model, to compare: slow beyond the card, with speculative decoding.
  {
    id: "mistral-medium-3.5",
    name: "Mistral Medium 3.5 128B",
    repo: "unsloth/Mistral-Medium-3.5-128B-GGUF",
    totalB: 125,
    activeB: 125,
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
 * then (SSD stream) the SSD: each part of the reads goes at its place's speed. A rough
 * estimate, said as such.
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
  // A mixture of experts reads few of its experts at each token and the ones used most stay in
  // the system's cache: a tenth of its SSD share is really read (measured 2026-11-04: gpt-oss
  // 120B, 58 GB, 13-15 tokens/s on a 16 GB card with about 27 GB of RAM free). A dense model
  // reads all of it at every token.
  const moe = m.activeB < m.totalB * 0.5;
  const onSsd = (size - inCard - inRam) * (moe ? 0.1 : 1);
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
