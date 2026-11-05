import type { EventStore } from "@redgiant/events";
import {
  type ChatMessage,
  type EventBody,
  type ImagePart,
  LOCAL_OWNER_ID,
  type MessageMetrics,
  type ModelSpec,
  type StopReason,
  type UserPart,
} from "@redgiant/protocol";
import {
  type Completion,
  complete,
  costUsd,
  ProviderError,
  type ProviderRegistry,
  type StreamEvent,
  streamWithFallback,
} from "@redgiant/providers";
import { z } from "zod";
import {
  COMPACTION_PROMPT,
  keepFrom,
  summaryText,
  trimResult,
  withoutReasoning,
} from "./compaction.js";
import type { Engine } from "./engine.js";
import type { Hooks, ToolCallInfo } from "./hooks.js";
import { type HistoryEntry, rebuildHistory, summaryMessage } from "./rebuild.js";
import { repairJson } from "./repair.js";
import { canonicalTools, type Tool, type ToolContext } from "./tools.js";

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
}

export interface AgentSessionOptions {
  /**
   * Messages the person sent while the agent worked (2026-11-05): taken after each round of
   * tools and given to the model with the results, as Claude Code does.
   */
  interject?: () => { text: string; images?: ImagePart[] }[];
  store: EventStore;
  providers: ProviderRegistry;
  model: ModelSpec;
  /** Stable system prompt: part of the cached prefix, never changes within a session. */
  system: string;
  tools: Tool[];
  sessionId: string;
  ownerId?: string;
  projectId?: string | null;
  agentId?: string | null;
  hooks?: Hooks;
  /** Asked before every tool run, after hooks. Default: allow (the hierarchy plugs in here). */
  permission?: (call: ToolCallInfo, ctx: ToolContext) => Promise<PermissionDecision>;
  /**
   * Past this fraction of the window after a turn, the summary is made ahead of time, in the
   * background (default 0.8, as VS Code).
   */
  compactAt?: number;
  /** Past this fraction before a model call, the summary is made at once (default 0.9). */
  emergencyAt?: number;
  /**
   * Share of the window the recent turns kept word for word may take (default 0.25). Local
   * models want less: every kept token is computed again once.
   */
  keepRatio?: number;
  /** Tool results longer than this are cut as they enter the history (default 100,000). */
  maxResultChars?: number;
  /** Reading back one's own conversation (default on; Demi-God only relays, RD8). */
  historyTool?: boolean;
  /** A summary is being made in the foreground (the chat says so) or done. */
  onCompacting?: (busy: boolean) => void;
  /** Maximum model calls per `send` (default 50). */
  maxTurns?: number;
  maxTokens?: number;
  /** Scheduling priority on shared local engines; set from the agent kind. */
  priority?: number;
  /** Scope of saved KV caches on local engines (normally the project). */
  cacheScope?: string;
  /** Live, non-persisted stream (text and thinking deltas) for connected clients. */
  live?: (event: StreamEvent) => void;
  /** Every completion, including summaries; budgets and counters plug in here. */
  onCompletion?: (completion: Completion, costUsd: number) => Promise<void> | void;
  /**
   * Asked before every model call, summaries included; budgets plug in here. A refusal
   * ends `send` with stopReason "budget".
   */
  beforeModelCall?: () => Promise<{ allow: boolean; reason?: string }>;
  /** A flat subscription's own agent runs the turns (G21); the tools stay these. */
  engine?: Engine;
}

export interface SendResult {
  stopReason: StopReason | "max_turns" | "budget";
  /** Why the loop stopped early (budget), when it did. */
  reason?: string;
  turns: number;
  lastCompletion?: Completion;
}

/** A provider saying the request does not fit in the model's window. */
const contextFull = (err: unknown) =>
  err instanceof ProviderError &&
  /context|too (long|many tokens)|maximum.*tokens|prompt is too long|exceeds/i.test(err.message);

