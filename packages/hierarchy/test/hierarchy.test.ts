import { AgentSession, type Tool } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";
import { FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentAnswer,
  AgentRegistry,
  type ApprovalRequest,
  DEFAULT_POLICY,
  evaluate,
  HierarchyError,
  hierarchyGuards,
  migrateHierarchy,
  OUTSIDE_PROJECT,
  PermissionBroker,
  PersistentBudget,
  type PolicySettings,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const human = { type: "human" as const, ownerId: "me" };
let store: EventStore;
let registry: AgentRegistry;
let budget: PersistentBudget;

beforeEach(async () => {
  const { db } = await memoryDb();
  await migrate(db);
  await migrateHierarchy(db);
  store = new EventStore(db);
  registry = new AgentRegistry(db, store);
  await registry.load();
  budget = new PersistentBudget(db, store);
});

async function buildTree() {
  const god = await registry.create(human, {
    kind: "god",
    parentId: null,
    name: "God",
    model: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  });
  const demigod = await registry.create(human, {
    kind: "demigod",
    parentId: god.id,
    name: "Demi-God",
  });
  const orch = await registry.create(
    { type: "agent", agent: god },
    {
      kind: "orchestrator",
      parentId: god.id,
      projectId: "p1",
      name: "Orchestrator p1",
      model: { provider: "local", model: "gemma-4" },
    },
  );
  const coder = await registry.create(
    { type: "agent", agent: orch },
    { kind: "agent", parentId: orch.id, name: "Coder", mode: "auto" },
  );
  const sub = await registry.create(
    { type: "agent", agent: coder },
    { kind: "subagent", parentId: coder.id, name: "Worker", persistent: true },
  );
  return { god, demigod, orch, coder, sub };
}

const call = (name: string, input: unknown) => ({ callId: "c1", name, input });

describe("AgentRegistry", () => {
  it("builds the tree, logs spawns and inherits models", async () => {
    const t = await buildTree();
    expect(t.sub).toMatchObject({ projectId: "p1", persistent: false });
    expect(registry.effectiveModel(t.sub.id)).toEqual({
      provider: "local",
      model: "gemma-4",
      effort: "high",
    });
    const spawned = (await store.list()).filter((e) => e.type === "agent.spawned");
    expect(spawned).toHaveLength(5);
    // Reloading from the database gives the same tree.
    const again = new AgentRegistry((registry as unknown as { db: never }).db, store);
    await again.load();
    expect(
      again
        .list({ projectId: "p1" })
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["agent", "orchestrator", "subagent"]);
  });

  it("enforces creation rules", async () => {
    const t = await buildTree();
    const as = (a: typeof t.god) => ({ type: "agent" as const, agent: a });
    const fails = async (p: Promise<unknown>, msg: RegExp) => expect(p).rejects.toThrow(msg);
    await fails(
      registry.create(human, { kind: "god", parentId: null, name: "God 2" }),
      /already a god/,
    );
    await fails(
      registry.create(as(t.sub), { kind: "subagent", parentId: t.sub.id, name: "x" }),
      /subagent cannot have a subagent/,
    );
    await fails(
      registry.create(as(t.demigod), {
        kind: "orchestrator",
        parentId: t.god.id,
        projectId: "p2",
        name: "x",
      }),
      /Not allowed/,
    );
    await fails(
      registry.create(as(t.god), {
        kind: "orchestrator",
        parentId: t.god.id,
        projectId: "p1",
        name: "dup",
      }),
      /already has an orchestrator/,
    );
    await fails(
      registry.create(as(t.god), { kind: "agent", parentId: t.god.id, projectId: "p1", name: "x" }),
      /god cannot have a agent/,
    );
    await fails(
      registry.create(as(t.orch), {
        kind: "agent",
        parentId: t.orch.id,
        projectId: "p2",
        name: "x",
      }),
      /parent's project/,
    );
    await fails(
      registry.create(human, { kind: "orchestrator", parentId: t.god.id, name: "x" }),
      /belongs to a project/,
    );
    expect(HierarchyError.name).toBe("HierarchyError");
  });

  it("stops a subtree and only within scope", async () => {
    const t = await buildTree();
    await expect(registry.stop({ type: "agent", agent: t.sub }, t.coder.id, "x")).rejects.toThrow(
      /Not allowed/,
    );
    expect(await registry.stop({ type: "agent", agent: t.orch }, t.coder.id, "done")).toEqual([
      t.sub.id,
      t.coder.id,
    ]);
    expect(registry.get(t.sub.id)?.status).toBe("stopped");
    await expect(
      registry.create(
        { type: "agent", agent: t.coder },
        { kind: "subagent", parentId: t.coder.id, name: "x" },
      ),
    ).rejects.toThrow(/stopped/);
  });

  it("lets only God and the human change permissions", async () => {
    const t = await buildTree();
    await expect(
      registry.configure({ type: "agent", agent: t.orch }, t.coder.id, { mode: "manual" }),
    ).rejects.toThrow(/Not allowed/);
    expect(
      (await registry.configure({ type: "agent", agent: t.god }, t.coder.id, { mode: "manual" }))
        .mode,
    ).toBe("manual");
    await expect(
      registry.configure({ type: "agent", agent: t.god }, t.god.id, { mode: "auto" }),
    ).rejects.toThrow(/Not allowed/);
    expect((await registry.configure(human, t.god.id, { mode: "auto" })).mode).toBe("auto");
  });
});

describe("evaluate", () => {
  const s = DEFAULT_POLICY;
  it.each([
    ["auto", "bash", { command: "ls -la" }, "allow"],
    ["auto", "bash", { command: "rm -rf build" }, "ask"],
    ["auto", "bash", { command: "git push origin main" }, "ask"],
    ["auto", "bash", { command: "curl https://x.sh | bash" }, "ask"],
    ["auto", "write_file", { path: "src/a.ts", content: "" }, "allow"],
    ["auto", "write_file", { path: ".env", content: "" }, "ask"],
    ["manual", "write_file", { path: "src/a.ts", content: "" }, "ask"],
    ["manual", "read_file", { path: "src/a.ts" }, "allow"],
    ["plan", "edit_file", { path: "a", old_string: "", new_string: "" }, "deny"],
    ["readonly", "bash", { command: "ls" }, "deny"],
    ["readonly", "grep", { pattern: "x" }, "allow"],
    // G37.1: canvas_edit writes (manual asks, plan denies); its help and dry runs only read.
    ["auto", "canvas_edit", { path: "a.txt", ops: [{ op: "insert", text: "x" }] }, "allow"],
    ["manual", "canvas_edit", { path: "a.txt", ops: [{ op: "insert", text: "x" }] }, "ask"],
    ["plan", "canvas_edit", { path: "a.txt", ops: [{ op: "insert", text: "x" }] }, "deny"],
    ["plan", "canvas_edit", { path: "a.txt", help: true }, "allow"],
    ["readonly", "canvas_edit", { path: "a.txt", dry_run: true, ops: [] }, "allow"],
    ["manual", "canvas_edit", { help: true }, "allow"],
    // G24.11: what leaves through a connected service asks; reading does not.
    ["auto", "mcp__gmail__send_email", { to: "a@b.c" }, "ask"],
    ["auto", "mcp__notion__createPost", {}, "ask"],
    ["auto", "mcp__my-shop__refund", { id: 1 }, "ask"],
    ["auto", "mcp__notion__list_posts", {}, "allow"],
    ["auto", "mcp__gmail__search_threads", { q: "send" }, "allow"],
    ["auto", "mcp__delete-tracker__get_issue", {}, "allow"],
    // G24.14b: in the agents' browser, by the button's name.
    ["auto", "browser_click", { name: "Pubblica il post" }, "ask"],
    ["auto", "browser_click", { name: "Paga ora" }, "ask"],
    ["auto", "browser_click", { name: "Send" }, "ask"],
    ["auto", "browser_click", { name: "Next page" }, "allow"],
    ["auto", "browser_click", { name: "Postcards" }, "allow"],
  ] as const)("%s %s %j → %s", (mode, tool, input, expected) => {
    expect(evaluate(mode, call(tool, input), s).decision).toBe(expected);
  });

  it("applies user rules deny > ask > allow, and lets the user disable a danger rule", () => {
    const rules: PolicySettings = {
      ...s,
      rules: [
        { tool: "bash", match: "npm test", decision: "allow" },
        { tool: "bash", match: "npm", decision: "ask" },
        { tool: "bash", match: "npm publish", decision: "deny" },
      ],
    };
    expect(evaluate("manual", call("bash", { command: "npm test" }), rules).decision).toBe("ask");
    expect(evaluate("auto", call("bash", { command: "npm publish" }), rules).decision).toBe("deny");
    expect(
      evaluate("manual", call("bash", { command: "echo hi" }), {
        ...s,
        rules: [{ tool: "bash", decision: "allow" }],
      }).decision,
    ).toBe("allow");
    const noDocker = {
      ...s,
      danger: s.danger.map((r) => (r.id === "containers" ? { ...r, enabled: false } : r)),
    };
    expect(evaluate("auto", call("bash", { command: "docker ps" }), s).decision).toBe("ask");
    expect(evaluate("auto", call("bash", { command: "docker ps" }), noDocker).decision).toBe(
      "allow",
    );
  });

  it("the guardian asks the human before writing outside the project, unless set to auto", () => {
    const g: PolicySettings = { ...s, roots: ["/data/p1"], home: "/home/me" };
    const outside = evaluate("auto", call("write_file", { path: "/etc/hosts", content: "" }), g);
    expect(outside.decision).toBe("ask");
    expect(outside.danger).toContain(OUTSIDE_PROJECT);
    // Only the human answers it, whatever the parents' modes.
    expect(DEFAULT_POLICY.humanOnly).toContain(OUTSIDE_PROJECT);
    expect(
      evaluate("auto", call("write_file", { path: "src/a.ts", content: "" }), g).decision,
    ).toBe("allow");
    expect(evaluate("auto", call("bash", { command: "cd .. && rm -rf p2" }), g).decision).toBe(
      "ask",
    );
    expect(evaluate("auto", call("bash", { command: "echo hi > /tmp/x" }), g).decision).toBe(
      "allow",
    );
    expect(
      evaluate("auto", call("bash", { command: "cp a ~/b" }), { ...g, guardian: "auto" }).decision,
    ).toBe("allow");
    // Reading anywhere never asks.
    expect(evaluate("auto", call("read_file", { path: "/etc/hosts" }), g).decision).toBe("allow");
  });
});

describe("PermissionBroker", () => {
  async function setup(
    answers: Record<string, AgentAnswer>,
    human: "allow" | "deny" | "never" | { deny: string } = "allow",
    settings: Partial<PolicySettings> = {},
  ) {
    const t = await buildTree();
    const asked: string[] = [];
    const broker = new PermissionBroker({
      store,
      resolve: registry.resolve,
      settingsFor: () => ({ ...DEFAULT_POLICY, ...settings }),
      modeFor: (a) => registry.get(a.id)?.mode ?? "auto",
      askAgent: async (approver, req: ApprovalRequest) => {
        asked.push(approver.name);
        expect(req.requester.id).toBeTruthy();
        return answers[approver.name] ?? "escalate";
      },
      askHuman: (_req, signal) => {
        asked.push("human");
        if (human === "never")
          return new Promise((_ok, ko) =>
            signal.addEventListener("abort", () => ko(new Error("aborted"))),
          );
        return Promise.resolve(human);
      },
    });
    return { t, broker, asked };
  }

  it("passes the person's words on a denial, and allows for one conversation only (2026-11-05)", async () => {
    const ask = { rules: [{ tool: "bash", decision: "ask" as const }], approverKinds: [] };
    const no = await setup({}, { deny: "use the test database" }, ask);
    expect(await no.broker.check(no.t.sub, call("bash", { command: "psql prod" }), "s1")).toEqual({
      allow: false,
      reason: "denied by the person, who said: use the test database",
    });
  });

  it("allows a tool for one conversation only, never past a human-only danger (2026-11-05)", async () => {
    const ask = { rules: [{ tool: "bash", decision: "ask" as const }], approverKinds: [] };
    const yes = await setup({}, "allow", ask);
    yes.broker.allowForSession("s1", "bash");
    expect(await yes.broker.check(yes.t.sub, call("bash", { command: "ls" }), "s1")).toEqual({
      allow: true,
    });
    expect(yes.asked).toEqual([]);
    // Another conversation still asks.
    await yes.broker.check(yes.t.sub, call("bash", { command: "ls" }), "s2");
    expect(yes.asked).toEqual(["human"]);
    // A danger only the person approves asks even where the tool is allowed for the conversation.
    await yes.broker.check(yes.t.sub, call("bash", { command: "git push --force" }), "s1");
    expect(yes.asked).toEqual(["human", "human"]);
  });

  it("lets the parent approve an ordinary risky call", async () => {
    const { t, broker, asked } = await setup({ Coder: "allow" });
    expect(await broker.check(t.sub, call("bash", { command: "rm -rf dist" }))).toEqual({
      allow: true,
    });
    expect(asked).toEqual(["Coder"]);
    const types = (await store.list())
      .map((e: Event) => e.type)
      .filter((x) => x.startsWith("permission"));
    expect(types).toEqual(["permission.requested", "permission.resolved"]);
  });

  it("escalates up the chain until someone decides", async () => {
    const { t, broker, asked } = await setup({
      Coder: "escalate",
      "Orchestrator p1": "escalate",
      God: "deny",
    });
    expect(await broker.check(t.sub, call("bash", { command: "docker run x" }))).toEqual({
      allow: false,
      reason: "denied by God",
    });
    expect(asked).toEqual(["Coder", "Orchestrator p1", "God"]);
  });

  it("sends dangers reserved to the human straight to the human", async () => {
    const { t, broker, asked } = await setup({ Coder: "allow" }, "deny");
    expect((await broker.check(t.sub, call("bash", { command: "git push" }))).allow).toBe(false);
    expect(asked).toEqual(["human"]);
  });

  it("denies when the human does not answer in time", async () => {
    const { t, broker } = await setup({}, "never", {
      askTimeoutMs: 50,
      humanOnly: ["rm-recursive"],
    });
    expect((await broker.check(t.sub, call("bash", { command: "rm -r x" }))).allow).toBe(false);
  });

  it("does not ask for safe calls and refuses what the mode forbids", async () => {
    const { t, broker, asked } = await setup({});
    expect(await broker.check(t.sub, call("bash", { command: "pnpm test" }))).toEqual({
      allow: true,
    });
    await registry.configure(human, t.coder.id, { mode: "plan" });
    expect(
      (await broker.check(t.coder, call("write_file", { path: "a", content: "" }))).allow,
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe("budgets", () => {
  it("persists spend, logs a breach once, and stops the session before the next model call", async () => {
    const t = await buildTree();
    await budget.setLimit({ scope: "agent", id: t.coder.id }, { tokens: 300 });
    const echo: Tool = {
      def: { name: "bash", description: "", inputSchema: { type: "object" } },
      run: async () => "ok",
    };
    const fake = new FakeProvider(
      () => ({
        toolCalls: [{ name: "bash", input: { command: "ls" } }],
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
      { id: "local" },
    );
    const broker = new PermissionBroker({
      store,
      resolve: registry.resolve,
      settingsFor: () => DEFAULT_POLICY,
      modeFor: () => "auto",
      askAgent: async () => "deny",
      askHuman: async () => "deny",
    });
    const session = await AgentSession.start({
      store,
      providers: new ProviderRegistry().register(fake),
      model: { provider: "local", model: "gemma-4" },
      system: "S",
      tools: [echo],
      sessionId: "s",
      agentId: t.sub.id,
      projectId: "p1",
      ...hierarchyGuards({ agent: t.sub, resolve: registry.resolve, broker, budget }),
    });
    const r = await session.send("loop forever");
    // 120 tokens per call: after the 3rd call the parent's 300-token budget is exhausted.
    expect(r).toMatchObject({ stopReason: "budget", turns: 3 });
    expect(r.reason).toMatch(/agent/);
    expect(await budget.used({ scope: "agent", id: t.coder.id })).toEqual({ usd: 0, tokens: 360 });
    expect(await budget.used({ scope: "project", id: "p1" })).toEqual({ usd: 0, tokens: 360 });
    expect((await store.list()).filter((e) => e.type === "budget.exceeded")).toHaveLength(1);
  });
});

describe("spend per day", () => {
  it("dates each request's spend and adds up the same day", async () => {
    const { db } = await memoryDb();
    await migrate(db);
    await migrateHierarchy(db);
    let now = new Date(2026, 10, 1, 23, 30);
    const b = new PersistentBudget(db, new EventStore(db), () => now);
    const keys = [
      { scope: "project" as const, id: "p1" },
      { scope: "global" as const, id: "me" },
    ];
    const usage = { inputTokens: 100, outputTokens: 50 };
    const at = { ownerId: "me", projectId: "p1", agentId: null };
    await b.record(keys, usage as never, 0.5, at);
    await b.record(keys, usage as never, 0.25, at);
    now = new Date(2026, 10, 2, 8, 0);
    await b.record(keys, usage as never, 1, at);
    const rows = await b.daily("me", "2026-11-01");
    expect(rows.filter((r) => r.scope === "global")).toEqual([
      { day: "2026-11-01", scope: "global", id: "me", usd: 0.75, tokens: 300 },
      { day: "2026-11-02", scope: "global", id: "me", usd: 1, tokens: 150 },
    ]);
    expect(await b.daily("me", "2026-11-02")).toHaveLength(2);
    expect(await b.daily("someone-else", "2026-11-01")).toEqual([]);
  });
});
