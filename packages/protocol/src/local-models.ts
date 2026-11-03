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
  /** Billions of parameters in all, and those working on each word (mixture of experts). */
  totalB: number;
  activeB: number;
  scores: { smart: number; code: number; tools: number; languages: number };
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
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    repo: "unsloth/gemma-4-12b-it-GGUF",
    totalB: 12,
    activeB: 12,
    scores: { smart: 3, code: 2, tools: 3, languages: 4 },
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
];

/** What the computer has, as the setup describes it. */
export interface SpeedHardware {
  kind: "gpu" | "gpu-unknown" | "igpu" | "cpu";
  vramGb: number;
}

/**
 * About how many words a second a model writes here, and that as 1 to 5. Writing one word
 * reads the working part of the model from memory once, so the speed is the memory's bandwidth
 * divided by that part's size: a model inside the graphics card's memory reads at hundreds of
 * GB/s, one in the computer's memory at tens. A rough estimate, said as such in the UI.
 */
export function estimatedSpeed(
  m: Pick<LocalModel, "totalB" | "activeB">,
  fileGb: number,
  hw: SpeedHardware,
): { wordsPerSec: number; stars: number } {
  const inCard = hw.kind === "gpu" && fileGb <= hw.vramGb * 0.9;
  const bandwidth =
    hw.kind === "gpu"
      ? inCard
        ? 350
        : 60
      : hw.kind === "gpu-unknown"
        ? 150
        : hw.kind === "igpu"
          ? 70
          : 45;
  const readPerWord = Math.max(0.2, (fileGb * m.activeB) / m.totalB);
  // Real engines reach about half of the bandwidth; a token is about three quarters of a word.
  const wordsPerSec = Math.round((bandwidth / readPerWord) * 0.5 * 0.75);
  const stars =
    wordsPerSec >= 60
      ? 5
      : wordsPerSec >= 30
        ? 4
        : wordsPerSec >= 15
          ? 3
          : wordsPerSec >= 7
            ? 2
            : 1;
  return { wordsPerSec, stars };
}