/** Reads back the summarised part of one's own conversation (G24.14): nothing is ever lost. */
function historyTool(store: EventStore, sessionId: string): Tool {
  return {
    def: {
      name: "conversation_history",
      description:
        "Read earlier parts of this conversation exactly as they were, also those replaced by a summary: by event numbers (from_seq, to_seq) or by searching words (query).",
      inputSchema: {
        type: "object",
        properties: {
          from_seq: { type: "integer" },
          to_seq: { type: "integer" },
          query: { type: "string" },
        },
      },
    },
    schema: z.object({
      from_seq: z.number().int().optional(),
      to_seq: z.number().int().optional(),
      query: z.string().optional(),
    }),
    async run(i: { from_seq?: number; to_seq?: number; query?: string }) {
      const words = i.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const lines: string[] = [];
      for (const e of await store.list({ sessionId })) {
        if (i.from_seq !== undefined && e.seq < i.from_seq) continue;
        if (i.to_seq !== undefined && e.seq > i.to_seq) continue;
        if (!e.payload) continue;
        const text =
          e.type === "message.user"
            ? `user: ${e.payload.text}`
            : e.type === "message.assistant"
              ? `assistant: ${e.payload.parts
                  .map((p) =>
                    p.type === "text"
                      ? p.text
                      : p.type === "tool_call"
                        ? `[${p.name} ${JSON.stringify(p.input ?? null)}]`
                        : "",
                  )
                  .join(" ")}`
              : e.type === "tool.result"
                ? `result${e.payload.ok ? "" : " (error)"}: ${e.payload.output}`
                : e.type === "compaction"
                  ? `[summary made here, replacing ${e.payload.fromSeq}–${e.payload.toSeq}]`
                  : "";
        if (!text) continue;
        const lower = text.toLowerCase();
        if (words.length && !words.every((w) => lower.includes(w))) continue;
        // A search shows the words found with what is around them, not a whole long output.
        const at = words.length ? lower.indexOf(words[0] as string) : -1;
        const shown =
          at >= 0 && text.length > 600
            ? `${at > 200 ? "…" : ""}${text.slice(Math.max(0, at - 200), at + 300)}…`
            : text;
        lines.push(`#${e.seq} ${shown}`);
      }
      const out = lines.join("\n");
      if (!out) return "Nothing matches.";
      return out.length > 20_000
        ? `${out.slice(0, 20_000)}\n[… more: narrow it with from_seq/to_seq or a query]`
        : out;
    },
  } as Tool;
}

/**
 * One agent conversation. Every step is appended to the event log first; the in-memory
 * history is only a cache of what the log says, and `resume` rebuilds it from the log.
 */
export class AgentSession {
  private history: HistoryEntry[] = [];
  /** Metrics of the latest model call since the last compaction; drives auto-compaction. */
  private lastMetrics: MessageMetrics | undefined;
  private readonly tools: Tool[];
  private readonly ctx: ToolContext;
  /** The engine's conversation id (G21), from the log. */
  private engineSession: string | undefined;
  /** A summary being made ahead of time, after a turn (G24.14). */
  private background: Promise<void> | undefined;
  /** The previous call's prompt, for noticing a cache that was lost (G24.14c). */
  private prevPrompt = 0;
  /** This provider has read from its cache in this session: a miss means something. */
  private sawCache = false;

  constructor(private readonly o: AgentSessionOptions) {
    this.tools = canonicalTools(
      o.historyTool === false ? o.tools : [...o.tools, historyTool(o.store, o.sessionId)],
    );
    this.ctx = {
      ownerId: o.ownerId ?? LOCAL_OWNER_ID,
      projectId: o.projectId ?? null,
      agentId: o.agentId ?? null,
      sessionId: o.sessionId,
    };
  }

  /** Starts a new session: records it and runs the SessionStart hooks. */
  static async start(options: AgentSessionOptions): Promise<AgentSession> {
    const s = new AgentSession(options);
    await s.record({
      type: "session.started",
      payload: {
        sessionId: options.sessionId,
        system: options.system,
        tools: s.tools.map((t) => t.def.name),
      },
    });
    for (const h of options.hooks?.sessionStart ?? []) await h(s.ctx);
    return s;
  }

