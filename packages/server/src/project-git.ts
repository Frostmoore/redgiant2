// A git repository in every new project (3.5.12, the person's test of 3.5.11: «create_project
// says "its own git repository" but there is none»). Until then git was set up only when GitHub
// or Gitea was connected, or later by an agent's first worktree; a project made without either had
// a plain folder. Now the server creates the repository when it creates the folder (branch main, a
// first commit), with the git RedGiant already uses (on Windows the person's Git for Windows, or the
// PortableGit RedGiant downloads at start: both are on this process's PATH). When git is missing
// or fails the project says so (tool result, page) instead of claiming a repository, and an
// existing project without one can get it from Settings > Projects («Initialise git»).

import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One git run, without a shell; rejects with ENOENT when there is no git at all. */
export type RunGit = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runGit: RunGit = (args, cwd) =>
  new Promise((ok, ko) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (e && typeof e.code === "string") return ko(e);
        ok({
          code: e ? Number(e.code ?? 1) || 1 : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/** What a project's repository is after RedGiant tried to make it. */
export type RepoState =
  | { git: "created" | "present" }
  | { git: "missing" | "failed"; error: string };

/** The project's own repository (a `.git` in its folder, not one around it). */
export const hasOwnRepo = (path: string): Promise<boolean> =>
  stat(join(path, ".git")).then(
    () => true,
    () => false,
  );

/**
 * The path as git's `safe.directory` wants it: forward slashes, also on Windows
 * (`C:\Users\Me\x` -> `C:/Users/Me/x`).
 */
export function safeDirectoryPath(path: string): string {
  const p = path.replaceAll("\\", "/").replace(/\/+$/, "");
  // A drive's root keeps its slash (D:/); the root of a Unix disk is "/".
  return /^[A-Za-z]:$/.test(p) ? `${p}/` : p || "/";
}

const IDENTITY = ["-c", "user.name=RedGiant", "-c", "user.email=redgiant@localhost"];
const dubious = (s: string) => /dubious ownership|safe\.directory/i.test(s);

/**
 * `git init` in a project's folder: branch main, line endings left as written, RedGiant's own
 * folders excluded, and a first commit of whatever is there (nothing there: no commit yet). A repository that is already there
 * is left as it is. Never throws: the outcome says what happened.
 */
export async function initProjectRepo(path: string, run: RunGit = runGit): Promise<RepoState> {
  if (await hasOwnRepo(path)) return { git: "present" };
  const git = async (args: string[]) => {
    const r = await run(args, path);
    if (r.code !== 0)
      throw new Error(
        `git ${args.find((a) => !a.startsWith("-") && !a.includes("="))}: ${(r.stderr || r.stdout).trim()}`,
      );
    return r;
  };
  try {
    await git(["init", "-q"]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT")
      return {
        git: "missing",
        error:
          process.platform === "win32"
            ? "git is not installed on this computer yet (RedGiant downloads Git for Windows by itself at start)"
            : "git is not installed on this computer",
      };
    return { git: "failed", error: e.message };
  }
  try {
    // A folder Windows (or a mount) says belongs to someone else: git refuses to work in it until
    // the folder is marked safe in the person's git configuration, as git itself suggests.
    const check = await run(["rev-parse", "--is-inside-work-tree"], path);
    if (check.code !== 0 && dubious(check.stderr))
      await git(["config", "--global", "--add", "safe.directory", safeDirectoryPath(path)]);
    // main whatever git's default (older gits say master; init -b needs git 2.28).
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    // Files stay exactly as agents write them (Windows git converts line endings by default).
    await git(["config", "core.autocrlf", "false"]);
    const exclude = join(path, ".git", "info", "exclude");
    const current = await readFile(exclude, "utf8").catch(() => "");
    const missing = [".worktrees/", ".redgiant/"].filter(
      (x) => !current.split(/\r?\n/).includes(x),
    );
    if (missing.length > 0)
      await writeFile(
        exclude,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
      );
    // A first commit of what is already there. An empty folder (every new project) stays on an
    // unborn main: the first agent's worktree commits what the folder has by then (`ensureRepo`),
    // so files put in before it reach the agents as they always did.
    if ((await readdir(path)).some((f) => f !== ".git")) {
      await git(["add", "-A"]);
      await git([...IDENTITY, "commit", "-q", "-m", "Initial commit"]);
    }
    return { git: "created" };
  } catch (err) {
    return { git: "failed", error: (err as Error).message };
  }
}

/** For an agent: what a project's repository is, in one sentence (no claim git cannot back). */
export function repoSentence(r: RepoState): string {
  switch (r.git) {
    case "created":
      return "It has its own git repository (branch main).";
    case "present":
      return "Its folder already had a git repository, kept as it is.";
    default:
      return `It has NO git repository: ${r.error}. Tell the user; once git works, the repository can be created from Settings > Projects («Initialise git») or with git init.`;
  }
}
