import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequestInfo } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { readRequest, releaseFile, writeJson } from "@redgiant/supervisor";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceOptions } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
let dirs: string[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const d of dirs)
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dirs = [];
});

// A stand-in for RedGiant's source: built.txt comes from version.txt; the "server" answers with it.
const APP = `import http from "node:http";
import { readFileSync } from "node:fs";
const v = readFileSync("built.txt", "utf8").trim();
if (v === "crashes") process.exit(1);
http.createServer((req, res) => res.end(v)).listen(Number(process.env.REDGIANT_PORT), "127.0.0.1");
`;
const BUILD = `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("built.txt", readFileSync("version.txt", "utf8"));
`;
const TEST = `import { readFileSync } from "node:fs";
if (readFileSync("version.txt", "utf8").includes("fail")) { console.error("1 test failed: version"); process.exit(1); }
`;

async function source(supervised: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "rg-src-"));
  const stateDir = await mkdtemp(join(tmpdir(), "rg-state-"));
  dirs.push(dir, stateDir);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir })
      .toString()
      .trim();
  git("init", "-q");
  await writeFile(join(dir, "app.mjs"), APP);
  await writeFile(join(dir, "build.mjs"), BUILD);
  await writeFile(join(dir, "test.mjs"), TEST);
  await writeFile(join(dir, "version.txt"), "v1");
  await writeFile(join(dir, ".gitignore"), "built.txt\n");
  git("add", "-A");
  git("commit", "-q", "-m", "v1");
  const restarts: number[] = [];
  const node = `"${process.execPath}"`;
  const opts: SourceOptions = {
    dir,
    stateDir,
    steps: [
      { name: "build", command: `${node} build.mjs` },
      { name: "test", command: `${node} test.mjs` },
    ],
    canary: { command: process.execPath, args: ["app.mjs"], healthPath: "/", smokePath: "/" },
    ...(supervised && { restart: () => restarts.push(Date.now()) }),
  };
  return { opts, git, restarts, stateDir };
}

const results = (req: CompletionRequest) =>
  req.messages.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])),
  );

/** God: start a change, write the new version, test it, promote it. */
const god = (version: string) => (req: CompletionRequest) => {
  const done = results(req);
  const id = done[0]?.match(/chg_[0-9a-f]+/)?.[0] ?? "";
  const next = [
    { name: "platform_code_start", input: { title: `Version ${version}` } },
    { name: "write_file", input: { path: `changes/${id}/version.txt`, content: version } },
    { name: "platform_code_test", input: { change_id: id } },
    { name: "platform_code_promote", input: { change_id: id } },
  ][done.length];
  return next ? { toolCalls: [next] } : { text: done.at(-1) ?? "" };
};

async function run(version: string, supervised = true) {
  const src = await source(supervised);
  s = await startServer(god(version), {}, { source: src.opts });
  const g = await s.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const asked: PermissionRequestInfo[] = [];
  s.core.approvals.on("request", (owner, info) => {
    asked.push(info);
    s?.core.approvals.decide(owner, info.requestId, "allow");
  });
  const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id }))
    .body.sessionId;
  await (await s.core.send("me", sid, "change the version")).done;
  const outputs = (await s.core.history("me", sid))
    .filter((e) => e.type === "tool.result")
    .map((e) => e.payload as { ok: boolean; output: string });
  const [change] = await s.core.changes.list("me");
  return { ...src, asked, outputs, change, core: s.core };
}