  /** Reopens an existing session from the event log. */
  static async resume(options: AgentSessionOptions): Promise<AgentSession> {
    const s = new AgentSession(options);
    const events = await options.store.list({ sessionId: options.sessionId });
    s.history = rebuildHistory(events, { maxResultChars: s.maxResultChars });
    for (const e of events) {
      if (e.type === "compaction" || e.type === "compaction.undone") s.lastMetrics = undefined;
      if (e.type === "message.assistant" && e.payload) s.lastMetrics = e.payload.metrics;
      if (e.type === "engine.session" && e.payload) s.engineSession = e.payload.id;
    }
    return s;
  }

  private get maxResultChars(): number {
    return this.o.maxResultChars ?? 100_000;
  }

  get messages(): ChatMessage[] {
    return this.history.map((h) => h.message);
  }

  private async record(body: EventBody) {
    return this.o.store.append({
      ownerId: this.ctx.ownerId,
      projectId: this.ctx.projectId,
      agentId: this.ctx.agentId,
      sessionId: this.ctx.sessionId,
      body,
    });
  }

  private request() {
    return {
      system: this.o.system,
      tools: this.tools.map((t) => t.def),
      messages: this.messages,
      ...(this.o.maxTokens !== undefined && { maxTokens: this.o.maxTokens }),
      cacheKey: this.ctx.sessionId,
      ...(this.o.priority !== undefined && { priority: this.o.priority }),
      ...(this.o.cacheScope !== undefined && { cacheScope: this.o.cacheScope }),
    };
  }

  /**
   * A call that appends to the previous one should find that one's prompt in the cache. When it
   * finds less than half of it (and the provider does cache), something changed the prefix:
   * recorded, so the chat can say so. A summary in between resets the expectation.
   */
  private async watchCache(c: Completion): Promise<void> {
    const u = c.usage;
    if (u.cachedReadTokens > 0) this.sawCache = true;
    if (this.sawCache && this.prevPrompt > 2048 && u.cachedReadTokens < 0.5 * this.prevPrompt)
      await this.record({
        type: "cache.missed",
        payload: { expected: this.prevPrompt, cached: u.cachedReadTokens, provider: c.provider },
      });
    this.prevPrompt = u.inputTokens;
  }

  private async priced(c: Completion): Promise<number> {
    const usd = costUsd(c.usage, this.o.providers.get(c.provider).modelInfo(c.model).pricing);
    // Awaited: the next turn's budget check must see this spend.
    await this.o.onCompletion?.(c, usd);
    return usd;
  }

