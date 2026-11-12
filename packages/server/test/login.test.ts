import { join } from "node:path";
import type { Job } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  base32,
  LoginStore,
  migrateLogin,
  type SetupHooks,
  SetupService,
  type SetupState,
  totp,
} from "../src/index.js";
import { startServer } from "./helpers.js";
import { memoryDb } from "./pglite.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("signing in with a password", () => {
  it("makes the codes of authenticator apps (RFC 6238)", () => {
    const secret = base32(Buffer.from("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    // The RFC's own vectors, last 6 digits.
    expect(totp(secret, 59_000)).toBe("287082");
    expect(totp(secret, 1_111_111_109_000)).toBe("081804");
    expect(totp(secret, 2_000_000_000_000)).toBe("279037");
  });

  it("password, second check, five tries, sessions that expire and end", async () => {
    const { db } = await memoryDb();
    await migrateLogin(db);
    let now = Date.parse("2026-11-03T10:00:00Z");
    const store = new LoginStore(db, { now: () => now });
    await expect(store.setPassword("me", "short")).rejects.toMatchObject({ code: "weak" });
    await expect(store.login("me", "x", undefined, "a", "b")).rejects.toMatchObject({
      code: "no_password",
    });
    await store.setPassword("me", "una-password-lunga");
    expect(await store.status("me")).toEqual({ password: true, code: false });
    const { token, expiresAt } = await store.login(
      "me",
      "una-password-lunga",
      undefined,
      "1.2.3.4",
      "Firefox",
    );
    expect(expiresAt).toBe("2026-12-03T10:00:00.000Z");
    expect(await store.authenticate(token)).toEqual({ ownerId: "me" });
    // Five wrong tries from one address: that address waits, the others do not.
    for (let i = 0; i < 5; i++)
      await expect(store.login("me", "wrong", undefined, "6.6.6.6", "x")).rejects.toMatchObject({
        code: "wrong",
      });
    await expect(
      store.login("me", "una-password-lunga", undefined, "6.6.6.6", "x"),
    ).rejects.toMatchObject({
      code: "too_many",
    });
    await store.login("me", "una-password-lunga", undefined, "1.2.3.4", "x");
    now += 16 * 60_000;
    await store.login("me", "una-password-lunga", undefined, "6.6.6.6", "x");
    // The second check: on only with a right code from the app.
    const { secret, url } = store.newCodeSecret("me");
    expect(url).toMatch(/^otpauth:\/\/totp\/RedGiant:me\?secret=[A-Z2-7]+&issuer=RedGiant/);
    await expect(store.enableCode("me", secret, "000000")).rejects.toMatchObject({ code: "wrong" });
    await store.enableCode("me", secret, totp(secret, now));
    await expect(
      store.login("me", "una-password-lunga", undefined, "1.2.3.4", "x"),
    ).rejects.toMatchObject({
      code: "code_needed",
    });
    await store.login("me", "una-password-lunga", totp(secret, now - 30_000), "1.2.3.4", "x");
    // A session ends when it expires, when signed out everywhere, or when the password changes.
    expect((await store.sessions("me")).length).toBeGreaterThan(1);
    now += 31 * 86_400_000;
    expect(await store.authenticate(token)).toBeNull();
    const fresh = await store.login("me", "una-password-lunga", totp(secret, now), "1.2.3.4", "x");
    await store.setPassword("me", "un'altra-password");
    expect(await store.authenticate(fresh.token)).toBeNull();
    const last = await store.login("me", "un'altra-password", totp(secret, now), "1.2.3.4", "x");
    await store.revokeAll("me");
    expect(await store.authenticate(last.token)).toBeNull();
  });

  it("over HTTP: the page asks how to sign in, then uses the session like a token", async () => {
    s = await startServer(() => ({ text: "x" }));
    const anon = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${s?.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect((await anon("GET", "/api/auth/methods")).body).toEqual({
      password: false,
      code: false,
      setupCode: false,
    });
    expect(
      (await s.api("PUT", "/api/auth/password", { password: "una-password-lunga" })).status,
    ).toBe(200);
    expect((await anon("GET", "/api/auth/methods")).body).toEqual({
      password: true,
      code: false,
      setupCode: false,
    });
    expect((await anon("POST", "/api/auth/login", { password: "wrong" })).body.code).toBe("wrong");
    const ok = await anon("POST", "/api/auth/login", { password: "una-password-lunga" });
    expect(ok.status).toBe(200);
    const projects = await fetch(`${s.url}/api/projects`, {
      headers: { authorization: `Bearer ${ok.body.token}` },
    });
    expect(projects.status).toBe(200);
    // Everything else still needs a credential.
    expect((await anon("GET", "/api/projects")).status).toBe(401);
  });

  it("never opens a way in from outside without a password", async () => {
    const asked: unknown[] = [];
    const hooks: SetupHooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
      remote: async (req, h) => {
        asked.push(req);
        if (!req) return null;
        h?.step("remote_login");
        h?.info({ url: "https://login.tailscale.com/a/abc" });
        return { url: "https://redgiant.tail1234.ts.net" };
      },
    };
    s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      const setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
      });
      await setup.applyAtStartup();
      return { setup };
    });
    const first = await s.api<{ code: string }>("POST", "/api/setup/remote", { way: "tailscale" });
    expect(first.body.code).toBe("no_password");
    expect(asked).toEqual([]);
    await s.api("PUT", "/api/auth/password", { password: "una-password-lunga" });
    const job = await s.api<Job>("POST", "/api/setup/remote", { way: "tailscale" });
    const end = await s.core.jobs.settled(job.body.id);
    expect(end?.state).toBe("done");
    expect(end?.vars.url).toBe("https://login.tailscale.com/a/abc");
    expect((await s.api<SetupState>("GET", "/api/setup")).body.config.remote).toEqual({
      way: "tailscale",
      url: "https://redgiant.tail1234.ts.net",
    });
    await s.api("DELETE", "/api/setup/remote");
    expect(asked.at(-1)).toBeNull();
    expect((await s.api<SetupState>("GET", "/api/setup")).body.config.remote).toBeUndefined();
  });
});
