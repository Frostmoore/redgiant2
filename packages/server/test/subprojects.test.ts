import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

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
      input: { command: "echo hack > ../../shared/hack.txt && pwd" },
    };
    for (const step of ["write own", "write shared", "read sibling", "read shared", "sneak"])
      await talk(agent.body.id, step);
    expect(system).toContain('subproject "Shop", in the folder apps/shop/');
    expect(results[0]).not.toMatch(/outside|error/i);
    expect(results[1]).toMatch(/outside your subproject/);
    expect(results[2]).toMatch(/No such file|another subproject/);
    expect(results[3]).toContain("body{}");
    expect(results[4]).toMatch(/apps\/shop/);

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
});
