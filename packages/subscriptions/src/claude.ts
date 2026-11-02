// Claude on a flat subscription (G21.2), through Anthropic's own Claude Agent SDK: the official way to
// run Claude with a subscription's login (a token from `claude setup-token`). The SDK runs the model
// loop; its own tools are switched off and RedGiant's tools are offered as an in-process MCP server,
// so permissions, sandbox and the event log stay RedGiant's.
//
// This is the only file that knows the SDK. Its usage method is marked experimental: if it changes,
// only `limits` here needs fixing.
import type { Engine, EngineTurn } from "@redgiant/agent";
import type { AssistantPart, MessageMetrics, ModelSpec } from "@redgiant/protocol";
import {
  ANTHROPIC_MODELS,
  type ModelInfo,
  type Provider,
  ProviderError,
  type SubscriptionWindow,
} from "@redgiant/providers";
import { z } from "zod";

export const CLAUDE_SUBSCRIPTION = "claude-subscription";
const SERVER = "redgiant";
const PREFIX = `mcp__${SERVER}__`;

/** What the engine needs from the SDK; tests pass fakes, production passes the real module. */
export interface ClaudeSdk {
  query(o: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): AsyncIterable<
    Record<string, unknown>
  > & {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
    interrupt?(): Promise<void>;
  };
  createSdkMcpServer(o: { name: string; tools: unknown[] }): unknown;
  tool(
    name: string,
    description: string,
    shape: Record<string, z.ZodType>,
    handler: (
      args: unknown,
      extra: unknown,
    ) => Promise<{
      content: { type: "text"; text: string }[];
      isError?: boolean;
    }>,
  ): unknown;
}

export interface ClaudeSubscriptionOptions {
  /** The subscription's long-lived token (`claude setup-token`). */
  token: string;
  /** Where the engine keeps its own state (sessions, settings), apart from the user's. */
  configDir: string;
  /** A directory the engine may call home (it touches no files: its tools are off). */
  cwd: string;
  sdk?: ClaudeSdk;
  now?: () => number;
}

