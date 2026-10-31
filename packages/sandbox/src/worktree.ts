import type { Workspace } from "@redgiant/tools";

const TIMEOUT = { timeoutMs: 60_000 };
const IDENTITY = ["-c", "user.name=RedGiant", "-c", "user.email=redgiant@localhost"];

export const worktreeDir = (agentId: string) => `.worktrees/${safe(agentId)}`;
export const worktreeBranch = (agentId: string) => `rg/${safe(agentId)}`;

function safe(agentId: string): string {
  const s = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!s) throw new Error("Empty agent id");
  return s;
}

/** Runs git without a shell: identical on Linux, macOS, Windows and in containers. */
const run = (ws: Workspace, args: string[]) => ws.execFile("git", args, TIMEOUT);

async function git(ws: Workspace, args: string[]): Promise<string> {
  const r = await run(ws, args);
  if (r.exitCode !== 0)
    throw new Error(
      `git ${args.find((a) => !a.startsWith("-"))} failed: ${(r.stderr || r.stdout).trim()}`,
    );
  return r.stdout.trim();
}

/** Makes sure the workspace is a git repository with at least one commit. */
export async function ensureRepo(ws: Workspace): Promise<void> {
  if ((await run(ws, ["rev-parse", "--is-inside-work-tree"])).exitCode !== 0) {
    await git(ws, ["init", "-q"]);
    // Files stay exactly as agents write them (Windows git converts line endings by default).
    // Only for repositories RedGiant creates: existing ones keep their own configuration.
    await git(ws, ["config", "core.autocrlf", "false"]);
  }
  const exclude = ".git/info/exclude";
  const current = (await ws.exists(exclude)) ? await ws.readText(exclude) : "";
  if (!current.split(/\r?\n/).includes(".worktrees/")) {
    await ws.writeText(
      exclude,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}.worktrees/\n`,
    );
  }
  if ((await run(ws, ["rev-parse", "--verify", "-q", "HEAD"])).exitCode !== 0) {
    await git(ws, ["add", "-A"]);
    await git(ws, [...IDENTITY, "commit", "-q", "--allow-empty", "-m", "Initial commit"]);
  }
}

/** Creates (or reuses) the agent's worktree on its own branch; returns its path. */
export async function createWorktree(
  ws: Workspace,
  agentId: string,
  base = "HEAD",
): Promise<string> {
  await ensureRepo(ws);
  const dir = worktreeDir(agentId);
  if (await ws.exists(`${dir}/.git`)) return dir;
  const branch = worktreeBranch(agentId);
  const exists =
    (await run(ws, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).exitCode === 0;
  await git(
    ws,
    exists
      ? ["worktree", "add", "-q", dir, branch]
      : ["worktree", "add", "-q", "-b", branch, dir, base],
  );
  return dir;
}

/** Commits everything in a worktree (or workspace); returns false when there was nothing to commit. */
export async function commitAll(
  ws: Workspace,
  message: string,
  author = "RedGiant <redgiant@localhost>",
): Promise<boolean> {
  await git(ws, ["add", "-A"]);
  if ((await run(ws, ["diff", "--cached", "--quiet"])).exitCode === 0) return false;
  const [name = "RedGiant", email = "redgiant@localhost"] = author.replace(/>$/, "").split(" <");
  // The message is an argument, never shell text: an agent cannot inject commands through it.
  await git(ws, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return true;
}

export type MergeResult = { ok: true; merged: boolean } | { ok: false; conflicts: string[] };

/**
 * Merges the agent's branch into the branch checked out in `ws`. On conflict the merge is
 * aborted (the workspace is left as it was) and the conflicting files are reported.
 */
export async function mergeWorktree(ws: Workspace, agentId: string): Promise<MergeResult> {
  const r = await run(ws, [...IDENTITY, "merge", "--no-ff", "--no-edit", worktreeBranch(agentId)]);
  if (r.exitCode === 0) return { ok: true, merged: !/Already up to date/i.test(r.stdout) };
  const conflicts = (await run(ws, ["diff", "--name-only", "--diff-filter=U"])).stdout
    .split(/\r?\n/)
    .filter(Boolean);
  await run(ws, ["merge", "--abort"]);
  if (conflicts.length === 0) throw new Error(`git merge failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: false, conflicts };
}

export async function removeWorktree(
  ws: Workspace,
  agentId: string,
  deleteBranch = false,
): Promise<void> {
  await git(ws, ["worktree", "remove", "--force", worktreeDir(agentId)]);
  if (deleteBranch) await git(ws, ["branch", "-D", worktreeBranch(agentId)]);
}
