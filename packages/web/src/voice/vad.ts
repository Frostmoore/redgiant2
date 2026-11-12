// Hands-free voice (G38.4): when the person starts and stops speaking, from the microphone's
// loudness alone. The room's own noise is learned while nobody speaks (a floor that follows the
// quiet moments), and speech is what stays clearly above it for a while; the end is a pause long
// enough. Pure: frames in, events out, so thresholds are tested with synthetic audio.

export interface VadOptions {
  sampleRate: number;
  /** 0 (only clear, loud speech) … 1 (even a soft voice): how far above the room's noise. */
  sensitivity?: number;
  /** Speech must last this long to count (a cough, a click do not). */
  minSpeechMs?: number;
  /** A pause this long ends what is being said. */
  endSilenceMs?: number;
  /** Nobody speaks longer than this in one go: it ends there. */
  maxSpeechMs?: number;
  /** Louder than usual is needed (barge-in over the answer's own voice): a multiplier. */
  boost?: number;
}

export type VadEvent = "start" | "end";

/** The loudness of a frame: root mean square of its samples (-1…1). */
export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] as number;
    sum += v * v;
  }
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

/** How many times the floor speech must be, for a sensitivity: 0 → 6×, 0.5 → 3.5×, 1 → 1.8×. */
export function ratioFor(sensitivity: number): number {
  const s = Math.max(0, Math.min(1, sensitivity));
  return 6 - s * 5 + s * s * 0.8;
}

/** Below this nothing is speech, however quiet the room (a digital silence has a floor of 0). */
const ABSOLUTE_MIN = 0.004;
const FRAME_MS = 20;
const CALIBRATION_FRAMES = 15;

export class Vad {
  private readonly frame: number;
  private pending = new Float32Array(0);
  /** The room's noise, learned from quiet frames. */
  floor = 0.003;
  private speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private speechMs = 0;
  /** The first frames only learn the room: a microphone opened next to a fan is not speech. */
  private calibrating = CALIBRATION_FRAMES;
  boost: number;
  sensitivity: number;

  constructor(private readonly o: VadOptions) {
    this.frame = Math.round((o.sampleRate * FRAME_MS) / 1000);
    this.boost = o.boost ?? 1;
    this.sensitivity = o.sensitivity ?? 0.5;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** The level that counts as speech now. */
  get threshold(): number {
    return Math.max(ABSOLUTE_MIN, this.floor * ratioFor(this.sensitivity)) * this.boost;
  }

  /** Forgets the speech in progress (the floor stays: the room is the same). */
  reset(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.speechMs = 0;
  }

  /** Feeds samples (any length); returns what happened in them, in order. */
  push(samples: Float32Array): VadEvent[] {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const out: VadEvent[] = [];
    let at = 0;
    for (; at + this.frame <= all.length; at += this.frame) {
      const e = this.step(rms(all.subarray(at, at + this.frame)));
      if (e) out.push(e);
    }
    this.pending = all.slice(at);
    return out;
  }

  private step(level: number): VadEvent | undefined {
    if (this.calibrating > 0) {
      const n = CALIBRATION_FRAMES - this.calibrating;
      this.floor = n === 0 ? Math.max(level, 0.0005) : (this.floor * n + level) / (n + 1);
      this.calibrating--;
      return undefined;
    }
    const loud = level > this.threshold;
    if (!loud) {
      // The floor follows quiet frames: quickly down, slowly up (a fan switched on).
      this.floor =
        level < this.floor ? this.floor * 0.7 + level * 0.3 : this.floor * 0.98 + level * 0.02;
      this.floor = Math.max(this.floor, 0.0005);
    } else {
      // A noise that never stops (a fan switched on) slowly becomes the room's: it cannot hold
      // the conversation open for ever.
      this.floor = this.floor * 0.999 + level * 0.001;
    }
    const minSpeech = this.o.minSpeechMs ?? 200;
    const endSilence = this.o.endSilenceMs ?? 900;
    const maxSpeech = this.o.maxSpeechMs ?? 30_000;
    if (!this.speaking) {
      this.loudMs = loud ? this.loudMs + FRAME_MS : Math.max(0, this.loudMs - FRAME_MS * 2);
      if (this.loudMs >= minSpeech) {
        this.speaking = true;
        this.quietMs = 0;
        this.speechMs = this.loudMs;
        return "start";
      }
      return undefined;
    }
    this.speechMs += FRAME_MS;
    this.quietMs = loud ? 0 : this.quietMs + FRAME_MS;
    if (this.quietMs >= endSilence || this.speechMs >= maxSpeech) {
      this.reset();
      return "end";
    }
    return undefined;
  }
}

/** Mono samples at another rate (averaging, enough for speech at 16 kHz). */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j] as number;
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

/** 16-bit mono WAV of these samples, what every transcription service reads. */
export function encodeWav(pcm: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++)
    out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i] ?? 0)) * 32767), true);
  return new Uint8Array(out.buffer);
}
