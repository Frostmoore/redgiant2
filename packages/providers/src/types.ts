import type { Effort, MessageMetrics } from "@redgiant/protocol";

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type UserPart =
  | { type: "text"; text: string }
  | {
      type: "tool_result";
      callId: string;
      content: string;
      isError?: boolean | undefined;
    };

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      /** Parsed arguments, or `undefined` when the model produced invalid JSON. */
      input: unknown;
      /** The raw argument string as produced by the model. */
      rawInput: string;
    };

/**
 * Provider-native content of an assistant turn. Replayed verbatim to the same provider and
 * model (some providers bind thinking blocks to the model that produced them); other
 * providers rebuild the turn from the neutral `parts`.
 */
export interface NativeContent {
  provider: string;
  model: string;
  content: unknown;
}

export type ChatMessage =
  | { role: "user"; parts: UserPart[] }
  | { role: "assistant"; parts: AssistantPart[]; native?: NativeContent | undefined };

export interface CompletionRequest {
  model: string;
  /** Stable system prompt. Never put timestamps or other volatile data here. */
  system: string;
  /** Tools in a canonical, stable order. */
  tools: ToolDef[];
  messages: ChatMessage[];
  effort?: Effort | undefined;
  maxTokens?: number | undefined;
  /** Stable per-session key, for providers that route by cache key. */
  cacheKey?: string | undefined;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause"
  | "aborted"
  | "other";

/** Token usage, normalised. `inputTokens` is the total prompt size, cached tokens included. */
export interface Usage {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Timings reported by the server itself (llama.cpp, Ollama), when available. */
export interface ServerTimings {
  prefillMs?: number | undefined;
  decodeMs?: number | undefined;
}

export interface AssistantMessage {
  role: "assistant";
  parts: AssistantPart[];
  native?: NativeContent | undefined;
}

export interface Completion {
  message: AssistantMessage;
  stopReason: StopReason;
  usage: Usage;
  metrics: MessageMetrics;
  /** Model that actually served the request (may differ from the requested one on fallback). */
  model: string;
  provider: string;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown; rawInput: string }
  | { type: "done"; completion: Completion };

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
  pricing?: Pricing | undefined;
}

/** USD per million tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Provider {
  readonly id: string;
  modelInfo(model: string): ModelInfo;
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

/** Thrown by providers for failures that another model may succeed on. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}
