// Gitea for real (G24.5): started by the same code as the server, an admin and a token made,
// a repository created through its API, a push. Run with REDGIANT_DOCKER_TESTS=1 pnpm test:docker.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { GitHosts, Jobs } from "../src/index.js";
import { runtimeHooks } from "../src/runtime.js";

const run = promisify(execFile);
const on = process.env.REDGIANT_DOCKER_TESTS === "1";
const docker = new Docker();
const tag = `rg-test-gitea-${Date.now()}`;
// Inside a container, Gitea shares its network (127.0.0.1); on a machine, a published port.
const inContainer = existsSync("/.dockerenv");
const port = 3900 + Math.floor(Math.random() * 90);

afterAll(async () => {
  if (!on) return;
  await docker
    .getContainer(tag)
    .remove({ force: true })
    .catch(() => {});
  for (const v of ["data", "config"])
    await docker
      .getVolume(`${tag}-${v}`)
      .remove()
      .catch(() => {});
});

describe.skipIf(!on)("Gitea", () => {
  it("starts with an admin and a token, creates a repository and takes a push", async () => {
    const internalUrl = inContainer ? "http://127.0.0.1:3000" : `http://127.0.0.1:${port}`;
    const hooks = runtimeHooks({
      core: {} as never,
      providers: {} as never,
      db: {} as never,
      redactor: { addSecret: () => {} } as never,
      telegram: {},
      engine: {
        docker,
        image: { cpu: "x", cuda: "x", vulkan: "x" },
        network: inContainer ? `container:${hostname()}` : "bridge",
        modelsVolume: "x",
        kvVolume: "x",
        kvDir: "/tmp",
        gitea: {
          port,
          bind: inContainer ? "" : "127.0.0.1",
          internalUrl,
          volumePrefix: tag,
          name: tag,
        },
      },
    });
    const jobs = new Jobs();
    let result: { token: string } | null = null;
    const job = jobs.start("me", "gitea", ["gitea_image", "gitea_start", "account"], async (h) => {
      result =
        (await hooks.gitea?.({ user: "mario", password: "Una-password-lunga-1" }, h)) ?? null;
    });
    const end = await jobs.settled(job.id);
    expect(end?.error?.message).toBeUndefined();
    expect(end?.state).toBe("done");
    const token = (result as { token: string } | null)?.token ?? "";
    expect(token).toMatch(/^[0-9a-f]{20,}$/);

    // A repository through the API, as RedGiant makes them for projects.
    const dir = await mkdtemp(join(tmpdir(), "rg-gitea-"));
    const g = new GitHosts({ giteaUrl: internalUrl, egressUrl: "http://unused" });
    const path = join(dir, "sito");
    await g.repoFor(
      { gitea: { user: "mario", publicUrl: internalUrl } },
      { giteaToken: token },
      { id: "sito", path },
    );
    // A push straight to Gitea with the token (the sandboxes go through the egress route).
    await writeFile(join(path, "README.md"), "# sito\n");
    const git = (...args: string[]) =>
      run("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await git("add", "-A");
    await git("commit", "-m", "first");
    const url = internalUrl.replace("http://", `http://mario:${token}@`);
    await git("push", `${url}/mario/sito.git`, "HEAD:main");
    // Gitea records a push in the background: the branch shows up within seconds.
    let branches: { name: string; commit: { message: string } }[] = [];
    for (let i = 0; i < 30 && branches.length === 0; i++) {
      const r = await fetch(`${internalUrl}/api/v1/repos/mario/sito/branches`, {
        headers: { authorization: `token ${token}` },
      });
      branches = ((await r.json().catch(() => null)) as typeof branches | null) ?? [];
      if (branches.length === 0) await new Promise((ok) => setTimeout(ok, 500));
    }
    expect(branches.map((b) => [b.name, b.commit.message.trim()])).toEqual([["main", "first"]]);
    // Started again (RedGiant restarted): the same admin, a new token, nothing lost.
    const again = await hooks.gitea?.({ user: "mario", password: "Una-password-lunga-1" });
    expect(again?.token).toMatch(/^[0-9a-f]{20,}$/);
  });
});
