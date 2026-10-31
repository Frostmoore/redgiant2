import type { Workspace } from "@redgiant/tools";

const TIMEOUT = { timeoutMs: 60_000 };

export const worktreeDir = (agentId: string) => `.worktrees/${safe(agentId)}`;
export const worktreeBranch = (agentId: string) => `rg/${safe(agentId)}`;

function safe(agentId: string): string {
  const s = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!s) throw new Error("Empty agent id");
  return s;
}

async function git(ws: Workspace, args: string): Promise<string> {
  const r = await ws.exec(`git ${args}`, TIMEOUT);
  if (r.exitCode !== 0)
    throw new Error(`git ${args.split(" ")[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Makes sure the workspace is a git repository with at least one commit. */
export async function ensureRepo(ws: Workspace): Promise<void> {
  if ((await ws.exec("git rev-parse --is-inside-work-tree", TIMEOUT)).exitCode !== 0)
    await git(ws, "init -q");
  await ws.exec(
    "grep -qx '.worktrees/' .git/info/exclude 2>/dev/null || echo '.worktrees/' >> .git/info/exclude",
    TIMEOUT,
  );
  if ((await ws.exec("git rev-parse --verify -q HEAD", TIMEOUT)).exitCode !== 0) {
    await git(ws, "add -A");
    await git(
      ws,
      `-c user.name=RedGiant -c user.email=redgiant@localhost commit -q --allow-empty -m "Initial commit"`,
    );
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
    (await ws.exec(`git rev-parse --verify -q refs/heads/${branch}`, TIMEOUT)).exitCode === 0;
  await git(
    ws,
    exists ? `worktree add -q ${dir} ${branch}` : `worktree add -q -b ${branch} ${dir} ${base}`,
  );
  return dir;
}

/** Commits everything in a worktree (or workspace); returns false when there was nothing to commit. */
export async function commitAll(
  ws: Workspace,
  message: string,
  author = "RedGiant <redgiant@localhost>",
): Promise<boolean> {
  await git(ws, "add -A");
  if ((await ws.exec("git diff --cached --quiet", TIMEOUT)).exitCode === 0) return false;
  const [name, email] = author.replace(/>$/, "").split(" <");
  await ws.exec(
    `git -c user.name=${JSON.stringify(name)} -c user.email=${JSON.stringify(email)} commit -q -F -  <<'RG_MSG'\n${message}\nRG_MSG`,
    TIMEOUT,
  );
  return true;
}

export type MergeResult = { ok: true; merged: boolean } | { ok: false; conflicts: string[] };

/**
 * Merges the agent's branch into the branch checked out in `ws`. On conflict the merge is
 * aborted (the workspace is left as it was) and the conflicting files are reported.
 */
export async function mergeWorktree(ws: Workspace, agentId: string): Promise<MergeResult> {
  const branch = worktreeBranch(agentId);
  const r = await ws.exec(
    `git -c user.name=RedGiant -c user.email=redgiant@localhost merge --no-ff --no-edit ${branch}`,
    TIMEOUT,
  );
  if (r.exitCode === 0) return { ok: true, merged: !/Already up to date/i.test(r.stdout) };
  const conflicts = (await ws.exec("git diff --name-only --diff-filter=U", TIMEOUT)).stdout
    .split("\n")
    .filter(Boolean);
  await ws.exec("git merge --abort", TIMEOUT);
  if (conflicts.length === 0) throw new Error(`git merge failed: ${(r.stderr || r.stdout).trim()}`);
  return { ok: false, conflicts };
}

export async function removeWorktree(
  ws: Workspace,
  agentId: string,
  deleteBranch = false,
): Promise<void> {
  await git(ws, `worktree remove --force ${worktreeDir(agentId)}`);
  if (deleteBranch) await git(ws, `branch -D ${worktreeBranch(agentId)}`);
}
