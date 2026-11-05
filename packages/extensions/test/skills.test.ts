import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { LocalWorkspace } from "@redgiant/tools";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionBuilder,
  exportSkill,
  importSkill,
  loadSkills,
  migrateExtensions,
  NAME_RE,
  ProposalInput,
  parseSkillMd,
  proposeTool,
  renderSkillMd,
  SKILL_ARCHIVE_LIMITS,
  SkillArchiveError,
  SkillExistsError,
  searchSkills,
  skillTools,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const ctx: ToolContext = { ownerId: "me", projectId: "p", agentId: "a", sessionId: "s" };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-skills-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const text = (o: unknown) => (typeof o === "string" ? o : (o as { content: string }).content);

async function putSkill(
  root: string,
  folder: string,
  md: string,
  extra: Record<string, string> = {},
) {
  await mkdir(join(root, "skills", folder), { recursive: true });
  await writeFile(join(root, "skills", folder, "SKILL.md"), md);
  for (const [p, c] of Object.entries(extra)) {
    await mkdir(join(root, "skills", folder, p, ".."), { recursive: true });
    await writeFile(join(root, "skills", folder, p), c);
  }
}

describe("skill names (agentskills.io)", () => {
  it.each([
    ["a", true],
    ["pdf", true],
    ["pdf-forms", true],
    ["v2-release-notes", true],
    ["9", true],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["", false],
    ["-pdf", false],
    ["pdf-", false],
    ["pdf--forms", false],
    ["PDF", false],
    ["pdf_forms", false],
    ["pdf forms", false],
    ["pdf.forms", false],
    ["../x", false],
  ])("%j valid: %s", (name, ok) => {
    expect(NAME_RE.test(name)).toBe(ok);
    expect(
      ProposalInput.safeParse({
        kind: "skill",
        name,
        description: "A long enough description",
        body: "A body long enough to be accepted.",
        untestableReason: "Instructions only, nothing to run.",
      }).success,
    ).toBe(ok);
  });

  it("caps the description at 1024 characters", () => {
    const base = {
      kind: "skill",
      name: "notes",
      body: "A body long enough to be accepted.",
      untestableReason: "Instructions only, nothing to run.",
    };
    expect(ProposalInput.safeParse({ ...base, description: "x".repeat(1024) }).success).toBe(true);
    expect(ProposalInput.safeParse({ ...base, description: "x".repeat(1025) }).success).toBe(false);
  });
});

describe("SKILL.md front matter (YAML)", () => {
  it.each([
    "Use when: the user asks for a PDF",
    "[draft] notes for the team",
    "# not a comment",
    "'quoted' at the start",
    '"double" quotes',
    "> folded? no",
    "a value with #hash inside",
    "- looks like a list",
    "{ looks: like a map }",
    "* star",
    "&anchor and *alias",
    "!tag",
    "% percent",
    "@at",
    "`backtick`",
    "yes",
    "123",
    "null",
    "ends with colon:",
    "Accénti e ünicode, 日本語",
  ])("round-trips %j", (description) => {
    const md = renderSkillMd({ name: "tricky", description, body: "Body." });
    expect(parseSkillMd(md)).toEqual({ name: "tricky", description, body: "Body.\n" });
  });

  it("keeps the optional fields of the standard", () => {
    const s = {
      name: "pdf",
      description: "Fill PDF forms",
      license: "Apache-2.0",
      compatibility: "Needs python3 and network access",
      metadata: { author: "acme", version: "1.0" },
      allowedTools: "Bash(python3:*) Read",
      body: "Run fill.py.",
    };
    const md = renderSkillMd(s);
    expect(md).toContain("allowed-tools: Bash(python3:*) Read\n");
    expect(parseSkillMd(md)).toEqual({ ...s, body: "Run fill.py.\n" });
  });

  it("reads YAML written by hand (block scalars, quotes, numbers in metadata)", () => {
    const p = parseSkillMd(
      "---\nname: pdf\ndescription: >-\n  Fill PDF forms\n  and merge them.\nmetadata:\n  version: 1.0\n  author: 'acme'\n---\nBody\n",
    );
    expect(p).toEqual({
      name: "pdf",
      description: "Fill PDF forms and merge them.",
      metadata: { version: "1", author: "acme" },
      body: "Body\n",
    });
    expect(parseSkillMd("---\nname: [unclosed\n---\nBody").error).toMatch(/Invalid YAML/);
    expect(parseSkillMd("No front matter")).toEqual({ body: "No front matter" });
  });

  it("skips skills whose name differs from the folder, or that break the rules", async () => {
    const root = join(dir, "root");
    const ok = (name: string) => `---\nname: ${name}\ndescription: Something useful\n---\nBody\n`;
    await putSkill(root, "good", ok("good"));
    await putSkill(root, "other", ok("not-other"));
    await putSkill(root, "broken", "---\nname: [broken\n---\nBody\n");
    await putSkill(root, "no-desc", "---\nname: no-desc\n---\nBody\n");
    await putSkill(root, "long", `---\nname: long\ndescription: ${"x".repeat(1025)}\n---\nB\n`);
    await putSkill(root, "bad--name", ok("bad--name"));
    await putSkill(root, "legacy", "---\ndescription: Folder gives the name\n---\nBody\n");
    const warnings: string[] = [];
    const skills = await loadSkills([{ dir: root, scope: "project" }], (m) => warnings.push(m));
    expect(skills.map((s) => s.name)).toEqual(["good", "legacy"]);
    expect(warnings.join("\n")).toMatch(/"not-other" does not match the folder "other"/);
    expect(warnings.join("\n")).toMatch(/broken skipped: Invalid YAML/);
    expect(warnings.join("\n")).toMatch(/no-desc skipped: The front matter has no description/);
    expect(warnings.join("\n")).toMatch(/long skipped: The description is longer than 1024/);
    expect(warnings).toHaveLength(4);
  });
});

