import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.js";
import {
  forWhisperCpp,
  LocalWhisper,
  toWav16k,
  WHISPER_NODE_VERSION,
  whisperAsset,
  whisperUrl,
  whisperWorker,
} from "../src/local-voice.js";

const saved = { ...process.env };
let worker: ChildProcess | undefined;
afterEach(() => {
  process.env = { ...saved };
  worker?.kill();
  worker = undefined;
});

/** A tar archive with one file, as npm packs it (`package/<name>`). */
function tgz(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(`package/${name}`, 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
  );
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, data, pad, Buffer.alloc(1024)]));
}

describe("voice notes on a Mac (2026-11-05)", () => {
  it("takes the prebuilt Node binding from npm on a Mac, whisper.cpp's programs elsewhere", () => {
    const table: [NodeJS.Platform, string, string | undefined][] = [
      ["win32", "x64", "whisper-bin-x64.zip"],
      ["linux", "x64", "whisper-bin-ubuntu-x64.tar.gz"],
      ["linux", "arm64", "whisper-bin-ubuntu-arm64.tar.gz"],
      ["darwin", "arm64", `node-whisper-darwin-arm64-${WHISPER_NODE_VERSION}.tgz`],
      ["darwin", "x64", `node-whisper-darwin-x64-${WHISPER_NODE_VERSION}.tgz`],
      ["win32", "ia32", undefined],
    ];
    for (const [platform, arch, asset] of table)
      expect([platform, arch, whisperAsset(platform, arch)]).toEqual([platform, arch, asset]);
    delete process.env.REDGIANT_NPM_REGISTRY;
    expect(whisperUrl(`node-whisper-darwin-arm64-${WHISPER_NODE_VERSION}.tgz`, "darwin")).toBe(
      `https://registry.npmjs.org/@fugood/node-whisper-darwin-arm64/-/node-whisper-darwin-arm64-${WHISPER_NODE_VERSION}.tgz`,
    );
    expect(whisperUrl("whisper-bin-x64.zip", "win32")).toMatch(
      /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b\d+\/whisper-bin-x64\.zip$/,
    );
    const mac = new LocalWhisper("/data", "darwin", "arm64");
    expect(mac.binding).toBe(true);
    expect(mac.wavOnly).toBe(true);
    expect(mac.dir).toBe(join("/data", "tools", "whisper", `node-${WHISPER_NODE_VERSION}`));
    expect(new LocalWhisper("/data", "win32", "x64").wavOnly).toBe(false);
  });

  it("downloads the binding and the model with their bar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-whisper-mac-"));
    const addon = Buffer.from("not really a program");
    const pkg = tgz("index.node", addon);
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.url?.endsWith(".tgz")) {
        res.writeHead(200, { "content-length": pkg.length });
        res.end(pkg);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.REDGIANT_NPM_REGISTRY = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const data = join(dir, "data");
    // The model is already there: only the binding comes down.
    await mkdir(join(data, "tools", "whisper"), { recursive: true });
    await writeFile(join(data, "tools", "whisper", "ggml-large-v3-turbo-q5_0.bin"), "model");
    try {
      const voice = new LocalWhisper(data, "darwin", "arm64");
      expect(await voice.ready()).toBe(false);
      await voice.ensure(new Jobs(), "me");
      expect(asked).toEqual([
        `/@fugood/node-whisper-darwin-arm64/-/node-whisper-darwin-arm64-${WHISPER_NODE_VERSION}.tgz`,
      ]);
      expect(await voice.ready()).toBe(true);
      expect(existsSync(join(voice.dir, "package", "index.node"))).toBe(true);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("answers like whisper.cpp's server, one recording at a time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-whisper-worker-"));
    // A stand-in for the binding: says what it was given.
    const fake = join(dir, "fake-binding.cjs");
    await writeFile(
      fake,
      `const fs = require("node:fs");
class WhisperContext {
  constructor(o) { this.model = o.filePath; this.gpu = o.useGpu; }
  transcribeFile(path, o) {
    const n = fs.statSync(path).size;
    return { promise: new Promise((r) => setTimeout(() => r({ result: " heard " + n + " bytes in " + o.language + " with " + this.model + (this.gpu ? " on the GPU " : "") }), 50)) };
  }
}
module.exports = { WhisperContext };`,
    );
    // A port the system says is free (a random one may fall in a range Windows keeps for itself).
    const port = await new Promise<number>((ok) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => ok(port));
      });
    });
    worker = spawn(process.execPath, [whisperWorker(), fake, "model.bin", String(port)], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 100; i++) {
        if (
          await fetch(base).then(
            () => true,
            () => false,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const wav = toWav16k([new Float32Array(16000)], 16000);
      const send = (language?: string) => {
        const body = new FormData();
        body.set("file", new Blob([wav], { type: "audio/wav" }), "voice.wav");
        body.set("response_format", "text");
        if (language) body.set("language", language);
        return fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body }).then((r) =>
          r.text(),
        );
      };
      const [a, b] = await Promise.all([send("it"), send()]);
      expect(a).toBe(`heard ${wav.length} bytes in it with model.bin on the GPU`);
      expect(b).toBe(`heard ${wav.length} bytes in auto with model.bin on the GPU`);
      // The server that started it goes away (stdin closes): it ends too.
      const ended = new Promise((r) => worker?.once("exit", r));
      worker.stdin?.end();
      await ended;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("turns every other format into WAV first for the Mac's binding", async () => {
    // MP3 passes as it is to whisper.cpp's server, not to the binding (which needs ffmpeg then).
    const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64)]);
    expect((await forWhisperCpp(mp3, "audio/mpeg")).type).toBe("audio/mpeg");
    await expect(
      forWhisperCpp(mp3, "audio/mpeg", { wavOnly: true, ffmpeg: "/nowhere/ffmpeg" }),
    ).rejects.toThrow(/need ffmpeg/);
    const wav = toWav16k([new Float32Array(160)], 16000);
    expect((await forWhisperCpp(wav, "audio/wav", { wavOnly: true })).type).toBe("audio/wav");
  });
});
