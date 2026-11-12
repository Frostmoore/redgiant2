import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  customTools,
  ExtensionBuilder,
  loadCustomTools,
  loadSkills,
  McpConnection,
  migrateExtensions,
  proposeTool,
  skillsIndex,
  skillTools,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const here = dirname(fileURLToPath(import.meta.url));
const ctx: ToolContext = { ownerId: "me", projectId: "p", agentId: "a", sessionId: "s" };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-ext-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const text = (o: unknown) => (typeof o === "string" ? o : (o as { content: string }).content);

describe("MCP", () => {
  it("turns an MCP server's tools into agent tools (in memory)", async () => {
    const server = new McpServer({ name: "calc", version: "1" });
    server.registerTool(
      "add",
      { description: "Adds", inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
    );
    server.registerTool("fail", { description: "Always fails", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    }));
    const [client, srv] = InMemoryTransport.createLinkedPair();
    await server.connect(srv);
    const conn = new McpConnection(
      { name: "calc", transport: { type: "http", url: "http://unused" } },
      () => client,
    );
    const tools = await conn.tools();
    expect(tools.map((t) => t.def.name)).toEqual(["mcp__calc__add", "mcp__calc__fail"]);
    expect(tools[0]?.def.inputSchema).toMatchObject({ properties: { a: { type: "number" } } });
    expect(await tools[0]?.run({ a: 2, b: 3 }, ctx)).toEqual({ content: "5", isError: false });
    expect(await tools[1]?.run({}, ctx)).toEqual({ content: "nope", isError: true });
    await conn.close();
  });

  it("starts a stdio MCP server as a process", async () => {
    const conn = new McpConnection({
      name: "echo",
      transport: { type: "stdio", command: process.execPath, args: [join(here, "mcp-server.mjs")] },
    });
    const [shout] = await conn.tools();
    expect(shout?.def.name).toBe("mcp__echo__shout");
    expect(text(await shout?.run({ text: "red giant" }, ctx))).toBe("RED GIANT");
    await conn.close();
  });
});

