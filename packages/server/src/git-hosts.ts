// Where the code lives (G24.5): GitHub with the user's fine-grained token, and/or a Gitea server
// RedGiant starts by itself, or one the person already has (p3.7.2: its address, user and token). Every project gets a private repository and its remote; with both,
// Gitea keeps the code and copies every push to GitHub. Tokens never reach the sandboxes: the
// egress proxy holds them as credential routes, and the remotes point at those routes.

import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CredentialRoute } from "@redgiant/sandbox";
import { RoutesFile } from "./egress-routes.js";

const run = promisify(execFile);

export interface GitHostsConfig {
  /** `expires`: when the token stops working (ISO date), as GitHub says. */
  github?: { login: string; expires?: string };
  /**
   * `external`: a Gitea the person already has (p3.7.2), reached at `publicUrl` by RedGiant and
   * the egress proxy alike; otherwise the one RedGiant runs (reached inside Docker).
   */
  gitea?: { user: string; publicUrl: string; external?: boolean };
}

/**
 * A Gitea's address as people paste it («git.example.org», «https://git.example.org/»,
 * «…/api/v1»): its base URL, http(s) only, without credentials, query or trailing slash. null
 * when it is not one.
 */
export function giteaBase(text: string): string | null {
  const t = text.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return null;
  if (!u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${u.origin}${path}`;
}

export interface GitHostsSecrets {
  githubToken?: string | undefined;
  giteaToken?: string | undefined;
}

/** Why GitHub or Gitea refused, in a code the UI explains. */
export class GitHostError extends Error {
  constructor(
    readonly code: "token_rejected" | "missing_permission" | "unreachable" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface GitHostsOptions {
  /** Where the egress proxy reads its credential routes. */
  routesFile?: string;
  /** The egress proxy as the sandboxes reach it (`http://egress:3128`). */
  egressUrl?: string;
  /** Gitea as RedGiant and the proxy reach it inside Docker. */
  giteaUrl?: string;
  fetch?: typeof fetch;
}

const GITHUB_API = "https://api.github.com";
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

export class GitHosts {
  constructor(private readonly o: GitHostsOptions = {}) {}

  private get f(): typeof fetch {
    return this.o.fetch ?? globalThis.fetch;
  }

  get giteaUrl(): string {
    return this.o.giteaUrl ?? "http://redgiant-gitea:3000";
  }

  /** Where a configured Gitea is reached: the person's own at its address, else RedGiant's. */
  private giteaAt(cfg: GitHostsConfig["gitea"]): string {
    return cfg?.external ? cfg.publicUrl : this.giteaUrl;
  }

  /**
   * A Gitea the person already has (p3.7.2): its token checked on /api/v1/user. The user name is
   * the one Gitea gives for the token (written as Gitea writes it).
   */
  async checkGitea(url: string, user: string, token: string): Promise<{ user: string }> {
    const r = await this.call(
      `${url}/api/v1/user`,
      { headers: { authorization: basic(user, token), accept: "application/json" } },
      "Gitea",
    );
    if (r.status === 401 || r.status === 403)
      throw new GitHostError("token_rejected", "Gitea refused the user name or the token");
    if (!r.ok) throw new GitHostError("failed", `Gitea answered ${r.status}`);
    const body = (await r.json().catch(() => null)) as { login?: unknown } | null;
    if (typeof body?.login !== "string" || !body.login)
      throw new GitHostError("failed", "That address does not answer like a Gitea");
    if (body.login.toLowerCase() !== user.toLowerCase())
      throw new GitHostError(
        "token_rejected",
        `The token belongs to ${body.login}, not to ${user}`,
      );
    return { user: body.login };
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.f(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new GitHostError("unreachable", `${what} did not answer: ${(err as Error).message}`);
    }
  }

  private github(token: string, path: string, init: RequestInit = {}) {
    return this.call(
      `${GITHUB_API}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "RedGiant",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      },
      "GitHub",
    );
  }

  /** Whose token this is, and when it expires (GitHub says it in a header). */
  async checkGithub(token: string): Promise<{ login: string; expires?: string }> {
    const r = await this.github(token, "/user");
    if (r.status === 401) throw new GitHostError("token_rejected", "GitHub refused the token");
    if (!r.ok) throw new GitHostError("failed", `GitHub answered ${r.status}`);
    const { login } = (await r.json()) as { login: string };
    const header = r.headers.get("github-authorization-token-expiration");
    const when = header ? new Date(header.replace(" UTC", "Z").replace(" ", "T")) : null;
    return when && !Number.isNaN(when.getTime())
      ? { login, expires: when.toISOString() }
      : { login };
  }

  /** The credential routes the egress proxy injects: written whole, then renamed. */
  async writeRoutes(cfg: GitHostsConfig, s: GitHostsSecrets): Promise<void> {
    if (!this.o.routesFile) return;
    const routes: Record<string, CredentialRoute> = {};
    if (cfg.github && s.githubToken) {
      routes.github = {
        upstream: "https://github.com",
        headers: { authorization: basic("x-access-token", s.githubToken) },
      };
      routes["github-api"] = {
        upstream: GITHUB_API,
        headers: {
          authorization: `Bearer ${s.githubToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "RedGiant",
        },
      };
    }
    if (cfg.gitea && s.giteaToken)
      routes.gitea = {
        upstream: this.giteaAt(cfg.gitea),
        headers: { authorization: basic(cfg.gitea.user, s.giteaToken) },
      };
    // Shared with the keychain's credentials (G33.4): one writer per file.
    await RoutesFile.for(this.o.routesFile).setGit(routes);
  }

  /** A private GitHub repository (an existing one with that name is kept). */
  private async githubRepo(login: string, token: string, name: string): Promise<void> {
    const r = await this.github(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: true, auto_init: false }),
    });
    if (r.status === 201 || r.status === 422) return;
    if (r.status === 401) throw new GitHostError("token_rejected", "GitHub refused the token");
    if (r.status === 403 || r.status === 404)
      throw new GitHostError(
        "missing_permission",
        `GitHub did not let the token create ${login}/${name} (Administration: read and write)`,
      );
    throw new GitHostError("failed", `GitHub answered ${r.status} creating ${name}`);
  }

  private gitea(
    g: NonNullable<GitHostsConfig["gitea"]>,
    token: string,
    path: string,
    init: RequestInit = {},
  ) {
    return this.call(
      `${this.giteaAt(g)}/api/v1${path}`,
      {
        ...init,
        headers: {
          authorization: basic(g.user, token),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      },
      "Gitea",
    );
  }

  private async giteaRepo(
    g: NonNullable<GitHostsConfig["gitea"]>,
    token: string,
    name: string,
  ): Promise<void> {
    const r = await this.gitea(g, token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: true }),
    });
    if (r.status === 201 || r.status === 409) return;
    if (r.status === 401) throw new GitHostError("token_rejected", "Gitea refused the token");
    throw new GitHostError("failed", `Gitea answered ${r.status} creating ${name}`);
  }

  /**
   * Pull requests and issues on a project's repository (G24.14c): on Gitea when the code lives
   * there, else on GitHub. Called by the server with the person's token; the agents never see it.
   */
  async repoAction(
    cfg: GitHostsConfig,
    s: GitHostsSecrets,
    projectId: string,
    a:
      | { kind: "pull"; title: string; body: string; head: string; base: string }
      | { kind: "issue"; title: string; body: string }
      | { kind: "list"; what: "issues" | "pulls" },
  ): Promise<string> {
    const gitea = cfg.gitea && s.giteaToken ? cfg.gitea : undefined;
    const github = !gitea && cfg.github && s.githubToken ? cfg.github : undefined;
    if (!gitea && !github) throw new GitHostError("failed", "No GitHub or Gitea is connected");
    const call = (path: string, init: RequestInit = {}) =>
      gitea
        ? this.gitea(
            gitea,
            s.giteaToken as string,
            `/repos/${gitea.user}/${projectId}${path}`,
            init,
          )
        : this.github(s.githubToken as string, `/repos/${github?.login}/${projectId}${path}`, init);
    const where = gitea ? "Gitea" : "GitHub";
    if (a.kind === "list") {
      const r = await call(`/${a.what}?state=open&per_page=30&limit=30`);
      if (!r.ok) throw new GitHostError("failed", `${where} answered ${r.status}`);
      const items = (await r.json()) as {
        number: number;
        title: string;
        html_url: string;
        user?: { login?: string };
        pull_request?: unknown;
      }[];
      // GitHub lists pull requests among the issues too.
      const shown = a.what === "issues" ? items.filter((i) => !i.pull_request) : items;
      return shown.length
        ? shown
            .map((i) => `#${i.number} ${i.title} (${i.user?.login ?? "?"}) ${i.html_url}`)
            .join("\n")
        : `No open ${a.what}.`;
    }
    const body =
      a.kind === "pull"
        ? { title: a.title, body: a.body, head: a.head, base: a.base }
        : { title: a.title, body: a.body };
    const r = await call(a.kind === "pull" ? "/pulls" : "/issues", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.status === 401) throw new GitHostError("token_rejected", `${where} refused the token`);
    if (r.status === 403)
      throw new GitHostError(
        "missing_permission",
        `${where} did not let the token do it (${a.kind === "pull" ? "Pull requests" : "Issues"}: read and write)`,
      );
    if (!r.ok)
      throw new GitHostError(
        "failed",
        `${where} answered ${r.status}: ${(await r.text()).slice(0, 300)}`,
      );
    const made = (await r.json()) as { number: number; html_url: string };
    return `${a.kind === "pull" ? "Pull request" : "Issue"} #${made.number}: ${made.html_url}`;
  }

  /**
   * A webhook on a project's repository that calls an automation (G24.14c): on Gitea when the
   * code lives there (it calls RedGiant inside Docker), else on GitHub (which needs RedGiant's
   * address from outside). `url` is the automation's address with its secret.
   */
  async hookFor(
    cfg: GitHostsConfig,
    s: GitHostsSecrets,
    projectId: string,
    urls: { internal: string; public?: string | undefined },
    events: string[],
  ): Promise<{ home: "gitea" | "github" }> {
    if (cfg.gitea && s.giteaToken) {
      // The person's own Gitea is outside RedGiant's Docker network: it calls the public address.
      const url = cfg.gitea.external ? urls.public : urls.internal;
      if (!url)
        throw new GitHostError(
          "unreachable",
          "Your Gitea must reach RedGiant from outside: set up access from outside home first",
        );
      const r = await this.gitea(
        cfg.gitea,
        s.giteaToken,
        `/repos/${cfg.gitea.user}/${projectId}/hooks`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "gitea",
            active: true,
            events,
            config: { url, content_type: "json" },
          }),
        },
      );
      if (r.status === 401) throw new GitHostError("token_rejected", "Gitea refused the token");
      if (!r.ok) throw new GitHostError("failed", `Gitea answered ${r.status} adding the webhook`);
      return { home: "gitea" };
    }
    if (cfg.github && s.githubToken) {
      if (!urls.public)
        throw new GitHostError(
          "unreachable",
          "GitHub must reach RedGiant from outside: set up access from outside home first",
        );
      const r = await this.github(s.githubToken, `/repos/${cfg.github.login}/${projectId}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          name: "web",
          active: true,
          events,
          config: { url: urls.public, content_type: "json", insecure_ssl: "0" },
        }),
      });
      if (r.status === 401) throw new GitHostError("token_rejected", "GitHub refused the token");
      if (r.status === 403 || r.status === 404)
        throw new GitHostError(
          "missing_permission",
          "GitHub did not let the token add a webhook (Webhooks: read and write)",
        );
      if (!r.ok) throw new GitHostError("failed", `GitHub answered ${r.status} adding the webhook`);
      return { home: "github" };
    }
    throw new GitHostError("failed", "No GitHub or Gitea is connected");
  }

  /**
   * A repository for a project and its remote `origin` in the project's folder (git is set up
   * there if missing). Gitea keeps the code when there is one, with a copy on GitHub.
   */
  async repoFor(
    cfg: GitHostsConfig,
    s: GitHostsSecrets,
    project: { id: string; path: string },
  ): Promise<{ home: "gitea" | "github"; remote: string } | null> {
    const name = project.id;
    const egress = this.o.egressUrl ?? "http://egress:3128";
    let home: "gitea" | "github";
    let remote: string;
    if (cfg.gitea && s.giteaToken) {
      await this.giteaRepo(cfg.gitea, s.giteaToken, name);
      if (cfg.github && s.githubToken) {
        await this.githubRepo(cfg.github.login, s.githubToken, name);
        const r = await this.gitea(
          cfg.gitea,
          s.giteaToken,
          `/repos/${cfg.gitea.user}/${name}/push_mirrors`,
          {
            method: "POST",
            body: JSON.stringify({
              remote_address: `https://github.com/${cfg.github.login}/${name}.git`,
              remote_username: cfg.github.login,
              remote_password: s.githubToken,
              interval: "8h0m0s",
              sync_on_commit: true,
            }),
          },
        );
        // A mirror that already exists answers 400 or 409: it is there.
        if (!r.ok && r.status !== 400 && r.status !== 409)
          throw new GitHostError("failed", `Gitea answered ${r.status} adding the GitHub copy`);
      }
      home = "gitea";
      remote = `${egress}/route/gitea/${cfg.gitea.user}/${name}.git`;
    } else if (cfg.github && s.githubToken) {
      await this.githubRepo(cfg.github.login, s.githubToken, name);
      home = "github";
      remote = `${egress}/route/github/${cfg.github.login}/${name}.git`;
    } else return null;
    await setOrigin(project.path, remote);
    return { home, remote };
  }
}

/** `git init` if needed and `origin` pointing at the remote; arguments, never a shell. */
export async function setOrigin(path: string, remote: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const git = (...args: string[]) => run("git", ["-C", path, ...args]);
  // The project's own repository, not one around its folder.
  const own = await stat(join(path, ".git")).then(
    () => true,
    () => false,
  );
  if (!own) await git("init");
  const has = await git("remote", "get-url", "origin").then(
    () => true,
    () => false,
  );
  await (has ? git("remote", "set-url", "origin", remote) : git("remote", "add", "origin", remote));
}
