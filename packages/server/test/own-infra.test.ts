// G39.8: «You already have your own infrastructure». RedGiant sees that the page came through a
// proxy at home, or with a name of the home's DNS, and says «You are reachable as <host>»; the
// person may say «Skip: I am reachable already», which stops the invitations to set up
// RedGiant's own ways out and makes the links use their address.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirstBoot } from "../src/firstboot.js";
import { lanEndpoint, reachedAs } from "../src/net-detect.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const hooks: SetupHooks = {
  key: async () => [],
  server: async () => [],
  telegram: async () => null,
  search: async () => {},
  engine: async () => {},
};

describe("reached already (G39.8)", () => {
  it.each([
    // [connection, headers, result]
    [
      "192.168.1.2",
      {
        host: "192.168.1.40:7600",
        "x-forwarded-for": "100.101.1.2",
        "x-forwarded-host": "redgiant.home.example.com",
        "x-forwarded-proto": "https",
      },
      { host: "redgiant.home.example.com", https: true, through: "proxy" },
    ],
    // Caddy passes the Host through and says it with Via.
    [
      "192.168.1.2",
      { host: "redgiant.example.org", via: "2.0 Caddy", "x-forwarded-proto": "https" },
      { host: "redgiant.example.org", https: true, through: "proxy" },
    ],
    [
      "10.0.0.2",
      { host: "10.0.0.5:7600", forwarded: 'for=10.0.0.9;host="rg.lan";proto=http' },
      { host: "rg.lan", https: false, through: "proxy" },
    ],
    // A name of the home's DNS straight to RedGiant.
    [
      "192.168.1.30",
      { host: "redgiant.lan:7600" },
      { host: "redgiant.lan", https: false, through: "name" },
    ],
    [
      "192.168.1.30",
      { host: "redgiant:7600" },
      { host: "redgiant", https: false, through: "name" },
    ],
    // Not someone else's: an address, RedGiant's own mDNS name, RedGiant OS's own HTTPS.
    ["192.168.1.30", { host: "192.168.1.40:7600" }, null],
    ["192.168.1.30", { host: "redgiant.local:7600" }, null],
    [
      "127.0.0.1",
      { host: "redgiant.local", "x-forwarded-proto": "https", "x-redgiant-local-tls": "1" },
      null,
    ],
    // Forwarded headers on a connection from the internet: written by the client, not a proxy.
    ["203.0.113.9", { host: "203.0.113.1", "x-forwarded-host": "evil.example" }, null],
    // A proxy that sends only an address on.
    ["192.168.1.2", { host: "192.168.1.40:7600", "x-forwarded-for": "192.168.1.30" }, null],
  ] as [string, Record<string, string>, unknown][])("%s %j", (socket, headers, want) =>
    expect(reachedAs((n) => headers[n], socket)).toEqual(want),
  );

  it("finds RedGiant's address and port for the blocks to copy", () => {
    expect(lanEndpoint("192.168.1.40:7600", ["10.0.0.5"], 7600)).toEqual({
      address: "192.168.1.40",
      port: 7600,
    });
    expect(lanEndpoint("redgiant.home.example.com", ["192.168.1.40"], 7600)).toEqual({
      address: "192.168.1.40",
      port: 7600,
    });
    expect(lanEndpoint("127.0.0.1:8123", [], undefined)).toEqual({ address: null, port: 8123 });
    expect(lanEndpoint(undefined, [], undefined)).toEqual({ address: null, port: 7600 });
  });

  it("over HTTP: says it is reached as the proxy's name, and «skip» is kept", async () => {
    let setup: SetupService | undefined;
    s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
        firstBoot: new FirstBoot({ dataDir: join(dir, "data"), platform: "win32" }),
      });
      await setup.applyAtStartup();
      return { setup };
    });
    const r = await fetch(`${s.url}/api/setup/net`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-forwarded-for": "100.64.0.7",
        "x-forwarded-host": "redgiant.home.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(await r.json()).toMatchObject({
      proxyInFront: "proxy",
      reachedAs: { host: "redgiant.home.example.com", https: true, through: "proxy" },
      lan: { port: expect.any(Number) },
    });
    expect(
      (await s.api("PUT", "/api/setup/reachable", { on: true, url: "javascript:alert(1)" })).status,
    ).toBe(400);
    expect(
      (
        await s.api("PUT", "/api/setup/reachable", {
          on: true,
          url: "https://redgiant.home.example.com/",
        })
      ).status,
    ).toBe(200);
    const state = await s.api<{ config: { reachable?: { url?: string } } }>("GET", "/api/setup");
    expect(state.body.config.reachable?.url).toBe("https://redgiant.home.example.com");
    expect((await s.api("PUT", "/api/setup/reachable", { on: false })).status).toBe(200);
    expect(
      (await s.api<{ config: { reachable?: unknown } }>("GET", "/api/setup")).body.config.reachable,
    ).toBeUndefined();
  });
});
