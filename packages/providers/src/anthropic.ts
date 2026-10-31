import Anthropic from "@anthropic-ai/sdk";
import { anthropicEffort } from "./effort.js";
import { MetricsClock } from "./metrics.js";
import {
  type AssistantPart,
  type ChatMessage,
  type CompletionRequest,
  type ModelInfo,
  type Pricing,
  type Provider,
  ProviderError,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "./types.js";

interface CatalogEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
  /** Adaptive thinking is requested explicitly (some models run without it when omitted). */
  adaptiveThinking: boolean;
  pricing: Pricing;
}

/** Cache writes with the default 5-minute TTL cost 1.25x input. */
const price = (input: number, output: number, cacheRead = input / 10): Pricing => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

const current = (pricing: Pricing): CatalogEntry => ({
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  supportsEffort: true,
  adaptiveThinking: true,
  pricing,
});

/** Known models (prices in USD per million tokens, as of 2026-10). Overridable via options. */
export const ANTHROPIC_MODELS: Record<string, CatalogEntry> = {
  "claude-fable-5-1": current(price(10, 50, 0.25)),
  "claude-fable-5": current(price(10, 50)),
  "claude-opus-5-5": current(price(4, 20, 0.2)),
  "claude-opus-5": current(price(5, 25)),
  "claude-opus-4-8": current(price(5, 25)),
  "claude-opus-4-7": current(price(5, 25)),
  "claude-opus-4-6": current(price(5, 25)),
  "claude-sonnet-5-5": current(price(2, 10, 0.2)),
  "claude-sonnet-5": current(price(2, 10)),
  "claude-sonnet-4-6": current(price(3, 15)),
  "claude-haiku-5-5": current(price(0.1, 0.5)),
  "claude-haiku-4-5": {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsEffort: false,
    adaptiveThinking: false,
    pricing: price(1, 5),
  },
};

const UNKNOWN_MODEL: Omit<CatalogEntry, "pricing"> = {
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsEffort: false,
  adaptiveThinking: false,
};

