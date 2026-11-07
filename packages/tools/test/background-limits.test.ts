// The person's limits for commands (G36.16): how many background commands at once (or no limit),
// how long they run (or until stopped), the log's ceiling (or none), and bash's longest wait.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackgroundCommands,
  type BackgroundLimits,
  bashTool,
  type ExecOptions,
  LocalWorkspace,
  type Workspace,
} from "../src/index.js";

const posix = process.platform !== "win32";
let dir: string;
let ws: LocalWorkspace;
let bg: BackgroundCommands | undefined;
const ctx = (sessionId = "s1") =>
  ({ ownerId: "me", projectId: null, agentId: "a1", sessionId, callId: "c1" }) as never;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-bgl-"));
  ws = new LocalWorkspace(dir);
});
afterEach(async () => {
  await bg?.stopAll();
  bg = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A workspace that records what exec was asked, and ends at once. */
function recording(): { ws: Workspace; seen: ExecOptions[] } {
  const seen: ExecOptions[] = [];
  const fake = {
    root: dir,
    exec: async (_c: string, o: ExecOptions) => {
      seen.push(o);
      o.onSpawn?.(1);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  } as unknown as Workspace;
  return { ws: fake, seen };
}

describe("the person's limits (G36.16)", () => {
  it("reads them per owner when a command starts: a number at once, or no limit", async () => {
    let limits: BackgroundLimits = { maxPerSession: 1, maxMs: 60_000, maxBytes: null };
    bg = new BackgroundCommands({ limits: () => limits });
    if (!posix) return;
    await bg.start(ws, "sleep 5", ctx());
    await expect(bg.start(ws, "sleep 5", ctx())).rejects.toThrow(/person's limit is 1/);
    limits = { ...limits, maxPerSession: null };
    for (let i = 0; i < 5; i++) await bg.start(ws, "sleep 5", ctx());
    expect(bg.list("s1").filter((c) => c.status === "running")).toHaveLength(6);
  });

  it("no time limit: the command gets Infinity and keeps running past the old ceiling", async () => {
    const r = recording();
    bg = new BackgroundCommands({
      limits: () => ({ maxPerSession: null, maxMs: null, maxBytes: null }),
    });
    await bg.start(r.ws, "serve", ctx());
    expect(r.seen[0]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
    bg = new BackgroundCommands({
      limits: () => ({ maxPerSession: 2, maxMs: 3_600_000, maxBytes: null }),
    });
    await bg.start(r.ws, "serve", ctx());
    expect(r.seen[1]?.timeoutMs).toBe(3_600_000);
  });

  it.runIf(posix)("a local command with no time limit is not cut at once", async () => {
    const out = await ws.exec("sleep 0.2; echo fine", { timeoutMs: Number.POSITIVE_INFINITY });
    expect(out).toMatchObject({ exitCode: 0, timedOut: false });
    expect(out.stdout).toContain("fine");
  });

  it.runIf(posix)("the log's ceiling: dropped lines past it, none without one", async () => {
    bg = new BackgroundCommands({
      limits: () => ({ maxPerSession: null, maxMs: null, maxBytes: 1024 }),
    });
    const small = await bg.start(ws, "for i in $(seq 1 300); do echo line $i; done", ctx());
    await bg.waitFor(small.id, "\u0000never", 5000);
    expect(readFileSync(small.file, "utf8")).toContain("# dropped");
    bg = new BackgroundCommands({
      limits: () => ({ maxPerSession: null, maxMs: null, maxBytes: null }),
    });
    const all = await bg.start(ws, "for i in $(seq 1 300); do echo line $i; done", ctx());
    await bg.waitFor(all.id, "\u0000never", 5000);
    const log = readFileSync(all.file, "utf8");
    expect(log).not.toContain("# dropped");
    expect(log).toContain("line 1\n");
    expect(log).toContain("line 300");
  });

  it("bash: a longer timeout_ms is cut to the person's maximum, and the agent is told", async () => {
    const r = recording();
    const tool = bashTool(r.ws, "full", 30_000, undefined, () => 60_000);
    const out = text(await tool.run({ command: "make", timeout_ms: 900_000 }, ctx()));
    expect(r.seen[0]?.timeoutMs).toBe(60_000);
    expect(out).toContain("cut to 60 s");
    const plain = bashTool(r.ws, "full", 30_000, undefined, () => 3_600_000);
    expect(text(await plain.run({ command: "make", timeout_ms: 900_000 }, ctx()))).not.toContain(
      "cut",
    );
    expect(r.seen[1]?.timeoutMs).toBe(900_000);
    // The description does not change with the setting (the prompt's prefix stays stable).
    expect(tool.def.description).toBe(plain.def.description);
    expect(tool.schema.safeParse({ command: "x", timeout_ms: 7_200_000 }).success).toBe(true);
  });
});
