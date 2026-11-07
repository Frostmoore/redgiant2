import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@redgiant/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalWorkspace,
  PathOutsideWorkspaceError,
  type ShowFileRequest,
  SubprojectWorkspace,
  showFileTool,
} from "../src/index.js";

let dir: string;
let other: string;
let ws: LocalWorkspace;
const ctx: ToolContext = { ownerId: "local", projectId: "p", agentId: "a", sessionId: "s" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-show-"));
  other = await mkdtemp(join(tmpdir(), "rg-show-out-"));
  await mkdir(join(dir, "out"), { recursive: true });
  await mkdir(join(dir, "apps/shop"), { recursive: true });
  await mkdir(join(dir, "apps/admin"), { recursive: true });
  await mkdir(join(dir, ".attachments/2026-11-07"), { recursive: true });
  await writeFile(join(dir, "out/clip.mp4"), Buffer.alloc(2048));
  await writeFile(join(dir, "apps/admin/secret.pdf"), "%PDF-1.4");
  await writeFile(join(dir, ".attachments/2026-11-07/x-photo.png"), "png");
  await writeFile(join(other, "notes.txt"), "outside");
  ws = new LocalWorkspace(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

const make = (w = ws as LocalWorkspace | SubprojectWorkspace) => {
  const shown: ShowFileRequest[] = [];
  const tool = showFileTool(w, "full", async (r) => {
    shown.push(r);
    return undefined;
  });
  const run = async (input: { path: string; title?: string }) => {
    const out = await tool.run(input, ctx);
    return typeof out === "string" ? { content: out, isError: false } : { isError: false, ...out };
  };
  return { shown, run };
};

describe("show_file (G34.1)", () => {
  it("opens a workspace file through the host, with its title and size", async () => {
    const { shown, run } = make();
    const r = await run({ path: "out/clip.mp4" });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("clip.mp4");
    expect(shown).toEqual([
      expect.objectContaining({
        path: "out/clip.mp4",
        outside: false,
        title: "clip.mp4",
        size: 2048,
      }),
    ]);
    await run({ path: ".attachments/2026-11-07/x-photo.png", title: "  The photo " });
    expect(shown[1]?.title).toBe("The photo");
  });

  it("refuses what is not there, and folders (show opens those)", async () => {
    const { shown, run } = make();
    expect((await run({ path: "nope.pdf" })).isError).toBe(true);
    const folder = await run({ path: "out" });
    expect(folder.isError).toBe(true);
    expect(folder.content).toContain("folder");
    expect(shown).toEqual([]);
  });

  it("never reads through a link that leaves the workspace", async () => {
    await symlink(join(other, "notes.txt"), join(dir, "out/link.txt"));
    const { shown, run } = make();
    // Refused by the workspace itself, or by the real-path check after it.
    const r = await run({ path: "out/link.txt" }).catch((e: unknown) => e);
    expect(r instanceof PathOutsideWorkspaceError || (r as { isError?: boolean }).isError).toBe(
      true,
    );
    expect(shown).toEqual([]);
  });

  it("does not show another subproject's files", async () => {
    const sub = new SubprojectWorkspace(ws, "apps/shop", ["apps/admin"]);
    const { shown, run } = make(sub);
    expect((await run({ path: "apps/admin/secret.pdf" })).isError).toBe(true);
    expect(shown).toEqual([]);
  });

  it("a file outside the workspace (the guardian let it through) is marked as outside", async () => {
    const { shown, run } = make();
    const r = await run({ path: join(other, "notes.txt") });
    expect(r.isError).toBe(false);
    expect(shown[0]).toMatchObject({ outside: true, title: "notes.txt" });
    expect((await run({ path: join(other, "missing.txt") })).isError).toBe(true);
  });

  it("says so without a canvas", async () => {
    const r = await showFileTool(ws, "compact").run({ path: "out/clip.mp4" }, ctx);
    expect(r).toMatchObject({ isError: true });
  });
});
