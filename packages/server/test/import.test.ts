import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportPreview, ImportRecord, Job } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { Importer, parseFacts } from "../src/import.js";
import { readChatExports } from "../src/import-chats.js";
import { type FoundFile, parseJsonc, readAgentFiles, skillName } from "../src/import-readers.js";
import { type SetupHooks, SetupService } from "../src/index.js";
import { startServer, TOKEN } from "./helpers.js";
import {
  CLAUDE_MEMORIES,
  CLAUDE_PROJECTS,
  chatgptConversations,
  chatgptZip,
  claudeConversations,
  claudeZip,
  HOME_FILES,
  PROJECT_FILES,
  writeHome,
  writeProject,
} from "./import-samples.js";

const files = (map: Record<string, string>, prefix = "~"): FoundFile[] =>
  Object.entries(map).map(([p, t]) => ({
    path: `${prefix}/${p}`,
    size: t.length,
    read: async () => Buffer.from(t),
  }));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("readers of other agents' files (G36.7)", () => {
  it("finds instructions, skills, servers and memories in a home folder", async () => {
    const r = await readAgentFiles(files(HOME_FILES));
    const of = (kind: string) =>
      r.candidates
        .filter((c) => c.kind === kind)
        .map((c) => c.name)
        .sort();
    expect(of("skill")).toEqual([
      "code-reviewer",
      "explain",
      "fix-issue",
      "git-commit",
      "git-squash",
      "release-notes",
      "sql-migrations",
      "translator",
    ]);
    expect(of("mcp")).toEqual([
      "context7",
      "figma",
      "filesystem",
      "github",
      "linear",
      "notion",
      "sentry",
      "weather",
    ]);
    expect(of("instructions")).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "GEMINI.md",
      "SOUL.md",
      "api.md",
    ]);
    const memories = r.candidates.filter((c) => c.kind === "memory").map((c) => c.text);
    expect(memories).toEqual(
      expect.arrayContaining([
        "The person always uses pnpm, never npm or yarn.",
        "Anna works from Turin, office hours on Central European Time.",
        "My cat is called Miso.",
        "I am vegetarian.",
        "Anna has two children, Luca and Sara.",
        "Anna runs on Sunday mornings.",
      ]),
    );
    // Claude Code's transcripts are never read.
    expect(r.candidates.some((c) => c.from.endsWith(".jsonl"))).toBe(false);
    // GEMINI.md's own memories do not stay in its instructions.
    const gemini = r.candidates.find((c) => c.name === "GEMINI.md");
    expect(gemini?.text).toContain("Keep answers short.");
    expect(gemini?.text).not.toContain("Miso");
    // What is not carried over is said.
    expect(r.left.map((l) => l.from)).toEqual([
      "~/.claude/settings.json",
      "~/.codex/config.toml",
      "~/.config/opencode/opencode.jsonc",
    ]);
    expect(r.left[0]?.what).toMatch(/permissions, hooks, model/);
  });

  it("keeps a command's meaning and says what it loses", async () => {
    const r = await readAgentFiles(files(HOME_FILES));
    const fix = r.candidates.find((c) => c.name === "fix-issue");
    expect(fix?.kind).toBe("skill");
    expect(fix?.notes.map((n) => n.code).sort()).toEqual([
      "arguments",
      "as-skill",
      "model-dropped",
      "tools-dropped",
    ]);
    expect(fix?.kind === "skill" && fix.data.body).toContain("(the person's request)");
    expect(fix?.skill?.description).toBe("Fix a GitHub issue by number");
    const rel = r.candidates.find((c) => c.name === "release-notes");
    expect(rel?.skill?.files).toEqual(["scripts/changes.sh"]);
    expect(rel?.skill?.scripts).toEqual(["scripts/changes.sh"]);
    const reviewer = r.candidates.find((c) => c.name === "code-reviewer");
    expect(reviewer?.kind === "skill" && reviewer.data.body).toMatch(/^When this skill fits/);
    const rule = r.candidates.find((c) => c.name === "api.md");
    expect(rule?.notes).toEqual([{ code: "only-paths" }]);
  });

  it("keeps keys out of the servers' settings", async () => {
    const r = await readAgentFiles(files(HOME_FILES));
    const mcp = (n: string) => {
      const c = r.candidates.find((x) => x.kind === "mcp" && x.name === n);
      if (c?.kind !== "mcp") throw new Error(n);
      return c;
    };
    const github = mcp("github");
    expect(github.data.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(JSON.stringify(github.data.transport)).not.toContain("ghp_");
    expect(github.data.secrets.env.GITHUB_PERSONAL_ACCESS_TOKEN).toMatch(/^ghp_/);
    expect(github.mcp?.held).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(github.preview).not.toContain("ghp_");
    expect(mcp("sentry").data.templates.headers).toEqual({
      Authorization: "Bearer ${SENTRY_TOKEN}",
    });
    expect(mcp("sentry").mcp?.missing).toEqual(["SENTRY_TOKEN"]);
    expect(mcp("figma").data.templates.headers).toEqual({
      Authorization: "Bearer ${FIGMA_OAUTH_TOKEN}",
    });
    expect(mcp("linear").mcp?.missing).toEqual(["LINEAR_KEY"]);
    expect(mcp("filesystem").data.transport).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/anna"],
    });
    expect(mcp("notion").notes).toContainEqual({ code: "disabled" });
    expect(mcp("weather").data.secrets.env).toEqual({ UNITS: "metric" });
  });

  it("reads a project's files: Cursor rules always on are instructions, the others skills", async () => {
    const r = await readAgentFiles(files(PROJECT_FILES, "shop"));
    expect(r.candidates.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      "instructions:AGENTS.md",
      "instructions:CLAUDE.md",
      "instructions:always.mdc",
      "mcp:postgres",
      "skill:react",
    ]);
    expect(r.candidates.find((c) => c.name === "react")?.notes).toEqual([{ code: "only-paths" }]);
  });

  it("parses JSON with comments and makes valid skill names", () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], /* x */ "b": "//not" , }')).toEqual({
      a: [1, 2],
      b: "//not",
    });
    expect(skillName("Git: Commit Message!")).toBe("git-commit-message");
    expect(skillName("Résumé")).toBe("resume");
    expect(skillName("---")).toBe("imported-skill");
  });
});

