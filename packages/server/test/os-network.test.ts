// RedGiant OS (G39.1): Wi-Fi read from iwd's objects, the HTTPS redirect rule, the requests to
// the OS helper, the updates' state, and the routes of Settings › System with a fake helper.
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirstBoot, parseOsUpdates } from "../src/firstboot.js";
import { bareHost, isLanHost, lanHsts, lanRedirect } from "../src/lan-https.js";
import { proxyInFront } from "../src/net-detect.js";
import {
  HelperError,
  type HelperOp,
  helperRequest,
  type OsHelper,
  wifiPasswordOk,
  wifiSsidOk,
} from "../src/os-helper.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import { installKind, UpdateWatcher } from "../src/updates.js";
import { parseWifi, signalPercent } from "../src/wifi.js";
import { startServer } from "./helpers.js";

const v = (type: string, data: unknown) => ({ type, data });
const station = "/net/connman/iwd/0/3";
function iwd(
  nets: { name: string; type?: string; connected?: boolean; dev?: string }[],
  o: { known?: string[]; state?: string; connected?: string } = {},
) {
  const data: Record<string, unknown> = {
    "/net/connman/iwd/0": { "net.connman.iwd.Adapter": { Powered: v("b", true) } },
    [station]: {
      "net.connman.iwd.Device": { Name: v("s", "wlan0") },
      "net.connman.iwd.Station": {
        State: v("s", o.state ?? "disconnected"),
        ...(o.connected && { ConnectedNetwork: v("o", o.connected) }),
      },
    },
  };
  nets.forEach((n, i) => {
    data[`${station}/${i}_${n.type ?? "psk"}`] = {
      "net.connman.iwd.Network": {
        Name: v("s", n.name),
        Type: v("s", n.type ?? "psk"),
        Connected: v("b", n.connected ?? false),
        Device: v("o", n.dev ?? station),
      },
    };
  });
  (o.known ?? []).forEach((k, i) => {
    data[`/net/connman/iwd/known/${i}`] = { "net.connman.iwd.KnownNetwork": { Name: v("s", k) } };
  });
  return { type: "a{oa{sa{sv}}}", data: [data] };
}
const ordered = (pairs: [number, number][]) => ({
  type: "a(on)",
  data: [pairs.map(([i, s]) => [`${station}/${i}_psk`, s])],
});

