import * as acp from "@agentclientprotocol/sdk";
import type { AcpProcess } from "../src/index.js";

/** Two in-process pipes, as a child process's stdin and stdout would be. */
export function stdioPair() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: { input: toAgent.writable, output: toClient.readable },
    agent: acp.ndJsonStream(toClient.writable, toAgent.readable),
  };
}

/** One step of the fake agent's turn. */
export type Step =
  | { say: string }
  | { think: string }
  | {
      tool: string;
      kind?: acp.ToolKind;
      title?: string;
      rawInput?: Record<string, unknown>;
      path?: string;
    }
  | { done: string; status?: "completed" | "failed"; output?: string }
  | {
      ask: string;
      kind?: acp.ToolKind;
      title?: string;
      rawInput?: Record<string, unknown>;
      path?: string;
    }
  | { read: string; line?: number; limit?: number }
  | { write: string; content: string }
  | { terminal: string; args?: string[]; cwd?: string }
  /** Waits until the turn is cancelled (or forever). */
  | { hang: true };

export interface FakeAgent {
  /** What happened, in order, for the test to read. */
  seen: string[];
  /** The prompts it received, by session. */
  prompts: { sessionId: string; text: string }[];
  /** Sessions it created and loaded. */
  created: string[];
  loaded: string[];
  /** The script of the next turn (set by the test before each prompt). */
  script: Step[];
  process: AcpProcess;
  /** Answers to its permission requests and file requests, as the client gave them. */
  answers: unknown[];
  kills: number;
}

/**
 * A fake ACP agent on in-process stdio: it answers `initialize` and `session/new|load`, and each
 * prompt plays the script the test set, calling back into the client (permissions, files,
 * terminals) like a real agent would. Never a real model, never a real program.
 */
export function fakeAgent(o: { loadSession?: boolean; cwd?: string } = {}): FakeAgent {
  const pipes = stdioPair();
  let exit!: (code: number | null) => void;
  const exited = new Promise<number | null>((ok) => {
    exit = ok;
  });
  const f: FakeAgent = {
    seen: [],
    prompts: [],
    created: [],
    loaded: [],
    script: [],
    answers: [],
    kills: 0,
    process: {
      ...pipes.client,
      cwd: o.cwd ?? "/work/project",
      kill: () => {
        f.kills++;
        exit(null);
      },
      exited,
    },
  };
  const cancels = new Map<string, AbortController>();
  let n = 0;
  acp
    .agent({ name: "fake-agent" })
    .onRequest("initialize", (ctx) => {
      f.seen.push(
        `initialize fs=${ctx.params.clientCapabilities?.fs?.readTextFile} terminal=${ctx.params.clientCapabilities?.terminal}`,
      );
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: o.loadSession ?? false },
        agentInfo: { name: "fake-agent", version: "1.0.0" },
        authMethods: [],
      };
    })
    .onRequest("session/new", (ctx) => {
      const id = `fake_${++n}`;
      f.created.push(id);
      f.seen.push(`new ${ctx.params.cwd}`);
      return { sessionId: id };
    })
    .onRequest("session/load", async (ctx) => {
      f.loaded.push(ctx.params.sessionId);
      f.seen.push(`load ${ctx.params.sessionId}`);
      // The replay: the client must not record it again.
      await ctx.client.notify("session/update", {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD" } },
      });
      return {};
    })
    .onNotification("session/cancel", (ctx) => {
      f.seen.push(`cancel ${ctx.params.sessionId}`);
      cancels.get(ctx.params.sessionId)?.abort();
    })
    .onRequest("session/prompt", async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      f.prompts.push({ sessionId, text });
      const stop = new AbortController();
      cancels.set(sessionId, stop);
      const up = (u: acp.SessionUpdate) =>
        ctx.client.notify("session/update", { sessionId, update: u });
      const script = f.script;
      f.script = [];
      for (const s of script) {
        if (stop.signal.aborted) break;
        if ("say" in s)
          await up({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: s.say },
          });
        else if ("think" in s)
          await up({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: s.think },
          });
        else if ("tool" in s)
          await up({
            sessionUpdate: "tool_call",
            toolCallId: s.tool,
            title: s.title ?? s.tool,
            kind: s.kind ?? "other",
            status: "pending",
            ...(s.rawInput && { rawInput: s.rawInput }),
            ...(s.path && { locations: [{ path: s.path }] }),
          });
        else if ("done" in s)
          await up({
            sessionUpdate: "tool_call_update",
            toolCallId: s.done,
            status: s.status ?? "completed",
            content: [{ type: "content", content: { type: "text", text: s.output ?? "ok" } }],
          });
        else if ("ask" in s) {
          const r = await ctx.client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: s.ask,
              ...(s.title && { title: s.title }),
              ...(s.kind && { kind: s.kind }),
              ...(s.rawInput && { rawInput: s.rawInput }),
              ...(s.path && { locations: [{ path: s.path }] }),
            },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          f.answers.push(r.outcome);
          f.seen.push(
            `permission ${s.ask} ${r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled"}`,
          );
        } else if ("read" in s) {
          try {
            const r = await ctx.client.request("fs/read_text_file", {
              sessionId,
              path: s.read,
              ...(s.line && { line: s.line }),
              ...(s.limit && { limit: s.limit }),
            });
            f.answers.push(r.content);
            f.seen.push(`read ${s.read} ok`);
          } catch (err) {
            f.answers.push((err as Error).message);
            f.seen.push(`read ${s.read} refused`);
          }
        } else if ("write" in s) {
          try {
            await ctx.client.request("fs/write_text_file", {
              sessionId,
              path: s.write,
              content: s.content,
            });
            f.seen.push(`write ${s.write} ok`);
          } catch (err) {
            f.answers.push((err as Error).message);
            f.seen.push(`write ${s.write} refused`);
          }
        } else if ("terminal" in s) {
          try {
            const t = await ctx.client.request("terminal/create", {
              sessionId,
              command: s.terminal,
              args: s.args ?? [],
              ...(s.cwd && { cwd: s.cwd }),
              outputByteLimit: 1000,
            });
            const exit = await ctx.client.request("terminal/wait_for_exit", {
              sessionId,
              terminalId: t.terminalId,
            });
            const out = await ctx.client.request("terminal/output", {
              sessionId,
              terminalId: t.terminalId,
            });
            await ctx.client.request("terminal/release", { sessionId, terminalId: t.terminalId });
            f.answers.push({ exit, output: out.output });
            f.seen.push(`terminal ${s.terminal} exit ${exit.exitCode}`);
          } catch (err) {
            f.answers.push((err as Error).message);
            f.seen.push(`terminal ${s.terminal} refused`);
          }
        } else if ("hang" in s) {
          await new Promise<void>((ok) =>
            stop.signal.addEventListener("abort", () => ok(), { once: true }),
          );
        }
      }
      cancels.delete(sessionId);
      return { stopReason: stop.signal.aborted ? "cancelled" : "end_turn" };
    })
    .connect(pipes.agent);
  return f;
}
