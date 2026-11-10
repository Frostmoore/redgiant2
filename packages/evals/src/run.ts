import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SqlClient } from "@redgiant/events";
import type { ModelSpec } from "@redgiant/protocol";
import type { ProviderRegistry } from "@redgiant/providers";
import { commitAll, ensureRepo, HostSandboxProvider } from "@redgiant/sandbox";
import { RedGiantCore } from "@redgiant/server";
import { commandLine } from "./python.js";
import { type EvalTask, TASKS } from "./tasks.js";

export interface EvalOptions {
  providers: ProviderRegistry;
  models: ModelSpec[];
  tasks?: EvalTask[];
  /** Each model gets its own folder here (projects, God's platform). */
  workDir: string;
  /** Per task (default 15 minutes): the orchestrator is interrupted after this. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface EvalResult {
  model: string;
  task: string;
  passed: boolean;
  /** The verifier's output, or why the run failed. */
  detail: string;
  usd: number;
  tokens: number;
  seconds: number;
  stopReason: string;
}

const OWNER = "eval";
export const modelName = (m: ModelSpec) =>
  `${m.provider}/${m.model}${m.effort ? ` (${m.effort})` : ""}`;

async function memoryDb(): Promise<SqlClient> {
  const pg = await PGlite.create();
  type Q = Pick<typeof pg, "query">;
  const wrap = (q: Q, top: boolean): SqlClient => ({
    query: async <T>(text: string, params?: unknown[]) => (await q.query<T>(text, params)).rows,
    transaction: (fn) => (top ? pg.transaction((tx) => fn(wrap(tx, false))) : fn(wrap(q, false))),
  });
  return wrap(pg, true);
}

function verify(cwd: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    try {
      [cmd, args] = commandLine(command);
    } catch (e) {
      resolve({ ok: false, output: (e as Error).message });
      return;
    }
    execFile(cmd, args, { cwd, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim().slice(-2000) }),
    );
  });
}

/**
 * Runs every task with every model: a fresh RedGiant per model (in-process database, host
 * sandbox), one project per task with its own orchestrator, then the hidden verifier.
 */
export async function runEvals(o: EvalOptions): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  const log = o.log ?? (() => {});
  for (const model of o.models) {
    const dir = join(o.workDir, modelName(model).replace(/[^a-zA-Z0-9.-]+/g, "_"));
    const core = await RedGiantCore.create({
      db: await memoryDb(),
      providers: o.providers,
      workspacesDir: join(dir, "workspaces"),
      platformDir: join(dir, "platform"),
      sandbox: new HostSandboxProvider(),
      defaultModel: model,
    });
    // Nobody is there to approve: what only a human may allow is denied.
    core.approvals.on("request", (owner, info) =>
      core.approvals.decide(owner, info.requestId, "deny"),
    );
    const god = await core.registry.create(
      { type: "human", ownerId: OWNER },
      { kind: "god", parentId: null, name: "God" },
    );
    try {
      for (const task of o.tasks ?? TASKS) {
        log(`${modelName(model)} · ${task.id}`);
        const started = Date.now();
        const project = await core.projects.create(OWNER, task.id);
        for (const [path, content] of Object.entries(task.files)) {
          await mkdir(dirname(join(project.path, path)), { recursive: true });
          await writeFile(join(project.path, path), content);
        }
        const orch = await core.registry.create(
          { type: "agent", agent: god },
          {
            kind: "orchestrator",
            parentId: god.id,
            projectId: project.id,
            name: "Orchestrator",
            mode: "auto",
          },
        );
        const { root } = await core.projectWorkspaces(orch);
        await ensureRepo(root);
        await commitAll(root, "Task files");
        const sid = await core.startSession(OWNER, orch.id);
        const { done } = await core.send(
          OWNER,
          sid,
          `${task.prompt}\n\nThe files are in this project's workspace. When the work is done and checked, reply with a one-line summary.`,
        );
        const timer = setTimeout(() => void core.interrupt(OWNER, sid), o.timeoutMs ?? 15 * 60_000);
        let stopReason = "error";
        try {
          stopReason = (await done).stopReason;
        } catch (err) {
          stopReason = `error: ${(err as Error).message}`;
        } finally {
          clearTimeout(timer);
        }
        await writeFile(join(project.path, task.verifier.file), task.verifier.content);
        const v = await verify(project.path, task.verifier.command);
        const used = await core.budget.used({ scope: "project", id: project.id });
        const r: EvalResult = {
          model: modelName(model),
          task: task.id,
          passed: v.ok,
          detail: v.output,
          usd: used.usd,
          tokens: used.tokens,
          seconds: Math.round((Date.now() - started) / 1000),
          stopReason,
        };
        log(`  ${r.passed ? "passed" : "FAILED"} in ${r.seconds} s, $${r.usd.toFixed(3)}`);
        results.push(r);
      }
    } finally {
      await core.close();
    }
  }
  return results;
}

/** The results as Markdown: one row per task, one column per model, totals at the bottom. */
export function report(
  results: EvalResult[],
  meta: { date: string; version: string; tasks?: EvalTask[] },
): string {
  const models = [...new Set(results.map((r) => r.model))];
  const tasks = meta.tasks ?? TASKS;
  const cell = (m: string, t: string) => {
    const r = results.find((x) => x.model === m && x.task === t);
    return r ? `${r.passed ? "✅" : "❌"} ${r.seconds} s · $${r.usd.toFixed(3)}` : "—";
  };
  const total = (m: string) => {
    const rs = results.filter((r) => r.model === m);
    const usd = rs.reduce((a, r) => a + r.usd, 0);
    const tok = rs.reduce((a, r) => a + r.tokens, 0);
    const min = rs.reduce((a, r) => a + r.seconds, 0) / 60;
    return `**${rs.filter((r) => r.passed).length}/${rs.length}** · $${usd.toFixed(2)} · ${Math.round(tok / 1000)}k tokens · ${min.toFixed(1)} min`;
  };
  const lines = [
    "# Evaluations",
    "",
    `RedGiant ${meta.version}, ${meta.date}. Each task runs in a fresh project with its own orchestrator`,
    "(permission mode `auto`; requests that only a human may approve are denied). The verifier is",
    "written after the agents finish and decides alone. Cost and tokens are the project's budget.",
    "Run them yourself: `pnpm --filter @redgiant/evals start -- --models provider/model,…`.",
    "",
    `| Task | ${models.join(" | ")} |`,
    `|---|${models.map(() => "---").join("|")}|`,
    ...tasks.map((t) => `| ${t.title} | ${models.map((m) => cell(m, t.id)).join(" | ")} |`),
    `| **Total** | ${models.map(total).join(" | ")} |`,
    "",
    "## Tasks",
    "",
    ...tasks.map((t) => `- **${t.title}** (\`${t.id}\`): ${t.prompt.split("\n")[0]}`),
    "",
  ];
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("## Failures", "");
    for (const f of failed)
      lines.push(
        `- ${f.model} · \`${f.task}\` (stopped: ${f.stopReason}): ${f.detail.split("\n").slice(-3).join(" ").slice(0, 300) || "no output"}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}