describe("Wi-Fi as iwd says it (parseWifi)", () => {
  it.each([
    [-10000, 0],
    [-9000, 20],
    [-6500, 70],
    [-5000, 100],
    [-3000, 100],
  ])("signal %i (100 × dBm) is %i%%", (s, p) => expect(signalPercent(s)).toBe(p));

  it("lists the networks, the one in use first, then by signal", () => {
    const w = parseWifi({
      ok: true,
      objects: iwd(
        [
          { name: "Debole" },
          { name: "Forte" },
          { name: "Casa", connected: true },
          { name: "Bar", type: "open" },
        ],
        { known: ["Casa", "Ufficio"], state: "connected", connected: `${station}/2_psk` },
      ),
      ordered: ordered([
        [1, -4000],
        [0, -8500],
        [2, -7000],
      ]),
      links: [
        {
          ifname: "enp1s0",
          link_type: "ether",
          operstate: "UP",
          addr_info: [{ family: "inet", local: "192.168.1.20" }],
        },
        {
          ifname: "wlan0",
          link_type: "ether",
          operstate: "UP",
          addr_info: [{ family: "inet", local: "192.168.1.31" }],
        },
        {
          ifname: "docker0",
          link_type: "ether",
          operstate: "UP",
          addr_info: [{ family: "inet", local: "172.17.0.1" }],
        },
      ],
    });
    expect(w).toEqual({
      available: true,
      device: "wlan0",
      state: "connected",
      connected: "Casa",
      networks: [
        { ssid: "Casa", security: "psk", signal: 60, connected: true, known: true },
        { ssid: "Forte", security: "psk", signal: 100, connected: false, known: false },
        { ssid: "Debole", security: "psk", signal: 30, connected: false, known: false },
        { ssid: "Bar", security: "open", signal: 0, connected: false, known: false },
      ],
      known: ["Casa", "Ufficio"],
      wired: true,
      address: "192.168.1.31",
    });
  });

  // iwd names the network it is still joining (wrong password included): only the helper's
  // `link` (associated: link up and an access point) plus an address make it "connected".
  it.each([
    ["joining, password not checked yet", { associated: false, bssid: null }, "192.168.1.31", null],
    ["associated, no address yet", { associated: true, bssid: "02:00:00:00:01:00" }, null, null],
    [
      "associated with an address",
      { associated: true, bssid: "02:00:00:00:01:00" },
      "192.168.1.31",
      "Casa",
    ],
    ["the helper could not tell", null, "192.168.1.31", null],
  ])("%s", (_n, link, address, connected) => {
    const w = parseWifi({
      ok: true,
      objects: iwd([{ name: "Casa", connected: true }], {
        known: ["Casa"],
        state: "connected",
        connected: `${station}/0_psk`,
      }),
      ordered: null,
      links: [
        {
          ifname: "wlan0",
          link_type: "ether",
          operstate: "UP",
          addr_info: address ? [{ family: "inet", local: address }] : [],
        },
      ],
      link,
    });
    expect(w).toMatchObject({ available: true, connected });
    if (w.available) expect(w.networks[0]?.connected).toBe(connected !== null);
  });

  it.each([
    ["no Wi-Fi card", { ok: true, objects: { type: "x", data: [{}] } }, "no_wifi"],
    ["nothing readable", { ok: true, objects: null }, "failed"],
  ])("%s", (_n, reply, why) => {
    expect(parseWifi(reply as Record<string, unknown>)).toEqual({ available: false, why });
  });

  it("no cable when only Docker's bridges have addresses; another card's networks are left out", () => {
    const w = parseWifi({
      ok: true,
      objects: iwd([{ name: "Mia" }, { name: "Altrui", dev: "/net/connman/iwd/1/9" }]),
      ordered: null,
      links: [
        {
          ifname: "docker0",
          link_type: "ether",
          operstate: "UP",
          addr_info: [{ family: "inet", local: "172.17.0.1" }],
        },
        { ifname: "enp1s0", link_type: "ether", operstate: "DOWN", addr_info: [] },
      ],
    });
    expect(w.available && w.wired).toBe(false);
    expect(w.available && w.networks.map((n) => n.ssid)).toEqual(["Mia"]);
  });
});

describe("the requests for the helper", () => {
  const b = (s: string) => Buffer.from(s).toString("base64");
  it.each<[string, HelperOp, string]>([
    [
      "a network",
      { op: "wifi-connect", ssid: "Casa Rossi", password: "12345678" },
      `wifi-connect ${b("Casa Rossi")} ${b("12345678")} visible`,
    ],
    [
      "a hidden one",
      { op: "wifi-connect", ssid: "X", password: "12345678", hidden: true },
      `wifi-connect ${b("X")} ${b("12345678")} hidden`,
    ],
    [
      "an open one",
      { op: "wifi-connect", ssid: "Libera", password: "" },
      `wifi-connect ${b("Libera")} - visible`,
    ],
    ["forget", { op: "wifi-forget", ssid: "Caffè" }, `wifi-forget ${b("Caffè")}`],
    ["https on", { op: "https-local", on: true }, "https-local on"],
    ["update", { op: "os-update-apply" }, "os-update-apply"],
    ["restart", { op: "reboot" }, "reboot"],
  ])("%s", (_n, op, line) => {
    expect(helperRequest(op)).toBe(line);
    // Only characters the helper's --stdin accepts.
    expect(line).toMatch(/^[A-Za-z0-9._+/= -]+$/);
  });

  it.each([
    ["1234567", false],
    ["12345678", true],
    ["x".repeat(63), true],
    ["x".repeat(64), false],
    ["a".repeat(64), true],
    ["con\naccapo", false],
    ["àccentata1", false],
  ])("password %j: %s", (p, ok) => expect(wifiPasswordOk(p)).toBe(ok));

  it.each([
    ["", false],
    ["Casa", true],
    ["è".repeat(16), true],
    ["è".repeat(17), false],
    ["tab\there", false],
  ])("name %j: %s", (n, ok) => expect(wifiSsidOk(n)).toBe(ok));

  it("refuses before asking", () => {
    expect(() => helperRequest({ op: "wifi-connect", ssid: "Casa", password: "corta" })).toThrow(
      "bad_password",
    );
    expect(() => helperRequest({ op: "wifi-forget", ssid: "x".repeat(33) })).toThrow("bad_ssid");
  });
});