  /** Sends a user message and runs the model/tool loop until the model stops. */
  async send(
    text: string,
    signal?: AbortSignal,
    extra: { images?: ImagePart[]; from?: string } = {},
  ): Promise<SendResult> {
    const ctx = { ...this.ctx, signal };
    const images = extra.images ?? [];
    // A summary made after the last turn is applied first: the message lands after it.
    await this.background;
    const first = await this.record({
      type: "message.user",
      payload: {
        text,
        ...(images.length > 0 && { images }),
        ...(extra.from && { from: extra.from }),
      },
    });
    this.history.push({
      message: { role: "user", parts: [{ type: "text", text }, ...images] },
      firstSeq: first.seq,
    });

    if (this.o.engine) return this.sendToEngine(this.o.engine, text, images, ctx);

    let last: Completion | undefined;
    for (let turn = 1; turn <= (this.o.maxTurns ?? 50); turn++) {
      const gate = await this.o.beforeModelCall?.();
      if (gate && !gate.allow) {
        return {
          stopReason: "budget",
          turns: turn - 1,
          ...(gate.reason && { reason: gate.reason }),
          ...(last && { lastCompletion: last }),
        };
      }
      const m = this.lastMetrics;
      // The window is nearly full in the middle of the work: summarise everything now.
      if (m && m.contextUsed >= (this.o.emergencyAt ?? 0.9) * m.contextWindow)
        await this.compactNow({ reason: "emergency", signal });
      let completion: Completion;
      try {
        completion = await this.callModel(signal);
      } catch (err) {
        // The provider says it does not fit: summarise and try once more.
        if (!contextFull(err)) throw err;
        await this.compactNow({ reason: "emergency", signal });
        completion = await this.callModel(signal);
      }
      last = completion;
      this.lastMetrics = completion.metrics;
      await this.watchCache(completion);
      const event = await this.record({
        type: "message.assistant",
        payload: {
          parts: completion.message.parts,
          ...(completion.message.native !== undefined && { native: completion.message.native }),
          stopReason: completion.stopReason,
          ...(completion.stopDetails && { stopDetails: completion.stopDetails }),
          provider: completion.provider,
          model: completion.model,
          metrics: completion.metrics,
          costUsd: await this.priced(completion),
        },
      });
      this.history.push({
        message: {
          role: "assistant",
          parts: completion.message.parts,
          native: completion.message.native,
        },
        firstSeq: event.seq,
      });

      switch (completion.stopReason) {
        case "tool_use":
          await this.runTools(completion, ctx);
          continue;
        case "pause":
          continue;
        case "end_turn": {
          const more = await this.stopHooks(completion, ctx);
          if (more === undefined) {
            this.compactAhead();
            return { stopReason: "end_turn", turns: turn, lastCompletion: completion };
          }
          const e = await this.record({ type: "message.user", payload: { text: more } });
          this.history.push({
            message: { role: "user", parts: [{ type: "text", text: more }] },
            firstSeq: e.seq,
          });
          continue;
        }
        default:
          return { stopReason: completion.stopReason, turns: turn, lastCompletion: completion };
      }
    }
    return {
      stopReason: "max_turns",
      turns: this.o.maxTurns ?? 50,
      ...(last && { lastCompletion: last }),
    };
  }

  /**
   * A turn on an external engine (G21): the engine runs the model, RedGiant runs and logs the
   * tools. Stop hooks still apply: their reminder is the next turn's message.
   */
  private async sendToEngine(
    engine: Engine,
    text: string,
    images: ImagePart[],
    ctx: ToolContext,
  ): Promise<SendResult> {
    let message = text;
    let pictures = images;
    for (let turn = 1; turn <= (this.o.maxTurns ?? 50); turn++) {
      const gate = await this.o.beforeModelCall?.();
      if (gate && !gate.allow)
        return {
          stopReason: "budget",
          turns: turn - 1,
          ...(gate.reason && { reason: gate.reason }),
        };
      const r = await engine.turn({
        text: message,
        images: pictures,
        system: this.o.system,
        tools: this.tools.map((t) => t.def),
        model: this.o.model,
        resume: this.engineSession,
        signal: ctx.signal,
        live: this.o.live,
        onCompaction: (info) =>
          void this.record({
            type: "engine.compacted",
            payload: {
              engine: engine.id,
              trigger: info.trigger,
              ...(info.preTokens !== undefined && { preTokens: info.preTokens }),
            },
          }).catch(() => {}),
        onMessage: async (m) => {
          this.lastMetrics = m.metrics;
          const e = await this.record({
            type: "message.assistant",
            payload: {
              parts: m.parts,
              stopReason: m.stopReason,
              provider: this.o.model.provider,
              model: m.model,
              metrics: m.metrics,
              // A flat subscription: nothing is paid per token.
              costUsd: 0,
            },
          });
          this.history.push({ message: { role: "assistant", parts: m.parts }, firstSeq: e.seq });
        },
        runTool: async (call) => {
          await this.record({
            type: "tool.call",
            payload: { callId: call.callId, tool: call.name, input: call.input },
          });
          const r = await this.runOne(
            { callId: call.callId, name: call.name, input: call.input },
            JSON.stringify(call.input ?? null),
            ctx,
          );
          const e = await this.record({
            type: "tool.result",
            payload: { callId: call.callId, ok: !r.isError, output: r.content },
          });
          this.history.push({
            message: {
              role: "user",
              parts: [
                {
                  type: "tool_result",
                  callId: call.callId,
                  content: trimResult(r.content, this.maxResultChars),
                  ...(r.isError && { isError: true }),
                },
              ],
            },
            firstSeq: e.seq,
          });
          return r;
        },
      });
      if (r.resume !== this.engineSession) {
        this.engineSession = r.resume;
        await this.record({ type: "engine.session", payload: { engine: engine.id, id: r.resume } });
      }
      if (r.stopReason !== "end_turn") return { stopReason: r.stopReason, turns: turn };
      const more = await this.engineStopHooks(ctx);
      if (more === undefined) return { stopReason: "end_turn", turns: turn };
      const e = await this.record({ type: "message.user", payload: { text: more } });
      this.history.push({
        message: { role: "user", parts: [{ type: "text", text: more }] },
        firstSeq: e.seq,
      });
      message = more;
      pictures = [];
    }
    return { stopReason: "max_turns", turns: this.o.maxTurns ?? 50 };
  }

