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
  /**
   * Model calls in one turn of an agent (G36.15); absent: the server's default
   * (`REDGIANT_MAX_TURNS`, else 50); null: no limit (the budgets still hold).
   */
  maxTurns: z.number().int().min(5).max(10_000).nullable().optional(),
});
export type CommandSettings = z.infer<typeof CommandSettings>;
export const DEFAULT_COMMAND_SETTINGS: CommandSettings = CommandSettings.parse({});

/**
 * What reaches the person (G36.17, the person: «Se le richieste sono attive devono arrivare
 * ovunque, se non sono attive non devono arrivare da nessuna parte. Quelle speciali devono
 * arrivare dovunque»). "ask": every request reaches every channel at once (the web page and every
 * linked chat); the first answer decides and closes the other copies; it waits up to `timeoutMs`,
 * then an approval is a no unless `afterTimeout` is "classifier". "classifier" ("don't ask me
 * anything"): nothing reaches the person and the classifier decides, except the special requests
 * (dangers only the person approves, keychain keys): those reach every channel in both modes, are
 * never the classifier's, and a time that runs out on them is always a no.
 */
const RequestSettingsShape = z.object({
  mode: z.enum(["ask", "classifier"]).default("ask"),
  /** How long a request waits for the person; null: no limit. */
  timeoutMs: z
    .number()
    .int()
    .min(MINUTE)
    .max(7 * DAY)
    .nullable()
    .default(null),
  /** When the time runs out: an approval is a no, or the classifier decides (never on a special one). */
  afterTimeout: z.enum(["no", "classifier"]).default("no"),
  /** The classifier's model; absent: the light default model. */
  classifierModel: ModelSpec.optional(),
});

/**
 * Settings saved before the channels went away (G36.17, 2026-11-07) had `channels: {web, chats}`:
 * dropped, since a request now reaches every channel or none.
 */
export const RequestSettings = z.preprocess((v) => {
  if (!v || typeof v !== "object" || !("channels" in v)) return v;
  const { channels: _gone, ...rest } = v as Record<string, unknown>;
  return rest;
}, RequestSettingsShape);
export type RequestSettings = z.infer<typeof RequestSettingsShape>;
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
 * "blocked" only in older history: special requests now reach the person instead of being blocked.
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
  createdAt: z.string(),
});
export type UnattendedDecision = z.infer<typeof UnattendedDecision>;

/**
 * Where the person answered a request (G36.17): "web", a chat platform's id, or "timeout". The
 * other copies of the request say so ("already decided by you on Telegram").
 */
export const CHANNEL_NAMES: Record<string, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  matrix: "Matrix",
  teams: "Microsoft Teams",
  imessage: "iMessage",
};
