import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitOnPath, portableGitDir, usePortableGit } from "../src/portable-git.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("Git on Windows (RedGiant 3.0)", () => {
  it("sees a git.exe on the PATH, and puts the portable one first when used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-git-"));
    expect(gitOnPath(dir)).toBe(false);
    await writeFile(join(dir, "git.exe"), "");
    expect(gitOnPath(["/nowhere", dir].join(delimiter))).toBe(true);

    const portable = portableGitDir(join(dir, "data"));
    expect(portable).toBe(join(dir, "data", "tools", "git"));
    await mkdir(join(portable, "cmd"), { recursive: true });
    process.env.PATH = "/usr/bin";
    delete process.env.REDGIANT_SHELL;
    usePortableGit(portable);
    usePortableGit(portable);
    // Its git and its tools first, once; its bash becomes the agents' shell.
    expect(process.env.PATH?.split(delimiter)).toEqual([
      join(portable, "cmd"),
      join(portable, "usr", "bin"),
      "/usr/bin",
    ]);
    expect(process.env.REDGIANT_SHELL).toBe(join(portable, "bin", "bash.exe"));
  });
});

describe.skipIf(process.platform === "win32")(
  "PortableGit downloaded (a Windows without Git)",
  () => {
    it("finds the build for this computer, downloads it with its progress and unpacks it", async () => {
      const { createServer } = await import("node:http");
      const { downloadPortableGit } = await import("../src/portable-git.js");
      const { existsSync } = await import("node:fs");
      // A stand-in for the self-extracting archive: "-y -o<folder>" makes cmd/git.exe there.
      const sfx = Buffer.from(
        '#!/bin/sh\nd="${2#-o}"\nmkdir -p "$d/cmd" && touch "$d/cmd/git.exe"\n',
      );
      let base = "";
      const arm = process.arch === "arm64";
      const server = createServer((req, res) => {
        if (req.url === "/releases/latest") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              // Only the build for this computer's processor is the right one (CI has arm64 Macs).
              assets: [
                {
                  name: "PortableGit-2.56.0.4-arm64.7z.exe",
                  browser_download_url: `${base}/${arm ? "git.exe" : "wrong"}`,
                },
                {
                  name: "PortableGit-2.56.0.4-64-bit.7z.exe",
                  browser_download_url: `${base}/${arm ? "wrong" : "git.exe"}`,
                },
                { name: "MinGit-2.56.0.4-64-bit.zip", browser_download_url: `${base}/wrong` },
              ],
            }),
          );
        } else if (req.url === "/git.exe") {
          res.writeHead(200, { "content-length": sfx.length });
          res.end(sfx);
        } else res.writeHead(404).end();
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.REDGIANT_GIT_RELEASES = `${base}/releases/latest`;
      const dir = join(await mkdtemp(join(tmpdir(), "rg-pgit-")), "git");
      const seen: number[] = [];
      try {
        await downloadPortableGit(dir, (d) => seen.push(d), AbortSignal.timeout(20_000));
        expect(seen.at(-1)).toBe(sfx.length);
        expect(existsSync(join(dir, "cmd", "git.exe"))).toBe(true);
        expect(existsSync(`${dir}.part`)).toBe(false);
      } finally {
        server.close();
      }
    });
  },
);
