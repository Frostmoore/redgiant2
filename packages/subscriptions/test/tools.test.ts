import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadTool, existingLogin, locateTool, nativePackage } from "../src/tools.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("the subscriptions' programs, found or downloaded (2026-11-05)", () => {
  it("names this system's npm build, at the version the SDKs ask for", () => {
    const codex = nativePackage("codex");
    expect(codex.version).toMatch(
      new RegExp(`^\\d+\\.\\d+\\.\\d+-${process.platform}-${process.arch}$`),
    );
    expect(codex.tarball).toBe(
      `https://registry.npmjs.org/@openai/codex/-/codex-${codex.version}.tgz`,
    );
    const claude = nativePackage("claude");
    expect(claude.name).toBe(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`);
    expect(claude.tarball).toMatch(/\/-\/claude-agent-sdk-.+\.tgz$/);
    process.env.REDGIANT_NPM_REGISTRY = "http://mirror.local/";
    expect(nativePackage("codex").tarball).toMatch(/^http:\/\/mirror\.local\/@openai\/codex\/-\//);
  });

  it.skipIf(process.platform === "win32")(
    "downloads a build with its progress, then finds it there",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-tools-"));
      // A package as npm serves it: package/claude inside a .tgz.
      await mkdir(join(dir, "src", "package"), { recursive: true });
      await writeFile(join(dir, "src", "package", "claude"), "#!/bin/sh\necho fake\n");
      execFileSync("tar", ["-czf", join(dir, "pkg.tgz"), "-C", join(dir, "src"), "package"]);
      const tgz = await readFile(join(dir, "pkg.tgz"));
      let asked = "";
      const server = createServer((req, res) => {
        asked = req.url ?? "";
        res.writeHead(200, { "content-length": tgz.length });
        res.end(tgz);
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      process.env.REDGIANT_NPM_REGISTRY = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const tools = join(dir, "tools");
      const seen: number[] = [];
      try {
        const got = await downloadTool("claude", tools, (done) => seen.push(done));
        expect(asked).toBe(
          `/${nativePackage("claude").name}/-/${nativePackage("claude").name.split("/")[1]}-${nativePackage("claude").version}.tgz`,
        );
        expect(seen.at(-1)).toBe(tgz.length);
        // The bundled build (development) wins over a downloaded one; either is a real file.
        expect(["bundled", "downloaded"]).toContain(got.source);
        expect(
          await readFile(
            join(tools, "claude", nativePackage("claude").version, "package", "claude"),
            "utf8",
          ),
        ).toContain("echo fake");
        expect(locateTool("claude", tools)).toBeDefined();
      } finally {
        server.close();
      }
    },
  );

  it("sees the person's own sign-in, made with their own Codex or Claude Code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-login-"));
    process.env.CODEX_HOME = join(dir, "codex");
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    expect(existingLogin("codex")).toBeUndefined();
    expect(existingLogin("claude")).toBeUndefined();
    await mkdir(join(dir, "codex"), { recursive: true });
    await writeFile(join(dir, "codex", "auth.json"), "{}");
    await mkdir(join(dir, "claude"), { recursive: true });
    await writeFile(join(dir, "claude", ".credentials.json"), "{}");
    expect(existingLogin("codex")).toBe(join(dir, "codex"));
    expect(existingLogin("claude")).toBe(join(dir, "claude"));
  });
});
