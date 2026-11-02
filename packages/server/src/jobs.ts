// Long actions the user started (G24.1): they run in the background, report steps and progress,
// and can be followed and cancelled from the UI, also after a reload. Kept in memory: a job
// does not survive a restart, and finished ones are forgotten after an hour.

import { randomUUID } from "node:crypto";
import type { Job, JobError, JobProgress } from "@redgiant/protocol";

/** An error with a code the UI explains in plain words. */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What an action uses to report what it is doing. */
export interface JobHandle {
  readonly signal: AbortSignal;
  /** Moves to this step: the previous running one is done. */
  step(id: string): void;
  /** Skips a step that is not needed (an image already there…). */
  skip(id: string): void;
  /** Progress of the running step (bytes for downloads). */
  progress(done: number, total: number | null): void;
}

interface Entry {
  ownerId: string;
  job: Job;
  controller: AbortController;
  /** Recent progress samples (time in ms, units done): the rate is their average. */
  samples: [number, number][];
}

/** The rate is the average of this many seconds: it does not jump at every chunk. */
const RATE_WINDOW_MS = 8_000;
const KEEP_FINISHED_MS = 60 * 60_000;

export class Jobs {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts an action; it runs in the background and its job is returned at once. */
  start(
    ownerId: string,
    kind: string,
    steps: string[],
    run: (h: JobHandle) => Promise<unknown>,
    vars: Record<string, string> = {},
  ): Job {
    this.sweep();
    const entry: Entry = {
      ownerId,
      controller: new AbortController(),
      samples: [],
      job: {
        id: randomUUID(),
        kind,
        vars,
        state: "running",
        steps: steps.map((id) => ({ id, state: "waiting" })),
        startedAt: new Date(this.now()).toISOString(),
      },
    };
    this.entries.set(entry.job.id, entry);
    const h = this.handle(entry);
    void run(h).then(
      (result) => this.finish(entry, "done", undefined, result),
      (err: unknown) =>
        this.finish(
          entry,
          entry.controller.signal.aborted ? "cancelled" : "failed",
          entry.controller.signal.aborted ? undefined : asError(err),
        ),
    );
    return this.view(entry);
  }

  list(ownerId: string): Job[] {
    this.sweep();
    return [...this.entries.values()].filter((e) => e.ownerId === ownerId).map((e) => this.view(e));
  }

  get(ownerId: string, id: string): Job | undefined {
    const e = this.entries.get(id);
    return e && e.ownerId === ownerId ? this.view(e) : undefined;
  }

  /** Asks a running action to stop; false if there is nothing to stop. */
  cancel(ownerId: string, id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.ownerId !== ownerId || e.job.state !== "running") return false;
    e.controller.abort();
    return true;
  }

  /** Waits for a job to end (tests). */
  async settled(id: string): Promise<Job | undefined> {
    for (;;) {
      const e = this.entries.get(id);
      if (!e || e.job.state !== "running") return e && this.view(e);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private handle(e: Entry): JobHandle {
    const running = () => e.job.steps.find((s) => s.state === "running");
    return {
      signal: e.controller.signal,
      step: (id) => {
        const target = e.job.steps.find((s) => s.id === id);
        if (!target) throw new Error(`Unknown step ${id}`);
        const current = running();
        if (current && current !== target) {
          current.state = "done";
          delete current.progress;
        }
        target.state = "running";
        e.samples = [];
      },
      skip: (id) => {
        const target = e.job.steps.find((s) => s.id === id);
        if (target && target.state === "waiting") target.state = "skipped";
      },
      progress: (done, total) => {
        const current = running();
        if (!current) return;
        const t = this.now();
        e.samples.push([t, done]);
        while (e.samples.length > 1 && t - (e.samples[0]?.[0] ?? t) > RATE_WINDOW_MS)
          e.samples.shift();
        current.progress = rated(e.samples, done, total);
      },
    };
  }

  private finish(e: Entry, state: Job["state"], error?: JobError, result?: unknown): void {
    for (const s of e.job.steps) {
      if (s.state === "running") s.state = state === "done" ? "done" : "failed";
      delete s.progress;
    }
    e.job.state = state;
    e.job.endedAt = new Date(this.now()).toISOString();
    if (error) e.job.error = error;
    if (result !== undefined) e.job.result = result;
  }

  private sweep(): void {
    const limit = this.now() - KEEP_FINISHED_MS;
    for (const [id, e] of this.entries)
      if (e.job.endedAt && Date.parse(e.job.endedAt) < limit) this.entries.delete(id);
  }

  private view(e: Entry): Job {
    return structuredClone(e.job);
  }
}

/** The rate over the samples kept, and the time left at that rate. */
function rated(samples: [number, number][], done: number, total: number | null): JobProgress {
  const [t0, d0] = samples[0] ?? [0, 0];
  const [t1] = samples.at(-1) ?? [0, 0];
  const secs = (t1 - t0) / 1000;
  const rate = secs >= 1.5 && done > d0 ? (done - d0) / secs : null;
  return {
    done,
    total,
    rate,
    secondsLeft: rate && total !== null ? Math.max(0, (total - done) / rate) : null,
  };
}

function asError(err: unknown): JobError {
  if (err instanceof JobFailure) return { code: err.code, message: err.message };
  return { message: err instanceof Error ? err.message : String(err) };
}
