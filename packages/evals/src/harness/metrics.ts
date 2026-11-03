// What a run says about the harness, read from its event log alone (the log is the source of
// truth): cache reuse, tool calls left without a result, errors that come from the program and
// not from the model, delegated tasks left open, spend. The same numbers for every scenario.
import type { Event } from "@redgiant/protocol";

export interface HarnessMetrics {
  /** Model requests, and how many conversations made them. */
  calls: number;
  sessions: number;
  inputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  usd: number;
  /** Cached share of the input of every request after a conversation's first one. */
  cacheReuse: number;
  /** The harness noticed a cache it expected and did not get (`cache.missed`). */
  cacheMisses: number;
  /** Largest request, in tokens: tool output that is not cut would show here. */
  maxContext: number;
  toolCalls: number;
  /** Results with `ok: false`, all causes. */
  toolErrors: number;
  /** Failures that point at the program (exceptions, missing functions): each one is a bug. */
  harnessErrors: { tool: string; output: string }[];
  /** Calls with no result in the log. */
  orphanCalls: number;
  tasksOpened: number;
  tasksVerified: number;
  tasksClosed: number;
  tasksAbandoned: number;
  /** Opened and never closed. */
  tasksOpen: number;
  /** Most tasks open at the same time (delegation in parallel). */
  maxParallelTasks: number;
  hookBlocks: number;
  permissionDenials: number;
  compactions: number;
  /** Turns that ended for these reasons (session.ended, by reason). */
  ended: Record<string, number>;
  /** Tool calls per tool name. */
  tools: Record<string, number>;
}

/** Messages a program error leaves, not a model's mistake. */
const PROGRAM_ERROR =
  /\b(TypeError|ReferenceError|RangeError|SyntaxError: Unexpected|is not a function|Cannot read propert|Cannot destructure|undefined is not|Maximum call stack|ECONNREFUSED|Internal error|unhandled)\b/i;

export const isProgramError = (output: string) => PROGRAM_ERROR.test(output);

export function harnessMetrics(events: readonly Event[]): HarnessMetrics {
  const m: HarnessMetrics = {
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    usd: 0,
    cacheReuse: 0,
    cacheMisses: 0,
    maxContext: 0,
    toolCalls: 0,
    toolErrors: 0,
    harnessErrors: [],
    orphanCalls: 0,
    tasksOpened: 0,
    tasksVerified: 0,
    tasksClosed: 0,
    tasksAbandoned: 0,
    tasksOpen: 0,
    maxParallelTasks: 0,
    hookBlocks: 0,
    permissionDenials: 0,
    compactions: 0,
    ended: {},
    tools: {},
  };
  const firstSeen = new Set<string>();
  let laterInput = 0;
  let laterCached = 0;
  const calls = new Map<string, string>();
  const open = new Set<string>();
  for (const e of events) {
    if (e.payload === null) continue;
    switch (e.type) {
      case "message.assistant": {
        const u = e.payload.metrics;
        m.calls++;
        m.inputTokens += u.inputTokens;
        m.cachedReadTokens += u.cachedReadTokens;
        m.cacheWriteTokens += u.cacheWriteTokens;
        m.outputTokens += u.outputTokens;
        m.usd += e.payload.costUsd;
        m.maxContext = Math.max(m.maxContext, u.inputTokens);
        const s = e.sessionId ?? "";
        if (firstSeen.has(s)) {
          laterInput += u.inputTokens;
          laterCached += u.cachedReadTokens;
        } else firstSeen.add(s);
        break;
      }
      case "cache.missed":
        m.cacheMisses++;
        break;
      case "tool.call":
        m.toolCalls++;
        m.tools[e.payload.tool] = (m.tools[e.payload.tool] ?? 0) + 1;
        calls.set(e.payload.callId, e.payload.tool);
        break;
      case "tool.result": {
        const tool = calls.get(e.payload.callId) ?? "?";
        calls.delete(e.payload.callId);
        if (!e.payload.ok) {
          m.toolErrors++;
          if (isProgramError(e.payload.output))
            m.harnessErrors.push({ tool, output: e.payload.output.slice(0, 300) });
        }
        break;
      }
      case "task.opened":
        m.tasksOpened++;
        open.add(e.payload.taskId);
        m.maxParallelTasks = Math.max(m.maxParallelTasks, open.size);
        break;
      case "task.verified":
        if (e.payload.passed) m.tasksVerified++;
        break;
      case "task.closed":
        m.tasksClosed++;
        if ("outcome" in e.payload && e.payload.outcome === "abandoned") m.tasksAbandoned++;
        open.delete(e.payload.taskId);
        break;
      case "hook.blocked":
        m.hookBlocks++;
        break;
      case "permission.resolved":
        if (e.payload.decision === "deny") m.permissionDenials++;
        break;
      case "compaction":
        m.compactions++;
        break;
      case "session.ended":
        m.ended[e.payload.reason] = (m.ended[e.payload.reason] ?? 0) + 1;
        break;
    }
  }
  m.sessions = firstSeen.size;
  m.orphanCalls = calls.size;
  m.tasksOpen = open.size;
  m.cacheReuse = laterInput > 0 ? laterCached / laterInput : 1;
  return m;
}

/** Text the agents produced or received: where a secret must never appear. */
export function visibleText(events: readonly Event[]): string {
  const out: string[] = [];
  for (const e of events) {
    if (e.payload === null) continue;
    if (e.type === "tool.result") out.push(e.payload.output);
    if (e.type === "message.assistant")
      for (const p of e.payload.parts) if (p.type === "text") out.push(p.text);
  }
  return out.join("\n");
}

/** The calls of one tool, with their inputs and results. */
export function callsOf(
  events: readonly Event[],
  tool: string | RegExp,
): {
  input: unknown;
  ok: boolean | undefined;
  output: string;
  agentId: string | null;
  at: string;
}[] {
  const res = new Map<string, { ok: boolean; output: string }>();
  for (const e of events)
    if (e.type === "tool.result" && e.payload) res.set(e.payload.callId, e.payload);
  return events.flatMap((e) =>
    e.type === "tool.call" &&
    e.payload &&
    (typeof tool === "string" ? e.payload.tool === tool : tool.test(e.payload.tool))
      ? [
          {
            input: e.payload.input,
            ok: res.get(e.payload.callId)?.ok,
            output: res.get(e.payload.callId)?.output ?? "",
            agentId: e.agentId,
            at: e.ts,
          },
        ]
      : [],
  );
}
