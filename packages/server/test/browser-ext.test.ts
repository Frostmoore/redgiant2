// G36.21: the browser extension's routes. Linking with a code, a token that opens only these
// routes, credentials only for their own site, every use recorded, saving and updating, limits.
import type {
  BrowserExtCheck,
  BrowserExtSite,
  VaultBrowser,
  VaultBrowserCode,
  VaultView,
} from "@redgiant/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;

const login = {
  name: "github",
  service: "GitHub",
  category: "login",
  username: "ada",
  value: "hunter2-correct-horse",
  url: "https://github.com/login",
  hosts: ["github.com"],
};
const other = { ...login, name: "gitlab", service: "GitLab", url: "https://gitlab.com", hosts: [] };

describe("browser extension routes (G36.21)", () => {
  let s: Server;
  let token = "";
  let githubId = "";
  // The extension's own requests: its token, never the person's.
  const ext = async <T = unknown>(method: string, path: string, body?: unknown, t = token) => {
    const r = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        ...(t && { authorization: `Bearer ${t}` }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as T & { code?: string; error?: string } };
  };

  beforeAll(async () => {
    s = await startServer([{ text: "Ok." }]);
    githubId = (await s.api<{ id: string }>("POST", "/api/vault", login)).body.id;
    await s.api("POST", "/api/vault", other);
  });
  afterAll(() => s.close());

  it("links a browser with a one-time code", async () => {
    const code = await s.api<VaultBrowserCode>("POST", "/api/vault-browsers/code");
    expect(code.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const wrong = await ext(
      "POST",
      "/api/browser-ext/pair",
      { code: "AAAA-AAAA", name: "Opera" },
      "",
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("bad_code");
    const ok = await ext<{ token: string; id: string; name: string }>(
      "POST",
      "/api/browser-ext/pair",
      {
        code: code.body.code.toLowerCase().replace("-", " "),
        name: "Opera on the desk",
        browser: "opera",
      },
      "",
    );
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^rgb_/);
    token = ok.body.token;
    // One browser per code.
    const again = await ext("POST", "/api/browser-ext/pair", { code: code.body.code }, "");
    expect(again.body.code).toBe("bad_code");
    const list = await s.api<VaultBrowser[]>("GET", "/api/vault-browsers");
    expect(list.body).toEqual([
      expect.objectContaining({ name: "Opera on the desk", browser: "opera", lastSeenAt: null }),
    ]);
    // The token is not kept anywhere the page reads.
    expect(JSON.stringify(list.body)).not.toContain(token);
    const status = await ext<{ name: string; ready: boolean }>("GET", "/api/browser-ext/status");
    expect(status.body).toMatchObject({ name: "Opera on the desk", ready: true });
  });

  it("keeps the two tokens apart", async () => {
    // The browser's token opens nothing else of the API…
    expect((await ext("GET", "/api/vault")).status).toBe(401);
    expect((await ext("GET", "/api/agents")).status).toBe(401);
    expect((await ext("POST", `/api/vault/${githubId}/reveal`)).status).toBe(401);
    // …and the person's sign-in does not open the extension's routes.
    const human = await s.api("GET", "/api/browser-ext/status");
    expect(human.status).toBe(401);
    expect((await ext("GET", "/api/browser-ext/status", undefined, "rgb_nothing")).status).toBe(
      401,
    );
    expect((await ext("GET", "/api/browser-ext/status", undefined, "")).status).toBe(401);
  });

  it("lists only the credentials of the page's site", async () => {
    const site = await ext<BrowserExtSite>("POST", "/api/browser-ext/site", {
      url: "https://github.com/login",
    });
    expect(site.body).toEqual({
      host: "github.com",
      secure: true,
      entries: [
        expect.objectContaining({
          id: githubId,
          service: "GitHub",
          username: "ada",
          site: "github.com",
        }),
      ],
    });
    expect(JSON.stringify(site.body)).not.toContain(login.value);
    for (const url of [
      "https://github.com.evil.net/login",
      "http://github.com/login",
      "https://gіthub.com/",
      "https://github.com:8443/",
    ]) {
      const r = await ext<BrowserExtSite>("POST", "/api/browser-ext/site", { url });
      expect(r.body.entries, url).toEqual([]);
    }
    const searched = await ext<BrowserExtSite>("POST", "/api/browser-ext/site", {
      url: "https://github.com/",
      q: "nobody",
    });
    expect(searched.body.entries).toEqual([]);
  });

  it("gives a value only for its site, and records every try", async () => {
    const evil = await ext("POST", "/api/browser-ext/value", {
      id: githubId,
      url: "https://github.com.evil.net/login",
      purpose: "fill",
    });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe("refused");
    expect(JSON.stringify(evil.body)).not.toContain(login.value);
    const ok = await ext<{ value: string; username: string }>("POST", "/api/browser-ext/value", {
      id: githubId,
      url: "https://github.com/login",
      purpose: "fill",
    });
    expect(ok.body).toEqual({ value: login.value, username: "ada" });
    const view = await s.api<VaultView>("GET", "/api/vault");
    const mine = view.body.uses.filter((u) => u.tool === "browser_extension");
    expect(mine.map((u) => [u.outcome, u.host, u.method, u.agentName])).toEqual([
      ["used", "github.com", "FILL", "Opera on the desk"],
      ["refused", "github.com.evil.net", "FILL", "Opera on the desk"],
    ]);
    expect(view.body.entries.find((e) => e.id === githubId)?.uses).toBe(1);
  });

  it("never fills a key RedGiant uses itself", async () => {
    await s.core.vault.setSystem("me", "setup:keys.anthropic", "sk-ant-api03-browser-test", {
      name: "anthropic",
      service: "Anthropic",
      category: "api",
      url: "https://console.anthropic.com",
      hosts: ["console.anthropic.com"],
      section: "setup",
      kind: "provider",
      what: "Claude",
    });
    const site = await ext<BrowserExtSite>("POST", "/api/browser-ext/site", {
      url: "https://console.anthropic.com/login",
    });
    expect(site.body.entries).toEqual([]);
    const id = s.core.vault.entriesOf("me").find((e) => e.usedBy)?.id ?? "";
    const r = await ext("POST", "/api/browser-ext/value", {
      id,
      url: "https://console.anthropic.com/login",
      purpose: "copy",
    });
    expect(r.status).toBe(403);
  });

  it("tells a new, a changed and a known password apart", async () => {
    const check = (url: string, username: string, password: string) =>
      ext<BrowserExtCheck>("POST", "/api/browser-ext/check", { url, username, password });
    expect((await check("https://github.com/login", "Ada", login.value)).body).toMatchObject({
      state: "same",
      entryId: githubId,
    });
    expect((await check("https://github.com/session", "ada", "new-one")).body).toMatchObject({
      state: "changed",
      entryId: githubId,
    });
    expect((await check("https://www.example.org/signin", "bob", "x")).body).toEqual({
      state: "new",
      service: "example.org",
      hosts: ["www.example.org"],
      domain: "example.org",
    });
    // A password typed on plain http, away from home: nothing to propose.
    expect((await check("http://example.org/signin", "bob", "x")).body.state).toBe("unsafe");
    // At home it is fine (a router).
    expect((await check("http://192.168.1.1/", "admin", "x")).body.state).toBe("new");
  });

  it("saves a new credential for the person only, and updates one for its site", async () => {
    const saved = await ext<{ entryId: string; state: string }>("POST", "/api/browser-ext/save", {
      url: "https://www.example.org/signin",
      username: "bob",
      password: "s3cret-from-the-form",
      service: "Example",
      hosts: ["*.example.org", "evil.net"],
    });
    expect(saved.body.state).toBe("saved");
    const e = s.core.vault.entriesOf("me").find((x) => x.id === saved.body.entryId);
    expect(e).toMatchObject({
      service: "Example",
      category: "login",
      username: "bob",
      url: "https://www.example.org",
      hosts: ["www.example.org", "*.example.org"],
      ask: "always",
      allow: { allAgents: false, agents: [], tools: [], automations: [] },
    });
    expect(s.core.vault.reveal("me", saved.body.entryId)).toBe("s3cret-from-the-form");
    // An update from a look-alike page is refused and recorded.
    const evil = await ext("POST", "/api/browser-ext/save", {
      url: "https://github.com.evil.net/",
      username: "ada",
      password: "stolen",
      entryId: githubId,
    });
    expect(evil.status).toBe(403);
    expect(s.core.vault.reveal("me", githubId)).toBe(login.value);
    const updated = await ext<{ state: string }>("POST", "/api/browser-ext/save", {
      url: "https://github.com/settings/password",
      username: "ada",
      password: "brand-new-password",
      entryId: githubId,
    });
    expect(updated.body.state).toBe("updated");
    expect(s.core.vault.reveal("me", githubId)).toBe("brand-new-password");
    // Not saved on plain http away from home.
    const http = await ext("POST", "/api/browser-ext/save", {
      url: "http://example.net/",
      username: "x",
      password: "y",
    });
    expect(http.status).toBe(403);
    const methods = (await s.api<VaultView>("GET", "/api/vault")).body.uses
      .filter((u) => u.tool === "browser_extension")
      .map((u) => `${u.method}:${u.outcome}`);
    expect(methods.slice(0, 3)).toEqual(["UPDATE:used", "UPDATE:refused", "SAVE:used"]);
  });

  it("limits how often values are read", async () => {
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++)
      last = (
        await ext("POST", "/api/browser-ext/value", {
          id: githubId,
          url: "https://github.com/",
          purpose: "copy",
        })
      ).status;
    expect(last).toBe(429);
  });

  it("limits tries at linking, even with the right code", async () => {
    const code = await s.api<VaultBrowserCode>("POST", "/api/vault-browsers/code");
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await ext("POST", "/api/browser-ext/pair", { code: "ZZZZ-ZZZZ" }, "")).status;
    expect(last).toBe(429);
    const right = await ext("POST", "/api/browser-ext/pair", { code: code.body.code }, "");
    expect(right.status).toBe(429);
  });

  it("unlinks a browser: its token stops at once", async () => {
    const [b] = (await s.api<VaultBrowser[]>("GET", "/api/vault-browsers")).body;
    expect(b?.lastSeenAt).not.toBeNull();
    expect((await s.api("DELETE", `/api/vault-browsers/${b?.id}`)).status).toBe(200);
    expect((await ext("GET", "/api/browser-ext/status")).status).toBe(401);
    expect((await s.api<VaultBrowser[]>("GET", "/api/vault-browsers")).body).toEqual([]);
    expect((await s.api("DELETE", `/api/vault-browsers/${b?.id}`)).status).toBe(404);
  });
});
