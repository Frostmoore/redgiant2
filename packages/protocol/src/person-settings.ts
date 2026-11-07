import { z } from "zod";
import { ModelSpec } from "./agents.js";

// The person's choices for commands and for what agents ask them (G36.16, G36.17). Saved as
// configuration (history, undoable); `null` means "no limit" where a limit is optional.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

/** Background commands and `bash` (G36.16, the person: «devono poter essere infiniti»). */
export const CommandSettings = z.object({
  /** Background commands running at once in one conversation; null: no limit. */
  maxPerSession: z.number().int().min(1).max(64).nullable().default(4),
  /** A background command is stopped after this long; null: it runs until it is stopped. */
  maxMs: z
    .number()
    .int()
    .min(MINUTE)
    .max(7 * DAY)
    .nullable()
    .default(DAY),
  /** A background command's log ceiling (past it the oldest half goes); null: no ceiling. */
  maxLogBytes: z
    .number()
    .int()
    .min(MB)
    .max(1024 * MB)
    .nullable()
    .default(8 * MB),
  /** The longest an ordinary (not background) `bash` call may wait. */
  bashMaxMs: z
    .number()
    .int()
    .min(MINUTE)
    .max(4 * HOUR)
    .default(10 * MINUTE),
});
export type CommandSettings = z.infer<typeof CommandSettings>;
export const DEFAULT_COMMAND_SETTINGS: CommandSettings = CommandSettings.parse({});

/**
 * What reaches the person (G36.17): approvals, questions, plans, tool and credential requests.
 * "ask": they reach the chosen channels and wait up to `timeoutMs`; then an approval is a no,
 * unless `afterTimeout` is "classifier". "classifier" ("don't ask me anything"): nothing reaches
 * the person; the classifier decides, never on a danger only the person approves (those stay a
 * no and wait in the review list).
 */
export const RequestSettings = z
  .object({
    mode: z.enum(["ask", "classifier"]).default("ask"),
    /** How long a request waits for the person; null: no limit. */
    timeoutMs: z
      .number()
      .int()
      .min(MINUTE)
      .max(7 * DAY)
      .nullable()
      .default(null),
    /** When the time runs out: an approval is a no, or the classifier decides. */
    afterTimeout: z.enum(["no", "classifier"]).default("no"),
    /** The classifier's model; absent: the light default model. */
    classifierModel: ModelSpec.optional(),
    /** Where requests reach the person: the web page, and the chats (Telegram and the others). */
    channels: z
      .object({ web: z.boolean().default(true), chats: z.boolean().default(true) })
      .default({ web: true, chats: true }),
  })
  .refine((s) => s.mode === "classifier" || s.channels.web || s.channels.chats, {
    message:
      'Requests must reach the person somewhere: keep the web page or the chats, or choose "classifier"',
    path: ["channels"],
  });
export type RequestSettings = z.infer<typeof RequestSettings>;
export const DEFAULT_REQUEST_SETTINGS: RequestSettings = RequestSettings.parse({});

/** The kinds of requests that reach the person. */
export const RequestKind = z.enum([
  "approval",
  "question",
  "plan",
  "tool",
  "credential",
  "automation",
]);
export type RequestKind = z.infer<typeof RequestKind>;

/**
 * A request decided without the person (G36.17): by the classifier, or by the time running out.
 * `review`: a danger only the person approves, blocked; it waits in the review list.
 */
export const UnattendedDecision = z.object({
  id: z.string(),
  requestId: z.string(),
  kind: RequestKind,
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** What was asked, in a line. */
  what: z.string(),
  danger: z.array(z.string()),
  decision: z.enum(["allow", "deny", "answered", "blocked"]),
  by: z.enum(["classifier", "timeout"]),
  /** Why (the classifier's words, or what happened). */
  reason: z.string(),
  /** The classifier's model, when one decided. */
  model: z.string().nullable(),
  review: z.boolean(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type UnattendedDecision = z.infer<typeof UnattendedDecision>;