export interface AnthropicProviderOptions {
  /** Pre-built client; otherwise one is created from the options below. */
  client?: Anthropic;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  /** Cache tools and system prompt for 1 hour instead of 5 minutes (writes cost 2x input). */
  longCache?: boolean;
  /**
   * Server-side fallback (`fallbacks: "default"`): when a model's safety classifiers decline,
   * Anthropic re-runs the request on the model it recommends for that category, in the same
   * call. On by default where supported, as Anthropic recommends.
   */
  serverFallbacks?: boolean;
  models?: Record<string, Partial<CatalogEntry>>;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause",
};

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models with server-side fallback on the Claude API (not Haiku 5.5, not older ones). */
const SERVER_FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
        ...(options.baseURL !== undefined && { baseURL: options.baseURL }),
        ...(options.fetch !== undefined && { fetch: options.fetch }),
        maxRetries: options.maxRetries ?? 2,
      });
  }

  private entry(model: string): CatalogEntry | (typeof UNKNOWN_MODEL & { pricing?: Pricing }) {
    const base = ANTHROPIC_MODELS[model] ?? UNKNOWN_MODEL;
    return { ...base, ...this.options.models?.[model] };
  }

  private fallbacksFor(model: string): boolean {
    return (this.options.serverFallbacks ?? true) && SERVER_FALLBACK_MODELS.has(model);
  }

  modelInfo(model: string): ModelInfo {
    const e = this.entry(model);
    return {
      id: model,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      supportsEffort: e.supportsEffort,
      pricing: e.pricing,
    };
  }

  /** Builds the request body. Exposed for tests of prompt-cache placement. */
  buildParams(request: CompletionRequest): Anthropic.MessageCreateParamsStreaming {
    const e = this.entry(request.model);
    const cacheControl: Anthropic.CacheControlEphemeral = this.options.longCache
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };

    const tools: Anthropic.Tool[] = request.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
      ...(i === request.tools.length - 1 && { cache_control: cacheControl }),
    }));

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? Math.min(64_000, e.maxOutputTokens),
      messages: request.messages.map((m) => this.toParam(m)),
      // Automatic breakpoint on the last cacheable block: caches the conversation so far.
      cache_control: { type: "ephemeral" },
      stream: true,
    };
    if (request.system) {
      params.system = [{ type: "text", text: request.system, cache_control: cacheControl }];
    }
    if (tools.length > 0) params.tools = tools;
    if (e.adaptiveThinking) params.thinking = { type: "adaptive", display: "summarized" };
    if (tools.length > 0 && request.toolChoice === "none") params.tool_choice = { type: "none" };
    if (this.fallbacksFor(request.model))
      (params as unknown as Record<string, unknown>).fallbacks = "default";
    if (e.supportsEffort && request.effort) {
      params.output_config = { effort: anthropicEffort(request.effort) };
    }
    return params;
  }

  private toParam(message: ChatMessage): Anthropic.MessageParam {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.parts.map(
          (p): Anthropic.ContentBlockParam =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : {
                  type: "tool_result",
                  tool_use_id: p.callId,
                  content: p.content,
                  ...(p.isError && { is_error: true }),
                },
        ),
      };
    }
    // Replay native blocks unchanged: thinking blocks must come back exactly as produced.
    if (message.native?.provider === this.id) {
      return {
        role: "assistant",
        content: message.native.content as Anthropic.ContentBlockParam[],
      };
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const p of message.parts) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      if (p.type === "tool_call") {
        content.push({ type: "tool_use", id: p.callId, name: p.name, input: p.input ?? {} });
      }
    }
    return { role: "assistant", content };
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const info = this.modelInfo(request.model);
    const clock = new MetricsClock();
    const stream = this.client.messages.stream(this.buildParams(request), {
      signal,
      ...(this.fallbacksFor(request.model) && { headers: { "anthropic-beta": FALLBACK_BETA } }),
    });
    let text = "";

    try {
      for await (const event of stream) {
        // Generation starts with the first content block of any kind (thinking included):
        // timing from the first text delta would hide reasoning and tool-call generation.
        if (event.type === "content_block_start") clock.token();
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          clock.token();
          text += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          clock.token();
          yield { type: "thinking_delta", text: event.delta.thinking };
        } else if (event.delta.type === "input_json_delta") {
          clock.token();
        }
      }
      const final = await stream.finalMessage();

      const parts: AssistantPart[] = [];
      for (const block of final.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        if (block.type === "thinking") parts.push({ type: "thinking", text: block.thinking });
        if (block.type === "tool_use") {
          const call = {
            type: "tool_call" as const,
            callId: block.id,
            name: block.name,
            input: block.input,
            rawInput: JSON.stringify(block.input),
          };
          parts.push(call);
          yield { ...call };
        }
      }
      const u = final.usage;
      const usage: Usage = {
        cachedReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        inputTokens:
          u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      };
      yield {
        type: "done",
        completion: {
          message: {
            role: "assistant",
            parts,
            native: { provider: this.id, model: final.model, content: final.content },
          },
          stopReason: STOP_REASONS[final.stop_reason ?? ""] ?? "other",
          ...(final.stop_reason === "refusal" && {
            stopDetails: {
              category:
                (final as { stop_details?: { category?: string | null } }).stop_details?.category ??
                null,
              explanation:
                (final as { stop_details?: { explanation?: string | null } }).stop_details
                  ?.explanation ?? null,
            },
          }),
          usage,
          metrics: clock.finish(usage, info.contextWindow),
          model: final.model,
          provider: this.id,
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
        const usage: Usage = {
          inputTokens: 0,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        };
        yield {
          type: "done",
          completion: {
            message: { role: "assistant", parts: text ? [{ type: "text", text }] : [] },
            stopReason: "aborted",
            usage,
            metrics: clock.finish(usage, info.contextWindow),
            model: request.model,
            provider: this.id,
          },
        };
        return;
      }
      throw toProviderError(err);
    }
  }
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Anthropic connection error: ${err.message}`, true, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const retriable = status === 408 || status === 409 || status === 429 || status >= 500;
    return new ProviderError(`Anthropic API error ${status}: ${err.message}`, retriable, {
      cause: err,
    });
  }
  // A tool input that could not be parsed at all: re-issuing the turn may succeed.
  return new ProviderError(`Anthropic stream failed: ${String(err)}`, true, { cause: err });
}
