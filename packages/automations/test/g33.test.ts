import { EventStore, migrate } from "@redgiant/events";
import type { Recipe } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AutomationHost,
  AutomationService,
  factsAllowed,
  migrateAutomations,
  nextRun,
  nextRuns,
  parseRecipe,
  type RunContext,
  timeAllowed,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const OWNER = "local";

describe("recipes without limits (G33.3)", () => {
  it("reads every new trigger, condition and action", () => {
    const r = parseRecipe(`
name: all-of-it
on:
  cron: "0 * * * *"
  timezone: Europe/Rome
  email: {from: bank, boxes: [box_1], categories: [work], text: invoice}
  message: {platforms: [whatsapp, telegram], from: anna, words: [spesa], handle: true}
  files: {path: docs, pattern: "*.pdf", changes: [added]}
  after: {automation: other, status: [failed]}
  task: {project: site, outcome: [verified]}
  startup: true
project: site
only:
  hours: {from: "09:00", to: "18:00"}
  days: [1, 2, 3, 4, 5]
  dates: {from: "2026-11-01", to: "2026-12-31"}
  from: [anna]
  words: [urgent, now]
  match: all
  without: [spam]
  maxPerDay: 3
  cooldownMinutes: 10
approve: true
budgetUsd: 0.5
overlap: queue
onFailure: {retries: 2, retryMinutes: 10, run: fallback}
notify: {when: failure, to: [whatsapp, email, web], email: me@example.com, box: box_1}
instructions: Do it.
`);
    expect(r).toMatchObject({
      approve: true,
      budgetUsd: 0.5,
      overlap: "queue",
      onFailure: { retries: 2, retryMinutes: 10, run: "fallback" },
      on: { startup: true, message: { handle: true }, files: { path: "docs" } },
      only: { match: "all", maxPerDay: 3 },
      notify: { to: ["whatsapp", "email", "web"], email: "me@example.com" },
    });
    // The defaults keep the old behaviour.
    const old = parseRecipe("name: a\non: {cron: '0 8 * * *'}\ninstructions: x");
    expect(old).toMatchObject({ approve: false, overlap: "skip", on: { startup: false } });
    expect(old.only).toBeUndefined();
  });

  it("refuses what cannot work", () => {
    const bad = (yaml: string) => () => parseRecipe(yaml);
    expect(bad("name: a\non: {files: {path: .}}\ninstructions: x")).toThrow(/project/);
    expect(bad("name: a\non: {after: {automation: a}}\ninstructions: x")).toThrow(/itself/);
    expect(bad("name: a\non: {startup: true}\nonFailure: {run: a}\ninstructions: x")).toThrow(
      /itself/,
    );
    expect(
      bad("name: a\non: {startup: true}\nonly: {hours: {from: '9', to: '18:00'}}\ninstructions: x"),
    ).toThrow(/HH:MM/);
    expect(bad("name: a\non: {message: {platforms: [fax]}}\ninstructions: x")).toThrow();
    expect(bad("name: a\non: {startup: true}\nnotify: {to: [pigeon]}\ninstructions: x")).toThrow();
    expect(bad("name: a\non: {startup: true}\ntools: [bash]\ninstructions: x")).toThrow(/tools/);
  });

  it("skips scheduled times outside the hours and days, also across midnight", () => {
    const r = parseRecipe(`name: a
on: {cron: "0 * * * *", timezone: Europe/Rome}
only: {hours: {from: "09:00", to: "11:00"}, days: [1, 2, 3, 4, 5]}
instructions: x`);
    // Saturday 31 October 2026, 10:30 in Rome: the next allowed hour is Monday 09:00 (UTC+1).
    expect(nextRun(r, new Date("2026-10-31T09:30:00Z"))?.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
    expect(nextRuns(r, new Date("2026-10-31T09:30:00Z"), 4).map((d) => d.toISOString())).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T09:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-03T08:00:00.000Z",
    ]);
    const night = parseRecipe(`name: a
on: {cron: "0 * * * *", timezone: UTC}
only: {hours: {from: "22:00", to: "02:00"}}
instructions: x`);
    expect(timeAllowed(night, new Date("2026-11-02T23:00:00Z"))).toBe(true);
    expect(timeAllowed(night, new Date("2026-11-02T01:30:00Z"))).toBe(true);
    expect(timeAllowed(night, new Date("2026-11-02T12:00:00Z"))).toBe(false);
    const holiday = parseRecipe(`name: a
on: {cron: "0 9 * * *", timezone: UTC}
only: {dates: {from: "2026-12-24", to: "2026-12-26"}}
instructions: x`);
    expect(
      nextRuns(holiday, new Date("2026-11-01T00:00:00Z"), 5).map((d) => d.toISOString()),
    ).toEqual(["2026-12-24T09:00:00.000Z", "2026-12-25T09:00:00.000Z", "2026-12-26T09:00:00.000Z"]);
  });

  it("checks senders and words, any or all, and the words that exclude", () => {
    const r = (only: string) =>
      parseRecipe(`name: a\non: {startup: true}\nonly: ${only}\ninstructions: x`);
    const any = r("{from: [anna, bank], words: [urgent, today]}");
    expect(factsAllowed(any, { from: "Anna <anna@x>", text: "call me TODAY" })).toBe(true);
    expect(factsAllowed(any, { from: "bob@x", text: "today" })).toBe(false);
    expect(factsAllowed(any, { from: "anna", text: "tomorrow" })).toBe(false);
    const all = r("{words: [urgent, today], match: all, without: [newsletter]}");
    expect(factsAllowed(all, { text: "urgent: today" })).toBe(true);
    expect(factsAllowed(all, { text: "urgent" })).toBe(false);
    expect(factsAllowed(all, { text: "urgent today newsletter" })).toBe(false);
  });
});

