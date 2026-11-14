import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  firstAccessBanner,
  firstAccessFromEnv,
  firstAccessOf,
  fromLocalNetwork,
  isLocalNetwork,
  setupCodeRequired,
} from "../src/first-access.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.restoreAllMocks();
});

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
};

async function withSetup(from?: "lan" | "anywhere") {
  let setup: SetupService | undefined;
  s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
    setup = new SetupService({
      db: core.db,
      core,
      dataDir: join(dir, "data"),
      ownerId: "me",
      hooks,
    });
    await setup.applyAtStartup();
    return { setup, ...(from && { firstAccessFrom: from }) };
  });
  return setup as SetupService;
}

/** A request without credentials, as a page reaching us through a proxy that saw `from`. */
const anon = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "x-forwarded-for": "192.168.1.77" },
) => {
  const r = await fetch(`${s?.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("the local network (G39.7)", () => {
  it.each([
    ["192.168.1.5", true],
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.1", true],
    ["172.32.0.1", false],
    ["127.0.0.1", true],
    ["::1", true],
    ["::ffff:192.168.1.5", true],
    ["::ffff:8.8.8.8", false],
    ["fd12:3456::1", true],
    ["fe80::1%eth0", true],
    // Tailscale: the person's own network.
    ["100.101.102.103", true],
    ["fd7a:115c:a1e0::1", true],
    ["100.128.0.1", false],
    ["169.254.10.10", true],
    ["8.8.8.8", false],
    ["203.0.113.9", false],
    ["2001:db8::1", false],
    ["192.168.1.300", false],
    ["", false],
    ["local", false],
  ])("%s → %s", (ip, local) => expect(isLocalNetwork(ip)).toBe(local));

  it.each([
    // [connection, headers, local]
    ["192.168.1.5", {}, true],
    ["203.0.113.9", {}, false],
    // A client from the internet cannot write its way in with a header.
    ["203.0.113.9", { "x-forwarded-for": "192.168.1.5" }, false],
    // A proxy at home carrying a request from home.
    ["192.168.1.2", { "x-forwarded-for": "192.168.1.30" }, true],
    // …or from the internet: the proxy says so.
    ["192.168.1.2", { "x-forwarded-for": "198.51.100.4" }, false],
    ["192.168.1.2", { "x-forwarded-for": "198.51.100.4, 192.168.1.2" }, false],
    ["127.0.0.1", { "x-real-ip": "198.51.100.4" }, false],
    ["127.0.0.1", { forwarded: 'for="[2001:db8::1]:443";proto=https' }, false],
    ["127.0.0.1", { forwarded: "for=192.168.1.30;proto=https" }, true],
    // A Cloudflare tunnel on the machine: always the internet.
    ["127.0.0.1", { "cf-connecting-ip": "198.51.100.4" }, false],
    ["127.0.0.1", { "cf-ray": "8a1b-MXP" }, false],
    [undefined, {}, false],
  ] as [string | undefined, Record<string, string>, boolean][])(
    "%s %j → %s",
    (socket, headers, local) => expect(fromLocalNetwork(socket, (n) => headers[n])).toBe(local),
  );

  it("decides what the page offers, as a table", () => {
    const base = {
      hasPassword: false,
      completed: false,
      codeActive: false,
      local: true,
      from: "lan" as const,
    };
    expect(firstAccessOf(base)).toBe("password");
    expect(firstAccessOf({ ...base, local: false })).toBe("not_here");
    expect(firstAccessOf({ ...base, local: false, from: "anywhere" })).toBe("password");
    expect(firstAccessOf({ ...base, codeActive: true })).toBe("code");
    expect(firstAccessOf({ ...base, codeActive: true, local: false })).toBe("code");
    expect(firstAccessOf({ ...base, hasPassword: true })).toBeNull();
    expect(firstAccessOf({ ...base, completed: true })).toBeNull();
    expect(firstAccessOf({ ...base, completed: true, from: "anywhere" })).toBeNull();
    expect(firstAccessFromEnv(undefined)).toBe("lan");
    expect(firstAccessFromEnv("anywhere")).toBe("anywhere");
    expect(firstAccessFromEnv("yes")).toBe("lan");
    expect(setupCodeRequired(undefined)).toBe(false);
    expect(setupCodeRequired("0")).toBe(false);
    expect(setupCodeRequired("1")).toBe(true);
    expect(setupCodeRequired("required")).toBe(true);
  });

  it("prints only the address at a first start: no token, no code", () => {
    const b = firstAccessBanner(7600, ["192.168.1.40"]);
    expect(b).toContain("http://192.168.1.40:7600");
    expect(b).toContain("create your access");
    expect(b).not.toMatch(/token|code/i);
  });
});

describe("the first access over HTTP (G39.7)", () => {
  it("lets the local network create the access once, then it is the usual sign-in", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await withSetup();
    // The default start: only the address, no code to copy.
    expect(await setup.startSetupCode(7600, false, false)).toBeNull();
    expect(setup.setupCode.active).toBe(false);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("create your access");
    expect((await anon("GET", "/api/auth/methods")).body).toMatchObject({
      password: false,
      setupCode: false,
      firstAccess: "password",
    });
    // Weak passwords are refused, nothing is created.
    expect((await anon("POST", "/api/auth/first-access", { password: "short" })).body.code).toBe(
      "weak",
    );
    const ok = await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" });
    expect(ok.status).toBe(200);
    const token = ok.body.token as string;
    expect(token).toMatch(/^rgs_/);
    const setupAs = await fetch(`${s?.url}/api/setup`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(setupAs.status).toBe(200);
    // Once: a second page cannot replace the password.
    const again = await anon("POST", "/api/auth/first-access", { password: "unaltra-password" });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("closed");
    const methods = (await anon("GET", "/api/auth/methods")).body;
    expect(methods).toMatchObject({ password: true });
    expect(methods.firstAccess).toBeUndefined();
    // From now on: the password.
    expect((await anon("POST", "/api/auth/login", { password: "una-password-lunga" })).status).toBe(
      200,
    );
    expect((await anon("POST", "/api/auth/login", { password: "unaltra-password" })).status).toBe(
      400,
    );
  });

  it("refuses an address outside the local network, unless the administrator allows it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await withSetup();
    const outside = { "x-forwarded-for": "203.0.113.9" };
    expect((await anon("GET", "/api/auth/methods", undefined, outside)).body.firstAccess).toBe(
      "not_here",
    );
    const r = await anon(
      "POST",
      "/api/auth/first-access",
      { password: "una-password-lunga" },
      outside,
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not_here");
    const tunnel = { "cf-connecting-ip": "203.0.113.9" };
    expect(
      (await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" }, tunnel))
        .status,
    ).toBe(403);
    expect((await anon("GET", "/api/auth/methods")).body.password).toBe(false);
    await s?.close();
    await withSetup("anywhere");
    expect((await anon("GET", "/api/auth/methods", undefined, outside)).body.firstAccess).toBe(
      "password",
    );
    expect(
      (await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" }, outside))
        .status,
    ).toBe(200);
  });

  it("asks for the setup code only when it is required, and never after the first start", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const setup = await withSetup();
    const code = await setup.startSetupCode(7600, false, true);
    expect(code).toMatch(/^\w{5}-\w{5}$/);
    expect((await anon("GET", "/api/auth/methods")).body.firstAccess).toBe("code");
    const r = await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("code");
    // Used, the code still guards the first access: the local network does not get it instead.
    expect((await anon("POST", "/api/auth/setup-code", { code })).status).toBe(200);
    expect((await anon("GET", "/api/auth/methods")).body.firstAccess).toBe("code");
    expect(
      (await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" })).status,
    ).toBe(403);
    // Not required at the next start: the old code is gone with its file.
    await setup.startSetupCode(7600, false, false);
    expect(setup.setupCode.active).toBe(false);
    expect((await anon("GET", "/api/auth/methods")).body.firstAccess).toBe("password");
    // A completed first start (an installation used with its token) is never open.
    await setup.complete();
    expect((await anon("GET", "/api/auth/methods")).body.firstAccess).toBeUndefined();
    const late = await anon("POST", "/api/auth/first-access", { password: "una-password-lunga" });
    expect(late.status).toBe(403);
    expect(late.body.code).toBe("closed");
  });
});