describe("God's changes to RedGiant's own code", () => {
  it("tests a change in a worktree, with a trial copy, and promotes it through the supervisor", async () => {
    const { asked, outputs, change, git, restarts, stateDir, core } = await run("v2");
    // Opening a change and editing files ask nobody; testing and promoting ask the human.
    expect(asked.map((a) => a.tool)).toEqual(["platform_code_test", "platform_code_promote"]);
    expect(outputs[2]?.output).toMatch(
      /^PASSED[\s\S]*## build: ok\n## test: ok\n## trial copy: healthy/,
    );
    expect(outputs[3]?.output).toMatch(/^Merged as [0-9a-f]{8}/);
    expect(await readFile(join(git("rev-parse", "--show-toplevel"), "version.txt"), "utf8")).toBe(
      "v2",
    );
    const req = await readRequest(stateDir);
    expect(req).toMatchObject({
      changeId: change?.id,
      ownerId: "me",
      commit: git("rev-parse", "HEAD"),
    });
    await new Promise((r) => setTimeout(r, 1700));
    expect(restarts).toHaveLength(1);

    // After the restart the supervisor reports; the server records it and tells the owner.
    const notes: string[] = [];
    core.notify = async (_o, text) => {
      notes.push(text);
    };
    await writeJson(releaseFile(stateDir), {
      lastGood: req?.commit,
      built: req?.commit,
      history: [{ ...req, result: "promoted", at: new Date().toISOString() }],
    });
    // The supervisor confirms only after the new version stayed up: the server keeps watching.
    core.code?.watch(50);
    await new Promise((r) => setTimeout(r, 300));
    core.code?.unwatch();
    expect((await core.changes.get("me", change?.id ?? ""))?.stage).toBe("promoted");
    // God picks up the turn the restart cut, and its answer reaches the owner too.
    for (let i = 0; i < 100 && notes.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    expect(notes[0]).toBe(`Platform change live: Version v2 (${req?.commit.slice(0, 8)})`);
    expect(notes.slice(1)).toHaveLength(1);
    const godSession = (await core.history("me", (await core.listSessions("me"))[0]?.id ?? ""))
      .filter((e) => e.type === "message.user")
      .map((e) => (e.payload as { text: string }).text);
    expect(godSession.at(-1)).toMatch(/is live: RedGiant restarted on version/);
  });

  it("records a failing change and never promotes it", async () => {
    const { outputs, change, git } = await run("v2-fail");
    expect(outputs[2]?.output).toMatch(/^FAILED[\s\S]*## test: FAILED[\s\S]*1 test failed/);
    expect(change?.stage).toBe("failed");
    expect(outputs[3]).toMatchObject({ ok: false });
    expect(outputs[3]?.output).toMatch(/Promote only what passed/);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("refuses to promote without a supervisor", async () => {
    const { outputs, change } = await run("v3", false);
    expect(outputs[2]?.output).toMatch(/^PASSED[\s\S]*not possible here/);
    expect(outputs[3]?.output).toMatch(/not running under the supervisor/);
    expect(change?.stage).toBe("tested");
  });

  it("reports a rollback, and the change can be tested again", async () => {
    const { change, stateDir, core } = await run("v3");
    const req = await readRequest(stateDir);
    const notes: string[] = [];
    core.notify = async (_o, text) => {
      notes.push(text);
    };
    await writeJson(releaseFile(stateDir), {
      lastGood: "abc",
      built: "abc",
      history: [
        {
          commit: req?.commit,
          result: "rolled_back",
          reason: "the server exited (code 1)\nstack…",
          changeId: change?.id,
          ownerId: "me",
          at: new Date().toISOString(),
        },
      ],
    });
    await core.code?.reconcile();
    expect((await core.changes.get("me", change?.id ?? ""))?.stage).toBe("rolled_back");
    expect(notes[0]).toBe(
      "Platform change rolled back: Version v3\nthe server exited (code 1)\nThe previous version is running.",
    );
    // The verdict is recorded once, and the change stays open: test it again.
    await core.code?.reconcile();
    expect(notes.filter((n) => n.startsWith("Platform change rolled back"))).toHaveLength(1);
    const again = await core.code?.test("me", "human", change?.id ?? "");
    expect(again?.passed).toBe(true);
  });

  it("a trial copy that does not come up fails the test", async () => {
    const { outputs, change } = await run("crashes");
    expect(outputs[2]?.output).toMatch(/## trial copy: FAILED[\s\S]*exited/);
    expect(change?.stage).toBe("failed");
  });
});
