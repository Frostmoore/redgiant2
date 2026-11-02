import { describe, expect, it } from "vitest";
import { type MediaRequest, makeMedia } from "../src/media.js";

/** Answers recorded from each provider's documentation (2026-11-02), by URL; the asks are kept. */
function recorded(routes: [RegExp, (body: unknown, n: number) => Response][]) {
  const asked: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const counts = new Map<RegExp, number>();
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    asked.push({ url, headers: Object.fromEntries(new Headers(init?.headers)), body });
    for (const [re, answer] of routes)
      if (re.test(url)) {
        const n = counts.get(re) ?? 0;
        counts.set(re, n + 1);
        return answer(body, n);
      }
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;
  return { f, asked };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const bytes = (s: string, type: string) =>
  new Response(Buffer.from(s), { headers: { "content-type": type } });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ctx = (f: typeof fetch) => ({ key: "k-123", fetch: f, sleep: async () => {} });
const req = (r: Partial<MediaRequest> & Pick<MediaRequest, "kind">): MediaRequest => ({
  prompt: "a red fox",
  ...r,
});

describe("media providers (G25.3)", () => {
  it("Google: pictures, speech and music through the Interactions API", async () => {
    const out = (type: string, data: string, mime: string) => ({
      steps: [
        { type: "thought" },
        {
          type: "model_output",
          content: [
            { type: "text", text: "Here" },
            { type, data, mime_type: mime },
          ],
        },
      ],
    });
    const { f, asked } = recorded([
      [
        /interactions$/,
        (body) => {
          const b = body as { model: string };
          return b.model.includes("tts")
            ? json(out("audio", b64("RIFF"), "audio/wav"))
            : b.model.startsWith("lyria")
              ? json(out("audio", b64("ID3"), "audio/mpeg"))
              : json(out("image", b64("PNG"), "image/png"));
        },
      ],
    ]);
    const img = await makeMedia(
      { provider: "google", model: "gemini-nano-banana-2.1" },
      req({ kind: "image", aspectRatio: "16:9" }),
      ctx(f),
    );
    expect(img).toMatchObject({ mime: "image/png", ext: "png" });
    expect(img.data.toString()).toBe("PNG");
    expect(asked[0]?.headers["x-goog-api-key"]).toBe("k-123");
    expect(asked[0]?.body).toEqual({
      model: "gemini-nano-banana-2.1",
      input: "a red fox",
      response_format: { type: "image", mime_type: "image/png", aspect_ratio: "16:9" },
    });
    const speech = await makeMedia(
      { provider: "google", model: "gemini-3.8-flash-tts", voice: "Puck" },
      req({ kind: "speech", prompt: "Ciao", instructions: "Say cheerfully" }),
      ctx(f),
    );
    expect(speech).toMatchObject({ mime: "audio/wav", ext: "wav" });
    expect(asked[1]?.body).toMatchObject({
      generation_config: { speech_config: [{ voice: "Puck" }] },
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
    });
    const music = await makeMedia(
      { provider: "google", model: "lyria-3.5" },
      req({ kind: "music", seconds: 45 }),
      ctx(f),
    );
    expect(music).toMatchObject({ mime: "audio/mpeg", ext: "mp3" });
  });

  it("FLUX: a task polled until ready, then the picture downloaded at once", async () => {
    const { f, asked } = recorded([
      [
        /api\.bfl\.ai\/v1\/flux-2-pro$/,
        () => json({ id: "t1", polling_url: "https://api.bfl.ai/v1/get_result?id=t1" }),
      ],
      [
        /get_result/,
        (_b, n) =>
          json(
            n < 2
              ? { status: "Pending" }
              : { status: "Ready", result: { sample: "https://delivery.bfl.ai/x.png" } },
          ),
      ],
      [/delivery\.bfl\.ai/, () => bytes("FLUXPNG", "image/png")],
    ]);
    const r = await makeMedia(
      { provider: "bfl", model: "flux-2-pro" },
      req({ kind: "image", aspectRatio: "16:9" }),
      ctx(f),
    );
    expect(r.data.toString()).toBe("FLUXPNG");
    expect(asked[0]?.headers["x-key"]).toBe("k-123");
    const size = asked[0]?.body as { width: number; height: number };
    expect(size.width % 16).toBe(0);
    expect(size.height % 16).toBe(0);
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1);
    expect(asked.filter((a) => a.url.includes("get_result"))).toHaveLength(3);
  });

  it("FLUX: a moderated request is said in the provider's words", async () => {
    const { f } = recorded([
      [
        /flux-2-pro$/,
        () => json({ id: "t2", polling_url: "https://api.bfl.ai/v1/get_result?id=t2" }),
      ],
      [/get_result/, () => json({ status: "Request Moderated" })],
    ]);
    await expect(
      makeMedia({ provider: "bfl", model: "flux-2-pro" }, req({ kind: "image" }), ctx(f)),
    ).rejects.toThrow(/Request Moderated/);
  });

  it("Runway: text or picture to video, a task with progress, the video downloaded", async () => {
    const seen: number[] = [];
    const { f, asked } = recorded([
      [/text_to_video|image_to_video/, () => json({ id: "rw1" })],
      [
        /tasks\/rw1/,
        (_b, n) =>
          json(
            n === 0
              ? { status: "RUNNING", progress: 0.4 }
              : { status: "SUCCEEDED", output: ["https://dnznrvs05pmza.cloudfront.net/v.mp4"] },
          ),
      ],
      [/cloudfront/, () => bytes("MP4", "video/mp4")],
    ]);
    const r = await makeMedia(
      { provider: "runway", model: "gen4.5" },
      req({
        kind: "video",
        seconds: 30,
        aspectRatio: "9:16",
        image: { data: Buffer.from("JPG"), mime: "image/jpeg" },
      }),
      { ...ctx(f), progress: (p) => seen.push(p) },
    );
    expect(r).toMatchObject({ mime: "video/mp4", ext: "mp4" });
    expect(asked[0]?.url).toMatch(/\/v1\/image_to_video$/);
    expect(asked[0]?.headers["x-runway-version"]).toBe("2024-11-06");
    expect(asked[0]?.body).toMatchObject({
      model: "gen4.5",
      ratio: "720:1280",
      duration: 10,
      promptImage: `data:image/jpeg;base64,${b64("JPG")}`,
    });
    expect(seen).toContain(40);
  });

  it("xAI: pictures at once, videos polled", async () => {
    const { f, asked } = recorded([
      [
        /images\/generations/,
        () => json({ data: [{ b64_json: b64("JPEG"), mime_type: "image/jpeg" }] }),
      ],
      [/videos\/generations/, () => json({ request_id: "x1" })],
      [
        /videos\/x1/,
        (_b, n) =>
          n === 0
            ? new Response("{}", { status: 202 })
            : json({ status: "done", video: { url: "https://vidgen.x.ai/v.mp4" } }),
      ],
      [/vidgen/, () => bytes("XMP4", "video/mp4")],
    ]);
    const img = await makeMedia(
      { provider: "xai", model: "grok-imagine-image-2.0" },
      req({ kind: "image" }),
      ctx(f),
    );
    expect(img).toMatchObject({ mime: "image/jpeg", ext: "jpg" });
    expect(asked[0]?.body).toMatchObject({ response_format: "b64_json" });
    const v = await makeMedia(
      { provider: "xai", model: "grok-imagine-video-1.5" },
      req({ kind: "video", seconds: 40 }),
      ctx(f),
    );
    expect(v.data.toString()).toBe("XMP4");
    expect(asked[1]?.body).toMatchObject({ duration: 15, resolution: "720p" });
  });

  it("ElevenLabs: speech with the account's first voice, music and sound effects", async () => {
    const { f, asked } = recorded([
      [/v2\/voices/, () => json({ voices: [{ voice_id: "v-first", name: "Aria" }] })],
      [/text-to-speech\/v-first/, () => bytes("MP3S", "audio/mpeg")],
      [/v1\/music/, () => bytes("MP3M", "audio/mpeg")],
      [/sound-generation/, () => bytes("MP3E", "audio/mpeg")],
    ]);
    const s = await makeMedia(
      { provider: "elevenlabs", model: "eleven_v3" },
      req({ kind: "speech", prompt: "Ciao" }),
      ctx(f),
    );
    expect(s.data.toString()).toBe("MP3S");
    expect(asked[1]?.headers["xi-api-key"]).toBe("k-123");
    expect(asked[1]?.body).toEqual({ text: "Ciao", model_id: "eleven_v3" });
    await makeMedia(
      { provider: "elevenlabs", model: "music_v2_5" },
      req({ kind: "music", seconds: 2 }),
      ctx(f),
    );
    // At least 3 seconds, and the model always given (the default one is going away).
    expect(asked[2]?.body).toEqual({
      prompt: "a red fox",
      model_id: "music_v2_5",
      music_length_ms: 3000,
    });
    await makeMedia(
      { provider: "elevenlabs", model: "eleven_text_to_sound_v3" },
      req({ kind: "sound", prompt: "a door creaks", seconds: 99 }),
      ctx(f),
    );
    expect(asked[3]?.body).toEqual({
      text: "a door creaks",
      model_id: "eleven_text_to_sound_v3",
      duration_seconds: 30,
    });
  });

  it("says plainly what a provider cannot make, and passes its refusals on", async () => {
    const { f } = recorded([
      [/audio\/speech/, () => json({ error: { message: "Incorrect API key" } }, 401)],
    ]);
    await expect(
      makeMedia({ provider: "runway", model: "gen4.5" }, req({ kind: "speech" }), ctx(f)),
    ).rejects.toThrow(/runway cannot make speech/);
    await expect(
      makeMedia({ provider: "openai", model: "gpt-4o-mini-tts" }, req({ kind: "speech" }), ctx(f)),
    ).rejects.toThrow(/OpenAI refused \(HTTP 401\): Incorrect API key/);
  });
});
