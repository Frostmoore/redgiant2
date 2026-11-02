/**
 * Model providers people connect with a key of their own (G24.2): the wizard shows them as
 * cards, with a link to where the key is made. Anthropic has its own client; the others speak
 * the OpenAI-compatible API at `baseUrl`. The provider's id is the first part of a model spec
 * (`gemini/gemini-3-pro`).
 */
export interface KeyProvider {
  id: string;
  /** The brand, the same in every language. */
  name: string;
  kind: "anthropic" | "openai-compat";
  /** For `openai-compat`: the API's address, with its version. */
  baseUrl?: string;
  /** The page where the key is created. */
  keyUrl: string;
  /** How a key starts, shown as an example. */
  keyExample: string;
  /** Context window assumed for models the API does not describe. */
  contextWindow: number;
  /** How the API takes a reasoning effort. */
  effortStyle: "reasoning_effort" | "none";
}

export const KEY_PROVIDERS: readonly KeyProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    kind: "anthropic",
    keyUrl: "https://platform.claude.com/settings/keys",
    keyExample: "sk-ant-api03-…",
    contextWindow: 200_000,
    effortStyle: "reasoning_effort",
  },
  {
    id: "openai",
    name: "OpenAI (GPT)",
    kind: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    keyExample: "sk-proj-…",
    contextWindow: 400_000,
    effortStyle: "reasoning_effort",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    keyExample: "AIza…",
    contextWindow: 1_000_000,
    effortStyle: "reasoning_effort",
  },
  {
    id: "mistral",
    name: "Mistral",
    kind: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    keyExample: "…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "openai-compat",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    keyExample: "sk-…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    kind: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    keyExample: "xai-…",
    contextWindow: 256_000,
    effortStyle: "reasoning_effort",
  },
  {
    id: "groq",
    name: "Groq",
    kind: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    keyExample: "gsk_…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    keyExample: "sk-or-v1-…",
    contextWindow: 128_000,
    effortStyle: "reasoning_effort",
  },
  {
    id: "together",
    name: "Together AI",
    kind: "openai-compat",
    baseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    keyExample: "…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    kind: "openai-compat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
    keyExample: "fw_…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    kind: "openai-compat",
    baseUrl: "https://api.cerebras.ai/v1",
    keyUrl: "https://cloud.cerebras.ai",
    keyExample: "csk-…",
    contextWindow: 128_000,
    effortStyle: "none",
  },
];

export const keyProvider = (id: string): KeyProvider | undefined =>
  KEY_PROVIDERS.find((p) => p.id === id);

/** The id of the user's own OpenAI-compatible server (Ollama, LM Studio, vLLM…). */
export const OWN_SERVER_ID = "server";
