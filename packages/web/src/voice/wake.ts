// Hands-free voice (G38.4): the wake word, heard in the page. Vosk (Apache-2.0, WASM in a worker)
// with a small speech model (Apache-2.0) listens with a grammar of a few phrases only: «Ehi
// RedGiant» and the stop words, everything else is "[unk]". No audio leaves the page for it.
// The model comes from RedGiant's server, which downloads it once (its bar in the page); the page
// then keeps its own copy (IndexedDB), so the second time nothing is downloaded.

export type WakeLang = "it" | "en";

/** The phrases that wake RedGiant, as the models spell them («red» and «giant» are in both). */
export const WAKE_PHRASES: Record<WakeLang, string[]> = {
  it: ["ehi red giant", "hey red giant", "ei red giant", "red giant"],
  en: ["hey red giant", "hi red giant", "okay red giant", "red giant"],
};

/** Said while the answer is read: it stops (the wake word instead asks something new). */
export const STOP_PHRASES: Record<WakeLang, string[]> = {
  it: ["stop", "basta", "basta così", "zitto"],
  en: ["stop", "enough", "stop it", "be quiet"],
};

/** What the recogniser may hear: the phrases, and anything else as "[unk]". */
export function wakeGrammar(lang: WakeLang): string {
  return JSON.stringify([...WAKE_PHRASES[lang], ...STOP_PHRASES[lang], "[unk]"]);
}

export interface HeardWord {
  word: string;
  conf: number;
}

/**
 * What a final result means: the wake word, a stop word, or nothing. `minConf` comes from the
 * sensitivity: each word of the phrase must be at least that sure (Vosk reports 0…1).
 */
export function classifyHeard(
  lang: WakeLang,
  text: string,
  words: HeardWord[] | undefined,
  minConf: number,
): "wake" | "stop" | undefined {
  const said = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!said) return undefined;
  const sure = (phrase: string) => {
    if (!words?.length) return true;
    const need = new Set(phrase.split(" "));
    const mine = words.filter((w) => need.has(w.word));
    return mine.length > 0 && mine.every((w) => w.conf >= minConf);
  };
  const wake = WAKE_PHRASES[lang].find((p) => said.includes(p));
  if (wake) return sure("red giant") ? "wake" : undefined;
  const stop = STOP_PHRASES[lang].find((p) => said === p || said.endsWith(` ${p}`));
  if (stop) return sure(stop) ? "stop" : undefined;
  return undefined;
}

/** Word confidence needed for a sensitivity (0…1): 0 → 0.95, 0.5 → 0.75, 1 → 0.55. */
export const minConfFor = (sensitivity: number): number =>
  0.95 - Math.max(0, Math.min(1, sensitivity)) * 0.4;

/** The file name the server serves for a language's model (`wake-models.ts`, same table). */
export const WAKE_MODEL_FILES: Record<WakeLang, string> = {
  it: "vosk-model-small-it-0.22.tar.gz",
  en: "vosk-model-small-en-us-0.15.tar.gz",
};

/** The page has unpacked this model once already (its copy is in IndexedDB). */
const LOADED_KEY = "rg.voice.wakeLoaded";
export function modelLoadedBefore(lang: WakeLang): boolean {
  try {
    return (JSON.parse(localStorage.getItem(LOADED_KEY) ?? "[]") as string[]).includes(
      WAKE_MODEL_FILES[lang],
    );
  } catch {
    return false;
  }
}
export function markModelLoaded(lang: WakeLang): void {
  try {
    const now = new Set(JSON.parse(localStorage.getItem(LOADED_KEY) ?? "[]") as string[]);
    now.add(WAKE_MODEL_FILES[lang]);
    localStorage.setItem(LOADED_KEY, JSON.stringify([...now]));
  } catch {
    // Private browsing: it is downloaded again next time, nothing else changes.
  }
}

/** A running wake-word listener: feed it 16 kHz samples, it calls back what it heard. */
export interface WakeSpotter {
  feed(samples: Float32Array): void;
  /** Forgets what it heard so far (after it fired, so the same words do not fire twice). */
  reset(): void;
  dispose(): void;
}

/** Starts Vosk on a model already in the browser's cache (or fetched from `url`). */
export async function startVosk(
  url: string,
  lang: WakeLang,
  sensitivity: () => number,
  onHeard: (what: "wake" | "stop") => void,
): Promise<WakeSpotter> {
  const { createModel } = await import("vosk-browser");
  const model = await createModel(url, -1);
  markModelLoaded(lang);
  const make = () => {
    const r = new model.KaldiRecognizer(16000, wakeGrammar(lang));
    r.setWords(true);
    r.on("result", (m) => {
      if (m.event !== "result") return;
      const what = classifyHeard(lang, m.result.text, m.result.result, minConfFor(sensitivity()));
      if (what) onHeard(what);
    });
    return r;
  };
  let rec = make();
  return {
    feed: (samples) => rec.acceptWaveformFloat(new Float32Array(samples), 16000),
    reset: () => {
      rec.remove();
      rec = make();
    },
    dispose: () => {
      rec.remove();
      model.terminate();
    },
  };
}
