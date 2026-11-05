// RedGiant's own search engine without Docker (2026-11-05). Through Docker it is SearXNG's
// container; on Windows and on a Mac without Docker (RedGiant 3.0) it is the same SearXNG run on
// this computer: uv (one program) downloads a portable Python and SearXNG's packages once into the
// data folder, with the bar, and RedGiant starts it on 127.0.0.1. Tried on Rig: installed in 7 s,
// 116 MB, three searches answered by Google, DuckDuckGo and Brave in 0.7-3 s.
//
// SearXNG publishes no numbered releases: its code is pinned at one commit. Windows has no `pwd`
// module, which SearXNG imports only to name the user in an error message of Valkey (a database
// RedGiant does not use): a three-line stand-in, kept apart from SearXNG's code.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, createWriteStream, existsSync, openSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { JobHandle } from "./jobs.js";

/** uv's release (astral-sh/uv) and SearXNG's commit, both pinned. */
export const UV_VERSION = "0.13.7";
export const SEARXNG_COMMIT = "3e95f6cd2a68add0329cb162907b49289e2bc1fd";

/** uv's archive for a system. */
export function uvAsset(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!cpu) return undefined;
  if (platform === "win32") return cpu === "x86_64" ? "uv-x86_64-pc-windows-msvc.zip" : undefined;
  if (platform === "darwin") return `uv-${cpu}-apple-darwin.tar.gz`;
  if (platform === "linux") return `uv-${cpu}-unknown-linux-gnu.tar.gz`;
  return undefined;
}

/** The stand-in for Unix's `pwd`, and the start: SearXNG ends when RedGiant's process goes. */
const PWD_PY = `# Windows has no pwd module; SearXNG imports it only to name the user in an error message.
import getpass


class _Entry:
    def __init__(self):
        self.pw_name = getpass.getuser()


def getpwuid(_uid=None):
    return _Entry()
`;
// RedGiant's process is watched, not stdin: on Windows a thread waiting on the stdin pipe held
// up every other use of it, and SearXNG never answered (2026-11-05, Rig).
const RUN_PY = `# RedGiant starts SearXNG through this: it ends when RedGiant's process does.
import os
import runpy
import threading
import time


def _watch(pid):
    if os.name == "nt":
        import ctypes

        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if handle:
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        os._exit(0)
    while True:
        try:
            os.kill(pid, 0)
        except OSError:
            os._exit(0)
        time.sleep(2)


_parent = int(os.environ.get("REDGIANT_PARENT_PID", "0"))
if _parent:
    threading.Thread(target=_watch, args=(_parent,), daemon=True).start()
runpy.run_module("searx.webapp", run_name="__main__", alter_sys=True)
`;

export interface LocalSearxngOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** uv's releases and SearXNG's archives (mirrors, or fakes in tests). */
  uvReleases?: string;
  searxngArchives?: string;
}

export class LocalSearxng {
  private proc: ChildProcess | undefined;
  private url: string | undefined;

  constructor(
    private readonly dataDir: string,
    private readonly o: LocalSearxngOptions = {},
  ) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  get dir(): string {
    return join(this.dataDir, "tools", "searxng");
  }

  private get src(): string {
    return join(this.dir, `searxng-${SEARXNG_COMMIT}`);
  }

  private get python(): string {
    return this.platform === "win32"
      ? join(this.dir, "venv", "Scripts", "python.exe")
      : join(this.dir, "venv", "bin", "python");
  }

  private get marker(): string {
    return join(this.dir, `ready-${SEARXNG_COMMIT.slice(0, 12)}.txt`);
  }

  /** Installed at this commit: nothing to download. */
  ready(): boolean {
    return existsSync(this.marker) && existsSync(this.python);
  }

  private uvEnv(): NodeJS.ProcessEnv {
    // Everything uv keeps stays in the data folder: never the person's own Python or caches.
    return {
      ...process.env,
      UV_CACHE_DIR: join(this.dir, "cache"),
      UV_PYTHON_INSTALL_DIR: join(this.dir, "python"),
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_NO_PROGRESS: "1",
      UV_NO_CONFIG: "1",
    };
  }

  private run(file: string, args: string[], cwd: string): Promise<string> {
    return new Promise((ok, ko) => {
      const p = spawn(file, args, { cwd, env: this.uvEnv(), windowsHide: true });
      let out = "";
      p.stdout?.on("data", (b: Buffer) => {
        out += b.toString();
      });
      p.stderr?.on("data", (b: Buffer) => {
        out += b.toString();
      });
      p.once("error", ko);
      p.once("exit", (code) =>
        code === 0 ? ok(out) : ko(new Error(`${file} exited with ${code}: ${out.slice(-800)}`)),
      );
    });
  }

