// Background commands (p3.3.1, the user: «Certo che li deve eseguire»): `bash` with
// `background: true` starts a command that keeps running (a dev server, a watcher, a long build)
// and answers at once with its id; `bash_output` reads what it wrote since the last look, waits
// for a text to appear, says how it is, or stops it. They run where `bash` runs and as it runs
// (the workspace's shell, the agents' environment without secrets, the same approvals), with a
// limit per conversation, their output in a file with a ceiling, and they are stopped with
// their whole tree when the conversation's sub-agent ends or RedGiant stops. The host records
// their start and end as events, so the page draws them and a restart marks them interrupted.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { truncateMiddle } from "./text.js";
import type { Workspace } from "./workspace.js";

export type CommandStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

export interface BackgroundCommand {
  id: string;
  sessionId: string;
  command: string;
  /** The log (absolute): `<workspace>/.redgiant/commands/<id>.log`. */
  file: string;
  /** The same, relative to the workspace (the agent can read it with read_file). */
  path: string;
  /** Where it runs (the workspace's folder). */
  cwd: string;
  /** Who started it, in words (agent, kind, conversation). */
  by: string;
  startedAt: string;
  endedAt?: string;
  status: CommandStatus;
  exitCode: number | null;
  pid?: number;
  /** The tool call that started it. */
  callId?: string;
}

/** Where a command's start and end are recorded (the server: events in the conversation). */
export interface BackgroundEvents {
  started(c: BackgroundCommand, ctx: ToolContext): Promise<void> | void;
  ended(c: BackgroundCommand, ctx: ToolContext): Promise<void> | void;
}

export interface BackgroundOptions {
  events?: BackgroundEvents;
  /** Who started it, in words, for the log's header. */
  who?: (ctx: ToolContext) => string;
  /** Running at once in one conversation (default 4). */
  maxPerSession?: number;
  /** The log's ceiling: past it the oldest half of the lines goes (default 8 MB). */
  maxBytes?: number;
  /** A command never runs longer than this (default 24 hours). */
  maxMs?: number;
  now?: () => Date;
}

interface Live {
  c: BackgroundCommand;
  ctx: ToolContext;
  stop: AbortController;
  done: Promise<void>;
  started: number;
  /** A line not yet ended, per stream. */
  partial: { out: string; err: string };
  bytes: number;
  /** Where the agent's next plain read starts (an output line's number). */
  cursor: number;
  stoppedByHand: boolean;
}

export class BackgroundLimitError extends Error {}

// ---------------------------------------------------------------- The log

/**
 * The log of a background command, made to be read by people and by programs:
 *
 *   # command  cmd_ab12cd34ef
 *   # started  2026-11-07 15:03:12.000 +01:00
 *   # folder   /data/workspaces/me/demo
 *   # by       Coder (agent agent_1a2b), conversation sess_3c4d
 *   # run      npm run dev
 *   [15:03:12.481 +0.481s] out  > vite
 *   [15:03:12.900 +0.900s] err  warning: ...
 *   # ended    2026-11-07 15:05:00.120 +01:00  exit 0  after 108.120 s  (done)
 *
 * Every line has its clock time and its time since the start; `out` and `err` keep stdout and
 * stderr apart. Past the ceiling the oldest lines go and `# dropped <n> older lines` says so.
 */
const two = (n: number, w = 2) => String(n).padStart(w, "0");
export function clockOf(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${two(d.getMilliseconds(), 3)}`;
}
export function stampOf(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clockOf(d)} ${sign}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`;
}

export interface LogLine {
  /** Its number among the output lines, from 1 (dropped ones counted). */
  n: number;
  clock: string;
  /** Seconds since the start. */
  at: number;
  stream: "out" | "err";
  text: string;
}

export interface ParsedLog {
  id?: string;
  started?: string;
  folder?: string;
  by?: string;
  command?: string;
  ended?: { stamp: string; exit: number | null; seconds: number; status: string };
  dropped: number;
  lines: LogLine[];
}

