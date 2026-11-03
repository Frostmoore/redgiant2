// ChatGPT on a flat subscription (G21.3), through OpenAI's own Codex app server (`codex app-server`,
// JSON-RPC over stdio): the official way to use a ChatGPT plan from a program, with the device-code
// login meant for machines without a browser. Codex runs the model loop; its own shell and editing
// are switched off (read-only sandbox, no shell tools) and RedGiant's tools are offered as Codex's
// "dynamic tools", so permissions, sandbox and log stay RedGiant's.
//
// This is the only file that knows the protocol. Dynamic tools are an experimental part of it: if
// they change, only this file needs fixing.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { Engine, EngineTurn } from "@redgiant/agent";
import type { AssistantPart, MessageMetrics } from "@redgiant/protocol";
import {
  type ModelInfo,
  type Provider,
  ProviderError,
  type SubscriptionWindow,
} from "@redgiant/providers";

export const CHATGPT_SUBSCRIPTION = "chatgpt-subscription";

export interface ChatgptSubscriptionOptions {
  /** Where Codex keeps its login and threads (CODEX_HOME), apart from the user's. */
  home: string;
  /** A directory Codex may call its workspace (it touches no files: read-only sandbox). */
  cwd: string;
  /** The program to run; default the bundled `codex app-server`. Tests pass a fake. */
  command?: { file: string; args: string[] };
  now?: () => number;
  /** Codex's own live web search (2026-11-03) instead of RedGiant's `web_search`. Default on. */
  nativeWebSearch?: boolean;
}

type Json = Record<string, unknown>;
type Pending = { ok: (v: unknown) => void; ko: (e: Error) => void };

/** One `codex app-server` process and its JSON-RPC line protocol. */
class CodexConnection {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private ready: Promise<void> | undefined;
  private next = 1;
  private readonly pending = new Map<number | string, Pending>();
  readonly listeners = new Set<(method: string, params: Json) => void>();
  /** Requests from Codex to us (dynamic tool calls); the answer goes back as the result. */
  onRequest: ((method: string, params: Json) => Promise<unknown>) | undefined;

  constructor(private readonly o: ChatgptSubscriptionOptions) {}

  private command() {
    if (this.o.command) return this.o.command;
    const bin = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
    return { file: process.execPath, args: [bin, "app-server"] };
  }

  start(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.o.home, { recursive: true });
      await mkdir(this.o.cwd, { recursive: true });
      const { file, args } = this.command();
      const proc = spawn(file, args, {
        env: {
          ...(process.env.PATH && { PATH: process.env.PATH }),
          HOME: this.o.home,
          CODEX_HOME: this.o.home,
        },
        cwd: this.o.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;
      proc.stderr.resume();
      proc.on("exit", () => {
        this.proc = undefined;
        this.ready = undefined;
        for (const p of this.pending.values()) p.ko(new ProviderError("Codex stopped", true));
        this.pending.clear();
      });
      createInterface({ input: proc.stdout }).on("line", (line) => this.receive(line));
      await this.request("initialize", {
        clientInfo: { name: "redgiant", title: "RedGiant", version: "2" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized", {});
    })();
    return this.ready;
  }

  private send(m: Json) {
    this.proc?.stdin.write(`${JSON.stringify(m)}\n`);
  }

  private receive(line: string) {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    const id = m.id as number | string | undefined;
    if (id !== undefined && typeof m.method === "string") {
      // A request from Codex.
      const method = m.method;
      void (
        this.onRequest?.(method, (m.params ?? {}) as Json) ?? Promise.reject(new Error("unhandled"))
      )
        .then((result) => this.send({ id, result }))
        .catch((err: Error) => this.send({ id, error: { code: -32000, message: err.message } }));
      return;
    }
    if (id !== undefined) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (!p) return;
      const error = m.error as { message?: string; code?: number } | undefined;
      if (error) p.ko(new ProviderError(`Codex: ${error.message ?? "error"}`, false));
      else p.ok(m.result);
      return;
    }
    if (typeof m.method === "string")
      for (const l of this.listeners) l(m.method, (m.params ?? {}) as Json);
  }

  request<T = Json>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, ko) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, ko });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  stop() {
    this.proc?.kill();
  }
}