describe("http to https in the local network (lanRedirect)", () => {
  const r = (o: Partial<Parameters<typeof lanRedirect>[0]>) =>
    lanRedirect({
      redirect: true,
      path: "/",
      host: "redgiant.local:7600",
      forwardedProto: undefined,
      ...o,
    });
  it.each([
    ["off: nothing", { redirect: false }, null],
    ["the name, direct on 7600", {}, "https://redgiant.local/"],
    [
      "through Caddy's port 80",
      { host: "redgiant.local", forwardedProto: "http" },
      "https://redgiant.local/",
    ],
    ["already https", { forwardedProto: "https" }, null],
    [
      "a private address keeps its path and query",
      { host: "192.168.1.20:7600", path: "/chat", search: "?a=1" },
      "https://192.168.1.20/chat?a=1",
    ],
    ["an IPv6 ULA", { host: "[fd00::5]:7600" }, "https://[fd00::5]/"],
    ["the machine itself", { host: "127.0.0.1:7600" }, null],
    ["localhost", { host: "localhost:7600" }, null],
    ["Tailscale's name", { host: "redgiant.tail1234.ts.net" }, null],
    ["a domain of one's own", { host: "rg.example.com" }, null],
    ["a public address", { host: "203.0.113.5:7600" }, null],
    ["health stays on http", { path: "/api/health" }, null],
    ["the certificate stays on http", { path: "/redgiant-ca.crt" }, null],
  ])("%s", (_n, o, to) => expect(r(o)).toBe(to));

  it("HSTS only on https of the local network, once the redirect is on", () => {
    expect(lanHsts({ redirect: true, host: "redgiant.local", forwardedProto: "https" })).toBe(
      "max-age=2592000",
    );
    expect(
      lanHsts({ redirect: false, host: "redgiant.local", forwardedProto: "https" }),
    ).toBeNull();
    expect(lanHsts({ redirect: true, host: "redgiant.local", forwardedProto: "http" })).toBeNull();
    expect(lanHsts({ redirect: true, host: "x.ts.net", forwardedProto: "https" })).toBeNull();
  });

  it("hosts", () => {
    expect(bareHost("[fe80::1]:443")).toBe("[fe80::1]");
    expect(isLanHost("redgiant-2.local")).toBe(true);
    expect(isLanHost("172.32.0.1")).toBe(false);
  });

  it("the local HTTPS is not someone else's proxy", () => {
    const h = (m: Record<string, string>) => (n: string) => m[n];
    expect(
      proxyInFront(h({ "x-forwarded-proto": "https", "x-redgiant-local-tls": "1" })),
    ).toBeNull();
    expect(proxyInFront(h({ "x-forwarded-proto": "https" }))).toBe("proxy");
  });
});