const LINE = /^\[(\d\d:\d\d:\d\d\.\d{3}) \+(\d+(?:\.\d+)?)s\] (out|err) {1,2}(.*)$/;

export function parseLog(text: string): ParsedLog {
  const log: ParsedLog = { dropped: 0, lines: [] };
  let n = 0;
  for (const raw of text.split("\n")) {
    const m = raw.match(LINE);
    if (m) {
      n++;
      log.lines.push({
        n: n + log.dropped,
        clock: m[1] as string,
        at: Number(m[2]),
        stream: m[3] as "out" | "err",
        text: m[4] ?? "",
      });
      continue;
    }
    const h = raw.match(/^# (\w+)\s+(.*)$/);
    if (!h) continue;
    const [, key, value] = h as unknown as [string, string, string];
    if (key === "command") log.id = value;
    else if (key === "started") log.started = value;
    else if (key === "folder") log.folder = value;
    else if (key === "by") log.by = value;
    else if (key === "run") log.command = value;
    else if (key === "dropped") log.dropped = Number(value.match(/^\d+/)?.[0] ?? 0);
    else if (key === "ended") {
      const e = value.match(/^(.*?)\s+exit (\S+)\s+after ([\d.]+) s\s+\((\w+)\)/);
      if (e)
        log.ended = {
          stamp: e[1] as string,
          exit: e[2] === "none" ? null : Number(e[2]),
          seconds: Number(e[3]),
          status: e[4] as string,
        };
    }
  }
  return log;
}

/** A time filter: "+30" / "30s" (seconds since the start) or "15:04:10" (clock). */
export function secondsOf(when: string, log: ParsedLog): number | undefined {
  const w = when.trim();
  const rel = w.match(/^\+?(\d+(?:\.\d+)?)s?$/);
  if (rel) return Number(rel[1]);
  const clock = w.match(/^(\d{1,2}):(\d\d)(?::(\d\d(?:\.\d+)?))?$/);
  const start = log.started?.match(/ (\d\d):(\d\d):(\d\d\.\d+)/);
  if (!clock || !start) return undefined;
  const sec = (h: string, m: string, x?: string) =>
    Number(h) * 3600 + Number(m) * 60 + Number(x ?? 0);
  let d =
    sec(clock[1] as string, clock[2] as string, clock[3]) -
    sec(start[1] as string, start[2] as string, start[3]);
  if (d < -60) d += 24 * 3600;
  return d;
}

export interface LogQuery {
  /** From this output line (its number). */
  from?: number;
  /** At most this many lines (default 200); with `tail`, the last ones. */
  lines?: number;
  tail?: boolean;
  grep?: string;
  stream?: "out" | "err";
  since?: string;
  until?: string;
}

/** Lines that look like problems (errors first). */
const ERROR =
  /\b(error|errors|failed|failure|fatal|exception|traceback|panic|cannot|unable to)\b|ERR!/i;
const WARNING = /\b(warn|warning|deprecated)\b/i;

export function queryLog(log: ParsedLog, q: LogQuery): LogLine[] {
  const since = q.since ? secondsOf(q.since, log) : undefined;
  const until = q.until ? secondsOf(q.until, log) : undefined;
  const re = q.grep ? textMatcher(q.grep) : undefined;
  let lines = log.lines.filter(
    (l) =>
      (q.from === undefined || l.n >= q.from) &&
      (!q.stream || l.stream === q.stream) &&
      (since === undefined || l.at >= since) &&
      (until === undefined || l.at <= until) &&
      (!re || re(l.text)),
  );
  const max = q.lines ?? 200;
  if (lines.length > max) lines = q.tail ? lines.slice(-max) : lines.slice(0, max);
  return lines;
}

export function textMatcher(pattern: string): (t: string) => boolean {
  if (/^\/.+\/[a-z]*$/.test(pattern)) {
    const at = pattern.lastIndexOf("/");
    const re = new RegExp(pattern.slice(1, at), pattern.slice(at + 1));
    return (t) => re.test(t);
  }
  const low = pattern.toLowerCase();
  return (t) => t.toLowerCase().includes(low);
}

export const formatLines = (lines: LogLine[]) =>
  lines.map((l) => `${l.n}  [${l.clock} +${l.at.toFixed(3)}s] ${l.stream}  ${l.text}`).join("\n");

/** Lines, streams, problems and the last activity, in a few lines. */
export function summarizeLog(log: ParsedLog, now = new Date()): string {
  const err = log.lines.filter((l) => l.stream === "err").length;
  const errors = log.lines.filter((l) => ERROR.test(l.text));
  const warnings = log.lines.filter((l) => !ERROR.test(l.text) && WARNING.test(l.text));
  const last = log.lines.at(-1);
  const startMs = log.started
    ? Date.parse(log.started.replace(" ", "T").replace(/ ([+-]\d\d:\d\d)$/, "$1"))
    : NaN;
  const quiet =
    last && Number.isFinite(startMs) && !log.ended
      ? ` (${Math.max(0, Math.round((now.getTime() - startMs) / 1000 - last.at))} s ago)`
      : "";
  return [
    `${log.lines.length + log.dropped} lines (${err} on stderr${log.dropped ? `, ${log.dropped} oldest dropped` : ""}); ${errors.length} look like errors, ${warnings.length} like warnings.`,
    last
      ? `Last activity: line ${last.n} at ${last.clock} (+${last.at.toFixed(1)} s)${quiet}.`
      : "No output yet.",
    ...errors.slice(-5).map((l) => `  error? ${l.n} [${l.clock}] ${l.text.slice(0, 200)}`),
    ...warnings.slice(-3).map((l) => `  warning? ${l.n} [${l.clock}] ${l.text.slice(0, 200)}`),
  ].join("\n");
}

// ---------------------------------------------------------------- The commands

export class BackgroundCommands {
  private readonly live = new Map<string, Live>();
  private readonly maxPerSession: number;
  private readonly maxBytes: number;
  private readonly maxMs: number;
  private readonly now: () => Date;

  constructor(private readonly o: BackgroundOptions = {}) {
    this.maxPerSession = o.maxPerSession ?? 4;
    this.maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
    this.maxMs = o.maxMs ?? 24 * 60 * 60 * 1000;
    this.now = o.now ?? (() => new Date());
  }

  /** Starts a command; it runs until it ends, is stopped, or its conversation's work ends. */
  async start(ws: Workspace, command: string, ctx: ToolContext): Promise<BackgroundCommand> {
    const running = this.list(ctx.sessionId).filter((c) => c.status === "running");
    if (running.length >= this.maxPerSession)
      throw new BackgroundLimitError(
        `${running.length} background commands are already running in this conversation (${running.map((c) => c.id).join(", ")}); the limit is ${this.maxPerSession}. Stop one with bash_output (stop: true) first.`,
      );
    const id = `cmd_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const path = `.redgiant/commands/${id}.log`;
    const dir = join(ws.root, ".redgiant", "commands");
    const file = join(dir, `${id}.log`);
    mkdirSync(dir, { recursive: true });
    const at = this.now();
    const by = this.o.who?.(ctx) ?? `agent ${ctx.agentId ?? "-"}, conversation ${ctx.sessionId}`;
    const c: BackgroundCommand = {
      id,
      sessionId: ctx.sessionId,
      command,
      file,
      path,
      cwd: ws.root,
      by,
      startedAt: at.toISOString(),
      status: "running",
      exitCode: null,
      ...(ctx.callId && { callId: ctx.callId }),
    };
    const header = [
      `# command  ${id}`,
      `# started  ${stampOf(at)}`,
      `# folder   ${ws.root}`,
      `# by       ${by}`,
      `# run      ${command.replace(/\n/g, " ")}`,
      "",
    ].join("\n");
    writeFileSync(file, header);
    const stop = new AbortController();
    const l: Live = {
      c,
      ctx,
      stop,
      done: Promise.resolve(),
      started: at.getTime(),
      partial: { out: "", err: "" },
      bytes: Buffer.byteLength(header),
      cursor: 1,
      stoppedByHand: false,
    };
    this.live.set(id, l);
    let spawned: () => void = () => {};
    const ready = new Promise<void>((ok) => {
      spawned = ok;
      setTimeout(ok, 2000);
    });
    l.done = ws
      .exec(command, {
        timeoutMs: this.maxMs,
        signal: stop.signal,
        env: { REDGIANT_COMMAND: id },
        onOutput: (text, stream) => this.take(l, text, stream ?? "out"),
        onSpawn: (pid) => {
          c.pid = pid;
          spawned();
        },
      })
      .then(
        (r) => {
          // A workspace that collects the output (no streaming) gives it at the end.
          if (r.stdout) this.take(l, r.stdout, "out");
          if (r.stderr) this.take(l, r.stderr, "err");
          c.exitCode = r.exitCode;
          c.status =
            l.stoppedByHand || stop.signal.aborted || r.timedOut
              ? "stopped"
              : r.exitCode === 0
                ? "done"
                : "failed";
        },
        (err: Error) => {
          this.take(l, `${err.message}\n`, "err");
          c.status = "failed";
        },
      )
      .then(async () => {
        this.flush(l);
        const end = this.now();
        c.endedAt = end.toISOString();
        this.append(
          l,
          `# ended    ${stampOf(end)}  exit ${c.exitCode ?? "none"}  after ${((end.getTime() - l.started) / 1000).toFixed(3)} s  (${c.status})\n`,
        );
        await Promise.resolve(this.o.events?.ended(c, ctx)).catch(() => {});
      });
    await ready;
    await Promise.resolve(this.o.events?.started(c, ctx)).catch(() => {});
    return c;
  }

  /** Output in pieces: written line by line, each with its time and stream. */
  private take(l: Live, text: string, stream: "out" | "err"): void {
    const parts = (l.partial[stream] + text).split(/\r\n|\n|\r/);
    l.partial[stream] = parts.pop() ?? "";
    if (parts.length === 0) return;
    const d = this.now();
    const prefix = `[${clockOf(d)} +${((d.getTime() - l.started) / 1000).toFixed(3)}s] ${stream}  `;
    this.append(l, parts.map((p) => `${prefix}${p}\n`).join(""));
  }

  private flush(l: Live): void {
    for (const stream of ["out", "err"] as const) if (l.partial[stream]) this.take(l, "\n", stream);
  }

  private append(l: Live, text: string): void {
    try {
      appendFileSync(l.c.file, text);
      l.bytes += Buffer.byteLength(text);
      if (l.bytes > this.maxBytes) this.shrink(l);
    } catch {
      // The workspace's folder went away: the command keeps running, its output is lost.
    }
  }

  /** Past the ceiling: the header, a line that says how many went, and the latest half. */
  private shrink(l: Live): void {
    const text = readFileSync(l.c.file, "utf8");
    const log = parseLog(text);
    const all = text.split("\n");
    const head = all.filter(
      (x) => x.startsWith("# ") && !x.startsWith("# dropped") && !x.startsWith("# ended"),
    );
    const body = all.filter((x) => LINE.test(x));
    let keep = body.length;
    let size = 0;
    while (keep > 0 && size + Buffer.byteLength(body[keep - 1] as string) + 1 < this.maxBytes / 2) {
      size += Buffer.byteLength(body[keep - 1] as string) + 1;
      keep--;
    }
    const dropped = log.dropped + keep;
    const out = [...head, `# dropped  ${dropped} older lines`, ...body.slice(keep), ""].join("\n");
    writeFileSync(l.c.file, out);
    l.bytes = Buffer.byteLength(out);
  }

  get(id: string): BackgroundCommand | undefined {
    return this.live.get(id)?.c;
  }

  list(sessionId?: string): BackgroundCommand[] {
    return [...this.live.values()]
      .filter((l) => sessionId === undefined || l.c.sessionId === sessionId)
      .map((l) => l.c);
  }

  /** The command's log, parsed. */
  log(id: string): ParsedLog {
    const l = this.live.get(id);
    if (!l) throw new Error(`There is no background command "${id}".`);
    try {
      return parseLog(readFileSync(l.c.file, "utf8"));
    } catch {
      return { dropped: 0, lines: [] };
    }
  }

  /**
   * Lines of its output. Without `from` and filters: the new ones since the agent last read
   * (its cursor then moves).
   */
  read(
    id: string,
    q: LogQuery = {},
  ): { lines: LogLine[]; log: ParsedLog; c: BackgroundCommand; more: number } {
    const l = this.live.get(id);
    if (!l) throw new Error(`There is no background command "${id}".`);
    const log = this.log(id);
    const plain = q.from === undefined && !q.grep && !q.since && !q.until && !q.stream && !q.tail;
    const query = plain ? { ...q, from: l.cursor } : q;
    const lines = queryLog(log, query);
    const all = queryLog(log, { ...query, lines: Number.MAX_SAFE_INTEGER });
    if (plain) l.cursor = (lines.at(-1)?.n ?? l.cursor - 1) + 1;
    return { lines, log, c: l.c, more: all.length - lines.length };
  }

  /** Waits until `pattern` shows in its output (any line so far), it ends, or the time is up. */
  async waitFor(
    id: string,
    pattern: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"found" | "ended" | "timeout"> {
    const l = this.live.get(id);
    if (!l) throw new Error(`There is no background command "${id}".`);
    const has = textMatcher(pattern);
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.log(id).lines.some((x) => has(x.text)) || has(l.partial.out) || has(l.partial.err))
        return "found";
      if (l.c.status !== "running") return "ended";
      if (Date.now() >= end || signal?.aborted) return "timeout";
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Stops a command and everything it started; waits (a little) for it to end. */
  async stop(id: string): Promise<BackgroundCommand> {
    const l = this.live.get(id);
    if (!l) throw new Error(`There is no background command "${id}".`);
    if (l.c.status === "running") {
      l.stoppedByHand = true;
      l.stop.abort();
      await Promise.race([l.done, new Promise((r) => setTimeout(r, 5000))]);
    }
    return l.c;
  }

  /** Waits for a command's end to be written (tests, shutdown). */
  async settled(id: string): Promise<void> {
    await this.live.get(id)?.done;
  }

  /** Stops every command of a conversation (its sub-agent's work ended). */
  async stopSession(sessionId: string): Promise<void> {
    await Promise.all(
      this.list(sessionId)
        .filter((c) => c.status === "running")
        .map((c) => this.stop(c.id)),
    );
  }

  /** Stops everything (RedGiant stops). */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.list()
        .filter((c) => c.status === "running")
        .map((c) => this.stop(c.id)),
    );
  }

  /** The log's size now. */
  size(id: string): number {
    const l = this.live.get(id);
    if (!l) return 0;
    try {
      return statSync(l.c.file).size;
    } catch {
      return 0;
    }
  }
}