/** A fake agent that records what it was asked; `fail` makes the next runs fail. */
function fakeHost() {
  const calls: { recipe: Recipe; ctx: RunContext }[] = [];
  const notes: { text: string; to?: string[] }[] = [];
  const asked: string[] = [];
  const emails: { subject: string; text: string; to?: string }[] = [];
  let answer: boolean | "throw" | "wait" = true;
  let gate: Promise<void> | undefined;
  let open = () => {};
  let spend = 0;
  let failures = 0;
  const host: AutomationHost = {
    async validate() {},
    async run(_owner, recipe, ctx) {
      calls.push({ recipe, ctx });
      ctx.onSession(`sess_${calls.length}`);
      if (spend > 0) ctx.spent(spend);
      if (gate || ctx.signal.aborted)
        await Promise.race([
          gate ?? Promise.resolve(),
          new Promise((_, reject) => {
            if (ctx.signal.aborted) reject(ctx.signal.reason);
            ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
          }),
        ]);
      if (failures > 0) {
        failures--;
        return { ok: false, summary: "It broke." };
      }
      return { ok: true, summary: `${recipe.name} via ${ctx.trigger}` };
    },
    async notify(_owner, text, to) {
      notes.push({ text, ...(to && { to }) });
      return { delivered: to ?? ["telegram"], failed: [] };
    },
    async approve(_owner, recipe, ask, signal) {
      asked.push(`${recipe.name}: ${ask.about}`);
      if (answer === "throw") throw new Error("no page open");
      if (answer === "wait")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      return answer;
    },
    async sendEmail(_owner, mail) {
      emails.push(mail);
      return mail.to ?? "me@example.com";
    },
  };
  return {
    host,
    calls,
    notes,
    asked,
    emails,
    answer(a: boolean | "throw" | "wait") {
      answer = a;
    },
    spend(usd: number) {
      spend = usd;
    },
    fail(n: number) {
      failures = n;
    },
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

async function setup(start = "2026-11-02T06:00:00Z") {
  const { db } = await memoryDb();
  await migrate(db);
  await migrateAutomations(db);
  const store = new EventStore(db);
  const clock = { now: new Date(start) };
  const fake = fakeHost();
  const svc = new AutomationService({
    db,
    store,
    host: fake.host,
    now: () => clock.now,
    minuteMs: 50,
  });
  services.push(svc);
  return { db, store, clock, fake, svc };
}

const statuses = async (svc: AutomationService, id: string) =>
  (await svc.runs(OWNER, id)).map((r) => `${r.trigger}:${r.status}`).reverse();

describe("AutomationService without limits (G33.3)", () => {
  it("runs on schedule only inside the hours, on the fake clock", async () => {
    const { svc, clock, fake } = await setup("2026-11-02T06:00:00Z"); // Monday 07:00 in Rome
    await svc.start();
    const { automation } = await svc.create(
      OWNER,
      `name: office\non: {cron: "0 * * * *", timezone: Europe/Rome}\nonly: {hours: {from: "09:00", to: "10:00"}}\ninstructions: x`,
    );
    expect(automation.nextRunAt).toBe("2026-11-02T08:00:00.000Z");
    for (const at of ["08:00", "09:00", "10:00"]) {
      clock.now = new Date(`2026-11-02T${at}:00Z`);
      await svc.tick();
      await svc.idle();
    }
    expect(fake.calls).toHaveLength(2);
    expect((await svc.get(OWNER, automation.id)).nextRunAt).toBe("2026-11-03T08:00:00.000Z");
  });

  it("asks before acting: a yes runs it, a no, a failure or no answer never do", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: careful\non: {email: {}}\napprove: true\ninstructions: Pay the bill.",
    );
    const mail = { from: "bank@x", subject: "Bill", date: "", text: "42 EUR" };
    fake.answer(false);
    await (await svc.email(OWNER, automation.id, mail))?.done;
    fake.answer("throw");
    await (await svc.email(OWNER, automation.id, mail))?.done;
    expect(fake.calls).toHaveLength(0);
    expect(fake.notes).toHaveLength(0);
    fake.answer(true);
    await (await svc.email(OWNER, automation.id, mail))?.done;
    expect(fake.calls).toHaveLength(1);
    expect(fake.asked[0]).toBe("careful: Email from bank@x: Bill");
    const runs = await svc.runs(OWNER, automation.id);
    expect(runs.map((r) => r.status).sort()).toEqual(["ok", "skipped", "skipped"]);
    for (const r of runs.filter((x) => x.status === "skipped"))
      expect(r.summary).toMatch(/Not approved/);
    // A run started by hand is the person's own yes.
    await (await svc.runNow(OWNER, automation.id)).done;
    expect(fake.asked).toHaveLength(3);
  });

  it("waiting for a yes ends with the run's time: never allowed by a timeout", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: careful\non: {startup: true}\napprove: true\ntimeoutMinutes: 1\ninstructions: x",
    );
    fake.answer("wait");
    await svc.start();
    await svc.idle();
    expect(fake.calls).toHaveLength(0);
    expect((await svc.runs(OWNER, automation.id))[0]).toMatchObject({
      trigger: "startup",
      status: "skipped",
    });
  });

  it("stops a run that spends more than its limit", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: thrifty\non: {startup: true}\nbudgetUsd: 0.1\ninstructions: x",
    );
    fake.spend(0.25);
    fake.hold();
    const { done } = await svc.runNow(OWNER, automation.id);
    await done;
    fake.release();
    const [run] = await svc.runs(OWNER, automation.id);
    expect(run?.status).toBe("failed");
    expect(run?.summary).toMatch(/over the limit of \$0.10/);
  });

  it("queues one run behind the one in progress instead of skipping it", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: patient\non: {email: {}}\noverlap: queue\ninstructions: x",
    );
    const mail = { from: "a", subject: "s", date: "", text: "t" };
    fake.hold();
    const first = await svc.email(OWNER, automation.id, mail);
    const second = await svc.email(OWNER, automation.id, mail);
    const third = await svc.email(OWNER, automation.id, mail);
    expect(second?.run.status).toBe("queued");
    expect(third?.run.status).toBe("skipped");
    expect(fake.calls).toHaveLength(1);
    fake.release();
    await first?.done;
    await second?.done;
    await svc.idle();
    expect(fake.calls).toHaveLength(2);
    expect((await statuses(svc, automation.id)).sort()).toEqual([
      "email:ok",
      "email:ok",
      "email:skipped",
    ]);
  });

  it("tries a failed run again on the fake clock, then starts the fallback", async () => {
    const { svc, clock, fake } = await setup();
    await svc.start();
    await svc.create(OWNER, "name: fallback\non: {webhook: true}\nreminder: The backup failed.");
    const { automation } = await svc.create(
      OWNER,
      "name: backup\non: {startup: true}\nonFailure: {retries: 2, retryMinutes: 10, run: fallback}\nnotify: {when: failure}\ninstructions: x",
    );
    fake.fail(10);
    await (await svc.runNow(OWNER, automation.id)).done;
    // No message while tries are left.
    expect(fake.notes).toHaveLength(0);
    expect((await svc.runs(OWNER, automation.id)).length).toBe(1);
    clock.now = new Date(clock.now.getTime() + 9 * 60_000);
    await svc.tick();
    await svc.idle();
    expect((await svc.runs(OWNER, automation.id)).length).toBe(1);
    clock.now = new Date(clock.now.getTime() + 60_000);
    await svc.tick();
    await svc.idle();
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await svc.tick();
    await svc.idle();
    expect(await statuses(svc, automation.id)).toEqual([
      "manual:failed",
      "retry:failed",
      "retry:failed",
    ]);
    // The last failure is told, and the fallback ran with it as data.
    expect(fake.notes.map((n) => n.text)).toEqual([
      "Automation backup: failed\n\nIt broke.",
      "The backup failed.",
    ]);
    clock.now = new Date(clock.now.getTime() + 60 * 60_000);
    await svc.tick();
    await svc.idle();
    expect((await svc.runs(OWNER, automation.id)).length).toBe(3);
  });

  it("a success after a retry stops the tries", async () => {
    const { svc, clock, fake } = await setup();
    await svc.start();
    const { automation } = await svc.create(
      OWNER,
      "name: flaky\non: {startup: true}\nonFailure: {retries: 3}\ninstructions: x",
    );
    fake.fail(1);
    await (await svc.runNow(OWNER, automation.id)).done;
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    await svc.tick();
    await svc.idle();
    clock.now = new Date(clock.now.getTime() + 60 * 60_000);
    await svc.tick();
    await svc.idle();
    expect(await statuses(svc, automation.id)).toEqual(["manual:failed", "retry:ok"]);
  });

  it("follows another automation, and a loop of them stops", async () => {
    const { svc, fake } = await setup();
    const { automation: a } = await svc.create(
      OWNER,
      "name: first\non: {webhook: true}\ninstructions: x",
    );
    const { automation: b } = await svc.create(
      OWNER,
      "name: second\non: {after: {automation: first, status: [ok]}}\ninstructions: x",
    );
    await svc.create(
      OWNER,
      "name: on-fail\non: {after: {automation: first, status: [failed]}}\ninstructions: x",
    );
    await (await svc.runNow(OWNER, a.id)).done;
    await svc.idle();
    expect(fake.calls.map((c) => `${c.recipe.name}:${c.ctx.trigger}`)).toEqual([
      "first:manual",
      "second:after",
    ]);
    expect(fake.calls[1]?.ctx.payload).toMatchObject({
      after: { automation: "first", status: "ok", summary: "first via manual" },
    });
    expect((await svc.runs(OWNER, b.id))[0]?.trigger).toBe("after");
    // ping after pong after ping…: a few rounds, then it stops.
    await svc.create(OWNER, "name: ping\non: {after: {automation: pong}}\ninstructions: x");
    const { automation: pong } = await svc.create(
      OWNER,
      "name: pong\non: {after: {automation: ping}}\ninstructions: x",
    );
    fake.calls.length = 0;
    await (await svc.runNow(OWNER, pong.id)).done;
    await svc.idle();
    expect(fake.calls.length).toBe(6);
  });

  it("starts on RedGiant's start and on the end of a task", async () => {
    const { svc, store, fake } = await setup();
    await svc.create(OWNER, "name: hello\non: {startup: true}\ninstructions: x");
    await svc.create(
      OWNER,
      "name: shipped\non: {task: {project: site, outcome: [verified]}}\nproject: site\ninstructions: x",
    );
    await svc.start();
    await svc.idle();
    expect(fake.calls.map((c) => c.ctx.trigger)).toEqual(["startup"]);
    const task = (projectId: string, outcome: string) => async () => {
      await store.append({
        ownerId: OWNER,
        projectId,
        sessionId: null,
        body: {
          type: "task.opened",
          payload: { taskId: `t_${outcome}`, title: "Fix the menu", from: undefined },
        } as never,
      });
      await store.append({
        ownerId: OWNER,
        projectId,
        sessionId: null,
        body: { type: "task.closed", payload: { taskId: `t_${outcome}`, outcome } } as never,
      });
    };
    await task("other", "verified")();
    await task("site", "abandoned")();
    await task("site", "verified")();
    for (let i = 0; i < 50 && fake.calls.length < 2; i++)
      await new Promise((r) => setTimeout(r, 10));
    await svc.idle();
    expect(fake.calls.map((c) => c.ctx.trigger)).toEqual(["startup", "task"]);
    expect(fake.calls[1]?.ctx.payload).toMatchObject({
      task: { title: "Fix the menu", outcome: "verified", project: "site" },
    });
  });

  it("starts on chat messages that match, keeps them when asked, answers where they came", async () => {
    const { svc, fake } = await setup();
    await svc.create(
      OWNER,
      "name: shopping\non: {message: {platforms: [whatsapp], words: [spesa], handle: true}}\ninstructions: Add it to the list.",
    );
    await svc.create(
      OWNER,
      "name: anna\non: {message: {from: anna}}\nonly: {without: [spesa]}\ninstructions: x",
    );
    const msg = (platform: string, from: string, text: string) => ({
      platform,
      userId: "u1",
      from,
      chatId: "c1",
      text,
    });
    const got = await svc.message(OWNER, msg("whatsapp", "Anna", "Spesa: latte e pane"));
    expect(got.taken).toBe(true);
    expect(got.started).toHaveLength(1);
    await Promise.all(got.started.map((s) => s.done));
    expect(fake.calls[0]?.ctx.payload).toMatchObject({ message: { text: "Spesa: latte e pane" } });
    expect(fake.notes[0]?.to).toEqual(["whatsapp"]);
    const other = await svc.message(OWNER, msg("telegram", "Anna", "spesa: uova"));
    expect(other).toMatchObject({ taken: false, started: [] });
    const hi = await svc.message(OWNER, msg("telegram", "Anna", "ciao"));
    expect(hi.taken).toBe(false);
    expect(hi.started).toHaveLength(1);
    await Promise.all(hi.started.map((s) => s.done));
    expect(fake.notes[1]?.to).toEqual(["telegram"]);
  });

  it("watches only the mailboxes and categories it asks for", async () => {
    const { svc, fake } = await setup();
    const { automation: work } = await svc.create(
      OWNER,
      "name: work\non: {email: {categories: [work], boxes: [box_b]}}\ninstructions: x",
    );
    const mail = (id: string, category: string) => ({
      from: "a",
      subject: "s",
      date: "",
      text: "t",
      box: { id, name: id, category },
    });
    expect(await svc.email(OWNER, work.id, mail("box_a", "personal"))).toBeNull();
    await (await svc.email(OWNER, work.id, mail("box_c", "work")))?.done;
    await (await svc.email(OWNER, work.id, mail("box_b", "social")))?.done;
    expect(fake.calls).toHaveLength(2);
  });

  it("counts runs a day and pauses between them", async () => {
    const { svc, clock, fake } = await setup("2026-11-02T08:00:00Z");
    const { automation } = await svc.create(
      OWNER,
      "name: calm\non: {email: {}, timezone: UTC}\nonly: {maxPerDay: 2, cooldownMinutes: 30}\ninstructions: x",
    );
    const mail = { from: "a", subject: "s", date: "", text: "t" };
    const at = async (iso: string) => {
      clock.now = new Date(iso);
      await (await svc.email(OWNER, automation.id, mail))?.done;
    };
    await at("2026-11-02T08:00:00Z");
    await at("2026-11-02T08:10:00Z"); // in the pause
    await at("2026-11-02T09:00:00Z");
    await at("2026-11-02T10:00:00Z"); // two today already
    await at("2026-11-03T08:00:00Z"); // a new day
    expect(fake.calls).toHaveLength(3);
    // A run by hand is never held back.
    await (await svc.runNow(OWNER, automation.id)).done;
    expect(fake.calls).toHaveLength(4);
  });

  it("starts once for a batch of changed files, only the changes it asks for", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: inbox\non: {files: {path: inbox, changes: [added]}}\nproject: site\ninstructions: File them.",
    );
    expect(
      await svc.filesChanged(OWNER, automation.id, [{ path: "inbox/a.pdf", change: "removed" }]),
    ).toBeNull();
    await (
      await svc.filesChanged(OWNER, automation.id, [
        { path: "inbox/a.pdf", change: "added" },
        { path: "inbox/b.pdf", change: "added" },
        { path: "inbox/c.pdf", change: "changed" },
      ])
    )?.done;
    expect(fake.calls[0]?.ctx.payload).toEqual({
      files: [
        { path: "inbox/a.pdf", change: "added" },
        { path: "inbox/b.pdf", change: "added" },
      ],
    });
    expect((await svc.watchingFiles()).map((w) => w.id)).toEqual([automation.id]);
  });

  it("sends the message by email when asked, and previews the next times", async () => {
    const { svc, fake } = await setup();
    const { automation } = await svc.create(
      OWNER,
      "name: mail-me\non: {startup: true}\nnotify: {to: [email, telegram], email: boss@example.com}\ninstructions: x",
    );
    await (await svc.runNow(OWNER, automation.id)).done;
    expect(fake.emails).toEqual([
      {
        subject: "Automation mail-me: done",
        text: "Automation mail-me: done\n\nmail-me via manual",
        to: "boss@example.com",
      },
    ]);
    expect((await svc.runs(OWNER, automation.id))[0]?.delivery).toMatchObject({
      status: "delivered",
      to: ["email boss@example.com", "telegram"],
    });
    const p = await svc.preview(
      OWNER,
      'name: p\non: {cron: "0 9 * * 1-5", timezone: UTC}\ninstructions: x',
      3,
    );
    expect(p.error).toBeNull();
    expect(p.next).toEqual([
      "2026-11-02T09:00:00.000Z",
      "2026-11-03T09:00:00.000Z",
      "2026-11-04T09:00:00.000Z",
    ]);
    expect((await svc.preview(OWNER, "name: p\non: {}\ninstructions: x")).error).toMatch(/on:/);
  });
});
