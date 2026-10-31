import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "@redgiant/agent";
import type { AgentRecord } from "@redgiant/hierarchy";
import { type ReleaseRequest, readRelease, requestFile, writeJson } from "@redgiant/supervisor";
import { z } from "zod";
import type { PlatformChange, PlatformChanges } from "./platform.js";

const exec = promisify(execFile);

export interface SourceOptions {
  /** RedGiant's own source: a git repository checked out on the live branch. */
  dir: string;
  /** Shared with the supervisor (release.json, request.json). */
  stateDir: string;
  /** Run in order in the change's worktree; default install, build, test. */
  steps?: { name: string; command: string; timeoutMs?: number }[];
  /** The trial copy started from the worktree; default the built server on a free port. */
  canary?: {
    command: string;
    args: string[];
    /** Extra environment; REDGIANT_PORT and REDGIANT_TOKEN are always set. */
    env?: Record<string, string>;
    healthPath?: string;
    /** An authenticated GET that must answer 200 (default /api/agents). */
    smokePath?: string;
    timeoutMs?: number;
  };
  /** Restarts onto the promoted code; set only when a supervisor runs the server. */
  restart?: () => void;
}

const DEFAULT_STEPS = [
  { name: "install", command: "pnpm install --frozen-lockfile", timeoutMs: 600_000 },
  { name: "build", command: "pnpm build", timeoutMs: 600_000 },
  { name: "test", command: "pnpm test", timeoutMs: 1_200_000 },
];

/**
 * Commands run with a clean environment: the code under test is God's and must not see the
 * server's secrets (API keys, the Telegram token…).
 */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const keep = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "LANG", "PNPM_HOME"];
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
};

const tail = (s: string, n = 3000) => (s.length > n ? `…${s.slice(-n)}` : s);

