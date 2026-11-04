import { z } from "zod";
import { Effort } from "./agents.js";

export const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
        /** Runs on new email in the person's mailbox that matches (G24.14c). */
        email: z
          .object({
            from: z.string().min(1).optional(),
            subject: z.string().min(1).optional(),
          })
          .optional(),
      })
      .refine(
        (o) => o.cron !== undefined || o.at !== undefined || o.webhook || o.email !== undefined,
        "set a cron expression, a date (at), a webhook, an email, or a schedule and a webhook",
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
    notify: z
      .object({
        when: z.enum(["always", "failure", "never"]).default("always"),
        /** Where (G29.6): some of the person's chats; every linked one when not set. */
        to: z
          .array(z.enum(["telegram", "discord", "slack", "signal", "whatsapp"]))
          .min(1)
          .optional(),
      })
      .default({ when: "always" }),
  })
  .strict()
  .refine((r) => (r.instructions === undefined) !== (r.reminder === undefined), {
    message: "set instructions (for an agent) or reminder (a message), one of the two",
    path: ["instructions"],
  });
export type Recipe = z.infer<typeof Recipe>;

export const AutomationTrigger = z.enum(["cron", "webhook", "manual", "missed", "email"]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

export const AutomationRunStatus = z.enum(["running", "ok", "failed", "timeout", "skipped"]);
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Automation = z.infer<typeof Automation>;