/** Codex's rate-limit snapshot as windows: the primary is the 5-hour one, the secondary the week. */
export function codexWindows(snapshot: unknown): SubscriptionWindow[] {
  const s = snapshot as {
    primary?: {
      usedPercent?: number;
      windowDurationMins?: number | null;
      resetsAt?: number | null;
    } | null;
    secondary?: {
      usedPercent?: number;
      windowDurationMins?: number | null;
      resetsAt?: number | null;
    } | null;
  } | null;
  const out: SubscriptionWindow[] = [];
  for (const [w, fallback] of [
    [s?.primary, "5h"],
    [s?.secondary, "7d"],
  ] as const) {
    if (typeof w?.usedPercent !== "number") continue;
    const mins = w.windowDurationMins ?? (fallback === "5h" ? 300 : 10_080);
    const id = mins <= 600 ? "5h" : "7d";
    const label = mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}g`;
    out.push({
      id,
      label,
      usedPct: Math.round(w.usedPercent),
      ...(w.resetsAt && {
        resetsAt: new Date(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)).toISOString(),
      }),
    });
  }
  return out;
}

/** One turn on Codex: a thread per RedGiant session, RedGiant's tools as dynamic tools. */
export class CodexEngine implements Engine {
  readonly id = CHATGPT_SUBSCRIPTION;
  onLimits: ((w: SubscriptionWindow[]) => void) | undefined;
  private readonly loaded = new Set<string>();
  /** The turn waiting for each thread's dynamic tool calls. */
  private readonly turns = new Map<string, EngineTurn>();

  constructor(
    private readonly conn: CodexConnection,
    private readonly o: ChatgptSubscriptionOptions,
  ) {
    conn.onRequest = async (method, params) => {
      if (method !== "item/tool/call") throw new Error(`Not supported: ${method}`);
      const t = this.turns.get(String(params.threadId));
      if (!t)
        return {
          success: false,
          contentItems: [{ type: "inputText", text: "No turn is running." }],
        };
      const callId = String(params.callId);
      const name = String(params.tool);
      // The call is announced in the log before it runs, like any model's tool call.
      await t.onMessage({
        parts: [
          {
            type: "tool_call",
            callId,
            name,
            input: params.arguments,
            rawInput: JSON.stringify(params.arguments ?? {}),
          },
        ],
        metrics: this.metrics(String(params.threadId)),
        stopReason: "tool_use",
        model: t.model.model,
      });
      const r = await t.runTool({ callId, name, input: params.arguments });
      return { success: !r.isError, contentItems: [{ type: "inputText", text: r.content }] };
    };
  }

  private readonly usage = new Map<string, { last: Json; window: number | null; at: number }>();
  private metrics(threadId: string): MessageMetrics {
    const u = this.usage.get(threadId);
    const last = (u?.last ?? {}) as Record<string, number>;
    const at = new Date((this.o.now ?? Date.now)()).toISOString();
    const input = last.inputTokens ?? 0;
    return {
      startedAt: at,
      endedAt: at,
      inputTokens: input,
      cachedReadTokens: last.cachedInputTokens ?? 0,
      cacheWriteTokens: last.cacheWriteInputTokens ?? 0,
      outputTokens: last.outputTokens ?? 0,
      contextUsed: last.totalTokens ?? input + (last.outputTokens ?? 0),
      contextWindow: u?.window ?? 272_000,
      prefillMs: 0,
      decodeMs: 0,
      tokPerSec: 0,
      source: "server",
    };
  }

  async turn(t: EngineTurn): Promise<{ resume: string; stopReason: "end_turn" | "aborted" }> {
    await this.conn.start();
    const native = this.o.nativeWebSearch !== false;
    // With Codex's own search, RedGiant's is not offered too (one way to search).
    const tools = t.tools
      .filter((d) => !native || d.name !== "web_search")
      .map((d) => ({
        type: "function",
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
      }));
    const threadParams = {
      model: t.model.model,
      cwd: this.o.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: t.system,
      dynamicTools: tools,
      // Codex's own shell off (commands run through RedGiant's tools); its web search live.
      config: {
        "features.shell_tool": false,
        "features.unified_exec": false,
        web_search: native ? "live" : "disabled",
      },
    };
    let threadId = t.resume;
    if (threadId && !this.loaded.has(threadId)) {
      await this.conn.request("thread/resume", { threadId, ...threadParams });
      this.loaded.add(threadId);
    }
    if (!threadId) {
      const r = await this.conn.request<{ thread: { id: string } }>("thread/start", threadParams);
      threadId = r.thread.id;
      this.loaded.add(threadId);
    }
    const id = threadId;
    this.turns.set(id, t);
    let turnId: string | undefined;
    const done = new Promise<"end_turn" | "aborted">((ok, ko) => {
      const listen = (method: string, p: Json) => {
        if (p.threadId !== undefined && p.threadId !== id) return;
        if (method === "thread/tokenUsage/updated") {
          const u = p.tokenUsage as { last: Json; modelContextWindow: number | null };
          this.usage.set(id, { last: u.last, window: u.modelContextWindow, at: Date.now() });
        } else if (method === "thread/compacted") {
          // Codex summarised its own context.
          t.onCompaction?.({ trigger: "auto" });
        } else if (method === "item/agentMessage/delta") {
          t.live?.({ type: "text_delta", text: String(p.delta ?? "") });
        } else if (method === "item/completed") {
          const item = p.item as Json;
          const parts: AssistantPart[] = [];
          if (item.type === "contextCompaction") t.onCompaction?.({ trigger: "auto" });
          if (item.type === "reasoning") {
            const text = [
              ...((item.summary as string[]) ?? []),
              ...((item.content as string[]) ?? []),
            ].join("\n");
            if (text) parts.push({ type: "thinking", text });
          } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
            parts.push({ type: "text", text: item.text });
          }
          if (parts.length)
            void t.onMessage({
              parts,
              metrics: this.metrics(id),
              stopReason: "end_turn",
              model: t.model.model,
            });
        } else if (method === "account/rateLimits/updated") {
          const w = codexWindows(p.rateLimits);
          if (w.length) this.onLimits?.(w);
        } else if (method === "turn/completed") {
          this.conn.listeners.delete(listen);
          const turn = p.turn as { status?: string; error?: { message?: string } | null };
          if (turn.status === "interrupted") ok("aborted");
          else if (turn.status === "failed") {
            const msg = turn.error?.message ?? "the turn failed";
            ko(
              new ProviderError(
                `ChatGPT subscription: ${msg}`,
                false,
                /401|unauthori[sz]ed|log ?in|token/i.test(msg) ? { status: 401 } : {},
              ),
            );
          } else ok("end_turn");
        }
      };
      this.conn.listeners.add(listen);
    });
    const interrupt = () => {
      if (turnId)
        void this.conn.request("turn/interrupt", { threadId: id, turnId }).catch(() => {});
    };
    t.signal?.addEventListener("abort", interrupt, { once: true });
    try {
      const r = await this.conn.request<{ turn: { id: string } }>("turn/start", {
        threadId: id,
        model: t.model.model,
        ...(t.model.effort && { effort: t.model.effort === "max" ? "xhigh" : t.model.effort }),
        input: [
          { type: "text", text: t.text, text_elements: [] },
          ...t.images.map((im) => ({
            type: "image",
            url: `data:${im.mediaType};base64,${im.data}`,
          })),
        ],
      });
      turnId = r.turn.id;
      if (t.signal?.aborted) interrupt();
      const stopReason = await done;
      return { resume: id, stopReason };
    } finally {
      t.signal?.removeEventListener("abort", interrupt);
      this.turns.delete(id);
    }
  }
}

/**
 * The provider RedGiant sees: models, the engine, the plan's limits and the login. Sessions on it
 * always go through the engine.
 */
export class ChatgptSubscriptionProvider implements Provider {
  readonly id = CHATGPT_SUBSCRIPTION;
  readonly engine: CodexEngine;
  private readonly conn: CodexConnection;
  private windows: SubscriptionWindow[] = [];
  private modelCache: string[] | undefined;

  constructor(o: ChatgptSubscriptionOptions) {
    this.conn = new CodexConnection(o);
    this.engine = new CodexEngine(this.conn, o);
    this.engine.onLimits = (w) => {
      this.windows = w;
    };
  }

  async models(): Promise<string[]> {
    if (this.modelCache) return this.modelCache;
    await this.conn.start();
    const r = await this.conn.request<{
      data?: { id?: string; model?: string; hidden?: boolean }[];
    }>("model/list", {});
    this.modelCache = (r.data ?? [])
      .filter((m) => !m.hidden)
      .map((m) => m.model ?? m.id ?? "")
      .filter(Boolean);
    return this.modelCache;
  }

  modelInfo(model: string): ModelInfo {
    return { id: model, contextWindow: 272_000, maxOutputTokens: 128_000, supportsEffort: true };
  }

  // biome-ignore lint/correctness/useYield: a session on a subscription never streams here.
  async *stream(): AsyncIterable<never> {
    throw new ProviderError(
      "A ChatGPT subscription runs through its engine, not as a stream",
      false,
    );
  }

  /** The plan's windows: the last update from the turns, or a fresh reading. */
  async limits(): Promise<SubscriptionWindow[]> {
    if (this.windows.length) return this.windows;
    try {
      await this.conn.start();
      const r = await this.conn.request<{ rateLimits?: unknown }>("account/rateLimits/read", {});
      this.windows = codexWindows(r.rateLimits);
    } catch {
      // Not logged in yet, or Codex unavailable: no bars.
    }
    return this.windows;
  }

  /** Who is logged in (null: nobody). */
  async account(): Promise<{ email: string | null; plan: string | null } | null> {
    await this.conn.start();
    const r = await this.conn.request<{
      account?: { type?: string; email?: string; planType?: string } | null;
    }>("account/read", { refreshToken: false });
    const a = r.account;
    return a && a.type === "chatgpt" ? { email: a.email ?? null, plan: a.planType ?? null } : null;
  }

  /**
   * Starts the device-code login: the human opens the address and types the code; `done` settles
   * when ChatGPT confirms (or refuses).
   */
  async login(): Promise<{ url: string; code: string; done: Promise<boolean> }> {
    await this.conn.start();
    const r = await this.conn.request<{
      type: string;
      verificationUrl: string;
      userCode: string;
      loginId: string;
    }>("account/login/start", { type: "chatgptDeviceCode" });
    const done = new Promise<boolean>((ok) => {
      const listen = (method: string, p: Json) => {
        if (method !== "account/login/completed" || (p.loginId && p.loginId !== r.loginId)) return;
        this.conn.listeners.delete(listen);
        ok(p.success === true);
      };
      this.conn.listeners.add(listen);
    });
    return { url: r.verificationUrl, code: r.userCode, done };
  }

  async logout(): Promise<void> {
    await this.conn.start();
    await this.conn.request("account/logout", undefined);
    this.windows = [];
  }

  stop(): void {
    this.conn.stop();
  }
}