function sh(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(command, { cwd, shell: true, env: cleanEnv() });
    let output = "";
    const add = (d: Buffer) => {
      output += d;
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    p.stdout?.on("data", add);
    p.stderr?.on("data", add);
    const timer = setTimeout(() => {
      output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`;
      p.kill("SIGKILL");
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    p.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
  });
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

interface CodeState {
  branch: string;
  path: string;
  commit?: string;
  passed?: boolean;
  /** The live-branch commit the change was merged as, waiting for the supervisor's verdict. */
  promoted?: string;
  /** God's session that promoted it: the restart cuts that turn, God picks it up afterwards. */
  sessionId?: string;
}

export class CodeChangeError extends Error {}

/**
 * Changes to RedGiant's own code (G14.2): a worktree where God works, a trial (build, tests,
 * a trial copy that must come up healthy), then promotion through the supervisor, which rolls
 * back by itself if the new version does not come up.
 */
export class CodeChanges {
  constructor(
    private readonly o: SourceOptions,
    private readonly changes: PlatformChanges,
    /** God's workspace on the host: worktrees go under `changes/`. */
    private readonly workspace: (ownerId: string) => string,
    private readonly notify: (ownerId: string, text: string) => Promise<void>,
    /** Hands God the outcome in the session that promoted the change (its turn was cut). */
    private readonly resume?: (ownerId: string, sessionId: string, text: string) => Promise<void>,
  ) {}

  get supervised(): boolean {
    return this.o.restart !== undefined;
  }

  private git(cwd: string, ...args: string[]) {
    return exec("git", ["-c", "user.name=God", "-c", "user.email=god@redgiant", ...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    }).then((r) => r.stdout.trim());
  }

  private async load(ownerId: string, id: string): Promise<{ c: PlatformChange; s: CodeState }> {
    const c = await this.changes.get(ownerId, id);
    if (c?.kind !== "code") throw new CodeChangeError(`Unknown code change "${id}"`);
    return { c, s: c.after as CodeState };
  }

  async start(ownerId: string, by: string, title: string) {
    const ws = this.workspace(ownerId);
    const pending = (await this.changes.list(ownerId)).filter(
      (c) => c.kind === "code" && ["proposed", "tested", "failed", "rolled_back"].includes(c.stage),
    );
    if (pending.length >= 3)
      throw new CodeChangeError(
        `Already ${pending.length} code changes open (${pending.map((c) => c.id).join(", ")}): finish or discard one first`,
      );
    const id = `chg_${randomBytes(6).toString("hex")}`;
    const branch = `rg/change-${id.slice(4)}`;
    const path = join(ws, "changes", id);
    await mkdir(join(ws, "changes"), { recursive: true });
    await this.git(this.o.dir, "worktree", "add", "-q", "-b", branch, path, "HEAD");
    const base = await this.git(path, "rev-parse", "HEAD");
    const c = await this.changes.record(ownerId, {
      id,
      kind: "code",
      change: title,
      stage: "proposed",
      target: `code:${branch}`,
      before: { commit: base },
      after: { branch, path } satisfies CodeState,
      by,
    });
    return { change: c, dir: relative(ws, path).split("\\").join("/") };
  }

  /** Commits the worktree, runs the steps, starts a trial copy; the result is recorded. */
  async test(ownerId: string, by: string, id: string) {
    const { c, s } = await this.load(ownerId, id);
    if (!["proposed", "tested", "failed", "rolled_back"].includes(c.stage))
      throw new CodeChangeError(`Change ${id} is ${c.stage}`);
    await this.git(s.path, "add", "-A");
    const dirty = await this.git(s.path, "status", "--porcelain");
    if (dirty) await this.git(s.path, "commit", "-q", "-m", c.change);
    const commit = await this.git(s.path, "rev-parse", "HEAD");
    if (commit === (c.before as { commit: string }).commit)
      throw new CodeChangeError(
        "Nothing changed yet: edit the files in the change's directory first",
      );

    const report: string[] = [];
    let passed = true;
    for (const step of this.o.steps ?? DEFAULT_STEPS) {
      const r = await sh(step.command, s.path, step.timeoutMs ?? 600_000);
      report.push(`## ${step.name}: ${r.ok ? "ok" : "FAILED"}${r.ok ? "" : `\n${tail(r.output)}`}`);
      if (!r.ok) {
        passed = false;
        break;
      }
    }
    if (passed) {
      const r = await this.canary(s.path);
      report.push(
        `## trial copy: ${r.ok ? "healthy" : "FAILED"}${r.ok ? "" : `\n${tail(r.output)}`}`,
      );
      passed = r.ok;
    }
    const detail = report.join("\n");
    const recorded = await this.changes.record(ownerId, {
      id,
      kind: "code",
      change: c.change,
      stage: passed ? "tested" : "failed",
      after: { ...s, commit, passed } satisfies CodeState,
      detail,
      by,
    });
    return { change: recorded, passed, detail };
  }

  /** Starts the built server from the worktree, with a throwaway database, and checks it. */
  private async canary(cwd: string): Promise<{ ok: boolean; output: string }> {
    const cfg = this.o.canary ?? {
      command: process.execPath,
      args: ["packages/server/dist/main.js"],
    };
    const port = await freePort();
    const token = randomBytes(18).toString("hex");
    const data = await mkdtemp(join(tmpdir(), "rg-trial-"));
    const p = spawn(cfg.command, cfg.args, {
      cwd,
      env: {
        ...cleanEnv(),
        DATABASE_URL: "memory:",
        REDGIANT_DATA_DIR: data,
        REDGIANT_HOST: "127.0.0.1",
        ...cfg.env,
        REDGIANT_PORT: String(port),
        REDGIANT_TOKEN: token,
      },
    });
    let output = "";
    p.stdout?.on("data", (d) => {
      output += d;
    });
    p.stderr?.on("data", (d) => {
      output += d;
    });
    let exited = false;
    p.on("exit", () => {
      exited = true;
    });
    p.on("error", (err) => {
      exited = true;
      output += err.message;
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (cfg.timeoutMs ?? 60_000);
    try {
      while (Date.now() < deadline && !exited) {
        const health = await fetch(`${base}${cfg.healthPath ?? "/api/health"}`, {
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined);
        if (health?.ok) {
          const smoke = await fetch(`${base}${cfg.smokePath ?? "/api/agents"}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          }).catch((err: Error) => ({ ok: false, status: err.message }) as const);
          return smoke.ok
            ? { ok: true, output }
            : { ok: false, output: `${output}\nsmoke check answered ${smoke.status}` };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return {
        ok: false,
        output: `${output}\n${exited ? "the trial copy exited" : "no answer to the health check"}`,
      };
    } finally {
      p.kill("SIGKILL");
      await rm(data, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Merges a tested change into the live branch and asks the supervisor to restart on it.
   * The supervisor rolls it back by itself if it does not come up.
   */
  async promote(ownerId: string, by: string, id: string, sessionId?: string) {
    const { c, s } = await this.load(ownerId, id);
    if (!this.o.restart)
      throw new CodeChangeError(
        "RedGiant is not running under the supervisor (redgiant-supervisor): a change cannot be promoted safely",
      );
    const head = await this.git(s.path, "rev-parse", "HEAD");
    if (c.stage !== "tested" || !s.passed || s.commit !== head)
      throw new CodeChangeError("Promote only what passed platform_code_test, unchanged since");
    const dirty = await this.git(s.path, "status", "--porcelain");
    if (dirty) throw new CodeChangeError("The change has edits after its test: test it again");
    await this.git(
      this.o.dir,
      "merge",
      "--no-ff",
      "-q",
      "-m",
      `Platform change ${id}: ${c.change}`,
      s.branch,
    );
    const commit = await this.git(this.o.dir, "rev-parse", "HEAD");
    await writeJson(requestFile(this.o.stateDir), {
      changeId: id,
      ownerId,
      commit,
    } satisfies ReleaseRequest);
    await this.changes.record(ownerId, {
      id,
      kind: "code",
      change: c.change,
      stage: "tested",
      after: { ...s, promoted: commit, ...(sessionId && { sessionId }) } satisfies CodeState,
      detail: `${c.detail ?? ""}\n## promotion: merged as ${commit.slice(0, 8)}, restarting`,
      by,
    });
    // Answer first: the restart ends this very turn.
    setTimeout(() => this.o.restart?.(), 1500);
    return commit;
  }

  async discard(ownerId: string, by: string, id: string) {
    const { c, s } = await this.load(ownerId, id);
    if (c.stage === "promoted")
      throw new CodeChangeError("A promoted change is part of the platform now");
    await this.git(this.o.dir, "worktree", "remove", "--force", s.path).catch(() => {});
    await this.git(this.o.dir, "branch", "-D", s.branch).catch(() => {});
    return this.changes.record(ownerId, {
      id,
      kind: "code",
      change: c.change,
      stage: "discarded",
      by,
    });
  }

  private timer: NodeJS.Timeout | undefined;
  private reconciling: Promise<void> | undefined;

  /**
   * Follows the supervisor's report. A promotion is confirmed only after the new version has
   * stayed up for a while, that is after this server started: reading it once is not enough.
   */
  watch(everyMs = 5000): void {
    this.unwatch();
    void this.reconcile().catch(() => {});
    this.timer = setInterval(() => void this.reconcile().catch(() => {}), everyMs);
    this.timer.unref?.();
  }

  unwatch(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * What the supervisor did goes into the log, and the owner is told (promoted, or rolled back
   * with the reason). Each outcome is recorded once, even when calls overlap.
   */
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<void> {
    const state = await readRelease(this.o.stateDir);
    for (const h of state.history) {
      if (!h.changeId || !h.ownerId) continue;
      const c = await this.changes.get(h.ownerId, h.changeId);
      const s = c?.after as CodeState | undefined;
      // Only the verdict on this promotion (a change rolled back, fixed and promoted again has two).
      if (!c || !s || c.stage !== "tested" || s.promoted !== h.commit) continue;
      const owner = h.ownerId;
      const tellGod = (text: string) => {
        if (s.sessionId) void this.resume?.(owner, s.sessionId, text).catch(() => {});
      };
      if (h.result === "promoted") {
        await this.changes.record(h.ownerId, {
          id: c.id,
          kind: "code",
          change: c.change,
          stage: "promoted",
          detail: `${c.detail ?? ""}\n## live since ${h.at}`,
          by: "supervisor",
        });
        // The worktree is done; the branch stays as history.
        await this.git(this.o.dir, "worktree", "remove", "--force", s.path).catch(() => {});
        await this.notify(
          h.ownerId,
          `✅ Platform change live: ${c.change} (${h.commit.slice(0, 8)})`,
        );
        tellGod(
          `Your platform change ${c.id} ("${c.change}") is live: RedGiant restarted on version ${h.commit.slice(0, 8)}, which interrupted your previous turn. Check that the change works, then give the user the result they asked for.`,
        );
      } else {
        await this.changes.record(h.ownerId, {
          id: c.id,
          kind: "code",
          change: c.change,
          stage: "rolled_back",
          after: { ...s, passed: false } satisfies CodeState,
          detail: `${c.detail ?? ""}\n## rolled back: ${h.reason ?? "it did not come up"}`,
          by: "supervisor",
        });
        await this.notify(
          h.ownerId,
          `↩️ Platform change rolled back: ${c.change}\n${(h.reason ?? "").split("\n")[0]}\nThe previous version is running.`,
        );
        tellGod(
          `Your platform change ${c.id} ("${c.change}") was rolled back by the supervisor: ${h.reason ?? "it did not come up"}. The previous version is running. Tell the user, then fix the change (it is still open: edit, test, promote again) or discard it.`,
        );
      }
    }
  }
}

/** God's tools on its own code (G14.2). All of them ask the human (danger "platform"). */
export function platformCodeTools(self: AgentRecord, code: CodeChanges | undefined): Tool[] {
  if (self.kind !== "god" || !code) return [];
  const owner = self.ownerId;
  const by = self.id;
  return [
    {
      def: {
        name: "platform_code_start",
        description:
          "Start a change to RedGiant's own source code. Returns a directory in your workspace (a git worktree of the source) where you edit files with your usual tools; then call platform_code_test.",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "What the change does, in one line" },
          },
          required: ["title"],
        },
      },
      schema: z.object({ title: z.string().min(3) }),
      async run({ title }) {
        const { change, dir } = await code.start(owner, by, title);
        return `Change ${change.id} started. Edit the files under ${dir}/ (paths relative to your workspace), then call platform_code_test.`;
      },
    } as Tool,
    {
      def: {
        name: "platform_code_test",
        description:
          "Commit the change, then install, build, run the test suite and start a trial copy of RedGiant from it (throwaway database, no secrets) that must answer its health check. Runs the code you wrote: the human approves it.",
        inputSchema: {
          type: "object",
          properties: { change_id: { type: "string" } },
          required: ["change_id"],
        },
      },
      schema: z.object({ change_id: z.string() }),
      async run({ change_id }) {
        const r = await code.test(owner, by, change_id);
        return `${r.passed ? "PASSED" : "FAILED"}: ${change_id}\n${r.detail}${r.passed ? `\nPromote it with platform_code_promote${code.supervised ? "" : " (not possible here: RedGiant is not supervised)"}.` : ""}`;
      },
    } as Tool,
    {
      def: {
        name: "platform_code_promote",
        description:
          "Put a tested change live: it is merged and RedGiant restarts on it (this conversation is interrupted). If the new version does not come up healthy the supervisor puts the previous one back by itself and the user is told.",
        inputSchema: {
          type: "object",
          properties: { change_id: { type: "string" } },
          required: ["change_id"],
        },
      },
      schema: z.object({ change_id: z.string() }),
      async run({ change_id }, ctx) {
        const commit = await code.promote(owner, by, change_id, ctx.sessionId);
        return `Merged as ${commit.slice(0, 8)}. RedGiant restarts on it in a moment; the outcome will be in platform_changes.`;
      },
    } as Tool,
    {
      def: {
        name: "platform_code_discard",
        description:
          "Drop a code change that was not promoted (its worktree and branch are deleted).",
        inputSchema: {
          type: "object",
          properties: { change_id: { type: "string" } },
          required: ["change_id"],
        },
      },
      schema: z.object({ change_id: z.string() }),
      async run({ change_id }) {
        await code.discard(owner, by, change_id);
        return `Change ${change_id} discarded.`;
      },
    } as Tool,
  ];
}
