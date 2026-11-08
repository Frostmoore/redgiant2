import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ExecOptions {
  /** Infinity: no time limit (a background command the person lets run, G36.16). */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /**
   * Extra variables for this run only. Never a secret (CLAUDE.md): the keychain gives a bound
   * tool the proxy's address for a credential (`REDGIANT_VAULT_<NAME>`), never its value.
   */
  env?: Record<string, string> | undefined;
  /**
   * Background commands (p3.3.1): the output as it comes, instead of collected (the result's
   * stdout and stderr are then empty), and the process's id once it starts.
   */
  onOutput?: ((text: string, stream: "out" | "err") => void) | undefined;
  onSpawn?: ((pid: number) => void) | undefined;
}

/** One process as the system lists it: its id, its parent's id, when it was created (any unit). */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  created: bigint;
}

/**
 * The processes to stop for `root` on Windows, leaves first and the root last (p3.4.0). Windows
 * keeps each process's parent id forever, even after the parent dies, and reuses ids: a process
 * whose recorded parent id now belongs to `root` (or to one of its descendants) may be a stranger
 * started long before by a parent that is gone (the embedded database's `cmd.exe`, whose `pg_ctl`
 * exits at once). So a child counts only when it was created no earlier than its parent, as
 * process explorers do: the current owner of a reused id is always born after the orphans of the
 * id's earlier owner. A root that is not in the list has ended: nothing is stopped.
 */
export function windowsDescendants(root: number, processes: readonly ProcessEntry[]): number[] {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  if (!byPid.has(root)) return [];
  const children = new Map<number, ProcessEntry[]>();
  for (const p of processes) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (p: ProcessEntry) => {
    seen.add(p.pid);
    for (const c of children.get(p.pid) ?? [])
      if (!seen.has(c.pid) && c.created >= p.created) visit(c);
    order.push(p.pid);
  };
  visit(byPid.get(root) as ProcessEntry);
  return order;
}

/** Parses the lines `pid ppid created` the Windows process list prints; undefined when unreadable. */
export function parseProcessList(out: string): ProcessEntry[] | undefined {
  const list: ProcessEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3] as string) });
  }
  return list.length > 0 ? list : undefined;
}

/** Every process on Windows with its parent and creation time (file time), or undefined. */
export function listWindowsProcesses(): Promise<ProcessEntry[] | undefined> {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }",
      ],
      { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => done(err ? undefined : parseProcessList(String(out))),
    );
  });
}

/**
 * Stops a process and everything it started (p3.3.1). Elsewhere the process group, which every
 * command gets of its own. Windows (p3.4.0): never `taskkill /T`, which follows recorded parent
 * ids that may have been reused and once took the embedded database down with an agent's
 * command; the processes are listed once, the true descendants chosen by creation time
 * (`windowsDescendants`) and each stopped alone, the root last. When the list cannot be read only
 * the root is stopped. Never rejects; callers may ignore the promise.
 */
export async function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (file: string, args: string[]) => void = (file, args) => {
    spawn(file, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
  },
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  list: () => Promise<ProcessEntry[] | undefined> = listWindowsProcesses,
): Promise<void> {
  if (platform === "win32") {
    const processes = await list().catch(() => undefined);
    const targets = processes ? windowsDescendants(pid, processes) : [pid];
    for (const p of targets) {
      try {
        run("taskkill", ["/PID", String(p), "/F"]);
      } catch {}
    }
    return;
  }
  try {
    kill(-pid, "SIGKILL");
  } catch {
    try {
      kill(pid, "SIGKILL");
    } catch {}
  }
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

/**
 * The folders of RedGiant's own programs on the agents' PATH (p3.3.1: an agent on Windows found
 * only a system ffmpeg it could not start). `first` goes before the PATH (ffmpeg's folder holds
 * only ffmpeg and its tools); `last` after it (LibreOffice's folder also holds a python.exe, which
 * must not hide the person's own).
 */
const programDirs = { first: new Set<string>(), last: new Set<string>() };

/** Puts a program's folder on the PATH of the agents' commands on this computer. */
export function shareProgramDir(dir: string, where: "first" | "last" = "last"): void {
  if (!dir || programDirs.first.has(dir) || programDirs.last.has(dir)) return;
  programDirs[where].add(dir);
}

/** Tests: forgets the shared folders. */
export function resetProgramDirs(): void {
  programDirs.first.clear();
  programDirs.last.clear();
}

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
  if (programDirs.first.size || programDirs.last.size) {
    const key =
      Object.keys(out).find(
        (k) => (process.platform === "win32" ? k.toUpperCase() : k) === "PATH",
      ) ?? "PATH";
    const own = (out[key] ?? "").split(delimiter).filter(Boolean);
    const seen = new Set<string>();
    out[key] = [...programDirs.first, ...own, ...programDirs.last]
      .filter((d) => !seen.has(d) && seen.add(d))
      .join(delimiter);
  }
  return out;
}