const loadSdk = async (): Promise<ClaudeSdk> =>
  (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;

/** RedGiant's JSON Schemas as the zod shapes the SDK asks for (it turns them back into JSON Schema). */
function shapeOf(schema: unknown): Record<string, z.ZodType> {
  try {
    const s = z.fromJSONSchema(schema as never) as unknown as { shape?: Record<string, z.ZodType> };
    return s.shape ?? {};
  } catch {
    return {};
  }
}

type Block = { type: string; [k: string]: unknown };

/** A message's usage as RedGiant's metrics (the window from the model's catalogue). */
function metricsOf(
  usage: Record<string, number> | undefined,
  model: string,
  started: number,
  now: number,
): MessageMetrics {
  const input = usage?.input_tokens ?? 0;
  const read = usage?.cache_read_input_tokens ?? 0;
  const write = usage?.cache_creation_input_tokens ?? 0;
  const out = usage?.output_tokens ?? 0;
  const window = ANTHROPIC_MODELS[model]?.contextWindow ?? 200_000;
  return {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(now).toISOString(),
    inputTokens: input + read + write,
    cachedReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: out,
    contextUsed: input + read + write + out,
    contextWindow: window,
    prefillMs: 0,
    decodeMs: 0,
    tokPerSec: 0,
    source: "server",
  };
}

/** One SDK turn: prompt in, assistant messages out, RedGiant's tools in between. */
export class ClaudeEngine implements Engine {
  readonly id = CLAUDE_SUBSCRIPTION;
  /** The plan's windows, as the turns report them (the provider shows them). */
  onLimits: ((w: SubscriptionWindow[]) => void) | undefined;
  constructor(private readonly o: ClaudeSubscriptionOptions) {}

  private env(): Record<string, string> {
    return {
      ...(process.env.PATH && { PATH: process.env.PATH }),
      HOME: this.o.configDir,
      CLAUDE_CONFIG_DIR: this.o.configDir,
      // Without a token the engine uses the login already in its folder (`claude login`).
      ...(this.o.token && { CLAUDE_CODE_OAUTH_TOKEN: this.o.token }),
      // No self-updates. (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is left out on purpose: with
      // it the engine loads ~36k tokens of tool definitions it would otherwise defer.)
      DISABLE_AUTOUPDATER: "1",
    };
  }

  /** The common options: no own tools, no settings files, only RedGiant's server. */
  options(model: ModelSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: model.model,
      ...(model.effort && { effort: model.effort }),
      tools: [],
      // No skills listing, no settings files: the agent is RedGiant's, not Claude Code's.
      skills: [],
      // Only RedGiant's MCP server: the account's claude.ai connectors would add tens of
      // thousands of tokens of tools to every call (they load in the background).
      strictMcpConfig: true,
      settingSources: [],
      cwd: this.o.cwd,
      env: this.env(),
      ...extra,
    };
  }

  async turn(t: EngineTurn): Promise<{ resume: string; stopReason: "end_turn" | "aborted" }> {
    const sdk = this.o.sdk ?? (await loadSdk());
    const now = this.o.now ?? Date.now;
    // The SDK's tool calls reach our handlers without their tool_use id: each call takes the
    // oldest announced id with that name (the assistant message always comes first).
    const pending = new Map<string, string[]>();
    const tools = t.tools.map((d) =>
      sdk.tool(d.name, d.description, shapeOf(d.inputSchema), async (args) => {
        const callId = pending.get(d.name)?.shift() ?? `call_${d.name}_${now()}`;
        const r = await t.runTool({ callId, name: d.name, input: args });
        return {
          content: [{ type: "text", text: r.content }],
          ...(r.isError && { isError: true }),
        };
      }),
    );
    const user = {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: t.text },
          ...t.images.map((im) => ({
            type: "image",
            source: { type: "base64", media_type: im.mediaType, data: im.data },
          })),
        ],
      },
    };
    // The prompt ends at once: kept open, the engine switches to its interactive mode and loads
    // ~44k more tokens of context on every call.
    async function* prompt() {
      yield user;
    }
    const abort = new AbortController();
    const stop = () => abort.abort();
    t.signal?.addEventListener("abort", stop, { once: true });
    let session = t.resume ?? "";
    let started = now();
    let stopReason: "end_turn" | "aborted" = "end_turn";
    try {
      const q = sdk.query({
        prompt: prompt(),
        options: this.options(t.model, {
          systemPrompt: t.system,
          mcpServers: { [SERVER]: sdk.createSdkMcpServer({ name: SERVER, tools }) },
          allowedTools: t.tools.map((d) => `${PREFIX}${d.name}`),
          // Only RedGiant's tools are allowed, and RedGiant asks its own permissions inside
          // each of them; anything else the engine would refuse without asking.
          permissionMode: "dontAsk",
          includePartialMessages: Boolean(t.live),
          abortController: abort,
          ...(t.resume && { resume: t.resume }),
        }),
      });
      for await (const m of q) {
        if (typeof m.session_id === "string") session = m.session_id;
        // The engine summarised its own context (Claude Agent SDK "compact_boundary").
        if (m.type === "system" && (m as { subtype?: string }).subtype === "compact_boundary") {
          const meta = (m as { compact_metadata?: { trigger?: string; pre_tokens?: number } })
            .compact_metadata;
          t.onCompaction?.({ trigger: meta?.trigger ?? "auto", preTokens: meta?.pre_tokens });
        }
        if (m.type === "stream_event") {
          const e = m.event as {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
          };
          if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text)
            t.live?.({ type: "text_delta", text: e.delta.text });
          if (
            e.type === "content_block_delta" &&
            e.delta?.type === "thinking_delta" &&
            e.delta.thinking
          )
            t.live?.({ type: "thinking_delta", text: e.delta.thinking });
          continue;
        }
        if (m.type === "assistant" && m.parent_tool_use_id === null) {
          const msg = m.message as {
            content?: Block[];
            usage?: Record<string, number>;
            model?: string;
            stop_reason?: string;
          };
          const parts: AssistantPart[] = [];
          for (const b of msg.content ?? []) {
            if (b.type === "text" && typeof b.text === "string" && b.text)
              parts.push({ type: "text", text: b.text });
            else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking)
              parts.push({ type: "thinking", text: b.thinking });
            else if (b.type === "tool_use" && typeof b.name === "string") {
              const name = b.name.startsWith(PREFIX) ? b.name.slice(PREFIX.length) : b.name;
              const callId = String(b.id);
              pending.set(name, [...(pending.get(name) ?? []), callId]);
              parts.push({
                type: "tool_call",
                callId,
                name,
                input: b.input,
                rawInput: JSON.stringify(b.input ?? {}),
              });
            }
          }
          if (parts.length === 0) continue;
          await t.onMessage({
            parts,
            metrics: metricsOf(msg.usage, t.model.model, started, now()),
            stopReason: parts.some((p) => p.type === "tool_call") ? "tool_use" : "end_turn",
            model: msg.model ?? t.model.model,
          });
          started = now();
        }
        if (m.type === "rate_limit_event") {
          const w = eventWindows(m.rate_limit_info);
          if (w.length) this.onLimits?.(w);
          continue;
        }
        if (m.type === "result") {
          // The full reading (with per-model windows such as Fable) when the process still
          // answers; the rate-limit events already gave 5h and 7d.
          const usage = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.();
          if (usage)
            void Promise.race([usage, new Promise((r) => setTimeout(r, 3000).unref?.())])
              .then((u) => {
                const w = claudeWindows(u);
                if (w.length) this.onLimits?.(w);
              })
              .catch(() => {});
          if (m.subtype !== "success") {
            const why = Array.isArray(m.errors)
              ? (m.errors as string[]).join("; ")
              : String(m.subtype);
            if (abort.signal.aborted) stopReason = "aborted";
            else throw new ProviderError(`Claude subscription: ${why}`, false);
          }
          if (m.is_error === true && typeof m.result === "string") {
            const text = m.result;
            throw new ProviderError(
              `Claude subscription: ${text}`,
              false,
              /401|authentication|invalid.*token|oauth|logged in|\/login/i.test(text)
                ? { status: 401 }
                : {},
            );
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) stopReason = "aborted";
      else throw err;
    } finally {
      t.signal?.removeEventListener("abort", stop);
    }
    return { resume: session, stopReason };
  }
}