  /** Stop hooks for engines: they see the last assistant text as a completion. */
  private async engineStopHooks(ctx: ToolContext): Promise<string | undefined> {
    const last = [...this.history].reverse().find((h) => h.message.role === "assistant");
    const completion = {
      message: { role: "assistant", parts: last?.message.parts ?? [] },
      stopReason: "end_turn",
    } as unknown as Completion;
    return this.stopHooks(completion, ctx);
  }

  private async callModel(signal?: AbortSignal): Promise<Completion> {
    for await (const e of streamWithFallback(
      this.o.providers,
      this.o.model,
      this.request(),
      signal,
    )) {
      if (e.type === "done") return e.completion;
      this.o.live?.(e);
    }
    throw new Error("Model stream ended without a completion");
  }

  private async stopHooks(completion: Completion, ctx: ToolContext): Promise<string | undefined> {
    for (const h of this.o.hooks?.stop ?? []) {
      const more = await h(completion, ctx);
      if (more !== undefined) return more;
    }
    return undefined;
  }

  private async runTools(completion: Completion, ctx: ToolContext): Promise<void> {
    const calls = completion.message.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
    // Calls are recorded in order, run in parallel, and their results recorded in order:
    // the log stays deterministic whatever finishes first.
    for (const c of calls) {
      await this.record({
        type: "tool.call",
        payload: { callId: c.callId, tool: c.name, input: c.input },
      });
    }
    const results = await Promise.all(
      calls.map((c) =>
        this.runOne({ callId: c.callId, name: c.name, input: c.input }, c.rawInput, ctx),
      ),
    );
    let firstSeq: number | undefined;
    for (const [i, r] of results.entries()) {
      const callId = calls[i]?.callId ?? "";
      const images = "images" in r ? r.images : undefined;
      const e = await this.record({
        type: "tool.result",
        payload: { callId, ok: !r.isError, output: r.content, ...(images && { images }) },
      });
      firstSeq ??= e.seq;
    }
    // Pictures follow every result, in the same message (G24.14c).
    const pictures = results.flatMap((r) => ("images" in r && r.images ? r.images : []));
    this.history.push({
      message: {
        role: "user",
        parts: [
          ...results.map((r, i) => ({
            type: "tool_result" as const,
            callId: calls[i]?.callId ?? "",
            content: trimResult(r.content, this.maxResultChars),
            ...(r.isError && { isError: true }),
          })),
          ...pictures,
          ...(await this.interjections()),
        ],
      },
      firstSeq: firstSeq ?? 0,
    });
  }

  /** What the person wrote meanwhile, recorded and returned as parts of the results' message. */
  private async interjections(): Promise<UserPart[]> {
    const parts: UserPart[] = [];
    for (const m of this.o.interject?.() ?? []) {
      await this.record({
        type: "message.user",
        payload: { text: m.text, ...(m.images?.length && { images: m.images }), steer: true },
      });
      parts.push({ type: "text", text: m.text }, ...(m.images ?? []));
    }
    return parts;
  }

