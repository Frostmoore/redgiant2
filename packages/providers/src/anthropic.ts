import Anthropic from "@anthropic-ai/sdk";
import {
  catalogModel,
  catalogModels,
  catalogPricing,
  isNewModel,
  newestRelease,
} from "./catalog.js";
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

/** What the provider needs of one model: from the catalog, the API's own list, or guesses. */
export interface AnthropicModelEntry {
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
  /** Adaptive thinking is requested explicitly (some models run without it when omitted). */
  adaptiveThinking: boolean;
  vision: boolean;
  /** Server-side fallback on a refusal (`fallbacks: "default"`). */
  serverFallback: boolean;
  /** Absent: prices not known. */
  pricing?: Pricing | undefined;
  name?: string | undefined;
  /** Not in the models catalog: limits from the API or guessed, prices unknown. */
  unconfirmed: boolean;
  isNew: boolean;
}

/** A model neither the catalog nor the API describes: careful limits, no extras. */
const UNKNOWN_MODEL: AnthropicModelEntry = {
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  supportsEffort: false,
  adaptiveThinking: false,
  vision: true,
  serverFallback: false,
  unconfirmed: true,
  isNew: false,
};

/** One model as the catalog has it (Claude API key and Claude subscription alike). */
export function anthropicModel(model: string): AnthropicModelEntry | undefined {
  const m = catalogModel("anthropic", model);
  if (!m) return undefined;
  return {
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    supportsEffort: m.effort,
    adaptiveThinking: m.adaptiveThinking,
    vision: m.vision,
    serverFallback: m.serverFallback === true,
    pricing: catalogPricing(m),
    name: m.name,
    unconfirmed: false,
    isNew: isNewModel(m),
  };
}

/** What `GET /v1/models` said about one model (3.5.4). */
interface ListedModel {
  id: string;
  name: string;
  createdAt: string;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  effort?: boolean | undefined;
  adaptive?: boolean | undefined;
  vision?: boolean | undefined;
}

/** The API's list is asked again after this long (a new model shows up within hours). */
export const MODEL_LIST_TTL_MS = 6 * 60 * 60 * 1000;
/** After a failed list, the next try waits this long (the menus keep the known models). */
const MODEL_LIST_RETRY_MS = 5 * 60 * 1000;

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
  models?: Record<string, Partial<AnthropicModelEntry>>;
  now?: () => number;
  /**
   * RedGiant's `web_search` tool becomes Anthropic's own (2026-11-03): Claude searches on the
   * server, filters the results with code (newer models) and cites its sources. Default on.
   */
  nativeWebSearch?: boolean;
}

