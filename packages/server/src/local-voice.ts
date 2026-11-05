// Voice messages on this computer (RedGiant 3.0, 2026-11-05): whisper.cpp's own server, no Docker
// and no account. Its program (a few MB) and a multilingual model come down once into the data
// folder, with their bar; the server then runs on 127.0.0.1 and RedGiant talks to it like any
// OpenAI-compatible transcription service. whisper.cpp reads WAV, MP3, FLAC and Ogg/Vorbis only, so
// other voice notes are decoded here first (`forWhisperCpp`): Ogg/Opus (Telegram, WhatsApp,
// Discord) and WebM/Opus (browsers, Slack) in WASM, AAC/M4A/MP4 (Signal, iPhone) with ffmpeg if
// this computer has it: there is no maintained, MIT-compatible AAC decoder for Node.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
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

/** What a recording really is, from its first bytes (the declared type is often wrong). */
export type AudioKind =
  | "wav"
  | "mp3"
  | "flac"
  | "ogg-opus"
  | "ogg-vorbis"
  | "ogg"
  | "webm"
  | "mp4"
  | "aac"
  | "unknown";

export function sniffAudio(data: Uint8Array): AudioKind {
  const ascii = (from: number, to: number) =>
    Buffer.from(data.subarray(from, to)).toString("latin1");
  if (ascii(0, 4) === "OggS") {
    // The first packet of the first page names the codec.
    const first = 27 + (data[26] ?? 0);
    if (ascii(first, first + 8) === "OpusHead") return "ogg-opus";
    if (ascii(first, first + 7) === "\x01vorbis") return "ogg-vorbis";
    return "ogg";
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "webm";
  if (ascii(4, 8) === "ftyp") return "mp4";
  const b1 = data[1] ?? 0;
  if (data[0] === 0xff && (b1 & 0xf6) === 0xf0) return "aac"; // ADTS: layer bits 00
  if (data[0] === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x06) !== 0) return "mp3";
  return "unknown";
}

/** Reads an EBML number: IDs keep their length marker, sizes lose it (all ones: unknown). */
function ebml(data: Uint8Array, pos: number, keepMarker: boolean) {
  const first = data[pos];
  if (first === undefined || first === 0) return undefined;
  const len = Math.clz32(first) - 23;
  if (pos + len > data.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> len);
  let ones = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const b = data[pos + i] ?? 0;
    value = value * 256 + b;
    ones &&= b === 0xff;
  }
  return { len, value: !keepMarker && ones ? undefined : value };
}

/** Master elements walked into: Segment, Cluster, Tracks, TrackEntry, BlockGroup. */
const EBML_MASTERS = new Set([0x18538067, 0x1f43b675, 0x1654ae6b, 0xae, 0xa0]);

/**
 * The Opus packets of a WebM/Matroska recording (MediaRecorder, Slack). A flat walk, so the
 * unknown-size Segment and Clusters that browsers write while recording need no special case.
 */
export function webmOpusPackets(data: Uint8Array): { head: Uint8Array; packets: Uint8Array[] } {
  const tracks: { number?: number; codec?: string; head?: Uint8Array }[] = [];
  const blocks: { track: number; data: Uint8Array }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const id = ebml(data, pos, true);
    const size = id && ebml(data, pos + id.len, false);
    const tag = id?.value;
    if (!id || tag === undefined || !size) break;
    pos += id.len + size.len;
    if (EBML_MASTERS.has(tag)) {
      if (tag === 0xae) tracks.push({});
      continue;
    }
    if (size.value === undefined || pos + size.value > data.length) break; // cut off at the end
    const body = data.subarray(pos, pos + size.value);
    pos += size.value;
    const track = tracks.at(-1);
    if (tag === 0xd7 && track) track.number = body.reduce((n, b) => n * 256 + b, 0);
    else if (tag === 0x86 && track) track.codec = Buffer.from(body).toString("latin1");
    else if (tag === 0x63a2 && track) track.head = body;
    else if (tag === 0xa3 || tag === 0xa1) {
      // SimpleBlock / Block: track number, 16-bit time, flags, then the frame.
      const t = ebml(body, 0, false);
      if (!t || t.value === undefined) continue;
      if (((body[t.len + 2] ?? 0) & 0x06) !== 0) throw new Error("laced WebM blocks");
      blocks.push({ track: t.value, data: body.subarray(t.len + 3) });
    }
  }
  const opus = tracks.find((t) => t.codec === "A_OPUS");
  if (!opus) throw new Error(`no Opus track (${tracks.map((t) => t.codec).join(", ") || "none"})`);
  if (!opus.head || Buffer.from(opus.head.subarray(0, 8)).toString("latin1") !== "OpusHead")
    throw new Error("the Opus track has no OpusHead");
  return {
    head: opus.head,
    packets: blocks.filter((b) => b.track === opus.number).map((b) => b.data),
  };
}

