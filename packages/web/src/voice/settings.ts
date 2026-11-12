// Hands-free voice (G38.4): its settings belong to this device (a phone on the kitchen table and
// the computer in the study want different ones), so they live in the browser, not on the server.
import { signal } from "@preact/signals";
import type { WakeLang } from "./wake.js";

export interface VoiceSettings {
  /** Hands-free on this device: the indicator in the top bar, the conversation by voice. */
  enabled: boolean;
  /** Listen for «Ehi RedGiant» while the page is open and in front. */
  wake: boolean;
  /** 0…1: how easily the wake word and speech are taken (the VAD's and Vosk's thresholds). */
  sensitivity: number;
  /** The language spoken and heard. */
  lang: WakeLang;
  /** The browser's voice (its voiceURI); null: the first one for the language. */
  voice: string | null;
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
  followupSec: 8,
  bargeIn: true,
  target: { kind: "open" },
});

const KEY = "rg.voice";

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
