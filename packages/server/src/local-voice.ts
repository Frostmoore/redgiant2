// Voice messages on this computer (RedGiant 3.0, 2026-11-05): whisper.cpp's own server, no Docker
// and no account. Its program (a few MB) and a multilingual model come down once into the data
// folder, with their bar; the server then runs on 127.0.0.1 and RedGiant talks to it like any
// OpenAI-compatible transcription service. whisper.cpp reads WAV, so voice notes in Ogg/Opus
// (Telegram, WhatsApp, Discord) are decoded here first (see `toWav`).

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { JobHandle, Jobs } from "./jobs.js";

/** whisper.cpp's release with prebuilt programs (later tags often have none). */
export const WHISPER_BUILD = "b5130";
/** Multilingual and fast enough on a CPU: Whisper large-v3-turbo, quantised (547 MB). */
export const WHISPER_MODEL = "ggml-large-v3-turbo-q5_0.bin";

const exe = process.platform === "win32" ? ".exe" : "";

/** The prebuilt program for this system, if whisper.cpp publishes one. */
export function whisperAsset(platform = process.platform, arch = process.arch): string | undefined {
  if (platform === "win32" && arch === "x64") return "whisper-bin-x64.zip";
  if (platform === "linux" && arch === "x64") return "whisper-bin-ubuntu-x64.tar.gz";
  return undefined;
}

async function download(url: string, file: string, h: JobHandle): Promise<void> {
  const r = await fetch(url, { signal: h.signal });
  if (!r.ok || !r.body) throw new Error(`${url} answered ${r.status}`);
  const total = Number(r.headers.get("content-length")) || null;
  let done = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on("data", (b: Buffer) => {
    done += b.length;
    h.progress(done, total);
  });
  await pipeline(body, createWriteStream(`${file}.part`));
  await rename(`${file}.part`, file);
}

/** Finds a file anywhere under a folder (the archives nest their programs differently). */
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

export class LocalWhisper {
  private proc: ChildProcess | undefined;
  private url: string | undefined;

  constructor(private readonly dataDir: string) {}

  get dir(): string {
    return join(this.dataDir, "tools", "whisper", WHISPER_BUILD);
  }

  private async program(): Promise<string | undefined> {
    return existsSync(this.dir) ? find(this.dir, `whisper-server${exe}`) : undefined;
  }

  private get model(): string {
    return join(this.dataDir, "tools", "whisper", WHISPER_MODEL);
  }

  /** Program and model here already: nothing to download. */
  async ready(): Promise<boolean> {
    return Boolean(await this.program()) && existsSync(this.model);
  }

  /** Downloads what is missing, as a job with its bar (`download_whisper`). */
  async ensure(jobs: Jobs, owner: string): Promise<void> {
    if (await this.ready()) return;
    const asset = whisperAsset();
    if (!asset) throw new Error("whisper.cpp has no ready program for this computer");
    const job = jobs.start(
      owner,
      "download_whisper",
      ["tool_download", "model_download"],
      async (h) => {
        h.step("tool_download");
        if (!(await this.program())) {
          const part = `${this.dir}.part`;
          await rm(part, { recursive: true, force: true });
          await mkdir(part, { recursive: true });
          const archive = join(part, asset);
          await download(
            `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_BUILD}/${asset}`,
            archive,
            h,
          );
          // The system's tar unpacks both (Windows 10 and later read zip with it too).
          await new Promise<void>((ok, ko) => {
            const t = spawn("tar", ["-xf", asset], {
              cwd: part,
              stdio: "ignore",
              windowsHide: true,
            });
            t.once("error", ko);
            t.once("exit", (c) => (c === 0 ? ok() : ko(new Error(`tar exited with ${c}`))));
          });
          await rm(archive, { force: true });
          await rm(this.dir, { recursive: true, force: true });
          await rename(part, this.dir);
        } else h.skip("tool_download");
        h.step("model_download");
        if (!existsSync(this.model))
          await download(
            `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}`,
            this.model,
            h,
          );
      },
    );
    const end = await jobs.settled(job.id, 500);
    if (end?.state !== "done")
      throw new Error(end?.error?.message ?? "whisper.cpp did not download");
  }

  /** Starts whisper.cpp's server on this computer; returns its OpenAI-style base URL. */
  async start(port: number): Promise<string> {
    if (this.url && this.proc?.exitCode === null) return this.url;
    const program = await this.program();
    if (!program || !existsSync(this.model)) throw new Error("whisper.cpp is not downloaded yet");
    this.proc = spawn(
      program,
      [
        "-m",
        this.model,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        // The path OpenAI-compatible clients call.
        "--inference-path",
        "/v1/audio/transcriptions",
        "-t",
        String(Math.max(1, Math.min(8, cpus().length - 1))),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
      if (this.proc.exitCode !== null) throw new Error("whisper.cpp's server stopped at start");
      const up = await fetch(base, { signal: AbortSignal.timeout(1000) }).then(
        () => true,
        () => false,
      );
      if (up) {
        this.url = `${base}/v1`;
        return this.url;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("whisper.cpp's server did not answer");
  }

  stop(): void {
    this.proc?.kill();
    this.proc = undefined;
    this.url = undefined;
  }
}

/** PCM channels as a 16 kHz mono 16-bit WAV: what whisper.cpp wants. */
export function toWav16k(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float32Array(frames);
  for (const c of channels)
    for (let i = 0; i < frames; i++) mono[i] = (mono[i] ?? 0) + (c[i] ?? 0) / channels.length;
  const ratio = sampleRate / 16000;
  const n = Math.floor(frames / ratio);
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // Linear interpolation between the two nearest samples.
    const x = i * ratio;
    const a = Math.floor(x);
    const v = (mono[a] ?? 0) + ((mono[a + 1] ?? mono[a] ?? 0) - (mono[a] ?? 0)) * (x - a);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return out;
}

/** An Ogg/Opus voice note (Telegram, WhatsApp, Discord) as WAV. */
export async function oggOpusToWav(data: Uint8Array): Promise<Uint8Array> {
  const { OggOpusDecoder } = await import("ogg-opus-decoder");
  const d = new OggOpusDecoder();
  await d.ready;
  try {
    const { channelData, sampleRate } = await d.decodeFile(data);
    return toWav16k(channelData, sampleRate);
  } finally {
    d.free();
  }
}
