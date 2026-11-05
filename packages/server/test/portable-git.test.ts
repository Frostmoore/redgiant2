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
