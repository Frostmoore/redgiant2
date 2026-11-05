import { createServer } from "node:http";
import type { ToolContext } from "@redgiant/agent";
import { describe, expect, it } from "vitest";
import { fetchTool, isNonPublicAddress, type ResolveHost } from "../src/index.js";

const ctx: ToolContext = { ownerId: "local", projectId: "p", agentId: "a", sessionId: "s" };

/** A fake DNS: names to addresses; anything else does not resolve. */
const dns =
  (table: Record<string, string[]>): ResolveHost =>
  async (host) =>
    (table[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

const PUBLIC = { "example.com": ["93.184.215.14"], "cdn.example.com": ["2606:2800:21f::1"] };

/** A fetch that answers from a list of handlers, recording the URLs asked. */
function fakeFetch(answer: (url: string) => Response) {
  const asked: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    expect(init?.redirect).toBe("manual");
    asked.push(url);
    return answer(url);
  }) as unknown as typeof fetch;
  return { f, asked };
}

const run = async (
  url: string,
  f: typeof fetch,
  o: Parameters<typeof fetchTool>[2] = {},
): Promise<{ content: string; isError: boolean }> => {
  const out = await fetchTool("full", f, { lookup: dns(PUBLIC), ...o }).run({ url }, ctx);
  return typeof out === "string"
    ? { content: out, isError: false }
    : { content: out.content, isError: out.isError ?? false };
};

describe("fetch reaches only the public web", () => {
  it("knows which addresses are not public", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.12",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:192.168.0.1",
      "64:ff9b::10.0.0.1",
      "not an address",
    ])
      expect(isNonPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      "93.184.215.14",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2606:2800:21f::1",
      "::ffff:8.8.8.8",
    ])
      expect(isNonPublicAddress(ip), ip).toBe(false);
  });

  it("refuses local, private and link-local targets before connecting", async () => {
    const { f, asked } = fakeFetch(() => new Response("secret"));
    const lookup = dns({
      ...PUBLIC,
      localhost: ["127.0.0.1"],
      "router.lan": ["192.168.1.1"],
      // One private address among public ones is enough to refuse.
      "mixed.example": ["93.184.215.14", "10.0.0.5"],
      "v6.example": ["fd00::5"],
    });
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "http://localhost/admin",
      "http://router.lan/",
      "http://mixed.example/",
      "http://v6.example/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://0.0.0.0/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      const r = await run(url, f, { lookup });
      expect(r.isError, url).toBe(true);
      expect(r.content, url).toMatch(/local or private network/);
    }
    // A name that does not resolve is refused too.
    expect((await run("http://nowhere.invalid/", f, { lookup })).isError).toBe(true);
    expect(asked).toEqual([]);
  });

  it("allows only http and https", async () => {
    const { f, asked } = fakeFetch(() => new Response("x"));
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/"]) {
      const r = await run(url, f);
      expect(r).toEqual({ content: "Only http and https URLs are supported.", isError: true });
    }
    expect((await run("http://user:pw@example.com/", f)).isError).toBe(true);
    expect(asked).toEqual([]);
  });

  it("checks every redirect again, and stops after five", async () => {
    const lookup = dns({ ...PUBLIC, "internal.example": ["192.168.1.12"] });
    const toPrivate = fakeFetch((url) =>
      url === "https://example.com/"
        ? new Response(null, { status: 302, headers: { location: "http://internal.example/x" } })
        : new Response("internal secret"),
    );
    const r = await run("https://example.com/", toPrivate.f, { lookup });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/internal\.example is a local or private network address/);
    expect(toPrivate.asked).toEqual(["https://example.com/"]);

    // To a public address (relative location) it is followed.
    const ok = fakeFetch((url) =>
      url === "https://example.com/old"
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response("moved here", { headers: { "content-type": "text/plain" } }),
    );
    const moved = await run("https://example.com/old", ok.f);
    expect(moved).toEqual({
      content: "URL: https://example.com/new\nStatus: 200\n\nmoved here",
      isError: false,
    });

    let n = 0;
    const loop = fakeFetch(
      () => new Response(null, { status: 307, headers: { location: `/hop${++n}` } }),
    );
    const many = await run("https://example.com/", loop.f);
    expect(many.isError).toBe(true);
    expect(many.content).toMatch(/Too many redirects/);
    expect(loop.asked).toHaveLength(6);
  });

  it("reads at most the cap of a body, then says so", async () => {
    let cancelled = false;
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new TextEncoder().encode("a".repeat(1000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { f } = fakeFetch(
      () => new Response(endless, { headers: { "content-type": "text/plain" } }),
    );
    const r = await run("https://example.com/big", f, { maxBytes: 2500 });
    expect(r.isError).toBe(false);
    expect(r.content).toContain(`\n\n${"a".repeat(2500)}\n[only the first 2500 bytes were read]`);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("gives up after its timeout", async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise((_ok, ko) =>
        init?.signal?.addEventListener("abort", () => ko(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const r = await run("https://example.com/slow", f, { timeoutMs: 50 });
    expect(r).toEqual({ content: "Timed out fetching https://example.com/slow", isError: true });
  });

  it("without a fetch of its own never connects to the server's network", async () => {
    let hits = 0;
    const srv = createServer((_q, res) => {
      hits++;
      res.end("local");
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const { port } = srv.address() as { port: number };
      const tool = fetchTool("full", undefined, {
        lookup: dns({ "sneaky.example": ["127.0.0.1"] }),
      });
      for (const url of [`http://127.0.0.1:${port}/`, `http://sneaky.example:${port}/`]) {
        const out = await tool.run({ url }, ctx);
        expect(typeof out !== "string" && out.isError).toBe(true);
      }
      expect(hits).toBe(0);
    } finally {
      srv.close();
    }
  });
});
