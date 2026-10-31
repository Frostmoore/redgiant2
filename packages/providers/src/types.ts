import type {
  AssistantPart,
  ChatMessage,
  Effort,
  MessageMetrics,
  NativeContent,
  StopReason,
} from "@redgiant/protocol";

export type {
  AssistantPart,
  ChatMessage,
  NativeContent,
  StopReason,
  UserPart,
} from "@redgiant/protocol";

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
