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
import {
  type EventFacts,
  factsAllowed,
  localTime,
  nextRun,
  nextRuns,
  parseRecipe,
  RecipeError,
  timeAllowed,
} from "./recipe.js";

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
  /**
   * Asks the person whether a run may go on (`approve: true`, G33.3). Only a clear yes is true:
   * a failure, no answer or the signal ending must give false (or throw).
   */
  approve?(
    ownerId: string,
    recipe: Recipe,
    ask: ApprovalAsk,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Sends a run's message by email (`notify.to: [email]`); returns the address it went to. */
  sendEmail?(
    ownerId: string,
    mail: { subject: string; text: string; to?: string; box?: string },
  ): Promise<string>;
}

/** What the person is asked before a run goes on. */
export interface ApprovalAsk {
  automationId: string;
  runId: string;
  trigger: AutomationTrigger;
  /** What started it, in a line (an email's sender and subject, a message…). */
  about: string;
}

/** A message on a linked chat (G33.3), as the gateway hands it over. */
export interface ChatMessage {
  platform: string;
  /** The writer's id on the platform. */
  userId: string;
  /** Their name or username, when the platform says. */
  from: string;
  chatId: string;
  text: string;
}

/** A file that changed in a watched folder (G33.3), relative to the project. */
export interface FileChange {
  path: string;
  change: "added" | "changed" | "removed";
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
  /**
   * What the run has spent so far, in dollars (the host calls it as the agent works): past the
   * recipe's `budgetUsd` the run is stopped (G33.3).
   */
  spent(usd: number): void;
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
  // A failed run tried again later (G33.3): when, and how many tries are left after that one.
  await db.query("ALTER TABLE rg_automations ADD COLUMN IF NOT EXISTS retry_at timestamptz");
  await db.query("ALTER TABLE rg_automations ADD COLUMN IF NOT EXISTS retry_left integer");
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
  retry_at?: Date | string | null;
  retry_left?: number | null;
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
  /** A run waiting for the one in progress (`overlap: queue`): one at most per automation. */
  private readonly queued = new Map<
    string,
    { slot: { controller: AbortController; done: Promise<void> }; go: () => void }
  >();
  /** Task titles seen in the log, for the runs on a task's end. */
  private readonly taskTitles = new Map<string, string>();
  private unfollow: (() => void) | undefined;
  /** What starts once a run has freed its place: the automations that follow it. */
  private readonly afterRun = new Map<string, () => Promise<void>>();
  /** Followers being started, so `idle` waits for them too. */
  private readonly starting = new Set<Promise<void>>();