/**
 * The shell agents' commands run in. On Windows (RedGiant 3.0, natively there): Git's bash when
 * installed, since models write bash; PowerShell otherwise. REDGIANT_SHELL chooses another.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  if (env.REDGIANT_SHELL) return env.REDGIANT_SHELL;
  if (platform !== "win32") return "/bin/bash";
  const roots = [
    env.ProgramFiles ?? env.PROGRAMFILES,
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs`,
  ];
  for (const r of roots.filter(Boolean)) {
    const bash = `${r}\\Git\\bin\\bash.exe`;
    if (exists(bash)) return bash;
  }
  return "powershell.exe";
}

/** How a shell is spoken to: cd and "then" differ between cmd, PowerShell and POSIX shells. */
export function shellKind(shell: string = defaultShell()): "cmd" | "powershell" | "posix" {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "cmd.exe" || name === "cmd") return "cmd";
  if (name.startsWith("powershell") || name.startsWith("pwsh")) return "powershell";
  return "posix";
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
    private readonly shell: string = defaultShell(),
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
  /**
   * Windows' own console (ConPTY), through node-pty's prebuilt module (RedGiant 3.0 runs there
   * natively): the agents' shell, Git's bash or PowerShell, in a real terminal.
   */
  private async windowsTerminal(cols: number, rows: number): Promise<Terminal> {
    let pty: typeof import("@lydell/node-pty");
    try {
      pty = await import("@lydell/node-pty");
    } catch {
      throw new TerminalUnavailableError("The terminal's module for Windows is missing");
    }
    const shell = this.shell;
    const kind = shellKind(shell);
    const p = pty.spawn(
      shell,
      kind === "posix" ? ["--login", "-i"] : kind === "powershell" ? ["-NoLogo"] : [],
      {
        name: "xterm-256color",
        cols,
        rows,
        cwd: this.root,
        env: { ...agentEnv(), TERM: "xterm-256color" } as Record<string, string>,
      },
    );
    return {
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      onData: (l) => void p.onData(l),
      onExit: (l) => void p.onExit((e) => l(e.exitCode)),
      kill: () => p.kill(),
    };
  }

  async openTerminal({ cols, rows }: TerminalOptions): Promise<Terminal> {
    if (process.platform === "win32") return this.windowsTerminal(cols, rows);
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
    { timeoutMs, signal, env, onOutput, onSpawn }: ExecOptions,
    shell?: string,
  ): Promise<ExecResult> {
    return new Promise((done) => {
      // Its own process group: stopping it stops what it started too (a shell's `sleep`
      // would otherwise keep the output open, and the turn waiting, until it ended).
      const group = process.platform !== "win32";
      const child = spawn(file, args, {
        cwd: this.root,
        ...(shell && { shell }),
        env: env ? { ...agentEnv(), ...env } : agentEnv(),
        detached: group,
      });
      if (child.pid) onSpawn?.(child.pid);
      // The whole tree: on Windows the shell's true descendants too (`killTree`).
      const stop = () => {
        try {
          if (child.pid) void killTree(child.pid);
          else child.kill("SIGKILL");
        } catch {}
      };
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      // Past what a timer can hold (about 24 days) there is no limit at all.
      const timer =
        Number.isFinite(timeoutMs) && timeoutMs <= MAX_TIMER_MS
          ? setTimeout(() => {
              timedOut = true;
              stop();
            }, timeoutMs)
          : undefined;
      if (signal?.aborted) stop();
      signal?.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        if (onOutput) onOutput(d.toString(), "out");
        else stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        if (onOutput) onOutput(d.toString(), "err");
        else stderr += d.toString();
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

/** The longest delay setTimeout keeps (a longer one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
