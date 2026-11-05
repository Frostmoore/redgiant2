// Voice messages (G20.2): audio from the browser or Telegram becomes text before it reaches an
// agent. Two kinds of service: whisper-asr-webservice (self-hosted, converts any format with its
// own ffmpeg) and any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq,
// whisper.cpp's server, speaches…).

import { oggOpusToWav } from "./local-voice.js";

export interface TranscriptionConfig {
  /** "local": whisper.cpp on this computer (RedGiant 3.0), started by RedGiant itself. */
  api: "whisper-asr" | "openai" | "local";
  /** whisper-asr: its base URL; openai: the API base, e.g. https://api.openai.com/v1. */
  url: string;
  /** For "openai": the model (whisper-1 by default). */
  model?: string;
  key?: string;
}

export class TranscriptionError extends Error {}

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** Turns an audio clip into text. Throws `TranscriptionError` with a readable message. */
export async function transcribe(
  audio: Uint8Array,
  mime: string,
  cfg: TranscriptionConfig,
  opts: { language?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  if (audio.length === 0) throw new TranscriptionError("The recording is empty");
  if (audio.length > MAX_AUDIO_BYTES) throw new TranscriptionError("The recording is too long");
  let type = mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  // whisper.cpp reads WAV, not Opus: voice notes from the chats are decoded here first.
  if (cfg.api === "local" && (type === "audio/ogg" || type === "audio/opus")) {
    audio = await oggOpusToWav(audio).catch(() => {
      throw new TranscriptionError("This voice note could not be decoded");
    });
    type = "audio/wav";
  }
  const file = new Blob([new Uint8Array(audio)], { type });
  const name = `voice.${EXTENSIONS[type] ?? "bin"}`;
  const base = cfg.url.replace(/\/+$/, "");
  const body = new FormData();
  let url: string;
  if (cfg.api === "whisper-asr") {
    const q = new URLSearchParams({
      task: "transcribe",
      output: "txt",
      encode: "true",
      vad_filter: "true",
      ...(opts.language && { language: opts.language }),
    });
    url = `${base}/asr?${q}`;
    body.set("audio_file", file, name);
  } else {
    url = `${base}/audio/transcriptions`;
    body.set("file", file, name);
    body.set("model", cfg.model ?? "whisper-1");
    body.set("response_format", "text");
    if (opts.language) body.set("language", opts.language);
  }
  let r: Response;
  try {
    r = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      body,
      ...(cfg.key && { headers: { authorization: `Bearer ${cfg.key}` } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000),
    });
  } catch (err) {
    throw new TranscriptionError(
      (err as Error).name === "TimeoutError"
        ? "The transcription service took too long"
        : `The transcription service is unreachable: ${(err as Error).message}`,
    );
  }
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    throw new TranscriptionError(
      r.status === 401 || r.status === 403
        ? "The transcription service refused the key"
        : `The transcription service answered ${r.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const text = await r.text();
  // response_format=text is plain text; some servers send JSON anyway.
  const plain = text.trimStart().startsWith("{")
    ? ((JSON.parse(text) as { text?: string }).text ?? "")
    : text;
  return plain.replace(/\s+/g, " ").trim();
}
