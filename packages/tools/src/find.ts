// find_files (p3.4.0, the person's decision of 2026-11-08): finding a file or a program anywhere
// on the computer without loading it. In a benchmark on Windows agents looked for compilers and
// jars with `find /` through Git's bash: tens of minutes walking the disk, the antivirus on every
// file, and the processes left alive kept a 12-core machine at 100% for hours. «People cannot
// watch their CPU explode to look for a picture.»
//
// In order: the system's index when there is one (Everything's es.exe on Windows, never installed
// by us; Spotlight on macOS; plocate/locate on Linux); otherwise a walk in Node itself (no shell,
// no `find`): a short time limit, four folders read at a time, a maximum of results, the folders
// nobody looks in skipped, and the likely places first (the project, the PATH, the package caches,
// the home) before the rest of the disks. Only names are read (a folder's listing opens no file,
// so no antivirus scan), never contents. In a container the commands' computer is the container:
// one `find` runs there, through Workspace.execFile, with the same limits.
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { agentEnv, type Workspace } from "./workspace.js";

export type FindKind = "file" | "folder" | "any";

export interface FindQuery {
  /** The name, with wildcards (`*.jar`, `g++*`); a path's tail (`boost/date_time/x.hpp`) too. */
  name?: string | undefined;
  /** A part of the whole path, wildcards allowed (`*date_time*`, `gradle/caches`). */
  path?: string | undefined;
  /** Only inside this absolute folder. */
  under?: string | undefined;
  kind: FindKind;
  maxResults: number;
  timeLimitMs: number;
  signal?: AbortSignal | undefined;
}

export type FindSource = "everything" | "spotlight" | "locate" | "walk" | "path" | "container";

export interface FindOutcome {
  paths: string[];
  source: FindSource;
  /** Why it ended before searching everything; undefined when complete. */
  cut?: "time" | "interrupted" | "max" | undefined;
  /** The folders not searched (or not to the end) when cut by time or an interruption. */
  notSearched: string[];
}

/** One entry of a folder, as `readdir` gives it. */
export interface DirEntry {
  name: string;
  dir: boolean;
  link: boolean;
}

