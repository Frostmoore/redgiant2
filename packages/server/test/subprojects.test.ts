import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CompletionRequest } from "@redgiant/providers";
import { shellKind } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

const execFileP = promisify(execFile);

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const asked = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};
const lastResult = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};

type Steps = Record<string, { name: string; input: unknown }>;

describe("subprojects (G24.13)", () => {
  it("fences an agent in its folder, guards the shared parts, lets the inspector read it all", async () => {
    const steps: Steps = {};
    const results: string[] = [];
    let system = "";
    s = await startServer((req) => {
      const r = lastResult(req);
      if (r !== undefined) {
        results.push(r);
        return { text: "done" };
      }
      const step = steps[asked(req)];
      if (step) {
        system = req.system ?? "";
        return { toolCalls: [step] };
      }
      return { text: "ok" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const p = await s.api<{ id: string; path: string }>("POST", "/api/projects", {
      name: "Microapps",
    });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: p.body.id,
      name: "Lead",
    });
    const shop = await s.api<{ id: string; dir: string }>(
      "POST",
      `/api/projects/${p.body.id}/subprojects`,
      { name: "Shop", dir: "apps/shop" },
    );
    expect(shop.status).toBe(201);
    expect(shop.body.dir).toBe("apps/shop");
    const blog = await s.api<{ id: string }>("POST", `/api/projects/${p.body.id}/subprojects`, {
      name: "Blog",
      dir: "apps/blog",
    });
    expect(blog.status).toBe(201);
    for (const dir of ["apps/shop/inner", "../out", "apps"])
      expect(
        (await s.api("POST", `/api/projects/${p.body.id}/subprojects`, { name: "X", dir })).status,
      ).toBe(400);
    const project = await s.core.projects.get("me", p.body.id);
    const root = project?.path ?? "";
    await mkdir(join(root, "shared"), { recursive: true });
    await writeFile(join(root, "shared/theme.css"), "body{}");
    await writeFile(join(root, "apps/blog/post.md"), "draft");

    const agent = await s.api<{ id: string; subprojectId: string }>("POST", "/api/agents", {
      kind: "agent",
      parentId: orch.body.id,
      projectId: p.body.id,
      subprojectId: shop.body.id,
      name: "Shopper",
    });
    expect(agent.body.subprojectId).toBe(shop.body.id);
    expect(
      (
        await s.api("POST", "/api/agents", {
          kind: "agent",
          parentId: orch.body.id,
          projectId: p.body.id,
          subprojectId: "elsewhere--x",
          name: "Nope",
        })
      ).status,
    ).toBe(404);

    const talk = async (agentId: string, text: string) => {
      const sid = (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId }))?.body
        .sessionId as string;
      await (await (s as Server).core.send("me", sid, text)).done;
    };
    steps["write own"] = {
      name: "write_file",
      input: { path: "apps/shop/cart.ts", content: "export {}" },
    };
    steps["write shared"] = {
      name: "write_file",
      input: { path: "shared/theme.css", content: "" },
    };
    steps["read sibling"] = { name: "read_file", input: { path: "apps/blog/post.md" } };
    steps["read shared"] = { name: "read_file", input: { path: "shared/theme.css" } };
    steps["sneak"] = {
      name: "bash",
      input: {
        command:
          // cmd only when that is the agents' shell (RedGiant 3.0 on Windows: Git's bash first).
          process.platform === "win32" && shellKind() === "cmd"
            ? "echo hack> ..\\..\\shared\\hack.txt && cd"
            : "echo hack > ../../shared/hack.txt && pwd",
      },
    };
    for (const step of ["write own", "write shared", "read sibling", "read shared", "sneak"])
      await talk(agent.body.id, step);
    expect(system).toContain('subproject "Shop", in the folder apps/shop/');
    expect(results[0]).not.toMatch(/outside|error/i);
    expect(results[1]).toMatch(/outside your subproject/);
    expect(results[2]).toMatch(/No such file|another subproject/);
    expect(results[3]).toContain("body{}");
    expect(results[4]).toMatch(/apps[\\/]shop/);

    // The shell wrote in the shared part: the merge waits for the orchestrator.
    steps["merge"] = { name: "merge_work", input: { agent_id: agent.body.id, message: "cart" } };
    steps["merge all"] = {
      name: "merge_work",
      input: { agent_id: agent.body.id, message: "cart", include_shared: true },
    };
    await talk(orch.body.id, "merge");
    expect(results.at(-1)).toMatch(/outside its subproject.*shared\/hack\.txt/s);
    expect(existsSync(join(root, "apps/shop/cart.ts"))).toBe(false);
    await talk(orch.body.id, "merge all");
    expect(results.at(-1)).toMatch(/Merged/);
    expect(existsSync(join(root, "apps/shop/cart.ts"))).toBe(true);

    // The project's inspector reads every subproject and writes nothing.
    const inspector = await s.core.inspectorAgent("me", p.body.id);
    steps["inspect"] = { name: "read_file", input: { path: "apps/blog/post.md" } };
    steps["scribble"] = { name: "write_file", input: { path: "apps/blog/x.md", content: "x" } };
    await talk(inspector.id, "inspect");
    expect(results.at(-1)).toContain("draft");
    await talk(inspector.id, "scribble");
    expect(results.at(-1)).toMatch(/readonly mode/);

    // A subproject's spend counts in its own budget too.
    const budgets = await s.api<{ scope: string; id: string; used: { tokens: number } }[]>(
      "GET",
      "/api/budgets",
    );
    expect(budgets.body.find((b) => b.id === shop.body.id)?.used.tokens).toBeGreaterThan(0);
  });

  it("turns a project into a subproject of another, with its history, agents and board (G24.14c)", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const mk = async (name: string) => {
      const p = await s?.api<{ id: string }>("POST", "/api/projects", { name });
      const o = await s?.api<{ id: string }>("POST", "/api/agents", {
        kind: "orchestrator",
        parentId: god.body.id,
        projectId: p?.body.id,
        name: `${name} lead`,
      });
      return { id: p?.body.id as string, lead: o?.body.id as string };
    };
    const shop = await mk("Shop");
    const app = await mk("Mobile app");
    const dev = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "agent",
      parentId: app.lead,
      projectId: app.id,
      name: "Flutter dev",
    });
    const appProject = await s.core.projects.get("me", app.id);
    await writeFile(join(appProject?.path ?? "", "pubspec.yaml"), "name: app\n");
    await execFileP("git", ["init", "-q"], { cwd: appProject?.path });
    await execFileP(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "First app commit",
      ],
      { cwd: appProject?.path },
    );
    await s.api("POST", "/api/board/posts", {
      projectId: app.id,
      title: "Icons",
      kind: "note",
      body: "Need new icons",
    });

    const r = await s.api<{ id: string; dir: string }>("POST", `/api/projects/${shop.id}/adopt`, {
      project: app.id,
      dir: "apps/mobile",
    });
    expect(r.status).toBe(201);
    const shopPath = (await s.core.projects.get("me", shop.id))?.path ?? "";
    expect(existsSync(join(shopPath, "apps/mobile/pubspec.yaml"))).toBe(true);
    const log = (await execFileP("git", ["log", "--format=%s"], { cwd: shopPath })).stdout;
    expect(log).toContain("First app commit");
    // The agents follow; the old lead stops, the new lead leads.
    const moved = s.core.registry.get(dev.body.id);
    expect(moved).toMatchObject({
      projectId: shop.id,
      subprojectId: r.body.id,
      parentId: shop.lead,
    });
    expect(s.core.registry.get(app.lead)?.status).toBe("stopped");
    expect(await s.core.projects.get("me", app.id)).toBeUndefined();
    const threads = await s.core.board.threads("me", shop.id);
    expect(threads.find((t) => t.title === "Icons")).toMatchObject({ subprojectId: r.body.id });
    // The old folder is kept as a safety copy.
    const kept = (await readdir(dirname(appProject?.path ?? ""))).filter((f) =>
      f.includes(".merged-"),
    );
    expect(kept).toHaveLength(1);
  });

  it("lets project agents open an issue through the server, after the person approves (G24.14c)", async () => {
    let step = 0;
    s = await startServer(() =>
      ++step === 1
        ? { toolCalls: [{ name: "repo_issue", input: { title: "Bug", body: "It breaks" } }] }
        : { text: "done" },
    );
    const asked: string[][] = [];
    s.core.approvals.on("request", (o, info) => {
      asked.push(info.danger);
      s?.core.approvals.decide(o, info.requestId, "allow");
    });
    const calls: unknown[] = [];
    s.core.repoActions = async (projectId, a) => {
      calls.push({ projectId, ...a });
      return "Issue #1: https://x/1";
    };
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const p = await s.api<{ id: string }>("POST", "/api/projects", { name: "Site" });
    const lead = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: p.body.id,
      name: "Lead",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: lead.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "report the bug")).done;
    expect(asked).toEqual([["git-publish"]]);
    expect(calls).toEqual([
      { projectId: p.body.id, kind: "issue", title: "Bug", body: "It breaks" },
    ]);
  });
});
