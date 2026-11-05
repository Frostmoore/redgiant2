import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freePort } from "../src/embedded-db.js";
import { LocalSearxng, SEARXNG_COMMIT, uvAsset } from "../src/searxng-local.js";

describe("SearXNG on this computer, without Docker (2026-11-05)", () => {
  it("knows uv's archive for each system", () => {
    expect(uvAsset("win32", "x64")).toBe("uv-x86_64-pc-windows-msvc.zip");
    expect(uvAsset("win32", "arm64")).toBeUndefined();
    expect(uvAsset("darwin", "arm64")).toBe("uv-aarch64-apple-darwin.tar.gz");
    expect(uvAsset("darwin", "x64")).toBe("uv-x86_64-apple-darwin.tar.gz");
    expect(uvAsset("linux", "x64")).toBe("uv-x86_64-unknown-linux-gnu.tar.gz");
  });

  it.skipIf(process.platform === "win32")(
    "installs uv, a Python and SearXNG once, starts it on 127.0.0.1 and stops it with RedGiant",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-searxng-"));
      const stage = join(dir, "stage");
      // A stand-in for SearXNG's Python: reads its settings, answers /healthz and a search.
      const python = `#!/usr/bin/env node
const fs = require("node:fs");
const settings = fs.readFileSync(process.env.SEARXNG_SETTINGS_PATH, "utf8");
const port = Number(/port: (\\d+)/.exec(settings)[1]);
const shim = process.env.PYTHONPATH.split(":")[0];
fs.writeFileSync(require("node:path").join(shim, "..", "started.json"), JSON.stringify({ args: process.argv.slice(2), settings }));
const server = require("node:http").createServer((q, r) => {
  if (q.url === "/healthz") return r.end("OK");
  const u = new URL(q.url, "http://x");
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ results: [{ title: "Found " + u.searchParams.get("q"), url: "https://example.org" }] }));
});
server.listen(port, "127.0.0.1");
// As the real start does: it ends when RedGiant's process does.
const parent = Number(process.env.REDGIANT_PARENT_PID);
setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 500);
`;
      // A stand-in for uv: "venv" makes the Python above, "pip install" checks the requirements.
      const uv = `#!/bin/sh
echo "$@" >> "$(dirname "$0")/../uv-calls.txt"
case "$1" in
  venv) mkdir -p "$4/bin" && cp "$(dirname "$0")/../stage-python" "$4/bin/python" && chmod +x "$4/bin/python" ;;
  pip) test -f "$6" || exit 3 ;;
esac
`;
      const asset = uvAsset("linux", "x64") as string;
      await mkdir(join(stage, "uv-x86_64-unknown-linux-gnu"), { recursive: true });
      await writeFile(join(stage, "uv-x86_64-unknown-linux-gnu", "uv"), uv);
      await chmod(join(stage, "uv-x86_64-unknown-linux-gnu", "uv"), 0o755);
      execFileSync("tar", ["-czf", join(stage, asset), "-C", stage, "uv-x86_64-unknown-linux-gnu"]);
      const src = `searxng-${SEARXNG_COMMIT}`;
      await mkdir(join(stage, src), { recursive: true });
      await writeFile(join(stage, src, "requirements.txt"), "flask==3.1.3\n");
      execFileSync("tar", ["-czf", join(stage, `${SEARXNG_COMMIT}.tar.gz`), "-C", stage, src]);
      const asked: string[] = [];
      const server = createServer(async (req, res) => {
        asked.push(req.url ?? "");
        const file = (req.url ?? "").split("/").pop() ?? "";
        const path = join(stage, file);
        if (!file || !existsSync(path)) return res.writeHead(404).end();
        res.end(await readFile(path));
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const data = join(dir, "data");
      const searx = new LocalSearxng(data, {
        platform: "linux",
        arch: "x64",
        uvReleases: `${base}/uv`,
        searxngArchives: `${base}/searxng`,
      });
      try {
        expect(searx.ready()).toBe(false);
        // The fake uv copies this file as the venv's Python.
        await mkdir(searx.dir, { recursive: true });
        await writeFile(join(searx.dir, "stage-python"), python);
        const seen: number[] = [];
        const steps: string[] = [];
        const h = {
          signal: new AbortController().signal,
          step: (s: string) => steps.push(s),
          progress: (d: number) => seen.push(d),
          skip: () => {},
        };
        await searx.install(h as never);
        expect(searx.ready()).toBe(true);
        expect(asked).toEqual([`/uv/${asset}`, `/searxng/${SEARXNG_COMMIT}.tar.gz`]);
        expect(seen.length).toBeGreaterThan(0);
        const calls = await readFile(join(searx.dir, "uv-calls.txt"), "utf8");
        expect(calls).toMatch(/^venv --python 3\.13 venv$/m);
        expect(calls).toMatch(/^pip install --python \S+ -r \S+requirements\.txt$/m);
        // uv's cache is not kept; the stand-in for pwd is there.
        expect(existsSync(join(searx.dir, "cache"))).toBe(false);
        // Installed: nothing comes down again.
        await searx.install(h as never);
        expect(asked).toHaveLength(2);

        const port = await freePort();
        const url = await searx.start(port, h as never);
        expect(url).toBe(`http://127.0.0.1:${port}`);
        expect(steps).toEqual(["searxng_start", "searxng_check"]);
        expect(await readFile(join(searx.dir, "shim", "pwd.py"), "utf8")).toMatch(/def getpwuid/);
        const started = JSON.parse(await readFile(join(searx.dir, "started.json"), "utf8"));
        expect(started.args[0]).toMatch(/redgiant_searxng\.py$/);
        expect(started.settings).toMatch(/bind_address: "127\.0\.0\.1"/);
        expect(started.settings).toMatch(/formats: \[html, json\]/);
        expect(started.settings).toMatch(/limiter: false/);
        const found = await (await fetch(`${url}/search?format=json&q=ciao`)).json();
        expect(found.results[0].title).toBe("Found ciao");
        searx.stop();
        await new Promise((r) => setTimeout(r, 300));
        await expect(
          fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) }),
        ).rejects.toThrow();
      } finally {
        searx.stop();
        server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
