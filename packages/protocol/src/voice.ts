/**
 * Hands-free voice in the cloud (3.7.3): who may write down what the person says (speech to text)
 * and who may read the answers aloud (text to speech), besides whisper and the browser's voices.
 * Models, endpoints and prices checked on each provider's documentation on 2026-11-14:
 * developers.openai.com/api/docs (guides speech-to-text, text-to-speech, pricing),
 * console.groq.com/docs/speech-to-text, elevenlabs.io/docs/models and elevenlabs.io/pricing/api,
 * aistudio.google.com/docs/speech-generation.
 */

export type VoiceProviderId = "openai" | "groq" | "elevenlabs" | "google";

/** An indicative price: dollars per minute of audio, per 1000 characters read, or per 1M tokens. */
export interface VoicePrice {
  usd: number;
  per: "minute" | "kchars" | "mtokens";
}

export interface VoiceModel {
  id: string;
  /** How people call it (brand words, the same in every language). */
  label: string;
  price?: VoicePrice;
  /** The provider closes it on this day (yyyy-mm-dd). */
  closes?: string;
  /** Voices this model may use, when not all of the provider's. */
  voices?: readonly string[];
}

export interface VoiceProvider {
  id: VoiceProviderId;
  /** The brand, the same in every language. */
  name: string;
  keyUrl: string;
  keyExample: string;
  /** Where the request goes (the keychain entry allows these hosts only). */
  hosts: readonly string[];
  /** A chat provider's key that works here too (`KEY_PROVIDERS` id). */
  chatKey?: string;
  /** A generation provider's key that works here too (`MEDIA_PROVIDERS` id). */
  mediaKey?: string;
  /** Newest first; the first one is the default. */
  stt?: readonly VoiceModel[];
  tts?: readonly VoiceModel[];
  /** Voices for reading; none: read from the account with the key (ElevenLabs). */
  voices?: readonly { id: string; label: string }[];
}

const OPENAI_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];
/** tts-1 and tts-1-hd know fewer voices. */
const OPENAI_TTS1_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
];

const GEMINI_VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Zephyr",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
];

export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyExample: "sk-proj-…",
    hosts: ["api.openai.com"],
    chatKey: "openai",
    mediaKey: "openai",
    stt: [
      { id: "gpt-transcribe", label: "GPT Transcribe", price: { usd: 0.0045, per: "minute" } },
      {
        id: "gpt-4o-mini-transcribe",
        label: "GPT-4o mini Transcribe",
        price: { usd: 0.003, per: "minute" },
        closes: "2027-02-26",
      },
      {
        id: "gpt-4o-transcribe",
        label: "GPT-4o Transcribe",
        price: { usd: 0.006, per: "minute" },
        closes: "2027-02-26",
      },
      {
        id: "whisper-1",
        label: "Whisper",
        price: { usd: 0.006, per: "minute" },
        closes: "2027-02-26",
      },
    ],
    tts: [
      {
        id: "gpt-4o-mini-tts",
        label: "GPT-4o mini TTS",
        price: { usd: 12, per: "mtokens" },
        closes: "2027-01-06",
      },
      {
        id: "tts-1-hd",
        label: "TTS-1 HD",
        price: { usd: 0.03, per: "kchars" },
        closes: "2027-01-06",
        voices: OPENAI_TTS1_VOICES,
      },
      {
        id: "tts-1",
        label: "TTS-1",
        price: { usd: 0.015, per: "kchars" },
        closes: "2027-01-06",
        voices: OPENAI_TTS1_VOICES,
      },
    ],
    voices: OPENAI_VOICES.map((v) => ({ id: v, label: v.charAt(0).toUpperCase() + v.slice(1) })),
  },
  {
    id: "groq",
    name: "Groq",
    keyUrl: "https://console.groq.com/keys",
    keyExample: "gsk_…",
    hosts: ["api.groq.com"],
    chatKey: "groq",
    stt: [
      {
        id: "whisper-large-v3-turbo",
        label: "Whisper Large v3 Turbo",
        price: { usd: 0.04 / 60, per: "minute" },
      },
      {
        id: "whisper-large-v3",
        label: "Whisper Large v3",
        price: { usd: 0.111 / 60, per: "minute" },
      },
    ],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    keyExample: "sk_…",
    hosts: ["api.elevenlabs.io"],
    mediaKey: "elevenlabs",
    stt: [
      { id: "scribe_v3", label: "Scribe v3", price: { usd: 0.2 / 60, per: "minute" } },
      { id: "scribe_v2", label: "Scribe v2", price: { usd: 0.2 / 60, per: "minute" } },
    ],
    tts: [
      { id: "eleven_v4_turbo", label: "Eleven v4 Turbo", price: { usd: 0.04, per: "kchars" } },
      { id: "eleven_v4", label: "Eleven v4", price: { usd: 0.08, per: "kchars" } },
      { id: "eleven_flash_v2_5", label: "Eleven Flash v2.5", price: { usd: 0.04, per: "kchars" } },
      {
        id: "eleven_multilingual_v2",
        label: "Eleven Multilingual v2",
        price: { usd: 0.08, per: "kchars" },
      },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    keyExample: "AIza…",
    hosts: ["generativelanguage.googleapis.com"],
    chatKey: "gemini",
    mediaKey: "google",
    tts: [
      { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash Lite TTS" },
      { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS" },
    ],
    voices: GEMINI_VOICES.map((v) => ({ id: v, label: v })),
  },
];

export const voiceProvider = (id: string): VoiceProvider | undefined =>
  VOICE_PROVIDERS.find((p) => p.id === id);

/** The voices a model may read with (all the provider's, or its own shorter list). */
export function voicesForModel(p: VoiceProvider, model: string): { id: string; label: string }[] {
  const only = p.tts?.find((m) => m.id === model)?.voices;
  const all = p.voices ?? [];
  return only ? all.filter((v) => only.includes(v.id)) : [...all];
}

/** Who writes down what is said, as the setup keeps it. */
export type TranscriptionChoice =
  /** whisper.cpp on this computer, started by RedGiant. */
  | { api: "local"; url: "" }
  /** whisper-asr-webservice on another computer, at its address. */
  | { api: "whisper-asr"; url: string }
  /** Any OpenAI-compatible `/audio/transcriptions` (speaches, whisper.cpp's server…). */
  | { api: "openai"; url: string; model?: string }
  /** A provider in the cloud, with the key already given (chat, generation or voice). */
  | { api: "cloud"; url: ""; provider: VoiceProviderId; model: string };

/** Who reads the answers on this device: the browser, or a provider through the server. */
export type SpeechChoice =
  | { kind: "browser" }
  | { kind: "cloud"; provider: VoiceProviderId; model: string; voice?: string };
