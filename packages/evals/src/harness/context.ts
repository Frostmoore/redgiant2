// What a harness scenario works with: a fresh RedGiant (in-process database, host sandbox),
// God already there, helpers to talk to agents, to wait until every conversation and every
// delegated task has finished, and to read the log.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@redgiant/events";
import type { Event, ModelSpec, PermissionRequestInfo } from "@redgiant/protocol";
import type { ProviderRegistry } from "@redgiant/providers";
import { commitAll, ensureRepo, HostSandboxProvider } from "@redgiant/sandbox";
import { RedGiantCore } from "@redgiant/server";

export type AgentRecord = NonNullable<ReturnType<RedGiantCore["registry"]["get"]>>;

export const OWNER = "eval";
export const HUMAN = { type: "human", ownerId: OWNER } as const;

export async function memoryDb(): Promise<SqlClient> {
  const pg = await PGlite.create();
  type Q = Pick<typeof pg, "query">;
  const wrap = (q: Q, top: boolean): SqlClient => ({
    query: async <T>(text: string, params?: unknown[]) => (await q.query<T>(text, params)).rows,
    transaction: (fn) => (top ? pg.transaction((tx) => fn(wrap(tx, false))) : fn(wrap(q, false))),
  });
  return wrap(pg, true);
}

/** What only a person may allow: the scenario decides (default: denied, nobody is there). */
export type Approver = (info: PermissionRequestInfo) => "allow" | "deny";

export interface ContextOptions {
  providers: ProviderRegistry;
  model: ModelSpec;
  dir: string;
  log: (line: string) => void;
}

export class ScenarioContext {
  core!: RedGiantCore;
  god!: AgentRecord;
  db!: SqlClient;
  approver: Approver = () => "deny";
  readonly approvals: { tool: string; danger: string[]; decision: string }[] = [];

  constructor(readonly o: ContextOptions) {}

  async start(db?: SqlClient): Promise<void> {
    this.db = db ?? (await memoryDb());
    this.core = await RedGiantCore.create({
      db: this.db,
      providers: this.o.providers,
      workspacesDir: join(this.o.dir, "workspaces"),
      platformDir: join(this.o.dir, "platform"),
      sandbox: new HostSandboxProvider(),
      defaultModel: this.o.model,
      // A child's question goes to the person, who is this scenario.
      askAgent: async () => "escalate",
    });
    this.core.approvals.on("request", (owner: string, info: PermissionRequestInfo) => {
      const decision = this.approver(info);
      this.approvals.push({ tool: info.tool, danger: info.danger, decision });
      this.core.approvals.decide(owner, info.requestId, decision);
    });
    const existing = this.core.registry
      .list({ ownerId: OWNER, activeOnly: true })
      .find((a) => a.kind === "god");
    this.god =
      existing ??
      (await this.core.registry.create(HUMAN, { kind: "god", parentId: null, name: "God" }));
  }

  /** The same database and folders, a new program: what a restart does. */
  async restart(): Promise<void> {
    await this.core.close();
    await this.start(this.db);
  }

  async close(): Promise<void> {
    await this.core.close();
  }

  log(line: string): void {
    this.o.log(line);
  }

  /** A project with its orchestrator, and files in it (committed). */
  async project(
    name: string,
    files: Record<string, string> = {},
  ): Promise<{ id: string; path: string; orchestrator: AgentRecord }> {
    const p = await this.core.projects.create(OWNER, name);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(p.path, path)), { recursive: true });
      await writeFile(join(p.path, path), content);
    }
    const orchestrator = await this.core.registry.create(
      { type: "agent", agent: this.god },
      {
        kind: "orchestrator",
        parentId: this.god.id,
        projectId: p.id,
        name: `Lead of ${name}`,
        mode: "auto",
      },
    );
    const { root } = await this.core.projectWorkspaces(orchestrator);
    await ensureRepo(root);
    await commitAll(root, "Starting files");
    return { id: p.id, path: p.path, orchestrator };
  }

  /** A new conversation with an agent, and the first message in it. */
  async say(
    agent: AgentRecord,
    text: string,
  ): Promise<{ sessionId: string; done: Promise<unknown> }> {
    const sessionId = await this.core.startSession(OWNER, agent.id);
    const { done } = await this.core.send(OWNER, sessionId, text, { queue: true });
    return { sessionId, done: done.catch((err) => ({ error: (err as Error).message })) };
  }

  /** Another message in a conversation (queued if it is busy). */
  async follow(sessionId: string, text: string): Promise<Promise<unknown>> {
    const { done } = await this.core.send(OWNER, sessionId, text, { queue: true });
    return done.catch((err) => ({ error: (err as Error).message }));
  }

  async events(): Promise<Event[]> {
    return this.core.store.list({});
  }

  /**
   * Until no conversation works and no delegated task is open, seen twice in a row a few
   * seconds apart (a closing task wakes the one that gave it). False on timeout.
   */
  async settle(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < until) {
      const busy = this.core.busySessions().length > 0;
      const open = busy ? 1 : await this.openTasks();
      quiet = !busy && open === 0 ? quiet + 1 : 0;
      if (quiet >= 2) return true;
      await new Promise((ok) => setTimeout(ok, 3000));
    }
    return false;
  }

  async openTasks(): Promise<number> {
    const open = new Set<string>();
    for (const e of await this.core.store.list({ types: ["task.opened", "task.closed"] })) {
      if (!e.payload) continue;
      if (e.type === "task.opened") open.add(e.payload.taskId);
      if (e.type === "task.closed") open.delete(e.payload.taskId);
    }
    return open.size;
  }

  /** Stops everything still running (a scenario out of time). */
  async interruptAll(): Promise<void> {
    for (const s of this.core.busySessions()) await this.core.interrupt(OWNER, s).catch(() => {});
  }

  async spentUsd(): Promise<number> {
    return (await this.core.budget.used({ scope: "global", id: OWNER })).usd;
  }
}

/** A hidden check, run in a folder after the agents finished: exit code 0 passes. */
export function runCheck(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim().slice(-1500) }),
    ),
  );
}