describe("skills", () => {
  it("lists names and descriptions, loads the body on demand, and lets projects override", async () => {
    const platform = join(dir, "platform");
    const project = join(dir, "project", ".redgiant");
    const put = async (root: string, name: string, desc: string, body: string) => {
      await mkdir(join(root, "skills", name), { recursive: true });
      await writeFile(
        join(root, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`,
      );
    };
    await put(platform, "release-notes", "Write release notes", "Platform version.");
    await put(platform, "pdf-forms", "Fill PDF forms", "Use the script.");
    await writeFile(join(platform, "skills", "pdf-forms", "fill.py"), "print('fill')\n");
    await put(project, "release-notes", "Write release notes (project style)", "Project version.");
    const skills = await loadSkills([
      { dir: platform, scope: "platform" },
      { dir: project, scope: "project" },
    ]);
    expect(skillsIndex(skills)).toBe(
      "## Skills\nLoad a skill with skill_load before doing what it covers; read its other files with skill_file.\n- pdf-forms: Fill PDF forms\n- release-notes: Write release notes (project style)",
    );
    const [load, file] = skillTools(skills);
    expect(text(await load?.run({ name: "release-notes" }, ctx))).toBe("Project version.\n");
    expect(text(await load?.run({ name: "pdf-forms" }, ctx))).toMatch(
      /Files of this skill.*fill\.py/s,
    );
    expect(text(await file?.run({ name: "pdf-forms", path: "fill.py" }, ctx))).toBe(
      "print('fill')\n",
    );
    await expect(
      file?.run({ name: "pdf-forms", path: "../../../etc/passwd" }, ctx),
    ).rejects.toThrow(/outside/);
  });
});

describe("extension builder", () => {
  async function setup() {
    const { db } = await memoryDb();
    await migrate(db);
    await migrateExtensions(db);
    const store = new EventStore(db);
    const installRoot = join(dir, "installed");
    const sandboxes: { id: string; routesOnly?: boolean }[] = [];
    const builder = new ExtensionBuilder({
      db,
      store,
      testWorkspace: async (id, opts) => {
        const d = join(dir, "tests", id);
        await mkdir(d, { recursive: true });
        sandboxes.push({ id, ...opts });
        return {
          workspace: new LocalWorkspace(d),
          dispose: () => rm(d, { recursive: true, force: true }),
        };
      },
      installRoot: async () => installRoot,
    });
    return { builder, store, installRoot, sandboxes };
  }
  const wordCount = {
    kind: "tool" as const,
    spec: {
      name: "word-count",
      description: "Counts the words of a text",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      command: "node count.mjs",
    },
    files: {
      "count.mjs":
        "import { readFileSync } from 'node:fs';\nconst { text } = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nconsole.log(text.split(/\\s+/).filter(Boolean).length);\n",
    },
    tests: [{ input: { text: "a b c" }, expectStdoutContains: "3" }],
  };

  it("tests a proposed tool, waits for approval, then installs it for the agents", async () => {
    const { builder, store, installRoot } = await setup();
    const p = await builder.propose({
      ownerId: "me",
      projectId: "p",
      author: "agent_aaaaaaaa",
      input: wordCount,
    });
    expect(p).toMatchObject({ status: "pending", report: [{ passed: true }] });
    expect(await loadCustomTools([{ dir: installRoot, scope: "project" }])).toEqual([]);

    const approved = await builder.decide("me", p.id, "approve", "human");
    expect(approved.status).toBe("installed");
    const installed = await loadCustomTools([{ dir: installRoot, scope: "project" }]);
    expect(installed.map((t) => t.spec.name)).toEqual(["word-count"]);
    const ws = new LocalWorkspace(join(dir, "agent-ws"));
    await mkdir(ws.root, { recursive: true });
    const [tool] = customTools(installed, ws);
    expect(text(await tool?.run({ text: "one two three four" }, ctx)).trim()).toBe("4");
    expect((await store.list()).map((e) => e.type)).toEqual([
      "extension.proposed",
      "extension.decided",
    ]);
    await expect(builder.decide("me", p.id, "approve", "human")).rejects.toThrow(/not pending/);
  });

  it("G38.3: a tool's tests get the keychain's addresses only, in a sandbox with routes only; uninstall", async () => {
    const { builder, store, installRoot, sandboxes } = await setup();
    const p = await builder.propose({
      ownerId: "me",
      projectId: null,
      author: "god",
      input: {
        ...wordCount,
        files: { "count.mjs": "console.log(process.env.REDGIANT_VAULT_NOTES ?? 'none');\n" },
        tests: [{ input: {}, expectStdoutContains: "http://egress/vault/cap" }],
      },
      testEnv: async (tool) => ({ REDGIANT_VAULT_NOTES: `http://egress/vault/cap?${tool}` }),
      routesOnly: true,
    });
    expect(p.status).toBe("pending");
    expect(p.report[0]?.detail).toContain("http://egress/vault/cap?word-count");
    expect(sandboxes.at(-1)).toMatchObject({ id: p.id, routesOnly: true });
    await builder.decide("me", p.id, "approve", "human");
    expect(await loadCustomTools([{ dir: installRoot, scope: "platform" }])).toHaveLength(1);
    expect(await builder.uninstall("me", null, "tool", "word-count", "human")).toBe(true);
    expect(await loadCustomTools([{ dir: installRoot, scope: "platform" }])).toEqual([]);
    expect(await builder.uninstall("me", null, "tool", "word-count", "human")).toBe(false);
    await expect(builder.uninstall("me", null, "tool", "../etc", "human")).rejects.toThrow();
    expect((await store.list()).map((e) => e.type).at(-1)).toBe("extension.removed");
  });

  it("never installs a proposal that fails its tests", async () => {
    const { builder, installRoot } = await setup();
    const p = await builder.propose({
      ownerId: "me",
      projectId: "p",
      author: "a",
      input: { ...wordCount, tests: [{ input: { text: "a b" }, expectStdoutContains: "3" }] },
    });
    expect(p.status).toBe("failed");
    expect(p.report[0]?.detail).toMatch(/stdout lacks "3"/);
    await expect(builder.decide("me", p.id, "approve", "human")).rejects.toThrow(
      /failed, not pending/,
    );
    expect(await loadCustomTools([{ dir: installRoot, scope: "project" }])).toEqual([]);
  });

  it("refuses reserved names, tools without tests and skills with neither tests nor a reason", async () => {
    const { builder } = await setup();
    await expect(
      builder.propose({
        ownerId: "me",
        projectId: null,
        author: "a",
        input: { ...wordCount, spec: { ...wordCount.spec, name: "bash" } },
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      builder.propose({
        ownerId: "me",
        projectId: null,
        author: "a",
        input: { ...wordCount, tests: [] },
      }),
    ).rejects.toThrow(/at least one test/);
    await expect(
      builder.propose({
        ownerId: "me",
        projectId: null,
        author: "a",
        input: {
          kind: "skill",
          name: "notes",
          description: "How we write notes",
          body: "Write short notes, one idea each.",
        },
      }),
    ).rejects.toThrow(/untestableReason/);
  });

  it("lets an agent propose a skill through its tool, and the human reject it", async () => {
    const { builder, installRoot } = await setup();
    const tool = proposeTool({ id: "agent_bbbbbbbb", ownerId: "me", projectId: "p" }, builder);
    const r = text(
      await tool.run(
        {
          kind: "skill",
          name: "commit-messages",
          description: "How to write commit messages",
          body: "Imperative mood, at most 72 characters in the title.",
          files: { "check.sh": 'test -n "$1"\n' },
          tests: [{ command: "sh check.sh x" }],
        },
        ctx,
      ),
    );
    expect(r).toMatch(/passed its tests and waits for the user's approval/);
    const [p] = await builder.list("me", "pending");
    await builder.decide("me", p?.id ?? "", "reject", "human");
    expect(await loadSkills([{ dir: installRoot, scope: "project" }])).toEqual([]);
    const bad = await tool.run({ kind: "tool", name: "x", description: "too short" }, ctx);
    expect(bad).toMatchObject({ isError: true, content: expect.stringMatching(/^Not accepted/) });
  });

  it("installs a tested skill at once when the person chose so, never a tool (G29.4)", async () => {
    const { builder, installRoot } = await setup();
    const tool = proposeTool(
      { id: "agent_bbbbbbbb", ownerId: "me", projectId: "p" },
      builder,
      () => true,
    );
    const r = text(
      await tool.run(
        {
          kind: "skill",
          name: "flaky-ci",
          description: "What to do when CI fails only on Windows",
          body: "Rerun once, then read the runner's log before touching the test.",
          untestable_reason: "Instructions only, nothing to run.",
        },
        ctx,
      ),
    );
    expect(r).toMatch(/is installed/);
    expect((await loadSkills([{ dir: installRoot, scope: "project" }])).map((x) => x.name)).toEqual(
      ["flaky-ci"],
    );
    const t = text(
      await tool.run(
        {
          kind: "tool",
          name: "say-hi",
          description: "Prints hi for the given name",
          command: "echo hi",
          tests: [{ input: {}, expectExitCode: 0 }],
        },
        ctx,
      ),
    );
    expect(t).toMatch(/waits for the user's approval/);
  });

  it("writes SKILL.md on approval", async () => {
    const { builder, installRoot } = await setup();
    const p = await builder.propose({
      ownerId: "me",
      projectId: null,
      author: "human",
      input: {
        kind: "skill",
        name: "tone",
        description: "House tone of voice",
        body: "Friendly, direct, no jargon.",
        untestableReason: "Tone is judged by reading, not by a command.",
      },
    });
    await builder.decide("me", p.id, "approve", "human");
    expect(await readFile(join(installRoot, "skills", "tone", "SKILL.md"), "utf8")).toBe(
      "---\nname: tone\ndescription: House tone of voice\n---\n\nFriendly, direct, no jargon.\n",
    );
  });
});
