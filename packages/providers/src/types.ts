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
  /**
   * `none` forbids tool calls for this request while still sending the same tool list, so
   * the cached prefix (tools come first) is reused. Default `auto`.
   */
  toolChoice?: "auto" | "none" | undefined;
  /** Scheduling priority on shared local engines (higher first). */
  priority?: number | undefined;
  /** Where a local engine's saved KV cache belongs (a project); budgets are per scope. */
  cacheScope?: string | undefined;
}

/** Token usage, normalised. `inputTokens` is the total prompt size, cached tokens included. */
export interface Usage {
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` cached for one hour (billed at `cacheWrite1h`). */
  cacheWrite1hTokens?: number | undefined;
  outputTokens: number;
  /** Billed apart from the tokens: the provider's own tools (Anthropic's web search). */
  extraUsd?: number;
}

/** Timings reported by the server itself (llama.cpp, Ollama), when available. */
export interface ServerTimings {
  prefillMs?: number | undefined;
  decodeMs?: number | undefined;
  /** The tokens the server timed while generating (its own count, which goes with decodeMs). */
  decodeTokens?: number | undefined;
}

export interface AssistantMessage {
  role: "assistant";
  parts: AssistantPart[];
  native?: NativeContent | undefined;
}

export interface Completion {
  message: AssistantMessage;
  stopReason: StopReason;
  /** For refusals: the provider's category and explanation, when given. */
  stopDetails?: { category: string | null; explanation: string | null } | undefined;
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
  /**
   * How far the engine has read the prompt (llama.cpp's `return_progress`, 2026-11-03): tokens
   * in all, those found in its cache, those processed so far (cache included), milliseconds.
   */
  | { type: "prefill_progress"; total: number; cached: number; processed: number; ms: number }
  | { type: "done"; completion: Completion };

export interface ModelInfo {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
  pricing?: Pricing | undefined;
  /** It reads images (screenshots from tools are offered only then). */
  vision?: boolean | undefined;
}

/** USD per million tokens. */
export interface PriceSet {
  input: number;
  output: number;
  cacheRead: number;
  /** Cache writes with the default (5-minute) lifetime. */
  cacheWrite: number;
  /** Cache writes that last one hour (Anthropic: 2x input); `cacheWrite` when absent. */
  cacheWrite1h?: number | undefined;
}

/** USD per million tokens; some models charge more for long prompts. */
export interface Pricing extends PriceSet {
  /**
   * A request whose prompt (all input tokens: uncached, cache reads and writes) is over
   * `overTokens` pays these prices for all of its tokens (Claude Haiku 5.5: over 100K).
   */
  longPrompt?: { overTokens: number; prices: PriceSet } | undefined;
}

export interface Provider {
  readonly id: string;
  modelInfo(model: string): ModelInfo;
  /** The models one can pick (the composer's menu); best known first. */
  models?(signal?: AbortSignal): Promise<string[]>;
  stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

/** Thrown by providers for failures that another model may succeed on. */
export class ProviderError extends Error {
  /** The HTTP status, when the server answered. */
  readonly status: number | undefined;
  constructor(
    message: string,
    readonly retriable: boolean,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.status = options?.status;
  }

  /** The server refused the credentials: a new key is needed, retrying will not help. */
  get rejectedKey(): boolean {
    return this.status === 401 || this.status === 403;
  }
}
