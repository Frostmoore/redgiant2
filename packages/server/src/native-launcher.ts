// The local engine on a Mac (2026-11-05). On Windows RedGiant.exe runs llama.cpp next to the
// server and the two talk through files in the engine's folder (win-engine.ts). On a Mac there is
// no such program, so this does its part inside the server, on the same files: the same plans,
// SSD stream, models page and engine code drive it.
//
//   engine.json         what the server wants: { id, model | null, build, ctx, parallel, … }
//   engine-status.json  what this does: { id, state, done, total, port, error, log }
//   memory.json         { totalGb, availableGb, engineGb }, every five seconds
//
// llama.cpp's official macOS build (Metal on Apple Silicon) comes down once into bin/, with its
// bar; the engine listens on 127.0.0.1 only. Arguments go to llama-server as a list, never
// through a shell.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WinEngineRequest, WinEngineStatus } from "./win-engine.js";

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

/** llama.cpp's archive for a system, if it publishes one. */
export function engineAsset(
  build: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    return `llama-${build}-bin-macos-${arch}.tar.gz`;
  return undefined;
}

/** Extra flags from RedGiant (SSD stream): plain words only, as the Windows launcher accepts. */
export function safeArgs(args: string | undefined): string[] {
  if (!args || !/^[A-Za-z0-9 _.=-]*$/.test(args)) return [];
  return args.trim().split(/\s+/).filter(Boolean);
}

/** Every file of a model: one, or all the parts of a split one ("x-00001-of-00003.gguf"). */
export function modelParts(dir: string, model: string): string[] {
  const m = /^(.*)-\d{5}-of-(\d{5})\.gguf$/.exec(model);
  if (!m) return [join(dir, model)];
  const of = Number(m[2]);
  const pad = (n: number) => String(n).padStart(5, "0");
  return Array.from({ length: of }, (_, i) =>
    join(dir, `${m[1]}-${pad(i + 1)}-of-${pad(of)}.gguf`),
  );
}

/** llama-server's arguments for a request (the Windows launcher's, as a list). */
export function engineArgs(dir: string, r: WinEngineRequest, port: number): string[] {
  const models = join(dir, "models");
  const draft =
    r.draft && /^[A-Za-z0-9_.-]+\.gguf$/.test(r.draft)
      ? [
          "--spec-type",
          "draft-simple",
          "-md",
          join(models, r.draft),
          "-ngld",
          "99",
          "--spec-draft-n-max",
          "8",
          "--spec-draft-p-min",
          "0.75",
        ]
      : [];
  const template =
    r.template &&
    /^[A-Za-z0-9_.-]+\.jinja$/.test(r.template) &&
    existsSync(join(dir, "templates", r.template))
      ? ["--chat-template-file", join(dir, "templates", r.template)]
      : [];
  return [
    "-m",
    join(models, r.model ?? ""),
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "-c",
    String(r.ctx),
    "--parallel",
    String(r.parallel),
    "--slot-save-path",
    join(dir, "kv"),
    "--swa-full",
    "--kv-unified",
    "--jinja",
    // SSD stream: llama.cpp fits the layers itself (--fit, its default); otherwise all on the GPU.
    ...(r.fit === "1" ? [] : ["--n-gpu-layers", "999"]),
    ...safeArgs(r.args),
    ...draft,
    ...template,
  ];
}

/**
 * llama-server's environment for a request: «next layer ahead» (G32.2) is switched on by
 * LLAMA_MOE_PREFETCH=1, which only RedGiant's patched build reads (the Windows launcher's rule).
 */
export function engineEnv(
  r: WinEngineRequest,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.LLAMA_MOE_PREFETCH;
  if (r.prefetch === "1" && r.flavor === "cuda") env.LLAMA_MOE_PREFETCH = "1";
  return env;
}

