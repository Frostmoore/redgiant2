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
  /**
   * Runs a program with arguments, without any shell: nothing is interpreted, so it is safe
   * with untrusted arguments and works the same on every OS.
   */
  execFile(file: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  /** Opens an interactive shell in the workspace root. */
  openTerminal(options: TerminalOptions): Promise<Terminal>;
}

/** An interactive shell with a pseudo-terminal (the user's terminal in the web UI). */
export interface Terminal {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export interface TerminalOptions {
  cols: number;
  rows: number;
}

export class TerminalUnavailableError extends Error {}

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

/**
 * What a command started by an agent sees of the server's environment (RedGiant 2.0, 2026-11-04:
 * agents run on the system, not in containers). Only what a shell needs to work: never the
 * server's token, its database, its keys. Secrets belong to egress routes, as before.
 */
const AGENT_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TZ",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "COREPACK_HOME",
  // Windows: what a program needs to start at all (its names are matched in any case there).
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "SYSTEMDRIVE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
];

/** The environment of an agent's commands: the safe part of `from` (the server's own). */
export function agentEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) {
    // Windows spells PATH as "Path": environment names there ignore case.
    const name = process.platform === "win32" ? k.toUpperCase() : k;
    if (
      v !== undefined &&
      (AGENT_ENV.includes(name) || k.startsWith("LC_") || k.startsWith("XDG_"))
    )
      out[k] = v;
  }
  return out;
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
    /**
     * Shell for `exec`. Node runs it the right way for each OS (on Windows it passes the
     * command to cmd.exe verbatim; escaping it ourselves breaks commands with quotes).
     */
    private readonly shell: string = process.platform === "win32" ? "cmd.exe" : "/bin/bash",
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

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    return this.run(command, [], options, this.shell);
  }

  execFile(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    return this.run(file, args, options);
  }

  /**
   * A real pseudo-terminal without native modules: a tiny Python helper forks the shell on a
   * pty and takes resize requests on fd 3. Linux and macOS (python3 required).
   */
  async openTerminal({ cols, rows }: TerminalOptions): Promise<Terminal> {
    if (process.platform === "win32") {
      throw new TerminalUnavailableError(
        "The host terminal needs Linux or macOS; use the Docker sandbox on Windows.",
      );
    }
    const shell =
      process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : "/bin/bash";
    const child = spawn("python3", ["-c", PTY_HELPER, String(cols), String(rows), shell], {
      cwd: this.root,
      env: { ...agentEnv(), TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as import("node:stream").Writable;
    const decoder = new TextDecoder();
    const dataListeners: ((d: string) => void)[] = [];
    const exitListeners: ((c: number | null) => void)[] = [];
    child.stdout?.on("data", (b: Buffer) => {
      const text = decoder.decode(b, { stream: true });
      for (const l of dataListeners) l(text);
    });
    child.stderr?.on("data", (b: Buffer) => {
      for (const l of dataListeners) l(b.toString());
    });
    child.on("close", (code) => {
      for (const l of exitListeners) l(code);
    });
    await new Promise<void>((ok, ko) => {
      child.once("spawn", ok);
      child.once("error", () =>
        ko(new TerminalUnavailableError("python3 is required for the host terminal")),
      );
    });
    return {
      write: (d) => child.stdin?.write(d),
      resize: (c, r) => control.write(`${JSON.stringify({ cols: c, rows: r })}\n`),
      onData: (l) => dataListeners.push(l),
      onExit: (l) => exitListeners.push(l),
      kill: () => {
        child.stdin?.end();
        child.kill("SIGHUP");
      },
    };
  }

  private run(
    file: string,
    args: string[],
    { timeoutMs, signal }: ExecOptions,
    shell?: string,
  ): Promise<ExecResult> {
    return new Promise((done) => {
      // Its own process group: stopping it stops what it started too (a shell's `sleep`
      // would otherwise keep the output open, and the turn waiting, until it ended).
      const group = process.platform !== "win32";
      const child = spawn(file, args, {
        cwd: this.root,
        ...(shell && { shell }),
        env: agentEnv(),
        detached: group,
      });
      const stop = () => {
        try {
          if (group && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
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
        signal?.removeEventListener("abort", stop);
        done({ stdout, stderr, exitCode: code, timedOut });
      });
    });
  }
}

const inside = (root: string, abs: string) => {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Forks a shell on a pty; stdin/stdout are the terminal, fd 3 carries JSON resize requests. */
const PTY_HELPER = `
import os, pty, sys, select, json, fcntl, termios, struct, signal
cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell])
def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
setsize(cols, rows)
buf = b""
inputs = [fd, 0, 3]
while True:
    try:
        ready, _, _ = select.select(inputs, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            os.kill(pid, signal.SIGHUP)
            break
        os.write(fd, data)
    if 3 in ready:
        data = os.read(3, 4096)
        if not data:
            inputs.remove(3)
            continue
        buf += data
        while b"\\n" in buf:
            line, buf = buf.split(b"\\n", 1)
            try:
                size = json.loads(line)
                setsize(int(size["cols"]), int(size["rows"]))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
