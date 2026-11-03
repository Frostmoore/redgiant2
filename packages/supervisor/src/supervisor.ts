import { type ChildProcess, execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import {
  RESTART_EXIT_CODE,
  type ReleaseRequest,
  type ReleaseState,
  readRelease,
  readRequest,
  releaseFile,
  requestFile,
  writeJson,
} from "./release.js";

const run = promisify(execFile);

export interface SupervisorOptions {
  /** The RedGiant source: a git repository, checked out on the live branch. */
  sourceDir: string;
  /** Shared with the server: release.json (history) and request.json (the change being promoted). */
  stateDir: string;
  /** Shell command that installs and builds the source, run in `sourceDir`. */
  build: string;
  start: { command: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  /** Polled until it answers 2xx. */
  healthUrl: string;
  /** How long a new version has to answer (default 90 s). */
  healthTimeoutMs?: number;
  /** How long it must then stay up to be the new last good version (default 15 s). */
  stableMs?: number;
  /** The server's output: inherited (default) or dropped. */
  stdio?: "inherit" | "ignore";
  log?: (line: string) => void;
}

type Up = { ok: true } | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);

/**
 * Keeps the server running (G14.2). When the server exits with RESTART_EXIT_CODE the code in
 * `sourceDir` is rebuilt and started; a version that fails to build, to answer its health
 * check or to stay up is replaced by the last good one, automatically.
 */
export class Supervisor {
  private child: ChildProcess | undefined;
  private stopping = false;
  private state: ReleaseState = { lastGood: null, built: null, history: [] };
  private readonly log: (line: string) => void;

  constructor(private readonly o: SupervisorOptions) {
    this.log = o.log ?? ((l) => console.log(`[supervisor] ${l}`));
  }

  get release(): ReleaseState {
    return this.state;
  }

  /** The running server's process id. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private async git(...args: string[]): Promise<string> {
    return (await run("git", args, { cwd: this.o.sourceDir })).stdout.trim();
  }

  private save() {
    return writeJson(releaseFile(this.o.stateDir), this.state);
  }

  private build(): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.o.build, {
        cwd: this.o.sourceDir,
        shell: true,
        env: this.o.env ?? process.env,
      });
      let output = "";
      p.stdout?.on("data", (d) => {
        output += d;
      });
      p.stderr?.on("data", (d) => {
        output += d;
      });
      p.on("close", (code) => resolve({ ok: code === 0, output }));
      p.on("error", (err) => resolve({ ok: false, output: err.message }));
    });
  }

  private async record(
    commit: string,
    result: "promoted" | "rolled_back",
    req: ReleaseRequest | undefined,
    reason?: string,
  ) {
    // The request may have been written after the commit was seen (a slow machine): read again.
    if (req?.commit !== commit) {
      const late = await readRequest(this.o.stateDir);
      if (late?.commit === commit) req = late;
    }
    this.state.history.push({
      commit,
      result,
      ...(reason && { reason: tail(reason, 4000) }),
      ...(req && req.commit === commit && { changeId: req.changeId, ownerId: req.ownerId }),
      at: new Date().toISOString(),
    });
    // Keep the file small: the event log has the full story.
    this.state.history = this.state.history.slice(-50);
    await this.save();
    await rm(requestFile(this.o.stateDir), { force: true });
  }

  private async rollback(commit: string, reason: string, req: ReleaseRequest | undefined) {
    const good = this.state.lastGood as string;
    this.log(
      `${commit.slice(0, 8)} failed (${reason.split("\n")[0]}); back to ${good.slice(0, 8)}`,
    );
    await this.git("reset", "--hard", good);
    await this.record(commit, "rolled_back", req, reason);
  }

  /** Waits for the health check, then for the stable period; fails if the process dies. */
  private async up(child: ChildProcess): Promise<Up> {
    let exited: string | undefined;
    child.once("exit", (code, signal) => {
      exited = `the server exited (${signal ?? `code ${code}`})`;
    });
    child.once("error", (err) => {
      exited = `the server could not start: ${err.message}`;
    });
    const deadline = Date.now() + (this.o.healthTimeoutMs ?? 90_000);
    let healthy = false;
    while (!healthy) {
      if (exited) return { ok: false, reason: exited };
      if (Date.now() > deadline) return { ok: false, reason: "no answer to the health check" };
      healthy = await fetch(this.o.healthUrl, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!healthy) await sleep(300);
    }
    const stableUntil = Date.now() + (this.o.stableMs ?? 15_000);
    while (Date.now() < stableUntil) {
      if (exited) return { ok: false, reason: `${exited} right after starting` };
      await sleep(200);
    }
    return exited ? { ok: false, reason: exited } : { ok: true };
  }

  private exit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
      if (child.pid === undefined) return resolve(null); // never started
      child.once("exit", (code) => resolve(code));
    });
  }

  /** Runs until `stop`. */
  async run(): Promise<void> {
    this.state = await readRelease(this.o.stateDir);
    let failures = 0;
    while (!this.stopping) {
      const head = await this.git("rev-parse", "HEAD");
      const req = await readRequest(this.o.stateDir);
      const candidate = this.state.lastGood !== null && head !== this.state.lastGood;

      if (this.state.built !== head) {
        this.log(`building ${head.slice(0, 8)}`);
        const b = await this.build();
        if (!b.ok) {
          if (candidate) {
            await this.rollback(head, `build failed:\n${tail(b.output)}`, req);
            continue;
          }
          this.log(`build failed:\n${tail(b.output)}`);
          await sleep(Math.min(60_000, 1000 * 2 ** failures++));
          continue;
        }
        this.state.built = head;
        await this.save();
      }

      this.log(`starting ${head.slice(0, 8)}`);
      const child = spawn(this.o.start.command, this.o.start.args, {
        cwd: this.o.sourceDir,
        env: this.o.env ?? process.env,
        stdio: this.o.stdio ?? "inherit",
      });
      this.child = child;
      const up = await this.up(child);
      if (this.stopping) break;
      if (!up.ok) {
        child.kill("SIGKILL");
        await this.exit(child);
        if (candidate) {
          await this.rollback(head, up.reason, req);
          continue;
        }
        this.log(`${head.slice(0, 8)} did not come up: ${up.reason}`);
        await sleep(Math.min(60_000, 1000 * 2 ** failures++));
        continue;
      }
      failures = 0;
      if (head !== this.state.lastGood) {
        const first = this.state.lastGood === null;
        this.state.lastGood = head;
        if (first) await this.save();
        else await this.record(head, "promoted", req);
        this.log(`${head.slice(0, 8)} is the last good version`);
      }

      const code = await this.exit(child);
      this.child = undefined;
      if (this.stopping) break;
      if (code === RESTART_EXIT_CODE) {
        this.log("restart requested");
        continue;
      }
      // A healthy version that crashes later is restarted as it is.
      this.log(`the server stopped (code ${code}); restarting`);
      await sleep(1000);
    }
  }

  /** Stops the server (SIGTERM, then SIGKILL after 10 s) and the loop. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await this.exit(child);
    clearTimeout(timer);
  }
}
