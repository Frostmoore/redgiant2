// External ACP agents as workers (G38.6): Claude Code through its adapter, Codex, Gemini CLI… An
// agent of a project whose turns run in that program (`AcpEngine`), launched in the agent's own
// folder (its worktree, in its sandbox) with an environment without secrets. Everything it asks
// goes through RedGiant: its permission requests to the broker (never a yes by the rules alone),
// its files and terminals only inside its folder, checked by the guardian like RedGiant's tools.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpProcess, AcpWorkerHost } from "@redgiant/acp";
import type { SqlClient } from "@redgiant/events";
import type { AgentRecord, PermissionBroker } from "@redgiant/hierarchy";
import { type AcpWorkerConfig, AcpWorkers, acpEnvProblem } from "@redgiant/protocol";
import { LocalWorkspace, type SpawnedProcess, type Workspace } from "@redgiant/tools";
import { OwnerSettings } from "./person-requests.js";

export class AcpWorkerError extends Error {}

/** What is wrong with an external agent's settings, if anything (its variables above all). */
export function acpConfigProblem(c: AcpWorkerConfig): string | undefined {
  for (const [k, v] of Object.entries(c.env)) {
    const p = acpEnvProblem(k, v);
    if (p) return p;
  }
  return undefined;
}

/** The person's external agents (`rg_settings` key `acp_workers`, by agent id). */
export class AcpWorkerStore {
  private readonly settings: OwnerSettings<AcpWorkers>;

  constructor(db: SqlClient) {
    this.settings = new OwnerSettings(db, "acp_workers", AcpWorkers, {});
  }

  load(): Promise<void> {
    return this.settings.load();
  }

  all(ownerId: string): AcpWorkers {
    return this.settings.get(ownerId);
  }

  get(ownerId: string, agentId: string): AcpWorkerConfig | undefined {
    return this.settings.get(ownerId)[agentId];
  }

  async set(ownerId: string, agentId: string, raw: unknown): Promise<AcpWorkerConfig> {
    const parsed = AcpWorkers.safeParse({ [agentId]: raw });
    if (!parsed.success) throw new AcpWorkerError("Give the command, its arguments and variables");
    const c = parsed.data[agentId] as AcpWorkerConfig;
    const problem = acpConfigProblem(c);
    if (problem) throw new AcpWorkerError(problem);
    await this.settings.set(ownerId, { ...this.settings.get(ownerId), [agentId]: c });
    return c;
  }

  async remove(ownerId: string, agentId: string): Promise<void> {
    const { [agentId]: _gone, ...rest } = this.settings.get(ownerId);
    await this.settings.set(ownerId, rest);
  }
}

/** Node streams of a spawned program as the web streams the ACP library reads. */
export function processStreams(p: SpawnedProcess, log?: (line: string) => void): AcpProcess {
  let tail = "";
  p.stderr.on("data", (d: Buffer | string) => {
    const lines = (tail + d.toString()).split("\n");
    tail = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) log?.(l.slice(0, 500));
  });
  return {
    input: Writable.toWeb(p.stdin as unknown as Writable) as unknown as WritableStream<Uint8Array>,
    output: Readable.toWeb(
      p.stdout as unknown as Readable,
    ) as unknown as ReadableStream<Uint8Array>,
    cwd: p.cwd,
    kill: () => p.kill(),
    exited: p.exited,
  };
}

/** Starts the program in a workspace: its own folder, `agentEnv()` plus the person's variables. */
async function launchIn(ws: Workspace, c: AcpWorkerConfig, log?: (line: string) => void) {
  if (!ws.spawn) throw new AcpWorkerError("This agent's sandbox cannot start programs");
  // Checked again here: the stored settings may predate a stricter rule.
  const problem = acpConfigProblem(c);
  if (problem) throw new AcpWorkerError(problem);
  const p = await ws.spawn(c.command, c.args, { env: c.env });
  return processStreams(p, log);
}

/**
 * What RedGiant serves one external agent's conversation (G38.6): files of its folder, commands
 * run with `execFile` (no shell), and every action through the broker with the agent's identity.
 */
export function acpWorkerHost(o: {
  ws: Workspace;
  agent: AgentRecord;
  sessionId: string;
  broker: PermissionBroker;
  config: () => AcpWorkerConfig;
  log?: (line: string) => void;
}): AcpWorkerHost {
  return {
    launch: () => launchIn(o.ws, o.config(), o.log),
    readText: (rel) => o.ws.readText(rel),
    writeText: (rel, content) => o.ws.writeText(rel, content),
    permit: (call, { ask, signal }) =>
      o.broker.check(o.agent, call, o.sessionId, { ask, ...(signal && { signal }) }),
    run: async (file, args, { cwd, env, signal, onOutput }) => {
      const r = await o.ws.execFile(file, args, {
        timeoutMs: Number.POSITIVE_INFINITY,
        signal,
        cwd,
        ...(env && Object.keys(env).length > 0 && { env }),
        onOutput: (text) => onOutput(text),
      });
      return { exitCode: r.exitCode };
    },
    ...(o.log && { log: o.log }),
  };
}

/**
 * Tries an external agent's command (Settings › External agents, «Try»): started in an empty
 * folder of its own, never in a project, asked who it is, then closed. Nothing else happens.
 */
export async function probeAcp(
  c: AcpWorkerConfig,
  timeoutMs = 120_000,
): Promise<{ name: string; version?: string; loadSession: boolean; signIn: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "rg-acp-try-"));
  const errors: string[] = [];
  let proc: AcpProcess | undefined;
  try {
    proc = await launchIn(new LocalWorkspace(dir), c, (l) => errors.push(l));
    const conn = acp
      .client({ name: "redgiant" })
      .connect(acp.ndJsonStream(proc.input, proc.output));
    const ended = proc.exited.then((code) => {
      throw new AcpWorkerError(
        `The program ended (exit ${code ?? "?"})${errors.length ? `: ${errors.slice(-3).join(" / ")}` : ""}`,
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_ok, ko) => {
      timer = setTimeout(
        () => ko(new AcpWorkerError("The program did not answer in time")),
        timeoutMs,
      );
    });
    try {
      const init = await Promise.race([
        conn.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: "redgiant", title: "RedGiant", version: "3" },
        }),
        ended,
        late,
      ]);
      return {
        name: init.agentInfo?.title ?? init.agentInfo?.name ?? c.command,
        ...(init.agentInfo?.version && { version: init.agentInfo.version }),
        loadSession: init.agentCapabilities?.loadSession === true,
        signIn: (init.authMethods ?? []).map((m) => m.name),
      };
    } finally {
      clearTimeout(timer);
      conn.close();
    }
  } catch (err) {
    if (err instanceof AcpWorkerError) throw err;
    throw new AcpWorkerError(
      `It did not start: ${(err as Error).message}${errors.length ? ` (${errors.slice(-3).join(" / ")})` : ""}`,
    );
  } finally {
    proc?.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