describe("RedGiant OS's updates", () => {
  it("is RedGiant OS when its compose file says so, and can update itself through the helper", () => {
    expect(installKind({ REDGIANT_OS: "1" })).toBe("os");
    const w = new UpdateWatcher({
      install: "os",
      installed: "3.7.0",
      dataDir: "/tmp",
      backupBase: "/tmp",
      osUpdater: true,
    });
    expect(w.status().canUpdateHere).toBe(true);
    expect(w.status().command).toBeNull();
  });

  it("never applies a breaking update in place", async () => {
    let asked = 0;
    const w = new UpdateWatcher({
      install: "os",
      installed: "3.7.0",
      dataDir: "/tmp",
      backupBase: "/tmp",
      osUpdater: true,
      act: async () => {
        asked++;
        return true;
      },
    });
    (w as unknown as { last: { gate: string } }).last.gate = "breaking";
    expect(await w.act("update")).toBe(false);
    expect(asked).toBe(0);
  });

  it("reads the helper's state field by field", () => {
    expect(
      parseOsUpdates({
        ok: true,
        update: {
          state: "applying",
          installed: "3.7.0",
          latest: "3.7.1",
          gate: "normal",
          step: "restart",
          note: null,
        },
        running: true,
        security: {
          lastRun: 1762920000,
          result: "success",
          upgraded: 3,
          rebootRequired: true,
          packages: ["libc6", 7],
        },
      }),
    ).toEqual({
      available: true,
      update: {
        state: "applying",
        installed: "3.7.0",
        latest: "3.7.1",
        gate: "normal",
        note: null,
        step: "restart",
        checkedAt: null,
      },
      running: true,
      security: {
        lastRun: "2025-11-12T04:00:00.000Z",
        result: "success",
        upgraded: 3,
        rebootRequired: true,
        packages: ["libc6"],
      },
    });
    expect(
      parseOsUpdates({ ok: true, update: { state: "rm -rf" }, running: false, security: null })
        .update?.state,
    ).toBe("error");
  });
});

// --- the routes, with a fake helper -------------------------------------------------------------

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
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function fake(lines: string[]): OsHelper {
  return {
    how: "socket",
    call: async (o) => {
      lines.push(helperRequest(o));
      switch (o.op) {
        case "wifi-status":
        case "wifi-scan":
          return {
            ok: true,
            objects: iwd([{ name: "Casa", connected: true }]),
            ordered: null,
            links: [],
          };
        case "wifi-connect":
          if (o.password === "sbagliata") throw new HelperError("connect_failed");
          return { ok: true, state: "connected" };
        case "https-status":
          return {
            ok: true,
            on: true,
            enabled: true,
            ca: Buffer.from(PEM).toString("base64"),
            fingerprint: "AA:BB",
            until: "Dec 14 00:00:00 2027 GMT",
            names: ["redgiant.local", "192.168.1.20"],
          };
        case "os-update-status":
        case "os-update-check":
          return {
            ok: true,
            update: { state: "available", installed: "3.7.0", latest: "3.7.1", gate: "normal" },
            running: false,
            security: {
              lastRun: null,
              result: "success",
              upgraded: 0,
              rebootRequired: true,
              packages: [],
            },
          };
        default:
          return { ok: true, in: 5 };
      }
    },
  };
}

async function server(lines: string[]) {
  s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
    const setup = new SetupService({
      db: core.db,
      core,
      dataDir: join(dir, "data"),
      ownerId: "me",
      hooks,
      firstBoot: new FirstBoot({ dataDir: dir, helper: fake(lines) }),
    });
    await setup.applyAtStartup();
    return { setup };
  });
  return s;
}

