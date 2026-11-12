// Hands-free voice (G38.4) in the browser: the microphone, the wake-word model with its bars, the
// browser's own voice, and the conversation the words go to. The microphone is open only while
// hands-free is on, the page is in front and something listens (the wake word, or a turn in
// progress); the indicator in the top bar says so all the time it is.
import { signal } from "@preact/signals";
import type { Event, Job, JobProgress } from "@redgiant/protocol";
import { t } from "../i18n.js";
import { activeTab, getApi, getLive, sessionView, tabs } from "../state.js";
import { VoiceController } from "./controller.js";
import { voiceSettings } from "./settings.js";
import { chunksForVoice, withVoiceHint } from "./speakable.js";
import { downsample } from "./vad.js";
import {
  modelLoadedBefore,
  startVosk,
  WAKE_MODEL_FILES,
  type WakeLang,
  type WakeSpotter,
} from "./wake.js";

/** Where the wake-word model is, as the page shows it. */
export type WakeModelState =
  | { state: "none" }
  /** RedGiant's server is downloading it (once for every device). */
  | { state: "server"; job: Job }
  /** This page is downloading it from the server (once for this browser). */
  | { state: "page"; progress: JobProgress }
  /** Unpacking and starting it. */
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string };

export const wakeModel = signal<WakeModelState>({ state: "none" });
/** The microphone: closed, open, or refused by the person or the browser. */
export const micState = signal<"closed" | "opening" | "open" | "denied">("closed");
/** The page is behind another one (or the phone is locked): nothing listens. */
export const voicePaused = signal(false);

// ---------- The browser's voice ----------

/** The browser's voices for a language, the default first. */
export function voicesFor(lang: WakeLang): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === "undefined") return [];
  const all = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
  return all.sort((a, b) => Number(b.default) - Number(a.default));
}

let hushed: (() => void) | undefined;

/** Reads aloud with the browser's voice; resolves at the end or when hushed. */
export function speak(text: string): Promise<void> {
  if (typeof speechSynthesis === "undefined" || !text.trim()) return Promise.resolve();
  const { lang, voice } = voiceSettings.value;
  const chosen =
    voicesFor(lang).find((v) => v.voiceURI === voice) ?? voicesFor(lang)[0] ?? undefined;
  speechSynthesis.cancel();
  return new Promise((done) => {
    const pieces = chunksForVoice(text);
    let left = pieces.length;
    const end = () => {
      hushed = undefined;
      done();
    };
    hushed = end;
    for (const piece of pieces) {
      const u = new SpeechSynthesisUtterance(piece);
      u.lang = lang === "it" ? "it-IT" : "en-US";
      if (chosen) u.voice = chosen;
      u.onend = u.onerror = () => {
        left--;
        if (left <= 0) end();
      };
      speechSynthesis.speak(u);
    }
  });
}

function hush(): void {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  hushed?.();
}

let audio: AudioContext | undefined;
/** Two short notes: the wake word was heard. */
function chime(): void {
  if (!audio) return;
  const now = audio.currentTime;
  for (const [i, hz] of [660, 990].entries()) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, now + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
    o.connect(g).connect(audio.destination);
    o.start(now + i * 0.12);
    o.stop(now + i * 0.12 + 0.12);
  }
}

// ---------- The conversation ----------

/** The conversation the words go to: the one set in Settings, or the one open in front. */
export function voiceTarget(): string | undefined {
  const target = voiceSettings.value.target;
  if (target.kind === "session") return target.sessionId;
  const tab = tabs.value.find((x) => x.id === activeTab.value);
  return tab?.type === "chat" ? tab.sessionId : undefined;
}

const answerText = (e: Event) =>
  e.type === "message.assistant" && e.payload
    ? e.payload.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n")
    : "";

/**
 * Sends the words, marked as said by voice and with the note for the model at their end, and
 * waits for the turn's final answer (a message that asks for no more tools, the turn over).
 */
