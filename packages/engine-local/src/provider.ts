import { randomUUID } from "node:crypto";
import {
  type CompletionRequest,
  type ModelInfo,
  type OpenAICompatOptions,
  OpenAICompatProvider,
  type Provider,
  type StreamEvent,
} from "@redgiant/providers";
import { type KvStore, kvFileName, prefixHashes } from "./kvstore.js";
import { type EngineProps, LlamaCppEngine } from "./llamacpp.js";
import { SlotScheduler } from "./scheduler.js";

export interface LocalEngineOptions extends Omit<OpenAICompatOptions, "extraBody"> {
  /** The engine's `--slot-save-path`, as seen by this process; omit to disable disk caching. */
  kv?: KvStore;
  /** Per-scope (project) budget for saved caches, in bytes. */
  kvBudgetBytes?: number;
  /** Prompts shorter than this are not worth saving (default 256 tokens). */
  kvMinTokens?: number;
}

interface SessionState {
  scope: string;
  /** Hashes of the conversation as it will be resent next turn (request + reply). */
  hashes: string[];
  tokens: number;
}

/**
 * A llama.cpp engine shared by many sessions. Each request runs in a slot (scheduled by
 * priority); a session that comes back to a slot that lost its cache — another session took
 * it, or the engine restarted — gets it back from the SSD before the request, so only the
 * new tokens are processed. Caches are saved after every turn and whenever a slot changes
 * hands.
 */
export class LocalEngineProvider implements Provider {
  readonly id: string;
  private readonly inner: OpenAICompatProvider;
  private readonly engine: LlamaCppEngine;
  private scheduler: SlotScheduler | undefined;
  private props: EngineProps | undefined;
  private readonly sessions = new Map<string, SessionState>();
  /** Slot assigned to the request in flight, keyed by the request object. */
  private readonly slotFor = new WeakMap<CompletionRequest, number>();

  constructor(private readonly o: LocalEngineOptions) {
    this.id = o.id ?? "local";
    this.engine = new LlamaCppEngine(o.baseURL, o.fetch);
    this.inner = new OpenAICompatProvider({
      ...o,
      id: this.id,
      extraBody: (req) => ({ id_slot: this.slotFor.get(req) ?? -1, cache_prompt: true }),
    });
  }

  /** Reads slots and context size from the engine; called lazily before the first request. */
  async connect(): Promise<EngineProps> {
    if (!this.props) {
      this.props = await this.engine.props();
      this.scheduler = new SlotScheduler(this.props.slots);
      await this.inner.discover().catch(() => []);
    }
    return this.props;
  }

  models(signal?: AbortSignal): Promise<string[]> {
    return this.inner.models(signal);
  }

  modelInfo(model: string): ModelInfo {
    const info = this.inner.modelInfo(model);
    return this.props ? { ...info, contextWindow: this.props.ctxPerSlot } : info;
  }

  private async save(slot: number, sessionId: string, reason: "turn" | "evict" | "shutdown") {
    const kv = this.o.kv;
    const state = this.sessions.get(sessionId);
    const props = this.props;
    if (!kv || !state || !props || state.tokens < (this.o.kvMinTokens ?? 256)) return;
    const file = kvFileName(state.scope, sessionId);
    const saved = await this.engine.save(slot, file);
    await kv.put({
      file,
      scope: state.scope,
      sessionId,
      model: props.modelPath,
      ctx: props.ctxPerSlot,
      prefixHashes: state.hashes,
      tokens: saved.tokens,
      reason,
    });
    if (this.o.kvBudgetBytes !== undefined)
      await kv.enforceBudget(state.scope, this.o.kvBudgetBytes, new Set([file]));
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const props = await this.connect();
    const scheduler = this.scheduler as SlotScheduler;
    const sessionId = request.cacheKey ?? `anon_${randomUUID()}`;
    const scope = request.cacheScope ?? "default";
    const lease = await scheduler.acquire(sessionId, request.priority ?? 50, signal);
    let restored: { tokens: number; ms: number } | undefined;
    try {
      // The slot held someone else's cache: keep it on disk before it is overwritten.
      if (lease.previous) await this.save(lease.slot, lease.previous, "evict").catch(() => {});
      if (!lease.warm && this.o.kv) {
        const match = await this.o.kv.find({
          scope,
          model: props.modelPath,
          ctx: props.ctxPerSlot,
          hashes: prefixHashes(request),
        });
        if (match) {
          restored = await this.engine.restore(lease.slot, match.entry.file).catch(() => undefined);
          if (restored) await this.o.kv.touch(match.entry);
        }
      }
      this.slotFor.set(request, lease.slot);
      for await (const event of this.inner.stream(request, signal)) {
        if (event.type !== "done") {
          yield event;
          continue;
        }
        const c = event.completion;
        if (c.stopReason !== "aborted") {
          const next = {
            ...request,
            messages: [...request.messages, { role: "assistant" as const, parts: c.message.parts }],
          };
          this.sessions.set(sessionId, {
            scope,
            hashes: prefixHashes(next),
            tokens: c.usage.inputTokens + c.usage.outputTokens,
          });
          await this.save(lease.slot, sessionId, "turn").catch(() => {});
        }
        yield {
          type: "done",
          completion: {
            ...c,
            metrics: {
              ...c.metrics,
              ...(restored && { kvRestoredTokens: restored.tokens, kvRestoreMs: restored.ms }),
            },
          },
        };
      }
    } finally {
      lease.release();
    }
  }

  /**
   * Computes a history in its session's slot without answering (G24.14): after a summary made
   * in the background, the new history is ready before the person writes, so the next message
   * costs only itself. The lowest priority: a working session goes first. One token is
   * generated (the safest way across llama.cpp versions), then the slot is saved to disk.
   */
  async prefill(request: CompletionRequest, signal?: AbortSignal): Promise<void> {
    const sessionId = request.cacheKey;
    if (!sessionId) return;
    await this.connect();
    const scheduler = this.scheduler as SlotScheduler;
    const scope = request.cacheScope ?? "default";
    const lease = await scheduler.acquire(sessionId, 0, signal);
    try {
      if (lease.previous) await this.save(lease.slot, lease.previous, "evict").catch(() => {});
      const warm = { ...request, maxTokens: 1 };
      this.slotFor.set(warm, lease.slot);
      let tokens = 0;
      for await (const e of this.inner.stream(warm, signal))
        if (e.type === "done") tokens = e.completion.usage.inputTokens;
      this.sessions.set(sessionId, { scope, hashes: prefixHashes(request), tokens });
      await this.save(lease.slot, sessionId, "turn").catch(() => {});
    } finally {
      lease.release();
    }
  }

  /** Saves every slot's cache (call before stopping the server). */
  async shutdown(): Promise<void> {
    for (const h of this.scheduler?.holders() ?? [])
      await this.save(h.slot, h.sessionId, "shutdown").catch(() => {});
  }
}
