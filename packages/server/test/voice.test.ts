import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SetupHooks, SetupService, TranscriptionError, transcribe } from "../src/index.js";
import { startServer, TOKEN } from "./helpers.js";

/** A fetch that records the request and answers with what the test says. */
function recorder(answer: () => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { f, seen };
}

describe("transcribe", () => {
  const audio = new Uint8Array([1, 2, 3]);

  it("asks whisper-asr for plain text, letting it convert the format", async () => {
    const { f, seen } = recorder(() => new Response("  ciao   mondo \n"));
    const text = await transcribe(
      audio,
      "audio/webm;codecs=opus",
      { api: "whisper-asr", url: "http://w:9000/" },
      { language: "it", fetch: f },
    );
    expect(text).toBe("ciao mondo");
    const url = new URL(seen[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("http://w:9000/asr");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      output: "txt",
      encode: "true",
      language: "it",
    });
    const file = (seen[0]?.init.body as FormData | undefined)?.get("audio_file") as File;
    expect([file.name, file.type, file.size]).toEqual(["voice.webm", "audio/webm", 3]);
  });

  it("uses an OpenAI-compatible endpoint with its key and model", async () => {
    const { f, seen } = recorder(() => Response.json({ text: "hello" }));
    const text = await transcribe(
      audio,
      "audio/ogg",
      { api: "openai", url: "https://api.example/v1", model: "whisper-large", key: "k1" },
      { fetch: f },
    );
    expect(text).toBe("hello");
    expect(seen[0]?.url).toBe("https://api.example/v1/audio/transcriptions");
    expect(seen[0]?.init.headers).toEqual({ authorization: "Bearer k1" });
    const body = seen[0]?.init.body as FormData;
    expect([body.get("model"), (body.get("file") as File).name]).toEqual([
      "whisper-large",
      "voice.ogg",
    ]);
  });

  it("explains failures in words", async () => {
    const refused = recorder(() => new Response("no", { status: 401 }));
    await expect(
      transcribe(audio, "audio/ogg", { api: "openai", url: "http://x" }, { fetch: refused.f }),
    ).rejects.toThrow("The transcription service refused the key");
    await expect(
      transcribe(new Uint8Array(), "audio/ogg", { api: "whisper-asr", url: "http://x" }),
    ).rejects.toBeInstanceOf(TranscriptionError);
  });
});

describe("voice messages through the server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("is configured in the wizard (key kept secret) and transcribes posted audio", async () => {
    // A stand-in for whisper-asr-webservice on a local port.
    const got: { url: string; auth: string | undefined; bytes: number }[] = [];
    const whisper = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      got.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        bytes: Buffer.concat(chunks).length,
      });
      res.end("prova uno due");
    });
    await new Promise<void>((ok) => whisper.listen(0, "127.0.0.1", ok));
    const port = (whisper.address() as AddressInfo).port;
    let dataDir = "";
    const hooks = {
      anthropic: async () => {},
      openai: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
    } satisfies SetupHooks;
    const s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      dataDir = join(dir, "data");
      const setup = new SetupService({ db: core.db, core, dataDir, ownerId: "me", hooks });
      await setup.applyAtStartup();
      return { setup };
    });
    close = async () => {
      await s.close();
      whisper.close();
    };

    expect((await s.api<{ voice: boolean }>("GET", "/api/platform")).body.voice).toBe(false);
    const post = () =>
      fetch(`${s.url}/api/transcribe?lang=it`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "audio/webm" },
        body: new Uint8Array(1000),
      });
    expect((await post()).status).toBe(400);

    const saved = await s.api("PUT", "/api/setup/models", {
      transcription: { api: "whisper-asr", url: `http://127.0.0.1:${port}`, key: "whisper-secret" },
    });
    expect(saved.status).toBe(200);
    expect((await s.api<{ voice: boolean }>("GET", "/api/platform")).body.voice).toBe(true);
    const r = await post();
    expect(await r.json()).toEqual({ text: "prova uno due" });
    expect(got).toEqual([
      expect.objectContaining({ auth: "Bearer whisper-secret", bytes: expect.any(Number) }),
    ]);
    expect(got[0]?.url).toMatch(/^\/asr\?.*language=it/);
    // The key is in the secrets file only, never in the readable configuration.
    expect(await readFile(join(dataDir, "secrets.json"), "utf8")).toContain("whisper-secret");
    expect(await readFile(join(dataDir, "redgiant.yaml"), "utf8")).not.toContain("whisper-secret");
    const state = await s.api<{ secretsSet: { transcription: boolean } }>("GET", "/api/setup");
    expect(state.body.secretsSet.transcription).toBe(true);
  });
});
