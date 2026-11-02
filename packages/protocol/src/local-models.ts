/**
 * Models suggested for this computer (G24.3), from the smallest to the largest: well known,
 * good with RedGiant's tools, from publishers who keep their files tidy. The wizard picks the
 * best quantisation that fits; what each one is good at is in the UI's words (`lm_<id>`).
 * Checked on Hugging Face on 2026-11-03.
 */
export interface LocalModel {
  id: string;
  name: string;
  repo: string;
}

export const LOCAL_MODELS: readonly LocalModel[] = [
  { id: "gemma-4-e2b", name: "Gemma 4 E2B", repo: "unsloth/gemma-4-E2B-it-GGUF" },
  { id: "gemma-4-e4b", name: "Gemma 4 E4B", repo: "unsloth/gemma-4-E4B-it-GGUF" },
  { id: "gemma-4-12b", name: "Gemma 4 12B", repo: "unsloth/gemma-4-12b-it-GGUF" },
  { id: "gpt-oss-20b", name: "gpt-oss 20B", repo: "unsloth/gpt-oss-20b-GGUF" },
  { id: "gemma-4-26b", name: "Gemma 4 26B A4B", repo: "unsloth/gemma-4-26B-A4B-it-GGUF" },
  {
    id: "qwen3-coder-30b",
    name: "Qwen3 Coder 30B A3B",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
  },
  { id: "qwen3.8-27b", name: "Qwen3.8 27B", repo: "unsloth/Qwen3.8-27B-GGUF" },
];
