// Git on Windows (RedGiant 3.0, 2026-11-05). RedGiant needs git for the agents' worktrees and
// their merges, and its bash is the agents' shell and the terminal's. When Windows has no git,
// the official portable Git for Windows (PortableGit: git and bash, no installation, no
// administrator rights) is downloaded once into the data folder, with its bar, and used from
// then on. A Git already installed is used as it is.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Jobs } from "./jobs.js";

const RELEASES = "https://api.github.com/repos/git-for-windows/git/releases/latest";

/** Where the portable Git lives. */
export const portableGitDir = (dataDir: string) => join(dataDir, "tools", "git");

/** A git.exe on the PATH (the person's own Git for Windows). */
export function gitOnPath(path = process.env.PATH ?? process.env.Path ?? ""): boolean {
  return path.split(delimiter).some((d) => d && existsSync(join(d, "git.exe")));
}

/** The portable Git becomes this process's git and the agents' shell (they inherit PATH). */
export function usePortableGit(dir: string): void {
  const path = process.env.PATH ?? process.env.Path ?? "";
  const extra = [join(dir, "cmd"), join(dir, "usr", "bin")];
  if (!path.split(delimiter).includes(extra[0] as string))
    process.env.PATH = [...extra, path].join(delimiter);
  process.env.REDGIANT_SHELL ??= join(dir, "bin", "bash.exe");
}

/** Downloads PortableGit for this computer and unpacks it (a self-extracting 7-Zip archive). */
async function download(
  dir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<void> {
  const release = (await (
    await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" }, signal })
  ).json()) as { assets?: { name: string; browser_download_url: string }[] };
  const arch = process.arch === "arm64" ? "arm64" : "64-bit";
  const asset = release.assets?.find(
    (a) => /^PortableGit-.*\.7z\.exe$/.test(a.name) && a.name.includes(arch),
  );
  if (!asset) throw new Error("Git for Windows has no portable build for this computer");
  const part = `${dir}.part`;
  await rm(part, { recursive: true, force: true });
  await mkdir(part, { recursive: true });
  const r = await fetch(asset.browser_download_url, { signal });
  if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status} for ${asset.name}`);
  const total = Number(r.headers.get("content-length")) || null;
  let done = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on("data", (b: Buffer) => {
    done += b.length;
    progress(done, total);
  });
  const exe = join(part, asset.name);
  await pipeline(body, createWriteStream(exe));
  // The archive unpacks itself: -y answers yes, -o<folder> (no space) is where.
  await new Promise<void>((ok, ko) => {
    const p = spawn(exe, ["-y", `-o${dir}`], { stdio: "ignore", windowsHide: true });
    p.once("error", ko);
    p.once("exit", (code) =>
      code === 0 ? ok() : ko(new Error(`PortableGit exited with ${code}`)),
    );
  });
  await rm(part, { recursive: true, force: true });
  if (!existsSync(join(dir, "cmd", "git.exe")))
    throw new Error("PortableGit unpacked without git.exe");
}

/**
 * On Windows: Git for RedGiant and its agents. Already installed, or downloaded before, it is
 * used at once; otherwise it comes down in the background as a job (`download_git`).
 */
export async function ensureGit(jobs: Jobs, owner: string, dataDir: string): Promise<void> {
  if (process.platform !== "win32") return;
  const dir = portableGitDir(dataDir);
  if (existsSync(join(dir, "cmd", "git.exe"))) {
    usePortableGit(dir);
    return;
  }
  if (gitOnPath()) return;
  const job = jobs.start(owner, "download_git", ["tool_download"], async (h) => {
    h.step("tool_download");
    await download(dir, (d, t) => h.progress(d, t), h.signal);
  });
  const end = await jobs.settled(job.id, 500);
  if (end?.state === "done") usePortableGit(dir);
}