describe("skill_search", () => {
  const sk = (name: string, description: string, body: string) => ({
    name,
    description,
    body,
    dir: "/nowhere",
    scope: "project" as const,
  });
  const skills = [
    sk("release-notes", "Write release notes", "Group changes by area. Mention PDF exports."),
    sk("pdf-forms", "Fill PDF forms with the script", "Run fill.py on the PDF."),
    sk("invoices", "Make invoices as PDF files", "Use the template."),
    sk("tone", "House tone of voice", "Friendly, direct."),
  ];

  it("ranks the name first, then the description, then the body", () => {
    expect(searchSkills(skills, "PDF").map((r) => r.skill.name)).toEqual([
      "pdf-forms",
      "invoices",
      "release-notes",
    ]);
    expect(searchSkills(skills, "release notes PDF")[0]?.skill.name).toBe("release-notes");
    expect(searchSkills(skills, "pdf", 1)).toHaveLength(1);
    expect(searchSkills(skills, "  ")).toEqual([]);
    expect(searchSkills(skills, "kubernetes")).toEqual([]);
  });

  it("is a tool next to skill_load and skill_file", async () => {
    const tools = skillTools(skills);
    expect(tools.map((t) => t.def.name)).toEqual(["skill_load", "skill_file", "skill_search"]);
    const search = tools[2];
    expect(text(await search?.run({ query: "voice" }, ctx))).toBe("- tone: House tone of voice");
    expect(text(await search?.run({ query: "pdf", limit: 2 }, ctx))).toBe(
      "- pdf-forms: Fill PDF forms with the script\n- invoices: Make invoices as PDF files",
    );
    expect(text(await search?.run({ query: "kubernetes" }, ctx))).toMatch(/No skill matches/);
  });
});

