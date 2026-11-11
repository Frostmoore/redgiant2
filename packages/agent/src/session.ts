import { randomUUID } from "node:crypto";
import type { EventStore } from "@redgiant/events";
import {
  ASIDE_NOTE,
  type ChatMessage,
  type EventBody,
  type ImagePart,
  LOCAL_OWNER_ID,
  MAX_NOTES,
  type MessageMetrics,
  type MessageQuote,
  type ModelSpec,
  notedText,
  quotedText,
  type StopReason,
  UNATTENDED_MAX_TURNS,
  type UserPart,
} from "@redgiant/protocol";
import {
  type Completion,
  complete,
  costUsd,
  ENGINE_STALL,
  ProviderError,
  type ProviderRegistry,
  ProviderStalledError,
  STALL_RETRY_DELAYS_MS,
  StallWatch,
  type StreamEvent,
  stallLog,
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
import type { Engine, EngineTurn } from "./engine.js";
import { sessionLog } from "./forks.js";
import type { Hooks, ToolCallInfo } from "./hooks.js";
import { type HistoryEntry, rebuildHistory, summaryMessage } from "./rebuild.js";
import { repairJson } from "./repair.js";
import { TodoWatch } from "./todos.js";
import { canonicalTools, type Tool, type ToolContext, type ToolOutput } from "./tools.js";

export interface PermissionDecision {
  allow: boolean;
  reason?: string;
}

/** Told to an engine whose earlier try was cancelled after it had started working (3.5.4). */
const STALL_GO_ON =
  "[RedGiant: the provider stopped answering and your request was cancelled. Go on from where you were; the tool results you already have are real.]";

export interface AgentSessionOptions {
  /**
   * Messages the person sent while the agent worked (2026-11-05): taken after each round of
   * tools and given to the model with the results, as Claude Code does.
   */
  interject?: () => {
    text: string;
    images?: ImagePart[];
    quotes?: MessageQuote[];
    /** Who sent it, when not the person (an agent's task report, 3.5.7). */
    from?: string;
    /** A task's report (3.5.7): an open list of steps rides with it, as in `send`. */
    taskReport?: boolean;
    /** Sent through an artifact's or a widget's button (3.5.9). */
    via?: "artifact";
  }[];
  /**
   * Tools that only read (2026-11-05, as the Claude Agent SDK does): consecutive calls of these
   * run together; every other call runs alone, in the order the model gave.
   */
  readOnlyTools?: ReadonlySet<string>;
  /**
   * After the person stops the turn, how long a tool still running may take to end (p3.4.0,
   * default 10 s). Past it the call is answered as cancelled and the turn ends: a tool that
   * never comes back (a command whose output something keeps open) must not hold the
   * conversation, and the messages waiting after it, forever.
   */
  stopGraceMs?: number;
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
  /**
   * Tools the person switched off, already left out of `tools` (G34.5): recorded when the
   * session starts, so a resumed one keeps the same set (the cached prefix does not move).
   */
  toolsOff?: readonly string[];
  /** A summary is being made in the foreground (the chat says so) or done. */
  onCompacting?: (busy: boolean) => void;
  /**
   * Maximum model calls per `send`; null: no limit. A function is read at each `send`, with
   * whether the person started it (`send`'s `person`), so the person's setting applies to the
   * next message of a live session. Default (3.5.6): none in a turn the person started,
   * `UNATTENDED_MAX_TURNS` in any other.
   */
  maxTurns?: number | ((origin: { person: boolean }) => number | null);
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
  /** Pauses before trying a silent engine again (3.5.4); tests make them short. */
  stallDelaysMs?: readonly number[];
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
      for (const e of await sessionLog(store, sessionId)) {
        if (i.from_seq !== undefined && e.seq < i.from_seq) continue;
        if (i.to_seq !== undefined && e.seq > i.to_seq) continue;
        if (!e.payload) continue;
        const text =
          e.type === "message.user"
            ? `user: ${quotedText(e.payload.text, e.payload.quotes, e.payload.notes)}`
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
/** A side question as recorded, with where and when (G36.24). */
export type AsideResult = Extract<EventBody, { type: "aside" }>["payload"] & {
  seq: number;
  at: string;
};

const answerOf = (c: Completion) =>
  c.message.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();

/**
 * The messages of a side question (G36.24): the conversation as it is now, unchanged, and the
 * question at its end. A turn in the middle of its tools has calls without results yet: they get
 * a placeholder, or the request would not be valid; the person's last message, if unanswered,
 * takes the question as one more part.
 */
export function asideMessages(history: readonly ChatMessage[], question: string): ChatMessage[] {
  const ask: UserPart = { type: "text", text: `${ASIDE_NOTE}\n\n${question}` };
  const last = history.at(-1);
  if (!last) return [{ role: "user", parts: [ask] }];
  if (last.role === "user")
    return [...history.slice(0, -1), { ...last, parts: [...(last.parts as UserPart[]), ask] }];
  const open = last.parts.flatMap((p) => (p.type === "tool_call" ? [p.callId] : []));
  return [
    ...history,
    {
      role: "user",
      parts: [
        ...open.map(
          (callId): UserPart => ({
            type: "tool_result",
            callId,
            content: "[Still running: the result is not in yet.]",
          }),
        ),
        ask,
      ],
    },
  ];
}

/** After this many identical calls with identical results in a row, the result says so. */
const REPEAT_NOTE_AFTER = 3;

export class AgentSession {
  private history: HistoryEntry[] = [];
  /** Metrics of the latest model call since the last compaction; drives auto-compaction. */
  private lastMetrics: MessageMetrics | undefined;
  private tools: Tool[];
  private readonly ctx: ToolContext;
  /** The engine's conversation id (G21), from the log. */
  private engineSession: string | undefined;
  /** A summary being made ahead of time, after a turn (G24.14). */
  private background: Promise<void> | undefined;
  /** The previous call's prompt, for noticing a cache that was lost (G24.14c). */
  private prevPrompt = 0;
  /** This provider has read from its cache in this session: a miss means something. */
  private sawCache = false;
  /** The agent's list of steps and the calls since it changed (3.5.6), rebuilt from the log. */
  private todos = new TodoWatch();

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
        ...(options.toolsOff?.length && { toolsOff: [...options.toolsOff] }),
      },
    });
    for (const h of options.hooks?.sessionStart ?? []) await h(s.ctx);
    return s;
  }

  /**
   * A session that records nothing (2026-11-05): what a new conversation of this agent would send,
   * so its start (system and tools) can be computed ahead. Never sent to; never in the log.
   */
  static preview(options: AgentSessionOptions): AgentSession {
    return new AgentSession(options);
  }

  /** Reopens an existing session from the event log. */
  static async resume(options: AgentSessionOptions): Promise<AgentSession> {
    // A conversation that goes on from another one (G36.23) has the origin's start and history.
    const events = await sessionLog(options.store, options.sessionId);
    // The system prompt the conversation started with, never the one rebuilt now (2026-11-05:
    // notes or skills changed meanwhile altered the cached prefix when a session was reloaded).
    const started = events.find((e) => e.type === "session.started" && e.payload);
    const system =
      started?.type === "session.started" && started.payload ? started.payload.system : undefined;
    const s = new AgentSession(system !== undefined ? { ...options, system } : options);
    s.history = rebuildHistory(events, { maxResultChars: s.maxResultChars });
    s.todos = TodoWatch.fromEvents(events);
    for (const e of events) {
      if (e.type === "compaction" || e.type === "compaction.undone") s.lastMetrics = undefined;
      if (e.type === "message.assistant" && e.payload) s.lastMetrics = e.payload.metrics;
      // An engine's own conversation belongs to the session that had it, not to its forks.
      if (e.type === "engine.session" && e.payload && e.sessionId === options.sessionId)
        s.engineSession = e.payload.id;
    }
    return s;
  }

  private get maxResultChars(): number {
    return this.o.maxResultChars ?? 100_000;
  }

  /**
   * Tools switched back on while the conversation runs (G36.15, the agent asked and the person said
   * yes): recorded first, then part of every later request. The prefix changes once, here.
   */
  async addTools(
    tools: Tool[],
    payload: { entry: string; why: string; scope: "session" | "agent" },
  ): Promise<void> {
    const fresh = tools.filter((t) => !this.tools.some((x) => x.def.name === t.def.name));
    if (fresh.length === 0) return;
    await this.record({
      type: "session.tools_added",
      payload: { tools: fresh.map((t) => t.def.name).sort(), ...payload },
    });
    this.tools = canonicalTools([...this.tools, ...fresh]);
  }

  /** The tools as the model receives them, in order (the tools page weighs them, G34.5). */
  get toolDefs(): Tool["def"][] {
    return this.tools.map((t) => t.def);
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

  /** A model the catalog does not know (3.5.4): its cost is not known, not zero. */
  private unpriced(c: Completion): boolean {
    const info = this.o.providers.get(c.provider).modelInfo(c.model);
    return info.unconfirmed === true && !info.pricing;
  }

  /** The step limit of one `send`, read when it starts (Infinity: none). */
  private turnLimit(person: boolean): number {
    const m = this.o.maxTurns;
    const v = typeof m === "function" ? m({ person }) : m;
    if (v === null) return Number.POSITIVE_INFINITY;
    return v ?? (person ? Number.POSITIVE_INFINITY : UNATTENDED_MAX_TURNS);
  }

  /** Sends a user message and runs the model/tool loop until the model stops. */
  async send(
    text: string,
    signal?: AbortSignal,
    extra: {
      images?: ImagePart[];
      from?: string;
      quotes?: MessageQuote[];
      /** RedGiant's lines after the text (G37.1): files changed while the agent was away. */
      notes?: string[];
      /** The report of a task this agent handed over (3.5.6): an open list of steps is shown again. */
      taskReport?: boolean;
      /** The person started this turn (3.5.6): it has no step limit unless they set one. */
      person?: boolean;
      /** Sent through an artifact's or a widget's button (3.5.9). */
      via?: "artifact";
    } = {},
  ): Promise<SendResult> {
    const ctx = { ...this.ctx, signal };
    const images = extra.images ?? [];
    const quotes = extra.quotes ?? [];
    const notes = [...(extra.notes ?? [])];
    if (extra.taskReport && this.todos.open && notes.length < MAX_NOTES) {
      notes.push(this.todos.text("report"));
      this.todos.reminded();
    }
    // What the model reads: the quoted passages first, each with its reply (G36.22).
    const said = quotedText(text, quotes, notes);
    // A summary made after the last turn is applied first: the message lands after it.
    await this.background;
    const first = await this.record({
      type: "message.user",
      payload: {
        text,
        ...(images.length > 0 && { images }),
        ...(extra.from && { from: extra.from }),
        ...(quotes.length > 0 && { quotes }),
        ...(notes.length > 0 && { notes }),
        ...(extra.via && { via: extra.via }),
      },
    });
    this.history.push({
      message: { role: "user", parts: [{ type: "text", text: said }, ...images] },
      firstSeq: first.seq,
    });

    const limit = this.turnLimit(extra.person === true);
    if (this.o.engine) return this.sendToEngine(this.o.engine, said, images, ctx, limit);

    let last: Completion | undefined;
    // Calls cut by the output limit, answered with an error and retried (at most twice).
    let cutCalls = 0;
    for (let turn = 1; turn <= limit; turn++) {
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
          ...(this.unpriced(completion) && { costUnknown: true }),
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
        default: {
          // Cut by the output limit in the middle of a tool call (a long write_file): the call
          // gets an error result, so the conversation stays valid, and the model tries again in
          // smaller steps. Twice at most in a row.
          const cut = completion.message.parts.some((p) => p.type === "tool_call");
          if (completion.stopReason === "max_tokens" && cut && cutCalls < 2) {
            cutCalls++;
            await this.failCalls(
              completion,
              "Your output reached its length limit before this call was complete, so it did not run. Make a smaller step: for example write the file in parts, or edit it instead of rewriting it.",
            );
            continue;
          }
          return { stopReason: completion.stopReason, turns: turn, lastCompletion: completion };
        }
      }
    }
    // Out of steps in the middle of the work: one more call, same request, to say where it is.
    if (last?.stopReason === "tool_use" && !signal?.aborted) {
      const gate = await this.o.beforeModelCall?.();
      if (!gate || gate.allow) last = (await this.closingSummary(signal)) ?? last;
    }
    return {
      stopReason: "max_turns",
      turns: limit,
      ...(last && { lastCompletion: last }),
    };
  }

  /**
   * The step limit is reached: the model writes what is done and what is left, so the person
   * can say "go on". Same tools and system (the cache holds); a call it still makes is answered
   * with an error, not run.
   */
  private async closingSummary(signal: AbortSignal | undefined): Promise<Completion | undefined> {
    const text =
      "[RedGiant: you reached the limit of steps for one message. Do not call any more tools. In a few lines, tell the person what you did, what is left, and what you would do next: they can tell you to go on.]";
    // It joins the last results' message, as the person's own words in the middle of work do.
    const results = this.history.at(-1)?.message;
    if (results?.role !== "user") return undefined;
    await this.record({ type: "message.user", payload: { text, steer: true, from: "redgiant" } });
    results.parts.push({ type: "text", text });
    try {
      const completion = await this.callModel(signal);
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
          costUsd: await this.priced(completion),
          ...(this.unpriced(completion) && { costUnknown: true }),
          // The page offers «Continue» under it (3.5.6); the model never sees this mark.
          stepLimit: true,
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
      if (completion.message.parts.some((p) => p.type === "tool_call"))
        await this.failCalls(
          completion,
          "Not run: the limit of steps for this message is reached.",
        );
      return completion;
    } catch {
      return undefined;
    }
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
    limit: number,
  ): Promise<SendResult> {
    let message = text;
    let pictures = images;
    for (let turn = 1; turn <= limit; turn++) {
      const gate = await this.o.beforeModelCall?.();
      if (gate && !gate.allow)
        return {
          stopReason: "budget",
          turns: turn - 1,
          ...(gate.reason && { reason: gate.reason }),
        };
      const r = await this.engineTurnWatched(engine, message, pictures, ctx, (watch, said) => ({
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
          watch.touch();
          said();
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
          // A tool's time is not the provider's: the watch waits while it runs.
          watch.pause();
          said();
          try {
            await this.record({
              type: "tool.call",
              payload: { callId: call.callId, tool: call.name, input: call.input },
            });
            const r = await this.runOne(
              { callId: call.callId, name: call.name, input: call.input },
              JSON.stringify(call.input ?? null),
              ctx,
            );
            const reminder = this.todoReminder(call.name, call.input, r);
            const e = await this.record({
              type: "tool.result",
              payload: {
                callId: call.callId,
                ok: !r.isError,
                output: r.content,
                ...(reminder && { reminder }),
              },
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
          } finally {
            watch.resume();
          }
        },
      }));
      if (r.resume && r.resume !== this.engineSession) {
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
    return { stopReason: "max_turns", turns: limit };
  }

  /**
   * One engine turn under a stall watch (3.5.4). When the engine sends nothing for too long (its
   * tools' time excluded) the turn is cancelled for real (the engine's process with it) and made
   * again, at most twice, with a growing pause: the same message when nothing came of it yet,
   * otherwise a note to go on. Then the agent's fallback model on the same engine, if it has one,
   * else a `ProviderStalledError`. The conversation's model is never changed. One log line per
   * stalled try.
   */
  private async engineTurnWatched(
    engine: Engine,
    text: string,
    images: ImagePart[],
    ctx: ToolContext,
    hooks: (
      watch: StallWatch,
      said: () => void,
    ) => Pick<EngineTurn, "onMessage" | "runTool" | "onCompaction">,
  ): Promise<{ resume: string; stopReason: StopReason }> {
    const limits = engine.stall ?? ENGINE_STALL;
    const delays = this.o.stallDelaysMs ?? STALL_RETRY_DELAYS_MS;
    let spec: ModelSpec | undefined = this.o.model;
    let tries = 0;
    let began: number | undefined;
    let message = text;
    let pictures = images;
    for (;;) {
      const model: ModelSpec = spec ?? this.o.model;
      const inner = new AbortController();
      const cancel = () => inner.abort();
      ctx.signal?.addEventListener("abort", cancel, { once: true });
      if (ctx.signal?.aborted) inner.abort();
      let stalled: "first" | "idle" | undefined;
      let stalledNow: () => void = () => {};
      const stalledP = new Promise<void>((ok) => {
        stalledNow = ok;
      });
      const watch = new StallWatch(limits, (kind) => {
        stalled = kind;
        inner.abort();
        stalledNow();
      });
      let anything = false;
      const started = Date.now();
      began ??= started;
      const turn = engine
        .turn({
          text: message,
          images: pictures,
          system: this.o.system,
          tools: this.tools.map((t) => t.def),
          model,
          resume: this.engineSession,
          signal: inner.signal,
          alive: () => watch.touch(),
          live: (e) => {
            watch.touch();
            this.o.live?.(e);
          },
          ...hooks(watch, () => {
            anything = true;
          }),
        })
        .then(
          (r) => ({ r }),
          (err: unknown) => ({ err }),
        );
      // Cancelled for a stall: the engine gets a little time to stop, then the turn moves on.
      const out = await Promise.race([
        turn,
        stalledP.then(() =>
          Promise.race([
            turn,
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
          ]),
        ),
      ]);
      watch.stop();
      ctx.signal?.removeEventListener("abort", cancel);
      if (!stalled) {
        if (!out || "err" in out) throw out?.err;
        return out.r;
      }
      // What the engine said before it went silent: the next try goes on from there.
      if (out && "r" in out && out.r.resume) this.engineSession = out.r.resume;
      if (ctx.signal?.aborted) return { resume: this.engineSession ?? "", stopReason: "aborted" };
      const waited = Math.round((Date.now() - started) / 1000);
      const what = stalled === "first" ? "no first token" : "the answer stopped";
      const where = `${engine.id}/${model.model}`;
      const pause = delays[tries];
      if (pause !== undefined) {
        tries++;
        stallLog(
          `provider ${where}: ${what} after ${waited}s, cancelled; trying again in ${Math.round(pause / 1000)}s (${tries}/${delays.length})`,
        );
        await new Promise<void>((ok) => {
          const t = setTimeout(ok, pause);
          ctx.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              ok();
            },
            { once: true },
          );
        });
        if (ctx.signal?.aborted) return { resume: this.engineSession ?? "", stopReason: "aborted" };
      } else if (spec?.fallback && spec.fallback.provider === engine.id) {
        stallLog(
          `provider ${where}: ${what} after ${waited}s, cancelled; ${tries} new tries done, moving to ${spec.fallback.model}`,
        );
        spec = { ...spec.fallback, effort: spec.fallback.effort ?? spec.effort };
        tries = 0;
      } else {
        stallLog(
          `provider ${where}: ${what} after ${waited}s, cancelled; ${tries} new tries done, the turn stops`,
        );
        const minutes = Math.max(1, Math.round((Date.now() - began) / 60_000));
        throw new ProviderStalledError(engine.id, model.model, minutes, tries);
      }
      if (anything) {
        message = STALL_GO_ON;
        pictures = [];
      }
    }
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

  /** Every call of a message answered with the same error, without running anything. */
  private async failCalls(completion: Completion, why: string): Promise<void> {
    const calls = completion.message.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
    let firstSeq: number | undefined;
    for (const c of calls) {
      await this.record({
        type: "tool.call",
        payload: { callId: c.callId, tool: c.name, input: c.input },
      });
    }
    for (const c of calls) {
      // Counted like every result, so a resumed session counts the same (no reminder here).
      this.todos.result(c.name, c.input, false);
      const e = await this.record({
        type: "tool.result",
        payload: { callId: c.callId, ok: false, output: why },
      });
      firstSeq ??= e.seq;
    }
    this.history.push({
      message: {
        role: "user",
        parts: calls.map((c) => ({
          type: "tool_result" as const,
          callId: c.callId,
          content: why,
          isError: true,
        })),
      },
      firstSeq: firstSeq ?? 0,
    });
  }

  /** The last tool call and its result, and how many times in a row they came back the same. */
  private repeats = { key: "", count: 0 };

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
    // Reads run together; writes, commands and everything else one at a time (two edits of one
    // file, or two commands, must not race). After a stop, what has not started is not run.
    const results: Awaited<ReturnType<AgentSession["runOne"]>>[] = [];
    const readOnly = (name: string) => this.o.readOnlyTools?.has(name) === true;
    for (let i = 0; i < calls.length; ) {
      let j = i + 1;
      if (readOnly(calls[i]?.name ?? ""))
        while (j < calls.length && readOnly(calls[j]?.name ?? "")) j++;
      const batch = calls.slice(i, j);
      results.push(
        ...(await Promise.all(
          batch.map((c) =>
            ctx.signal?.aborted
              ? Promise.resolve({
                  content: "Cancelled: the person stopped the turn.",
                  isError: true,
                })
              : this.runOne({ callId: c.callId, name: c.name, input: c.input }, c.rawInput, ctx),
          ),
        )),
      );
      i = j;
    }
    let firstSeq: number | undefined;
    for (const [i, r] of results.entries()) {
      const callId = calls[i]?.callId ?? "";
      // The same call with the same answer again and again: the model is stuck, say so.
      const key = `${calls[i]?.name}\u0000${JSON.stringify(calls[i]?.input ?? null)}\u0000${r.content}`;
      this.repeats =
        key === this.repeats.key ? { key, count: this.repeats.count + 1 } : { key, count: 1 };
      if (this.repeats.count >= REPEAT_NOTE_AFTER)
        r.content = `${r.content}\n\n[RedGiant: this is the ${this.repeats.count}th time in a row you make exactly this call and get exactly this result. Repeating it will not change anything: try a different approach, or stop and tell the person what blocks you.]`;
      const reminder = this.todoReminder(calls[i]?.name, calls[i]?.input, r);
      const images = "images" in r ? r.images : undefined;
      const e = await this.record({
        type: "tool.result",
        payload: {
          callId,
          ok: !r.isError,
          output: r.content,
          ...(images && { images }),
          ...(reminder && { reminder }),
        },
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

  /**
   * Counts a result for the list of steps (3.5.6) and, when a reminder is due, appends it to the
   * result (the output that is logged, so the history rebuilds the same) and says so.
   */
  private todoReminder(
    tool: string | undefined,
    input: unknown,
    r: { content: string; isError: boolean },
  ): "todos" | undefined {
    this.todos.result(tool, input, !r.isError);
    if (!this.todos.due) return undefined;
    r.content = notedText(r.content, [this.todos.text("calls")]);
    this.todos.reminded();
    return "todos";
  }

  /** What the person wrote meanwhile, recorded and returned as parts of the results' message. */
  private async interjections(): Promise<UserPart[]> {
    const parts: UserPart[] = [];
    for (const m of this.o.interject?.() ?? []) {
      const notes: string[] = [];
      if (m.taskReport && this.todos.open) {
        notes.push(this.todos.text("report"));
        this.todos.reminded();
      }
      await this.record({
        type: "message.user",
        payload: {
          text: m.text,
          ...(m.images?.length && { images: m.images }),
          ...(m.from && { from: m.from }),
          ...(m.quotes?.length && { quotes: m.quotes }),
          ...(notes.length > 0 && { notes }),
          ...(m.via && { via: m.via }),
          steer: true,
        },
      });
      parts.push({ type: "text", text: quotedText(m.text, m.quotes, notes) }, ...(m.images ?? []));
    }
    return parts;
  }

  /** A tool's run, cut short `stopGraceMs` after the turn is stopped (p3.4.0). */
  private untilStopped(
    run: Promise<ToolOutput>,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutput> {
    if (!signal) return run;
    const cancelled: ToolOutput = {
      content:
        "Cancelled: the person stopped the turn, and this call had not finished; what it did so far is not known.",
      isError: true,
    };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        timer = setTimeout(() => resolve(cancelled), this.o.stopGraceMs ?? 10_000);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      run.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  private async runOne(call: ToolCallInfo, rawInput: string, base: ToolContext) {
    const ctx: ToolContext = { ...base, callId: call.callId };
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
      let parsed = tool.schema.safeParse(input);
      // Some engines hand over an object, array, number or boolean argument as its JSON text
      // (p3.3.1: blender's render). Read such strings once and try again.
      const decoded = parsed.success ? undefined : decodeJsonStrings(input);
      if (decoded !== undefined) {
        const again = tool.schema.safeParse(decoded);
        if (again.success) parsed = again;
      }
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
      const out = await this.untilStopped(tool.run(input, ctx), ctx.signal);
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
  /**
   * A local engine computes this conversation as it stands, in its slot, before the person
   * writes (after a summary; at start, 2026-11-05: the first message read the whole context
   * again). Exactly what the next request will send, minus the new message. Nothing elsewhere.
   */
  /**
   * The start every new conversation of this agent shares (system and tools: 5,500 tokens and
   * 205 s for GLM-4.5 Air on Rig), computed ahead and kept by a local engine: the first message
   * of a new conversation then reads only itself. Nothing when it is already kept.
   */
  async prefillStart(signal?: AbortSignal): Promise<void> {
    if (this.o.engine) return;
    const p = this.o.providers.get(this.o.model.provider) as {
      prefill?: (
        r: ReturnType<AgentSession["request"]>,
        signal?: AbortSignal,
        o?: { onlyStart?: boolean },
      ) => Promise<void>;
    };
    await p.prefill?.(
      {
        ...this.request(),
        // One character after the start: the cache keeps everything before it.
        messages: [{ role: "user", parts: [{ type: "text", text: "." }] }],
        model: this.o.model.model,
        ...(this.o.model.effort && { effort: this.o.model.effort }),
      } as never,
      signal,
      { onlyStart: true },
    );
  }

  async prefill(signal?: AbortSignal): Promise<void> {
    if (this.o.engine) return;
    const p = this.o.providers.get(this.o.model.provider) as {
      prefill?: (r: ReturnType<AgentSession["request"]>, signal?: AbortSignal) => Promise<void>;
    };
    await p.prefill?.(
      {
        ...this.request(),
        model: this.o.model.model,
        ...(this.o.model.effort && { effort: this.o.model.effort }),
      } as never,
      signal,
    );
  }

  private compactAhead(): void {
    const m = this.lastMetrics;
    if (!m || this.o.engine || m.contextUsed < (this.o.compactAt ?? 0.8) * m.contextWindow) return;
    this.background = this.compactNow({ reason: "auto" })
      .then(async (done) => {
        if (!done) return;
        // A local engine computes the new history now, not when the person writes (G24.14).
        await this.prefill().catch(() => {});
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
    const events = await sessionLog(this.o.store, this.ctx.sessionId);
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
    this.history = rebuildHistory(await sessionLog(this.o.store, this.ctx.sessionId), {
      maxResultChars: this.maxResultChars,
    });
    this.lastMetrics = undefined;
    this.prevPrompt = 0;
    return true;
  }

  /**
   * A side question «Intanto» (G36.24, Claude Code's /btw): a request of its own with this
   * conversation's system, tools and history (so the cached prefix is reused) plus the question,
   * also while a turn runs. Recorded as an `aside` event, never in the history: the conversation
   * and its memory go on as if it was never asked. Tools are not run; the tool choice changes only
   * if the model calls one anyway (as the summaries do), because changing it costs the cache.
   */
  async aside(question: string, signal?: AbortSignal): Promise<AsideResult> {
    const id = `aside_${randomUUID().slice(0, 12)}`;
    const done = async (payload: Extract<EventBody, { type: "aside" }>["payload"]) => {
      const e = await this.record({ type: "aside", payload });
      return { ...payload, seq: e.seq, at: e.ts };
    };
    const failed = (error: string) =>
      done({
        id,
        question,
        answer: "",
        provider: this.o.model.provider,
        model: this.o.model.model,
        costUsd: 0,
        error,
      });
    if (this.o.engine)
      return failed("A subscription's engine keeps its own conversation: ask in the chat.");
    const base = {
      ...this.request(),
      messages: asideMessages(this.messages, question),
      // Its own key: a turn running now keeps its local engine slot.
      cacheKey: `${this.ctx.sessionId}:aside`,
    };
    let usd = 0;
    let last: Completion | undefined;
    try {
      for (const req of [base, { ...base, toolChoice: "none" as const }]) {
        const gate = await this.o.beforeModelCall?.();
        if (gate && !gate.allow) return failed(gate.reason ?? "budget");
        let c: Completion | undefined;
        for await (const e of streamWithFallback(this.o.providers, this.o.model, req, signal))
          if (e.type === "done") c = e.completion;
        if (!c) throw new Error("Model stream ended without a completion");
        usd += await this.priced(c);
        last = c;
        if (answerOf(c) || !c.message.parts.some((p) => p.type === "tool_call")) break;
      }
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
    const c = last as Completion;
    return done({
      id,
      question,
      answer: answerOf(c),
      provider: c.provider,
      model: c.model,
      metrics: c.metrics,
      costUsd: usd,
    });
  }

  /**
   * «Porta nella chat» (G36.24): the side question and its answer become a normal exchange at the
   * end of the conversation, appended as any message is (no new model call). Only between turns.
   */
  async adoptAside(
    a: Pick<AsideResult, "id" | "question" | "answer" | "provider" | "model" | "metrics">,
  ): Promise<void> {
    await this.background;
    const user = await this.record({ type: "message.user", payload: { text: a.question } });
    this.history.push({
      message: { role: "user", parts: [{ type: "text", text: a.question }] },
      firstSeq: user.seq,
    });
    const parts = [{ type: "text" as const, text: a.answer }];
    const reply = await this.record({
      type: "message.assistant",
      payload: {
        parts,
        stopReason: "end_turn",
        provider: a.provider,
        model: a.model,
        metrics: a.metrics ?? {
          startedAt: new Date().toISOString(),
          inputTokens: 0,
          cachedReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          contextUsed: 0,
          contextWindow: 1,
          source: "server",
        },
        // Already counted when it was asked.
        costUsd: 0,
      },
    });
    this.history.push({ message: { role: "assistant", parts }, firstSeq: reply.seq });
    await this.record({ type: "aside.promoted", payload: { asideId: a.id } });
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

/**
 * The input with its top-level string values that are JSON objects, arrays, numbers or
 * booleans read as such; undefined when there is none.
 */
export function decodeJsonStrings(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = v;
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!/^([{[]|-?\d|true$|false$)/.test(t)) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed !== "string") {
        out[k] = parsed;
        changed = true;
      }
    } catch {
      // Not JSON: left as it is.
    }
  }
  return changed ? out : undefined;
}
