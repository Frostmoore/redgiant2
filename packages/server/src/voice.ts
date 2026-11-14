// Voice messages (G20.2): audio from the browser or the chats becomes text before it reaches an
// agent. Two kinds of service: whisper-asr-webservice (self-hosted, converts any format with its
// own ffmpeg) and any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, Groq,
// whisper.cpp's server, speaches…).

import { forWhisperCpp, sniffAudio } from "./local-voice.js";

export interface TranscriptionConfig {
  /**
   * "local": whisper.cpp on this computer (RedGiant 3.0), started by RedGiant itself;
   * "elevenlabs": ElevenLabs Scribe (3.7.3). OpenAI and Groq in the cloud are "openai".
   */
  api: "whisper-asr" | "openai" | "local" | "elevenlabs";
  /** whisper-asr: its base URL; openai: the API base, e.g. https://api.openai.com/v1. */
  url: string;
  /** For "openai" and "elevenlabs": the model (whisper-1 by default). */
  model?: string;
  key?: string;
  /** "local" on a Mac: the whisper binding reads WAV only. */
  wavOnly?: boolean;
  /** Who it is, named in the messages (a brand: "OpenAI", "Groq"…; "whisper" otherwise). */
  name?: string;
  /** A provider in the cloud chosen before its key was given. */
  noKey?: boolean;
  /** Ask for JSON (the cloud's transcription models answer only that). */
  json?: boolean;
  /** No language hint: the model keeps the language spoken (gpt-transcribe). */
  noLanguage?: boolean;
}

/**
 * Why a recording did not become text. The page and the chats say it in the person's language
 * from `code` (`err_<code>`, with `vars`); `message` is the English fallback for the log.
 */
export type TranscriptionCode =
  | "voice_no_service"
  | "voice_no_key"
  | "voice_empty"
  | "voice_too_long"
  | "voice_convert"
  | "voice_timeout"
  | "voice_unreachable"
  | "voice_key_refused"
  | "voice_rate_limited"
  | "voice_service_error";

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly code: TranscriptionCode = "voice_service_error",
    readonly vars: Record<string, string> = {},
    /** The HTTP status the server answers with. */
    readonly status: 400 | 413 | 502 = 502,
  ) {
    super(message);
  }
}

/** The error for an HTTP answer that is not ok (shared with the voice that reads). */
export function httpVoiceError(status: number, name: string, detail: string): TranscriptionError {
  if (status === 401 || status === 403)
    return new TranscriptionError(`${name} refused the key`, "voice_key_refused", { name });
  if (status === 429)
    return new TranscriptionError(`${name}: too many requests or no credit`, "voice_rate_limited", {
      name,
    });
  return new TranscriptionError(
    `${name} answered ${status}${detail ? `: ${detail}` : ""}`,
    "voice_service_error",
    { name, status: String(status) },
  );
}

/** The error for a request that never got an answer. */
export function fetchVoiceError(err: Error, name: string): TranscriptionError {
  return err.name === "TimeoutError" || err.name === "AbortError"
    ? new TranscriptionError(`${name} took too long`, "voice_timeout", { name })
    : new TranscriptionError(`${name} is unreachable: ${err.message}`, "voice_unreachable", {
        name,
      });
}

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  // OpenAI refuses ".aac"; ffmpeg behind it reads the content whatever the name.
  "audio/aac": "m4a",
  "audio/x-aac": "m4a",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

/** The type and file name to send, from the content when it is recognisable. */
const BY_CONTENT: Record<string, [string, string]> = {
  wav: ["audio/wav", "wav"],
  mp3: ["audio/mpeg", "mp3"],
  flac: ["audio/flac", "flac"],
  "ogg-opus": ["audio/ogg", "ogg"],
  "ogg-vorbis": ["audio/ogg", "ogg"],
  ogg: ["audio/ogg", "ogg"],
  webm: ["audio/webm", "webm"],
  mp4: ["audio/mp4", "m4a"],
  aac: ["audio/mp4", "m4a"],
};

/** Turns an audio clip into text. Throws `TranscriptionError` with a readable message. */
export async function transcribe(
  audio: Uint8Array,
  mime: string,
  cfg: TranscriptionConfig,
  opts: {
    language?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** The ffmpeg program, or how to get it (downloaded the first time it is needed). */
    ffmpeg?: string | (() => Promise<string | undefined>);
  } = {},
): Promise<string> {
  const name = cfg.name ?? (cfg.api === "local" ? "whisper.cpp" : "whisper");
  if (cfg.noKey || (cfg.api === "elevenlabs" && !cfg.key))
    throw new TranscriptionError(`${name} has no key yet`, "voice_no_key", { name }, 400);
  if (audio.length === 0)
    throw new TranscriptionError("The recording is empty", "voice_empty", {}, 400);
  if (audio.length > MAX_AUDIO_BYTES)
    throw new TranscriptionError("The recording is too long", "voice_too_long", {}, 413);
  let type = mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  // whisper.cpp reads WAV, MP3, FLAC and Ogg/Vorbis only: the rest is converted here first.
  if (cfg.api === "local") {
    ({ audio, type } = await forWhisperCpp(audio, type, {
      ...(opts.ffmpeg && { ffmpeg: opts.ffmpeg }),
      ...(cfg.wavOnly && { wavOnly: true }),
    }).catch((err) => {
      throw new TranscriptionError((err as Error).message, "voice_convert");
    }));
  }
  const known = BY_CONTENT[sniffAudio(audio)];
  if (known) type = known[0];
  const file = new Blob([new Uint8Array(audio)], { type });
  const fileName = `voice.${known?.[1] ?? EXTENSIONS[type] ?? "bin"}`;
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
    body.set("audio_file", file, fileName);
  } else if (cfg.api === "elevenlabs") {
    // ElevenLabs Scribe: POST /v1/speech-to-text, multipart, `xi-api-key`, JSON with `text`.
    url = `${base}/speech-to-text`;
    body.set("file", file, fileName);
    body.set("model_id", cfg.model ?? "scribe_v3");
    if (opts.language) body.set("language_code", opts.language);
  } else {
    url = `${base}/audio/transcriptions`;
    body.set("file", file, fileName);
    body.set("model", cfg.model ?? "whisper-1");
    body.set("response_format", cfg.json ? "json" : "text");
    if (opts.language && !cfg.noLanguage) body.set("language", opts.language);
  }
  const headers: Record<string, string> = {};
  if (cfg.key && cfg.api === "elevenlabs") headers["xi-api-key"] = cfg.key;
  else if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  let r: Response;
  try {
    r = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      body,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000),
    });
  } catch (err) {
    throw fetchVoiceError(err as Error, name);
  }
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    throw httpVoiceError(r.status, name, detail);
  }
  const text = await r.text();
  // response_format=text is plain text; the cloud answers JSON.
  let plain = text;
  if (text.trimStart().startsWith("{")) {
    try {
      plain = (JSON.parse(text) as { text?: string }).text ?? "";
    } catch {
      throw new TranscriptionError(`${name} answered something unreadable`, "voice_service_error", {
        name,
        status: String(r.status),
      });
    }
  }
  return plain.replace(/\s+/g, " ").trim();
}