describe("sharing skills (.zip)", () => {
  const md = renderSkillMd({
    name: "pdf-forms",
    description: "Use when: a PDF form must be filled",
    license: "MIT",
    body: "Run scripts/fill.py.",
  });

  it("exports a skill's folder and imports it elsewhere", async () => {
    const src = join(dir, "src");
    await putSkill(src, "pdf-forms", md, { "scripts/fill.py": "print('fill')\n" });
    const zip = await exportSkill(join(src, "skills", "pdf-forms"));
    expect(Object.keys(unzipSync(zip)).sort()).toEqual([
      "pdf-forms/SKILL.md",
      "pdf-forms/scripts/fill.py",
    ]);
    // Same files, same archive: nothing depends on when it was made.
    expect(await exportSkill(join(src, "skills", "pdf-forms"))).toEqual(zip);

    const target = join(dir, "target");
    const r = await importSkill(zip, target);
    expect(r).toMatchObject({ name: "pdf-forms", replaced: false });
    const [skill] = await loadSkills([{ dir: target, scope: "platform" }]);
    expect(skill).toMatchObject({
      name: "pdf-forms",
      description: "Use when: a PDF form must be filled",
      license: "MIT",
    });
    expect(await readFile(join(target, "skills", "pdf-forms", "scripts", "fill.py"), "utf8")).toBe(
      "print('fill')\n",
    );
    // Never over an existing skill unless asked; no leftovers either way.
    await expect(importSkill(zip, target)).rejects.toBeInstanceOf(SkillExistsError);
    expect((await importSkill(zip, target, { replace: true })).replaced).toBe(true);
    expect(await readdir(join(target, "skills"))).toEqual(["pdf-forms"]);
  });

  it("accepts SKILL.md at the top of the archive", async () => {
    const zip = zipSync({ "SKILL.md": strToU8(md), "ref.md": strToU8("Ref") });
    expect((await importSkill(zip, dir)).name).toBe("pdf-forms");
    expect(await readFile(join(dir, "skills", "pdf-forms", "ref.md"), "utf8")).toBe("Ref");
  });

  it.each([
    ["path traversal", { "pdf-forms/SKILL.md": md, "pdf-forms/../../evil.txt": "x" }, /leaves/],
    ["an absolute path", { "pdf-forms/SKILL.md": md, "/etc/evil": "x" }, /Absolute/],
    ["a backslash path", { "pdf-forms/SKILL.md": md, "pdf-forms\\..\\evil": "x" }, /Bad path/],
    ["no SKILL.md", { "pdf-forms/README.md": "x" }, /no SKILL\.md/],
    ["two folders", { "pdf-forms/SKILL.md": md, "other/x.md": "x" }, /no SKILL\.md/],
    ["a folder not matching the name", { "forms/SKILL.md": md }, /does not match the folder/],
    ["an invalid name", { "SKILL.md": md.replace("pdf-forms", "Pdf--Forms") }, /not a valid/],
    ["no description", { "SKILL.md": "---\nname: x\n---\nBody" }, /no description/],
  ])("rejects %s", async (_label, files, error) => {
    const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
    await expect(importSkill(zip, dir)).rejects.toThrow(error);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects what is not a zip, and archives over the limits", async () => {
    await expect(importSkill(strToU8("not a zip"), dir)).rejects.toBeInstanceOf(SkillArchiveError);
    const big = zipSync({
      "SKILL.md": strToU8(md),
      "big.bin": new Uint8Array(SKILL_ARCHIVE_LIMITS.unpackedBytes + 1),
    });
    await expect(importSkill(big, dir)).rejects.toThrow(/too large/);
    const many = Object.fromEntries(
      Array.from({ length: SKILL_ARCHIVE_LIMITS.files + 1 }, (_, i) => [`f${i}.md`, strToU8("")]),
    );
    await expect(importSkill(zipSync({ ...many, "SKILL.md": strToU8(md) }), dir)).rejects.toThrow(
      /Too many files/,
    );
  });
});

describe("installing skills", () => {
  async function setup(installRoot = async () => join(dir, "installed")) {
    const { db } = await memoryDb();
    await migrate(db);
    await migrateExtensions(db);
    const builder = new ExtensionBuilder({
      db,
      store: new EventStore(db),
      testWorkspace: async (id) => {
        const d = join(dir, "tests", id);
        await mkdir(d, { recursive: true });
        return {
          workspace: new LocalWorkspace(d),
          dispose: () => rm(d, { recursive: true, force: true }),
        };
      },
      installRoot,
    });
    return { builder, installRoot: join(dir, "installed") };
  }
  const skill = (body: string) => ({
    kind: "skill" as const,
    name: "flaky-ci",
    description: "What to do when CI fails only on Windows",
    body,
    untestable_reason: "Instructions only, nothing to run.",
  });

  it("never lets an agent's auto-installed skill replace an existing one (G29.4)", async () => {
    const { builder, installRoot } = await setup();
    const tool = proposeTool(
      { id: "agent_cccccccc", ownerId: "me", projectId: "p" },
      builder,
      () => true,
    );
    expect(text(await tool.run(skill("First version of the instructions."), ctx))).toMatch(
      /is installed/,
    );
    const second = text(await tool.run(skill("Second version, replacing the first."), ctx));
    expect(second).toMatch(/waits for the user's approval/);
    expect(second).toMatch(/already installed/);
    const read = () => readFile(join(installRoot, "skills", "flaky-ci", "SKILL.md"), "utf8");
    expect(await read()).toMatch(/First version/);
    const [pending] = await builder.list("me", "pending");
    await builder.decide("me", pending?.id ?? "", "approve", "human");
    expect(await read()).toMatch(/Second version/);
  });

  it("lets the person replace their own skill directly", async () => {
    const { builder, installRoot } = await setup();
    const input = (body: string) => ({
      kind: "skill" as const,
      name: "tone",
      description: "House tone of voice",
      body,
      untestableReason: "Tone is judged by reading, not by a command.",
    });
    for (const body of ["Friendly, direct, no jargon.", "Formal, precise, no slang at all."]) {
      const p = await builder.propose({
        ownerId: "me",
        projectId: null,
        author: "human",
        input: input(body),
        autoInstall: true,
      });
      expect(p.status).toBe("installed");
    }
    expect(await readFile(join(installRoot, "skills", "tone", "SKILL.md"), "utf8")).toMatch(
      /Formal/,
    );
  });

  it("records installed only once the install worked", async () => {
    const { builder } = await setup(async () => {
      throw new Error("disk full");
    });
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
      autoInstall: true,
    });
    expect(p.status).toBe("failed");
    expect(p.report.at(-1)).toMatchObject({ name: "install", passed: false, detail: "disk full" });
  });
});
