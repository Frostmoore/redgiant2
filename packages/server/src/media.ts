// Making pictures, videos and sounds (G25.3) with the provider the person chose for each kind,
// over plain HTTP with their key. Each provider's way was checked against its documentation on
// 2026-11-02: some answer at once (base64 or bytes), others give a task to poll and a short-lived
// link to download. The result comes back as bytes, saved by the caller in the workspace.
import type { MediaChoice, MediaKind } from "@redgiant/protocol";
import { generateImage } from "./images.js";

export interface MediaRequest {
  kind: MediaKind;
  /** What to make: the description, or for speech the text to say. */
  prompt: string;
  aspectRatio?: string | undefined;
  /** Videos, music, sound effects. */
  seconds?: number | undefined;
  /** Speech: how to say it (tone, pace), where the model takes it. */
  instructions?: string | undefined;
  /** A first frame or a reference picture. */
  image?: { data: Buffer; mime: string } | undefined;
}

export interface MediaResult {
  data: Buffer;
  mime: string;
  ext: string;
  /** In dollars, when the provider says. */
  costUsd: number | null;
  /** Tokens counted, when the provider counts them. */
  tokens?: number;
}

export interface MediaContext {
  key: string;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch;
  /** Waits between polls (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** 0–100 while it works, and a blurry preview for pictures that have one. */
  progress?: (percent: number, preview?: string) => void;
  /** How long a task may take before it is given up (default 15 minutes). */
  timeoutMs?: number;
  /** OpenAI pictures: another address (tests, compatible servers). */
  baseUrl?: string;
}

export class MediaError extends Error {
  /** The provider's HTTP status, when it answered with one. */
  status?: number;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};
const ext = (mime: string) => EXT[mime] ?? mime.split("/")[1] ?? "bin";

async function failed(r: Response, who: string): Promise<never> {
  const text = await r.text().catch(() => "");
  let message = text.slice(0, 500);
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
      detail?: unknown;
    };
    message =
      (typeof j.error === "string" ? j.error : j.error?.message) ??
      j.message ??
      (j.detail ? JSON.stringify(j.detail) : message);
  } catch {
    // Not JSON: the text as it is.
  }
  const err = new MediaError(`${who} refused (HTTP ${r.status}): ${message}`);
  err.status = r.status;
  throw err;
}

/** Polls until `done` gives a value; gives up after the timeout. */
async function poll<T>(
  ctx: MediaContext,
  every: number,
  look: (round: number) => Promise<T | undefined>,
): Promise<T> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = Date.now() + (ctx.timeoutMs ?? 15 * 60_000);
  for (let round = 0; ; round++) {
    ctx.signal?.throwIfAborted();
    const v = await look(round);
    if (v !== undefined) return v;
    if (Date.now() > until) throw new MediaError("It took too long: the provider did not finish");
    await sleep(every);
  }
}

async function download(f: typeof fetch, url: string, headers: Record<string, string> = {}) {
  const r = await f(url, { headers, redirect: "follow" });
  if (!r.ok) await failed(r, "The download");
  return {
    data: Buffer.from(await r.arrayBuffer()),
    mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0] ?? "",
  };
}

/** OpenAI's picture sizes for an aspect ratio. */
const openaiSize = (ratio?: string) =>
  ratio === "16:9" || ratio === "4:3" || ratio === "3:2"
    ? "1536x1024"
    : ratio === "9:16" || ratio === "3:4" || ratio === "2:3"
      ? "1024x1536"
      : "1024x1024";

/** FLUX takes pixels: about a megapixel, sides multiples of 16. */
const fluxSize = (ratio?: string): { width: number; height: number } => {
  const [w, h] = (ratio ?? "1:1").split(":").map(Number);
  const r = w && h ? w / h : 1;
  const height = Math.round(Math.sqrt(1_048_576 / r) / 16) * 16;
  return { width: Math.round((height * r) / 16) * 16, height };
};

type Interaction = {
  steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[];
};

