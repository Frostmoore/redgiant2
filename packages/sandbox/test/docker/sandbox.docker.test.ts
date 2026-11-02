import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ContainerWorkspace,
  commitAll,
  createWorktree,
  DockerSandboxProvider,
  ensureRepo,
  mergeWorktree,
  type Sandbox,
} from "../../src/index.js";

/**
 * Integration with a real Docker engine (`pnpm test:docker`, never in CI).
 *   REDGIANT_SANDBOX_IMAGE   default redgiant/sandbox:dev (docker/sandbox.Dockerfile)
 *   REDGIANT_TEST_DIR        a directory with the same path for this process and the engine
 *   REDGIANT_TEST_OUTBOUND   network the egress proxy uses to go out (default bridge)
 */
const env = process.env;
const image = env.REDGIANT_SANDBOX_IMAGE ?? "redgiant/sandbox:dev";
const base = resolve(env.REDGIANT_TEST_DIR ?? "/mnt/fast-data/rg-test", `run-${Date.now()}`);
const outbound = env.REDGIANT_TEST_OUTBOUND ?? "bridge";
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../../dist");
const docker = new Docker();
const NET = "rg-test-internal";
const SECRET = "Bearer real-secret-never-in-sandbox";

let upstream: http.Server;
let provider: DockerSandboxProvider;
let sandbox: Sandbox;
let ws: ContainerWorkspace;
let egress: Docker.Container;

const sh = (cmd: string, timeoutMs = 30_000) => ws.exec(cmd, { timeoutMs });
const myIp = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";

beforeAll(async () => {
  await mkdir(join(base, "project"), { recursive: true });
  upstream = http.createServer((req, res) =>
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null })),
  );
  await new Promise<void>((ok) => upstream.listen(0, "0.0.0.0", ok));
  const upPort = (upstream.address() as { port: number }).port;

  provider = new DockerSandboxProvider({
    image,
    network: NET,
    egressProxyUrl: "http://rg-test-egress:3128",
    prefix: "rg-test-sbx",
  });
  await provider.ensureNetwork();

  await writeFile(
    join(base, "policy.json"),
    JSON.stringify({
      allow: ["example.com"],
      routes: {
        echo: { upstream: `http://${myIp()}:${upPort}/`, headers: { Authorization: SECRET } },
      },
    }),
  );
  await docker
    .getContainer("rg-test-egress")
    .remove({ force: true })
    .catch(() => {});
  egress = await docker.createContainer({
    name: "rg-test-egress",
    Image: "node:22-alpine",
    Cmd: ["node", "/app/egress-main.js", "/policy.json", "3128"],
    HostConfig: {
      NetworkMode: outbound,
      Mounts: [
        { Type: "bind", Source: dist, Target: "/app", ReadOnly: true },
        { Type: "bind", Source: join(base, "policy.json"), Target: "/policy.json", ReadOnly: true },
      ],
    },
  });
  await docker
    .getNetwork(NET)
    .connect({ Container: egress.id, EndpointConfig: { Aliases: ["rg-test-egress"] } });
  await egress.start();

  sandbox = await provider.create({
    id: "main",
    localPath: join(base, "project"),
    mount: { type: "bind", source: join(base, "project") },
    limits: { cpus: 0.5, memoryMb: 256, pids: 64 },
  });
  ws = sandbox.workspace() as ContainerWorkspace;
});

