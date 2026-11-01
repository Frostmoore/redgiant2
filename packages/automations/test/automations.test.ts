import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import type { Recipe } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AutomationHost,
  AutomationService,
  migrateAutomations,
  nextRun,
  parseRecipe,
  type RunContext,
  WebhookForbiddenError,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const OWNER = "local";

describe("parseRecipe", () => {
  it("fills in the defaults", () => {
    const r = parseRecipe(`
name: morning-digest
on:
  cron: "0 8 * * 1-5"
  timezone: Europe/Rome
instructions: Summarise yesterday's work on every project.
`);
    expect(r).toMatchObject({
      name: "morning-digest",
      agent: "god",
      project: null,
      session: "new",
      timeoutMinutes: 30,
      missed: "skip",
      notify: { when: "always" },
      on: { cron: "0 8 * * 1-5", timezone: "Europe/Rome", webhook: false },
    });
  });

  it("reports every problem by field", () => {
    const bad = (yaml: string) => () => parseRecipe(yaml);
    expect(bad("name: Bad Name\non: {cron: '* * * * *'}\ninstructions: x")).toThrow(/^name:/);
    expect(bad("name: a\non: {}\ninstructions: x")).toThrow(/cron expression, a webhook/);
    expect(bad("name: a\non: {cron: 'every day'}\ninstructions: x")).toThrow(/^on: /);
    expect(bad("name: a\non: {cron: '0 8 * * *', timezone: Mars/Base}\ninstructions: x")).toThrow(
      /timezone/i,
    );
    expect(bad("name: a\non: {webhook: true}\ninstructions: x\ntools: [bash]")).toThrow(/tools/);
    expect(bad("name: a\non: {webhook: true}\ninstructions: '  '")).toThrow(/instructions/);
    expect(bad("name: [")).toThrow(/^YAML:/);
  });

  it("accepts every example in recipes/", () => {
    const dir = join(import.meta.dirname, "../../../recipes");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files)
      expect(parseRecipe(readFileSync(join(dir, f), "utf8")).name).toBeTruthy();
  });

  it("follows the time zone, daylight saving included", () => {
    const r = parseRecipe(
      "name: a\non: {cron: '0 8 * * *', timezone: Europe/Rome}\ninstructions: x",
    );
    // Summer time (UTC+2) until 25 October 2026, then UTC+1.
    expect(nextRun(r, new Date("2026-10-24T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-25T07:00:00.000Z",
    );
    expect(nextRun(r, new Date("2026-10-23T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-24T06:00:00.000Z",
    );
    expect(nextRun({ ...r, on: { webhook: true } } as Recipe, new Date())).toBeNull();
  });
});

/** A fake agent: answers with what it was asked, or waits until released. */
function fakeHost() {
  const calls: { recipe: Recipe; ctx: RunContext }[] = [];
  const notes: string[] = [];
  let gate: Promise<void> | undefined;
  let open = () => {};
  let n = 0;
  const host: AutomationHost = {
    async validate(_owner, recipe) {
      if (recipe.agent === "nobody") throw new Error('Agent "nobody" not found');
    },
    async run(_owner, recipe, ctx) {
      calls.push({ recipe, ctx });
      const sid = ctx.sessionId ?? `sess_${++n}`;
      ctx.onSession(sid);
      if (gate) {
        await Promise.race([
          gate,
          new Promise((_, reject) =>
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
          ),
        ]);
      }
      if (recipe.instructions === "fail") return { ok: false, summary: "It did not work." };
      return {
        ok: true,
        summary: `${recipe.name} via ${ctx.trigger}${ctx.payload ? ` ${JSON.stringify(ctx.payload)}` : ""}`,
      };
    },
    async notify(_owner, text) {
      notes.push(text);
    },
  };
  return {
    host,
    calls,
    notes,
    hold() {
      gate = new Promise((r) => {
        open = r;
      });
    },
    release() {
      gate = undefined;
      open();
    },
  };
}

let services: AutomationService[] = [];
afterEach(async () => {
  for (const s of services) await s.stop();
  services = [];
});

async function setup(start = "2026-10-31T06:00:00Z") {
  const { db } = await memoryDb();
  await migrate(db);
  await migrateAutomations(db);
  const store = new EventStore(db);
  const clock = { now: new Date(start) };
  const fake = fakeHost();
  const make = () => {
    const s = new AutomationService({
      db,
      store,
      host: fake.host,
      now: () => clock.now,
      minuteMs: 50,
    });
    services.push(s);
    return s;
  };
  return { db, store, clock, fake, make, svc: make() };
}

const DIGEST = `name: digest
on:
  cron: "0 8 * * *"
  timezone: Europe/Rome
instructions: Summarise the projects.
`;

describe("AutomationService", () => {
  it("runs a recipe when it is due, records it, logs it and tells the user", async () => {
    const { svc, clock, fake, store } = await setup();
    await svc.start();
    const { automation } = await svc.create(OWNER, DIGEST);
    expect(automation.nextRunAt).toBe("2026-10-31T07:00:00.000Z");

    clock.now = new Date("2026-10-31T06:59:59Z");
    await svc.tick();
    expect(fake.calls).toHaveLength(0);

    clock.now = new Date("2026-10-31T07:00:00Z");
    await svc.tick();
    await svc.idle();
    expect(fake.calls.map((c) => c.ctx.trigger)).toEqual(["cron"]);
    const after = await svc.get(OWNER, automation.id);
    expect(after.nextRunAt).toBe("2026-11-01T07:00:00.000Z");
    expect(after.lastRun).toMatchObject({
      status: "ok",
      trigger: "cron",
      sessionId: "sess_1",
      summary: "digest via cron",
    });
    expect(fake.notes).toEqual(["Automation digest: done\n\ndigest via cron"]);
    const logged = (await store.list({})).filter((e) => e.type === "automation.run");
    expect(logged.map((e) => (e.payload as { status: string }).status)).toEqual(["running", "ok"]);
  });

  it("never runs a recipe twice at once", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(OWNER, DIGEST);
    fake.hold();
    const first = await svc.runNow(OWNER, automation.id);
    const second = await svc.runNow(OWNER, automation.id);
    expect(second.run.status).toBe("skipped");
    fake.release();
    await first.done;
    expect((await svc.runs(OWNER, automation.id)).map((r) => r.status).sort()).toEqual([
      "ok",
      "skipped",
    ]);
    expect(fake.calls).toHaveLength(1);
  });

  it("stops a run that takes too long", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(OWNER, `${DIGEST}timeoutMinutes: 1\n`);
    fake.hold();
    await (await svc.runNow(OWNER, automation.id)).done;
    expect((await svc.get(OWNER, automation.id)).lastRun).toMatchObject({
      status: "timeout",
      summary: "Stopped after 1 minutes.",
    });
    expect(fake.notes[0]).toMatch(/^Automation digest: timeout/);
    fake.release();
  });

  it("notifies only failures when asked, and keeps a session with session: continue", async () => {
    const { svc, fake } = await setup();
    const quiet = await svc.create(
      OWNER,
      "name: quiet\non: {webhook: true}\ninstructions: x\nnotify: {when: failure}\nsession: continue\n",
    );
    await (await svc.runNow(OWNER, quiet.automation.id)).done;
    await (await svc.runNow(OWNER, quiet.automation.id)).done;
    expect(fake.calls.map((c) => c.ctx.sessionId)).toEqual([null, "sess_1"]);
    expect(fake.notes).toEqual([]);
    const loud = await svc.create(
      OWNER,
      "name: loud\non: {webhook: true}\ninstructions: fail\nnotify: {when: failure}\n",
    );
    await (await svc.runNow(OWNER, loud.automation.id)).done;
    expect(fake.notes).toEqual(["Automation loud: failed\n\nIt did not work."]);
    // Editing a recipe forgets its session (the agent or the model may have changed).
    await svc.update(OWNER, quiet.automation.id, `${quiet.automation.yaml}description: edited\n`);
    await (await svc.runNow(OWNER, quiet.automation.id)).done;
    expect(fake.calls.at(-1)?.ctx.sessionId).toBeNull();
  });

  it("checks the webhook's secret and passes the body as data", async () => {
    const { svc, fake } = await setup();
    const { automation, webhookSecret } = await svc.create(
      OWNER,
      "name: on-push\non: {webhook: true}\ninstructions: Review the push.\n",
    );
    expect(webhookSecret).toMatch(/^rgwh_/);
    expect(automation.hasWebhookSecret).toBe(true);
    expect(automation.nextRunAt).toBeNull();
    await expect(svc.webhook(automation.id, "rgwh_wrong", {})).rejects.toThrow(
      WebhookForbiddenError,
    );
    await expect(svc.webhook("auto_missing", webhookSecret ?? "", {})).rejects.toThrow(
      WebhookForbiddenError,
    );
    await (await svc.webhook(automation.id, webhookSecret ?? "", { ref: "main" })).done;
    expect(fake.calls[0]?.ctx).toMatchObject({ trigger: "webhook", payload: { ref: "main" } });

    const rotated = await svc.rotateSecret(OWNER, automation.id);
    await expect(svc.webhook(automation.id, webhookSecret ?? "", {})).rejects.toThrow(
      WebhookForbiddenError,
    );
    await svc.setEnabled(OWNER, automation.id, false);
    await expect(svc.webhook(automation.id, rotated, {})).rejects.toThrow(WebhookForbiddenError);
  });

  it("after a restart: closes interrupted runs and catches up only when asked", async () => {
    const { svc, make, clock, fake, db } = await setup();
    const skip = await svc.create(OWNER, DIGEST);
    const run = await svc.create(OWNER, `${DIGEST.replace("digest", "catch-up")}missed: run\n`);
    fake.hold();
    await svc.runNow(OWNER, skip.automation.id);
    await svc.stop();
    fake.release();
    // A crash leaves the run as "running"; the next start closes it.
    await db.query("UPDATE rg_automation_runs SET status = 'running', finished_at = NULL");

    clock.now = new Date("2026-10-31T12:00:00Z"); // 08:00 Rome was missed
    const again = make();
    await again.start();
    await again.idle();
    expect((await again.get(OWNER, skip.automation.id)).lastRun).toMatchObject({
      status: "failed",
      summary: "Interrupted: the server stopped during the run.",
    });
    expect(fake.calls.map((c) => [c.recipe.name, c.ctx.trigger])).toEqual([
      ["digest", "manual"],
      ["catch-up", "missed"],
    ]);
    expect((await again.get(OWNER, skip.automation.id)).nextRunAt).toBe("2026-11-01T07:00:00.000Z");
    expect((await again.get(OWNER, run.automation.id)).nextRunAt).toBe("2026-11-01T07:00:00.000Z");
  });

  it("refuses recipes the host cannot run and duplicate names", async () => {
    const { svc } = await setup();
    await expect(svc.create(OWNER, `${DIGEST}agent: nobody\n`)).rejects.toThrow(/nobody/);
    await svc.create(OWNER, DIGEST);
    await expect(svc.create(OWNER, DIGEST)).rejects.toThrow(/already exists/);
    expect(await svc.list("someone-else")).toEqual([]);
  });

  it("wakes itself up with a real timer", async () => {
    const { svc, fake } = await setup();
    const real = new AutomationService({
      db: (svc as unknown as { o: { db: never } }).o.db,
      store: (svc as unknown as { o: { store: never } }).o.store,
      host: fake.host,
      maxSleepMs: 20,
    });
    services.push(real);
    await real.create(OWNER, "name: every-second\non: {cron: '* * * * * *'}\ninstructions: x\n");
    await real.start();
    for (let i = 0; i < 100 && fake.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 30));
    expect(fake.calls[0]?.ctx.trigger).toBe("cron");
  });
});
