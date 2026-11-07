// Skills that come by themselves (G36.8): an agent's proposal that repeats an installed skill
// becomes an update to it, scripts always wait for the person, a newer proposal of the same
// skill takes the place of the one waiting, and the person sees what an update replaces.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@redgiant/agent";
import { EventStore, migrate } from "@redgiant/events";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExtensionBuilder,
  migrateExtensions,
  proposeTool,
  scriptFiles,
  skillLikeness,
} from "../src/index.js";
import { memoryDb } from "./pglite.js";

const ctx: ToolContext = { ownerId: "me", projectId: null, agentId: "a", sessionId: "s" };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-skillprop-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);

async function setup(auto = true) {
  const { db } = await memoryDb();
  await migrate(db);
  await migrateExtensions(db);
  const root = join(dir, "installed");
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
    installRoot: async () => root,
  });
  const tool = proposeTool({ id: "agent_x", ownerId: "me", projectId: null }, builder, () => auto);
  return { builder, tool, root };
}

const flaky = {
  kind: "skill" as const,
  name: "windows-ci-flakes",
  description: "What to do when CI fails only on Windows runners because of paths",
  body: "Use path.join, never '/'. Retry the npm cache step once.",
  untestable_reason: "Instructions only, nothing to run here.",
  summary: "CI failed only on Windows; the fix was path.join and a cache retry.",
};

describe("skills that come by themselves (G36.8)", () => {
  it("says how alike two skills are", () => {
    expect(
      skillLikeness(
        {
          name: "windows-ci-flakes",
          description: "What to do when CI fails only on Windows runners",
        },
        {
          name: "ci-windows-failures",
          description: "When CI fails only on Windows runners: what to do",
        },
      ),
    ).toBeGreaterThan(0.5);
    expect(
      skillLikeness(
        { name: "release-notes", description: "Write release notes from the git log" },
        { name: "sql-migrations", description: "Safe SQL migrations with a rollback" },
      ),
    ).toBe(0);
    expect(scriptFiles({ "a.md": "x", "run.sh": "echo", tool: "#!/usr/bin/env node\n" })).toEqual([
      "run.sh",
      "tool",
    ]);
  });

  it("installs an agent's instructions-only skill and keeps its summary", async () => {
    const { tool, builder, root } = await setup();
    expect(text(await tool.run(flaky, ctx))).toMatch(/is installed/);
    const [p] = await builder.list("me");
    expect(p?.input).toMatchObject({ summary: flaky.summary });
    expect(p?.previous).toBeNull();
    expect(await readFile(join(root, "skills", "windows-ci-flakes", "SKILL.md"), "utf8")).toMatch(
      /path\.join/,
    );
  });

  it("turns a skill like an installed one into an update instead of a twin", async () => {
    const { tool } = await setup();
    await tool.run(flaky, ctx);
    const twin = await tool.run(
      {
        ...flaky,
        name: "ci-windows-failures",
        description: "When CI fails only on Windows runners because of paths: what to do",
      },
      ctx,
    );
    expect(text(twin)).toMatch(/already installed: "windows-ci-flakes".*updates true/s);
    expect((twin as { isError?: boolean }).isError).toBe(true);
    // A different skill goes in.
    const other = await tool.run(
      {
        ...flaky,
        name: "release-notes",
        description: "Write release notes from the git log, grouped by feature",
        body: "Read git log since the last tag and group the commits.",
      },
      ctx,
    );
    expect(text(other)).toMatch(/is installed/);
    // An update of a skill that does not exist is refused.
    expect(text(await tool.run({ ...flaky, name: "nope-skill", updates: true }, ctx))).toMatch(
      /no skill "nope-skill"/,
    );
  });

  it("an update waits, shows what it replaces and keeps the files it does not rewrite", async () => {
    const { tool, builder, root } = await setup();
    await tool.run(flaky, ctx);
    const skill = join(root, "skills", "windows-ci-flakes");
    await writeFile(join(skill, "notes.md"), "Seen on runner windows-2025.\n");
    const r = text(
      await tool.run(
        {
          ...flaky,
          updates: true,
          body: "Use path.join; also set core.autocrlf false on checkout.",
        },
        ctx,
      ),
    );
    expect(r).toMatch(/an update of the skill "windows-ci-flakes".*waits/);
    const [p] = await builder.list("me", "pending");
    expect(p?.previous?.skillMd).toMatch(/Retry the npm cache/);
    expect(p?.previous?.files).toEqual(["notes.md"]);
    await builder.decide("me", p?.id ?? "", "approve", "human");
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toMatch(/autocrlf/);
    expect(await readFile(join(skill, "notes.md"), "utf8")).toMatch(/windows-2025/);
  });

  it("never installs an agent's scripts by itself, and a newer proposal replaces the waiting one", async () => {
    const { tool, builder, root } = await setup();
    const withScript = {
      ...flaky,
      name: "csv-clean",
      description: "Clean a CSV file exported from the bank before reading it",
      body: "Run clean.sh on the file first, then read it.",
      files: { "clean.sh": "#!/bin/sh\ntr -d '\\r' < \"$1\"\n" },
    };
    const first = text(await tool.run(withScript, ctx));
    expect(first).toMatch(/waits for the user's approval/);
    expect(first).toMatch(/scripts: It has scripts \(clean\.sh\)/);
    expect(
      await readFile(join(root, "skills", "csv-clean", "SKILL.md")).catch(() => undefined),
    ).toBeUndefined();
    await tool.run(
      { ...withScript, body: "Run clean.sh on the file first; then read it as UTF-8." },
      ctx,
    );
    const all = await builder.list("me");
    expect(all.map((p) => [p.status, p.decidedBy?.split(":")[0] ?? null])).toEqual([
      ["pending", null],
      ["rejected", "superseded"],
    ]);
  });
});
