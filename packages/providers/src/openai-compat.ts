import { type EffortStyle, openAiEffortFields } from "./effort.js";
import { MetricsClock } from "./metrics.js";
import { sseData } from "./sse.js";
import {
  type AssistantPart,
  type ChatMessage,
  type CompletionRequest,
  type ModelInfo,
  type Provider,
  ProviderError,
  type ServerTimings,
  type StopReason,
  type StreamEvent,
  type Usage,
} from "./types.js";

export interface OpenAICompatOptions {
  /** Provider id used in model specs, e.g. "local", "openrouter". */
  id?: string;
  /** Base URL including `/v1`, e.g. `http://localhost:8080/v1`. */
  baseURL: string;
  apiKey?: string;
  effortStyle?: EffortStyle;
  /** Per-model overrides; unknown models get `defaultContextWindow`. */
  models?: Record<string, Partial<ModelInfo>>;
  defaultContextWindow?: number;
  /** Send `prompt_cache_key` (OpenAI); local servers usually ignore it. */
  sendCacheKey?: boolean;
  /**
   * Send previous turns' reasoning back as `reasoning_content` (default true). The KV cache
   * of a local server holds the reasoning it generated; dropping it from the history makes
   * the prompt diverge from the cache at that turn and forces a re-prefill of everything
   * after it. Templates that strip old reasoning ignore the field.
   */
  replayReasoning?: boolean;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };

interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  /** llama.cpp server extension. */
  timings?: {
    cache_n?: number;
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_ms?: number;
  };
  model?: string;
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/**
 * Chat Completions client for any OpenAI-compatible server: llama.cpp, vLLM, Ollama,
 * LM Studio, OpenRouter, OpenAI itself.
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatOptions) {
    this.id = options.id ?? "openai-compat";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private readonly discovered = new Map<string, number>();

  modelInfo(model: string): ModelInfo {
    // A server that serves a single model (llama.cpp) answers whatever name is asked for.
    const only = this.discovered.size === 1 ? [...this.discovered.values()][0] : undefined;
    return {
      id: model,
      contextWindow:
        this.discovered.get(model) ?? only ?? this.options.defaultContextWindow ?? 8192,
      maxOutputTokens: 4096,
      supportsEffort: (this.options.effortStyle ?? "none") !== "none",
      ...this.options.models?.[model],
    };
  }

  /**
   * Reads context windows from `GET /models`: `meta.n_ctx` (llama.cpp), `max_model_len`
   * (vLLM) or `context_length` (OpenRouter). Returns the models found.
   */
  async discover(signal?: AbortSignal): Promise<{ id: string; contextWindow?: number }[]> {
    const response = await this.fetchImpl(`${this.options.baseURL.replace(/\/$/, "")}/models`, {
      headers: {
        ...(this.options.apiKey && { authorization: `Bearer ${this.options.apiKey}` }),
        ...this.options.headers,
      },
      ...(signal && { signal }),
    });
    if (!response.ok)
      throw new ProviderError(
        `${this.id}: HTTP ${response.status} on /models`,
        response.status >= 500,
      );
    const body = (await response.json()) as {
      data?: {
        id: string;
        meta?: { n_ctx?: number };
        max_model_len?: number;
        context_length?: number;
      }[];
    };
    return (body.data ?? []).map((m) => {
      const ctx = m.meta?.n_ctx ?? m.max_model_len ?? m.context_length;
      if (ctx !== undefined) this.discovered.set(m.id, ctx);
      return ctx !== undefined ? { id: m.id, contextWindow: ctx } : { id: m.id };
    });
  }

  /** Builds the request body. Exposed for tests. */
  buildBody(request: CompletionRequest): Record<string, unknown> {
    const messages: WireMessage[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    for (const m of request.messages) {
      messages.push(...toWire(m, this.options.replayReasoning ?? true));
    }
    return {
      model: request.model,
      messages,
      ...(request.tools.length > 0 && {
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
      ...(request.tools.length > 0 && request.toolChoice === "none" && { tool_choice: "none" }),
      ...(request.maxTokens !== undefined && { max_tokens: request.maxTokens }),
      ...openAiEffortFields(request.effort, this.options.effortStyle ?? "none"),
      ...(this.options.sendCacheKey && request.cacheKey && { prompt_cache_key: request.cacheKey }),
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const info = this.modelInfo(request.model);
    const clock = new MetricsClock();
    let text = "";
    let thinking = "";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | undefined;
    let usageChunk: Chunk["usage"];
    let timings: Chunk["timings"];
    let servedModel = request.model;

    try {
      const response = await this.fetchImpl(
        `${this.options.baseURL.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(this.options.apiKey && { authorization: `Bearer ${this.options.apiKey}` }),
            ...this.options.headers,
          },
          body: JSON.stringify(this.buildBody(request)),
          ...(signal && { signal }),
        },
      );
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        const retriable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ProviderError(
          `${this.id}: HTTP ${response.status} ${detail.slice(0, 500)}`,
          retriable,
        );
      }

      for await (const data of sseData(response.body)) {
        if (data.trim() === "[DONE]") break;
        const chunk = JSON.parse(data) as Chunk;
        if (chunk.model) servedModel = chunk.model;
        if (chunk.usage) usageChunk = chunk.usage;
        if (chunk.timings) timings = chunk.timings;
        for (const choice of chunk.choices ?? []) {
          const d = choice.delta;
          if (choice.finish_reason) finish = choice.finish_reason;
          if (!d) continue;
          const reasoning = d.reasoning_content ?? d.reasoning;
          if (reasoning) {
            clock.token();
            thinking += reasoning;
            yield { type: "thinking_delta", text: reasoning };
          }
          if (d.content) {
            clock.token();
            text += d.content;
            yield { type: "text_delta", text: d.content };
          }
          for (const tc of d.tool_calls ?? []) {
            clock.token();
            const acc = calls.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            calls.set(tc.index, acc);
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) {
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
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`${this.id}: ${String(err)}`, true, { cause: err });
    }

    const parts: AssistantPart[] = [];
    if (thinking) parts.push({ type: "thinking", text: thinking });
    if (text) parts.push({ type: "text", text });
    for (const [index, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      const call = {
        type: "tool_call" as const,
        callId: c.id || `call_${index}`,
        name: c.name,
        input: parseArgs(c.args),
        rawInput: c.args,
      };
      parts.push(call);
      yield { ...call };
    }

    const usage = normaliseUsage(usageChunk, timings);
    const server: ServerTimings | undefined =
      timings?.prompt_ms !== undefined && timings.predicted_ms !== undefined
        ? { prefillMs: timings.prompt_ms, decodeMs: timings.predicted_ms }
        : undefined;
    yield {
      type: "done",
      completion: {
        message: { role: "assistant", parts },
        stopReason:
          calls.size > 0 && finish !== "length"
            ? "tool_use"
            : (STOP_REASONS[finish ?? ""] ?? "other"),
        usage,
        metrics: clock.finish(usage, info.contextWindow, server),
        model: servedModel,
        provider: this.id,
      },
    };
  }
}

function toWire(m: ChatMessage, replayReasoning: boolean): WireMessage[] {
  if (m.role === "user") {
    const out: WireMessage[] = [];
    const texts: string[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: p.callId,
          content: p.isError ? `ERROR: ${p.content}` : p.content,
        });
      } else {
        texts.push(p.text);
      }
    }
    if (texts.length > 0) out.push({ role: "user", content: texts.join("\n\n") });
    return out;
  }
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const reasoning = m.parts.flatMap((p) => (p.type === "thinking" ? [p.text] : [])).join("");
  const toolCalls = m.parts.flatMap((p) =>
    p.type === "tool_call"
      ? [
          {
            id: p.callId,
            type: "function" as const,
            function: { name: p.name, arguments: p.rawInput },
          },
        ]
      : [],
  );
  return [
    {
      role: "assistant",
      content: text || null,
      ...(replayReasoning && reasoning && { reasoning_content: reasoning }),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
  ];
}

/** Parsed arguments, or `undefined` when the model produced invalid JSON (repaired later). */
function parseArgs(raw: string): unknown {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normaliseUsage(u: Chunk["usage"], t: Chunk["timings"]): Usage {
  if (t?.prompt_n !== undefined) {
    const cached = t.cache_n ?? 0;
    return {
      inputTokens: t.prompt_n + cached,
      cachedReadTokens: cached,
      cacheWriteTokens: 0,
      outputTokens: t.predicted_n ?? u?.completion_tokens ?? 0,
    };
  }
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    cachedReadTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
    outputTokens: u?.completion_tokens ?? 0,
  };
}
