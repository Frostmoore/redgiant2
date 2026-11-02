import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitHosts, type SetupHooks, SetupService, type SetupState } from "../src/index.js";
import { startServer } from "./helpers.js";

const git = promisify(execFile);

/** GitHub and Gitea in miniature: records every call, answers as they would. */
function hosts(o: { badToken?: boolean; noAdmin?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url
      .replace("https://api.github.com", "github:")
      .replace("http://redgiant-gitea:3000", "gitea:");
    calls.push(`${method} ${path}`);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (path === "github:/user")
      return o.badToken || !auth.includes("ghp_good")
        ? new Response("{}", { status: 401 })
        : Response.json(
            { login: "mario" },
            { headers: { "github-authorization-token-expiration": "2027-11-03 10:00:00 UTC" } },
          );
    if (path === "github:/user/repos") return new Response("{}", { status: o.noAdmin ? 403 : 201 });
    if (path === "gitea:/api/v1/user/repos") return new Response("{}", { status: 201 });
    if (path.startsWith("gitea:/api/v1/repos/") && path.endsWith("/push_mirrors"))
      return new Response("{}", { status: 201 });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  return { calls, f };
}

const remote = async (path: string) =>
  (await git("git", ["-C", path, "remote", "get-url", "origin"])).stdout.trim();

describe("where the code lives", () => {
  it("checks a GitHub token and says why one is refused", async () => {
    const h = hosts();
    const g = new GitHosts({ fetch: h.f });
    expect(await g.checkGithub("ghp_good_token_123456")).toEqual({
      login: "mario",
      expires: "2027-11-03T10:00:00.000Z",
    });
    await expect(g.checkGithub("ghp_wrong")).rejects.toMatchObject({ code: "token_rejected" });
  });

  it("gives a project a private GitHub repository and a remote through the proxy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-git-"));
    const h = hosts();
    const routesFile = join(dir, "egress", "routes.json");
    const g = new GitHosts({ fetch: h.f, routesFile, egressUrl: "http://egress:3128" });
    const cfg = { github: { login: "mario" } };
    const secrets = { githubToken: "ghp_good_token_123456" };
    const project = { id: "sito", path: join(dir, "sito") };
    expect(await g.repoFor(cfg, secrets, project)).toEqual({
      home: "github",
      remote: "http://egress:3128/route/github/mario/sito.git",
    });
    expect(h.calls).toEqual(["POST github:/user/repos"]);
    expect(await remote(project.path)).toBe("http://egress:3128/route/github/mario/sito.git");
    // Run again: nothing breaks, the remote stays.
    await g.repoFor(cfg, secrets, project);
    expect(await remote(project.path)).toBe("http://egress:3128/route/github/mario/sito.git");
    // The token is in the proxy's routes, never in the remote.
    await g.writeRoutes(cfg, secrets);
    const routes = JSON.parse(await readFile(routesFile, "utf8"));
    expect(Object.keys(routes).sort()).toEqual(["github", "github-api"]);
    expect(routes.github.upstream).toBe("https://github.com");
    expect(Buffer.from(routes.github.headers.authorization.slice(6), "base64").toString()).toBe(
      "x-access-token:ghp_good_token_123456",
    );
    expect(await remote(project.path)).not.toContain("ghp_");
  });

  it("with Gitea too: the code lives on Gitea, copied to GitHub at every push", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-git-"));
    const h = hosts();
    const g = new GitHosts({ fetch: h.f });
    const r = await g.repoFor(
      { github: { login: "mario" }, gitea: { user: "mario", publicUrl: "http://localhost:3000" } },
      { githubToken: "ghp_good_token_123456", giteaToken: "abc123" },
      { id: "app", path: join(dir, "app") },
    );
    expect(r?.home).toBe("gitea");
    expect(h.calls).toEqual([
      "POST gitea:/api/v1/user/repos",
      "POST github:/user/repos",
      "POST gitea:/api/v1/repos/mario/app/push_mirrors",
    ]);
    expect(await remote(join(dir, "app"))).toBe("http://egress:3128/route/gitea/mario/app.git");
  });

  it("says when the token may not create repositories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-git-"));
    const g = new GitHosts({ fetch: hosts({ noAdmin: true }).f });
    await expect(
      g.repoFor(
        { github: { login: "mario" } },
        { githubToken: "ghp_good_token_123456" },
        { id: "x", path: join(dir, "x") },
      ),
    ).rejects.toMatchObject({ code: "missing_permission" });
  });

  it("from the wizard: new projects get their repository, the proxy its route, a reminder before expiry", async () => {
    const h = hosts();
    const told: string[] = [];
    let routesFile = "";
    const hooks: SetupHooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
    };
    let setup: SetupService | undefined;
    const s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      routesFile = join(dir, "egress", "routes.json");
      setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
        git: new GitHosts({ fetch: h.f, routesFile }),
      });
      await setup.applyAtStartup();
      return { setup };
    });
    try {
      s.core.notify = async (_o, text) => void told.push(text);
      const bad = await s.api<{ code: string }>("PUT", "/api/setup/github", {
        token: "ghp_wrong_but_long_enough",
      });
      expect(bad.body.code).toBe("token_rejected");
      expect(
        (await s.api("PUT", "/api/setup/github", { token: "ghp_good_token_123456" })).body,
      ).toEqual({
        login: "mario",
      });
      const state = (await s.api<SetupState>("GET", "/api/setup")).body;
      expect(state.config.git?.github).toEqual({
        login: "mario",
        expires: "2027-11-03T10:00:00.000Z",
      });
      expect(state.secretsSet.github).toBe(true);
      expect(Object.keys(JSON.parse(await readFile(routesFile, "utf8"))).sort()).toEqual([
        "github",
        "github-api",
      ]);
      // A new project: its private repository and its remote, by themselves.
      h.calls.length = 0;
      const p = (await s.api<{ path: string }>("POST", "/api/projects", { name: "Sito" })).body;
      expect(h.calls).toEqual(["POST github:/user/repos"]);
      expect(await remote(p.path)).toBe("http://egress:3128/route/github/mario/sito.git");
      // Two weeks before the token expires the owner is told, once.
      const s1 = setup as SetupService;
      expect(await s1.remindToken(Date.parse("2027-10-01T00:00:00Z"))).toBe(false);
      expect(await s1.remindToken(Date.parse("2027-10-25T00:00:00Z"))).toBe(true);
      expect(await s1.remindToken(Date.parse("2027-10-26T00:00:00Z"))).toBe(false);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(/GitHub token expires/);
      // Disconnected: no route, and new projects get no repository.
      await s.api("DELETE", "/api/setup/github");
      expect(JSON.parse(await readFile(routesFile, "utf8"))).toEqual({});
      h.calls.length = 0;
      await s.api("POST", "/api/projects", { name: "Altro" });
      expect(h.calls).toEqual([]);
    } finally {
      s1Stop(setup);
      await s.close();
    }
  });
});

function s1Stop(setup: SetupService | undefined) {
  setup?.stop();
}
