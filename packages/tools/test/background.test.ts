// Background commands (p3.3.1): started by bash with background, every line logged with its
// time and stream; read, filtered, waited on, stopped with their tree; a limit per conversation.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackgroundCommands,
  bashOutputTool,
  bashTool,
  killTree,
  LocalWorkspace,
  parseLog,
  queryLog,
  secondsOf,
  summarizeLog,
} from "../src/index.js";

const posix = process.platform !== "win32";
let dir: string;
let ws: LocalWorkspace;
let bg: BackgroundCommands;
const ctx = (sessionId = "s1") =>
  ({ ownerId: "me", projectId: null, agentId: "a1", sessionId, callId: "c1" }) as never;
const text = (r: unknown) => (typeof r === "string" ? r : (r as { content: string }).content);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-bg-"));
  ws = new LocalWorkspace(dir);
  bg = new BackgroundCommands({ who: () => "Coder (agent a1), conversation s1" });
});
afterEach(async () => {
  await bg.stopAll();
  await rm(dir, { recursive: true, force: true });
});

describe.runIf(posix)("background commands", () => {
  it("logs every line with its time and stream, with a header and an end", async () => {
    const events: string[] = [];
    bg = new BackgroundCommands({
      who: () => "Coder",
      events: {
        started: (c) => void events.push(`started ${c.id} ${c.pid ? "pid" : "nopid"}`),
        ended: (c) => void events.push(`ended ${c.status} ${c.exitCode}`),
      },
    });
    const c = await bg.start(
      ws,
      "echo one; echo two >&2; printf 'no newline'; sleep 0.2; echo; exit 3",
      ctx(),
    );
    await bg.settled(c.id);
    const raw = readFileSync(join(dir, c.path), "utf8");
    expect(raw).toMatch(
      /^# command {2}cmd_[0-9a-f]{10}\n# started {2}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d\n# folder {3}/,
    );
    expect(raw).toContain("# by       Coder\n");
    expect(raw).toMatch(/\n\[\d\d:\d\d:\d\d\.\d{3} \+\d+\.\d{3}s\] out {2}one\n/);
    expect(raw).toMatch(/\] err {2}two\n/);
    expect(raw).toMatch(/# ended {4}.* exit 3 {2}after [\d.]+ s {2}\(failed\)\n$/);
    const log = parseLog(raw);
    expect(log.command).toContain("echo one");
    expect(log.lines.map((l) => [l.stream, l.text])).toEqual([
      ["out", "one"],
      ["err", "two"],
      ["out", "no newline"],
    ]);
    expect(log.ended).toMatchObject({ exit: 3, status: "failed" });
    expect(events).toEqual([`started ${c.id} pid`, "ended failed 3"]);
  });

  it("reads the new lines, filters by text, stream and time, and sums up", async () => {
    const c = await bg.start(
      ws,
      "echo starting; echo 'warning: slow disk'; sleep 1.2; echo 'Error: port in use' >&2; echo ready",
      ctx(),
    );
    await bg.settled(c.id);
    const first = bg.read(c.id);
    expect(first.lines.map((l) => l.text)).toEqual([
      "starting",
      "warning: slow disk",
      "Error: port in use",
      "ready",
    ]);
    // Read again: nothing new.
    expect(bg.read(c.id).lines).toEqual([]);
    expect(bg.read(c.id, { grep: "/^err/i" }).lines.map((l) => l.n)).toEqual([3]);
    expect(bg.read(c.id, { stream: "err" }).lines.map((l) => l.text)).toEqual([
      "Error: port in use",
    ]);
    expect(bg.read(c.id, { since: "+1" }).lines.map((l) => l.text)).toEqual([
      "Error: port in use",
      "ready",
    ]);
    expect(bg.read(c.id, { until: "1" }).lines).toHaveLength(2);
    // A clock time works too.
    const log = bg.log(c.id);
    expect(secondsOf(log.lines[3]?.clock ?? "", log)).toBeCloseTo(log.lines[3]?.at ?? 0, 0);
    expect(bg.read(c.id, { tail: true, lines: 1 })).toMatchObject({ more: 3 });
    const sum = summarizeLog(log);
    expect(sum).toMatch(/^4 lines \(1 on stderr\); 1 look like errors, 1 like warnings\./);
    expect(sum).toContain("error? 3");
  });

  it("waits for a text, and stops the command with what it started", async () => {
    const tool = bashTool(ws, "full", 30_000, bg);
    const out = bashOutputTool(bg, "full");
    const started = text(
      await tool.run(
        {
          command: "sleep 30 & echo $! > child.pid; sleep 0.3; echo 'server ready'; wait",
          background: true,
        },
        ctx(),
      ),
    );
    const id = started.match(/as (cmd_[0-9a-f]+)/)?.[1] as string;
    expect(started).toMatch(/Keep it verbose/);
    const waited = text(await out.run({ id, wait_for: "server ready", timeout_s: 10 }, ctx()));
    expect(waited).toMatch(/«server ready» appeared/);
    expect(waited).toMatch(/\] out {2}server ready/);
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    expect(alive(child)).toBe(true);
    const stopped = text(await out.run({ id, stop: true }, ctx()));
    expect(stopped).toMatch(/\(stopped\)/);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(child)).toBe(false);
    expect(text(await out.run({}, ctx()))).toContain(`${id} (stopped)`);
    // Another conversation sees nothing of it.
    expect(text(await out.run({ id }, ctx("s2")))).toMatch(/no background command/);
  });

  it("keeps to the limit per conversation, and stops a conversation's commands", async () => {
    bg = new BackgroundCommands({ maxPerSession: 2 });
    const a = await bg.start(ws, "sleep 30", ctx());
    await bg.start(ws, "sleep 30", ctx());
    await expect(bg.start(ws, "sleep 30", ctx())).rejects.toThrow(/limit is 2/);
    // Another conversation has its own.
    const other = await bg.start(ws, "sleep 30", ctx("s2"));
    await bg.stopSession("s1");
    expect(bg.list("s1").map((c) => c.status)).toEqual(["stopped", "stopped"]);
    expect(bg.get(other.id)?.status).toBe("running");
    expect(a.pid && alive(a.pid)).toBe(false);
  });

  it("keeps the latest lines past its ceiling, saying how many went", async () => {
    bg = new BackgroundCommands({ maxBytes: 4000 });
    const c = await bg.start(ws, "for i in $(seq 1 300); do echo line $i; done", ctx());
    await bg.settled(c.id);
    const log = bg.log(c.id);
    expect(log.dropped).toBeGreaterThan(0);
    expect(log.lines.at(-1)).toMatchObject({ n: 300, text: "line 300" });
    expect(log.lines[0]?.n).toBe(log.dropped + 1);
    expect(log.command).toContain("seq 1 300");
    expect(readFileSync(join(dir, c.path)).length).toBeLessThan(4200);
  });

  it("is not available without the commands' manager", async () => {
    const r = await bashTool(ws, "full").run({ command: "true", background: true }, ctx());
    expect(text(r)).toMatch(/not available/);
  });
});

describe("stopping a tree", () => {
  it("uses taskkill with the tree on Windows, the process group elsewhere", () => {
    const runs: string[][] = [];
    killTree(4242, "win32", (file, args) => void runs.push([file, ...args]));
    expect(runs).toEqual([["taskkill", "/PID", "4242", "/T", "/F"]]);
    const kills: [number, string][] = [];
    killTree(77, "linux", undefined, (pid, sig) => void kills.push([pid, sig]));
    expect(kills).toEqual([[-77, "SIGKILL"]]);
  });

  it("parses a log made elsewhere (the server reads it after a restart)", () => {
    const log = parseLog(
      "# command  cmd_1\n# started  2026-11-07 15:03:12.000 +01:00\n# dropped  5 older lines\n[15:03:20.000 +8.000s] err  boom\n",
    );
    expect(log.lines).toEqual([
      { n: 6, clock: "15:03:20.000", at: 8, stream: "err", text: "boom" },
    ]);
    expect(secondsOf("15:03:22", log)).toBeCloseTo(10, 3);
    expect(queryLog(log, { since: "15:03:15" })).toHaveLength(1);
  });
});
