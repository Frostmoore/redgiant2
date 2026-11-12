import * as acp from "@agentclientprotocol/sdk";
import type { Engine, EngineTurn } from "@redgiant/agent";
import type { AssistantPart, MessageMetrics, StopReason } from "@redgiant/protocol";
import {
  chooseOption,
  completionOf,
  contentText,
  externalTool,
  insideFolder,
  type MappedCall,
  permissionCall,
  shellLine,
  stopReasonOf,
  workerPrelude,
} from "./map.js";

/** An external agent's process, started in its folder (the project's sandbox). */
export interface AcpProcess {
  /** The process's stdin and stdout. */
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  /** Its folder as the process sees it (in a container, the container's path). */
  cwd: string;
  kill(): void;
  /** Settles when the process ends. */
  exited: Promise<number | null>;
}

/** What RedGiant gives an external agent (G38.6): everything within its folder, checked. */
export interface AcpWorkerHost {
  /** Starts the agent's program (in the agent's sandbox, with an environment without secrets). */
  launch(): Promise<AcpProcess>;
  /** Text files of its folder, by path relative to it. */
  readText(rel: string): Promise<string>;
  writeText(rel: string, content: string): Promise<void>;
  /**
   * RedGiant's permission for one of its actions (the `PermissionBroker`, guardian included).
   * `ask`: the agent itself asked; RedGiant's rules alone never turn that into a yes.
   */
  permit(
    call: MappedCall,
    o: { ask: boolean; signal?: AbortSignal },
  ): Promise<{ allow: boolean; reason?: string }>;
  /** Runs a program in its folder, without a shell (`Workspace.execFile`). */
  run(
    file: string,
    args: string[],
    o: {
      cwd: string;
      env?: Record<string, string>;
      signal: AbortSignal;
      onOutput: (text: string) => void;
    },
  ): Promise<{ exitCode: number | null }>;
  /** A line for the server's log (the agent's stderr, errors). */
  log?(line: string): void;
}

export interface AcpEngineOptions {
  /** The worker's name in RedGiant (the prelude names it). */
  name: string;
  host: AcpWorkerHost;
  /** How long a silent agent may stay alive between turns before its process is closed. */
  idleMs?: number;
}

const zeroMetrics = (startedAt: number): MessageMetrics => ({
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date().toISOString(),
  inputTokens: 0,
  cachedReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  contextUsed: 0,
  contextWindow: 1,
  source: "server",
});

interface Terminal {
  output: string;
  truncated: boolean;
  limit: number | undefined;
  exit: Promise<{ exitCode: number | null; signal: string | null }>;
  status: { exitCode: number | null; signal: string | null } | null;
  stop: AbortController;
}

interface Running {
  sessionId: string;
  turn: EngineTurn;
  text: string;
  thinking: string;
  startedAt: number;
  /** Tool calls seen in this turn, by id: their kind and input for the permission requests. */
  tools: Map<
    string,
    { kind?: acp.ToolKind | null; title?: string | null; rawInput?: unknown; done: boolean }
  >;
  /** Log writes in order (the notifications come faster than the log). */
  chain: Promise<void>;
  cancelled: AbortSignal;
}

/**
 * An external ACP agent as one of RedGiant's engines (G38.6): Claude Code through its adapter,
 * Codex, Gemini CLI. The conversation lives in the agent (resumed with `session/load` when it
 * can); RedGiant records what it says and does, answers its permission requests through the
 * broker, and serves its files and terminals only within its folder. A turn's abort is
 * `session/cancel`.
 */
export class AcpEngine implements Engine {
  readonly id = "acp";
  /** Agents run builds and tests: a long silence is normal, an hour is not. */
  readonly stall = { firstTokenMs: 30 * 60_000, idleMs: 60 * 60_000 };
  private conn:
    | Promise<{ c: acp.ClientConnection; proc: AcpProcess; init: acp.InitializeResponse }>
    | undefined;
  private sessionId: string | undefined;
  private running: Running | undefined;
  /** Replayed history while loading: never recorded again. */
  private loading = false;
  private readonly terminals = new Map<string, Terminal>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private terminalSeq = 0;
  /** What the agent said about itself (`agentInfo`), once started. */
  info: { name: string; version?: string } | undefined;