/** A `rate_limit_event`'s windows (utilisation as a fraction, reset in seconds). */
export function eventWindows(info: unknown): SubscriptionWindow[] {
  const u = (
    info as
      | { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> }
      | undefined
  )?.unifiedWindows;
  const out: SubscriptionWindow[] = [];
  for (const [key, id, label] of [
    ["five_hour", "5h", "5h"],
    ["seven_day", "7d", "7g"],
  ] as const) {
    const w = u?.[key];
    if (typeof w?.utilization !== "number") continue;
    const pct = w.utilization <= 1 ? w.utilization * 100 : w.utilization;
    out.push({
      id,
      label,
      usedPct: Math.round(pct),
      ...(w.resetsAt && {
        resetsAt: new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toISOString(),
      }),
    });
  }
  return out;
}

/** The SDK's usage answer as windows (5 hours, 7 days, and per-model ones like Fable). */
export function claudeWindows(r: unknown): SubscriptionWindow[] {
  const rl = (r as { rate_limits?: Record<string, unknown> | null } | undefined)?.rate_limits ?? {};
  type W = { utilization?: number | null; resets_at?: string | null; display_name?: string };
  const out: SubscriptionWindow[] = [];
  const add = (id: string, label: string, w: W | null | undefined) => {
    if (typeof w?.utilization === "number")
      out.push({
        id,
        label,
        usedPct: Math.round(w.utilization),
        ...(w.resets_at && { resetsAt: w.resets_at }),
      });
  };
  add("5h", "5h", rl.five_hour as W | undefined);
  add("7d", "7g", rl.seven_day as W | undefined);
  for (const m of (rl.model_scoped as W[] | null | undefined) ?? [])
    if (m.display_name) add(`model:${m.display_name}`, m.display_name, m);
  return out;
}

/**
 * The provider RedGiant sees: models to pick, their windows, the engine, the plan's limits.
 * It has no `stream`: sessions on it always go through the engine.
 */
export class ClaudeSubscriptionProvider implements Provider {
  readonly id = CLAUDE_SUBSCRIPTION;
  readonly engine: ClaudeEngine;
  private cached: { at: number; windows: SubscriptionWindow[] } | undefined;

  constructor(o: ClaudeSubscriptionOptions) {
    this.engine = new ClaudeEngine(o);
    this.engine.onLimits = (w) => this.merge(w);
  }

  async models(): Promise<string[]> {
    return ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
  }

  modelInfo(model: string): ModelInfo {
    const e = ANTHROPIC_MODELS[model];
    return {
      id: model,
      contextWindow: e?.contextWindow ?? 200_000,
      maxOutputTokens: e?.maxOutputTokens ?? 64_000,
      supportsEffort: e?.supportsEffort ?? true,
    };
  }

  // biome-ignore lint/correctness/useYield: a session on a subscription never streams here.
  async *stream(): AsyncIterable<never> {
    throw new ProviderError(
      "A Claude subscription runs through its engine, not as a stream",
      false,
    );
  }

  private windows: SubscriptionWindow[] = [];

  /**
   * The plan's limits as the last turn left them: the SDK knows them only after a real request
   * in the same process, so they come with the turns (no extra calls, no extra cost). Windows a
   * newer report does not mention stay as they were.
   */
  async limits(): Promise<SubscriptionWindow[]> {
    return this.windows;
  }

  private merge(fresh: SubscriptionWindow[]): void {
    const byId = new Map(this.windows.map((w) => [w.id, w]));
    for (const w of fresh) byId.set(w.id, w);
    const order = (id: string) => (id === "5h" ? 0 : id === "7d" ? 1 : 2);
    this.windows = [...byId.values()].sort((a, b) => order(a.id) - order(b.id));
  }
}