describe("chat exports (G36.7)", () => {
  it("reads ChatGPT's branch shown, its custom instructions and its memory", async () => {
    const r = await readChatExports([
      {
        path: "chatgpt/conversations.json",
        size: 1,
        read: async () => Buffer.from(JSON.stringify(chatgptConversations())),
      },
    ]);
    const convs = r.candidates.filter((c) => c.kind === "conversation");
    expect(convs).toHaveLength(2);
    const first = convs[0];
    if (first?.kind !== "conversation") throw new Error();
    expect(first.data.title).toBe("Pasta for six");
    expect(first.data.originalId).toBe("chatgpt:6790a1b2-0000-4000-8000-000000000001");
    expect(first.data.model).toBe("gpt-5");
    // The regenerated answer, the thoughts and the search call are not the conversation shown.
    expect(first.data.messages).toEqual([
      { role: "user", text: "How much pasta for six people?", at: "2026-01-01T00:00:01.000Z" },
      {
        role: "assistant",
        text: "About 500-600 g: 80-100 g per person.",
        at: "2026-01-01T00:00:10.000Z",
      },
    ]);
    expect(first.notes.map((n) => n.code)).toEqual(["no-attachments", "branch"]);
    const second = convs[1];
    if (second?.kind !== "conversation") throw new Error();
    expect(second.data.title).toBe("What is in this picture?");
    const instructions = r.candidates.filter((c) => c.kind === "instructions");
    expect(instructions.map((c) => c.text)).toEqual([
      "I am Anna, a developer in Turin.\n\nAnswer briefly, in Italian.",
    ]);
    expect(r.candidates.filter((c) => c.kind === "memory").map((c) => c.text)).toEqual([
      "Has a cat named Miso.",
      "Is learning Rust.",
    ]);
  });

  it("reads Claude's conversations, memories and project prompts", async () => {
    const r = await readChatExports([
      {
        path: "conversations.json",
        size: 1,
        read: async () => Buffer.from(JSON.stringify(claudeConversations())),
      },
      {
        path: "memories.json",
        size: 1,
        read: async () => Buffer.from(JSON.stringify(CLAUDE_MEMORIES)),
      },
      {
        path: "projects.json",
        size: 1,
        read: async () => Buffer.from(JSON.stringify(CLAUDE_PROJECTS)),
      },
    ]);
    const conv = r.candidates.find((c) => c.kind === "conversation");
    if (conv?.kind !== "conversation") throw new Error();
    expect(conv.source).toBe("claude");
    expect(conv.data.messages[0]?.text).toBe(
      "Plan three days in Lisbon, I love museums.\n\n[file dates.txt]\nMarch 3 to 6",
    );
    expect(conv.data.messages[1]?.text).toContain("Day 1: Gulbenkian");
    expect(conv.data.messages[1]?.text).toContain("**Lisbon plan**");
    expect(conv.data.messages[1]?.text).not.toContain("They like museums");
    expect(r.candidates.filter((c) => c.kind === "memory").map((c) => c.text)).toEqual([
      "Anna is a developer in Turin.",
      "Anna prefers short answers.",
    ]);
    expect(r.candidates.find((c) => c.kind === "instructions")?.name).toBe("Blog (Claude project)");
  });

  it("finds facts in a model's answer", () => {
    expect(parseFacts('Sure: ["Lives in Turin.", "Has a cat."]')).toEqual([
      "Lives in Turin.",
      "Has a cat.",
    ]);
    expect(parseFacts("- Lives in Turin.\n- Has a cat.")).toEqual([
      "Lives in Turin.",
      "Has a cat.",
    ]);
  });
});

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
  remote: async () => null,
};