  constructor(private readonly o: AcpEngineOptions) {}

  private connection() {
    this.conn ??= this.start().catch((err) => {
      this.conn = undefined;
      throw err;
    });
    return this.conn;
  }

  private async start() {
    const proc = await this.o.host.launch();
    const app = acp
      .client({ name: "redgiant" })
      .onNotification("session/update", (ctx) => this.update(ctx.params))
      .onRequest("session/request_permission", (ctx) => this.permission(ctx.params, ctx.signal))
      .onRequest("fs/read_text_file", (ctx) => this.readFile(ctx.params, proc.cwd))
      .onRequest("fs/write_text_file", (ctx) => this.writeFile(ctx.params, proc.cwd))
      .onRequest("terminal/create", (ctx) => this.createTerminal(ctx.params, proc.cwd))
      .onRequest("terminal/output", (ctx) => this.terminalOutput(ctx.params))
      .onRequest("terminal/wait_for_exit", (ctx) => this.waitTerminal(ctx.params))
      .onRequest("terminal/kill", (ctx) => {
        this.terminals.get(ctx.params.terminalId)?.stop.abort();
        return {};
      })
      .onRequest("terminal/release", (ctx) => {
        this.terminals.get(ctx.params.terminalId)?.stop.abort();
        this.terminals.delete(ctx.params.terminalId);
        return {};
      });
    const c = app.connect(acp.ndJsonStream(proc.input, proc.output));
    const reset = () => {
      if (this.conn) this.conn = undefined;
      this.sessionId = undefined;
      for (const t of this.terminals.values()) t.stop.abort();
      this.terminals.clear();
    };
    void c.closed.then(reset, reset);
    void proc.exited.then(() => c.close(new Error("the external agent's process ended")));
    let init: acp.InitializeResponse;
    try {
      init = await c.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "redgiant", title: "RedGiant", version: "3" },
      });
    } catch (err) {
      proc.kill();
      throw new Error(`The external agent did not start: ${(err as Error).message}`);
    }
    if (init.agentInfo)
      this.info = {
        name: init.agentInfo.name,
        ...(init.agentInfo.version && { version: init.agentInfo.version }),
      };
    return { c, proc, init };
  }

  /** Closes the agent's process (RedGiant closes the conversation, or it stayed idle). */
  close(): void {
    if (this.idle) clearTimeout(this.idle);
    const conn = this.conn;
    this.conn = undefined;
    this.sessionId = undefined;
    void conn?.then(
      ({ c, proc }) => {
        c.close();
        proc.kill();
      },
      () => {},
    );
  }

  async turn(t: EngineTurn): Promise<{ resume: string; stopReason: StopReason }> {
    if (this.idle) clearTimeout(this.idle);
    try {
      return await this.turnNow(t);
    } finally {
      const ms = this.o.idleMs ?? 10 * 60_000;
      if (Number.isFinite(ms)) {
        this.idle = setTimeout(() => this.close(), ms);
        this.idle.unref?.();
      }
    }
  }

  private async turnNow(t: EngineTurn): Promise<{ resume: string; stopReason: StopReason }> {
    const { c, proc, init } = await this.connection();
    const closesTasks = t.tools.some((d) => d.name === "complete_task");
    let fresh = false;
    if (!this.sessionId) {
      if (t.resume && init.agentCapabilities?.loadSession) {
        this.loading = true;
        try {
          await c.agent.request("session/load", {
            sessionId: t.resume,
            cwd: proc.cwd,
            mcpServers: [],
          });
          this.sessionId = t.resume;
        } catch (err) {
          this.o.host.log?.(
            `acp ${this.o.name}: could not load ${t.resume}: ${(err as Error).message}`,
          );
        } finally {
          this.loading = false;
        }
      }
      if (!this.sessionId) {
        const r = await c.agent.request("session/new", { cwd: proc.cwd, mcpServers: [] });
        this.sessionId = r.sessionId;
        fresh = true;
      }
    }
    const sessionId = this.sessionId;
    const prelude = fresh
      ? [
          workerPrelude(this.o.name, closesTasks),
          t.resume
            ? "RedGiant restarted and your earlier conversation could not be reopened: what you did is in this folder."
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "";
    let text = prelude ? `${prelude}\n\n---\n\n${t.text}` : t.text;
    let images = t.images;
    for (let attempt = 0; ; attempt++) {
      const out = await this.prompt(c, sessionId, text, images, t, init);
      if (out.stopReason !== "end_turn" || !closesTasks)
        return { resume: sessionId, stopReason: out.stopReason };
      const done = completionOf(out.text);
      if (!done || attempt >= 3) return { resume: sessionId, stopReason: "end_turn" };
      const r = await t.runTool({
        callId: `acp-complete-${Date.now().toString(36)}-${attempt}`,
        name: "complete_task",
        input: done,
      });
      if (!r.isError) return { resume: sessionId, stopReason: "end_turn" };
      text = `RedGiant: complete_task did not close the task.\n${r.content}\n\nFix what is wrong, then end your answer with the ${"RG_COMPLETE_TASK"} line again.`;
      images = [];
    }
  }

  /** One `session/prompt`, its updates recorded as they come. */
  private async prompt(
    c: acp.ClientConnection,
    sessionId: string,
    text: string,
    images: EngineTurn["images"],
    t: EngineTurn,
    init: acp.InitializeResponse,
  ): Promise<{ stopReason: StopReason; text: string }> {
    const cancel = new AbortController();
    const run: Running = {
      sessionId,
      turn: t,
      text: "",
      thinking: "",
      startedAt: Date.now(),
      tools: new Map(),
      chain: Promise.resolve(),
      cancelled: cancel.signal,
    };
    this.running = run;
    let all = "";
    const onAbort = () => {
      cancel.abort();
      void c.agent.notify("session/cancel", { sessionId }).catch(() => {});
    };
    if (t.signal?.aborted) onAbort();
    else t.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const blocks: acp.ContentBlock[] = [{ type: "text", text }];
      if (init.agentCapabilities?.promptCapabilities?.image)
        for (const i of images) blocks.push({ type: "image", mimeType: i.mediaType, data: i.data });
      const pending = c.agent.request("session/prompt", { sessionId, prompt: blocks });
      // Cancelled: the agent answers `cancelled`; one that does not within a while is stopped.
      const r = await Promise.race([
        pending,
        new Promise<"gone">((ok) => {
          cancel.signal.addEventListener(
            "abort",
            () => setTimeout(() => ok("gone"), 15_000).unref?.(),
            { once: true },
          );
        }),
      ]);
      all = run.text;
      await this.flush(run);
      await run.chain;
      if (r === "gone") {
        this.close();
        return { stopReason: "aborted", text: all };
      }
      // A tool still open when the turn ended: failed (ACP v1 has no "cancelled" status).
      for (const [id, tool] of run.tools)
        if (!tool.done)
          await t.onExternalResult?.({
            callId: id,
            ok: false,
            output: cancel.signal.aborted ? "stopped" : "",
          });
      return {
        stopReason: cancel.signal.aborted ? "aborted" : stopReasonOf(r.stopReason),
        text: all,
      };
    } finally {
      t.signal?.removeEventListener("abort", onAbort);
      if (this.running === run) this.running = undefined;
    }
  }

  /** What the agent said so far, as one assistant message (before a tool, or at the end). */
  private flush(run: Running): Promise<void> {
    const parts: AssistantPart[] = [];
    if (run.thinking) parts.push({ type: "thinking", text: run.thinking });
    if (run.text) parts.push({ type: "text", text: run.text });
    run.thinking = "";
    run.text = "";
    if (parts.length === 0) return run.chain;
    const startedAt = run.startedAt;
    run.startedAt = Date.now();
    run.chain = run.chain.then(() =>
      run.turn
        .onMessage({
          parts,
          metrics: zeroMetrics(startedAt),
          stopReason: "end_turn",
          model: this.info?.name ?? this.o.name,
        })
        .catch((err) => this.o.host.log?.(`acp ${this.o.name}: ${(err as Error).message}`)),
    );
    return run.chain;
  }

  private later(run: Running, f: () => Promise<void> | undefined) {
    run.chain = run.chain.then(() =>
      f()?.catch((err) => this.o.host.log?.(`acp ${this.o.name}: ${(err as Error).message}`)),
    );
  }

  private update(n: acp.SessionNotification): void {
    if (this.loading) return;
    const run = this.running;
    if (!run || n.sessionId !== run.sessionId) return;
    const u = n.update;
    run.turn.alive?.();
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          run.text += u.content.text;
          run.turn.live?.({ type: "text_delta", text: u.content.text });
        }
        return;
      case "agent_thought_chunk":
        if (u.content.type === "text") {
          run.thinking += u.content.text;
          run.turn.live?.({ type: "thinking_delta", text: u.content.text });
        }
        return;
      case "tool_call": {
        void this.flush(run);
        const known = run.tools.get(u.toolCallId);
        run.tools.set(u.toolCallId, {
          kind: u.kind ?? null,
          title: u.title,
          rawInput: u.rawInput,
          done: false,
        });
        if (!known) {
          const shown = externalTool(u);
          this.later(run, () => run.turn.onExternalTool?.({ callId: u.toolCallId, ...shown }));
        }
        if (u.status === "completed" || u.status === "failed")
          this.toolEnded(run, u.toolCallId, u.status, contentText(u.content));
        return;
      }
      case "tool_call_update": {
        const known = run.tools.get(u.toolCallId);
        if (!known) {
          void this.flush(run);
          run.tools.set(u.toolCallId, {
            kind: u.kind ?? null,
            title: u.title ?? null,
            rawInput: u.rawInput,
            done: false,
          });
          const shown = externalTool({
            kind: u.kind ?? "other",
            title: u.title ?? u.toolCallId,
            rawInput: u.rawInput,
            ...(u.locations && { locations: u.locations }),
          });
          this.later(run, () => run.turn.onExternalTool?.({ callId: u.toolCallId, ...shown }));
        } else {
          if (u.kind) known.kind = u.kind;
          if (u.title) known.title = u.title;
          if (u.rawInput !== undefined) known.rawInput = u.rawInput;
        }
        if (u.status === "completed" || u.status === "failed")
          this.toolEnded(run, u.toolCallId, u.status, contentText(u.content));
        return;
      }
      default:
        return;
    }
  }

  private toolEnded(run: Running, id: string, status: "completed" | "failed", output: string) {
    const tool = run.tools.get(id);
    if (!tool || tool.done) return;
    tool.done = true;
    this.later(run, () =>
      run.turn.onExternalResult?.({
        callId: id,
        ok: status === "completed",
        output: output.slice(0, 30_000),
      }),
    );
  }

  /** The agent asks before acting: RedGiant's broker answers, never a yes by itself. */
  private async permission(
    p: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const run = this.running;
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (!run || p.sessionId !== run.sessionId || run.cancelled.aborted) return cancelled;
    const proc = await this.connection().then((x) => x.proc);
    const call = permissionCall(p.toolCall, proc.cwd, run.tools.get(p.toolCall.toolCallId));
    const stop = new AbortController();
    const abort = () => stop.abort();
    signal.addEventListener("abort", abort, { once: true });
    run.cancelled.addEventListener("abort", abort, { once: true });
    // Waiting for the person is not the agent being silent.
    const beat = setInterval(() => run.turn.alive?.(), 20_000);
    try {
      await run.chain;
      const d = await this.o.host.permit(call, { ask: true, signal: stop.signal });
      if (stop.signal.aborted) return cancelled;
      const optionId = chooseOption(p.options, d.allow);
      if (!optionId) return cancelled;
      return { outcome: { outcome: "selected", optionId } };
    } catch {
      return cancelled;
    } finally {
      clearInterval(beat);
      signal.removeEventListener("abort", abort);
      run.cancelled.removeEventListener("abort", abort);
    }
  }

  private inside(cwd: string, path: string): string {
    const rel = insideFolder(cwd, path);
    if (rel === undefined)
      throw acp.RequestError.invalidParams(
        { path },
        `RedGiant refused: ${path} is outside this agent's folder (${cwd})`,
      );
    return rel;
  }

  private async checked(call: MappedCall): Promise<void> {
    const d = await this.o.host.permit(call, {
      ask: false,
      ...(this.running && { signal: this.running.cancelled }),
    });
    if (!d.allow)
      throw acp.RequestError.invalidParams(
        { tool: call.name },
        `RedGiant refused: ${d.reason ?? "not allowed"}`,
      );
  }

  private async readFile(
    p: acp.ReadTextFileRequest,
    cwd: string,
  ): Promise<acp.ReadTextFileResponse> {
    const rel = this.inside(cwd, p.path);
    await this.checked({ callId: `acp-read-${rel}`, name: "read_file", input: { path: rel } });
    let content: string;
    try {
      content = await this.o.host.readText(rel);
    } catch (err) {
      throw acp.RequestError.resourceNotFound(`${p.path}: ${(err as Error).message}`);
    }
    if (p.line || p.limit) {
      const lines = content.split("\n");
      const from = Math.max(0, (p.line ?? 1) - 1);
      content = lines.slice(from, p.limit ? from + p.limit : undefined).join("\n");
    }
    return { content };
  }

  private async writeFile(
    p: acp.WriteTextFileRequest,
    cwd: string,
  ): Promise<acp.WriteTextFileResponse> {
    const rel = this.inside(cwd, p.path);
    await this.checked({
      callId: `acp-write-${rel}`,
      name: "write_file",
      input: { path: rel, content: p.content },
    });
    await this.o.host.writeText(rel, p.content);
    return {};
  }

  private async createTerminal(
    p: acp.CreateTerminalRequest,
    cwd: string,
  ): Promise<acp.CreateTerminalResponse> {
    const dir = p.cwd ? this.inside(cwd, p.cwd) : ".";
    const args = p.args ?? [];
    await this.checked({
      callId: `acp-terminal-${this.terminalSeq + 1}`,
      name: "bash",
      input: { command: shellLine(p.command, args), ...(dir !== "." && { cwd: dir }) },
    });
    const id = `term_${++this.terminalSeq}`;
    const env: Record<string, string> = {};
    for (const v of p.env ?? []) {
      if (/^REDGIANT_/i.test(v.name)) continue;
      env[v.name] = v.value;
    }
    const term: Terminal = {
      output: "",
      truncated: false,
      limit: p.outputByteLimit ?? undefined,
      status: null,
      stop: new AbortController(),
      exit: Promise.resolve({ exitCode: null, signal: null }),
    };
    term.exit = this.o.host
      .run(p.command, args, {
        cwd: dir,
        env,
        signal: term.stop.signal,
        onOutput: (text) => {
          term.output += text;
          if (term.limit !== undefined && Buffer.byteLength(term.output) > term.limit) {
            const b = Buffer.from(term.output);
            term.output = b.subarray(b.length - term.limit).toString();
            term.truncated = true;
          }
        },
      })
      .then(
        (r) => ({ exitCode: r.exitCode, signal: term.stop.signal.aborted ? "SIGKILL" : null }),
        (err: Error) => {
          term.output += `\n${err.message}`;
          return { exitCode: null, signal: null };
        },
      )
      .then((s) => {
        term.status = s;
        return s;
      });
    this.terminals.set(id, term);
    return { terminalId: id };
  }

  private terminal(id: string): Terminal {
    const t = this.terminals.get(id);
    if (!t) throw acp.RequestError.resourceNotFound(id);
    return t;
  }

  private terminalOutput(p: acp.TerminalOutputRequest): acp.TerminalOutputResponse {
    const t = this.terminal(p.terminalId);
    return { output: t.output, truncated: t.truncated, exitStatus: t.status };
  }

  private async waitTerminal(
    p: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    return this.terminal(p.terminalId).exit;
  }
}