/** A WebM/Opus recording (browsers, Slack) as WAV. */
export async function webmOpusToWav(data: Uint8Array): Promise<Uint8Array> {
  const { head, packets } = webmOpusPackets(data);
  const channels = head[9] ?? 1;
  const family = head[18] ?? 0;
  const { OpusDecoder } = await import("opus-decoder");
  const d = new OpusDecoder({
    channels,
    preSkip: (head[10] ?? 0) | ((head[11] ?? 0) << 8),
    ...(family !== 0 && {
      streamCount: head[19] ?? 1,
      coupledStreamCount: head[20] ?? 0,
      channelMappingTable: Array.from(head.subarray(21, 21 + channels)),
    }),
  });
  await d.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = d.decodeFrames(packets);
    if (samplesDecoded === 0) throw new Error("no audio in the recording");
    return toWav16k(channelData, sampleRate);
  } finally {
    d.free();
  }
}

/**
 * Any format ffmpeg reads, as WAV; `undefined` when this computer has no ffmpeg. Through files,
 * not pipes: an M4A often keeps its index at the end, which ffmpeg cannot reach on a pipe.
 */
export async function ffmpegToWav(
  data: Uint8Array,
  program = process.env.REDGIANT_FFMPEG || "ffmpeg",
): Promise<Uint8Array | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "redgiant-voice-"));
  try {
    const input = join(dir, "in");
    const output = join(dir, "out.wav");
    await writeFile(input, data);
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input];
    args.push("-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", output);
    const missing = await new Promise<boolean>((ok, fail) =>
      execFile(program, args, { timeout: 120_000, windowsHide: true }, (err, _out, stderr) => {
        if (!err) ok(false);
        else if ((err as NodeJS.ErrnoException).code === "ENOENT") ok(true);
        else fail(new Error(String(stderr).trim().split("\n").at(-1) || err.message));
      }),
    );
    return missing ? undefined : new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const KIND_NAMES: Partial<Record<AudioKind, string>> = {
  webm: "WebM",
  mp4: "M4A/MP4",
  aac: "AAC",
  ogg: "Ogg",
};

/**
 * A recording in a format whisper.cpp reads (WAV, MP3, FLAC, Ogg/Vorbis): those pass as they
 * are, Opus is decoded in WASM, the rest goes through ffmpeg when there is one. Errors carry a
 * message meant for the user.
 */
export async function forWhisperCpp(
  data: Uint8Array,
  mime: string,
  /** The ffmpeg program, or how to get it (downloaded the first time it is needed). */
  opts: { ffmpeg?: string | (() => Promise<string | undefined>) } = {},
): Promise<{ audio: Uint8Array; type: string }> {
  const kind = sniffAudio(data);
  const passes = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    "ogg-vorbis": "audio/ogg",
  };
  if (kind in passes) return { audio: data, type: passes[kind as keyof typeof passes] };
  const wav = (audio: Uint8Array) => ({ audio, type: "audio/wav" });
  let failure: Error | undefined;
  if (kind === "ogg-opus" || kind === "webm") {
    try {
      return wav(await (kind === "ogg-opus" ? oggOpusToWav(data) : webmOpusToWav(data)));
    } catch (err) {
      failure = err as Error; // ffmpeg may still read it (e.g. WebM with Vorbis)
    }
  }
  let converted: Uint8Array | undefined;
  try {
    let program = opts.ffmpeg;
    if (typeof program === "function")
      program = await program().catch((err) => {
        throw new Error(`ffmpeg could not be downloaded (${(err as Error).message})`);
      });
    converted = await ffmpegToWav(data, program);
  } catch (err) {
    throw new Error(`This voice note could not be decoded: ${(err as Error).message}`);
  }
  if (converted) return wav(converted);
  if (failure) throw new Error(`This voice note could not be decoded: ${failure.message}`);
  const name = KIND_NAMES[kind] ?? (mime || "this format");
  throw new Error(
    `Voice notes in ${name} need ffmpeg, and there is none for this computer: install ffmpeg (or set REDGIANT_FFMPEG), or use an online transcription service`,
  );
}