/** What the search needs of the computer; tests give a fake one. */
export interface FindDeps {
  platform: NodeJS.Platform;
  /** The commands' environment (their PATH, PATHEXT, Program Files…). */
  env: NodeJS.ProcessEnv;
  home: string;
  readdir(dir: string): Promise<DirEntry[]>;
  /** Follows links; undefined when nothing is there. */
  stat(path: string): Promise<{ dir: boolean; file: boolean; mode: number } | undefined>;
  /** Runs an index program without a shell. */
  run(
    file: string,
    args: string[],
    o: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<{ stdout: string; exitCode: number | null }>;
  now(): number;
}

export const DEFAULT_FIND_TIME_MS = 20_000;
export const MAX_FIND_TIME_MS = 60_000;
/** Folders read at the same time: enough to hide the disk's latency, never the whole CPU. */
const CONCURRENCY = 4;
const MAX_DEPTH = 32;
/** An index gets this long at most; past it the walk takes over. */
const INDEX_MS = 10_000;

export function realFindDeps(env: NodeJS.ProcessEnv = agentEnv()): FindDeps {
  return {
    platform: process.platform,
    env,
    home: homedir(),
    async readdir(dir) {
      const list = await readdir(dir, { withFileTypes: true });
      return list.map((d) => ({
        name: d.name,
        dir: d.isDirectory(),
        link: d.isSymbolicLink(),
      }));
    },
    async stat(path) {
      try {
        const s = await stat(path);
        return { dir: s.isDirectory(), file: s.isFile(), mode: s.mode };
      } catch {
        return undefined;
      }
    },
    run: (file, args, o) =>
      new Promise((done) => {
        execFile(
          file,
          args,
          {
            timeout: o.timeoutMs,
            killSignal: "SIGKILL",
            windowsHide: true,
            maxBuffer: 32 * 1024 * 1024,
            ...(o.signal && { signal: o.signal }),
          },
          (err, stdout) => {
            const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
            done({ stdout: String(stdout ?? ""), exitCode: code });
          },
        );
      }),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------------- patterns

const hasWild = (s: string) => /[*?[]/.test(s);

/** A glob as a case-insensitive regular expression: `*` any text, `?` one character, `[…]`. */
export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\\]/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

const slashes = (p: string) => p.replaceAll("\\", "/");

/** What a found path must match: its name, a part of its path. */
export interface FindPattern {
  /** The name's glob (the last part of a path given as name). */
  name?: string | undefined;
  /** Globs the whole path (forward slashes) must match. */
  paths: string[];
  test(fullPath: string, name: string): boolean;
}

export function findPattern(name?: string, path?: string): FindPattern {
  let n = name?.trim() || undefined;
  const paths: string[] = [];
  const p = path?.trim();
  if (p) paths.push(`*${slashes(p).replace(/^\*+|\*+$/g, "")}*`);
  if (n && /[\\/]/.test(n)) {
    // A path's tail as the name (boost/date_time/gregorian/gregorian.hpp): its last part is the
    // name, and the path must end with the whole tail.
    const parts = slashes(n).split("/").filter(Boolean);
    n = parts.at(-1);
    if (parts.length > 1) paths.push(`*/${parts.join("/")}`);
  }
  const nameRe = n ? globRegExp(n) : undefined;
  const pathRes = paths.map(globRegExp);
  return {
    name: n,
    paths,
    test: (full, base) =>
      (!nameRe || nameRe.test(base)) && pathRes.every((r) => r.test(slashes(full))),
  };
}

// ------------------------------------------------------------------------------------ places

const pathOf = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** A variable of the environment; on Windows names ignore case. */
export function envOf(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return env[name] || undefined;
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return (key && env[key]) || undefined;
}

/** The PATH's folders, in order. */
export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = envOf(env, "PATH", platform) ?? "";
  return raw
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** A folder to walk: `depth` 0 lists it only (the PATH's folders). */
export interface FindRoot {
  dir: string;
  depth: number;
}

/**
 * Where to look, likely places first (p3.4.0): the project, the PATH's folders (listed only),
 * the package caches and the usual installation folders of the system, the home, then the disks.
 */
export function knownRoots(o: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  project?: string | undefined;
}): FindRoot[] {
  const { platform, env, home } = o;
  const p = pathOf(platform);
  const v = (name: string) => envOf(env, name, platform);
  const deep: (string | undefined)[] = [];
  const inHome = (...parts: string[]) => p.join(home, ...parts);
  // Package caches every system has in the home.
  const caches = [
    inHome(".gradle"),
    inHome(".m2"),
    inHome(".npm"),
    inHome(".cache"),
    inHome(".local"),
    inHome(".cargo"),
    inHome(".nuget", "packages"),
    inHome("go", "pkg"),
    inHome(".conda"),
    inHome("miniconda3"),
    inHome("anaconda3"),
    inHome(".pyenv"),
    inHome(".sdkman"),
    inHome(".jdks"),
  ];
  if (platform === "win32") {
    const drive = `${(v("SYSTEMDRIVE") ?? "C:").replace(/[\\/]+$/, "")}\\`;
    const local = v("LOCALAPPDATA");
    const roaming = v("APPDATA");
    deep.push(
      ...caches,
      local && p.join(local, "pnpm"),
      local && p.join(local, "npm-cache"),
      roaming && p.join(roaming, "npm"),
      local && p.join(local, "pip"),
      roaming && p.join(roaming, "Python"),
      local && p.join(local, "Programs"),
      inHome("scoop"),
      p.join(drive, "msys64"),
      p.join(drive, "ProgramData", "chocolatey"),
      p.join(drive, "vcpkg"),
      p.join(drive, "tools"),
      p.join(drive, "MinGW"),
      p.join(drive, "cygwin64"),
      v("PROGRAMFILES") ?? p.join(drive, "Program Files"),
      v("PROGRAMFILES(X86)") ?? p.join(drive, "Program Files (x86)"),
    );
  } else if (platform === "darwin") {
    deep.push(
      ...caches,
      inHome("Library", "pnpm"),
      "/opt/homebrew",
      "/usr/local",
      "/usr/include",
      "/Library/Java",
      "/Library/Developer/CommandLineTools",
      "/Library/Frameworks",
      "/Applications",
      "/opt",
    );
  } else {
    deep.push(
      ...caches,
      "/usr/include",
      "/usr/local",
      "/usr/share/java",
      "/usr/lib",
      "/opt",
      "/snap/bin",
    );
  }
  const rest: string[] = [];
  if (platform === "win32") {
    const sys = (v("SYSTEMDRIVE") ?? "C:").replace(/[\\/]+$/, "").toUpperCase();
    rest.push(`${sys}\\`);
    for (let c = 67; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:`;
      if (d !== sys) rest.push(`${d}\\`);
    }
  } else rest.push("/");
  const list: FindRoot[] = [
    ...(o.project ? [{ dir: o.project, depth: MAX_DEPTH }] : []),
    ...pathDirs(env, platform).map((dir) => ({ dir, depth: 0 })),
    ...deep.filter((d): d is string => Boolean(d)).map((dir) => ({ dir, depth: MAX_DEPTH })),
    { dir: home, depth: MAX_DEPTH },
    ...rest.map((dir) => ({ dir, depth: MAX_DEPTH })),
  ];
  const seen = new Set<string>();
  return list.filter((r) => {
    const k = keyOf(r.dir, platform);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Folders never walked, by name in any case (p3.4.0): system bins, repositories' insides. */
export const FIND_SKIPPED_NAMES = [
  "$recycle.bin",
  "system volume information",
  "$windows.~bt",
  "$windows.~ws",
  "$winreagent",
  "winsxs",
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".trash",
  ".trashes",
  ".spotlight-v100",
  ".fseventsd",
  ".documentrevisions-v100",
  "backups.backupdb",
];

/** Whole folders never walked: the system's own, temporary files, other mounts of the same disk. */
export function skippedPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const win =
      envOf(env, "SYSTEMROOT", platform) ?? envOf(env, "WINDIR", platform) ?? "C:\\Windows";
    const local = envOf(env, "LOCALAPPDATA", platform);
    return [
      win32.join(win, "Installer"),
      win32.join(win, "servicing"),
      win32.join(win, "SoftwareDistribution"),
      win32.join(win, "Temp"),
      win32.join(win, "System32", "DriverStore"),
      win32.join(win, "Prefetch"),
      ...(local ? [win32.join(local, "Temp")] : []),
    ];
  }
  return [
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/tmp",
    "/var/tmp",
    "/var/lib/docker",
    "/var/lib/containerd",
    "/snap",
    "/System/Volumes",
    "/private/var/folders",
    "/private/var/vm",
  ];
}

const keyOf = (p: string, platform: NodeJS.Platform) => {
  const n = pathOf(platform).normalize(p);
  const trimmed =
    n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n) ? n.slice(0, -1) : n;
  return platform === "win32" || platform === "darwin" ? trimmed.toLowerCase() : trimmed;
};

const insideKey = (child: string, parent: string, platform: NodeJS.Platform) => {
  const s = platform === "win32" ? "\\" : "/";
  return child === parent || child.startsWith(parent.endsWith(s) ? parent : parent + s);
};

// --------------------------------------------------------------------------------- the walk

/** Walks the roots in order within the time limit; what it found so far when it must stop. */
export async function walkFind(
  roots: FindRoot[],
  q: FindQuery,
  pattern: FindPattern,
  deps: FindDeps,
): Promise<FindOutcome> {
  const { platform } = deps;
  const p = pathOf(platform);
  const skipNames = new Set(FIND_SKIPPED_NAMES);
  const skipPaths = new Set(skippedPaths(deps.env, platform).map((d) => keyOf(d, platform)));
  const done: string[] = [];
  const found: string[] = [];
  const seen = new Set<string>();
  let cut: FindOutcome["cut"];
  let stopped = false;
  const started = new Set<number>();
  const finished = new Set<number>();
  const stop = (why: NonNullable<FindOutcome["cut"]>) => {
    if (!stopped) cut = why;
    stopped = true;
  };
  const left = Math.max(0, q.timeLimitMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stop("time");
      resolve();
    }, left);
    onAbort = () => {
      stop("interrupted");
      resolve();
    };
    if (q.signal?.aborted) onAbort();
    else q.signal?.addEventListener("abort", onAbort, { once: true });
  });

  const add = (full: string, dir: boolean) => {
    const k = keyOf(full, platform);
    if (seen.has(k)) return;
    seen.add(k);
    found.push(dir ? `${full.replace(/[\\/]+$/, "")}${p.sep}` : full);
    if (found.length >= q.maxResults) stop("max");
  };

  const walkRoot = (root: FindRoot) =>
    new Promise<void>((resolve) => {
      const queue: { dir: string; depth: number }[] = [{ dir: root.dir, depth: 0 }];
      let next = 0;
      let active = 0;
      const visit = async (item: { dir: string; depth: number }) => {
        let entries: DirEntry[];
        try {
          entries = await deps.readdir(item.dir);
        } catch {
          return;
        }
        for (const e of entries) {
          if (stopped) return;
          const full = p.join(item.dir, e.name);
          const isDir = e.dir && !e.link;
          const kindOk = q.kind === "any" || (q.kind === "folder" ? isDir : !isDir);
          if (kindOk && pattern.test(full, e.name)) add(full, isDir);
          if (!isDir || item.depth >= root.depth) continue;
          const k = keyOf(full, platform);
          if (skipNames.has(e.name.toLowerCase()) || skipPaths.has(k)) continue;
          // Walked to the end already as a root of its own (the project inside the home).
          if (done.includes(k)) continue;
          queue.push({ dir: full, depth: item.depth + 1 });
        }
      };
      const pump = () => {
        while (!stopped && active < CONCURRENCY && next < queue.length) {
          const item = queue[next++] as { dir: string; depth: number };
          active++;
          void visit(item).finally(() => {
            active--;
            pump();
          });
        }
        if (active === 0 && (stopped || next >= queue.length)) resolve();
      };
      pump();
    });

  const all = (async () => {
    for (const [i, root] of roots.entries()) {
      if (stopped) return;
      const k = keyOf(root.dir, platform);
      if (done.some((d) => insideKey(k, d, platform))) {
        finished.add(i);
        continue;
      }
      started.add(i);
      await walkRoot(root);
      if (stopped) return;
      finished.add(i);
      if (root.depth >= MAX_DEPTH) done.push(k);
    }
  })();
  await Promise.race([all, cutoff]);
  stopped = true;
  clearTimeout(timer);
  if (onAbort) q.signal?.removeEventListener("abort", onAbort);
  const complete = cut === undefined;
  return {
    paths: found,
    source: "walk",
    cut,
    notSearched:
      complete || cut === "max" ? [] : roots.filter((_, i) => !finished.has(i)).map((r) => r.dir),
  };
}

// ---------------------------------------------------------------------------------- programs

/** Windows' extensions of programs when PATHEXT says nothing. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Programs on the PATH whose name matches (like `which`, every match in the PATH's order). */
export async function findPrograms(
  name: string,
  deps: FindDeps,
  maxResults = 100,
): Promise<string[]> {
  const { platform } = deps;
  const p = pathOf(platform);
  const re = globRegExp(name.trim());
  const exts = (envOf(deps.env, "PATHEXT", platform) ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of pathDirs(deps.env, platform)) {
    let entries: DirEntry[];
    try {
      entries = await deps.readdir(dir);
    } catch {
      continue;
    }
    // A folder lists in any order; within it, by name.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.dir && !e.link) continue;
      let ok: boolean;
      if (platform === "win32") {
        const ext = p.extname(e.name).toLowerCase();
        ok =
          exts.includes(ext) &&
          (re.test(e.name) || re.test(e.name.slice(0, e.name.length - ext.length)));
      } else ok = re.test(e.name);
      if (!ok) continue;
      const full = p.join(dir, e.name);
      if (platform !== "win32") {
        const s = await deps.stat(full);
        if (!s?.file || (s.mode & 0o111) === 0) continue;
      }
      const k = keyOf(full, platform);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(full);
      if (out.length >= maxResults) return out;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------------- indexes

/** Where Everything's command-line client usually is (it is never installed by RedGiant). */
export function everythingCandidates(env: NodeJS.ProcessEnv): string[] {
  const v = (n: string) => envOf(env, n, "win32");
  return [
    ...pathDirs(env, "win32").map((d) => win32.join(d, "es.exe")),
    ...[
      v("PROGRAMFILES"),
      v("PROGRAMFILES(X86)"),
      v("LOCALAPPDATA") && win32.join(v("LOCALAPPDATA") as string, "Programs"),
    ]
      .filter((d): d is string => Boolean(d))
      .map((d) => win32.join(d, "Everything", "es.exe")),
  ];
}

async function firstFile(paths: string[], deps: FindDeps): Promise<string | undefined> {
  for (const f of paths) if ((await deps.stat(f))?.file) return f;
  return undefined;
}

interface IndexAnswer {
  source: FindSource;
  lines: string[];
  /** Nothing found there means nothing is there (Everything sees every file of its disks). */
  authoritative: boolean;
}

/** Asks the system's index; undefined when there is none or it cannot answer. */
export async function askIndex(
  q: FindQuery,
  pattern: FindPattern,
  deps: FindDeps,
): Promise<IndexAnswer | undefined> {
  const limit = Math.min(10_000, q.maxResults * 10);
  const timeoutMs = Math.min(INDEX_MS, q.timeLimitMs);
  const run = (file: string, args: string[]) =>
    deps.run(file, args, { timeoutMs, signal: q.signal }).catch(() => undefined);
  const lines = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  if (deps.platform === "win32") {
    const es = await firstFile(everythingCandidates(deps.env), deps);
    if (!es) return undefined;
    // A name es.exe would read as its own option (-export-csv writes a file): the walk instead.
    if (pattern.name && /^[-/]/.test(pattern.name)) return undefined;
    const quoted = (t: string) => (/\s/.test(t) ? `"${t}"` : t);
    const args = ["-n", String(limit)];
    if (q.under) args.push("-path", q.under);
    if (q.kind === "file") args.push("/a-d");
    if (q.kind === "folder") args.push("/ad");
    if (pattern.name) args.push(quoted(pattern.name));
    for (const pp of pattern.paths) args.push(`path:${quoted(pp.replaceAll("/", "\\"))}`);
    const r = await run(es, args);
    if (r?.exitCode !== 0) return undefined;
    return { source: "everything", lines: lines(r.stdout), authoritative: true };
  }
  if (deps.platform === "darwin") {
    // Spotlight matches names only, with `*` (no `?` or sets).
    if (!pattern.name || /[[\]]/.test(pattern.name)) return undefined;
    const mdfind = await firstFile(["/usr/bin/mdfind"], deps);
    if (!mdfind) return undefined;
    const literal = pattern.name.replaceAll("?", "*").replace(/["\\]/g, "\\$&");
    const r = await run(mdfind, [
      ...(q.under ? ["-onlyin", q.under] : []),
      `kMDItemFSName == "${literal}"c`,
    ]);
    if (!r || (r.exitCode !== 0 && !r.stdout)) return undefined;
    return { source: "spotlight", lines: lines(r.stdout), authoritative: false };
  }
  const locate =
    (await firstFile(
      pathDirs(deps.env, deps.platform).map((d) => posix.join(d, "plocate")),
      deps,
    )) ??
    (await firstFile(
      pathDirs(deps.env, deps.platform).map((d) => posix.join(d, "locate")),
      deps,
    ));
  if (!locate) return undefined;
  const args = ["-i", "-l", String(limit)];
  if (pattern.name) args.push("-b", "--", pattern.name);
  else args.push("--", pattern.paths[0] as string);
  const r = await run(locate, args);
  if (r?.exitCode !== 0) return undefined;
  return { source: "locate", lines: lines(r.stdout), authoritative: false };
}

/** The index's answer checked as the walk would: the pattern, the folder, the kind, still there. */
async function checkIndexed(
  answer: IndexAnswer,
  q: FindQuery,
  pattern: FindPattern,
  deps: FindDeps,
): Promise<string[]> {
  const p = pathOf(deps.platform);
  const under = q.under ? keyOf(q.under, deps.platform) : undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of answer.lines.slice(0, 10_000)) {
    if (q.signal?.aborted || out.length >= q.maxResults) break;
    const full = line.replace(/[\\/]+$/, "") || line;
    const k = keyOf(full, deps.platform);
    if (seen.has(k) || (under && !insideKey(k, under, deps.platform))) continue;
    if (!pattern.test(full, p.basename(full))) continue;
    const s = await deps.stat(full);
    if (!s) continue;
    if ((q.kind === "file" && s.dir) || (q.kind === "folder" && !s.dir)) continue;
    seen.add(k);
    out.push(s.dir ? `${full}${p.sep}` : full);
  }
  return out;
}

// ------------------------------------------------------------------------------- the search

/** Finds on the computer the commands run on (the host): an index, else the walk. */
export async function findOnHost(
  q: FindQuery,
  o: { project?: string | undefined; deps?: FindDeps | undefined } = {},
): Promise<FindOutcome> {
  const deps = o.deps ?? realFindDeps();
  const pattern = findPattern(q.name, q.path);
  const t0 = deps.now();
  const answer = await askIndex(q, pattern, deps);
  if (answer) {
    const paths = await checkIndexed(answer, q, pattern, deps);
    if (paths.length > 0 || answer.authoritative)
      return {
        paths,
        source: answer.source,
        cut: q.signal?.aborted ? "interrupted" : paths.length >= q.maxResults ? "max" : undefined,
        notSearched: [],
      };
  }
  const roots = q.under
    ? [{ dir: q.under, depth: MAX_DEPTH }]
    : knownRoots({ platform: deps.platform, env: deps.env, home: deps.home, project: o.project });
  const spent = deps.now() - t0;
  return walkFind(roots, { ...q, timeLimitMs: q.timeLimitMs - spent }, pattern, deps);
}

/** Lists every program on the container's PATH (a fixed script: nothing of the model in it). */
const LIST_PROGRAMS =
  'IFS=:; for d in $PATH; do [ -d "$d" ] || continue; for f in "$d"/*; do [ -f "$f" ] && [ -x "$f" ] && printf "%s\\n" "$f"; done; done';

/**
 * In a container (p3.4.0) the commands' computer is the container, which only RedGiant's
 * folders and an image fill: one `find` there, through execFile (no shell, so nothing of the
 * pattern is interpreted), the project first then the image, on one filesystem each (`-xdev`:
 * never the mounts), at most 20 levels deep, stopped by the same time limit.
 */
export async function findInWorkspace(
  ws: Workspace,
  q: FindQuery & { executable?: boolean },
): Promise<FindOutcome> {
  const opts = { timeoutMs: q.timeLimitMs, signal: q.signal };
  const lines = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  if (q.executable) {
    const r = await ws.execFile("sh", ["-c", LIST_PROGRAMS], opts);
    const re = globRegExp(q.name?.trim() ?? "*");
    const seen = new Set<string>();
    const paths = lines(r.stdout).filter(
      (l) => re.test(posix.basename(l)) && !seen.has(l) && seen.add(l),
    );
    return {
      paths: paths.slice(0, q.maxResults),
      source: "path",
      cut: paths.length > q.maxResults ? "max" : undefined,
      notSearched: [],
    };
  }
  const pattern = findPattern(q.name, q.path);
  const starts = q.under
    ? [q.under.startsWith("/") ? q.under : `./${q.under.replace(/^\.\//, "")}`]
    : [".", "/"];
  const args = [
    ...starts,
    "-xdev",
    "-maxdepth",
    "20",
    "(",
    "-path",
    "/proc",
    "-o",
    "-path",
    "/sys",
    "-o",
    "-path",
    "/dev",
    "-o",
    "-name",
    "node_modules",
    "-o",
    "-name",
    ".git",
    ")",
    "-prune",
    "-o",
    ...(q.kind === "file" ? ["!", "-type", "d"] : q.kind === "folder" ? ["-type", "d"] : []),
    ...(pattern.name ? ["-iname", pattern.name] : []),
    ...pattern.paths.flatMap((pp) => ["-ipath", pp]),
    "-print",
  ];
  const r = await ws.execFile("find", args, opts);
  const seen = new Set<string>();
  const all: string[] = [];
  for (const l of lines(r.stdout)) {
    const path = l === "." ? "./" : l.replace(/^\.\//, "");
    if (seen.has(path)) continue;
    seen.add(path);
    all.push(path);
  }
  const cut = q.signal?.aborted
    ? "interrupted"
    : all.length > q.maxResults
      ? "max"
      : r.timedOut
        ? "time"
        : undefined;
  return {
    paths: all.slice(0, q.maxResults),
    source: "container",
    cut,
    notSearched: cut === "time" || cut === "interrupted" ? starts : [],
  };
}

// --------------------------------------------------------------------------------- the tool

const FindInput = z
  .object({
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    executable: z.boolean().optional(),
    under: z.string().min(1).optional(),
    kind: z.enum(["file", "folder", "any"]).optional(),
    max_results: z.number().int().min(1).max(1000).optional(),
    time_limit_s: z
      .number()
      .int()
      .min(1)
      .max(MAX_FIND_TIME_MS / 1000)
      .optional(),
  })
  .refine((i) => i.name || i.path, { message: "Give name or path (or both)." })
  .refine((i) => !i.executable || i.name, { message: "executable: true needs a name." });

const SOURCES: Record<FindSource, string> = {
  everything: "Everything's index",
  spotlight: "the Spotlight index (it skips hidden and system folders: give under to walk one)",
  locate:
    "the locate database (updated daily: newer files may be missing; give under to walk a folder)",
  walk: "a walk of the folders, likely places first",
  path: "the PATH",
  container: "find in the container",
};

export interface FindFilesOptions {
  /**
   * Commands run on this computer (sandbox "host"): the search is RedGiant's own, here. Otherwise
   * they run in a container, and so does the search (`findInWorkspace`).
   */
  host?: boolean | undefined;
  /** Tests: the computer as the search sees it. */
  deps?: FindDeps;
}

export function findFilesTool(
  ws: Workspace,
  profile: ModelProfile,
  o: FindFilesOptions = {},
): Tool<z.infer<typeof FindInput>> {
  return {
    def: {
      name: "find_files",
      description: describe(profile, {
        full:
          "Find files, folders and programs anywhere on the computer your commands run on, quickly and without loading it. " +
          'name: the name with wildcards ("*.jar", "g++*", "gregorian.hpp", or a path\'s tail like "boost/date_time/gregorian.hpp"); ' +
          'path: a part of the whole path ("*date_time*", "gradle/caches"); executable: true lists only the programs on the PATH matching name, like which (Windows extensions too), at once. ' +
          "It uses the system's index when there is one (Everything, Spotlight, locate), otherwise it walks the project, the PATH, the package caches (Gradle, Maven, npm/pnpm, pip, MSYS2, Program Files, Homebrew, /usr/include…), the home and then the disks, " +
          "for at most time_limit_s (default 20, at most 60) and max_results (default 100), and says whether the search was complete. under: only inside that folder. " +
          "Use it instead of find / or Get-ChildItem -Recurse over a disk, which can run for hours. Names and paths only, never contents.",
        compact:
          'Find files or programs on the computer: name ("*.jar"), path part ("*date_time*"), executable: true for programs on the PATH. Use instead of find /.',
      }),
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          executable: { type: "boolean" },
          under: { type: "string" },
          kind: { type: "string", enum: ["file", "folder", "any"] },
          max_results: { type: "integer" },
          time_limit_s: { type: "integer" },
        },
      },
    },
    schema: FindInput as unknown as z.ZodType<z.infer<typeof FindInput>>,
    async run(i, ctx) {
      const timeLimitMs = (i.time_limit_s ?? DEFAULT_FIND_TIME_MS / 1000) * 1000;
      const maxResults = i.max_results ?? 100;
      const kind = i.kind ?? "any";
      const t0 = Date.now();
      let r: FindOutcome;
      try {
        if (!o.host) {
          r = await findInWorkspace(ws, {
            name: i.name,
            path: i.path,
            under: i.under,
            kind,
            maxResults,
            timeLimitMs,
            signal: ctx.signal,
            executable: i.executable === true,
          });
        } else {
          const deps = o.deps ?? realFindDeps();
          const p = pathOf(deps.platform);
          if (i.executable) {
            const paths = await findPrograms(i.name as string, deps, maxResults);
            r = {
              paths,
              source: "path",
              cut: paths.length >= maxResults ? "max" : undefined,
              notSearched: [],
            };
          } else {
            const under = i.under
              ? p.resolve(ws.root, i.under.replace(/^~(?=$|[\\/])/, deps.home))
              : undefined;
            r = await findOnHost(
              {
                name: i.name,
                path: i.path,
                under,
                kind,
                maxResults,
                timeLimitMs,
                signal: ctx.signal,
              },
              { project: ws.root, deps },
            );
          }
        }
      } catch (err) {
        return { content: `The search failed: ${(err as Error).message}`, isError: true };
      }
      return findReport(r, {
        maxResults,
        seconds: Math.round((Date.now() - t0) / 1000),
        exact: i.executable === true && !hasWild(i.name ?? ""),
      });
    },
  };
}

/** The tool's answer: what was found, how, and whether the search was complete. */
export function findReport(
  r: FindOutcome,
  o: { maxResults: number; seconds: number; exact?: boolean },
): string {
  const how = SOURCES[r.source];
  const lines: string[] = [];
  if (r.paths.length === 0) lines.push(`Nothing found (${how}).`);
  else {
    lines.push(`${r.paths.length} found (${how}):`);
    lines.push(...r.paths);
    if (o.exact && r.source === "path") lines.push("(The first one is what runs.)");
  }
  if (r.cut === "max")
    lines.push(`Stopped at ${o.maxResults} results: narrow name/path/under, or raise max_results.`);
  else if (r.cut === "time" || r.cut === "interrupted") {
    const not = r.notSearched.slice(0, 8);
    lines.push(
      `${r.cut === "time" ? `Stopped by the time limit after about ${o.seconds} s` : "Interrupted"}: the search was not complete.` +
        (not.length
          ? ` Not searched (or not to the end): ${not.join(", ")}${r.notSearched.length > not.length ? `, and ${r.notSearched.length - not.length} more` : ""}. Give under to search one of them, or a longer time_limit_s.`
          : ""),
    );
  } else lines.push("The search was complete.");
  return lines.join("\n");
}
