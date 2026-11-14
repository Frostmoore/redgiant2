import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { giteaBase } from "../src/git-hosts.js";
import { GitHosts, type SetupHooks, SetupService, type SetupState } from "../src/index.js";
import { startServer } from "./helpers.js";

const git = promisify(execFile);

/** GitHub and Gitea in miniature: records every call, answers as they would. */
function hosts(o: { badToken?: boolean; noAdmin?: boolean } = {}) {
  const calls: string[] = [];
  const hooks: { path: string; body: { events: string[]; config: { url: string } } }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url
      .replace("https://api.github.com", "github:")
      .replace("http://redgiant-gitea:3000", "gitea:")
      .replace("https://git.example.org", "ext:");
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
    // The person's own Gitea (p3.7.2): user marta, token «gitea-good-token».
    if (path === "ext:/api/v1/user")
      return auth === `Basic ${Buffer.from("marta:gitea-good-token").toString("base64")}`
        ? Response.json({ login: "marta" })
        : new Response("{}", { status: 401 });
    if (path === "ext:/api/v1/user/repos") return new Response("{}", { status: 201 });
    if (path.startsWith("ext:/api/v1/repos/") && path.endsWith("/push_mirrors"))
      return new Response("{}", { status: 201 });
    if (path === "gitea:/api/v1/user/repos") return new Response("{}", { status: 201 });
    if (path.startsWith("gitea:/api/v1/repos/") && path.endsWith("/push_mirrors"))
      return new Response("{}", { status: 201 });
    if (/\/(pulls|issues)$/.test(path) && method === "POST") {
      hooks.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({ number: 7, html_url: `https://x/${path}/7` }, { status: 201 });
    }
    if (path.includes("/issues?"))
      return Response.json([
        { number: 1, title: "Bug", html_url: "https://x/1", user: { login: "marta" } },
        { number: 2, title: "A PR", html_url: "https://x/2", pull_request: {} },
      ]);
    if (path.endsWith("/hooks")) {
      hooks.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 201 });
    }
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  return { calls, f, hooks };
}

const remote = async (path: string) =>
  (await git("git", ["-C", path, "remote", "get-url", "origin"])).stdout.trim();

