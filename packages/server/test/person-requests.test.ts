// Requests to the person (G36.17) and the commands' limits as configuration (G36.16). The person's
// time runs on a fake clock; the classifier is scripted (or a FakeProvider behind the real one).
// An approval nobody answers is a no; only the classifier's explicit yes allows, never on a danger
// only the person approves (blocked, in the review list), and a classifier that fails is a no.
import { EventStore, migrate } from "@redgiant/events";
import {
  type AgentRecord,
  AgentRegistry,
  type ApprovalRequest,
  allows,
  migrateHierarchy,
  PersistentBudget,
} from "@redgiant/hierarchy";
import {
  DEFAULT_REQUEST_SETTINGS,
  type Event,
  PLAN_APPROVE,
  type QuestionRequestInfo,
  RequestSettings,
  type UnattendedDecision,
} from "@redgiant/protocol";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { HumanApprovals } from "../src/approvals.js";
import type { PlatformChange } from "../src/index.js";
import {
  type Classifier,
  type ClassifyRequest,
  modelClassifier,
  OwnerSettings,
  PersonRequests,
} from "../src/person-requests.js";
import { migratePlatform } from "../src/platform.js";
import { HumanQuestions } from "../src/questions.js";
import { startServer } from "./helpers.js";
import { memoryDb } from "./pglite.js";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; on: boolean }[] = [];
  return {
    timer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, on: true };
      timers.push(t);
      return () => {
        t.on = false;
      };
    },
    tick(ms: number) {
      now += ms;
      for (const t of timers)
        if (t.on && t.at <= now) {
          t.on = false;
          t.fn();
        }
    },
    pending: () => timers.filter((t) => t.on).length,
  };
}

const AGENT: AgentRecord = {
  id: "ag_1",
  name: "Builder",
  kind: "agent",
  parentId: null,
  projectId: null,
  ownerId: "me",
  status: "active",
} as AgentRecord;

