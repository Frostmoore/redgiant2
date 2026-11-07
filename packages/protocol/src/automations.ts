import { z } from "zod";
import { Effort } from "./agents.js";

export const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The chat platforms a person can link (G29.5). */
export const ChatPlatform = z.enum([
  "telegram",
  "discord",
  "slack",
  "signal",
  "whatsapp",
  "matrix",
  "teams",
  "imessage",
]);
export type ChatPlatform = z.infer<typeof ChatPlatform>;

/**
 * Where a run's message can go: the person's chats, `web` (a notice in the web app) and
 * `email` (sent from one of the person's mailboxes, G33.3).
 */
export const NotifyTarget = z.enum([
  "telegram",
  "discord",
  "slack",
  "signal",
  "whatsapp",
  "matrix",
  "teams",
  "imessage",
  "web",
  "email",
]);
export type NotifyTarget = z.infer<typeof NotifyTarget>;

/** A time of day, "HH:MM" (24 hours). */
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time as HH:MM");
/** A day, "YYYY-MM-DD". */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD");
const Words = z.array(z.string().trim().min(1)).min(1);

/** The default categories of mailboxes; the person may add their own (G33.3). */
export const MAILBOX_CATEGORIES = ["work", "personal", "social", "other"] as const;

/**
 * Conditions every start must meet (G33.3): all of the given ones together. Times are in the
 * recipe's time zone. A scheduled time that falls outside them is skipped (not recorded); a run
 * started by hand ignores them.
 */
export const RecipeConditions = z
  .object({
    /** Only between these times of day (`to` before `from` crosses midnight). */
    hours: z.object({ from: TimeOfDay, to: TimeOfDay }).optional(),
    /** Only on these weekdays (0 Sunday … 6 Saturday). */
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    /** Only in this period (both days included). */
    dates: z.object({ from: Day.optional(), to: Day.optional() }).optional(),
    /** Only when the sender (an email's or a chat message's) contains one of these. */
    from: Words.optional(),
    /** Only when the text (subject and body, or the message) contains these words. */
    words: Words.optional(),
    /** `any` (the default): one of `words` is enough; `all`: every one. */
    match: z.enum(["any", "all"]).default("any"),
    /** Never when the text contains one of these. */
    without: Words.optional(),
    /** At most this many runs a day (manual ones not counted). */
    maxPerDay: z.number().int().min(1).max(1000).optional(),
    /** At least this many minutes after the previous run. */
    cooldownMinutes: z.number().int().min(1).max(10080).optional(),
  })
  .strict();
export type RecipeConditions = z.infer<typeof RecipeConditions>;

/**
 * An automation, written by the user as YAML: when it runs, which agent does the work and what
 * it is asked. The agent keeps its own tools and permissions; a recipe never changes them.
 */
