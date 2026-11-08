// Embeddings and reranking on this computer (G36.2): llama.cpp's own server in embedding or
// rerank mode, started by RedGiant next to itself (like whisper.cpp in local-voice.ts), on
// 127.0.0.1 and a free port. Its program (llama.cpp's CPU build, 12-25 MB, or the Vulkan one when
// the person wants the graphics card) and the model (a GGUF from Hugging Face) come down once,
// with their bar, and are checked: the program against the sha256 GitHub publishes for it (fixed
// here), the model against the sha256 Hugging Face keeps for the file. Few threads by default, so
// indexing never takes the whole processor; the server stops after a while without work.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  LOCAL_EMBEDDING_MODELS,
  LOCAL_RERANK_MODELS,
  type LocalEmbeddingModel,
  type LocalRerankModel,
} from "@redgiant/protocol";
import { freePort } from "../embedded-db.js";
import { JobFailure, type JobHandle, type Jobs } from "../jobs.js";
import { WIN_ENGINE_BUILD } from "../win-engine.js";

/** The llama.cpp release used here: the same one as the chat engine. */
export const LLAMA_EMBED_BUILD = WIN_ENGINE_BUILD;

/** sha256 of each program archive of release b12034 (GitHub's `digest`, 2026-11-07). */
export const LLAMA_ASSETS: Readonly<Record<string, { file: string; sha256: string }>> = {
  "win32-x64": {
    file: "llama-b12034-bin-win-cpu-x64.zip",
    sha256: "16c38cd9ff7487bf118a37808784245a2d639d844110f21fe9b373aaa40ff511",
  },
  "win32-arm64": {
    file: "llama-b12034-bin-win-cpu-arm64.zip",
    sha256: "4d359c9236c362b34d97d30450743a1731981dd3e1788bf9e491c69f7fa7fefa",
  },
  "win32-x64-gpu": {
    file: "llama-b12034-bin-win-vulkan-x64.zip",
    sha256: "df6ab37942d02aeb8ab3de5984711ea866826a94d50f7a9c5960a0d18a9d4269",
  },
  "win32-arm64-gpu": {
    file: "llama-b12034-bin-win-vulkan-arm64.zip",
    sha256: "6edc6140eaddaea1e0cdbc30e24b542bae4c2621d7ab6321638525887e639c47",
  },
  "linux-x64": {
    file: "llama-b12034-bin-ubuntu-x64.tar.gz",
    sha256: "b2c898e15db0da9433de7779e6faee9f4f6801a5c1ed1308a38bf30e492e983b",
  },
  "linux-arm64": {
    file: "llama-b12034-bin-ubuntu-arm64.tar.gz",
    sha256: "ed19b95e95c9bdf42bdf88d9930400f648bf619a5f48b4bb7b5ab2d7d365aef9",
  },
  "linux-x64-gpu": {
    file: "llama-b12034-bin-ubuntu-vulkan-x64.tar.gz",
    sha256: "18e0524d245fbf4395421a73ed9fc7c911b2c081aaf1a24a708512fcc49e6144",
  },
  "linux-arm64-gpu": {
    file: "llama-b12034-bin-ubuntu-vulkan-arm64.tar.gz",
    sha256: "8cd30402acc619d5d5aa1ac03f3af2157c4744a7e5346a0ea09c064de69d24a1",
  },
  // Metal is in the macOS builds: the same archive with or without the card.
  "darwin-arm64": {
    file: "llama-b12034-bin-macos-arm64.tar.gz",
    sha256: "ce1893ad52bd5db86227624d1777ccc0f2b211d1621cfcd393a886dbd2ac1d9b",
  },
  "darwin-x64": {
    file: "llama-b12034-bin-macos-x64.tar.gz",
    sha256: "79f1e86d763d2670a683aff0aa28d2547023f84d63d50cac21c3084f14d15c79",
  },
};

export function llamaAsset(
  gpu: boolean,
  platform: string = process.platform,
  arch: string = process.arch,
): { file: string; sha256: string; key: string } | undefined {
  const key = `${platform}-${arch}${gpu && platform !== "darwin" ? "-gpu" : ""}`;
  const a = LLAMA_ASSETS[key];
  return a && { ...a, key };
}

