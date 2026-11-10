// A provider that stops answering (3.5.4, from the person's test on Windows: a request stayed on
// "waiting for the first token" for over five minutes and never ended). Every model call has a
// time limit for its first sign of life and one between two pieces of the answer; when one runs
// out the request is really cancelled and made again, at most twice, with a growing pause. Then
// the turn stops with a clear message (or the agent's fallback model takes over). The model of
// the conversation never changes by itself.
import { ProviderError } from "./types.js";

export interface StallLimits {
  /** From the request to its first sign of life (any event: reasoning, text, a tool call...). */
  firstTokenMs: number;
  /** Between two signs of life once the answer started (a stream that stopped). */
  idleMs: number;
}

/**
 * Cloud APIs: they start answering within seconds, reasoning included (Anthropic sends its
 * thinking, OpenAI its first chunk); three minutes of silence is a stuck request.
 */
export const CLOUD_STALL: StallLimits = { firstTokenMs: 3 * 60_000, idleMs: 2 * 60_000 };

/**
 * Local engines read the whole prompt before the first token: a long context on a slow machine
 * takes minutes (205 s measured for GLM-4.5 Air on Rig, more on a CPU), and llama.cpp's progress
 * counts as a sign of life only when the engine sends it. Twenty minutes without anything, or
 * five once it writes (one token every few seconds still counts).
 */
export const LOCAL_STALL: StallLimits = { firstTokenMs: 20 * 60_000, idleMs: 5 * 60_000 };

/**
 * Subscription engines (Claude, ChatGPT): a process starts, loads its own context and then asks
 * the model; every message of the engine counts. Time spent running RedGiant's tools never
 * counts (a `sleep 90` is not a silent provider).
 */
export const ENGINE_STALL: StallLimits = { firstTokenMs: 4 * 60_000, idleMs: 3 * 60_000 };

/** Pauses before the two new tries. */
export const STALL_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000];

/** The provider did not answer, even after trying again: the turn stops with this. */
export class ProviderStalledError extends ProviderError {
  /** For the page: `err_provider_stalled` with `{minutes, retries}`. */
  readonly code = "provider_stalled";
  constructor(
    readonly provider: string,
    readonly model: string,
    /** Minutes waited in all, every try included. */
    readonly minutes: number,
    readonly retries: number,
  ) {
    super(
      `The provider has not answered for ${minutes} minutes: tried again ${retries} times (${provider}/${model}).`,
      false,
    );
    this.name = "ProviderStalledError";
  }

  get params(): Record<string, string> {
    return { minutes: String(this.minutes), retries: String(this.retries) };
  }
}

/** Where a line goes for every stalled try (the server's log; tests replace it). */
let log: (line: string) => void = (line) => console.warn(line);

export function setStallLog(fn: (line: string) => void): void {
  log = fn;
}

export function stallLog(line: string): void {
  log(line);
}

/**
 * A watch over one request: `touch()` at every sign of life, `pause()`/`resume()` around work
 * that is not the provider's (tools). When a limit runs out, `onStall` runs once.
 */
export class StallWatch {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private paused = 0;
  private done = false;
  /** "first": nothing came at all; "idle": the answer stopped. */
  stalled: "first" | "idle" | undefined;

  constructor(
    private readonly limits: StallLimits,
    private readonly onStall: (kind: "first" | "idle") => void,
  ) {
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.done || this.paused > 0) return;
    const kind = this.started ? "idle" : "first";
    this.timer = setTimeout(
      () => {
        if (this.done || this.paused > 0) return;
        this.stalled = kind;
        this.done = true;
        this.onStall(kind);
      },
      kind === "first" ? this.limits.firstTokenMs : this.limits.idleMs,
    );
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** A sign of life: the next limit is the one between pieces. */
  touch(): void {
    if (this.done) return;
    this.started = true;
    this.arm();
  }

  pause(): void {
    this.paused++;
    clearTimeout(this.timer);
  }

  resume(): void {
    this.paused = Math.max(0, this.paused - 1);
    // Back from a tool: the engine asks the model again, which gets its full first-token time.
    if (this.paused === 0) {
      this.started = false;
      this.arm();
    }
  }

  stop(): void {
    this.done = true;
    clearTimeout(this.timer);
  }
}