/** What macOS can hand out now, from vm_stat: free, inactive, speculative and purgeable pages. */
export function parseVmStat(text: string): number | undefined {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return undefined;
  const pages = (name: string) =>
    Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  return (
    ((pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * size) / GB
  );
}

const run = (file: string, args: string[]) =>
  new Promise<string>((ok) =>
    execFile(file, args, { timeout: 5000 }, (err, out) => ok(err ? "" : String(out))),
  );

export interface NativeLauncherOptions {
  /** The engine's folder (models/, kv/, bin/, templates/ and the three files). */
  dir: string;
  build?: string;
  port?: number;
  pollMs?: number;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** llama.cpp's releases (a mirror, or a fake one in tests). */
  releases?: string;
}

export class NativeLauncher {
  private timers: NodeJS.Timeout[] = [];
  private lastId: string | undefined;
  private generation = 0;
  private server: ChildProcess | undefined;
  private tail: string[] = [];

  constructor(private readonly o: NativeLauncherOptions) {}

  private get port(): number {
    return this.o.port ?? 8091;
  }

  private get bin(): string {
    return join(this.o.dir, "bin", "current");
  }

  start(): void {
    void Promise.all(
      ["models", "kv", "bin", "templates"].map((d) =>
        mkdir(join(this.o.dir, d), { recursive: true }),
      ),
    ).catch(() => {});
    this.timers.push(setInterval(() => void this.check().catch(() => {}), this.o.pollMs ?? 1000));
    this.timers.push(setInterval(() => void this.memory().catch(() => {}), 5000));
    void this.memory().catch(() => {});
  }

  /** The engine stops with RedGiant. */
  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.generation++;
    this.kill();
  }

  private kill(): void {
    if (this.server && this.server.exitCode === null) this.server.kill();
    this.server = undefined;
  }

  private async status(gen: number, s: Omit<WinEngineStatus, "id"> & { id: string }) {
    if (gen !== this.generation) return;
    const file = join(this.o.dir, "engine-status.json");
    await writeFile(`${file}.tmp`, JSON.stringify(s));
    await rename(`${file}.tmp`, file);
  }

  private async memory(): Promise<void> {
    const available =
      this.o.platform === "darwin" || (!this.o.platform && process.platform === "darwin")
        ? parseVmStat(await run("vm_stat", []))
        : undefined;
    let engine = 0;
    const pid = this.server?.exitCode === null ? this.server.pid : undefined;
    if (pid)
      engine =
        (Number((await run("ps", ["-o", "rss=", "-p", String(pid)])).trim()) * 1024) / GB || 0;
    const file = join(this.o.dir, "memory.json");
    await writeFile(
      `${file}.tmp`,
      JSON.stringify({
        totalGb: round(totalmem() / GB),
        availableGb: round(available ?? totalmem() / GB / 2),
        engineGb: round(engine),
      }),
    );
    await rename(`${file}.tmp`, file);
  }

  private async check(): Promise<void> {
    const text = await readFile(join(this.o.dir, "engine.json"), "utf8").catch(() => undefined);
    if (!text) return;
    const r = JSON.parse(text) as WinEngineRequest;
    if (!r.id || r.id === this.lastId) return;
    this.lastId = r.id;
    const gen = ++this.generation;
    this.kill();
    void this.handle(gen, r);
  }

  private async handle(gen: number, r: WinEngineRequest): Promise<void> {
    if (!r.model) {
      await this.status(gen, { id: r.id, state: "stopped" });
      return;
    }
    let phase = "download";
    try {
      const build = this.o.build ?? r.build;
      const marker = join(this.bin, "build.txt");
      const ready =
        existsSync(join(this.bin, "llama-server")) &&
        (await readFile(marker, "utf8").catch(() => "")).trim() === build;
      if (!ready) await this.download(gen, r.id, build);
      if (gen !== this.generation) return;
      await this.status(gen, { id: r.id, state: "starting" });
      phase = "preload";
      if (r.preload === "1") await this.preload(gen, r.id, r.model);
      if (gen !== this.generation) return;
      phase = "start";
      this.tail = [];
      const p = spawn(join(this.bin, "llama-server"), engineArgs(this.o.dir, r, this.port), {
        cwd: this.bin,
        env: engineEnv(r),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.server = p;
      const keep = (b: Buffer) => {
        for (const line of b.toString().split("\n")) if (line) this.tail.push(line);
        if (this.tail.length > 60) this.tail.splice(0, this.tail.length - 60);
      };
      p.stdout?.on("data", keep);
      p.stderr?.on("data", keep);
      await this.status(gen, { id: r.id, state: "loading" });
      for (;;) {
        await new Promise((ok) => setTimeout(ok, this.o.pollMs ?? 1000));
        if (gen !== this.generation) return;
        const log = this.tail.join("\n");
        if (log.includes("no usable GPU found")) {
          this.kill();
          await this.status(gen, { id: r.id, state: "failed", error: "no_gpu", log });
          return;
        }
        if (p.exitCode !== null || p.signalCode !== null) {
          await this.status(gen, { id: r.id, state: "failed", log });
          return;
        }
        const healthy = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(2000),
        }).then(
          (x) => x.ok,
          () => false,
        );
        if (healthy) {
          await this.status(gen, { id: r.id, state: "ready", port: this.port });
          return;
        }
      }
    } catch (err) {
      await this.status(gen, {
        id: r.id,
        state: "failed",
        error: phase,
        log: `${(err as Error).message}\n${this.tail.join("\n")}`,
      }).catch(() => {});
    }
  }

  /** llama.cpp's build for this system, into bin/current, with its progress on the status. */
  private async download(gen: number, id: string, build: string): Promise<void> {
    const asset = engineAsset(build, this.o.platform, this.o.arch);
    if (!asset)
      throw new Error(`llama.cpp has no ready build for ${process.platform} ${process.arch}`);
    const base = (
      this.o.releases ?? "https://github.com/ggml-org/llama.cpp/releases/download"
    ).replace(/\/+$/, "");
    const res = await fetch(`${base}/${build}/${asset}`);
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status} for ${asset}`);
    const total = Number(res.headers.get("content-length")) || undefined;
    const fresh = join(this.o.dir, "bin", `${build}.part`);
    await rm(fresh, { recursive: true, force: true });
    await mkdir(fresh, { recursive: true });
    const archive = join(fresh, asset);
    let done = 0;
    let last = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on("data", (b: Buffer) => {
      done += b.length;
      if (Date.now() - last > 500) {
        last = Date.now();
        void this.status(gen, { id, state: "downloading", done, ...(total && { total }) }).catch(
          () => {},
        );
      }
    });
    await pipeline(body, createWriteStream(archive));
    await new Promise<void>((ok, ko) => {
      const t = spawn("tar", ["-xzf", asset], { cwd: fresh, stdio: "ignore" });
      t.once("error", ko);
      t.once("exit", (c) => (c === 0 ? ok() : ko(new Error(`tar exited with ${c}`))));
    });
    await rm(archive, { force: true });
    // The program may sit in a folder of the archive: its folder becomes the engine's.
    const found = await find(fresh, "llama-server");
    if (!found) throw new Error(`llama-server is not in ${asset}`);
    await rm(this.bin, { recursive: true, force: true });
    await rename(dirname(found), this.bin);
    await rm(fresh, { recursive: true, force: true });
    await writeFile(join(this.bin, "build.txt"), build);
  }

  /** The model read once before the engine starts: it stays in the system's cache. */
  private async preload(gen: number, id: string, model: string): Promise<void> {
    const parts = modelParts(join(this.o.dir, "models"), model);
    let total = 0;
    for (const f of parts) total += (await stat(f)).size;
    let done = 0;
    let last = 0;
    for (const f of parts) {
      for await (const chunk of createReadStream(f, { highWaterMark: 16 << 20 })) {
        done += (chunk as Buffer).length;
        if (gen !== this.generation) return;
        if (Date.now() - last > 500) {
          last = Date.now();
          await this.status(gen, { id, state: "preloading", done, total });
        }
      }
    }
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