/** Threads for the local models: half the processor, at most 4 (0 = decide). */
export function embedThreads(wanted = 0, cores = availableParallelism()): number {
  if (wanted > 0) return Math.max(1, Math.min(wanted, cores));
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export type LocalRole = "embed" | "rerank";
type AnyModel = LocalEmbeddingModel | LocalRerankModel;

/** The arguments of llama.cpp's server for a model in one role (pure, tested). */
export function llamaArgs(o: {
  model: string;
  role: LocalRole;
  pooling?: LocalEmbeddingModel["pooling"];
  port: number;
  threads: number;
  gpu: boolean;
}): string[] {
  // Two slots of 2048 tokens: a piece (≤ 1800 characters) always fits, and embedding models need
  // the whole input in one micro-batch (they are not causal).
  return [
    "-m",
    o.model,
    o.role === "embed" ? "--embedding" : "--reranking",
    ...(o.role === "embed" && o.pooling ? ["--pooling", o.pooling] : []),
    "-c",
    "4096",
    "--parallel",
    "2",
    "-b",
    "2048",
    "-ub",
    "2048",
    "-t",
    String(o.threads),
    "-tb",
    String(o.threads),
    "--n-gpu-layers",
    o.gpu ? "999" : "0",
    "--host",
    "127.0.0.1",
    "--port",
    String(o.port),
    "--no-webui",
  ];
}

const run = promisify(execFile);

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** Downloads `url` to `dest` (resuming a `.part`), with the bar and an sha256 check. */
export async function download(
  url: string,
  dest: string,
  sha256: string | undefined,
  h: JobHandle,
): Promise<void> {
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const have = await stat(part).then(
    (s) => s.size,
    () => 0,
  );
  const r = await fetch(url, {
    signal: h.signal,
    ...(have > 0 && { headers: { range: `bytes=${have}-` } }),
  });
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  const resumed = r.status === 206;
  const start = resumed ? have : 0;
  const length = Number(r.headers.get("content-length")) || 0;
  const total = length ? start + length : null;
  let done = start;
  h.progress(done, total);
  const body = Readable.fromWeb(r.body as never);
  body.on("data", (b: Buffer) => {
    done += b.length;
    h.progress(done, total);
  });
  await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }));
  if (sha256) {
    const got = await sha256File(part);
    if (got !== sha256) {
      await rm(part, { force: true });
      throw new JobFailure("checksum", `${url}: sha256 ${got}, expected ${sha256}`);
    }
  }
  await rename(part, dest);
}

/** The sha256 Hugging Face keeps for a file (LFS), to check what came down. */
async function hfSha256(
  repo: string,
  file: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, {
    ...(signal && { signal }),
  }).catch(() => undefined);
  if (!r?.ok) return undefined;
  const list = (await r.json().catch(() => [])) as { path: string; lfs?: { oid?: string } }[];
  return Array.isArray(list) ? list.find((f) => f.path === file)?.lfs?.oid : undefined;
}

async function findProgram(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  for (const e of entries)
    if (e.isDirectory()) {
      const found = await findProgram(join(dir, e.name), name);
      if (found) return found;
    }
  return undefined;
}

interface Running {
  key: string;
  proc: ChildProcess;
  url: string;
  log: string[];
  lastUse: number;
}

export interface LocalEmbedOptions {
  dataDir: string;
  jobs: Jobs;
  /** Stop a server after this long without requests (default 10 minutes). */
  idleMs?: number;
  platform?: string;
  arch?: string;
}

/**
 * llama.cpp's servers for the knowledge: at most one embedding and one rerank server, started on
 * the first request and stopped when idle. `url(role, id)` gives the OpenAI-style base address.
 */
export class LocalEmbedServers {
  private readonly running = new Map<LocalRole, Running>();
  private readonly starting = new Map<LocalRole, Promise<string>>();
  private readonly downloads = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  /** Threads (0 = decide) and the graphics card, from the knowledge settings. */
  threads = 0;

  constructor(private readonly o: LocalEmbedOptions) {}

  private get platform() {
    return this.o.platform ?? process.platform;
  }

  programDir(gpu: boolean): string {
    return join(this.o.dataDir, "tools", "llama", `${LLAMA_EMBED_BUILD}${gpu ? "-gpu" : ""}`);
  }

  modelPath(m: AnyModel): string {
    return join(this.o.dataDir, "models", "knowledge", m.file);
  }

  static model(role: LocalRole, id: string): AnyModel | undefined {
    return role === "embed"
      ? LOCAL_EMBEDDING_MODELS.find((m) => m.id === id)
      : LOCAL_RERANK_MODELS.find((m) => m.id === id);
  }

  /** Whether the program and the model are here already (no download needed). */
  async ready(role: LocalRole, id: string, gpu: boolean): Promise<boolean> {
    const m = LocalEmbedServers.model(role, id);
    if (!m || !existsSync(this.modelPath(m))) return false;
    return (await this.program(gpu)) !== undefined;
  }

  private async program(gpu: boolean): Promise<string | undefined> {
    const name = this.platform === "win32" ? "llama-server.exe" : "llama-server";
    return findProgram(this.programDir(gpu), name);
  }

  /**
   * Downloads what is missing as one job with its bar (`download_knowledge_model`): the program,
   * then the model. Calls at the same time share it.
   */
  ensure(owner: string, role: LocalRole, id: string, gpu: boolean): Promise<void> {
    const m = LocalEmbedServers.model(role, id);
    if (!m) return Promise.reject(new JobFailure("unknown_model", `Unknown local model ${id}`));
    const key = `${role}:${id}:${gpu}`;
    const going = this.downloads.get(key);
    if (going) return going;
    const p = (async () => {
      if (await this.ready(role, id, gpu)) return;
      const job = this.o.jobs.start(
        owner,
        "download_knowledge_model",
        ["tool_download", "model_download"],
        async (h) => {
          h.step("tool_download");
          if (!(await this.program(gpu))) await this.downloadProgram(gpu, h);
          h.step("model_download");
          const dest = this.modelPath(m);
          if (!existsSync(dest)) {
            const sha = await hfSha256(m.repo, m.file, h.signal);
            await download(`https://huggingface.co/${m.repo}/resolve/main/${m.file}`, dest, sha, h);
          }
        },
        { model: m.name, size: `${m.sizeMb} MB` },
      );
      const end = await this.o.jobs.settled(job.id, 500);
      if (end?.state !== "done")
        throw new JobFailure(
          end?.error?.code ?? "download_failed",
          end?.error?.message ?? `${m.name} did not download`,
        );
    })().finally(() => this.downloads.delete(key));
    this.downloads.set(key, p);
    return p;
  }

