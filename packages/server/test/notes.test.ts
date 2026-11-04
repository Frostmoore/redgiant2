import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { NOTE_LIMIT, Notes } from "../src/notes.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const who = { ownerId: "me", agentId: "a1", projectId: "p1" };

describe("notes (G29.3)", () => {
  it("adds, replaces and removes entries, each scope in its own file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-notes-"));
    const n = new Notes((o) => join(dir, o));
    await n.change(who, "user", "add", "Prefers Italian");
    await n.change(who, "user", "add", "- Works late");
    expect(await n.read(who, "user")).toBe("- Prefers Italian\n- Works late");
    await n.change(who, "user", "replace", "Prefers Italian, always", "Prefers Italian");
    await n.change(who, "user", "remove", "Works late");
    expect(await n.read(who, "user")).toBe("- Prefers Italian, always");
    await n.change(who, "project", "add", "Tests: pnpm test");
    expect(await readFile(join(dir, "me", "projects", "p1.md"), "utf8")).toContain("pnpm test");
    expect(await n.read(who, "self")).toBe("");
    const prompt = await n.prompt(who);
    expect(prompt).toContain("Prefers Italian, always");
    expect(prompt).toContain('About this project (scope "project"):\n- Tests: pnpm test');
    // Without a project there is no project scope.
    await expect(n.change({ ownerId: "me", agentId: "a1" }, "project", "add", "x")).rejects.toThrow(
      /no project/,
    );
  });

  it("refuses unclear changes and notes that grow too long", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-notes-"));
    const n = new Notes(() => dir);
    await n.change(who, "self", "add", "same");
    await n.change(who, "self", "add", "same");
    await expect(n.change(who, "self", "replace", "x", "same")).rejects.toThrow(/more than once/);
    await expect(n.change(who, "self", "remove", "missing")).rejects.toThrow(/not in the notes/);
    await expect(n.change(who, "self", "add", "y".repeat(NOTE_LIMIT))).rejects.toThrow(/merge/);
  });

  it("keeps every line when many agents add at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-notes-"));
    const n = new Notes(() => dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => n.change(who, "user", "add", `fact ${i}`)),
    );
    expect((await n.read(who, "user")).split("\n")).toHaveLength(20);
  });

  it("what one agent of a project saves, the next conversation of another one knows", async () => {
    const systems: string[] = [];
    const lastResult = (req: CompletionRequest) =>
      req.messages.at(-1)?.parts.some((x) => x.type === "tool_result") === true;
    s = await startServer((req) => {
      systems.push(req.system ?? "");
      expect(req.tools.map((t) => t.name)).toContain("memory");
      if (lastResult(req)) return { text: "Saved." };
      if (systems.length === 1)
        return {
          toolCalls: [
            {
              name: "memory",
              input: { action: "add", scope: "project", text: "Deploy only on Fridays" },
            },
          ],
        };
      return { text: "ok" };
    });
    await s.api("POST", "/api/projects", { name: "Demo Project" });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "demo-project",
      name: "Orchestrator",
    });
    const coder = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "agent",
      parentId: orch.body.id,
      name: "Coder",
    });
    const talk = async (agentId: string) => {
      const sid = (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId }))?.body
        .sessionId as string;
      await (await (s as Server).core.send("me", sid, "hello")).done;
    };
    await talk(coder.body.id);
    expect(systems[0]).toContain('About this project (scope "project"):\n(empty)');
    await talk(orch.body.id);
    expect(systems.at(-1)).toContain("- Deploy only on Fridays");
  });
});