/** Google's Interactions API: the first output of a kind in the model's step. */
function interactionOutput(
  j: {
    steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string }[] }[];
  },
  type: "image" | "audio" | "video",
): { data: Buffer; mime: string } {
  for (const s of j.steps ?? [])
    if (s.type === "model_output")
      for (const c of s.content ?? [])
        if (c.type === type && c.data)
          return { data: Buffer.from(c.data, "base64"), mime: c.mime_type ?? "" };
  throw new MediaError(`Google gave no ${type} (the request may have been refused)`);
}

const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/interactions";

/** Makes it with the chosen provider and model. */
export async function makeMedia(
  choice: MediaChoice,
  req: MediaRequest,
  ctx: MediaContext,
): Promise<MediaResult> {
  const f = ctx.fetch ?? fetch;
  const json = (url: string, body: unknown, headers: Record<string, string>) =>
    f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...(ctx.signal && { signal: ctx.signal }),
    });
  const bearer = { Authorization: `Bearer ${ctx.key}` };
  const p = `${choice.provider}:${req.kind}`;

  switch (p) {
    case "openai:image": {
      const img = await generateImage(req.prompt, {
        key: ctx.key,
        model: choice.model,
        size: openaiSize(req.aspectRatio) as never,
        onProgress: (x) => ctx.progress?.(x.percent, x.preview),
        signal: ctx.signal,
        ...(ctx.baseUrl && { baseUrl: ctx.baseUrl }),
        ...(ctx.fetch && { fetch: ctx.fetch }),
      }).catch((err: Error) => {
        throw new MediaError(err.message);
      });
      return {
        data: Buffer.from(img.base64, "base64"),
        mime: "image/png",
        ext: "png",
        costUsd: img.costUsd,
      };
    }

    case "openai:speech": {
      const r = await json(
        "https://api.openai.com/v1/audio/speech",
        {
          model: choice.model,
          input: req.prompt.slice(0, 4096),
          voice: choice.voice ?? "marin",
          response_format: "mp3",
          ...(req.instructions && { instructions: req.instructions }),
        },
        bearer,
      );
      if (!r.ok) await failed(r, "OpenAI");
      return {
        data: Buffer.from(await r.arrayBuffer()),
        mime: "audio/mpeg",
        ext: "mp3",
        costUsd: null,
      };
    }

    case "google:image": {
      const r = await json(
        GOOGLE,
        {
          model: choice.model,
          input: req.image
            ? [
                { type: "text", text: req.prompt },
                {
                  type: "image",
                  mime_type: req.image.mime,
                  data: req.image.data.toString("base64"),
                },
              ]
            : req.prompt,
          response_format: {
            type: "image",
            mime_type: "image/png",
            ...(req.aspectRatio && { aspect_ratio: req.aspectRatio }),
          },
        },
        { "x-goog-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "Google");
      const out = interactionOutput((await r.json()) as Interaction, "image");
      const mime = out.mime || "image/png";
      return { data: out.data, mime, ext: ext(mime), costUsd: null };
    }

    case "google:video": {
      ctx.progress?.(5);
      const seconds = req.seconds ? `\n\nLength: about ${Math.round(req.seconds)} seconds.` : "";
      const r = await json(
        GOOGLE,
        {
          model: choice.model,
          input: req.image
            ? [
                { type: "text", text: req.prompt + seconds },
                {
                  type: "image",
                  mime_type: req.image.mime,
                  data: req.image.data.toString("base64"),
                },
              ]
            : req.prompt + seconds,
          response_format: {
            type: "video",
            aspect_ratio: req.aspectRatio === "9:16" ? "9:16" : "16:9",
            resolution: "720p",
          },
        },
        { "x-goog-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "Google");
      const out = interactionOutput((await r.json()) as Interaction, "video");
      return { data: out.data, mime: "video/mp4", ext: "mp4", costUsd: null };
    }

    case "google:speech": {
      const r = await json(
        GOOGLE,
        {
          model: choice.model,
          input: [
            {
              type: "user_input",
              content: [
                {
                  type: "text",
                  text: req.instructions ? `${req.instructions}: ${req.prompt}` : req.prompt,
                },
              ],
            },
          ],
          response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
          generation_config: { speech_config: [{ voice: choice.voice ?? "Kore" }] },
        },
        { "x-goog-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "Google");
      const out = interactionOutput((await r.json()) as Interaction, "audio");
      return { data: out.data, mime: "audio/wav", ext: "wav", costUsd: null };
    }

    case "google:music": {
      const r = await json(
        GOOGLE,
        {
          model: choice.model,
          input: req.seconds
            ? `${req.prompt}\n\nLength: about ${Math.round(req.seconds)} seconds.`
            : req.prompt,
          response_format: { type: "audio" },
        },
        { "x-goog-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "Google");
      const out = interactionOutput((await r.json()) as Interaction, "audio");
      const mime = out.mime || "audio/mpeg";
      return { data: out.data, mime, ext: ext(mime), costUsd: null };
    }

    case "xai:image": {
      const r = await json(
        "https://api.x.ai/v1/images/generations",
        {
          model: choice.model,
          prompt: req.prompt,
          n: 1,
          response_format: "b64_json",
          ...(req.aspectRatio && { aspect_ratio: req.aspectRatio }),
        },
        bearer,
      );
      if (!r.ok) await failed(r, "xAI");
      const j = (await r.json()) as { data?: { b64_json?: string; mime_type?: string }[] };
      const b64 = j.data?.[0]?.b64_json;
      if (!b64) throw new MediaError("xAI gave no picture");
      const mime = j.data?.[0]?.mime_type ?? "image/jpeg";
      return { data: Buffer.from(b64, "base64"), mime, ext: ext(mime), costUsd: null };
    }

    case "xai:video": {
      const r = await json(
        "https://api.x.ai/v1/videos/generations",
        {
          model: choice.model,
          prompt: req.prompt,
          duration: Math.min(15, Math.max(1, Math.round(req.seconds ?? 8))),
          aspect_ratio: req.aspectRatio ?? "16:9",
          resolution: "720p",
        },
        bearer,
      );
      if (!r.ok) await failed(r, "xAI");
      const { request_id } = (await r.json()) as { request_id?: string };
      if (!request_id) throw new MediaError("xAI gave no task");
      const url = await poll(ctx, 5000, async (round) => {
        ctx.progress?.(Math.min(90, 5 + round * 3));
        const s = await f(`https://api.x.ai/v1/videos/${request_id}`, { headers: bearer });
        if (s.status === 202) return undefined;
        if (!s.ok) await failed(s, "xAI");
        const j = (await s.json()) as {
          status?: string;
          video?: { url?: string };
          error?: { message?: string };
        };
        if (j.status === "failed") throw new MediaError(`xAI: ${j.error?.message ?? "it failed"}`);
        return j.status === "done" && j.video?.url ? j.video.url : undefined;
      });
      const v = await download(f, url);
      return { data: v.data, mime: "video/mp4", ext: "mp4", costUsd: null };
    }

    case "bfl:image": {
      const r = await json(
        `https://api.bfl.ai/v1/${choice.model}`,
        {
          prompt: req.prompt,
          ...fluxSize(req.aspectRatio),
          output_format: "png",
          ...(req.image && { input_image: req.image.data.toString("base64") }),
        },
        { "x-key": ctx.key },
      );
      if (!r.ok) await failed(r, "Black Forest Labs");
      const { polling_url, id } = (await r.json()) as { polling_url?: string; id?: string };
      const at = polling_url ?? `https://api.bfl.ai/v1/get_result?id=${id}`;
      const url = await poll(ctx, 1500, async (round) => {
        ctx.progress?.(Math.min(90, 10 + round * 5));
        const s = await f(at, { headers: { "x-key": ctx.key } });
        if (!s.ok) await failed(s, "Black Forest Labs");
        const j = (await s.json()) as { status?: string; result?: { sample?: string } };
        if (j.status === "Ready" && j.result?.sample) return j.result.sample;
        if (j.status && /Moderated|Error|not found|No Card/i.test(j.status))
          throw new MediaError(`Black Forest Labs: ${j.status}`);
        return undefined;
      });
      // The link lasts ten minutes: taken at once.
      const img = await download(f, url);
      const mime = img.mime.startsWith("image/") ? img.mime : "image/png";
      return { data: img.data, mime, ext: ext(mime), costUsd: null };
    }

    case "runway:video": {
      const headers = { ...bearer, "X-Runway-Version": "2024-11-06" };
      const portrait = req.aspectRatio === "9:16" || req.aspectRatio === "3:4";
      const veo = choice.model.startsWith("veo");
      const seconds = Math.round(req.seconds ?? (veo ? 8 : 5));
      const duration = veo
        ? [4, 6, 8].reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a))
        : Math.min(10, Math.max(2, seconds));
      const body = {
        model: choice.model,
        promptText: req.prompt.slice(0, 1000),
        ratio: portrait ? "720:1280" : "1280:720",
        duration,
        ...(req.image && {
          promptImage: `data:${req.image.mime};base64,${req.image.data.toString("base64")}`,
        }),
      };
      const r = await json(
        `https://api.dev.runwayml.com/v1/${req.image ? "image_to_video" : "text_to_video"}`,
        body,
        headers,
      );
      if (!r.ok) await failed(r, "Runway");
      const { id } = (await r.json()) as { id?: string };
      if (!id) throw new MediaError("Runway gave no task");
      const url = await poll(ctx, 5000, async () => {
        const s = await f(`https://api.dev.runwayml.com/v1/tasks/${id}`, { headers });
        if (!s.ok) await failed(s, "Runway");
        const j = (await s.json()) as {
          status?: string;
          progress?: number;
          output?: string[];
          failure?: string;
        };
        if (typeof j.progress === "number") ctx.progress?.(Math.round(j.progress * 100));
        if (j.status === "FAILED" || j.status === "CANCELLED")
          throw new MediaError(`Runway: ${j.failure ?? j.status}`);
        return j.status === "SUCCEEDED" ? j.output?.[0] : undefined;
      });
      const v = await download(f, url);
      return { data: v.data, mime: "video/mp4", ext: "mp4", costUsd: null };
    }

    case "elevenlabs:speech": {
      const voice = choice.voice ?? (await elevenFirstVoice(f, ctx.key));
      const r = await json(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
        { text: req.prompt, model_id: choice.model },
        { "xi-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "ElevenLabs");
      return {
        data: Buffer.from(await r.arrayBuffer()),
        mime: "audio/mpeg",
        ext: "mp3",
        costUsd: null,
      };
    }

    case "elevenlabs:music": {
      const r = await json(
        "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128",
        {
          prompt: req.prompt,
          model_id: choice.model,
          music_length_ms: Math.min(
            600_000,
            Math.max(3000, Math.round((req.seconds ?? 30) * 1000)),
          ),
        },
        { "xi-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "ElevenLabs");
      return {
        data: Buffer.from(await r.arrayBuffer()),
        mime: "audio/mpeg",
        ext: "mp3",
        costUsd: null,
      };
    }

    case "elevenlabs:sound": {
      const r = await json(
        "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
        {
          text: req.prompt,
          model_id: choice.model,
          ...(req.seconds && { duration_seconds: Math.min(30, Math.max(0.5, req.seconds)) }),
        },
        { "xi-api-key": ctx.key },
      );
      if (!r.ok) await failed(r, "ElevenLabs");
      return {
        data: Buffer.from(await r.arrayBuffer()),
        mime: "audio/mpeg",
        ext: "mp3",
        costUsd: null,
      };
    }
  }
  throw new MediaError(`${choice.provider} cannot make ${req.kind}`);
}

/** The voices of an ElevenLabs account: the default ones and the person's own. */
export async function elevenVoices(
  key: string,
  f: typeof fetch = fetch,
): Promise<{ id: string; label: string }[]> {
  const r = await f("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": key },
  });
  if (!r.ok) await failed(r, "ElevenLabs");
  const j = (await r.json()) as { voices?: { voice_id: string; name: string }[] };
  return (j.voices ?? []).map((v) => ({ id: v.voice_id, label: v.name }));
}

async function elevenFirstVoice(f: typeof fetch, key: string): Promise<string> {
  const first = (await elevenVoices(key, f))[0];
  if (!first) throw new MediaError("The ElevenLabs account has no voice: choose one in Settings");
  return first.id;
}
