// Hands-free voice (G38.4): its settings belong to this device (a phone on the kitchen table and
// the computer in the study want different ones), so they live in the browser, not on the server.
import { signal } from "@preact/signals";
import { type SpeechChoice, voiceProvider } from "@redgiant/protocol";
import { type WakeLang, wakeLabel } from "./wake.js";

export interface VoiceSettings {
  /** Hands-free on this device: the indicator in the top bar, the conversation by voice. */
  enabled: boolean;
  /** Listen for the wake word («Ehi RedGiant» or the person's own) while the page is in front. */
  wake: boolean;
  /** The person's own wake word for a language, as they wrote it (3.7.3); none: «Ehi RedGiant». */
  wakeWords: Partial<Record<WakeLang, string>>;
  /** 0…1: how easily the wake word and speech are taken (the VAD's and Vosk's thresholds). */
  sensitivity: number;
  /** The language spoken and heard. */
  lang: WakeLang;
  /** The browser's voice (its voiceURI); null: the first one for the language. */
  voice: string | null;
  /** Who reads the answers (3.7.3): the browser's voice, or a provider in the cloud. */
  reader: SpeechChoice;
  /** How loud the answers are read, in percent (3.7.3): above 100 only where Web Audio can. */
  volume: number;
  /** Seconds after the answer during which speaking again needs no wake word (0: none). */
  followupSec: number;
  /** Speaking over the answer stops it (with loudspeakers its own voice may, too). */
  bargeIn: boolean;
  /** Where what is said goes: the conversation open in front, or always the same one. */
  target: { kind: "open" } | { kind: "session"; sessionId: string; title: string };
}

export const defaultVoiceSettings = (lang: string): VoiceSettings => ({
  enabled: false,
  wake: true,
  sensitivity: 0.5,
  lang: lang === "it" ? "it" : "en",
  voice: null,
  wakeWords: {},
  reader: { kind: "browser" },
  volume: DEFAULT_VOLUME,
  followupSec: 8,
  bargeIn: true,
  target: { kind: "open" },
});

const KEY = "rg.voice";

/** Louder than before (3.7.3, the person: «il volume è troppo basso»). */
export const DEFAULT_VOLUME = 150;
export const MIN_VOLUME = 25;
export const MAX_VOLUME = 200;

function readReader(r: unknown): SpeechChoice {
  const x = r as Partial<{ kind: string; provider: string; model: string; voice: string }>;
  if (x?.kind !== "cloud" || typeof x.provider !== "string" || typeof x.model !== "string")
    return { kind: "browser" };
  const p = voiceProvider(x.provider);
  if (!p?.tts?.some((m) => m.id === x.model)) return { kind: "browser" };
  return {
    kind: "cloud",
    provider: p.id,
    model: x.model,
    ...(typeof x.voice === "string" && { voice: x.voice }),
  };
}

export function loadVoiceSettings(lang: string): VoiceSettings {
  const base = defaultVoiceSettings(lang);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<VoiceSettings> | null;
    if (!saved || typeof saved !== "object") return base;
    return {
      enabled: saved.enabled === true,
      wake: saved.wake !== false,
      sensitivity:
        typeof saved.sensitivity === "number"
          ? Math.max(0, Math.min(1, saved.sensitivity))
          : base.sensitivity,
      lang: saved.lang === "it" || saved.lang === "en" ? saved.lang : base.lang,
      voice: typeof saved.voice === "string" ? saved.voice : null,
      wakeWords: {
        ...(typeof saved.wakeWords?.it === "string" && { it: saved.wakeWords.it.slice(0, 60) }),
        ...(typeof saved.wakeWords?.en === "string" && { en: saved.wakeWords.en.slice(0, 60) }),
      },
      reader: readReader(saved.reader),
      volume:
        typeof saved.volume === "number"
          ? Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(saved.volume)))
          : DEFAULT_VOLUME,
      followupSec:
        typeof saved.followupSec === "number"
          ? Math.max(0, Math.min(30, Math.round(saved.followupSec)))
          : base.followupSec,
      bargeIn: saved.bargeIn !== false,
      target:
        saved.target?.kind === "session" && typeof saved.target.sessionId === "string"
          ? {
              kind: "session",
              sessionId: saved.target.sessionId,
              title: String(saved.target.title ?? ""),
            }
          : { kind: "open" },
    };
  } catch {
    return base;
  }
}

export const voiceSettings = signal<VoiceSettings>(
  loadVoiceSettings(
    typeof navigator !== "undefined" && navigator.language?.startsWith("it") ? "it" : "en",
  ),
);

export function setVoiceSettings(patch: Partial<VoiceSettings>): void {
  voiceSettings.value = { ...voiceSettings.value, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(voiceSettings.value));
  } catch {
    // Private browsing: kept for this visit only.
  }
}

/** The wake word this device listens for, as the page names it («Ehi RedGiant» by default). */
export const currentWake = (): string =>
  wakeLabel(voiceSettings.value.lang, voiceSettings.value.wakeWords[voiceSettings.value.lang]);