  private async downloadProgram(gpu: boolean, h: JobHandle): Promise<void> {
    const asset = llamaAsset(gpu, this.platform, this.o.arch ?? process.arch);
    if (!asset)
      throw new JobFailure(
        "unsupported_system",
        `llama.cpp publishes no ${gpu ? "Vulkan" : "CPU"} build for ${this.platform} ${this.o.arch ?? process.arch}`,
      );
    const dir = this.programDir(gpu);
    const archive = `${dir}.download`;
    await download(
      `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_EMBED_BUILD}/${asset.file}`,
      archive,
      asset.sha256,
      h,
    );
    const fresh = `${dir}.part`;
    await rm(fresh, { recursive: true, force: true });
    await mkdir(fresh, { recursive: true });
    // bsdtar on Windows 10+ and macOS reads zip too; GNU tar on Linux reads the .tar.gz.
    await run("tar", ["-xf", archive, "-C", fresh], { windowsHide: true });
    await rm(archive, { force: true });
    await rm(dir, { recursive: true, force: true });
    await rename(fresh, dir);
  }

  /** The server's base address (`http://127.0.0.1:<port>/v1`), started if needed. */
  url(role: LocalRole, id: string, gpu = false): Promise<string> {
    const key = `${id}:${gpu}`;
    const r = this.running.get(role);
    if (r && r.key === key && r.proc.exitCode === null && !r.proc.killed) {
      r.lastUse = Date.now();
      return Promise.resolve(r.url);
    }
    const going = this.starting.get(role);
    if (going) return going;
    const p = this.start(role, id, gpu).finally(() => this.starting.delete(role));
    this.starting.set(role, p);
    return p;
  }

  private async start(role: LocalRole, id: string, gpu: boolean): Promise<string> {
    this.stop(role);
    const m = LocalEmbedServers.model(role, id);
    if (!m) throw new JobFailure("unknown_model", `Unknown local model ${id}`);
    const program = await this.program(gpu);
    const model = this.modelPath(m);
    if (!program || !existsSync(model))
      throw new JobFailure("not_downloaded", `${m.name} is not downloaded yet`);
    const port = await freePort();
    const args = llamaArgs({
      model,
      role,
      ...("pooling" in m && { pooling: m.pooling }),
      port,
      threads: embedThreads(this.threads),
      gpu,
    });
    const bin = dirname(program);
    const proc = spawn(program, args, {
      cwd: bin,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // The archive's own libraries next to the program (Linux).
        LD_LIBRARY_PATH: [bin, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    });
    const log: string[] = [];
    const keep = (b: Buffer) => {
      for (const line of b.toString("utf8").split(/\r?\n/)) if (line) log.push(line);
      if (log.length > 80) log.splice(0, log.length - 80);
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    const base = `http://127.0.0.1:${port}`;
    const running: Running = {
      key: `${id}:${gpu}`,
      proc,
      url: `${base}/v1`,
      log,
      lastUse: Date.now(),
    };
    this.running.set(role, running);
    // Loading a model of a few hundred MB takes seconds; four minutes covers slow disks.
    for (let i = 0; i < 480; i++) {
      if (proc.exitCode !== null)
        throw new JobFailure("engine_stopped", `llama.cpp stopped: ${log.slice(-5).join(" | ")}`);
      const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) {
        this.watchIdle();
        return running.url;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop(role);
    throw new JobFailure("engine_timeout", "llama.cpp did not answer in time");
  }

  private watchIdle() {
    if (this.timer) return;
    const idle = this.o.idleMs ?? 10 * 60_000;
    this.timer = setInterval(
      () => {
        for (const [role, r] of this.running) if (Date.now() - r.lastUse > idle) this.stop(role);
        if (this.running.size === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      },
      Math.min(60_000, idle),
    );
    this.timer.unref?.();
  }

  /** Marks a server as used (a long batch keeps it alive). */
  touch(role: LocalRole) {
    const r = this.running.get(role);
    if (r) r.lastUse = Date.now();
  }

  /** Last lines of a server's log (for an error on the page). */
  log(role: LocalRole): string[] {
    return [...(this.running.get(role)?.log ?? [])];
  }

  stop(role?: LocalRole) {
    for (const [k, r] of this.running) {
      if (role && k !== role) continue;
      r.proc.kill();
      this.running.delete(k);
    }
  }
}
