import http, { type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EgressDecision, EgressProxy, hostAllowed, isPrivateAddress } from "../src/index.js";

let upstream: http.Server;
let upPort = 0;
let proxy: EgressProxy;
let proxyPort = 0;
const decisions: EgressDecision[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        path: req.url,
        auth: req.headers.authorization ?? null,
        host: req.headers.host,
      }),
    );
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  upPort = (upstream.address() as { port: number }).port;
  proxy = new EgressProxy(
    {
      allow: ["127.0.0.1", "localhost", "*.example.org"],
      allowPrivate: ["127.0.0.1"],
      routes: {
        github: {
          upstream: `http://127.0.0.1:${upPort}/api/`,
          headers: { Authorization: "Bearer real-secret" },
        },
      },
    },
    (d) => decisions.push(d),
  );
  proxyPort = await proxy.listen(0, "127.0.0.1");
});
afterAll(async () => {
  await proxy.close();
  await new Promise((ok) => upstream.close(ok));
});

function viaProxy(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((ok, ko) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, path, headers },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", ko);
    req.end();
  });
}

function connectVia(target: string): Promise<string> {
  return new Promise((ok, ko) => {
    const s = connect(proxyPort, "127.0.0.1", () =>
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let data = "";
    s.on("data", (d) => {
      data += d.toString();
      if (data.includes("\r\n\r\n")) {
        s.destroy();
        ok(data.split("\r\n")[0] ?? "");
      }
    });
    s.on("error", ko);
  });
}

describe("EgressProxy", () => {
  it("forwards allowed HTTP requests", async () => {
    const r = await viaProxy(`http://127.0.0.1:${upPort}/hello`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ path: "/hello" });
  });

  it("refuses hosts outside the allow list", async () => {
    const r = await viaProxy("http://evil.test/steal");
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/not in the allow list/);
  });

  it("refuses allowed names that resolve to private addresses (SSRF)", async () => {
    const r = await viaProxy(`http://localhost:${upPort}/`);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/private address/);
  });

  it("tunnels CONNECT only to allowed hosts", async () => {
    expect(await connectVia(`127.0.0.1:${upPort}`)).toBe("HTTP/1.1 200 Connection Established");
    expect(await connectVia("evil.test:443")).toBe("HTTP/1.1 403 Forbidden");
  });

  it("survives clients that hang up abruptly", async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((ok) => {
        const s = connect(proxyPort, "127.0.0.1", () => {
          s.write("CONNECT evil.test:443 HTTP/1.1\r\n\r\n");
          s.resetAndDestroy();
          ok();
        });
        s.on("error", () => ok());
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    expect((await viaProxy(`http://127.0.0.1:${upPort}/still-alive`)).status).toBe(200);
  });

  it("injects route credentials, replacing what the sandbox sent", async () => {
    const r = await viaProxy("/route/github/repos/x?y=1", { authorization: "Bearer forged" });
    expect(JSON.parse(r.body)).toEqual({
      path: "/api/repos/x?y=1",
      auth: "Bearer real-secret",
      host: `127.0.0.1:${upPort}`,
    });
    expect((await viaProxy("/route/nope/x")).status).toBe(404);
  });

  it("takes routes added while running (GitHub, Gitea), the newest over the file's", async () => {
    proxy.setRoutes({
      gitea: {
        upstream: `http://127.0.0.1:${upPort}/gitea/`,
        headers: { authorization: "Basic added-later" },
      },
    });
    const r = await viaProxy("/route/gitea/mario/app.git/info/refs");
    expect(JSON.parse(r.body)).toMatchObject({
      path: "/gitea/mario/app.git/info/refs",
      auth: "Basic added-later",
    });
    proxy.setRoutes({});
    expect((await viaProxy("/route/gitea/x")).status).toBe(404);
    // The policy's own routes stay.
    expect((await viaProxy("/route/github/repos/x")).status).toBe(200);
  });

  it("reports every decision", () => {
    expect(decisions.some((d) => d.host === "evil.test" && !d.allowed)).toBe(true);
    expect(decisions.some((d) => d.kind === "route" && d.allowed)).toBe(true);
  });
});

describe("policy helpers", () => {
  it("matches exact names and subdomain wildcards", () => {
    expect(hostAllowed("api.example.org", ["*.example.org"])).toBe(true);
    expect(hostAllowed("example.org", ["*.example.org"])).toBe(false);
    expect(hostAllowed("evilexample.org", ["*.example.org"])).toBe(false);
    expect(hostAllowed("GitHub.com.", ["github.com"])).toBe(true);
  });

  it.each([
    ["10.1.2.3", true],
    ["172.20.0.1", true],
    ["172.32.0.1", false],
    ["192.168.1.10", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],
    ["100.98.200.21", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["fd12::1", true],
    ["::ffff:10.0.0.1", true],
    ["2606:4700::1111", false],
  ])("isPrivateAddress(%s) = %s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});
