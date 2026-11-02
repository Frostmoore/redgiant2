import { MCP_CATALOG, type PermissionRequestInfo } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const lastResult = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};
const asked = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};

type Steps = Record<string, { name: string; input: unknown }>;

/** God makes the tool call its message names, then reports the result. */
function god(ref: { steps: Steps }) {
  return (req: CompletionRequest) => {
    if (req.system === "Health check.") {
      if (req.model === "broken") throw new Error("model not found");
      return { text: "OK" };
    }
    const r = lastResult(req);
    const step = ref.steps[asked(req)];
    return r === undefined && step ? { toolCalls: [step] } : { text: r ?? "nothing" };
  };
}

async function setup(steps: Steps, decision: "allow" | "deny" = "allow") {
  const ref = { steps };
  s = await startServer(god(ref));
  const g = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const requests: PermissionRequestInfo[] = [];
  s.core.approvals.on("request", (owner, info) => {
    requests.push(info);
    s?.core.approvals.decide(owner, info.requestId, decision);
  });
  const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id }))
    .body.sessionId;
  const say = async (text: string) => {
    await (await (s as Server).core.send("me", sid, text)).done;
    return (await (s as Server).core.history("me", sid))
      .filter((e) => e.type === "tool.result")
      .at(-1)?.payload as { ok: boolean; output: string } | undefined;
  };
  return { godId: g.body.id, requests, say, ref };
}

