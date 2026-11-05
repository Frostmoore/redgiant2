import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { EventStore, SqlClient } from "@redgiant/events";
import type {
  Automation,
  AutomationDelivery,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  NotifyReport,
  Recipe,
} from "@redgiant/protocol";
import { nextRun, parseRecipe, RecipeError } from "./recipe.js";

/** What the service needs from the RedGiant core. */
export interface AutomationHost {
  /** Throws (with a reason for the user) when the recipe's agent or model cannot be used. */
  validate(ownerId: string, recipe: Recipe): Promise<void>;
  /** Gives the instructions to the recipe's agent and waits for the end of its turn. */
  run(ownerId: string, recipe: Recipe, ctx: RunContext): Promise<RunOutcome>;
  /**
   * Tells the person on their chats (Telegram…); `to` picks some of them, all when not set.
   * Undefined when no chat is linked. A report says where it arrived (nothing arrived anywhere
   * when both lists are empty: no chat linked); without one the message counts as delivered.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a host without a report returns nothing.
  notify?(ownerId: string, text: string, to?: string[]): Promise<NotifyReport | void>;
  /** Shows a run's message in the web app (recipes with `notify.to: [web]`). */
  notice?(ownerId: string, text: string, info: NoticeInfo): Promise<void> | void;
}

/** Which run a web notice is about. */
export interface NoticeInfo {
  automationId: string;
  name: string;
  runId: string;
  status: AutomationRunStatus;
  sessionId: string | null;
}

export interface RunContext {
  trigger: AutomationTrigger;
  /** Webhook body: data for the agent, never instructions. */
  payload?: unknown;
  /** The session to continue (`session: continue`), or null for a new one. */
  sessionId: string | null;
  /** Called as soon as the session exists, so the run links to it while it works. */
  onSession(sessionId: string): void;
  signal: AbortSignal;
}

export interface RunOutcome {
  ok: boolean;
  summary: string;
}

export interface AutomationServiceOptions {
  db: SqlClient;
  store: EventStore;
  host: AutomationHost;
  /** For tests: a fake clock. */
  now?: () => Date;
  /** The timer never sleeps longer than this, so clock changes are noticed (default 60 s). */
  maxSleepMs?: number;
  /** For tests: how long a minute of `timeoutMinutes` lasts (default 60 000 ms). */
  minuteMs?: number;
  /** Where scheduler failures are written besides the run history (default: console.error). */
  logError?: (message: string, err: unknown) => void;
}

export class AutomationNotFoundError extends Error {}
export class WebhookForbiddenError extends Error {}