afterAll(async () => {
  await provider?.removeAll();
  await egress?.remove({ force: true }).catch(() => {});
  await docker
    .getNetwork(NET)
    .remove()
    .catch(() => {});
  await new Promise((ok) => upstream?.close(ok));
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(!env.REDGIANT_DOCKER_TESTS)("Docker sandbox", () => {
  it("runs commands in the container and shares files with the core", async () => {
    await ws.writeText("from-core.txt", "hello\n");
    const r = await sh("cat from-core.txt && echo made-in-container > from-sandbox.txt && exit 3");
    expect(r).toMatchObject({ stdout: "hello\n", exitCode: 3, timedOut: false });
    expect(await ws.readText("from-sandbox.txt")).toBe("made-in-container\n");
  });

  it("runs a sandbox on another image when asked (a subproject's own tools, G24.14c)", async () => {
    const other = await provider.create({
      id: "other-image",
      localPath: join(base, "project"),
      mount: { type: "bind", source: join(base, "project") },
      // Any image with bash and coreutils (the sandbox runs commands with them).
      image: "python:3.12-slim",
    });
    const r = await other.workspace().exec("python3 --version", { timeoutMs: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^Python 3\.12/);
    // The same folder as the project's own sandbox.
    expect((await other.workspace().exec("cat from-core.txt", { timeoutMs: 30_000 })).stdout).toBe(
      "hello\n",
    );
    await other.destroy();
  });

  it("enforces limits and drops every capability", async () => {
    expect((await sh("cat /sys/fs/cgroup/memory.max")).stdout.trim()).toBe(
      String(256 * 1024 * 1024),
    );
    expect((await sh("cat /sys/fs/cgroup/pids.max")).stdout.trim()).toBe("64");
    expect((await sh("cat /sys/fs/cgroup/cpu.max")).stdout.trim()).toBe("50000 100000");
    expect((await sh("grep CapEff /proc/self/status")).stdout).toMatch(
      /CapEff:\s+0000000000000000/,
    );
  });

  it("times out and aborts long commands", async () => {
    const t = await ws.exec("sleep 30", { timeoutMs: 1500 });
    expect(t).toMatchObject({ timedOut: true, exitCode: 137 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 500);
    await ws.exec("sleep 30", { timeoutMs: 60_000, signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("has no direct way out: only the egress proxy, and only to allowed hosts", async () => {
    const direct = await sh("curl -sS -m 5 --noproxy '*' https://example.com -o /dev/null", 20_000);
    expect(direct.exitCode).not.toBe(0);
    const allowed = await sh(
      "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com",
      30_000,
    );
    expect(allowed.stdout).toBe("200");
    const blocked = await sh("curl -sS -m 10 https://www.wikipedia.org -o /dev/null", 20_000);
    expect(blocked.stderr).toMatch(/403/);
  });

  it("never sees credentials, which the egress proxy injects", async () => {
    expect((await sh("env")).stdout).not.toContain("real-secret");
    const r = await sh('curl -sS -m 10 "$REDGIANT_EGRESS/route/echo/repos?x=1"');
    expect(JSON.parse(r.stdout)).toEqual({ path: "/repos?x=1", auth: SECRET });
    // The proxy is still up after refusing tunnels earlier in the suite.
    expect((await egress.inspect()).State.Running).toBe(true);
  });

  it("mounts read-only workspaces read-only", async () => {
    const ro = await provider.create({
      id: "inspector",
      localPath: join(base, "project"),
      mount: { type: "bind", source: join(base, "project") },
      readOnly: true,
    });
    const rws = ro.workspace();
    const r = await rws.exec("touch /workspace/nope", { timeoutMs: 10_000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/Read-only file system/);
    await expect(rws.writeText("nope.txt", "x")).rejects.toThrow(/read-only/);
    expect((await rws.exec("cat from-core.txt", { timeoutMs: 10_000 })).stdout).toBe("hello\n");
    await ro.destroy();
  });

  it("opens an interactive terminal in the container, with resizing", async () => {
    const term = await ws.openTerminal({ cols: 90, rows: 20 });
    let out = "";
    let exit: number | null | undefined;
    term.onData((d) => {
      out += d;
    });
    term.onExit((c) => {
      exit = c;
    });
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(pred()).toBe(true);
    };
    term.write("echo in-container-$((6*7)); stty size\r");
    await until(() => out.includes("in-container-42") && out.includes("20 90"));
    term.resize(120, 33);
    term.write("stty size\r");
    await until(() => out.includes("33 120"));
    term.write("exit\r");
    await until(() => exit !== undefined);
    expect(exit).toBe(0);
  });

  it("gives two agents separate worktrees and merges them", async () => {
    await ensureRepo(ws);
    const a = sandbox.workspace(await createWorktree(ws, "alice"));
    const b = sandbox.workspace(await createWorktree(ws, "bob"));
    await a.exec("echo alice > alice.txt", { timeoutMs: 10_000 });
    await b.exec("echo bob > bob.txt", { timeoutMs: 10_000 });
    expect(await b.exists("alice.txt")).toBe(false);
    await commitAll(a, "alice's work");
    await commitAll(b, "bob's work");
    expect(await mergeWorktree(ws, "alice")).toEqual({ ok: true, merged: true });
    expect(await mergeWorktree(ws, "bob")).toEqual({ ok: true, merged: true });
    expect((await sh("cat alice.txt bob.txt")).stdout).toBe("alice\nbob\n");
  });
});