async function server(script: (r: CompletionRequest) => { text: string }) {
  let setup: SetupService | undefined;
  const s = await startServer(
    (r) => script(r),
    {},
    {},
    undefined,
    undefined,
    async (core, dir) => {
      setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
      });
      await setup.applyAtStartup();
      return { setup };
    },
  );
  cleanup.push(s.close);
  const god = await s.api("POST", "/api/agents", { kind: "god", parentId: null, name: "God" });
  expect(god.status).toBe(201);
  return { s, setup: setup as SetupService };
}

async function finish(s: Awaited<ReturnType<typeof startServer>>, job: Job): Promise<ImportRecord> {
  for (;;) {
    const j = s.core.jobs.get("me", job.id);
    if (j && j.state !== "running") {
      if (j.state !== "done") throw new Error(JSON.stringify(j.error));
      return j.result as ImportRecord;
    }
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

describe("importing (G36.7)", () => {
  it("shows a preview, imports what was chosen, and takes it all back", async () => {
    const asked: CompletionRequest[] = [];
    const { s, setup } = await server((r) => {
      asked.push(r);
      return { text: "Glad to go on." };
    });
    await setup.saveInstructions("Be kind.");
    const home = await mkdtemp(join(tmpdir(), "rg-import-home-"));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    await writeHome(home);
    // A skill of the same name is there already: never overwritten silently.
    const skills = join(s.core.platformPath("me"), "skills");
    await s.core.extensions.propose({
      ownerId: "me",
      projectId: null,
      author: "human",
      autoInstall: true,
      input: {
        kind: "skill",
        name: "release-notes",
        description: "My own release notes skill",
        body: "My own way of writing release notes, kept.",
        untestableReason: "Instructions only, nothing to run here.",
      },
    });
    const importer = new Importer(s.core, {
      dir: join(s.dir, "imports"),
      home: () => home,
      instructions: { get: () => setup.instructionsText(), set: (t) => setup.saveInstructions(t) },
    });
    const pv = await importer.scan("me", { home: true });
    const item = (name: string, kind?: string) => {
      const x = pv.items.find((i) => i.name === name && (!kind || i.kind === kind));
      if (!x) throw new Error(name);
      return x;
    };
    expect(item("release-notes").exists).toBe("taken");
    expect(item("release-notes").on).toBe(false);
    expect(item("notion").on).toBe(false);
    const password = pv.items.find((i) => i.kind === "memory" && i.text?.includes("hunter2"));
    expect(password?.on).toBe(false);
    expect(password?.notes).toContainEqual({ code: "secret" });
    expect(JSON.stringify(pv)).not.toContain("ghp_");

    const choose = (name: string, extra: object = {}, kind?: string) => ({
      id: item(name, kind).id,
      on: true,
      ...extra,
    });
    const job = importer.apply("me", {
      id: pv.id,
      choices: [
        choose("CLAUDE.md"),
        choose("release-notes", { conflict: "replace" }),
        choose("fix-issue"),
        choose("github"),
        choose("sentry", { secrets: { SENTRY_TOKEN: "sntrys_secret_value_123" } }),
        choose("figma"),
        choose("I am vegetarian."),
        { id: item("My cat is called Miso.").id, on: true, text: "Has a cat named Miso." },
        { id: item("SOUL.md").id, on: false },
      ],
    });
    const rec = await finish(s, job);
    expect(rec.done.every((d) => d.ok)).toBe(true);
    expect(rec.done.find((d) => d.name === "figma")?.note).toBe(
      "keys still to add: FIGMA_OAUTH_TOKEN",
    );
    expect(setup.instructionsText()).toBe(
      `Be kind.\n\n## From Claude Code (~/.claude/CLAUDE.md)\n${HOME_FILES[".claude/CLAUDE.md"]?.trim()}`,
    );
    expect(await readFile(join(skills, "release-notes", "SKILL.md"), "utf8")).toContain(
      "git log --oneline",
    );
    expect(
      await readFile(join(skills, "release-notes", "scripts", "changes.sh"), "utf8"),
    ).toContain("git diff");
    expect(await readFile(join(skills, "fix-issue", "SKILL.md"), "utf8")).toContain(
      "(the person's request)",
    );
    const servers = await s.core.listMcp("me");
    expect(servers.map((x) => x.name).sort()).toEqual(["figma", "github", "sentry"]);
    // Keys only in the servers' private credentials, never in their settings.
    expect(JSON.stringify(servers)).not.toMatch(/ghp_|sntrys_/);
    expect(await s.core.mcpCredentials.load("me", "sentry")).toMatchObject({
      headers: { Authorization: "Bearer sntrys_secret_value_123" },
    });
    expect(await s.core.mcpCredentials.load("me", "github")).toMatchObject({
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: expect.stringMatching(/^ghp_/) },
    });
    const memory = (await s.core.sharedMemory.entries("me")).map((e) => e.text);
    expect(memory.sort()).toEqual(["Has a cat named Miso.", "I am vegetarian."]);
    expect((await s.core.sharedMemory.entries("me")).every((e) => e.by === "import")).toBe(true);

    // Looked at again: what came in is there already.
    const again = await importer.scan("me", { home: true });
    expect(again.items.find((i) => i.name === "CLAUDE.md")?.exists).toBe("same");
    expect(again.items.find((i) => i.name === "github")?.exists).toBe("same");
    expect(again.items.find((i) => i.text === "I am vegetarian.")?.exists).toBe("same");

    // Undo: everything back as it was, the replaced skill too.
    const undone = await importer.undo("me", rec.id);
    expect(undone.undoneAt).not.toBeNull();
    expect(undone.undoProblems).toEqual([]);
    expect(setup.instructionsText()).toBe("Be kind.");
    expect(await readFile(join(skills, "release-notes", "SKILL.md"), "utf8")).toContain(
      "My own way",
    );
    expect(await stat(join(skills, "fix-issue")).catch(() => undefined)).toBeUndefined();
    expect(await s.core.listMcp("me")).toEqual([]);
    expect(await s.core.sharedMemory.entries("me")).toEqual([]);
    await expect(importer.undo("me", rec.id)).rejects.toThrow(/already/);
    expect(asked).toHaveLength(0);
  });

  it("imports a ChatGPT export through the API as conversations that go on", async () => {
    const asked: CompletionRequest[] = [];
    const { s } = await server((r) => {
      asked.push(r);
      if (r.system?.startsWith("You read what a person wrote"))
        return { text: '["Anna is a developer in Turin.", "My card is 4111 1111 1111 1111"]' };
      return { text: "Glad to go on." };
    });
    const up = await s.api<{ id: string }>("POST", "/api/import/upload");
    const put = (path: string, body: Uint8Array) =>
      fetch(`${s.url}/api/import/upload/${up.body.id}?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        body,
      }).then((r) => r.json() as Promise<{ added: number }>);
    expect(await put("chatgpt-export.zip", chatgptZip())).toEqual({ added: 1 });
    // A folder picked: only the files the readers want are kept.
    expect(await put(".claude/CLAUDE.md", Buffer.from("Use tabs."))).toEqual({ added: 1 });
    expect(await put("photos/cat.jpg", Buffer.from("x"))).toEqual({ added: 0 });
    expect((await put("../evil.md", Buffer.from("x")).catch(() => ({ added: -1 }))).added).not.toBe(
      1,
    );
    const pv = await s.api<ImportPreview>("POST", `/api/import/upload/${up.body.id}/preview`);
    expect(pv.status).toBe(200);
    const convs = pv.body.items.filter((i) => i.kind === "conversation");
    expect(convs.map((c) => c.name)).toEqual(["Pasta for six", "What is in this picture?"]);
    expect(pv.body.items.some((i) => i.name === "CLAUDE.md")).toBe(true);
    const applied = await s.api<Job>("POST", "/api/import/apply", {
      id: pv.body.id,
      choices: convs.map((c) => ({ id: c.id, on: true })),
    });
    expect(applied.status).toBe(202);
    const rec = await finish(s, applied.body);
    const sid = rec.done[0]?.ref as string;
    expect(rec.done.map((d) => d.error ?? "ok")).toEqual(["ok", "ok"]);
    expect(sid).toMatch(/^sess_/);
    const list = await s.core.listSessions("me");
    const chat = await s.core.chatAgent("me");
    expect(list.find((x) => x.id === sid)).toMatchObject({
      title: "Pasta for six",
      agent_id: chat.id,
    });
    const events = await s.core.store.list({ sessionId: sid });
    expect(events.map((e) => e.type)).toEqual([
      "session.imported",
      "message.user",
      "message.assistant",
    ]);
    // The conversation goes on: the model reads the imported messages first.
    const { done } = await s.core.send("me", sid, "And for eight?");
    await done;
    const last = asked.at(-1);
    expect(last?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(last?.messages[1])).toContain("80-100 g per person");
    // The same export again: nothing doubles.
    const up2 = await s.api<{ id: string }>("POST", "/api/import/upload");
    await fetch(`${s.url}/api/import/upload/${up2.body.id}?path=export.zip`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: chatgptZip(),
    });
    const pv2 = await s.api<ImportPreview>("POST", `/api/import/upload/${up2.body.id}/preview`);
    expect(
      pv2.body.items.filter((i) => i.kind === "conversation").every((i) => i.exists === "same"),
    ).toBe(true);
    // Memories from what the person wrote there, to confirm one by one (a secret never on).
    const mem = await s.api<ImportPreview>("POST", `/api/import/${rec.id}/memories`);
    expect(mem.body.items.map((i) => [i.text, i.on])).toEqual([
      ["Anna is a developer in Turin.", true],
      ["My card is 4111 1111 1111 1111", false],
    ]);
    const read = asked.find((r) => r.system?.startsWith("You read what a person wrote"));
    expect(JSON.stringify(read?.messages)).toContain("How much pasta");
    expect(JSON.stringify(read?.messages)).not.toContain("80-100 g per person");
    // Taken back: the conversations leave the list and their words the log.
    const history = await s.api<ImportRecord[]>("GET", "/api/import/history");
    expect(history.body[0]?.id).toBe(rec.id);
    const undone = await s.api<ImportRecord>("POST", `/api/import/${rec.id}/undo`);
    expect(undone.body.undoneAt).not.toBeNull();
    expect((await s.core.listSessions("me")).some((x) => x.id === sid)).toBe(false);
    expect(
      (await s.core.store.list({ sessionId: sid })).filter(
        (e) => e.payload && e.type !== "redaction",
      ),
    ).toEqual([]);
    expect(await s.core.store.verify()).toMatchObject({ ok: true });
  });

  it("reads a Claude export and a project's folder when asked", async () => {
    const { s } = await server(() => ({ text: "ok" }));
    const project = await s.api<{ id: string; path: string }>("POST", "/api/projects", {
      name: "Shop",
    });
    await writeProject(project.body.path);
    const pv = await s.api<ImportPreview>("POST", "/api/import/scan", { projects: true });
    // A project's own instructions are not for every agent unless chosen.
    const claudeMd = pv.body.items.find((i) => i.name === "CLAUDE.md");
    expect(claudeMd?.from).toBe("Shop/CLAUDE.md");
    expect(claudeMd?.on).toBe(false);
    expect(pv.body.items.find((i) => i.name === "postgres")?.on).toBe(true);
    const up = await s.api<{ id: string }>("POST", "/api/import/upload");
    await fetch(`${s.url}/api/import/upload/${up.body.id}?path=data-2026.zip`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: claudeZip(),
    });
    const c = await s.api<ImportPreview>("POST", `/api/import/upload/${up.body.id}/preview`);
    expect(c.body.items.map((i) => `${i.source}:${i.kind}`).sort()).toEqual([
      "claude:conversation",
      "claude:instructions",
      "claude:memory",
      "claude:memory",
    ]);
    // The upload folder is gone once read.
    expect(await readdir(join(s.core.backupsDir, "..", "imports")).catch(() => [])).toEqual([]);
    // An expired or someone else's preview does nothing.
    const other = await s.api("POST", "/api/import/apply", { id: "pv_nope", choices: [] });
    expect(other.status).toBe(400);
  });
});

// The samples on disk for the screenshots and for trying by hand (RG_IMPORT_SAMPLES=<folder>).
describe.skipIf(!process.env.RG_IMPORT_SAMPLES)("samples", () => {
  it("writes them", async () => {
    const dir = process.env.RG_IMPORT_SAMPLES as string;
    await writeHome(join(dir, "home"));
    await writeProject(join(dir, "project-shop"));
    await writeFile(join(dir, "chatgpt-export.zip"), chatgptZip());
    await writeFile(join(dir, "claude-export.zip"), claudeZip());
  });
});
