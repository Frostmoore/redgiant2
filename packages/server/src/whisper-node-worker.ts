// whisper.cpp on a Mac (2026-11-05). whisper.cpp publishes no ready program for macOS, so there
// RedGiant uses the prebuilt Node binding `@fugood/node-whisper-darwin-<arch>` (MIT, with Metal),
// downloaded from npm like Codex. It runs in this process of its own, never inside the server (a
// crash in native code must not take RedGiant down), and answers like whisper.cpp's server: the
// same OpenAI-style path, so the rest of RedGiant does not see the difference.
//
//   node whisper-node-worker.js <addon (index.node)> <model> <port>
//
// Audio arrives as 16 kHz mono WAV (`forWhisperCpp` with `wavOnly`).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

interface Context {
  transcribeFile(
    path: string,
    o: { language?: string; maxThreads?: number },
  ): { promise: Promise<{ result: string }> };
}

const [addon, model, port] = process.argv.slice(2);
if (!addon || !model || !port) {
  console.error("usage: whisper-node-worker <addon> <model> <port>");
  process.exit(2);
}
const binding = createRequire(import.meta.url)(addon) as {
  WhisperContext: new (o: { filePath: string; useGpu: boolean }) => Context | Promise<Context>;
};
const ctx = await new binding.WhisperContext({ filePath: model, useGpu: true });
const threads = Math.max(1, Math.min(8, cpus().length - 1));

// One recording at a time, in order: the model and the GPU are shared.
let line: Promise<unknown> = Promise.resolve();

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (!req.url?.startsWith("/v1/audio/transcriptions")) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const work = async () => {
      // The multipart body read by the platform's own parser.
      const form = await new Request("http://worker/", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body: Buffer.concat(chunks),
      }).formData();
      const file = form.get("file");
      if (!file || typeof file === "string") throw new Error("no file in the request");
      const language = form.get("language");
      const dir = await mkdtemp(join(tmpdir(), "redgiant-whisper-"));
      try {
        const wav = join(dir, "voice.wav");
        await writeFile(wav, new Uint8Array(await file.arrayBuffer()));
        const { promise } = ctx.transcribeFile(wav, {
          language: typeof language === "string" && language ? language : "auto",
          maxThreads: threads,
        });
        return (await promise).result.trim();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    const done = line.then(work);
    line = done.catch(() => {});
    done.then(
      (text) => res.writeHead(200, { "content-type": "text/plain" }).end(text),
      (err: Error) => res.writeHead(500, { "content-type": "text/plain" }).end(err.message),
    );
  });
});
server.listen(Number(port), "127.0.0.1");
// The server that started this one went away: so does this one.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