const elapsed = (from: string) => {
  const s = Math.round((Date.now() - Date.parse(from)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** How a command is, in one line for the model. */
export function commandLine(c: BackgroundCommand): string {
  const state =
    c.status === "running"
      ? `running for ${elapsed(c.startedAt)}`
      : c.status === "stopped"
        ? "stopped"
        : c.status === "interrupted"
          ? "interrupted"
          : `exited with code ${c.exitCode}`;
  return `${c.id} (${state}): ${c.command.length > 120 ? `${c.command.slice(0, 117)}...` : c.command}`;
}

const OutputInput = z.object({
  id: z.string().min(1).optional(),
  stop: z.boolean().optional(),
  wait_for: z.string().min(1).optional(),
  timeout_s: z.number().int().min(1).max(600).optional(),
  from: z.number().int().min(1).optional(),
  lines: z.number().int().min(1).max(5000).optional(),
  tail: z.boolean().optional(),
  grep: z.string().min(1).optional(),
  stream: z.enum(["out", "err"]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  summary: z.boolean().optional(),
});
export type OutputInput = z.infer<typeof OutputInput>;

/** The answer about one command: its state, what was asked of its log. */
export function describeCommand(
  c: BackgroundCommand,
  log: ParsedLog,
  lines: LogLine[],
  more: number,
  o: { summary?: boolean; waited?: string; plain?: boolean } = {},
): string {
  return [
    commandLine(c),
    `Started ${log.started ?? c.startedAt} in ${c.cwd}, by ${c.by}.${c.endedAt ? ` Ended ${c.endedAt}, exit ${c.exitCode ?? "none"}.` : ""}`,
    o.waited ?? "",
    o.summary ? summarizeLog(log) : "",
    lines.length
      ? `${o.plain ? "New output" : "Output"} (line, [clock +seconds], stream):\n${truncateMiddle(formatLines(lines), 30_000)}`
      : o.plain
        ? "No new output."
        : "No lines match.",
    more > 0 ? `(${more} more lines: ask with from, lines, tail, grep, since or until)` : "",
    `Whole log: ${c.path}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Reads, waits on, or stops a background command started with bash (background: true). */
export function bashOutputTool(
  bg: BackgroundCommands | undefined,
  profile: ModelProfile,
): Tool<z.infer<typeof OutputInput>> {
  return {
    def: {
      name: "bash_output",
      description: describe(profile, {
        full: 'A background command (bash background: true): new output since your last look, every line with its time and stream. from/lines/tail, grep (text or /regex/), stream (out|err), since/until ("+30" seconds from start or "15:04:10"), summary (counts, errors, last activity), wait_for a text up to timeout_s, stop. No id: list.',
        compact: "Read (with times), filter, wait on or stop a background command. No id: list.",
      }),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          stop: { type: "boolean" },
          wait_for: { type: "string" },
          timeout_s: { type: "integer" },
          from: { type: "integer" },
          lines: { type: "integer" },
          tail: { type: "boolean" },
          grep: { type: "string" },
          stream: { type: "string", enum: ["out", "err"] },
          since: { type: "string" },
          until: { type: "string" },
          summary: { type: "boolean" },
        },
      },
    },
    schema: OutputInput,
    async run(i, ctx) {
      if (!bg) return { content: "Background commands are not available here.", isError: true };
      if (!i.id) {
        const mine = bg.list(ctx.sessionId);
        return mine.length
          ? mine.map(commandLine).join("\n")
          : "No background commands in this conversation.";
      }
      const c = bg.get(i.id);
      if (!c || c.sessionId !== ctx.sessionId)
        return {
          content: `There is no background command "${i.id}" in this conversation.`,
          isError: true,
        };
      if (i.stop) await bg.stop(i.id);
      let waited: string | undefined;
      if (i.wait_for && !i.stop) {
        const how = await bg.waitFor(i.id, i.wait_for, (i.timeout_s ?? 60) * 1000, ctx.signal);
        waited =
          how === "found"
            ? `«${i.wait_for}» appeared.`
            : how === "ended"
              ? `It ended before «${i.wait_for}» appeared.`
              : `«${i.wait_for}» did not appear within ${i.timeout_s ?? 60} s.`;
      }
      const q: LogQuery = {
        ...(i.from !== undefined && { from: i.from }),
        ...(i.lines !== undefined && { lines: i.lines }),
        ...(i.tail !== undefined && { tail: i.tail }),
        ...(i.grep && { grep: i.grep }),
        ...(i.stream && { stream: i.stream }),
        ...(i.since && { since: i.since }),
        ...(i.until && { until: i.until }),
      };
      const plain = Object.keys(q).length === 0;
      const r = bg.read(i.id, i.stop ? { tail: true, lines: 40 } : q);
      return describeCommand(c, r.log, r.lines, r.more, {
        ...(i.summary && { summary: true }),
        ...(waited && { waited }),
        plain: plain && !i.stop,
      });
    },
  };
}
