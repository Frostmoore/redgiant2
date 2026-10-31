import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Event, PermissionRequestInfo, ServerMessage } from "@redgiant/protocol";
import { RedGiantClient } from "./client.js";
import { metricsLine } from "./format.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Asks a yes/no question; undefined when there is no terminal (approvals stay pending). */
  confirm?: (question: string) => Promise<boolean>;
  /** Reads the next chat line; undefined ends the chat. */
  readLine?: (prompt: string) => Promise<string | undefined>;
}

const USAGE = `Usage: redgiant <command> [options]

  projects                          list projects
  projects create <name>            create a project
  agents [--project <id>]           list agents
  agents create --kind <k> --name <n> [--parent <id>] [--project <id>]
                [--model provider/model] [--effort low|medium|high|max] [--mode auto|manual|plan|readonly]
  sessions [--agent <id>]           list sessions
  chat <agentId> [--session <id>]   talk to an agent (live)
  send <sessionId> <text>           send one message, print the answer, exit when the agent is done
  approvals                         list pending permission requests
  approve <requestId> | deny <requestId>
  verify                            check the integrity of the event log

Environment: REDGIANT_URL (default http://127.0.0.1:7600), REDGIANT_TOKEN.`;

/** Runs one CLI command; returns the exit code. */
export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  io: CliIo,
): Promise<number> {
  const say = (t: string) => io.out(`${t}\n`);
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    say(USAGE);
    return command ? 0 : 2;
  }
  const token = env.REDGIANT_TOKEN;
  if (!token) {
    io.err("REDGIANT_TOKEN is not set.");
    return 2;
  }
  const client = new RedGiantClient(env.REDGIANT_URL ?? "http://127.0.0.1:7600", token);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      kind: { type: "string" },
      name: { type: "string" },
      parent: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
      session: { type: "string" },
    },
  });

  try {
    switch (command) {
      case "projects": {
        if (positionals[0] === "create") {
          const p = await client.api<{ id: string; path: string }>("POST", "/api/projects", {
            name: positionals.slice(1).join(" "),
          });
          say(`Created project ${p.id} (${p.path})`);
          return 0;
        }
        const list = await client.api<{ id: string; name: string }[]>("GET", "/api/projects");
        for (const p of list) say(`${p.id}\t${p.name}`);
        return 0;
      }
      case "agents": {
        if (positionals[0] === "create") {
          const [provider, ...model] = (values.model ?? "").split("/");
          const a = await client.api<{ id: string }>("POST", "/api/agents", {
            kind: values.kind,
            name: values.name,
            parentId: values.parent ?? null,
            ...(values.project && { projectId: values.project }),
            ...(provider &&
              model.length && {
                model: {
                  provider,
                  model: model.join("/"),
                  ...(values.effort && { effort: values.effort }),
                },
              }),
            ...(values.mode && { mode: values.mode }),
          });
          say(a.id);
          return 0;
        }
        const q = values.project ? `?projectId=${encodeURIComponent(values.project)}` : "";
        const list = await client.api<
          { id: string; kind: string; name: string; projectId: string | null; status: string }[]
        >("GET", `/api/agents${q}`);
        for (const a of list)
          say(`${a.id}\t${a.kind}\t${a.name}\t${a.projectId ?? "-"}\t${a.status}`);
        return 0;
      }
      case "sessions": {
        const q = values.agent ? `?agentId=${encodeURIComponent(values.agent)}` : "";
        const list = await client.api<
          { id: string; agentId: string; running: boolean; createdAt: string }[]
        >("GET", `/api/sessions${q}`);
        for (const s of list)
          say(`${s.id}\t${s.agentId}\t${s.running ? "running" : "idle"}\t${s.createdAt}`);
        return 0;
      }
      case "approvals": {
        for (const r of await client.api<PermissionRequestInfo[]>("GET", "/api/permissions"))
          say(describeRequest(r));
        return 0;
      }
      case "approve":
      case "deny": {
        await client.api("POST", `/api/permissions/${positionals[0]}`, {
          decision: command === "approve" ? "allow" : "deny",
        });
        say(`${command === "approve" ? "Approved" : "Denied"} ${positionals[0]}`);
        return 0;
      }
      case "verify": {
        const r = await client.api<{
          ok: boolean;
          checked?: number;
          seq?: number;
          reason?: string;
        }>("GET", "/api/log/verify");
        say(
          r.ok
            ? `Event log intact (${r.checked} events)`
            : `Event log BROKEN at #${r.seq}: ${r.reason}`,
        );
        return r.ok ? 0 : 1;
      }
      case "send":
        return await converse(client, io, positionals[0] ?? "", [positionals.slice(1).join(" ")]);
      case "chat": {
        const sessionId =
          values.session ??
          (
            await client.api<{ sessionId: string }>("POST", "/api/sessions", {
              agentId: positionals[0],
            })
          ).sessionId;
        say(`Session ${sessionId}. Empty line or Ctrl-D to leave; the agent keeps its history.`);
        return await converse(client, io, sessionId, undefined);
      }
      default:
        io.err(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    io.err((err as Error).message);
    return 1;
  }
}

function describeRequest(r: PermissionRequestInfo): string {
  const input = JSON.stringify(r.input);
  return `${r.requestId}  ${r.agentName} wants ${r.tool} ${input.length > 200 ? `${input.slice(0, 200)}…` : input}\n    because: ${r.reasons.join("; ")}`;
}

/**
 * Follows a session and sends messages: the given ones (then exits when the agent is idle),
 * or lines read from the terminal.
 */
async function converse(
  client: RedGiantClient,
  io: CliIo,
  sessionId: string,
  scripted: string[] | undefined,
): Promise<number> {
  let synced = false;
  let streaming = false;
  let idle: (() => void) | undefined;
  let sawRunning = false;
  const answered = new Set<string>();

  const onMessage = (m: ServerMessage) => {
    switch (m.type) {
      case "session.synced":
        synced = true;
        return;
      case "delta":
        if (m.kind === "text") {
          io.out(m.text);
          streaming = true;
        }
        return;
      case "event": {
        if (!synced) return;
        const e = m.event as Event;
        if (e.type === "message.assistant" && e.payload) {
          if (streaming) io.out("\n");
          streaming = false;
          io.out(`${metricsLine(e.payload.metrics, e.payload.costUsd)}\n`);
        }
        if (e.type === "tool.call" && e.payload)
          io.out(`  ⚙ ${e.payload.tool} ${JSON.stringify(e.payload.input).slice(0, 160)}\n`);
        if (e.type === "tool.result" && e.payload && !e.payload.ok)
          io.out(`  ✗ ${e.payload.output.slice(0, 200)}\n`);
        return;
      }
      case "permission.request": {
        if (answered.has(m.request.requestId)) return;
        answered.add(m.request.requestId);
        io.out(`\n? ${describeRequest(m.request)}\n`);
        if (!io.confirm) {
          io.out("  (no terminal: approve with `redgiant approve` or from the web UI)\n");
          return;
        }
        void io.confirm("  Allow? [y/N] ").then((yes) =>
          live.send({
            type: "permission.resolve",
            requestId: m.request.requestId,
            decision: yes ? "allow" : "deny",
            remember: false,
          }),
        );
        return;
      }
      case "session.state":
        if (m.state === "running") sawRunning = true;
        if (m.state === "idle" && sawRunning) idle?.();
        return;
      case "error":
        io.err(`${m.code}: ${m.message}`);
        return;
    }
  };

  const live = await client.live(onMessage);
  live.send({ type: "session.follow", sessionId });
  const nextIdle = () =>
    new Promise<void>((ok) => {
      idle = ok;
    });

  const lines = scripted ?? [];
  while (true) {
    const text = scripted ? lines.shift() : await io.readLine?.("\n> ");
    if (!text) break;
    sawRunning = false;
    const done = nextIdle();
    live.send({ type: "session.send", sessionId, text });
    await done;
  }
  live.close();
  return 0;
}

export async function terminalIo(): Promise<CliIo> {
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  return {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(`${t}\n`),
    ...(rl && {
      confirm: async (q: string) => /^y(es)?$/i.test((await rl.question(q)).trim()),
      readLine: async (p: string) => {
        try {
          return await rl.question(p);
        } catch {
          return undefined;
        }
      },
    }),
  };
}