  constructor(private readonly o: AutomationServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  /** Tells the listeners something about an automation changed (magic automations too). */
  touch(ownerId: string, id: string): void {
    this.changed(ownerId, id);
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
    // A recipe that no longer reads still lists, so the person can fix or delete it.
    let recipe: Recipe;
    let error: string | undefined;
    try {
      recipe = parseRecipe(r.yaml);
    } catch (err) {
      error = message(err);
      recipe = { name: r.name, description: "", on: { webhook: false } } as Recipe;
    }
    return {
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      yaml: r.yaml,
      recipe,
      ...(error !== undefined && { error }),
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

  /** Reads and checks a recipe as saving would, without saving it (G33.3: magic proposals). */
  async check(ownerId: string, yaml: string): Promise<Recipe> {
    return this.checked(ownerId, yaml);
  }

  /**
   * What the editor shows while the person writes (G33.3): the recipe as the server reads it,
   * or why it does not read, and its next scheduled times.
   */
  async preview(
    ownerId: string,
    yaml: string,
    count = 5,
  ): Promise<{ recipe: Recipe | null; error: string | null; next: string[] }> {
    try {
      const recipe = await this.checked(ownerId, yaml);
      return {
        recipe,
        error: null,
        next: nextRuns(recipe, this.now(), count).map((d) => d.toISOString()),
      };
    } catch (err) {
      return { recipe: null, error: message(err), next: [] };
    }
  }

  /** Runs a recipe now, whatever its schedule and conditions; `done` resolves when it is over. */
  async runNow(ownerId: string, id: string): Promise<{ run: AutomationRun; done: Promise<void> }> {
    return this.trigger(await this.row(ownerId, id), "manual") as Promise<Started>;
  }

  /** A webhook call: the recipe's secret, compared in constant time. */
  async webhook(
    id: string,
    secret: string,
    payload: unknown,
    /** The event a GitHub or Gitea webhook says it carries. */
    event?: string,
  ): Promise<Started | null> {
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
    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    return this.trigger(row, "webhook", event ? { event, body: payload } : payload, { text });
  }

  /**
   * A new email that matches the recipe's filter (G24.14c): a run, the email as data (never
   * instructions). Ignored when the automation is off or no longer waits for email, when the
   * mailbox is not one it watches (G33.3) or when its conditions say no.
   */
  async email(
    ownerId: string,
    id: string,
    mail: {
      from: string;
      subject: string;
      date: string;
      text: string;
      box?: { id: string; name: string; category: string };
    },
  ): Promise<Started | null> {
    const row = await this.row(ownerId, id).catch(() => undefined);
    if (!row?.enabled) return null;
    const f = parseRecipe(row.yaml).on.email;
    if (!f) return null;
    if (!watches(f, mail.box)) return null;
    const has = (where: string, what?: string) =>
      !what || where.toLowerCase().includes(what.toLowerCase());
    if (!has(mail.from, f.from) || !has(mail.subject, f.subject) || !has(mail.text, f.text))
      return null;
    return this.trigger(
      row,
      "email",
      { email: mail },
      { from: mail.from, text: `${mail.subject}\n${mail.text}` },
    );
  }

  /**
   * A message on a linked chat (G33.3): every automation waiting for one that matches starts,
   * the message as data. `taken` when one of them keeps it (`handle: true`): then Demi-God does
   * not answer it.
   */
  async message(ownerId: string, m: ChatMessage): Promise<{ taken: boolean; started: Started[] }> {
    const rows = await this.o.db.query<Row>(
      "SELECT * FROM rg_automations WHERE owner_id = $1 AND enabled ORDER BY name",
      [ownerId],
    );
    let taken = false;
    const started: Started[] = [];
    const text = m.text.toLowerCase();
    for (const row of rows) {
      const f = safeRecipe(row.yaml)?.on.message;
      if (!f) continue;
      if (f.platforms && !f.platforms.includes(m.platform as never)) continue;
      if (f.chat && f.chat !== m.chatId) continue;
      if (f.from && !`${m.from} ${m.userId}`.toLowerCase().includes(f.from.toLowerCase())) continue;
      if (f.words && !f.words.some((w) => text.includes(w.toLowerCase()))) continue;
      const run = await this.trigger(
        row,
        "message",
        { message: m },
        { from: `${m.from} ${m.userId}`, text: m.text, replyTo: m.platform },
      ).catch((err) => {
        this.fail(`automation ${row.id}: message`, err);
        return null;
      });
      if (!run) continue;
      started.push(run);
      if (f.handle) taken = true;
    }
    return { taken, started };
  }

  /** Files that changed in the folder an automation watches (G33.3): one run, the list as data. */
  async filesChanged(ownerId: string, id: string, changes: FileChange[]): Promise<Started | null> {
    const row = await this.row(ownerId, id).catch(() => undefined);
    if (!row?.enabled || changes.length === 0) return null;
    const f = parseRecipe(row.yaml).on.files;
    if (!f) return null;
    const wanted = changes.filter((c) => !f.changes || f.changes.includes(c.change));
    if (wanted.length === 0) return null;
    return this.trigger(
      row,
      "files",
      { files: wanted.slice(0, 200) },
      { text: wanted.map((c) => c.path).join("\n") },
    );
  }

  /** The automations of an owner that watch files (for the server's watcher). */
  async watchingFiles(): Promise<{ ownerId: string; id: string; recipe: Recipe }[]> {
    const rows = await this.o.db.query<Row>("SELECT * FROM rg_automations WHERE enabled", []);
    return rows.flatMap((r) => {
      const recipe = safeRecipe(r.yaml);
      return recipe?.on.files ? [{ ownerId: r.owner_id, id: r.id, recipe }] : [];
    });
  }

  /** A task closed (G33.3): the automations waiting for one like it start. */
  private async taskClosed(
    ownerId: string,
    projectId: string | null,
    task: { id: string; outcome: string; title: string },
  ) {
    const rows = await this.o.db.query<Row>(
      "SELECT * FROM rg_automations WHERE owner_id = $1 AND enabled ORDER BY name",
      [ownerId],
    );
    for (const row of rows) {
      const f = safeRecipe(row.yaml)?.on.task;
      if (!f) continue;
      if (f.project && f.project !== projectId) continue;
      if (f.outcome && !f.outcome.includes(task.outcome as never)) continue;
      await this.trigger(
        row,
        "task",
        { task: { ...task, project: projectId } },
        { text: task.title },
      ).then(
        (r) => r?.done.catch(() => {}),
        (err) => this.recordFailure(row, "task", err),
      );
    }
  }

  /** The automations that follow one that just ended (`on.after`), and its `onFailure.run`. */
  private async followers(
    row: Row,
    recipe: Recipe,
    status: AutomationRunStatus,
    summary: string,
    depth: number,
  ) {
    // A chain that loops (A after B, B after A) stops here.
    if (depth >= MAX_CHAIN) return;
    const rows = await this.o.db.query<Row>(
      "SELECT * FROM rg_automations WHERE owner_id = $1 AND enabled AND id <> $2 ORDER BY name",
      [row.owner_id, row.id],
    );
    const data = { after: { automation: recipe.name, status, summary: summary.slice(0, 4000) } };
    for (const other of rows) {
      const r = safeRecipe(other.yaml);
      if (!r) continue;
      const f = r.on.after;
      const follows =
        f &&
        (f.automation === recipe.name || f.automation === row.id) &&
        (f.status ?? ["ok", "failed", "timeout"]).includes(status as never);
      const fallback = status !== "ok" && recipe.onFailure?.run === r.name;
      if (!follows && !fallback) continue;
      await this.trigger(other, "after", data, { text: summary, depth: depth + 1 }).then(
        (x) => void x?.done.catch(() => {}),
        (err) => this.recordFailure(other, "after", err),
      );
    }
  }

  /**
   * Whether an automatic start may happen now (G33.3): the recipe's hours, days, dates,
   * senders and words, its runs a day and its pause between runs.
   */
  private async allowed(row: Row, recipe: Recipe, facts: EventFacts): Promise<boolean> {
    const only = recipe.only;
    if (!only) return true;
    const now = this.now();
    if (!timeAllowed(recipe, now) || !factsAllowed(recipe, facts)) return false;
    if (only.cooldownMinutes) {
      const since = new Date(now.getTime() - only.cooldownMinutes * 60_000);
      const [r] = await this.o.db.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM rg_automation_runs WHERE automation_id = $1 AND trigger <> 'manual'
         AND status NOT IN ('skipped', 'queued') AND started_at > $2`,
        [row.id, since],
      );
      if (Number(r?.n ?? 0) > 0) return false;
    }
    if (only.maxPerDay) {
      const t = localTime(now, recipe.on.timezone);
      const dayStart = new Date(
        now.getTime() - t.minute * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds(),
      );
      const [r] = await this.o.db.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM rg_automation_runs WHERE automation_id = $1 AND trigger <> 'manual'
         AND status NOT IN ('skipped', 'queued') AND started_at >= $2`,
        [row.id, dayStart],
      );
      if (Number(r?.n ?? 0) >= only.maxPerDay) return false;
    }
    return true;
  }

  /**
   * Starts a run (or records why it could not). Null when the recipe's conditions say no:
   * nothing is recorded then, so a busy mailbox does not fill the history.
   */
  private async trigger(
    row: Row,
    trigger: AutomationTrigger,
    payload?: unknown,
    opts: EventFacts & { depth?: number; replyTo?: string } = {},
  ): Promise<Started | null> {
    const recipe = parseRecipe(row.yaml);
    if (trigger !== "manual" && trigger !== "retry" && !(await this.allowed(row, recipe, opts)))
      return null;
    const runId = `run_${randomUUID().slice(0, 12)}`;
    // Reserved before any await: two triggers at the same moment cannot both start.
    const busy = this.running.has(row.id);
    const queue = busy && recipe.overlap === "queue" && !this.queued.has(row.id);
    const controller = new AbortController();
    let release = () => {};
    const finished = new Promise<void>((r) => {
      release = r;
    });
    let go = () => {};
    const turn = new Promise<void>((r) => {
      go = r;
    });
    const slot = { controller, done: finished };
    if (!busy) this.running.set(row.id, slot);
    if (queue) this.queued.set(row.id, { slot, go });
    const status: AutomationRunStatus = queue ? "queued" : busy ? "skipped" : "running";
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
          queue
            ? "Waiting for the previous run to end."
            : busy
              ? "The previous run was still going."
              : "",
          startedAt,
          busy && !queue ? startedAt : null,
        ],
      );
      inserted = true;
      await this.log(row, recipe, runId, trigger, status, null);
    } catch (err) {
      if (!busy) {
        this.running.delete(row.id);
        release();
      }
      if (queue) this.queued.delete(row.id);
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
    if (busy && !queue) return { run, done: Promise.resolve() };
    const end = { depth: opts.depth ?? 0, ...(opts.replyTo && { replyTo: opts.replyTo }) };

    let sessionId: string | null = null;
    const done = (async () => {
      if (queue) {
        // Its turn comes when the run in progress ends (or never, when the server stops).
        await turn;
        if (controller.signal.aborted) {
          await this.finish(
            row,
            recipe,
            runId,
            trigger,
            aborted(controller.signal, recipe),
            null,
            end,
          );
          return;
        }
        await this.o.db
          .query(
            "UPDATE rg_automation_runs SET status = 'running', summary = '', started_at = $2 WHERE id = $1",
            [runId, this.now()],
          )
          .catch(() => {});
        await this.log(row, recipe, runId, trigger, "running", null).catch(() => {});
        this.changed(row.owner_id, row.id);
      }
      const timeout = setTimeout(
        () => controller.abort(new TimeoutError()),
        recipe.timeoutMinutes * (this.o.minuteMs ?? 60_000),
      );
      let outcome: { status: AutomationRunStatus; summary: string };
      try {
        // Asked first when the recipe says so; only a clear yes goes on (G33.3).
        if (recipe.approve && trigger !== "manual") {
          await this.o.db
            .query("UPDATE rg_automation_runs SET summary = $2 WHERE id = $1", [
              runId,
              "Waiting for your yes.",
            ])
            .then(() => this.changed(row.owner_id, row.id))
            .catch(() => {});
          const yes = this.o.host.approve
            ? await this.o.host
                .approve(
                  row.owner_id,
                  recipe,
                  { automationId: row.id, runId, trigger, about: about(trigger, payload) },
                  controller.signal,
                )
                .catch(() => false)
            : false;
          if (yes !== true) {
            await this.finish(
              row,
              recipe,
              runId,
              trigger,
              { status: "skipped", summary: "Not approved: it did not run." },
              null,
              { ...end, quiet: true },
            );
            return;
          }
        }
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
                spent: (usd) => {
                  if (recipe.budgetUsd !== undefined && usd > recipe.budgetUsd)
                    controller.abort(new BudgetError(recipe.budgetUsd, usd));
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
      await this.finish(row, recipe, runId, trigger, outcome, sessionId, end);
    })().finally(() => {
      if (this.running.get(row.id) === slot) this.running.delete(row.id);
      release();
      // The queued run takes the place of this one, before anything else can.
      const next = this.queued.get(row.id);
      if (next) {
        this.queued.delete(row.id);
        this.running.set(row.id, next.slot);
        next.go();
      }
      const follow = this.afterRun.get(runId);
      if (follow) {
        this.afterRun.delete(runId);
        const p = follow().finally(() => this.starting.delete(p));
        this.starting.add(p);
      }
    });
    if (!queue) go();
    return { run, done };
  }

  private async finish(
    row: Row,
    recipe: Recipe,
    runId: string,
    trigger: AutomationTrigger,
    outcome: { status: AutomationRunStatus; summary: string },
    sessionId: string | null,
    /**
     * `depth`: how many automations led here (a chain stops at MAX_CHAIN); `replyTo`: the chat
     * platform that started it; `quiet`: not approved, nothing to tell or to try again.
     */
    end: { depth: number; replyTo?: string; quiet?: boolean },
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
    if (end.quiet) return;
    const failed = outcome.status === "failed" || outcome.status === "timeout";
    // Tried again later when the recipe says so (G33.3); the person hears of the last try only.
    const retrying = failed && (await this.planRetry(row, recipe, trigger));
    if (!failed) await this.clearRetry(row);
    const when = recipe.notify.when;
    if (!retrying && (when === "always" || (when === "failure" && outcome.status !== "ok"))) {
      const head = `Automation ${recipe.name}: ${outcome.status === "ok" ? "done" : outcome.status}`;
      // A reminder is sent as written: it is the message.
      const text =
        recipe.reminder !== undefined && outcome.status === "ok"
          ? recipe.reminder
          : summary
            ? `${head}\n\n${summary}`
            : head;
      // A run started by a chat message answers on that platform, unless the recipe says where.
      const delivery = await this.deliver(
        row.owner_id,
        text,
        recipe.notify.to ?? (end.replyTo ? [end.replyTo] : undefined),
        {
          automationId: row.id,
          name: recipe.name,
          runId,
          status: outcome.status,
          sessionId,
        },
        {
          subject: head,
          ...(recipe.notify.email && { to: recipe.notify.email }),
          ...(recipe.notify.box && { box: recipe.notify.box }),
        },
      );
      await this.o.db
        .query("UPDATE rg_automation_runs SET delivery = $2::jsonb WHERE id = $1", [
          runId,
          JSON.stringify(delivery),
        ])
        .then(() => this.changed(row.owner_id, row.id))
        .catch((err) => this.fail(`run ${runId}: delivery not recorded`, err));
    }
    // Started once this run has freed its place (a loop back to it must not be skipped).
    if (!retrying && outcome.status !== "skipped")
      this.afterRun.set(runId, () =>
        this.followers(row, recipe, outcome.status, summary, end.depth).catch((err) =>
          this.fail(`automation ${row.id}: followers`, err),
        ),
      );
  }

  /** A failed run with tries left: the next one is due later. True when one was planned. */
  private async planRetry(row: Row, recipe: Recipe, trigger: AutomationTrigger): Promise<boolean> {
    const retries = recipe.onFailure?.retries ?? 0;
    if (retries === 0) return false;
    const [fresh] = await this.o.db
      .query<Row>("SELECT * FROM rg_automations WHERE id = $1", [row.id])
      .catch(() => [] as Row[]);
    if (!fresh) return false;
    const left = trigger === "retry" ? (fresh.retry_left ?? 0) : retries;
    if (left <= 0) {
      await this.clearRetry(row);
      return false;
    }
    const at = new Date(this.now().getTime() + (recipe.onFailure?.retryMinutes ?? 5) * 60_000);
    await this.o.db.query(
      "UPDATE rg_automations SET retry_at = $2, retry_left = $3 WHERE id = $1",
      [row.id, at, left - 1],
    );
    this.rearm();
    return true;
  }

  private async clearRetry(row: Row) {
    await this.o.db
      .query(
        "UPDATE rg_automations SET retry_at = NULL, retry_left = NULL WHERE id = $1 AND retry_at IS NOT NULL",
        [row.id],
      )
      .catch(() => {});
  }

  /** Sends a run's message where the recipe says and tells where it arrived. Never throws. */
  private async deliver(
    ownerId: string,
    text: string,
    to: string[] | undefined,
    info: NoticeInfo,
    mail: { subject: string; to?: string; box?: string } = { subject: info.name },
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
    if (to?.includes("email")) {
      if (!this.o.host.sendEmail) failed.push("email: not available");
      else
        await this.o.host.sendEmail(ownerId, { ...mail, text }).then(
          (address) => delivered.push(`email ${address}`),
          (err) => failed.push(`email: ${message(err)}`),
        );
    }
    const chats = to?.filter((c) => c !== "web" && c !== "email");
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
   * server was down happen once now if the recipe says `missed: run`; recipes on startup run;
   * the ends of tasks are followed (G33.3).
   */
  async start(): Promise<void> {
    let failed = false;
    this.followTasks();
    try {
      await this.o.db
        .query(
          `UPDATE rg_automation_runs SET status = 'failed', summary = 'Interrupted: the server stopped during the run.', finished_at = $1
       WHERE status IN ('running', 'queued')`,
          [this.now()],
        )
        .catch((err) => this.fail("closing interrupted runs", err));
      const now = this.now();
      const late = await this.o.db.query<Row>(
        "SELECT * FROM rg_automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at < $1",
        [now],
      );
      for (const row of late) if (!(await this.due(row, now, "missed"))) failed = true;
      const all = await this.o.db.query<Row>(
        "SELECT * FROM rg_automations WHERE enabled ORDER BY name",
        [],
      );
      for (const row of all)
        if (safeRecipe(row.yaml)?.on.startup)
          await this.trigger(row, "startup").then(
            (r) => r?.done.catch(() => {}),
            async (err) => {
              failed = true;
              await this.recordFailure(row, "startup", err);
            },
          );
    } catch (err) {
      failed = true;
      this.fail("start", err);
    } finally {
      // Whatever went wrong, the schedule goes on.
      this.started = true;
      this.rearm(failed);
    }
  }

  /** The ends of tasks, from the log: the recipes with `on.task` start on them. */
  private followTasks() {
    if (this.unfollow) return;
    this.unfollow = this.o.store.subscribe((e) => {
      if (e.type === "task.opened" && e.payload) {
        const p = e.payload as { taskId: string; title?: string };
        this.taskTitles.set(p.taskId, p.title ?? "");
        if (this.taskTitles.size > 5000) {
          const first = this.taskTitles.keys().next().value;
          if (first !== undefined) this.taskTitles.delete(first);
        }
      }
      if (e.type !== "task.closed" || !e.payload) return;
      const p = e.payload as { taskId: string; outcome: string };
      const title = this.taskTitles.get(p.taskId) ?? "";
      void this.taskClosed(e.ownerId, e.projectId ?? null, {
        id: p.taskId,
        outcome: p.outcome,
        title,
      }).catch((err) => this.fail("task closed", err));
    });
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
      // Failed runs tried again (G33.3).
      const again = await this.o.db.query<Row>(
        "SELECT * FROM rg_automations WHERE enabled AND retry_at IS NOT NULL AND retry_at <= $1 ORDER BY retry_at",
        [now],
      );
      for (const row of again) {
        await this.o.db.query("UPDATE rg_automations SET retry_at = NULL WHERE id = $1", [row.id]);
        await this.trigger(row, "retry").then(
          (r) => r?.done.catch(() => {}),
          async (err) => {
            failed = true;
            await this.recordFailure(row, "retry", err);
          },
        );
      }
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
        `SELECT min(t) AS next FROM (
           SELECT next_run_at AS t FROM rg_automations WHERE enabled AND next_run_at IS NOT NULL
           UNION ALL SELECT retry_at AS t FROM rg_automations WHERE enabled AND retry_at IS NOT NULL
         ) due`,
      )
      .then(
        ([r]) => arm(r?.next ? new Date(r.next).getTime() - this.now().getTime() : max),
        (err) => {
          this.fail("rearm", err);
          arm(max);
        },
      );
  }

  /** Every run that is going right now (or waits for its turn) has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.queued.size > 0 || this.starting.size > 0)
      await Promise.allSettled([
        ...[...this.running.values(), ...[...this.queued.values()].map((q) => q.slot)].map(
          (r) => r.done,
        ),
        ...this.starting,
      ]);
  }

  /** Stops the timer and the runs in progress (they are recorded as failed). */
  async stop(): Promise<void> {
    this.started = false;
    clearTimeout(this.timer);
    this.unfollow?.();
    this.unfollow = undefined;
    for (const r of this.running.values()) r.controller.abort(new Error("The server is stopping"));
    for (const q of this.queued.values())
      q.slot.controller.abort(new Error("The server is stopping"));
    await this.idle();
  }
}

class TimeoutError extends Error {}

/** A run past its recipe's spending limit (G33.3). */
class BudgetError extends Error {
  constructor(limit: number, spent: number) {
    super(
      `Stopped: it spent $${spent.toFixed(2)}, over the limit of $${limit.toFixed(2)} for one run.`,
    );
  }
}

/** A run that started, and its end. */
export type Started = { run: AutomationRun; done: Promise<void> };

/** How many automations may start one another in a row (A after B after C…). */
const MAX_CHAIN = 5;

/** A recipe, or undefined when it no longer reads (it is reported where it is due). */
function safeRecipe(yaml: string): Recipe | undefined {
  try {
    return parseRecipe(yaml);
  } catch {
    return undefined;
  }
}

/** Whether an email trigger watches this mailbox: all, these ids, or these categories. */
function watches(
  f: NonNullable<Recipe["on"]["email"]>,
  box: { id: string; category: string } | undefined,
): boolean {
  if (!f.boxes && !f.categories) return true;
  if (!box) return false;
  return (f.boxes?.includes(box.id) ?? false) || (f.categories?.includes(box.category) ?? false);
}

/** What started a run, in a line, for the person asked to approve it. */
function about(trigger: AutomationTrigger, payload: unknown): string {
  const p = (payload ?? {}) as {
    email?: { from: string; subject: string };
    message?: { platform: string; from: string; text: string };
    files?: { path: string }[];
    after?: { automation: string; status: string };
    task?: { title: string; outcome: string };
  };
  const cut = (x: string) => (x.length > 160 ? `${x.slice(0, 160)}…` : x);
  if (p.email) return cut(`Email from ${p.email.from}: ${p.email.subject}`);
  if (p.message)
    return cut(`Message on ${p.message.platform} from ${p.message.from}: ${p.message.text}`);
  if (p.files) return cut(`Files changed: ${p.files.map((f) => f.path).join(", ")}`);
  if (p.after) return `Automation ${p.after.automation} ended: ${p.after.status}`;
  if (p.task) return cut(`Task ended (${p.task.outcome}): ${p.task.title}`);
  return trigger;
}

function aborted(
  signal: AbortSignal,
  recipe: Recipe,
): { status: AutomationRunStatus; summary: string } {
  return signal.reason instanceof TimeoutError
    ? { status: "timeout", summary: `Stopped after ${recipe.timeoutMinutes} minutes.` }
    : { status: "failed", summary: (signal.reason as Error | undefined)?.message ?? "Stopped." };
}