  private async runOne(call: ToolCallInfo, rawInput: string, ctx: ToolContext) {
    const fail = (content: string) => ({ content, isError: true });
    const tool = this.tools.find((t) => t.def.name === call.name);
    if (!tool) return fail(`Unknown tool "${call.name}".`);
    let input: unknown = call.input;
    if (input === undefined) {
      // Small models often write almost-JSON; repair it when that needs no guessing.
      input = repairJson(rawInput);
      if (input === undefined) {
        return fail(`The arguments are not valid JSON. Received: ${rawInput.slice(0, 2000)}`);
      }
    }
    for (const h of this.o.hooks?.preToolUse ?? []) {
      const r = await h({ ...call, input }, ctx);
      if (r.action === "block") {
        await this.record({
          type: "hook.blocked",
          payload: { hook: "preToolUse", callId: call.callId, reason: r.reason },
        });
        return fail(`Blocked: ${r.reason}`);
      }
      if (r.action === "modify") input = r.input;
    }
    if (tool.schema) {
      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        return fail(
          `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
        );
      }
      input = parsed.data;
    }
    if (this.o.permission) {
      const d = await this.o.permission({ ...call, input }, ctx);
      if (!d.allow) return fail(`Permission denied${d.reason ? `: ${d.reason}` : ""}.`);
    }

    let result: { content: string; isError: boolean };
    let images: ImagePart[] = [];
    try {
      const out = await tool.run(input, ctx);
      result =
        typeof out === "string"
          ? { content: out, isError: false }
          : { content: out.content, isError: out.isError ?? false };
      if (typeof out !== "string" && out.images?.length) images = out.images;
    } catch (err) {
      result = fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const h of this.o.hooks?.postToolUse ?? []) {
      result = (await h({ ...call, input }, result, ctx)) ?? result;
    }
    if (images.length > 0) return { ...result, images };
    return result;
  }

  /**
   * After a turn, past `compactAt`: the summary is made now, in the background, and applied as
   * soon as it is ready (the session is idle). The next message waits for it if needed, and on
   * a local engine finds the new history already computed.
   */
  private compactAhead(): void {
    const m = this.lastMetrics;
    if (!m || this.o.engine || m.contextUsed < (this.o.compactAt ?? 0.8) * m.contextWindow) return;
    this.background = this.compactNow({ reason: "auto" })
      .then(async (done) => {
        if (!done) return;
        // A local engine computes the new history now, not when the person writes (G24.14).
        const p = this.o.providers.get(this.o.model.provider) as {
          prefill?: (r: ReturnType<AgentSession["request"]>) => Promise<void>;
        };
        // Exactly what streamWithFallback will send next time, minus the new message.
        await p
          .prefill?.({
            ...this.request(),
            model: this.o.model.model,
            ...(this.o.model.effort && { effort: this.o.model.effort }),
          } as never)
          .catch(() => {});
      })
      .catch((err) => console.warn(`compaction of ${this.ctx.sessionId}: ${String(err)}`))
      .finally(() => {
        this.background = undefined;
      });
  }

  /**
   * Replaces the older part of the history with a summary. The request that makes it is the
   * last turn's request (or a prefix of it) plus one message, so it is all in the cache; the
   * new history costs one computation, once. Kept turns stay word for word, without their
   * reasoning. In an emergency (the window is full in the middle of the work) nothing is kept:
   * the summary covers everything, and the work goes on from it.
   * Returns false when there was nothing to summarise, or a hook postponed it.
   */
  async compactNow(
    o: {
      reason: "auto" | "manual" | "emergency";
      instructions?: string | undefined;
      signal?: AbortSignal | undefined;
    } = {
      reason: "manual",
    },
  ): Promise<boolean> {
    const extra: string[] = o.instructions ? [`The person asks: ${o.instructions}`] : [];
    for (const h of this.o.hooks?.preCompact ?? []) {
      const r = await h(this.messages, this.ctx);
      if (r === false) return false;
      if (r) extra.push(r);
    }
    const window = this.lastMetrics?.contextWindow ?? 0;
    const cut =
      o.reason === "emergency" || window === 0
        ? this.history.length
        : keepFrom(this.history, Math.floor((this.o.keepRatio ?? 0.25) * window));
    const toSummarise = this.history.slice(0, cut);
    const kept = this.history.slice(cut);
    if (toSummarise.length === 0) return false;

    this.o.onCompacting?.(true);
    try {
      const prompt = [COMPACTION_PROMPT, ...extra].join("\n\n");
      // Same system, tools, effort and history as a normal turn, with only the summary prompt
      // appended: the request reuses the whole cached prefix (prompt cache or KV cache).
      // Changing tools or tool_choice would invalidate it, so `none` is only a fallback for a
      // model that calls a tool anyway.
      const summaryRequest = {
        ...this.request(),
        messages: [
          ...toSummarise.map((h) => h.message),
          { role: "user" as const, parts: [{ type: "text" as const, text: prompt }] },
        ],
      };
      const gate = await this.o.beforeModelCall?.();
      if (gate && !gate.allow) return false;
      let c = await complete(
        streamWithFallback(this.o.providers, this.o.model, summaryRequest, o.signal),
      );
      if (c.message.parts.some((p) => p.type === "tool_call")) {
        await this.priced(c);
        c = await complete(
          streamWithFallback(
            this.o.providers,
            this.o.model,
            { ...summaryRequest, toolChoice: "none" },
            o.signal,
          ),
        );
      }
      await this.priced(c);
      const raw = c.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const summary =
        summaryText(raw) +
        (o.reason === "emergency"
          ? "\n\n(The conversation was summarised in the middle of the work: carry on from the work in progress.)"
          : "");
      const fromSeq = toSummarise[0]?.firstSeq ?? 0;
      const toSeq = (kept[0]?.firstSeq ?? Number.MAX_SAFE_INTEGER) - 1;
      const stripped = kept.length > 0;
      const e = await this.record({
        type: "compaction",
        payload: { summary, fromSeq, toSeq, reason: o.reason, ...(stripped && { stripped }) },
      });
      this.history = [
        { message: summaryMessage(summary), firstSeq: e.seq },
        ...kept.map((h) => ({ ...h, message: withoutReasoning(h.message) })),
      ];
      this.lastMetrics = undefined;
      this.prevPrompt = 0;
      return true;
    } finally {
      this.o.onCompacting?.(false);
    }
  }

  /** @deprecated Kept for callers of the first version: a foreground summary, nothing kept. */
  async compact(signal?: AbortSignal): Promise<void> {
    await this.compactNow({ reason: "emergency", ...(signal && { signal }) });
  }

  /**
   * Undoes the last summary the person asked for, if nothing was said since: the whole history
   * comes back from the log (nothing was ever deleted). Returns false when it cannot.
   */
  async undoCompaction(): Promise<boolean> {
    await this.background;
    const events = await this.o.store.list({ sessionId: this.ctx.sessionId });
    const undone = new Set(
      events.flatMap((e) =>
        e.type === "compaction.undone" && e.payload ? [e.payload.compactionSeq] : [],
      ),
    );
    const last = [...events].reverse().find((e) => e.type === "compaction" && !undone.has(e.seq));
    if (!last || last.type !== "compaction" || last.payload?.reason !== "manual") return false;
    if (
      events.some(
        (e) => e.seq > last.seq && (e.type === "message.user" || e.type === "message.assistant"),
      )
    )
      return false;
    await this.record({ type: "compaction.undone", payload: { compactionSeq: last.seq } });
    this.history = rebuildHistory(await this.o.store.list({ sessionId: this.ctx.sessionId }), {
      maxResultChars: this.maxResultChars,
    });
    this.lastMetrics = undefined;
    this.prevPrompt = 0;
    return true;
  }

  /** Resolves when no summary is being made in the background. */
  async settled(): Promise<void> {
    await this.background;
  }

  /** Records the end of the session. */
  async end(reason: string): Promise<void> {
    await this.record({ type: "session.ended", payload: { reason } });
  }
}