export const Recipe = z
  .object({
    name: z.string().regex(RECIPE_NAME, "lowercase letters, digits and dashes"),
    description: z.string().default(""),
    on: z
      .object({
        /** Five fields (minute…weekday) or six (with seconds first). */
        cron: z.string().min(1).optional(),
        /** Once, at this date and time (ISO 8601, e.g. 2026-11-02T09:00; in `timezone` without an offset). */
        at: z.string().min(1).optional(),
        /** IANA time zone of the cron expression (default: the server's). */
        timezone: z.string().min(1).optional(),
        /** Also runs on POST /api/automations/{id}/hook with the recipe's secret. */
        webhook: z.boolean().default(false),
        /**
         * Only these events of a GitHub or Gitea webhook (`push`, `pull_request`, `issues`…);
         * the others are ignored (G24.14c). Needs `webhook`.
         */
        events: z
          .array(z.string().regex(/^[a-z_]+$/))
          .min(1)
          .optional(),
        /** Runs on new email in the person's mailboxes that matches (G24.14c). */
        email: z
          .object({
            from: z.string().min(1).optional(),
            subject: z.string().min(1).optional(),
            /** Words the body must contain (any of them). */
            text: z.string().min(1).optional(),
            /** Only these mailboxes (ids); with `categories`, either is enough. All when unset. */
            boxes: z.array(z.string().min(1)).min(1).optional(),
            /** Only mailboxes of these categories (`work`, `personal`… or the person's own). */
            categories: z.array(z.string().min(1)).min(1).optional(),
          })
          .optional(),
        /**
         * A message on a linked chat (G33.3): the person (or someone linked to them) writes on
         * Telegram, WhatsApp, Discord, Slack, Signal, Matrix, Teams or iMessage. The message reaches the agent as data.
         */
        message: z
          .object({
            /** Only on these platforms (all when unset). */
            platforms: z.array(ChatPlatform).min(1).optional(),
            /** Only from this person (name, username or id contains it). */
            from: z.string().min(1).optional(),
            /** Only in this chat (its id). */
            chat: z.string().min(1).optional(),
            /** Only messages with one of these words (or starting with a /command). */
            words: Words.optional(),
            /** The message is for the automation only: Demi-God does not answer it. */
            handle: z.boolean().default(false),
          })
          .optional(),
        /** Files that change in a project's folder (G33.3), looked at every minute. */
        files: z
          .object({
            /** The project the folder is in (default: the recipe's own project). */
            project: z.string().min(1).optional(),
            /** The folder, relative to the project (default: the whole project). */
            path: z.string().min(1).default("."),
            /** Only names that match (`*.pdf`, `invoices/**`). */
            pattern: z.string().min(1).optional(),
            /** Which changes count (default: all of them). */
            changes: z
              .array(z.enum(["added", "changed", "removed"]))
              .min(1)
              .optional(),
          })
          .optional(),
        /** The end of another automation (G33.3): its name, and how it ended. */
        after: z
          .object({
            automation: z.string().min(1),
            status: z
              .array(z.enum(["ok", "failed", "timeout"]))
              .min(1)
              .optional(),
          })
          .optional(),
        /** The end of an agent's task (G33.3): in a project, with an outcome. */
        task: z
          .object({
            project: z.string().min(1).optional(),
            outcome: z
              .array(z.enum(["verified", "not_testable", "abandoned"]))
              .min(1)
              .optional(),
          })
          .optional(),
        /** When RedGiant starts. */
        startup: z.boolean().default(false),
      })
      .refine(
        (o) =>
          o.cron !== undefined ||
          o.at !== undefined ||
          o.webhook ||
          o.email !== undefined ||
          o.message !== undefined ||
          o.files !== undefined ||
          o.after !== undefined ||
          o.task !== undefined ||
          o.startup,
        "set a cron expression, a date (at), a webhook, an email, a chat message, files, another automation, a task or startup",
      )
      .refine((o) => o.events === undefined || o.webhook, "events need webhook: true")
      .refine((o) => o.cron === undefined || o.at === undefined, "cron or at, not both"),
    /** `god`, `orchestrator` (of `project`), or an agent's id or name. */
    agent: z.string().min(1).default("god"),
    project: z.string().min(1).nullable().default(null),
    /** `provider/model`, only for this recipe's sessions (default: the agent's own model). */
    model: z
      .string()
      .regex(/^[^/\s]+\/\S+$/, "provider/model")
      .optional(),
    effort: Effort.optional(),
    /** What the agent is asked. */
    instructions: z.string().trim().min(1).optional(),
    /** A reminder: this text is sent as it is (Telegram, notifications), no agent and no model. */
    reminder: z.string().trim().min(1).max(4000).optional(),
    /** `new`: a fresh session every run; `continue`: one session that remembers past runs. */
    session: z.enum(["new", "continue"]).default("new"),
    timeoutMinutes: z.number().int().min(1).max(1440).default(30),
    /** What to do with a run missed while the server was down. */
    missed: z.enum(["skip", "run"]).default("skip"),
    /** Conditions every automatic start must meet (G33.3). */
    only: RecipeConditions.optional(),
    /**
     * Ask the person before the agent acts (G33.3): the run waits for their yes (in the web app
     * or on their chats); no answer, a failure or the time running out count as no.
     */
    approve: z.boolean().default(false),
    /** The most one run may spend, in dollars: the agent is stopped there (G33.3). */
    budgetUsd: z.number().positive().max(10_000).optional(),
    /** When a run is due while the previous one still works: `skip` it, or `queue` one after. */
    overlap: z.enum(["skip", "queue"]).default("skip"),
    /** What to do when a run fails or times out (G33.3). */
    onFailure: z
      .object({
        /** Try again this many times… */
        retries: z.number().int().min(0).max(5).default(0),
        /** …this many minutes apart. */
        retryMinutes: z.number().int().min(1).max(1440).default(5),
        /** Then start this other automation (by name), the failure as its data. */
        run: z.string().regex(RECIPE_NAME).optional(),
      })
      .strict()
      .optional(),
    notify: z
      .object({
        when: z.enum(["always", "failure", "never"]).default("always"),
        /**
         * Where (G29.6): some of the person's chats; every linked one when not set (a run
         * started by a chat message answers there). `web` also shows the message in the web
         * app, as a notice; `email` sends it by email.
         */
        to: z.array(NotifyTarget).min(1).optional(),
        /** `email`: to this address (default: the mailbox's own). */
        email: z.string().email().optional(),
        /** `email`: from this mailbox (its id; default: the first one that can send). */
        box: z.string().min(1).optional(),
      })
      .default({ when: "always" }),
  })
  .strict()
  .refine((r) => (r.instructions === undefined) !== (r.reminder === undefined), {
    message: "set instructions (for an agent) or reminder (a message), one of the two",
    path: ["instructions"],
  })
  .refine((r) => r.on.files === undefined || (r.on.files.project ?? r.project) !== null, {
    message: "files need a project (the folder is inside it)",
    path: ["project"],
  })
  .refine((r) => r.onFailure?.run === undefined || r.onFailure.run !== r.name, {
    message: "an automation cannot start itself on failure",
    path: ["onFailure", "run"],
  })
  .refine((r) => r.on.after === undefined || r.on.after.automation !== r.name, {
    message: "an automation cannot follow itself",
    path: ["on", "after"],
  });