describe("where the code lives", () => {
  it("opens pull requests and issues on the project's repository for its agents (G24.14c)", async () => {
    const h = hosts();
    const g = new GitHosts({ fetch: h.f });
    const gitea = { gitea: { user: "marta", publicUrl: "" } } as never;
    expect(
      await g.repoAction(gitea, { giteaToken: "t" }, "sito", {
        kind: "pull",
        title: "Cart",
        body: "Adds the cart",
        head: "cart",
        base: "main",
      }),
    ).toMatch(/^Pull request #7/);
    expect(h.hooks[0]).toMatchObject({
      path: "gitea:/api/v1/repos/marta/sito/pulls",
      body: { head: "cart", base: "main" },
    });
    const gh = { github: { login: "mario" } };
    expect(
      await g.repoAction(gh, { githubToken: "ghp_good" }, "sito", {
        kind: "issue",
        title: "Bug",
        body: "It breaks",
      }),
    ).toMatch(/^Issue #7/);
    expect(h.hooks[1]?.path).toBe("github:/repos/mario/sito/issues");
    // GitHub lists pull requests among issues: only the issues are shown.
    const list = await g.repoAction(gh, { githubToken: "ghp_good" }, "sito", {
      kind: "list",
      what: "issues",
    });
    expect(list).toBe("#1 Bug (marta) https://x/1");
  });

  it("adds a routine's webhook on Gitea, or on GitHub when it can reach RedGiant (G24.14c)", async () => {
    const h = hosts();
    const g = new GitHosts({ fetch: h.f });
    const url = { internal: "http://redgiant:7600/api/automations/a1/hook/rgwh_x" };
    await g.hookFor(
      { gitea: { user: "marta", publicUrl: "" } } as never,
      { giteaToken: "t" },
      "sito",
      url,
      ["pull_request"],
    );
    expect(h.hooks[0]).toMatchObject({
      path: "gitea:/api/v1/repos/marta/sito/hooks",
      body: { events: ["pull_request"], config: { url: url.internal } },
    });
    // GitHub needs RedGiant's address from outside.
    await expect(
      g.hookFor({ github: { login: "mario" } }, { githubToken: "ghp_good" }, "sito", url, ["push"]),
    ).rejects.toMatchObject({ code: "unreachable" });
    await g.hookFor(
      { github: { login: "mario" } },
      { githubToken: "ghp_good" },
      "sito",
      { ...url, public: "https://me.example/api/automations/a1/hook/rgwh_x" },
      ["push"],
    );
    expect(h.hooks[1]?.path).toBe("github:/repos/mario/sito/hooks");
    expect(h.hooks[1]?.body.config.url).toBe("https://me.example/api/automations/a1/hook/rgwh_x");
  });

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

describe("a Gitea the person already has (p3.7.2)", () => {
  it.each([
    ["git.example.org", "https://git.example.org"],
    ["https://git.example.org/", "https://git.example.org"],
    ["https://git.example.org/api/v1", "https://git.example.org"],
    ["http://192.168.1.20:3000", "http://192.168.1.20:3000"],
    ["https://example.org/gitea/", "https://example.org/gitea"],
    ["https://me:pw@git.example.org", null],
    ["ftp://git.example.org", null],
    ["not a url at all", null],
  ])("its address: %s", (text, want) => {
    expect(giteaBase(text)).toBe(want);
  });

  it("checks the token, then keeps the code there (and copies every push to GitHub)", async () => {
    const h = hosts();
    let routesFile = "";
    const hooks: SetupHooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
      gitea: async () => {
        throw new Error("RedGiant's own Gitea must not be touched");
      },
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
      const bad = await s.api<{ code: string }>("PUT", "/api/setup/gitea/external", {
        url: "https://git.example.org/",
        user: "marta",
        token: "gitea-wrong-token",
      });
      expect(bad.body.code).toBe("token_rejected");
      const ok = await s.api("PUT", "/api/setup/gitea/external", {
        url: "https://git.example.org/",
        user: "marta",
        token: "gitea-good-token",
      });
      expect(ok.body).toEqual({ user: "marta", url: "https://git.example.org" });
      await s.api("PUT", "/api/setup/github", { token: "ghp_good_token_123456" });
      const state = (await s.api<SetupState>("GET", "/api/setup")).body;
      expect(state.config.git?.gitea).toEqual({
        user: "marta",
        publicUrl: "https://git.example.org",
        external: true,
      });
      expect(state.secretsSet.gitea).toBe(true);
      expect(JSON.stringify(state)).not.toContain("gitea-good-token");
      const routes = JSON.parse(await readFile(routesFile, "utf8"));
      expect(routes.gitea.upstream).toBe("https://git.example.org");
      h.calls.length = 0;
      const p = (await s.api<{ path: string }>("POST", "/api/projects", { name: "Sito" })).body;
      expect(h.calls).toEqual([
        "POST ext:/api/v1/user/repos",
        "POST github:/user/repos",
        "POST ext:/api/v1/repos/marta/sito/push_mirrors",
      ]);
      expect(await remote(p.path)).toBe("http://egress:3128/route/gitea/marta/sito.git");
      // Disconnected: forgotten here, nothing stopped (it is the person's).
      expect((await s.api("DELETE", "/api/setup/gitea")).status).toBe(200);
      expect((await s.api<SetupState>("GET", "/api/setup")).body.config.git?.gitea).toBeUndefined();
      expect(Object.keys(JSON.parse(await readFile(routesFile, "utf8")))).not.toContain("gitea");
    } finally {
      s1Stop(setup);
      await s.close();
    }
  });

  it("an external Gitea's webhook calls RedGiant's public address, never the inside one", async () => {
    const h = hosts();
    const g = new GitHosts({ fetch: h.f });
    const cfg = {
      gitea: { user: "marta", publicUrl: "https://git.example.org", external: true },
    };
    await expect(
      g.hookFor(cfg, { giteaToken: "t" }, "sito", { internal: "http://redgiant:7600/h" }, ["push"]),
    ).rejects.toMatchObject({ code: "unreachable" });
    await g.hookFor(
      cfg,
      { giteaToken: "t" },
      "sito",
      { internal: "http://redgiant:7600/h", public: "https://rg.example.org/h" },
      ["push"],
    );
    expect(h.hooks.at(-1)).toMatchObject({
      path: "ext:/api/v1/repos/marta/sito/hooks",
      body: { config: { url: "https://rg.example.org/h" } },
    });
  });
});

function s1Stop(setup: SetupService | undefined) {
  setup?.stop();
}
