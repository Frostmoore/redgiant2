import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspace } from "@redgiant/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitAll,
  createWorktree,
  ensureRepo,
  mergeWorktree,
  removeWorktree,
} from "../src/index.js";

let dir: string;
let ws: LocalWorkspace;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-wt-"));
  await writeFile(join(dir, "shared.txt"), "line 1\nline 2\n");
  ws = new LocalWorkspace(dir);
  await ensureRepo(ws);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("git worktrees per agent", () => {
  it("gives each agent its own copy and merges their work", async () => {
    const a = new LocalWorkspace(join(dir, await createWorktree(ws, "agent-A")));
    const b = new LocalWorkspace(join(dir, await createWorktree(ws, "agent-B")));
    await a.writeText("a.txt", "from A\n");
    await b.writeText("b.txt", "from B\n");
    expect(await b.exists("a.txt")).toBe(false);
    expect(await commitAll(a, "A: add a.txt")).toBe(true);
    expect(await commitAll(b, "B: add b.txt")).toBe(true);
    expect(await commitAll(b, "nothing")).toBe(false);

    expect(await mergeWorktree(ws, "agent-A")).toEqual({ ok: true, merged: true });
    expect(await mergeWorktree(ws, "agent-B")).toEqual({ ok: true, merged: true });
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("from A\n");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("from B\n");
    // Worktrees never show up as changes of the main workspace.
    expect((await ws.exec("git status --porcelain", { timeoutMs: 10_000 })).stdout).toBe("");
    await removeWorktree(ws, "agent-A", true);
    expect(await ws.exists(".worktrees/agent-a")).toBe(false);
  });

  it("reports conflicts and leaves the workspace untouched", async () => {
    const a = new LocalWorkspace(join(dir, await createWorktree(ws, "a")));
    const b = new LocalWorkspace(join(dir, await createWorktree(ws, "b")));
    await a.writeText("shared.txt", "line 1\nA was here\n");
    await b.writeText("shared.txt", "line 1\nB was here\n");
    await commitAll(a, "A");
    await commitAll(b, "B");
    expect(await mergeWorktree(ws, "a")).toEqual({ ok: true, merged: true });
    expect(await mergeWorktree(ws, "b")).toEqual({ ok: false, conflicts: ["shared.txt"] });
    expect(await readFile(join(dir, "shared.txt"), "utf8")).toBe("line 1\nA was here\n");
    expect((await ws.exec("git status --porcelain", { timeoutMs: 10_000 })).stdout).toBe("");
  });

  it("reuses an existing worktree", async () => {
    const first = await createWorktree(ws, "Agent X!");
    expect(first).toBe(".worktrees/agent-x-");
    expect(await createWorktree(ws, "Agent X!")).toBe(first);
  });
});