describe("Settings › System › Network and Updates (routes)", () => {
  it("Wi-Fi: lists, joins, refuses a wrong password, forgets", async () => {
    const lines: string[] = [];
    const sv = await server(lines);
    const w = await sv.api<{ available: boolean; connected: string }>("GET", "/api/setup/wifi");
    expect(w.body).toMatchObject({ available: true, connected: "Casa" });
    const ok = await sv.api<{ state: string }>("POST", "/api/setup/wifi/connect", {
      ssid: "Casa",
      password: "la password giusta",
    });
    expect(ok.body.state).toBe("connected");
    const no = await sv.api<{ code: string }>("POST", "/api/setup/wifi/connect", {
      ssid: "Casa",
      password: "sbagliata",
    });
    expect(no.status).toBe(400);
    expect(no.body.code).toBe("connect_failed");
    // The answer never carries the password back.
    expect(JSON.stringify(ok.body) + JSON.stringify(no.body)).not.toContain("giusta");
    const bad = await sv.api<{ code: string }>("POST", "/api/setup/wifi/connect", {
      ssid: "Casa",
      password: "corta",
    });
    expect(bad.body.code).toBe("bad_password");
    await sv.api("POST", "/api/setup/wifi/forget", { ssid: "Casa" });
    expect(lines.at(-2)).toBe(`wifi-forget ${Buffer.from("Casa").toString("base64")}`);
  });

  it("HTTPS: the certificate for anyone, the redirect only once trusted, then 308 and HSTS", async () => {
    const sv = await server([]);
    const crt = await fetch(`${sv.url}/redgiant-ca.crt`);
    expect(crt.status).toBe(200);
    expect(crt.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(await crt.text()).toBe(PEM);
    const h = await sv.api<{ available: boolean; redirect: boolean; ca: string }>(
      "GET",
      "/api/setup/https",
    );
    expect(h.body).toMatchObject({ available: true, redirect: false, ca: PEM });
    // Not without the page's check that the certificate is trusted.
    const no = await sv.api<{ code: string }>("PUT", "/api/setup/https", { redirect: true });
    expect(no.body.code).toBe("not_trusted");
    // node:http, not fetch: fetch always sends the real Host.
    const lan = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: { get: (n: string) => string | null } }>(
        (resolve, reject) => {
          const req = request(
            `${sv.url}${path}`,
            { headers: { host: "redgiant.local:7600", ...headers } },
            (res) => {
              res.resume();
              resolve({
                status: res.statusCode ?? 0,
                headers: { get: (n) => (res.headers[n] as string | undefined) ?? null },
              });
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
    expect((await lan("/")).status).not.toBe(308);
    const yes = await sv.api<{ redirect: boolean }>("PUT", "/api/setup/https", {
      redirect: true,
      trusted: true,
    });
    expect(yes.body.redirect).toBe(true);
    const r = await lan("/chat?x=1");
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://redgiant.local/chat?x=1");
    expect((await lan("/api/health")).status).toBe(200);
    const tls = await lan("/api/health", {
      "x-forwarded-proto": "https",
      "x-redgiant-local-tls": "1",
    });
    expect(tls.headers.get("strict-transport-security")).toBe("max-age=2592000");
    // Local HTTPS switched off: the redirect goes with it (nobody is sent to a closed door).
    const off = await sv.api<{ redirect: boolean }>("PUT", "/api/setup/https", { local: false });
    expect(off.body.redirect).toBe(false);
    expect((await lan("/")).status).not.toBe(308);
  });

  it("updates and restart: the state, and a restart only with the person's yes", async () => {
    const lines: string[] = [];
    const sv = await server(lines);
    const u = await sv.api<{ update: { latest: string }; security: { rebootRequired: boolean } }>(
      "GET",
      "/api/setup/os-updates",
    );
    expect(u.body.update.latest).toBe("3.7.1");
    expect(u.body.security.rebootRequired).toBe(true);
    await sv.api("POST", "/api/setup/os-updates/check");
    expect(lines).toContain("os-update-check");
    const no = await sv.api("POST", "/api/setup/os/reboot", {});
    expect(no.status).toBe(400);
    expect(lines).not.toContain("reboot");
    const yes = await sv.api<{ in: number }>("POST", "/api/setup/os/reboot", { confirm: true });
    expect(yes.body.in).toBe(5);
    expect(lines).toContain("reboot");
  });
});
