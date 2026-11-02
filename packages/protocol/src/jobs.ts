import { z } from "zod";

/**
 * A long action the user started (G24.1): a download, starting the local engine, linking an
 * account. The server runs it in the background; the UI follows it, and finds it again after
 * a reload. Steps and errors carry codes the UI translates, plus the original text for details.
 */
export const JobStepState = z.enum(["waiting", "running", "done", "failed", "skipped"]);
export type JobStepState = z.infer<typeof JobStepState>;

export const JobProgress = z.object({
  /** Units done so far (bytes for downloads). */
  done: z.number().nonnegative(),
  /** Units in total, when known. */
  total: z.number().nonnegative().nullable(),
  /** Units per second over the last seconds, when it can be told. */
  rate: z.number().nonnegative().nullable(),
  /** Seconds left at that rate, when it can be told. */
  secondsLeft: z.number().nonnegative().nullable(),
});
export type JobProgress = z.infer<typeof JobProgress>;

export const JobStep = z.object({
  /** A code the UI translates (`job_step_<id>`). */
  id: z.string(),
  state: JobStepState,
  progress: JobProgress.optional(),
});
export type JobStep = z.infer<typeof JobStep>;

export const JobError = z.object({
  /** A code the UI explains in plain words (`job_error_<code>`), when the cause is known. */
  code: z.string().optional(),
  /** The original message, for whoever helps. */
  message: z.string(),
});
export type JobError = z.infer<typeof JobError>;

export const Job = z.object({
  id: z.string(),
  /** What it does, a code the UI translates (`job_<kind>`). */
  kind: z.string(),
  /** Words for the title (a model's name, an account…). */
  vars: z.record(z.string(), z.string()),
  state: z.enum(["running", "done", "failed", "cancelled"]),
  steps: z.array(JobStep),
  error: JobError.optional(),
  /** Whatever the action returns, for the UI. */
  result: z.unknown().optional(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
});
export type Job = z.infer<typeof Job>;
