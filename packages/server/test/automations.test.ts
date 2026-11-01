import type { Automation, AutomationRun } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const lastUser = (req: CompletionRequest) => {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};

async function withGod() {
  const god = await s?.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  return god?.body.id ?? "";
}

async function waitRun(id: string, pred: (r: AutomationRun) => boolean) {
  for (let i = 0; i < 200; i++) {
    const runs = (await s?.api<AutomationRun[]>("GET", `/api/automations/${id}/runs`))?.body ?? [];
    const r = runs.find(pred);
    if (r) return r;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error("run not finished");
}

describe("automations end to end", () => {
  it("runs a recipe with its own model on an agent and keeps the answer", async () => {
    s = await startServer((req) => ({ text: `Digest: ${lastUser(req)}` }));
    await withGod();
    const created = await s.api<{ automation: Automation }>("POST", "/api/automations", {
      yaml: [
        "name: digest",
        "on: {cron: '0 8 * * *', timezone: Europe/Rome}",
        "model: fake/small",
        "effort: low",
        "instructions: Summarise every project.",
      ].join("\n"),
    });
    expect(created.status).toBe(201);
    const { id } = created.body.automation;
    expect(created.body.automation.nextRunAt).toMatch(/T0[67]:00:00.000Z$/);

    const notes: string[] = [];
    s.core.notify = async (_owner, text) => {
      notes.push(text);
    };
    const ws = await wsClient(s.url);
    await ws.waitFor("welcome");
    expect((await s.api("POST", `/api/automations/${id}/run`)).status).toBe(202);
    const run = await waitRun(id, (r) => r.status === "ok");
    expect(run.summary).toBe("Digest: Summarise every project.");
    expect(notes).toEqual(["Automation digest: done\n\nDigest: Summarise every project."]);
    await ws.waitFor("automations.changed", (m) => m.automationId === id);
    ws.close();

    // The session used the recipe's model and effort; the user can open it like any other.
    const req = s.provider.requests.at(-1);
    expect([req?.model, req?.effort]).toEqual(["small", "low"]);
    const history = await s.core.history("me", run.sessionId ?? "");
    expect(history.some((e) => e.type === "message.user")).toBe(true);
    expect(
      (await s.api<{ id: string }[]>("GET", "/api/automations"))?.body.map((a) => a.id),
    ).toEqual([id]);
  });

  it("starts from a webhook only with the recipe's secret, passing the body as data", async () => {
    s = await startServer((req) => ({ text: lastUser(req) }));
    await withGod();
    const { body } = await s.api<{ automation: Automation; webhookSecret: string }>(
      "POST",
      "/api/automations",
      {
        yaml: "name: on-push\non: {webhook: true}\ninstructions: Review the push.\nnotify: {when: never}",
      },
    );
    const hook = (secret: string | undefined, payload: string) =>
      fetch(`${s?.url}/api/automations/${body.automation.id}/hook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret !== undefined && { "x-redgiant-secret": secret }),
        },
        body: payload,
      });
    expect((await hook(undefined, "{}")).status).toBe(403);
    expect((await hook("rgwh_wrong", "{}")).status).toBe(403);
    expect((await hook(body.webhookSecret, "x".repeat(70_000))).status).toBe(413);
    const ok = await hook(body.webhookSecret, JSON.stringify({ ref: "refs/heads/main" }));
    expect(ok.status).toBe(202);
    const run = await waitRun(body.automation.id, (r) => r.status === "ok");
    expect(run.trigger).toBe("webhook");
    expect(run.summary).toMatch(/^Review the push\.\n\nThis run was started by a webhook/);
    expect(run.summary).toContain('"ref": "refs/heads/main"');
    // The secret never comes back from the API.
    expect(
      JSON.stringify((await s.api("GET", `/api/automations/${body.automation.id}`)).body),
    ).not.toContain(body.webhookSecret);
  });

  it("refuses recipes for agents that do not exist, and other owners' automations", async () => {
    s = await startServer(() => ({ text: "x" }));
    await withGod();
    const bad = await s.api<{ error: string }>("POST", "/api/automations", {
      yaml: "name: a\non: {webhook: true}\ninstructions: x\nagent: Nobody",
    });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toMatch(/Nobody/);
    const noProject = await s.api<{ error: string }>("POST", "/api/automations", {
      yaml: "name: a\non: {webhook: true}\ninstructions: x\nagent: orchestrator",
    });
    expect(noProject.status).toBe(400);
    const syntax = await s.api<{ error: string }>("POST", "/api/automations", {
      yaml: "name: a\non: {cron: 'nope'}\ninstructions: x",
    });
    expect([syntax.status, syntax.body.error]).toEqual([400, expect.stringMatching(/^on: /)]);
    const mine = await s.api<{ automation: Automation }>("POST", "/api/automations", {
      yaml: "name: a\non: {webhook: true}\ninstructions: x",
    });
    const other = await s.api(
      "GET",
      `/api/automations/${mine.body.automation.id}`,
      undefined,
      "other-token-0123456789",
    );
    expect(other.status).toBe(404);
  });
});