/** USD for one search of Anthropic's web search ($10 for 1000). */
const WEB_SEARCH_USD = 0.01;
/** Models that filter search results with code (Claude 4.6 and later, not Haiku). */
const filtersSearch = (model: string) =>
  /^claude-(opus|sonnet|fable|mythos)-5|^claude-(opus|sonnet)-4-[6-9]/.test(model);

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
  pause_turn: "pause",
};

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
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

  private listed: { at: number; models: ListedModel[] } | undefined;
  private listFailedAt = 0;
  private listing: Promise<ListedModel[] | undefined> | undefined;

  private entry(model: string): AnthropicModelEntry {
    let base = anthropicModel(model);
    if (!base) {
      // Not in the catalog: what the API's own list says, prices unknown.
      const l = this.listed?.models.find((m) => m.id === model);
      base = {
        ...UNKNOWN_MODEL,
        ...(l && {
          name: l.name,
          ...(l.contextWindow && { contextWindow: l.contextWindow }),
          ...(l.maxOutputTokens && { maxOutputTokens: l.maxOutputTokens }),
          ...(l.effort !== undefined && { supportsEffort: l.effort }),
          ...(l.adaptive !== undefined && { adaptiveThinking: l.adaptive }),
          ...(l.vision !== undefined && { vision: l.vision }),
        }),
      };
    }
    return { ...base, ...this.options.models?.[model] };
  }

  private fallbacksFor(model: string): boolean {
    return (this.options.serverFallbacks ?? true) && this.entry(model).serverFallback;
  }

  /** Asks Anthropic whether the key works (a refused key throws, with its status). */
  async checkKey(signal?: AbortSignal): Promise<void> {
    try {
      await this.client.models.list({ limit: 1 }, signal ? { signal } : undefined);
    } catch (err) {
      throw toProviderError(err);
    }
  }

  /**
   * The models to offer (3.5.4): Anthropic's own list (`GET /v1/models`, every page), kept for a
   * few hours. The current generation per the catalog comes first (those this key can use), then
   * models the catalog does not know yet and that came out after the newest one it knows ("data
   * to be confirmed"). If the list cannot be read, the catalog's current models.
   */
  async models(signal?: AbortSignal): Promise<string[]> {
    const listed = await this.list(signal);
    const current = catalogModels("anthropic")
      .filter(([, m]) => m.status === "current")
      .map(([id]) => id);
    if (!listed) return current;
    const ids = new Set(listed.map((m) => m.id));
    const newest = newestRelease("anthropic");
    const unknown = listed
      .filter((m) => !catalogModel("anthropic", m.id))
      .filter((m) => newest !== undefined && m.createdAt.slice(0, 10) >= newest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((m) => m.id);
    return [...current.filter((id) => ids.has(id)), ...unknown];
  }

  /** The API's list, from the cache while fresh; undefined when it could not be read. */
  private async list(signal?: AbortSignal): Promise<ListedModel[] | undefined> {
    const now = (this.options.now ?? Date.now)();
    if (this.listed && now - this.listed.at < MODEL_LIST_TTL_MS) return this.listed.models;
    if (now - this.listFailedAt < MODEL_LIST_RETRY_MS) return this.listed?.models;
    this.listing ??= (async () => {
      try {
        const out: ListedModel[] = [];
        for await (const m of this.client.models.list(
          { limit: 100 },
          signal ? { signal } : undefined,
        ))
          out.push(listedModel(m));
        this.listed = { at: now, models: out };
        return out;
      } catch {
        this.listFailedAt = now;
        // An older list stays good while the API does not answer.
        return this.listed?.models;
      } finally {
        this.listing = undefined;
      }
    })();
    return this.listing;
  }

  modelInfo(model: string): ModelInfo {
    const e = this.entry(model);
    return {
      id: model,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      supportsEffort: e.supportsEffort,
      pricing: e.pricing,
      vision: e.vision,
      ...(e.name && { name: e.name }),
      ...(e.unconfirmed && { unconfirmed: true }),
      ...(e.isNew && { isNew: true }),
    };
  }

  /** Builds the request body. Exposed for tests of prompt-cache placement. */
  buildParams(request: CompletionRequest): Anthropic.MessageCreateParamsStreaming {
    const e = this.entry(request.model);
    const cacheControl: Anthropic.CacheControlEphemeral = this.options.longCache
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };

    const native = this.options.nativeWebSearch !== false;
    const tools: Anthropic.Tool[] = request.tools.map((t, i) => {
      const last = i === request.tools.length - 1 && { cache_control: cacheControl };
      // The same name, done by Anthropic: the tool list stays the same for RedGiant.
      if (native && t.name === "web_search")
        return {
          ...(filtersSearch(request.model)
            ? { type: "web_search_20260318", response_inclusion: "excluded" }
            : { type: "web_search_20250305" }),
          name: "web_search",
          max_uses: 8,
          ...last,
        } as unknown as Anthropic.Tool;
      return {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        eager_input_streaming: true,
        ...last,
      };
    });

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
              : p.type === "image"
                ? {
                    type: "image",
                    source: { type: "base64", media_type: p.mediaType, data: p.data },
                  }
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
        if (event.type !== "content_block_delta") {
          // The answer has started (or goes on): nothing to show, but alive (3.5.4).
          yield { type: "alive" };
          continue;
        }
        if (event.delta.type === "text_delta") {
          clock.token();
          text += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          clock.token();
          yield { type: "thinking_delta", text: event.delta.thinking };
        } else {
          // A tool call's arguments being written, a citation, a signature: alive.
          if (event.delta.type === "input_json_delta") clock.token();
          yield { type: "alive" };
        }
      }
      const final = await stream.finalMessage();

      const parts: AssistantPart[] = [];
      // Sources Claude cited from its own web search, listed once at the end of the answer.
      const sources = new Map<string, string>();
      for (const block of final.content) {
        for (const c of (block as { citations?: { url?: string; title?: string }[] | null })
          .citations ?? [])
          if (c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
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
      if (sources.size > 0) {
        const list = [...sources].map(([url, title], i) => `${i + 1}. [${title}](${url})`);
        parts.push({ type: "text", text: `\n\n${list.join("\n")}` });
      }
      const u = final.usage;
      const searches =
        (u as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use
          ?.web_search_requests ?? 0;
      const usage: Usage = {
        ...(searches > 0 && { extraUsd: searches * WEB_SEARCH_USD }),
        cachedReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        ...(u.cache_creation?.ephemeral_1h_input_tokens && {
          cacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens,
        }),
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

/** One entry of the Models API, as the provider keeps it. */
function listedModel(m: Anthropic.ModelInfo): ListedModel {
  const caps = m.capabilities as
    | {
        effort?: { supported?: boolean } | null;
        thinking?: { types?: { adaptive?: { supported?: boolean } | null } | null } | null;
        image_input?: { supported?: boolean } | null;
      }
    | null
    | undefined;
  return {
    id: m.id,
    name: m.display_name || m.id,
    createdAt: m.created_at ?? "",
    contextWindow: m.max_input_tokens ?? undefined,
    maxOutputTokens: m.max_tokens ?? undefined,
    effort: caps?.effort?.supported,
    adaptive: caps?.thinking?.types?.adaptive?.supported,
    vision: caps?.image_input?.supported,
  };
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
      status,
    });
  }
  // A tool input that could not be parsed at all: re-issuing the turn may succeed.
  return new ProviderError(`Anthropic stream failed: ${String(err)}`, true, { cause: err });
}