export type Recipe = z.infer<typeof Recipe>;

/** A mailbox for email routines (G33.3), as shown: its password never leaves the server. */
export const Mailbox = z.object({
  id: z.string(),
  /** The person's name for it ("Work", "Gmail"…). */
  name: z.string(),
  /** `work`, `personal`, `social`, `other`, or the person's own. */
  category: z.string(),
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  user: z.string(),
  /** Where it sends from (for `notify.to: [email]`), when set. */
  smtp: z.object({ host: z.string(), port: z.number().int(), secure: z.boolean() }).optional(),
  createdAt: z.string(),
});
export type Mailbox = z.infer<typeof Mailbox>;

/** Something a magic automation still needs from the person before it can work (G33.3). */
export const MagicNeed = z.object({
  kind: z.enum(["chat", "email", "extension", "credential", "other"]),
  /** What exactly ("whatsapp", "revolut-api"…). */
  what: z.string(),
  why: z.string().default(""),
  /** A credential's service and host (G33.4): the keychain's form opens with them filled in. */
  service: z.string().optional(),
  host: z.string().optional(),
  /**
   * Whether it is there already, checked by the server each time the proposal is read (chats,
   * mailboxes, credentials, extensions); absent when it cannot know ("other").
   */
  ready: z.boolean().optional(),
});
export type MagicNeed = z.infer<typeof MagicNeed>;

/**
 * A magic automation (G33.3): a conversation with God that builds an automation. God asks what
 * it needs, may propose tools and skills (they wait for the person as always) and finally
 * proposes the recipe; only the person's yes makes it a real automation.
 */
export const MagicAutomation = z.object({
  id: z.string(),
  title: z.string(),
  /** What the person asked, in their words. */
  request: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  /** `building`: talking; `ready`: a proposal waits; `done`: approved; `dismissed`. */
  status: z.enum(["building", "ready", "done", "dismissed"]),
  proposal: z
    .object({
      yaml: z.string(),
      recipe: z.unknown(),
      summary: z.string(),
      needs: z.array(MagicNeed),
      at: z.string(),
    })
    .nullable(),
  /** The automation it became, once approved. */
  automationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MagicAutomation = z.infer<typeof MagicAutomation>;

/**
 * Whether a run's message reached the person: `delivered` (somewhere, `to` says where; `reason`
 * lists the places that failed), `failed` (nowhere), `no-chat` (no chat linked for the targets).
 */
export const AutomationDelivery = z.object({
  status: z.enum(["delivered", "failed", "no-chat"]),
  to: z.array(z.string()),
  reason: z.string().optional(),
});
export type AutomationDelivery = z.infer<typeof AutomationDelivery>;

/** What the host's `notify` may say about a message: where it arrived and where it failed. */
export interface NotifyReport {
  delivered: string[];
  failed: { to: string; reason: string }[];
}

export const AutomationTrigger = z.enum([
  "cron",
  "webhook",
  "manual",
  "missed",
  "email",
  "message",
  "files",
  "after",
  "task",
  "startup",
  "retry",
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/** `queued`: due while the previous run still worked (`overlap: queue`), it starts after it. */
export const AutomationRunStatus = z.enum([
  "running",
  "ok",
  "failed",
  "timeout",
  "skipped",
  "queued",
]);
export type AutomationRunStatus = z.infer<typeof AutomationRunStatus>;

export const AutomationRun = z.object({
  id: z.string(),
  automationId: z.string(),
  trigger: AutomationTrigger,
  status: AutomationRunStatus,
  sessionId: z.string().nullable(),
  /** The agent's final answer (or why the run did not happen). */
  summary: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** Whether its message reached the person; null when none was due (or not yet sent). */
  delivery: AutomationDelivery.nullable().optional(),
});
export type AutomationRun = z.infer<typeof AutomationRun>;

export const Automation = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  yaml: z.string(),
  recipe: Recipe,
  enabled: z.boolean(),
  hasWebhookSecret: z.boolean(),
  /** Next scheduled run (null without cron or when disabled). */
  nextRunAt: z.string().nullable(),
  lastRun: AutomationRun.nullable(),
  /** Why the stored recipe no longer reads (then `recipe` only carries the name): edit it. */
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Automation = z.infer<typeof Automation>;
