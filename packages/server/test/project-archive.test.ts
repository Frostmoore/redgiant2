import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Automation, PermissionRequestInfo } from "@redgiant/protocol";
import { type CompletionRequest, FakeProvider, ProviderRegistry } from "@redgiant/providers";
import { HostSandboxProvider, type SandboxProvider } from "@redgiant/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectArchivedError, RedGiantCore } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** The host's sandbox, counting what is made and stopped (a fake container). */
function countingSandbox() {
  const host = new HostSandboxProvider();
  const made: string[] = [];
  const stopped: string[] = [];
  const provider: SandboxProvider = {
    kind: "host",
    async create(spec) {
      made.push(spec.id);
      const sb = await host.create(spec);
      return {
        ...sb,
        destroy: async () => {
          stopped.push(spec.id);
        },
      };
    },
  };
  return { provider, made, stopped };
}

const lastUser = (req: CompletionRequest) => {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};

/** God, a project "Shop" with its orchestrator, and three automations (two of the project). */
async function shop(server: Server) {
  const god = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const project = await server.api<{ id: string }>("POST", "/api/projects", { name: "Shop" });
  const orch = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: god.body.id,
    projectId: project.body.id,
    name: "Shop lead",
  });
  const recipe = (name: string, extra: string[]) =>
    server.api<{ automation: Automation }>("POST", "/api/automations", {
      yaml: [
        `name: ${name}`,
        "on: {cron: '0 8 * * *', timezone: Europe/Rome}",
        ...extra,
        "instructions: Check the shop.",
      ].join("\n"),
    });
  const on = (await recipe("shop-on", ["project: shop", "agent: orchestrator"])).body.automation;
  const off = (await recipe("shop-off", ["project: shop", "agent: orchestrator"])).body.automation;
  await server.api("POST", `/api/automations/${off.id}/enabled`, { enabled: false });
  // Run by the project's agent by name, without `project:`: it belongs to the project too.
  const named = (await recipe("shop-named", ["agent: Shop lead"])).body.automation;
  const global = (await recipe("everyone", ["agent: god"])).body.automation;
  return { god: god.body.id, project: project.body.id, orch: orch.body.id, on, off, named, global };
}

const enabled = async (server: Server) =>
  Object.fromEntries(
    (await server.api<Automation[]>("GET", "/api/automations")).body.map((a) => [
      a.name,
      a.enabled,
    ]),
  );