  /** Downloads uv and SearXNG, then a Python and SearXNG's packages (step `searxng_image`). */
  async install(h?: JobHandle): Promise<void> {
    if (this.ready()) return;
    const asset = uvAsset(this.platform, this.o.arch ?? process.arch);
    if (!asset) throw new Error("There is no ready uv for this computer");
    await mkdir(this.dir, { recursive: true });
    const uvBase = (
      this.o.uvReleases ?? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
    ).replace(/\/+$/, "");
    const srcBase = (
      this.o.searxngArchives ?? "https://github.com/searxng/searxng/archive"
    ).replace(/\/+$/, "");
    // The two downloads share one bar: uv (15 MB) and SearXNG's code (a few MB).
    const part = join(this.dir, "download.part");
    await rm(part, { recursive: true, force: true });
    await mkdir(part, { recursive: true });
    let done = 0;
    const fetchTo = async (url: string, file: string) => {
      const r = await fetch(url, { ...(h && { signal: h.signal }) });
      if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
      const body = Readable.fromWeb(r.body as never);
      body.on("data", (b: Buffer) => {
        done += b.length;
        h?.progress(done, null);
      });
      await pipeline(body, createWriteStream(file));
    };
    await fetchTo(`${uvBase}/${asset}`, join(part, asset));
    const tarball = `${SEARXNG_COMMIT}.tar.gz`;
    await fetchTo(`${srcBase}/${tarball}`, join(part, tarball));
    // The system's tar unpacks both (Windows 10 and later read zip with it too).
    await this.run("tar", ["-xf", asset], part);
    await this.run("tar", ["-xzf", tarball], part);
    const uv = await find(part, this.platform === "win32" ? "uv.exe" : "uv");
    if (!uv) throw new Error(`uv is not in ${asset}`);
    await rm(join(this.dir, "uv"), { recursive: true, force: true });
    await mkdir(join(this.dir, "uv"), { recursive: true });
    const uvFile = join(this.dir, "uv", this.platform === "win32" ? "uv.exe" : "uv");
    await rename(uv, uvFile);
    await rm(this.src, { recursive: true, force: true });
    await rename(join(part, `searxng-${SEARXNG_COMMIT}`), this.src);
    await rm(part, { recursive: true, force: true });
    // A Python of its own and SearXNG's packages.
    await rm(join(this.dir, "venv"), { recursive: true, force: true });
    await this.run(uvFile, ["venv", "--python", "3.13", "venv"], this.dir);
    await this.run(
      uvFile,
      ["pip", "install", "--python", this.python, "-r", join(this.src, "requirements.txt")],
      this.dir,
    );
    await rm(join(this.dir, "cache"), { recursive: true, force: true });
    await writeFile(this.marker, `${SEARXNG_COMMIT}\n`);
  }

  /** Starts SearXNG on 127.0.0.1 (step `searxng_start`) and waits for it (`searxng_check`). */
  async start(port: number, h?: JobHandle): Promise<string> {
    if (this.url && this.proc?.exitCode === null) return this.url;
    if (!this.ready()) throw new Error("SearXNG is not installed yet");
    h?.step("searxng_start");
    // Written at every start: a newer RedGiant brings newer ones without installing again.
    await mkdir(join(this.dir, "shim"), { recursive: true });
    await writeFile(join(this.dir, "shim", "pwd.py"), PWD_PY);
    await writeFile(join(this.dir, "shim", "redgiant_searxng.py"), RUN_PY);
    const settings = join(this.dir, "settings.yml");
    // Its settings: this computer only, JSON answers for RedGiant, no rate limiter.
    await writeFile(
      settings,
      [
        "use_default_settings: true",
        "general:",
        "  instance_name: RedGiant",
        "server:",
        '  bind_address: "127.0.0.1"',
        `  port: ${port}`,
        `  secret_key: "${randomBytes(24).toString("hex")}"`,
        "  limiter: false",
        "  public_instance: false",
        "  image_proxy: false",
        "search:",
        "  formats: [html, json]",
        "",
      ].join("\n"),
    );
    const sep = this.platform === "win32" ? ";" : ":";
    // What it says goes to a file of its own, for whoever helps.
    const log = openSync(join(this.dir, "searxng.log"), "w");
    this.proc = spawn(this.python, [join(this.dir, "shim", "redgiant_searxng.py")], {
      cwd: this.src,
      env: {
        ...process.env,
        SEARXNG_SETTINGS_PATH: settings,
        PYTHONPATH: [join(this.dir, "shim"), this.src].join(sep),
        PYTHONUNBUFFERED: "1",
        // It ends when RedGiant does, even when RedGiant is killed.
        REDGIANT_PARENT_PID: String(process.pid),
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    closeSync(log);
    h?.step("searxng_check");
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (this.proc.exitCode !== null) throw new Error("SearXNG stopped at start");
      const up = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) }).then(
        (r) => r.ok,
        () => false,
      );
      if (up) {
        this.url = base;
        return base;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error("SearXNG did not answer");
  }

  stop(): void {
    const p = this.proc;
    // On Windows the venv's python.exe only starts the real one as its child: the whole tree.
    if (p?.pid && this.platform === "win32")
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else p?.kill();
    this.proc = undefined;
    this.url = undefined;
  }
}

async function find(dir: string, name: string): Promise<string | undefined> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const got = await find(p, name);
      if (got) return got;
    }
  }
  return undefined;
}
