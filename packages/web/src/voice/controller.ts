// Hands-free voice (G38.4): the state machine at work. The page gives it the microphone's samples
// (16 kHz) and what the wake-word listener heard; it keeps what is said, finds where speech ends
// (`Vad`), and through its ports transcribes, asks the conversation, reads the answer and keeps
// time. The ports are the only way out, so a whole conversation is tested with fakes.
import { signal } from "@preact/signals";
import {
  initialVoice,
  stepVoice,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from "./machine.js";
import { speakable } from "./speakable.js";
import { encodeWav, Vad } from "./vad.js";

export interface VoicePorts {
  transcribe(wav: Uint8Array): Promise<string>;
  /** Sends the person's words to the conversation; resolves with the agent's final answer. */
  ask(text: string, signal: AbortSignal): Promise<string>;
  /** Reads aloud; resolves when done or hushed. */
  speak(text: string): Promise<void>;
  hush(): void;
  chime(): void;
  /** «The rest is on the screen», in the person's language. */
  more(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export interface VoiceOptions {
  sensitivity: () => number;
  bargeIn: () => boolean;
  followupMs: () => number;
  /** After the wake word, how long to wait for the first word. */
  listenMs?: number;
  /** A pause this long ends the request. */
  endSilenceMs?: number;
}

const RATE = 16000;
/** Kept from before speech is noticed, so its first syllable is not lost. */
const PREROLL = RATE * 0.5;

export class VoiceController {
  readonly state = signal<VoiceState>(initialVoice());
  private readonly vad: Vad;
  private recording = false;
  private kept: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  private timer: unknown;
  private turn = 0;
  private asking: AbortController | undefined;
  /** Which reading is the current one: an older one ending late says nothing. */
  private reading = 0;

  constructor(
    private readonly ports: VoicePorts,
    private readonly o: VoiceOptions,
  ) {
    this.vad = new Vad({
      sampleRate: RATE,
      sensitivity: o.sensitivity(),
      endSilenceMs: o.endSilenceMs ?? 900,
    });
  }

  get phase() {
    return this.state.value.phase;
  }

  dispatch(e: VoiceEvent): void {
    const before = this.state.value;
    const { state, effects } = stepVoice(before, e);
    if (state.phase !== before.phase) {
      // A new phase counts its speech afresh; leaving a turn makes its late answers stale.
      this.vad.reset();
      this.vad.boost = state.phase === "speaking" ? 3 : 1;
      this.vad.sensitivity = this.o.sensitivity();
      if (state.phase === "idle" || state.phase === "off") this.turn++;
    }
    this.state.value = state;
    for (const fx of effects) this.run(fx);
    // The microphone is always open while the conversation runs: recording is ready at once.
    if (state.phase === "wake") this.dispatch({ type: "ready" });
  }

  /** What the wake-word listener heard. */
  heard(what: "wake" | "stop"): void {
    const p = this.phase;
    if (what === "stop") {
      if (p !== "idle" && p !== "off") this.dispatch({ type: "stopWord" });
      return;
    }
    if (p === "idle" || p === "speaking" || p === "followup") this.dispatch({ type: "wake" });
  }

  /** The microphone's samples, mono at 16 kHz. */
  feed(samples: Float32Array): void {
    this.preroll.push(samples);
    this.prerollLen += samples.length;
    while (this.prerollLen - (this.preroll[0]?.length ?? 0) >= PREROLL) {
      this.prerollLen -= (this.preroll.shift() as Float32Array).length;
    }
    if (this.recording) this.kept.push(samples);
    const p = this.phase;
    const watching =
      p === "listening" || p === "followup" || (p === "speaking" && this.o.bargeIn());
    if (!watching) {
      // The room's noise is still learned while waiting.
      if (p === "idle") this.vad.push(samples);
      return;
    }
    for (const ev of this.vad.push(samples)) {
      const now = this.phase;
      if (ev === "start") {
        if (now === "speaking") {
          this.dispatch({ type: "bargeIn" });
          this.dispatch({ type: "speechStart" });
        } else this.dispatch({ type: "speechStart" });
      } else if (ev === "end" && now === "listening") this.dispatch({ type: "speechEnd" });
    }
  }

  private run(fx: VoiceEffect): void {
    const turn = this.turn;
    const live = () => turn === this.turn;
    switch (fx.do) {
      case "chime":
        this.ports.chime();
        return;
      case "record":
        this.recording = true;
        this.kept = [...this.preroll];
        return;
      case "discard":
        this.recording = false;
        this.kept = [];
        return;
      case "transcribe": {
        this.recording = false;
        const total = this.kept.reduce((n, k) => n + k.length, 0);
        const pcm = new Float32Array(total);
        let at = 0;
        for (const k of this.kept) {
          pcm.set(k, at);
          at += k.length;
        }
        this.kept = [];
        this.ports.transcribe(encodeWav(pcm, RATE)).then(
          (text) => live() && this.dispatch({ type: "transcribed", text }),
          (err: Error) => live() && this.dispatch({ type: "failed", error: err.message }),
        );
        return;
      }
      case "send": {
        const ask = new AbortController();
        this.asking = ask;
        this.ports.ask(fx.text, ask.signal).then(
          (answer) =>
            live() && this.dispatch({ type: "answer", text: speakable(answer, this.ports.more()) }),
          (err: Error) =>
            live() && !ask.signal.aborted && this.dispatch({ type: "failed", error: err.message }),
        );
        return;
      }
      case "abandon":
        this.asking?.abort();
        this.asking = undefined;
        return;
      case "speak": {
        const reading = ++this.reading;
        void this.ports.speak(fx.text).then(() => {
          if (live() && reading === this.reading && this.phase === "speaking")
            this.dispatch({ type: "spoken" });
        });
        return;
      }
      case "hush":
        this.ports.hush();
        return;
      case "timer": {
        this.clear();
        const ms = fx.which === "listen" ? (this.o.listenMs ?? 7000) : this.o.followupMs();
        const ev: VoiceEvent =
          fx.which === "listen" ? { type: "silence" } : { type: "followupOver" };
        this.timer = this.ports.setTimer(() => {
          this.timer = undefined;
          if (live()) this.dispatch(ev);
        }, ms);
        return;
      }
      case "cancelTimer":
        this.clear();
        return;
    }
  }

  private clear(): void {
    if (this.timer !== undefined) this.ports.clearTimer(this.timer);
    this.timer = undefined;
  }
}