export async function migrateAutomations(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_automations (
      id                  text PRIMARY KEY,
      owner_id            text NOT NULL,
      name                text NOT NULL,
      yaml                text NOT NULL,
      enabled             boolean NOT NULL DEFAULT true,
      webhook_secret_hash text,
      session_id          text,
      next_run_at         timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (owner_id, name)
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_automation_runs (
      id            text PRIMARY KEY,
      automation_id text NOT NULL REFERENCES rg_automations(id) ON DELETE CASCADE,
      owner_id      text NOT NULL,
      trigger       text NOT NULL,
      status        text NOT NULL,
      session_id    text,
      summary       text NOT NULL DEFAULT '',
      started_at    timestamptz NOT NULL,
      finished_at   timestamptz
    )`);
  await db.query("ALTER TABLE rg_automation_runs ADD COLUMN IF NOT EXISTS delivery jsonb");
  await db.query(
    "CREATE INDEX IF NOT EXISTS rg_automation_runs_recent ON rg_automation_runs (automation_id, started_at DESC)",
  );
}

interface Row {
  id: string;
  owner_id: string;
  name: string;
  yaml: string;
  enabled: boolean;
  webhook_secret_hash: string | null;
  session_id: string | null;
  next_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow {
  id: string;
  automation_id: string;
  trigger: string;
  status: string;
  session_id: string | null;
  summary: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  delivery?: AutomationDelivery | string | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newSecret = () => `rgwh_${randomBytes(24).toString("base64url")}`;
const toRun = (r: RunRow): AutomationRun => ({
  id: r.id,
  automationId: r.automation_id,
  trigger: r.trigger as AutomationTrigger,
  status: r.status as AutomationRunStatus,
  sessionId: r.session_id,
  summary: r.summary,
  startedAt: iso(r.started_at),
  finishedAt: r.finished_at ? iso(r.finished_at) : null,
  delivery: typeof r.delivery === "string" ? JSON.parse(r.delivery) : (r.delivery ?? null),
});
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A run that could not start; `recorded` when its row already says why. */
class RunNotStarted extends Error {
  constructor(
    cause: unknown,
    readonly recorded: boolean,
  ) {
    super(message(cause), { cause });
  }
}

/** Longest answer kept in the run history (the whole turn stays in the session). */
const MAX_SUMMARY = 20_000;

/**
 * Runs recipes on their schedule and on their webhook. One timer points at the next due
 * recipe; a recipe never runs twice at once (the extra run is recorded as `skipped`).
 */
export class AutomationService {
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly listeners = new Set<(ownerId: string, automationId: string) => void>();

  constructor(private readonly o: AutomationServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  onChange(l: (ownerId: string, automationId: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(ownerId: string, id: string) {
    for (const l of this.listeners) l(ownerId, id);
  }

  // ---- Recipes -------------------------------------------------------------------------------

  private async row(ownerId: string | null, id: string): Promise<Row> {
    const [r] = await this.o.db.query<Row>("SELECT * FROM rg_automations WHERE id = $1", [id]);
    if (!r || (ownerId !== null && r.owner_id !== ownerId))
      throw new AutomationNotFoundError(`Automation "${id}" not found`);
    return r;
  }

  private async toAutomation(r: Row): Promise<Automation> {
    const [last] = await this.o.db.query<RunRow>(
      "SELECT * FROM rg_automation_runs WHERE automation_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1",
      [r.id],
    );
    return {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      yaml: r.yaml,
      recipe: parseRecipe(r.yaml),
      enabled: r.enabled,
      hasWebhookSecret: r.webhook_secret_hash !== null,
      nextRunAt: r.next_run_at ? iso(r.next_run_at) : null,
      lastRun: last ? toRun(last) : null,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  private async checked(ownerId: string, yaml: string): Promise<Recipe> {
    const recipe = parseRecipe(yaml);
    await this.o.host.validate(ownerId, recipe);
    return recipe;
  }

  /** Saves a new recipe. A webhook's secret is returned only here (and on rotation). */
  async create(
    ownerId: string,
    yaml: string,
  ): Promise<{ automation: Automation; webhookSecret?: string }> {
    const recipe = await this.checked(ownerId, yaml);
    const id = `auto_${randomUUID().slice(0, 12)}`;
    const secret = recipe.on.webhook ? newSecret() : undefined;
    const next = nextRun(recipe, this.now());
    const at = this.now();
    await this.o.db
      .query(
        `INSERT INTO rg_automations (id, owner_id, name, yaml, webhook_secret_hash, next_run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, ownerId, recipe.name, yaml, secret ? hash(secret) : null, next, at],
      )
      .catch((err: Error) => {
        if (/unique|duplicate/i.test(err.message))
          throw new RecipeError(`name: an automation called "${recipe.name}" already exists`);
        throw err;
      });
    this.rearm();
    this.changed(ownerId, id);
    return { automation: await this.get(ownerId, id), ...(secret && { webhookSecret: secret }) };
  }

  /**
   * Replaces a recipe. The remembered session is dropped (the agent or model may have changed);
   * a recipe that gains a webhook gets a secret, returned here.
   */
  async update(
    ownerId: string,
    id: string,
    yaml: string,
  ): Promise<{ automation: Automation; webhookSecret?: string }> {
    const row = await this.row(ownerId, id);
    const recipe = await this.checked(ownerId, yaml);
    const secret = recipe.on.webhook && !row.webhook_secret_hash ? newSecret() : undefined;
    await this.o.db
      .query(
        `UPDATE rg_automations SET name = $2, yaml = $3, session_id = NULL, next_run_at = $4, updated_at = $5,
         webhook_secret_hash = CASE WHEN $6::text IS NOT NULL THEN $6 WHEN $7 THEN webhook_secret_hash ELSE NULL END
       WHERE id = $1`,
        [
          id,
          recipe.name,
          yaml,
          row.enabled ? nextRun(recipe, this.now()) : null,
          this.now(),
          secret ? hash(secret) : null,
          recipe.on.webhook,
        ],
      )
      .catch((err: Error) => {
        if (/unique|duplicate/i.test(err.message))
          throw new RecipeError(`name: an automation called "${recipe.name}" already exists`);
        throw err;
      });
    this.rearm();
    this.changed(ownerId, id);
    return { automation: await this.get(ownerId, id), ...(secret && { webhookSecret: secret }) };
  }

  async setEnabled(ownerId: string, id: string, enabled: boolean): Promise<Automation> {
    const row = await this.row(ownerId, id);
    const next = enabled ? nextRun(parseRecipe(row.yaml), this.now()) : null;
    await this.o.db.query(
      "UPDATE rg_automations SET enabled = $2, next_run_at = $3, updated_at = $4 WHERE id = $1",
      [id, enabled, next, this.now()],
    );
    this.rearm();
    this.changed(ownerId, id);
    return this.get(ownerId, id);
  }

  /** A new webhook secret; the old one stops working at once. */
  async rotateSecret(ownerId: string, id: string): Promise<string> {
    const row = await this.row(ownerId, id);
    if (!parseRecipe(row.yaml).on.webhook)
      throw new RecipeError("on.webhook: this automation has no webhook");
    const secret = newSecret();
    await this.o.db.query("UPDATE rg_automations SET webhook_secret_hash = $2 WHERE id = $1", [
      id,
      hash(secret),
    ]);
    return secret;
  }

  async remove(ownerId: string, id: string): Promise<void> {
    await this.row(ownerId, id);
    this.running.get(id)?.controller.abort(new Error("The automation was deleted"));
    await this.o.db.query("DELETE FROM rg_automations WHERE id = $1", [id]);
    this.rearm();
    this.changed(ownerId, id);
  }

  async get(ownerId: string, id: string): Promise<Automation> {
    return this.toAutomation(await this.row(ownerId, id));
  }

  async list(ownerId: string): Promise<Automation[]> {
    const rows = await this.o.db.query<Row>(
      "SELECT * FROM rg_automations WHERE owner_id = $1 ORDER BY name",
      [ownerId],
    );
    return Promise.all(rows.map((r) => this.toAutomation(r)));
  }

  async runs(ownerId: string, id: string, limit = 50): Promise<AutomationRun[]> {
    await this.row(ownerId, id);
    const rows = await this.o.db.query<RunRow>(
      "SELECT * FROM rg_automation_runs WHERE automation_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2",
      [id, limit],
    );
    return rows.map(toRun);
  }

  // ---- Triggers ------------------------------------------------------------------------------

  /** Runs a recipe now, whatever its schedule; `done` resolves when the run is over. */
  async runNow(ownerId: string, id: string): Promise<{ run: AutomationRun; done: Promise<void> }> {
    return this.trigger(await this.row(ownerId, id), "manual");
  }

  /** A webhook call: the recipe's secret, compared in constant time. */
  async webhook(
    id: string,
    secret: string,
    payload: unknown,
    /** The event a GitHub or Gitea webhook says it carries. */
    event?: string,
  ): Promise<{ run: AutomationRun; done: Promise<void> } | null> {
    const row = await this.row(null, id).catch(() => undefined);
    const expected = row?.webhook_secret_hash;
    const ok =
      row &&
      expected &&
      row.enabled &&
      parseRecipe(row.yaml).on.webhook &&
      timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(expected));
    if (!ok || !row) throw new WebhookForbiddenError("Forbidden");
    // A repository's webhook sends every event it was given: only the recipe's run it.
    const events = parseRecipe(row.yaml).on.events;
    if (events && event && !events.includes(event)) return null;
    return this.trigger(row, "webhook", event ? { event, body: payload } : payload);
  }

  /**
   * A new email that matches the recipe's filter (G24.14c): a run, the email as data (never
   * instructions). Ignored when the automation is off or no longer waits for email.
   */
  async email(
    ownerId: string,
    id: string,
    mail: { from: string; subject: string; date: string; text: string },
  ): Promise<{ run: AutomationRun; done: Promise<void> } | null> {
    const row = await this.row(ownerId, id).catch(() => undefined);
    if (!row?.enabled) return null;
    const f = parseRecipe(row.yaml).on.email;
    if (!f) return null;
    const has = (where: string, what?: string) =>
      !what || where.toLowerCase().includes(what.toLowerCase());
    if (!has(mail.from, f.from) || !has(mail.subject, f.subject)) return null;
    return this.trigger(row, "email", { email: mail });
  }

  private async trigger(
    row: Row,
    trigger: AutomationTrigger,
    payload?: unknown,
  ): Promise<{ run: AutomationRun; done: Promise<void> }> {
    const recipe = parseRecipe(row.yaml);
    const runId = `run_${randomUUID().slice(0, 12)}`;
    // Reserved before any await: two triggers at the same moment cannot both start.
    const busy = this.running.has(row.id);
    const controller = new AbortController();
    let release = () => {};
    const finished = new Promise<void>((r) => {
      release = r;
    });
    if (!busy) this.running.set(row.id, { controller, done: finished });
    const status: AutomationRunStatus = busy ? "skipped" : "running";
    const startedAt = this.now();
    let inserted = false;
    try {
      await this.o.db.query(
        `INSERT INTO rg_automation_runs (id, automation_id, owner_id, trigger, status, summary, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          runId,
          row.id,
          row.owner_id,
          trigger,
          status,
          busy ? "The previous run was still going." : "",
          startedAt,
          busy ? startedAt : null,
        ],
      );
      inserted = true;
      await this.log(row, recipe, runId, trigger, status, null);
    } catch (err) {
      if (!busy) {
        this.running.delete(row.id);
        release();
      }
      // A run row left "running" would stay so until the next restart: close it with the reason.
      const recorded =
        inserted &&
        (await this.o.db
          .query(
            "UPDATE rg_automation_runs SET status = 'failed', summary = $2, finished_at = $3 WHERE id = $1",
            [runId, `This run could not start: ${message(err)}`, this.now()],
          )
          .then(
            () => true,
            () => false,
          ));
      if (recorded) this.changed(row.owner_id, row.id);
      throw new RunNotStarted(err, recorded);
    }
    this.changed(row.owner_id, row.id);
    const run = await this.getRun(runId);
    if (busy) return { run, done: Promise.resolve() };

    const timeout = setTimeout(
      () => controller.abort(new TimeoutError()),
      recipe.timeoutMinutes * (this.o.minuteMs ?? 60_000),
    );
    let sessionId: string | null = null;
    const done = (async () => {
      let outcome: { status: AutomationRunStatus; summary: string };
      try {
        // A reminder is its own message: no agent, no model.
        const r =
          recipe.reminder !== undefined
            ? { ok: true, summary: recipe.reminder }
            : await this.o.host.run(row.owner_id, recipe, {
                trigger,
                ...(payload !== undefined && { payload }),
                sessionId: recipe.session === "continue" ? row.session_id : null,
                onSession: (sid) => {
                  sessionId = sid;
                  void this.o.db
                    .query("UPDATE rg_automation_runs SET session_id = $2 WHERE id = $1", [
                      runId,
                      sid,
                    ])
                    .then(() => this.changed(row.owner_id, row.id))
                    .catch(() => {});
                  if (recipe.session === "continue")
                    void this.o.db
                      .query("UPDATE rg_automations SET session_id = $2 WHERE id = $1", [
                        row.id,
                        sid,
                      ])
                      .catch(() => {});
                },
                signal: controller.signal,
              });
        outcome = controller.signal.aborted
          ? aborted(controller.signal, recipe)
          : { status: r.ok ? "ok" : "failed", summary: r.summary };
      } catch (err) {
        outcome = controller.signal.aborted
          ? aborted(controller.signal, recipe)
          : { status: "failed", summary: (err as Error).message };
      } finally {
        clearTimeout(timeout);
      }
      await this.finish(row, recipe, runId, trigger, outcome, sessionId);
    })().finally(() => {
      this.running.delete(row.id);
      release();
    });
    return { run, done };
  }

  private async finish(
    row: Row,
    recipe: Recipe,
    runId: string,
    trigger: AutomationTrigger,
    outcome: { status: AutomationRunStatus; summary: string },
    sessionId: string | null,
  ) {
    const summary = outcome.summary.slice(0, MAX_SUMMARY);
    await this.o.db
      .query(
        "UPDATE rg_automation_runs SET status = $2, summary = $3, finished_at = $4, session_id = COALESCE($5, session_id) WHERE id = $1",
        [runId, outcome.status, summary, this.now(), sessionId],
      )
      .catch(() => {});
    await this.log(row, recipe, runId, trigger, outcome.status, sessionId).catch(() => {});
    this.changed(row.owner_id, row.id);
    const when = recipe.notify.when;
    if (when === "always" || (when === "failure" && outcome.status !== "ok")) {
      const head = `Automation ${recipe.name}: ${outcome.status === "ok" ? "done" : outcome.status}`;
      // A reminder is sent as written: it is the message.
      const text =
        recipe.reminder !== undefined && outcome.status === "ok"
          ? recipe.reminder
          : summary
            ? `${head}\n\n${summary}`
            : head;
      const delivery = await this.deliver(row.owner_id, text, recipe.notify.to, {
        automationId: row.id,
        name: recipe.name,
        runId,
        status: outcome.status,
        sessionId,
      });
      await this.o.db
        .query("UPDATE rg_automation_runs SET delivery = $2::jsonb WHERE id = $1", [
          runId,
          JSON.stringify(delivery),
        ])
        .then(() => this.changed(row.owner_id, row.id))
        .catch((err) => this.fail(`run ${runId}: delivery not recorded`, err));
    }
  }

  /** Sends a run's message where the recipe says and tells where it arrived. Never throws. */
  private async deliver(
    ownerId: string,
    text: string,
    to: string[] | undefined,
    info: NoticeInfo,
  ): Promise<AutomationDelivery> {
    const delivered: string[] = [];
    const failed: string[] = [];
    let noChat = false;
    if (to?.includes("web")) {
      if (!this.o.host.notice) failed.push("web: not available");
      else
        await Promise.resolve()
          .then(() => this.o.host.notice?.(ownerId, text, info))
          .then(
            () => delivered.push("web"),
            (err) => failed.push(`web: ${message(err)}`),
          );
    }
    const chats = to?.filter((c) => c !== "web");
    if (!chats || chats.length > 0) {
      if (!this.o.host.notify) noChat = true;
      else {
        try {
          const r = await this.o.host.notify(ownerId, text, chats);
          if (r) {
            delivered.push(...r.delivered);
            failed.push(...r.failed.map((f) => `${f.to}: ${f.reason}`));
            if (r.delivered.length === 0 && r.failed.length === 0) noChat = true;
          } else delivered.push(...(chats ?? ["chats"]));
        } catch (err) {
          failed.push(message(err));
        }
      }
    }
    const reasons = [...failed, ...(noChat ? ["no chat linked"] : [])];
    return {
      status: delivered.length > 0 ? "delivered" : failed.length > 0 ? "failed" : "no-chat",
      to: delivered,
      ...(reasons.length > 0 && { reason: reasons.join("; ") }),
    };
  }

  /**
   * A scheduled run that could not happen (a broken recipe, the database): written on the
   * automation's history so the person sees it, and logged. Never throws.
   */
  private async recordFailure(row: Row, trigger: AutomationTrigger, err: unknown) {
    this.fail(`automation ${row.name} (${row.id})`, err);
    if (err instanceof RunNotStarted && err.recorded) return;
    const at = this.now();
    await this.o.db
      .query(
        `INSERT INTO rg_automation_runs (id, automation_id, owner_id, trigger, status, summary, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 'failed', $5, $6, $6)`,
        [
          `run_${randomUUID().slice(0, 12)}`,
          row.id,
          row.owner_id,
          trigger,
          `This run could not happen: ${message(err)}`.slice(0, MAX_SUMMARY),
          at,
        ],
      )
      .then(() => this.changed(row.owner_id, row.id))
      .catch((e) => this.fail(`automation ${row.id}: failure not recorded`, e));
  }

  private fail(what: string, err: unknown) {
    (this.o.logError ?? ((m, e) => console.error(m, e)))(`automations: ${what}`, err);
  }

  private log(
    row: Row,
    recipe: Recipe,
    runId: string,
    trigger: AutomationTrigger,
    status: AutomationRunStatus,
    sessionId: string | null,
  ) {
    return this.o.store.append({
      ownerId: row.owner_id,
      projectId: recipe.project,
      sessionId,
      body: {
        type: "automation.run",
        payload: { automationId: row.id, name: recipe.name, runId, trigger, status },
      },
    });
  }

  private async getRun(runId: string): Promise<AutomationRun> {
    const [r] = await this.o.db.query<RunRow>("SELECT * FROM rg_automation_runs WHERE id = $1", [
      runId,
    ]);
    return toRun(r as RunRow);
  }

  // ---- Schedule ------------------------------------------------------------------------------

  /**
   * Starts the schedule. Runs left `running` by a crash are closed; runs missed while the
   * server was down happen once now if the recipe says `missed: run`.
   */
  async start(): Promise<void> {
    let failed = false;
    try {
      await this.o.db
        .query(
          `UPDATE rg_automation_runs SET status = 'failed', summary = 'Interrupted: the server stopped during the run.', finished_at = $1
       WHERE status = 'running'`,
          [this.now()],
        )
        .catch((err) => this.fail("closing interrupted runs", err));
      const now = this.now();
      const late = await this.o.db.query<Row>(
        "SELECT * FROM rg_automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at < $1",
        [now],
      );
      for (const row of late) if (!(await this.due(row, now, "missed"))) failed = true;
    } catch (err) {
      failed = true;
      this.fail("start", err);
    } finally {
      // Whatever went wrong, the schedule goes on.
      this.started = true;
      this.rearm(failed);
    }
  }

  /** Runs every recipe that is due at `now`, then points the timer at the next one. */
  async tick(): Promise<void> {
    let failed = false;
    try {
      const now = this.now();
      const due = await this.o.db.query<Row>(
        "SELECT * FROM rg_automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at",
        [now],
      );
      for (const row of due) if (!(await this.due(row, now, "cron"))) failed = true;
    } catch (err) {
      failed = true;
      this.fail("tick", err);
    } finally {
      this.rearm(failed);
    }
  }

  /**
   * One recipe whose time has come (`missed`: while the server was down). Its failure stays
   * its own: written on its history, the other recipes still run. False when it failed.
   */
  private async due(row: Row, now: Date, trigger: "cron" | "missed"): Promise<boolean> {
    let recipe: Recipe;
    try {
      recipe = parseRecipe(row.yaml);
    } catch (err) {
      // Unreadable (e.g. written by an older version): no next time until the person edits it.
      await this.o.db
        .query("UPDATE rg_automations SET next_run_at = NULL WHERE id = $1", [row.id])
        .catch((e) => this.fail(`automation ${row.id}: schedule not cleared`, e));
      await this.recordFailure(row, trigger, err);
      return false;
    }
    try {
      // Next time is computed from now: a late tick never fires a burst of catch-up runs.
      await this.o.db.query("UPDATE rg_automations SET next_run_at = $2 WHERE id = $1", [
        row.id,
        nextRun(recipe, now),
      ]);
      if (trigger === "cron" || recipe.missed === "run") await this.trigger(row, trigger);
      return true;
    } catch (err) {
      await this.recordFailure(row, trigger, err);
      return false;
    }
  }

  /**
   * Points the timer at the next due recipe. After a failure it waits at least `maxSleepMs`,
   * so a recipe whose schedule could not be moved on is retried, not fired in a tight loop.
   */
  private rearm(afterFailure = false) {
    if (!this.started) return;
    clearTimeout(this.timer);
    const max = this.o.maxSleepMs ?? 60_000;
    const arm = (wait: number) => {
      if (!this.started) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(
        () => void this.tick(),
        afterFailure ? max : Math.max(0, Math.min(wait, max)),
      );
      this.timer.unref?.();
    };
    void this.o.db
      .query<{ next: Date | string | null }>(
        "SELECT min(next_run_at) AS next FROM rg_automations WHERE enabled AND next_run_at IS NOT NULL",
      )
      .then(
        ([r]) => arm(r?.next ? new Date(r.next).getTime() - this.now().getTime() : max),
        (err) => {
          this.fail("rearm", err);
          arm(max);
        },
      );
  }

  /** Every run that is going right now has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0)
      await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  /** Stops the timer and the runs in progress (they are recorded as failed). */
  async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    for (const r of this.running.values()) r.controller.abort(new Error("The server is stopping"));
    await this.idle();
  }
}

class TimeoutError extends Error {}

function aborted(
  signal: AbortSignal,
  recipe: Recipe,
): { status: AutomationRunStatus; summary: string } {
  return signal.reason instanceof TimeoutError
    ? { status: "timeout", summary: `Stopped after ${recipe.timeoutMinutes} minutes.` }
    : { status: "failed", summary: (signal.reason as Error | undefined)?.message ?? "Stopped." };
}