describe("archiving a whole project (2026-11-09)", () => {
  it("stops the turn running, pauses its automations and sandbox, and restores it as it was", async () => {
    let slow = true;
    const box = countingSandbox();
    s = await startServer(
      (req) => ({ text: slow ? "word ".repeat(400) : `ok: ${lastUser(req)}` }),
      { tick: () => new Promise((ok) => setTimeout(ok, slow ? 20 : 0)) },
      { sandbox: box.provider },
    );
    const server = s;
    const t = await shop(server);
    const before = (await server.api<{ id: string }[]>("GET", "/api/projects")).body.find(
      (p) => p.id === t.project,
    );
    const states = await enabled(server);
    expect(states).toEqual({
      "shop-on": true,
      "shop-off": false,
      "shop-named": true,
      everyone: true,
    });

    const sid = (
      await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: t.orch })
    ).body.sessionId;
    const lead = server.core.registry.get(t.orch);
    if (!lead) throw new Error("no lead");
    const task = await server.core.tasks.open(lead, sid, "Build the shop");
    const turn = await server.core.send("me", sid, "find the unicorn price");
    for (let i = 0; i < 100 && !server.core.isRunning(sid); i++)
      await new Promise((ok) => setTimeout(ok, 10));
    expect(server.core.isRunning(sid)).toBe(true);
    expect(box.made).toContain(`me-${t.project}`);

    // The page asks first: who is working, which automations will pause.
    const work = await server.api<{
      working: { sessionId: string; agentName: string }[];
      automations: { name: string }[];
    }>("GET", `/api/projects/${t.project}/work`);
    expect(work.body.working).toEqual([
      expect.objectContaining({ sessionId: sid, agentName: "Shop lead" }),
    ]);
    expect(work.body.automations.map((a) => a.name).sort()).toEqual(["shop-named", "shop-on"]);

    const archived = await server.api<{ change: string; detail: string; target: string }>(
      "POST",
      `/api/projects/${t.project}/archive`,
    );
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({
      change: "Project shop: archived",
      target: "project:shop",
    });
    expect(archived.body.detail).toMatch(
      /^1 turn\(s\) stopped, 2 automation\(s\) paused, 1 sandbox/,
    );

    // The turn stopped as an interruption would; its task is still open.
    expect((await turn.done).stopReason).toBe("aborted");
    expect(server.core.isRunning(sid)).toBe(false);
    expect(server.core.tasks.get(task.id)?.outcome).toBeUndefined();
    expect(await enabled(server)).toEqual({
      "shop-on": false,
      "shop-off": false,
      "shop-named": false,
      everyone: true,
    });
    expect(box.stopped).toEqual([`me-${t.project}`]);

    // Out of the lists, read only, nothing starts in it.
    const listed = (await server.api<{ id: string; archivedAt?: string }[]>("GET", "/api/projects"))
      .body;
    expect(listed.find((p) => p.id === t.project)?.archivedAt).toEqual(expect.any(String));
    await expect(server.core.send("me", sid, "go on")).rejects.toThrow(ProjectArchivedError);
    await expect(server.core.startSession("me", t.orch)).rejects.toThrow(ProjectArchivedError);
    const write = await server.api<{ code: string }>("PUT", "/api/files/content", {
      scope: `project:${t.project}`,
      path: "notes.txt",
      content: "x",
    });
    expect(write).toMatchObject({ status: 423, body: { code: "project_archived" } });
    expect(
      (await server.api("POST", "/api/files/op", { op: "mkdir", scope: "project:shop", path: "d" }))
        .status,
    ).toBe(423);
    // Reading goes on: the list of files, the conversation from the log, never built again.
    expect((await server.api("GET", "/api/files/list?scope=project:shop")).status).toBe(200);
    const tasks = await server.api<{ id: string; outcome: string; agentName: string }[]>(
      "GET",
      `/api/projects/${t.project}/tasks`,
    );
    expect(tasks.body).toEqual([
      expect.objectContaining({ id: task.id, outcome: "open", agentName: "Shop lead" }),
    ]);
    const history = await server.core.history("me", sid);
    expect(history.some((e) => e.type === "message.user")).toBe(true);
    expect(box.made.filter((id) => id === `me-${t.project}`)).toHaveLength(1);
    // The search leaves it out; the scope rules let nobody act on its agents.
    expect((await server.api<unknown[]>("GET", "/api/search?q=unicorn")).body).toEqual([]);
    expect(server.core.registry.get(t.orch)?.archived).toBe(true);
    expect(
      (
        await server.api("POST", "/api/agents", {
          kind: "agent",
          parentId: t.orch,
          name: "Helper",
        })
      ).status,
    ).toBe(400);

    // The log says what happened.
    const [ev] = await server.core.store.list({ types: ["project.archived"] });
    expect(ev?.payload).toEqual({
      projectId: t.project,
      by: "human",
      interrupted: [sid],
      paused: expect.arrayContaining([t.on.id, t.named.id]),
      sandboxes: [`me-${t.project}`],
    });

    // Restored: exactly as it was.
    slow = false;
    const restored = await server.api<{ change: string }>(
      "POST",
      `/api/projects/${t.project}/restore`,
    );
    expect(restored).toMatchObject({ status: 200, body: { change: "Project shop: restored" } });
    expect(await enabled(server)).toEqual(states);
    const after = (await server.api<{ id: string }[]>("GET", "/api/projects")).body.find(
      (p) => p.id === t.project,
    );
    expect(after).toEqual(before);
    expect(box.made.filter((id) => id === `me-${t.project}`)).toHaveLength(2);
    expect(server.core.registry.get(t.orch)?.archived).toBe(false);
    expect(server.core.tasks.get(task.id)?.outcome).toBeUndefined();
    const again = await server.core.send("me", sid, "go on");
    expect((await again.done).stopReason).toBe("end_turn");
    expect((await server.api<unknown[]>("GET", "/api/search?q=unicorn")).body).not.toEqual([]);
    const [back] = await server.core.store.list({ types: ["project.restored"] });
    expect(back?.payload).toEqual({
      projectId: t.project,
      by: "human",
      resumed: expect.arrayContaining([t.on.id, t.named.id]),
    });
    // Twice is refused, clearly.
    expect((await server.api("POST", `/api/projects/${t.project}/restore`)).status).toBe(400);
  }, 30_000);

  it("lets God archive and restore with the person's yes, undoable like its other changes", async () => {
    type Step = { name: string; input: unknown };
    const steps: Record<string, Step> = {
      archive: { name: "platform_project", input: { action: "archive", project_id: "shop" } },
      changes: { name: "platform_changes", input: {} },
    };
    let undo: Step | undefined;
    s = await startServer((req) => {
      const last = req.messages.at(-1);
      const result =
        last?.role === "user" ? last.parts.find((p) => p.type === "tool_result") : undefined;
      if (result?.type === "tool_result") return { text: result.content };
      const asked = lastUser(req);
      const step = asked === "undo" ? undo : steps[asked];
      return step ? { toolCalls: [step] } : { text: "nothing" };
    });
    const server = s;
    const t = await shop(server);
    const requests: PermissionRequestInfo[] = [];
    let decision: "allow" | "deny" = "deny";
    server.core.approvals.on("request", (owner, info) => {
      requests.push(info);
      server.core.approvals.decide(owner, info.requestId, decision);
    });
    const sid = (
      await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: t.god })
    ).body.sessionId;
    const say = async (text: string) => {
      await (await server.core.send("me", sid, text)).done;
      return (await server.core.history("me", sid)).filter((e) => e.type === "tool.result").at(-1)
        ?.payload as { ok: boolean; output: string } | undefined;
    };
    const archivedAt = async () =>
      (await server.api<{ id: string; archivedAt?: string }[]>("GET", "/api/projects")).body.find(
        (p) => p.id === t.project,
      )?.archivedAt;

    // No: nothing changes.
    expect((await say("archive"))?.ok).toBe(false);
    expect(requests.map((r) => [r.tool, r.danger])).toEqual([["platform_project", ["platform"]]]);
    expect(await archivedAt()).toBeUndefined();

    // Yes: archived, in the history with what it stopped.
    decision = "allow";
    const done = await say("archive");
    expect(done?.ok).toBe(true);
    expect(done?.output).toMatch(/Project shop: archived[\s\S]*2 automation\(s\) paused/);
    expect(await archivedAt()).toEqual(expect.any(String));
    const [ev] = await server.core.store.list({ types: ["project.archived"] });
    expect(ev?.payload).toMatchObject({ by: t.god });

    // Its files are read only for God too: canvas_edit on one of them is refused (the person's
    // yes for a file outside God's folder does not open an archived project).
    const project = await server.core.projects.get("me", t.project);
    await writeFile(join(project?.path ?? "", "notes.md"), "# Notes\n");
    steps.edit = {
      name: "canvas_edit",
      input: {
        path: join(project?.path ?? "", "notes.md"),
        ops: [{ op: "replace_text", find: "Notes", text: "Changed" }],
      },
    };
    const dir = project?.path ?? "";
    steps.write = { name: "write_file", input: { path: join(dir, "new.txt"), content: "x" } };
    steps.change = {
      name: "edit_file",
      input: { path: join(dir, "notes.md"), old_string: "Notes", new_string: "Changed" },
    };
    steps.shell = { name: "bash", input: { command: `cd ${dir} && touch made-by-bash` } };
    // The person's yes is ready (decision "allow"), yet nothing is asked: refused at once.
    const asked = requests.length;
    for (const step of ["edit", "write", "change", "shell"]) {
      const r = await say(step);
      expect(r?.ok, step).toBe(false);
      expect(r?.output, step).toMatch(/The project "Shop" is archived: restore it first/);
    }
    expect(requests.length).toBe(asked);
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("# Notes\n");
    await expect(readFile(join(dir, "new.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(dir, "made-by-bash"), "utf8")).rejects.toThrow();

    // Undone: restored, the automations as they were.
    const change = (await server.core.changes.list("me")).find((c) => c.target === "project:shop");
    undo = { name: "platform_undo", input: { change_id: change?.id } };
    expect((await say("undo"))?.ok).toBe(true);
    expect(await archivedAt()).toBeUndefined();
    expect(await enabled(server)).toMatchObject({ "shop-on": true, "shop-off": false });
    expect((await server.core.changes.get("me", change?.id ?? ""))?.stage).toBe("undone");
    // Restored: the same write goes through again (the guardian's rules as always).
    expect((await say("write"))?.ok).toBe(true);
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("x");
  }, 30_000);

  it("is archived again after a restart: the mark comes from the database", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const t = await shop(s);
    await s.api("POST", `/api/projects/${t.project}/archive`);
    // Another core on the same database, as after a restart.
    const again = await RedGiantCore.create({
      db: s.core.db,
      providers: new ProviderRegistry().register(new FakeProvider(() => ({ text: "ok" }))),
      workspacesDir: join(s.dir, "workspaces"),
      platformDir: join(s.dir, "platform"),
      defaultModel: { provider: "fake", model: "m" },
    });
    try {
      expect(again.registry.get(t.orch)?.archived).toBe(true);
      await expect(again.startSession("me", t.orch)).rejects.toThrow(ProjectArchivedError);
      expect(await again.projects.archivedState("me", t.project)).toEqual({
        paused: expect.arrayContaining([t.on.id, t.named.id]),
      });
      await again.restoreProject("me", t.project, "human");
      expect(again.registry.get(t.orch)?.archived).toBe(false);
      expect((await again.automations.get("me", t.on.id)).enabled).toBe(true);
    } finally {
      await again.close();
    }
  }, 30_000);
});
