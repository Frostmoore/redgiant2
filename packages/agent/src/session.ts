import type { EventStore } from "@redgiant/events";
import {
  type ChatMessage,
  type EventBody,
  LOCAL_OWNER_ID,
  type MessageMetrics,
  type ModelSpec,
  type StopReason,
} from "@redgiant/protocol";
import {
  type Completion,
  complete,
  costUsd,
  type ProviderRegistry,
  type StreamEvent,
  streamWithFallback,
} from "@redgiant/providers";
import type { Hooks, ToolCallInfo } from "./hooks.js";
import { type HistoryEntry, rebuildHistory, summaryMessage } from "./rebuild.js";
import { repairJson } from "./repair.js";
import { canonicalTools, type Tool, type ToolContext } from "./tools.js";

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
}

export interface AgentSessionOptions {
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
  /** Compact when the context is fuller than this fraction of the window (default 0.8). */
  compactAt?: number;
  /** Maximum model calls per `send` (default 50). */
  maxTurns?: number;
  maxTokens?: number;
  /** Live, non-persisted stream (text and thinking deltas) for connected clients. */
  live?: (event: StreamEvent) => void;
  /** Every completion, including summaries; budgets and counters plug in here. */
  onCompletion?: (completion: Completion, costUsd: number) => void;
}

export interface SendResult {
  stopReason: StopReason | "max_turns";
  turns: number;
  lastCompletion?: Completion;
}

const COMPACTION_PROMPT =
  "Do not call any tool now. Summarise the conversation so far for your own future use: the goal, decisions taken, " +
  "work done (files, commands, results), open problems and the next steps. Be complete but " +
  "concise; this summary replaces the earlier messages.";

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

  constructor(private readonly o: AgentSessionOptions) {
    this.tools = canonicalTools(o.tools);
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
    s.history = rebuildHistory(events);
    for (const e of events) {
      if (e.type === "compaction") s.lastMetrics = undefined;
      if (e.type === "message.assistant" && e.payload) s.lastMetrics = e.payload.metrics;
    }
    return s;
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
    };
  }

  private priced(c: Completion): number {
    const usd = costUsd(c.usage, this.o.providers.get(c.provider).modelInfo(c.model).pricing);
    this.o.onCompletion?.(c, usd);
    return usd;
  }

  /** Sends a user message and runs the model/tool loop until the model stops. */
  async send(text: string, signal?: AbortSignal): Promise<SendResult> {
    const ctx = { ...this.ctx, signal };
    const first = await this.record({ type: "message.user", payload: { text } });
    this.history.push({
      message: { role: "user", parts: [{ type: "text", text }] },
      firstSeq: first.seq,
    });

    let last: Completion | undefined;
    for (let turn = 1; turn <= (this.o.maxTurns ?? 50); turn++) {
      const m = this.lastMetrics;
      if (m && m.contextUsed >= (this.o.compactAt ?? 0.8) * m.contextWindow) {
        await this.compact(signal);
      }
      const completion = await this.callModel(signal);
      last = completion;
      this.lastMetrics = completion.metrics;
      const event = await this.record({
        type: "message.assistant",
        payload: {
          parts: completion.message.parts,
          ...(completion.message.native !== undefined && { native: completion.message.native }),
          stopReason: completion.stopReason,
          provider: completion.provider,
          model: completion.model,
          metrics: completion.metrics,
          costUsd: this.priced(completion),
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
          if (more === undefined)
            return { stopReason: "end_turn", turns: turn, lastCompletion: completion };
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
      const e = await this.record({
        type: "tool.result",
        payload: { callId, ok: !r.isError, output: r.content },
      });
      firstSeq ??= e.seq;
    }
    this.history.push({
      message: {
        role: "user",
        parts: results.map((r, i) => ({
          type: "tool_result" as const,
          callId: calls[i]?.callId ?? "",
          content: r.content,
          ...(r.isError && { isError: true }),
        })),
      },
      firstSeq: firstSeq ?? 0,
    });
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
    try {
      const out = await tool.run(input, ctx);
      result =
        typeof out === "string"
          ? { content: out, isError: false }
          : { content: out.content, isError: out.isError ?? false };
    } catch (err) {
      result = fail(`Tool failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const h of this.o.hooks?.postToolUse ?? []) {
      result = (await h({ ...call, input }, result, ctx)) ?? result;
    }
    return result;
  }

  /**
   * Replaces the history with a summary. The tail that must stay intact (a tool call and
   * its results) is kept after the summary. Recorded as a `compaction` event.
   */
  async compact(signal?: AbortSignal): Promise<void> {
    const extra: string[] = [];
    for (const h of this.o.hooks?.preCompact ?? []) {
      const r = await h(this.messages, this.ctx);
      if (r === false) return;
      if (r) extra.push(r);
    }
    const lastEntry = this.history.at(-1);
    const keepFrom =
      lastEntry?.message.role === "user" &&
      lastEntry.message.parts.some((p) => p.type === "tool_result")
        ? this.history.length - 2
        : this.history.length - 1;
    const toSummarise = this.history.slice(0, Math.max(0, keepFrom));
    const kept = this.history.slice(Math.max(0, keepFrom));
    if (toSummarise.length === 0) return;

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
    let c = await complete(
      streamWithFallback(this.o.providers, this.o.model, summaryRequest, signal),
    );
    if (c.message.parts.some((p) => p.type === "tool_call")) {
      this.priced(c);
      c = await complete(
        streamWithFallback(
          this.o.providers,
          this.o.model,
          { ...summaryRequest, toolChoice: "none" },
          signal,
        ),
      );
    }
    this.priced(c);
    const summary = c.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    const fromSeq = toSummarise[0]?.firstSeq ?? 0;
    const toSeq = (kept[0]?.firstSeq ?? Number.MAX_SAFE_INTEGER) - 1;
    const e = await this.record({ type: "compaction", payload: { summary, fromSeq, toSeq } });
    this.history = [{ message: summaryMessage(summary), firstSeq: e.seq }, ...kept];
    this.lastMetrics = undefined;
  }

  /** Records the end of the session. */
  async end(reason: string): Promise<void> {
    await this.record({ type: "session.ended", payload: { reason } });
  }
}
