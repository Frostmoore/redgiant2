import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRelease, requestFile, Supervisor, writeJson } from "../src/index.js";

/** A stand-in for the RedGiant server: its behaviour depends on version.txt. */
const APP = `import http from "node:http";
import { readFileSync } from "node:fs";
const v = readFileSync("built.txt", "utf8").trim();
if (v === "crashes") process.exit(1);
const port = Number(process.env.REDGIANT_PORT);
http.createServer((req, res) => {
  if (req.url === "/restart") { res.end("ok"); setTimeout(() => process.exit(75), 20); return; }
  res.statusCode = v === "unhealthy" ? 500 : 200;
  res.end(v);
}).listen(port, "127.0.0.1");
if (v === "dies-soon") setTimeout(() => process.exit(3), 300);
`;
const BUILD = `import { readFileSync, writeFileSync } from "node:fs";
const v = readFileSync("version.txt", "utf8").trim();
if (v === "does-not-build") { console.error("syntax error in app"); process.exit(1); }
writeFileSync("built.txt", v);
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

let dirs: string[] = [];
let sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups) await s.stop();
  for (const d of dirs)
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  dirs = [];
  sups = [];
});

async function setup() {
  const src = await mkdtemp(join(tmpdir(), "rg-sup-src-"));
  const state = await mkdtemp(join(tmpdir(), "rg-sup-state-"));
  dirs.push(src, state);
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: src })
      .toString()
      .trim();
  git("init", "-q");
  await writeFile(join(src, "app.mjs"), APP);
  await writeFile(join(src, "build.mjs"), BUILD);
  await writeFile(join(src, ".gitignore"), "built.txt\n");
  const commit = async (version: string) => {
    await writeFile(join(src, "version.txt"), version);
    git("add", "-A");
    git("commit", "-q", "-m", version);
    return git("rev-parse", "HEAD");
  };
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const sup = new Supervisor({
    sourceDir: src,
    stateDir: state,
    build: `"${process.execPath}" build.mjs`,
    start: { command: process.execPath, args: ["app.mjs"] },
    env: { ...process.env, REDGIANT_PORT: String(port) },
    healthUrl: url,
    healthTimeoutMs: 5000,
    stableMs: 600,
    stdio: "ignore",
    log: () => {},
  });
  sups.push(sup);
  const serving = async () =>
    fetch(url)
      .then((r) => r.text())
      .catch(() => "");
  const until = async (pred: () => boolean | Promise<boolean>, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** What the server does when God promotes: the change goes in, then exit 75. */
  const promote = async (version: string, changeId: string) => {
    const c = await commit(version);
    await writeJson(requestFile(state), { changeId, ownerId: "local", commit: c });
    await fetch(`${url}/restart`);
    return c;
  };
  return { sup, state, git, commit, serving, until, promote };
}

describe("Supervisor", () => {
  it("promotes a good version and rolls back every broken one by itself", async () => {
    const { sup, state, git, commit, serving, until, promote } = await setup();
    const v1 = await commit("v1");
    void sup.run();
    await until(async () => (await serving()) === "v1");
    await until(() => sup.release.lastGood === v1);

    const v2 = await promote("v2", "chg_good");
    await until(() => sup.release.lastGood === v2);
    expect(await serving()).toBe("v2");

    for (const [broken, reason] of [
      ["crashes", /exited \(code 1\)/],
      ["unhealthy", /no answer to the health check/],
      // Dies right after answering the health check; on a loaded machine sometimes before the
      // check is seen: the exit code tells it from the others either way (flaky in CI before).
      ["dies-soon", /exited \(code 3\)/],
      ["does-not-build", /build failed:[\s\S]*syntax error in app/],
    ] as const) {
      const bad = await promote(broken, `chg_${broken}`);
      await until(() => sup.release.history.some((h) => h.commit === bad), 30_000);
      await until(async () => (await serving()) === "v2");
      expect(git("rev-parse", "HEAD")).toBe(v2);
      const entry = sup.release.history.find((h) => h.commit === bad);
      expect(entry).toMatchObject({ result: "rolled_back", changeId: `chg_${broken}` });
      expect(entry?.reason).toMatch(reason);
    }
    expect(sup.release.lastGood).toBe(v2);

    // The state survives the supervisor: the server reads it at startup.
    const saved = await readRelease(state);
    expect(saved.history.map((h) => [h.changeId, h.result])).toEqual([
      ["chg_good", "promoted"],
      ["chg_crashes", "rolled_back"],
      ["chg_unhealthy", "rolled_back"],
      ["chg_dies-soon", "rolled_back"],
      ["chg_does-not-build", "rolled_back"],
    ]);
    await expect(readFile(requestFile(state))).rejects.toThrow();
  }, 120_000);

  it("restarts a healthy version that crashes later, without rolling it back", async () => {
    const { sup, commit, serving, until } = await setup();
    const v1 = await commit("v1");
    void sup.run();
    await until(async () => (await serving()) === "v1");
    await until(() => sup.release.lastGood === v1);
    // Killed from outside (not a restart request): it comes back as it was.
    process.kill(sup.pid as number, "SIGKILL");
    await until(async () => (await serving()) === "");
    await until(async () => (await serving()) === "v1");
    expect(sup.release.history).toEqual([]);
  }, 60_000);
});