const request = (danger: string[] = []): ApprovalRequest => ({
  requestId: `req_${Math.random().toString(36).slice(2)}`,
  requester: AGENT,
  call: { callId: "c1", name: "bash", input: { command: "npm install" } },
  reasons: ["runs a command"],
  danger,
  sessionId: "ses_1",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function rig(settings: Partial<RequestSettings>, classify?: Classifier) {
  const { db } = await memoryDb();
  await migrate(db);
  await migratePlatform(db);
  const { migratePersonRequests } = await import("../src/person-requests.js");
  await migratePersonRequests(db);
  const store = new EventStore(db);
  const approvals = new HumanApprovals();
  const questions = new HumanQuestions();
  const stored = new OwnerSettings(db, "requests", RequestSettings, DEFAULT_REQUEST_SETTINGS);
  await stored.set("me", settings);
  const clock = fakeClock();
  const asked: ClassifyRequest[] = [];
  const reviews: UnattendedDecision[] = [];
  const person = new PersonRequests({
    db,
    store,
    approvals,
    questions,
    settings: stored,
    classify: async (r) => {
      asked.push(r);
      if (!classify) throw new Error("no classifier in this test");
      return classify(r);
    },
    defaultModel: () => ({ provider: "fake", model: "light" }),
    language: () => "it",
    onReview: (_o, d) => reviews.push(d),
    timer: clock.timer,
  });
  const shown: string[] = [];
  approvals.on("request", (_o, info) => shown.push(info.requestId));
  questions.on("request", (_o, info) => shown.push(info.requestId));
  return { db, store, approvals, questions, person, clock, asked, reviews, shown };
}

const approve = (r: Awaited<ReturnType<typeof rig>>, req: ApprovalRequest, humanOnly = false) =>
  r.person.approve(req, new AbortController().signal, {
    kind: "approval",
    humanOnly,
    what: "bash: npm install",
  });

const question = (): QuestionRequestInfo => ({
  requestId: `q_${Math.random().toString(36).slice(2)}`,
  sessionId: "ses_1",
  agentId: AGENT.id,
  agentName: AGENT.name,
  projectId: null,
  questions: [
    {
      question: "Which database?",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
      multiSelect: false,
    },
  ],
  createdAt: new Date().toISOString(),
});

describe("requests to the person (G36.17)", () => {
  it("validates the settings: a time between a minute and a week, a channel unless the classifier", () => {
    expect(RequestSettings.safeParse({ timeoutMs: 1000 }).success).toBe(false);
    expect(RequestSettings.safeParse({ timeoutMs: 15 * 60_000 }).success).toBe(true);
    expect(RequestSettings.safeParse({ timeoutMs: null }).success).toBe(true);
    expect(RequestSettings.safeParse({ channels: { web: false, chats: false } }).success).toBe(
      false,
    );
    expect(
      RequestSettings.safeParse({ mode: "classifier", channels: { web: false, chats: false } })
        .success,
    ).toBe(true);
  });

  it("the person answers in time: their answer, nothing recorded", async () => {
    const r = await rig({ timeoutMs: 5 * 60_000 });
    const req = request();
    const answer = approve(r, req);
    await flush();
    expect(r.shown).toEqual([req.requestId]);
    r.approvals.decide("me", req.requestId, "allow");
    expect(await answer).toBe("allow");
    expect(r.clock.pending()).toBe(0);
    expect(await r.person.list("me")).toEqual([]);
  });

  it("an approval nobody answers in time is a no, recorded with why", async () => {
    const r = await rig({ timeoutMs: 15 * 60_000 }, async () => ({
      decision: "allow",
      reason: "never asked",
      model: "fake/light",
    }));
    const answer = approve(r, request());
    await flush();
    r.clock.tick(15 * 60_000 - 1);
    await flush();
    expect(r.approvals.list("me")).toHaveLength(1);
    r.clock.tick(1);
    const a = await answer;
    expect(allows(a)).toBe(false);
    expect(a).toMatchObject({ decision: "deny", by: "timeout" });
    expect(r.asked).toHaveLength(0);
    expect(r.approvals.list("me")).toHaveLength(0);
    const [d] = await r.person.list("me");
    expect(d).toMatchObject({ decision: "deny", by: "timeout", review: false, kind: "approval" });
    expect(d?.reason).toBe("Nessuna risposta entro 15 minuti. È un no.");
    const events = await r.store.list({ sessionId: "ses_1" });
    expect(events.map((e) => e.type)).toContain("request.unattended");
  });

  it("after the time, the classifier decides when the person chose so", async () => {
    const r = await rig({ timeoutMs: 5 * 60_000, afterTimeout: "classifier" }, async () => ({
      decision: "allow",
      reason: "Installa le dipendenze del progetto: serve al lavoro.",
      model: "fake/light",
    }));
    const answer = approve(r, request());
    await flush();
    r.clock.tick(5 * 60_000);
    const a = await answer;
    expect(allows(a)).toBe(true);
    expect(r.asked[0]).toMatchObject({ kind: "approval", language: "it", sessionId: "ses_1" });
    expect(r.asked[0]?.detail).toContain("npm install");
    const [d] = await r.person.list("me");
    expect(d).toMatchObject({ decision: "allow", by: "classifier", model: "fake/light" });
    expect(d?.reason).toMatch(/^Nessuna risposta entro 5 minuti\. Installa/);
  });

  it("'don't ask me anything': nothing reaches the person, the classifier decides with its reason", async () => {
    const r = await rig({ mode: "classifier" }, async (q) => ({
      decision: q.detail.includes("rm -rf") ? "deny" : "allow",
      reason: q.detail.includes("rm -rf") ? "Cancella troppo." : "Va bene.",
      model: "fake/light",
    }));
    expect(r.person.reaches("me", "web")).toBe(false);
    expect(r.person.reaches("me", "chats")).toBe(false);
    expect(allows(await approve(r, request()))).toBe(true);
    const risky = request();
    risky.call = { ...risky.call, input: { command: "rm -rf build" } };
    const no = await approve(r, risky);
    expect(no).toEqual({ decision: "deny", by: "classifier", reason: "Cancella troppo." });
    expect(r.shown).toEqual([]);
    expect((await r.person.list("me")).map((d) => d.decision)).toEqual(["deny", "allow"]);
  });

  it("never approves a danger only the person approves: blocked, for review, the classifier not asked", async () => {
    const r = await rig({ mode: "classifier" }, async () => ({
      decision: "allow",
      reason: "would say yes",
      model: "fake/light",
    }));
    const a = await approve(r, request(["git-push"]), true);
    expect(allows(a)).toBe(false);
    expect(r.asked).toHaveLength(0);
    const review = await r.person.list("me", { review: true });
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ decision: "blocked", review: true, danger: ["git-push"] });
    expect(r.reviews).toHaveLength(1);
    // Seen: it leaves the review list and stays in the history.
    expect(await r.person.reviewed("me", review[0]?.id as string)).toBe(true);
    expect(await r.person.reviewed("someone-else", review[0]?.id as string)).toBe(false);
    expect(await r.person.list("me", { review: true })).toEqual([]);
    expect((await r.person.list("me"))[0]?.reviewedAt).not.toBeNull();
  });

  it("a classifier that fails is a no", async () => {
    const r = await rig({ mode: "classifier" }, async () => {
      throw new Error("model down");
    });
    const a = await approve(r, request());
    expect(allows(a)).toBe(false);
    expect((await r.person.list("me"))[0]?.reason).toContain("model down");
  });

  it("chooses the channels: the page, the chats, or both", async () => {
    const r = await rig({ channels: { web: false, chats: true } });
    expect(r.person.reaches("me", "web")).toBe(false);
    expect(r.person.reaches("me", "chats")).toBe(true);
  });

  it("questions: answered by the classifier among the options, or the agent's best guess", async () => {
    const r = await rig({ mode: "classifier" }, async () => ({
      answers: [["SQLite"]],
      reason: "Un solo file basta per una prova.",
      model: "fake/light",
    }));
    const out = await r.person.ask(AGENT, question(), undefined, "question");
    expect(out).toEqual({
      by: "classifier",
      answers: [["SQLite"]],
      reason: "Un solo file basta per una prova.",
    });
    expect(r.asked[0]?.questions?.[0]?.question).toBe("Which database?");

    const bad = await rig({ mode: "classifier" }, async () => ({
      answers: [["MongoDB"]],
      reason: "not an option",
      model: "fake/light",
    }));
    expect((await bad.person.ask(AGENT, question(), undefined, "question")).by).toBe("timeout");

    const late = await rig({ timeoutMs: 60_000 });
    const asked = late.person.ask(AGENT, question(), undefined, "question");
    await flush();
    late.clock.tick(60_000);
    expect(await asked).toMatchObject({ by: "timeout" });
    expect((await late.person.list("me"))[0]).toMatchObject({ kind: "question", by: "timeout" });
  });

  it("plans: the classifier approves or not; an unanswered plan stays a plan", async () => {
    const r = await rig({ mode: "classifier" }, async () => ({
      decision: "allow",
      reason: "Il piano fa ciò che è stato chiesto.",
      model: "fake/light",
    }));
    const plan = { ...question(), plan: "1. Write the tests\n2. Fix the bug" };
    expect(await r.person.ask(AGENT, plan, undefined, "plan")).toMatchObject({
      by: "classifier",
      answers: [[PLAN_APPROVE]],
    });
    expect(r.asked[0]?.plan).toContain("Write the tests");
  });

  it("the model's classifier reads the conversation and decides in JSON, charged to the agent", async () => {
    const { db } = await memoryDb();
    await migrate(db);
    await migrateHierarchy(db);
    const store = new EventStore(db);
    const registry = new AgentRegistry(db);
    const budget = new PersistentBudget(db);
    const provider = new FakeProvider([
      { text: 'Ecco: {"decision": "deny", "reason": "Non serve al compito."}' },
      { text: "ALLOW" },
    ]);
    await store.append({
      ownerId: "me",
      sessionId: "ses_1",
      body: { type: "message.user", payload: { text: "Fix the login page, nothing else" } },
    });
    const classify = modelClassifier({
      providers: new ProviderRegistry().register(provider),
      budget,
      registry,
      store,
    });
    const base: ClassifyRequest = {
      ownerId: "me",
      kind: "approval",
      agent: AGENT,
      sessionId: "ses_1",
      what: "bash: npm publish",
      detail: "Tool: bash",
      model: { provider: "fake", model: "light" },
      language: "it",
    };
    expect(await classify(base)).toEqual({
      decision: "deny",
      reason: "Non serve al compito.",
      model: "fake/light",
    });
    const sent = JSON.stringify(provider.requests[0]?.messages);
    expect(sent).toContain("Fix the login page");
    expect(sent).toContain("in Italian");
    expect(provider.requests[0]?.tools).toEqual([]);
    // Not JSON: it throws, and the caller turns that into a no.
    await expect(classify(base)).rejects.toThrow();
    await expect(classify({ ...base, model: undefined })).rejects.toThrow(/no model/);
  });
});

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("settings as configuration (G36.16, G36.17)", () => {
  it("saves the commands' limits validated, with history and undo, and the manager uses them", async () => {
    s = await startServer([{ text: "ok" }]);
    const got = await s.api<{ settings: { maxPerSession: number | null } }>(
      "GET",
      "/api/settings/commands",
    );
    expect(got.body.settings).toMatchObject({ maxPerSession: 4, maxLogBytes: 8 * 1024 * 1024 });
    expect((await s.api("PUT", "/api/settings/commands", { maxPerSession: 0 })).status).toBe(400);
    expect((await s.api("PUT", "/api/settings/commands", { bashMaxMs: 999 })).status).toBe(400);
    const put = await s.api<PlatformChange>("PUT", "/api/settings/commands", {
      maxPerSession: null,
      maxMs: null,
      maxLogBytes: 64 * 1024 * 1024,
      bashMaxMs: 30 * 60_000,
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ target: "settings:commands", stage: "promoted" });
    expect(put.body.before).toMatchObject({ maxPerSession: 4 });
    expect(s.core.commands.limitsFor("me")).toEqual({
      maxPerSession: null,
      maxMs: null,
      maxBytes: 64 * 1024 * 1024,
    });
    expect(s.core.commands.limitsFor("someone-else").maxPerSession).toBe(4);
    const undo = await s.api("POST", `/api/platform/changes/${put.body.id}/undo`);
    expect(undo.status).toBe(200);
    expect(s.core.commands.limitsFor("me").maxPerSession).toBe(4);
  });

  it("God cannot change them; the requests' settings come with the default model and the person's dangers", async () => {
    s = await startServer([{ text: "ok" }]);
    await expect(
      s.core.config.setPersonSettings("me", "god", "requests", { mode: "classifier" }),
    ).rejects.toThrow(/Only the person/);
    const put = await s.api<PlatformChange>("PUT", "/api/settings/requests", {
      mode: "classifier",
    });
    expect(put.status).toBe(200);
    const got = await s.api<{
      settings: RequestSettings;
      defaultModel: unknown;
      humanOnly: string[];
    }>("GET", "/api/settings/requests");
    expect(got.body.settings.mode).toBe("classifier");
    expect(got.body.defaultModel).toEqual({ provider: "fake", model: "m" });
    expect(got.body.humanOnly).toEqual(expect.arrayContaining(["outside-project", "platform"]));
    expect(s.core.requestsReach("me", "web")).toBe(false);
  });

  it("through the broker: the classifier allows a command, blocks a push for review", async () => {
    const decided: string[] = [];
    s = await startServer(
      (req) => {
        const last = req.messages.at(-1);
        if (last?.parts.some((p) => p.type === "tool_result")) return { text: "done" };
        const said = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        return {
          toolCalls: [
            {
              name: "bash",
              input: { command: said?.includes("push") ? "git push --force" : "echo hi" },
            },
          ],
        };
      },
      {},
      {
        classify: async (r) => {
          decided.push(r.what);
          return { decision: "allow", reason: "Serve al lavoro.", model: "fake/light" };
        },
      },
    );
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
        mode: "manual",
      })
    ).body.id;
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god })).body
      .sessionId;
    await s.api("PUT", "/api/settings/requests", { mode: "classifier" });
    const shown: string[] = [];
    s.core.approvals.on("request", (_o, info) => shown.push(info.tool));
    await (await s.core.send("me", sid, "say hi")).done;
    await (await s.core.send("me", sid, "now push")).done;
    expect(shown).toEqual([]);
    expect(decided).toHaveLength(1);
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    const resolved = events.flatMap((e) =>
      e.type === "permission.resolved" ? [e.payload.decision] : [],
    );
    expect(resolved).toEqual(["allow", "deny"]);
    const results = events.flatMap((e) => (e.type === "tool.result" ? [e.payload.output] : []));
    expect(String(results.at(-1))).toContain("classifier");
    const review = await s.api<UnattendedDecision[]>("GET", "/api/unattended?review=1");
    expect(review.body).toHaveLength(1);
    expect(review.body[0]?.danger).toContain("git-push");
    const all = await s.api<UnattendedDecision[]>("GET", "/api/unattended");
    expect(all.body.map((d) => d.decision)).toEqual(["blocked", "allow"]);
    const seen = await s.api("POST", `/api/unattended/${review.body[0]?.id}/reviewed`);
    expect(seen.status).toBe(200);
    expect((await s.api<unknown[]>("GET", "/api/unattended?review=1")).body).toEqual([]);
  });

  it("ask_user in 'don't ask me anything': the classifier answers and the agent is told", async () => {
    s = await startServer(
      [
        {
          toolCalls: [
            {
              name: "ask_user",
              input: {
                questions: [
                  {
                    question: "Which database?",
                    options: [{ label: "Postgres" }, { label: "SQLite" }],
                  },
                ],
              },
            },
          ],
        },
        { text: "Ok." },
      ],
      {},
      {
        classify: async () => ({
          answers: [["SQLite"]],
          reason: "Basta un file.",
          model: "fake/light",
        }),
      },
    );
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      })
    ).body.id;
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god })).body
      .sessionId;
    await s.api("PUT", "/api/settings/requests", { mode: "classifier" });
    await (await s.core.send("me", sid, "start")).done;
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    const answered = events.find((e) => e.type === "question.answered");
    expect(answered?.payload).toMatchObject({ answers: [["SQLite"]], by: "classifier" });
    const out = events.flatMap((e) => (e.type === "tool.result" ? [e.payload.output] : []));
    expect(String(out[0])).toContain("classifier answered for them");
    expect(String(out[0])).toContain("-> SQLite");
  });
});