export function askConversation(
  sessionId: string,
  text: string,
  stop: AbortSignal,
): Promise<string> {
  const view = sessionView(sessionId);
  const live = getLive();
  // Followed already when it is open; a conversation set in Settings may not be.
  live.send({ type: "session.follow", sessionId });
  const sent = withVoiceHint(text);
  const after = view.value.events.at(-1)?.seq ?? -1;
  live.send({
    type: "session.send",
    sessionId,
    text: sent,
    via: "voice",
    clientId: `v${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  });
  return new Promise((resolve, reject) => {
    let mine = -1;
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(new Error(t("voiceTooLong"))), 15 * 60_000);
    const finish = (err?: Error, answer?: string) => {
      clearTimeout(timer);
      unsubscribe();
      if (err) reject(err);
      else resolve(answer ?? "");
    };
    stop.addEventListener("abort", () => finish(new Error("stopped")), { once: true });
    unsubscribe = view.subscribe((v) => {
      if (mine < 0) {
        const e = v.events.find(
          (x) => x.seq > after && x.type === "message.user" && x.payload?.text === sent,
        );
        if (!e) return;
        mine = e.seq;
      }
      if (v.state === "running") return;
      const last = v.events.filter((x) => x.seq > mine && x.type === "message.assistant").at(-1);
      if (!last || (last.type === "message.assistant" && last.payload?.stopReason === "tool_use"))
        return;
      queueMicrotask(() => finish(undefined, answerText(last)));
    });
  });
}

// ---------- The microphone and the wake word ----------

let controller: VoiceController | undefined;
let stream: MediaStream | undefined;
let processor: ScriptProcessorNode | undefined;
let spotter: WakeSpotter | undefined;
let spotterLang: WakeLang | undefined;

export function voiceController(): VoiceController {
  controller ??= new VoiceController(
    {
      transcribe: (wav) =>
        getApi().transcribe(
          new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
          voiceSettings.value.lang,
        ),
      ask: (text, stop) => {
        const target = voiceTarget();
        if (!target) return Promise.reject(new Error(t("voiceNoConversation")));
        return askConversation(target, text, stop);
      },
      speak,
      hush,
      chime,
      more: () => t("voiceRestOnScreen"),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
    {
      sensitivity: () => voiceSettings.value.sensitivity,
      bargeIn: () => voiceSettings.value.bargeIn,
      followupMs: () => voiceSettings.value.followupSec * 1000,
    },
  );
  return controller;
}

async function openMic(): Promise<void> {
  if (stream || micState.value === "opening") return;
  micState.value = "opening";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    micState.value = "denied";
    return;
  }
  audio ??= new AudioContext();
  if (audio.state === "suspended") await audio.resume().catch(() => {});
  const source = audio.createMediaStreamSource(stream);
  // A ScriptProcessor: old, but every browser has it (iOS Safari included), and a frame every
  // ~85 ms is enough for speech.
  processor = audio.createScriptProcessor(4096, 1, 1);
  const rate = audio.sampleRate;
  processor.onaudioprocess = (e) => {
    const samples = downsample(new Float32Array(e.inputBuffer.getChannelData(0)), rate, 16000);
    const c = voiceController();
    const p = c.phase;
    if (
      spotter &&
      voiceSettings.value.wake &&
      (p === "idle" || p === "speaking" || p === "followup")
    )
      spotter.feed(samples);
    c.feed(samples);
  };
  source.connect(processor);
  // Connected to the output (silent) or some browsers never call it.
  processor.connect(audio.destination);
  micState.value = "open";
}

function closeMic(): void {
  processor?.disconnect();
  processor = undefined;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = undefined;
  if (micState.value !== "denied") micState.value = "closed";
}

/** Downloads with a real bar: bytes, speed and time left. */
async function fetchWithProgress(url: string, onProgress: (p: JobProgress) => void): Promise<void> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get("content-length")) || null;
  const reader = r.body.getReader();
  const started = performance.now();
  let done = 0;
  let shown = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    done += value.length;
    const now = performance.now();
    if (now - shown > 200) {
      shown = now;
      const seconds = (now - started) / 1000;
      const rate = seconds > 0.5 ? done / seconds : null;
      onProgress({
        done,
        total,
        rate,
        secondsLeft: rate && total ? Math.max(0, (total - done) / rate) : null,
      });
    }
  }
}

/** Gets the wake-word model to the page (server first, then the browser) and starts it. */
export async function prepareWakeWord(lang: WakeLang): Promise<void> {
  if (spotter && spotterLang === lang) return;
  spotter?.dispose();
  spotter = undefined;
  try {
    const api = getApi();
    let state = await api.wakeModel(lang);
    if (!state.ready) {
      const started = await api.prepareWakeModel(lang);
      let job = started.job;
      while (job && job.state === "running") {
        wakeModel.value = { state: "server", job };
        await new Promise((r) => setTimeout(r, 1000));
        job = await api.job(job.id);
      }
      if (job) wakeModel.value = { state: "server", job };
      if (job && job.state !== "done") throw new Error(job.error?.message ?? t("voiceModelFailed"));
      state = await api.wakeModel(lang);
      if (!state.ready) throw new Error(t("voiceModelFailed"));
    }
    const url = `/api/voice/wake-models/${WAKE_MODEL_FILES[lang]}`;
    // The first time this browser sees it: downloaded here with its bar; the worker then finds it
    // in the browser's cache and keeps its own unpacked copy.
    if (!modelLoadedBefore(lang)) {
      wakeModel.value = {
        state: "page",
        progress: { done: 0, total: state.size, rate: null, secondsLeft: null },
      };
      await fetchWithProgress(url, (progress) => (wakeModel.value = { state: "page", progress }));
    }
    wakeModel.value = { state: "loading" };
    spotter = await startVosk(
      new URL(url, location.href).toString(),
      lang,
      () => voiceSettings.value.sensitivity,
      (what) => {
        spotter?.reset();
        voiceController().heard(what);
      },
    );
    spotterLang = lang;
    wakeModel.value = { state: "ready" };
  } catch (err) {
    wakeModel.value = { state: "error", message: (err as Error).message };
  }
}

/** Brings everything in line with the settings, the page's visibility and the phase. */
export async function syncVoice(): Promise<void> {
  const s = voiceSettings.value;
  const c = voiceController();
  if (!s.enabled) {
    c.dispatch({ type: "off" });
    closeMic();
    spotter?.dispose();
    spotter = undefined;
    spotterLang = undefined;
    return;
  }
  c.dispatch({ type: "start", wake: s.wake });
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  voicePaused.value = hidden;
  const busy = c.phase !== "idle" && c.phase !== "off";
  if (hidden) {
    // Behind another page or with the phone locked: nothing is heard (the browser would cut the
    // microphone anyway on a phone). A turn being answered goes on in the conversation.
    if (busy) c.dispatch({ type: "stop" });
    closeMic();
    return;
  }
  if (s.wake || busy) await openMic();
  else closeMic();
  if (s.wake) void prepareWakeWord(s.lang);
}

/** Switches hands-free on from a tap (the browser lets sound and voice start only from one). */
export async function startHandsFree(): Promise<void> {
  audio ??= new AudioContext();
  await audio.resume().catch(() => {});
  // iOS lets the page speak only after it spoke once from a tap.
  if (typeof speechSynthesis !== "undefined")
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  await syncVoice();
}

/** «Speak»: a request without the wake word. */
export async function talkNow(): Promise<void> {
  audio ??= new AudioContext();
  await audio.resume().catch(() => {});
  await openMic();
  if (micState.value !== "open") return;
  const c = voiceController();
  if (c.phase === "off") c.dispatch({ type: "start", wake: voiceSettings.value.wake });
  if (c.phase === "idle" || c.phase === "followup" || c.phase === "speaking")
    c.dispatch({ type: "wake" });
}

/** «Stop»: ends the turn (the conversation itself goes on as it was). */
export function stopTalking(): void {
  voiceController().dispatch({ type: "stop" });
  void syncVoice();
}

let installed = false;
/** Follows settings and visibility for the page's lifetime. */
export function installVoice(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => void syncVoice());
  let before = voiceSettings.value;
  voiceSettings.subscribe((s) => {
    if (s === before) return;
    before = s;
    void syncVoice();
  });
  // A turn over with the wake word off: the microphone closes again. A failure is said aloud
  // too: hands-free, the person may not be looking.
  let lastError: string | undefined;
  voiceController().state.subscribe((st) => {
    if (st.phase === "idle" && !voiceSettings.value.wake) closeMic();
    if (st.error && st.error !== lastError) void speak(t("voiceFailedSpoken", { error: st.error }));
    lastError = st.error;
  });
  if (voiceSettings.value.enabled) void syncVoice();
}
