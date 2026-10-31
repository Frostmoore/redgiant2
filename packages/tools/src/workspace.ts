import { spawn } from "node:child_process";
import {
  glob as fsGlob,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/**
 * Where an agent's tools act. The local implementation works on a directory of the host;
 * the sandbox (G4) provides one backed by a container. Paths are relative to the root and
 * can never leave it.
 */
export interface Workspace {
  readonly root: string;
  readonly readOnly: boolean;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** Files matching a glob pattern, relative to the root, sorted. */
  glob(pattern: string, under?: string): Promise<string[]>;
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
}

export class PathOutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`Path "${path}" is outside the workspace`);
  }
}

export class ReadOnlyWorkspaceError extends Error {
  constructor() {
    super("This workspace is read-only");
  }
}

/** Directories never walked by glob/grep. */
export const IGNORED_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".venv",
  "__pycache__",
  ".next",
  "target",
];

export class LocalWorkspace implements Workspace {
  readonly root: string;

  constructor(
    root: string,
    readonly readOnly = false,
    private readonly shell: { file: string; args: string[] } = process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c"] }
      : { file: "/bin/bash", args: ["-c"] },
  ) {
    this.root = resolve(root);
  }

  /**
   * Resolves a relative path, refusing anything that escapes the root. Every existing
   * component is checked with lstat, so a symlink pointing outside is refused even when its
   * target does not exist yet (writing through it would create a file outside).
   */
  async resolve(path: string): Promise<string> {
    const abs = resolve(this.root, path);
    if (!inside(this.root, abs)) throw new PathOutsideWorkspaceError(path);
    const realRoot = await realpath(this.root);
    let current = realRoot;
    for (const segment of relative(this.root, abs).split(sep).filter(Boolean)) {
      const next = join(current, segment);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(next);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") break; // the rest does not exist yet
        throw err;
      }
      if (st.isSymbolicLink()) {
        const target = resolve(dirname(next), await readlink(next));
        const real = await realpath(target).catch(() => target);
        if (!inside(realRoot, real)) throw new PathOutsideWorkspaceError(path);
        current = real;
      } else {
        current = next;
      }
    }
    return abs;
  }

  async readText(path: string): Promise<string> {
    return readFile(await this.resolve(path), "utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new ReadOnlyWorkspaceError();
    const abs = await this.resolve(path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(await this.resolve(path));
      return true;
    } catch (err) {
      if (err instanceof PathOutsideWorkspaceError) throw err;
      return false;
    }
  }

  async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(await this.resolve(path))).isFile();
    } catch (err) {
      if (err instanceof PathOutsideWorkspaceError) throw err;
      return false;
    }
  }

  async glob(pattern: string, under = "."): Promise<string[]> {
    const cwd = await this.resolve(under);
    if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes(".."))
      throw new PathOutsideWorkspaceError(pattern);
    const out: string[] = [];
    for await (const entry of fsGlob(pattern, {
      cwd,
      withFileTypes: true,
      exclude: (d) => IGNORED_DIRS.includes(typeof d === "string" ? d : d.name),
    })) {
      if (!entry.isFile()) continue;
      out.push(relative(this.root, resolve(entry.parentPath, entry.name)).split(sep).join("/"));
    }
    return out.sort();
  }

  exec(command: string, { timeoutMs, signal }: ExecOptions): Promise<ExecResult> {
    return new Promise((done) => {
      const child = spawn(this.shell.file, [...this.shell.args, command], {
        cwd: this.root,
        env: process.env,
        ...(signal && { signal }),
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        stderr += err.message;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ stdout, stderr, exitCode: code, timedOut });
      });
    });
  }
}

const inside = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