describe("God on the platform's configuration", () => {
  it("changes its own model after a trial and the human's approval, and undoes it", async () => {
    const { godId, requests, say, ref } = await setup({});
    const steps = {
      upgrade: {
        name: "platform_configure_agent",
        input: { agent_id: godId, model: "fake/bigger", effort: "high" },
      },
      status: { name: "platform_status", input: {} },
    };
    // God's id is known only now: give it its script.
    ref.steps = steps;

    const r = await say("upgrade");
    expect(r?.ok).toBe(true);
    expect(requests.map((q) => [q.tool, q.danger])).toEqual([
      ["platform_configure_agent", ["platform"]],
    ]);
    expect(s?.core.registry.get(godId)?.model).toEqual({
      provider: "fake",
      model: "bigger",
      effort: "high",
    });
    expect((s as Server).provider.requests.some((q) => q.system === "Health check.")).toBe(true);

    // Reading the platform needs no approval.
    expect((await say("status"))?.output).toMatch(/\tgod\tGod\t-\tactive\tfake\/bigger \(high\)\t/);
    expect(requests).toHaveLength(1);

    const [change] = await (s as Server).core.changes.list("me");
    expect(change).toMatchObject({ kind: "config", stage: "promoted", before: { model: null } });
    await (s as Server).core.config.undo("me", "human", change?.id ?? "");
    expect(s?.core.registry.get(godId)?.model).toBeUndefined();
    expect((await (s as Server).core.changes.get("me", change?.id ?? ""))?.stage).toBe("undone");
    const logged = (await (s as Server).core.store.list({})).filter(
      (e) => e.type === "platform.changed",
    );
    expect(logged.map((e) => (e.payload as { stage: string }).stage)).toEqual([
      "promoted",
      "promoted",
      "undone",
    ]);
  });

  it("does not apply a model that cannot answer, nor anything the human denies", async () => {
    const { godId, say, ref } = await setup({}, "allow");
    ref.steps = {
      broken: {
        name: "platform_configure_agent",
        input: { agent_id: godId, model: "fake/broken" },
      },
    };
    const r = await say("broken");
    expect(r).toMatchObject({ ok: false });
    expect(r?.output).toMatch(/did not answer a test request/);
    expect(s?.core.registry.get(godId)?.model).toBeUndefined();
    expect(await (s as Server).core.changes.list("me")).toEqual([]);
  });

  it("keeps the human in charge when God is denied", async () => {
    const { say } = await setup(
      { budget: { name: "platform_set_budget", input: { scope: "global", usd: 5 } } },
      "deny",
    );
    const r = await say("budget");
    expect(r?.ok).toBe(false);
    expect(await (s as Server).core.changes.list("me")).toEqual([]);
  });

  it("sets budgets, automations and the policy, each undoable", async () => {
    const { say } = await setup({
      budget: { name: "platform_set_budget", input: { scope: "global", usd: 5 } },
      automation: {
        name: "platform_automation",
        input: {
          action: "create",
          yaml: "name: nightly\non: {cron: '0 3 * * *'}\ninstructions: Check the projects.",
        },
      },
      policy: {
        name: "platform_policy",
        input: { rules: [{ tool: "bash", match: "\\bnpm\\b", decision: "deny" }] },
      },
    });
    for (const step of ["budget", "automation", "policy"]) expect((await say(step))?.ok).toBe(true);
    const core = (s as Server).core;
    expect((await core.budget.listFor("me", [], []))[0]?.limit).toEqual({ usd: 5 });
    expect((await core.automations.list("me")).map((a) => a.name)).toEqual(["nightly"]);
    const god = core.registry.list({ ownerId: "me" })[0];
    expect(
      core.policies.settingsFor(god as never, false).rules.map((r) => [r.tool, r.decision]),
    ).toEqual([["bash", "deny"]]);

    for (const c of await core.changes.list("me")) await core.config.undo("me", "human", c.id);
    expect((await core.budget.listFor("me", [], []))[0]?.limit).toEqual({});
    expect(await core.automations.list("me")).toEqual([]);
    expect(core.policies.get("me").rules).toEqual([]);
  });

  it("adds catalog servers with the human's approval, never ones that need a key", async () => {
    const oauth = MCP_CATALOG.find((e) => e.auth.type === "oauth");
    const keyed = MCP_CATALOG.find((e) => e.auth.type === "header" || e.auth.type === "env");
    if (!oauth || !keyed) throw new Error("the catalog needs both kinds");
    const { say, requests } = await setup({
      add: { name: "platform_mcp", input: { action: "add", catalog_id: oauth.id } },
      keyed: { name: "platform_mcp", input: { action: "add", catalog_id: keyed.id } },
      remove: { name: "platform_mcp", input: { action: "remove", name: oauth.id } },
    });
    const core = (s as Server).core;
    const added = await say("add");
    expect(added?.ok).toBe(true);
    expect(added?.output).toMatch(/press Connect/);
    expect(requests.map((r) => r.tool)).toEqual(["platform_mcp"]);
    const rows = await core.listMcp("me");
    expect(rows.map((r) => r.name)).toEqual([oauth.id]);
    expect(await core.mcpStatus("me")).toEqual([
      expect.objectContaining({ name: oauth.id, state: "login" }),
    ]);

    const refused = await say("keyed");
    expect(refused?.ok).toBe(false);
    expect(refused?.output).toMatch(/needs a key/);

    // Undoing the addition removes it; undoing the removal brings it back.
    const [change] = await core.changes.list("me");
    await core.config.undo("me", "human", change?.id ?? "");
    expect(await core.listMcp("me")).toEqual([]);
    const [undone] = await core.changes.list("me");
    await core.config.undo("me", "human", undone?.id ?? "");
    expect((await core.listMcp("me")).map((r) => r.name)).toEqual([oauth.id]);
    expect((await say("remove"))?.ok).toBe(true);
    expect(await core.listMcp("me")).toEqual([]);
  });

  it("puts the person's own budget changes in the history, undoable", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const list = await s.api<{ scope: string; limit: object }[]>("GET", "/api/budgets");
    expect(list.body).toEqual([expect.objectContaining({ scope: "global", limit: {} })]);
    expect(
      (await s.api("PUT", "/api/budgets", { scope: "global", id: "me", usd: 50 })).status,
    ).toBe(200);
    const [c] = await s.core.changes.list("me");
    expect(c).toMatchObject({ by: "human", target: "budget:global:me", after: { usd: 50 } });
    await s.core.config.undo("me", "human", c?.id ?? "");
    expect((await s.core.budget.listFor("me", [], []))[0]?.limit).toEqual({});
    expect((await s.api("GET", "/api/budgets/daily?from=nope")).status).toBe(400);
    expect((await s.api("GET", "/api/budgets/daily?from=2026-11-01")).body).toEqual([]);
  });

  it("on metal, every change God makes to its workspace asks the human", async () => {
    s = await startServer(() => ({ text: "x" }), {}, { metal: true });
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const rules = s.core.policies.settingsFor(s.core.registry.get(g.body.id) as never, true).rules;
    expect(rules.map((r) => `${r.tool}:${r.decision}`)).toEqual([
      "bash:ask",
      "write_file:ask",
      "edit_file:ask",
    ]);
  });
});
