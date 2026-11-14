import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const file = ((seen[0]?.init.body ?? {}) as unknown as FormData | undefined)?.get(
      "audio_file",
    ) as File;
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

  it("names AAC so that OpenAI takes it (it refuses .aac)", async () => {
    const { f, seen } = recorder(() => new Response("ok"));
    await transcribe(audio, "audio/aac", { api: "openai", url: "http://x" }, { fetch: f });
    const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
    await transcribe(
      adts,
      "application/octet-stream",
      { api: "openai", url: "http://x" },
      { fetch: f },
    );
    const names = seen.map((s) => ((s.init.body as FormData).get("file") as File).name);
    expect(names).toEqual(["voice.m4a", "voice.m4a"]);
  });

  it("gives whisper.cpp a WAV for an Opus voice note, and says when ffmpeg is needed", async () => {
    const { f, seen } = recorder(() => new Response("ciao"));
    const opus = await readFile(new URL("./fixtures/tone.opus", import.meta.url));
    const local = { api: "local", url: "http://127.0.0.1:1/v1" } as const;
    expect(await transcribe(opus, "audio/ogg", local, { fetch: f })).toBe("ciao");
    const file = ((seen[0]?.init.body ?? {}) as unknown as FormData | undefined)?.get(
      "file",
    ) as File;
    expect([file.name, file.type]).toEqual(["voice.wav", "audio/wav"]);
    expect(file.size).toBe(44 + 16000 * 2);
    const m4a = new Uint8Array([0, 0, 0, 0x20, ...Buffer.from("ftypM4A ")]);
    const err = await transcribe(m4a, "audio/mp4", local, {
      fetch: f,
      ffmpeg: "/nonexistent/ffmpeg",
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as Error).message).toMatch(/need ffmpeg, and there is none/);
    expect(seen).toHaveLength(1);
  });

  it("explains failures with a code the page says in the person's language", async () => {
    const failing = async (
      answer: () => Response | Promise<Response>,
      cfg: Parameters<typeof transcribe>[2] = { api: "openai", url: "http://x", name: "Groq" },
      opts: { timeoutMs?: number } = {},
    ) => {
      const f = (async (_u: string | URL, init: RequestInit = {}) => {
        if (opts.timeoutMs) {
          await new Promise((_, no) =>
            init.signal?.addEventListener("abort", () => no(init.signal?.reason)),
          );
        }
        return answer();
      }) as typeof fetch;
      return transcribe(audio, "audio/ogg", cfg, { fetch: f, ...opts }).then(
        () => undefined,
        (e: unknown) => e as TranscriptionError,
      );
    };
    const refused = await failing(() => new Response("no", { status: 401 }));
    expect([refused?.code, refused?.vars, refused?.status]).toEqual([
      "voice_key_refused",
      { name: "Groq" },
      502,
    ]);
    expect((await failing(() => new Response("slow down", { status: 429 })))?.code).toBe(
      "voice_rate_limited",
    );
    const broken = await failing(() => new Response("boom", { status: 500 }));
    expect([broken?.code, broken?.vars]).toEqual([
      "voice_service_error",
      { name: "Groq", status: "500" },
    ]);
    const down = await failing(() => {
      throw new TypeError("fetch failed");
    });
    expect([down?.code, down?.vars]).toEqual(["voice_unreachable", { name: "Groq" }]);
    const slow = await failing(() => new Response("late"), undefined, { timeoutMs: 20 });
    expect(slow?.code).toBe("voice_timeout");
    // Unnamed: whisper, as the person set it.
    const plain = await failing(() => new Response("no", { status: 403 }), {
      api: "whisper-asr",
      url: "http://x",
    });
    expect(plain?.vars).toEqual({ name: "whisper" });
    const noKey = await failing(() => new Response("never"), {
      api: "openai",
      url: "https://api.openai.com/v1",
      name: "OpenAI",
      noKey: true,
    });
    expect([noKey?.code, noKey?.status]).toEqual(["voice_no_key", 400]);
    const empty = await transcribe(new Uint8Array(), "audio/ogg", {
      api: "whisper-asr",
      url: "http://x",
    }).catch((e: unknown) => e as TranscriptionError);
    expect([empty.code, empty.status]).toEqual(["voice_empty", 400]);
  });

  it("asks OpenAI and Groq in the cloud for JSON, with the model and the language", async () => {
    const { f, seen } = recorder(() => Response.json({ text: " ciao  a tutti " }));
    const openai = {
      api: "openai" as const,
      url: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      key: "sk-test",
      name: "OpenAI",
      json: true,
    };
    expect(await transcribe(audio, "audio/wav", openai, { language: "it", fetch: f })).toBe(
      "ciao a tutti",
    );
    const body = seen[0]?.init.body as FormData;
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(((seen[0]?.init.headers ?? {}) as unknown as Record<string, string>).authorization).toBe(
      "Bearer sk-test",
    );
    expect([body.get("model"), body.get("response_format"), body.get("language")]).toEqual([
      "gpt-4o-mini-transcribe",
      "json",
      "it",
    ]);
    // gpt-transcribe keeps the language spoken: no hint.
    await transcribe(
      audio,
      "audio/wav",
      { ...openai, model: "gpt-transcribe", noLanguage: true },
      { language: "it", fetch: f },
    );
    expect(((seen[1]?.init.body ?? {}) as unknown as FormData).get("language")).toBeNull();
    await transcribe(
      audio,
      "audio/wav",
      {
        ...openai,
        url: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3-turbo",
        key: "gsk-test",
        name: "Groq",
      },
      { language: "en", fetch: f },
    );
    expect(seen[2]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(((seen[2]?.init.body ?? {}) as unknown as FormData).get("model")).toBe(
      "whisper-large-v3-turbo",
    );
    expect(((seen[2]?.init.headers ?? {}) as unknown as Record<string, string>).authorization).toBe(
      "Bearer gsk-test",
    );
  });

  it("asks ElevenLabs Scribe with its own header and fields", async () => {
    const { f, seen } = recorder(() =>
      Response.json({ language_code: "ita", text: "buongiorno", words: [] }),
    );
    const text = await transcribe(
      audio,
      "audio/wav",
      {
        api: "elevenlabs",
        url: "https://api.elevenlabs.io/v1",
        model: "scribe_v3",
        key: "sk_eleven",
        name: "ElevenLabs",
        json: true,
      },
      { language: "it", fetch: f },
    );
    expect(text).toBe("buongiorno");
    expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect([headers["xi-api-key"], headers.authorization]).toEqual(["sk_eleven", undefined]);
    const body = seen[0]?.init.body as FormData;
    expect([body.get("model_id"), body.get("language_code")]).toEqual(["scribe_v3", "it"]);
    expect((body.get("file") as File).name).toBe("voice.wav");
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
      key: async () => [],
      server: async () => [],
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
    // The person speaks to the agents in the agents' language (G33.5), not the interface's.
    s.core.setAgentLanguage("zh-Hant");
    await post();
    expect(got[1]?.url).toMatch(/^\/asr\?.*language=zh(&|$)/);
    // The key is in the keychain only (G36.20), never in the readable configuration.
    expect(s.core.vault.systemValue("me", "setup:transcriptionKey")).toBe("whisper-secret");
    expect(await readFile(join(dataDir, "redgiant.yaml"), "utf8")).not.toContain("whisper-secret");
    const state = await s.api<{ secretsSet: { transcription: boolean } }>("GET", "/api/setup");
    expect(state.body.secretsSet.transcription).toBe(true);
  });

  it("uses a provider in the cloud with the key given, and reads answers aloud (fake fetch)", async () => {
    const real = globalThis.fetch;
    const out: { url: string; init: RequestInit }[] = [];
    let answer: (url: string) => Response = () => new Response("?");
    // Only the providers' addresses are faked; RedGiant's own server is reached for real.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost"))
        return real(url, init);
      out.push({ url: u, init: init ?? {} });
      return answer(u);
    });
    const hooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
    } satisfies SetupHooks;
    let dataDir = "";
    const s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      dataDir = join(dir, "data");
      const setup = new SetupService({ db: core.db, core, dataDir, ownerId: "me", hooks });
      await setup.applyAtStartup();
      return { setup };
    });
    close = async () => {
      spy.mockRestore();
      await s.close();
    };
    const post = () =>
      fetch(`${s.url}/api/transcribe?lang=it`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "audio/wav" },
        body: new Uint8Array(1000),
      });
    // No service: the code the page says in Italian, not an English sentence.
    const none = await post();
    expect([none.status, ((await none.json()) as { code: string }).code]).toEqual([
      400,
      "voice_no_service",
    ]);

    // Groq without a key yet: chosen, and the page says the key is missing.
    expect(
      (
        await s.api("PUT", "/api/setup/models", {
          transcription: {
            api: "cloud",
            url: "",
            provider: "groq",
            model: "whisper-large-v3-turbo",
          },
        })
      ).status,
    ).toBe(200);
    const noKey = await post();
    expect(await noKey.json()).toMatchObject({ code: "voice_no_key", vars: { name: "Groq" } });
    expect(out).toHaveLength(0);

    // The key, given on the Voice page: in the keychain, never in the files.
    await s.api("PUT", "/api/setup/voice-keys/groq", { key: "gsk_voice_secret_1" });
    expect(s.core.vault.systemValue("me", "setup:voiceKeys.groq")).toBe("gsk_voice_secret_1");
    expect(await readFile(join(dataDir, "redgiant.yaml"), "utf8")).not.toContain("gsk_voice");
    answer = () => Response.json({ text: "accendi la luce" });
    const ok = await post();
    expect(await ok.json()).toEqual({ text: "accendi la luce" });
    expect(out[0]?.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    const state = await s.api<{ secretsSet: { voice: string[] } }>("GET", "/api/setup");
    expect(state.body.secretsSet.voice).toEqual(["groq"]);

    // A refused key: a code with the provider's name.
    answer = () => new Response("bad key", { status: 401 });
    expect(await (await post()).json()).toMatchObject({
      code: "voice_key_refused",
      vars: { name: "Groq" },
    });

    // ElevenLabs Scribe, its key pasted with the choice.
    answer = () => Response.json({ text: "ciao" });
    await s.api("PUT", "/api/setup/models", {
      transcription: {
        api: "cloud",
        url: "",
        provider: "elevenlabs",
        model: "scribe_v3",
        key: "sk_eleven_voice",
      },
    });
    expect(await (await post()).json()).toEqual({ text: "ciao" });
    expect(out.at(-1)?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(
      ((out.at(-1)?.init.headers ?? {}) as unknown as Record<string, string>)["xi-api-key"],
    ).toBe("sk_eleven_voice");
    // A provider that cannot transcribe is refused.
    expect(
      (
        await s.api("PUT", "/api/setup/models", {
          transcription: { api: "cloud", url: "", provider: "google", model: "x" },
        })
      ).body,
    ).toMatchObject({ code: "voice_provider" });

    // Reading aloud: OpenAI with its voice, the audio back to the page.
    const speech = (b: Record<string, unknown>) =>
      fetch(`${s.url}/api/voice/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(b),
      });
    const openaiNoKey = await speech({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      text: "Ciao",
    });
    expect(await openaiNoKey.json()).toMatchObject({
      code: "voice_no_key",
      vars: { name: "OpenAI" },
    });
    // The chat's OpenAI key serves the voice too, as it serves the generation.
    expect((await s.api("PUT", "/api/setup/keys/openai", { key: "sk-openai-voice" })).status).toBe(
      200,
    );
    expect(s.core.vault.systemValue("me", "setup:voiceKeys.openai")).toBeUndefined();
    answer = () =>
      new Response(new Uint8Array([0xff, 0xfb, 1, 2]), {
        headers: { "content-type": "audio/mpeg" },
      });
    const read = await speech({
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      text: "Ciao, sono RedGiant.",
    });
    expect([read.status, read.headers.get("content-type")]).toEqual([200, "audio/mpeg"]);
    expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([0xff, 0xfb, 1, 2]);
    const sent = out.at(-1);
    expect(sent?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(sent?.init.body))).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      input: "Ciao, sono RedGiant.",
    });
    // tts-1 does not know cedar: its first voice instead.
    await speech({ provider: "openai", model: "tts-1", voice: "cedar", text: "Ciao" });
    expect(JSON.parse(String(out.at(-1)?.init.body))).toMatchObject({
      model: "tts-1",
      voice: "alloy",
    });

    // ElevenLabs with the key given for the transcription (one key, both uses).
    await speech({ provider: "elevenlabs", model: "eleven_v4_turbo", voice: "v123", text: "Ciao" });
    expect(out.at(-1)?.url).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/v123\?/);
    expect(JSON.parse(String(out.at(-1)?.init.body))).toMatchObject({
      model_id: "eleven_v4_turbo",
    });

    // Google Gemini with its key, the WAV out of the Interactions API.
    await s.api("PUT", "/api/setup/voice-keys/google", { key: "AIza-voice-key" });
    answer = () =>
      Response.json({
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "audio",
                data: Buffer.from("RIFF").toString("base64"),
                mime_type: "audio/wav",
              },
            ],
          },
        ],
      });
    const gem = await speech({
      provider: "google",
      model: "gemini-3.8-flash-lite-tts",
      voice: "Kore",
      text: "Ciao",
    });
    expect([gem.status, gem.headers.get("content-type"), await gem.text()]).toEqual([
      200,
      "audio/wav",
      "RIFF",
    ]);
    expect(out.at(-1)?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(
      ((out.at(-1)?.init.headers ?? {}) as unknown as Record<string, string>)["x-goog-api-key"],
    ).toBe("AIza-voice-key");

    // Failures with their codes; a model the provider does not have is refused before any call.
    answer = () => new Response("quota", { status: 429 });
    expect(
      await (await speech({ provider: "openai", model: "tts-1", text: "Ciao" })).json(),
    ).toMatchObject({
      code: "voice_rate_limited",
      vars: { name: "OpenAI" },
    });
    const calls = out.length;
    expect((await speech({ provider: "openai", model: "nope", text: "Ciao" })).status).toBe(400);
    expect((await speech({ provider: "openai", model: "tts-1", text: "" })).status).toBe(400);
    expect(out).toHaveLength(calls);
    // No key ever in an answer.
    expect(JSON.stringify((await s.api("GET", "/api/setup")).body)).not.toMatch(
      /sk-openai-voice|gsk_voice|AIza-voice/,
    );
  });
});
