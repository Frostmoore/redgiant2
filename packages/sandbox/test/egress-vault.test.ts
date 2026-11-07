import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressProxy } from "../src/index.js";

// The keychain's credentials for extensions' tools (G33.4): `/vault/<cap>/<host>/<path>`.
const VALUE = "rk_live_Zq81mXv3PdQw7Tn2LbYc";
let hasOpenssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  hasOpenssl = false;
}

let upstream: https.Server | undefined;
let upPort = 0;
let proxy: EgressProxy;
let proxyPort = 0;

beforeAll(async () => {
  proxy = new EgressProxy({ allow: [] });
  proxyPort = await proxy.listen(0, "127.0.0.1");
  if (!hasOpenssl) return;
  const dir = mkdtempSync(join(tmpdir(), "rg-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
    ],
    { stdio: "ignore" },
  );
  upstream = https.createServer(
    { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          path: req.url,
          key: req.headers["x-api-key"] ?? null,
          auth: req.headers.authorization ?? null,
        }),
      );
    },
  );
  await new Promise<void>((ok) => upstream?.listen(0, "127.0.0.1", ok));
  upPort = (upstream.address() as { port: number }).port;
});

afterAll(async () => {
  await proxy.close();
  upstream?.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((ok, ko) => {
    const r = http.request({ host: "127.0.0.1", port: proxyPort, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", ko);
    r.end();
  });

describe("keychain credentials through the egress proxy (G33.4)", () => {
  it("refuses unknown capabilities and hosts that are not the credential's", async () => {
    proxy.setVault([
      {
        cap: "cap-1",
        name: "bank",
        value: VALUE,
        hosts: ["b2b.bank.example"],
        inject: { header: "authorization", format: "Bearer {value}" },
      },
    ]);
    expect((await get("/vault/nope/b2b.bank.example/x")).status).toBe(404);
    const r = await get("/vault/cap-1/evil.example/steal");
    expect(r.status).toBe(403);
    expect(r.body).toContain("not a host of credential");
    expect(r.body).not.toContain(VALUE);
  });

  it.skipIf(!hasOpenssl)(
    "puts the value where the placeholder is, and hides it in the answer",
    async () => {
      const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        proxy.setVault([
          {
            cap: "cap-2",
            name: "bank",
            value: VALUE,
            hosts: ["127.0.0.1"],
            inject: { header: "authorization", format: "Bearer {value}" },
          },
        ]);
        const placed = await get(`/vault/cap-2/127.0.0.1:${upPort}/api/accounts`, {
          "x-api-key": "{{vault:bank}}",
        });
        expect(placed.status).toBe(200);
        const body = JSON.parse(placed.body);
        expect(body.path).toBe("/api/accounts");
        // The upstream received the value; the sandbox reads it back hidden.
        expect(body.key).toBe("[vault]");
        expect(placed.body).not.toContain(VALUE);
        // No placeholder: its usual header.
        const usual = JSON.parse((await get(`/vault/cap-2/127.0.0.1:${upPort}/x`)).body);
        expect(usual.auth).toBe("Bearer [vault]");
      } finally {
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      }
    },
  );
});
