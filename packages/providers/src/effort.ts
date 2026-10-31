import type { Effort } from "@redgiant/protocol";

/** Anthropic `output_config.effort` value for a RedGiant effort level. */
export function anthropicEffort(effort: Effort): "low" | "medium" | "high" | "max" {
  return effort;
}

/** How an OpenAI-compatible server is told about reasoning effort. */
export type EffortStyle =
  /** `reasoning_effort: low|medium|high` (OpenAI, vLLM, many gateways). */
  | "reasoning_effort"
  /** `chat_template_kwargs.enable_thinking` (llama.cpp / vLLM with hybrid-thinking templates). */
  | "template_thinking"
  /** The server has no effort control; the level is ignored. */
  | "none";

export function openAiEffortFields(
  effort: Effort | undefined,
  style: EffortStyle,
): Record<string, unknown> {
  if (effort === undefined || style === "none") return {};
  if (style === "reasoning_effort") {
    return { reasoning_effort: effort === "max" ? "high" : effort };
  }
  return { chat_template_kwargs: { enable_thinking: effort !== "low" } };
}
