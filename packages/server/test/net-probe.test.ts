// «Your home services seen by RedGiant» (p3.7.3): which names «Try a name» accepts, how Node's
// network errors read, what a probe answers (nothing of the service's answer but its status),
// and «A Gitea you already have» saying why instead of «fetch failed».
import { describe, expect, it } from "vitest";
import { GitHostError, GitHosts } from "../src/git-hosts.js";
import { netFailure, probeName, probeService } from "../src/net-probe.js";

const netError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`getaddrinfo ${code} git.home.example.com`), { code }),
  });

describe("the names «Try a name» accepts", () => {
  it.each([
    ["git.home.varitest.ovh", "git.home.varitest.ovh"],
    [" Git.Home.Example.com. ", "git.home.example.com"],
    ["nas", "nas"],
    ["my-nas.lan", "my-nas.lan"],
    ["192.168.1.12", null],
    ["::1", null],
    ["localhost", null],
    ["a.localhost", null],
    ["git.example.com:3000", null],
    ["https://git.example.com", null],
    ["git.example.com/path", null],
    ["-bad.example.com", null],
    ["bad-.example.com", null],
    ["a..b", null],
    ["x y", null],
    ["", null],
    [`${"a".repeat(64)}.com`, null],
  ])("%j → %j", (text, want) => expect(probeName(text)).toBe(want));
});

describe("Node's network errors in a word", () => {
  it.each([
    [netError("ENOTFOUND"), "not_found"],
    [netError("EAI_AGAIN"), "dns_failed"],
    [netError("ECONNREFUSED"), "unreachable"],
    [netError("EHOSTUNREACH"), "unreachable"],
    [netError("UND_ERR_CONNECT_TIMEOUT"), "timeout"],
    [netError("DEPTH_ZERO_SELF_SIGNED_CERT"), "tls"],
    [netError("ERR_TLS_CERT_ALTNAME_INVALID"), "tls"],
    [Object.assign(new Error("timed out"), { name: "TimeoutError" }), "timeout"],
    [new Error("something else"), null],
  ])("%s", (err, want) => expect(netFailure(err)).toBe(want));
});

describe("a probe", () => {
  const found = async () => ({ address: "192.168.1.12" });
  it("says the address and the status, HEAD first and GET only when HEAD is refused", async () => {
    const asked: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      asked.push(`${init.method} ${url} ${init.redirect}`);
      return new Response("secret page", { status: init.method === "HEAD" ? 405 : 302 });
    }) as unknown as typeof fetch;
    const p = await probeService("git.home.example.com", { lookup: found, fetch: f });
    expect(p).toEqual({
      name: "git.home.example.com",
      address: "192.168.1.12",
      reachable: true,
      status: 302,
      why: "ok",
    });
    expect(JSON.stringify(p)).not.toContain("secret");
    expect(asked).toEqual([
      "HEAD https://git.home.example.com/ manual",
      "GET https://git.home.example.com/ manual",
    ]);
  });

  it("a name the DNS does not know: no request at all", async () => {
    let fetched = false;
    const p = await probeService("git.home.example.com", {
      lookup: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
      },
      fetch: (async () => {
        fetched = true;
        return new Response(null);
      }) as unknown as typeof fetch,
    });
    expect(p).toMatchObject({ address: null, reachable: false, why: "not_found" });
    expect(fetched).toBe(false);
  });

  it("a DNS that does not answer in time", async () => {
    const p = await probeService("git.home.example.com", {
      lookup: () => new Promise(() => {}),
      lookupMs: 20,
    });
    expect(p).toMatchObject({ address: null, why: "dns_failed" });
  });

  it.each([
    ["ECONNREFUSED", false, "unreachable"],
    ["UND_ERR_CONNECT_TIMEOUT", false, "timeout"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", true, "tls"],
  ])("an answer that fails with %s", async (code, reachable, why) => {
    const p = await probeService("git.home.example.com", {
      lookup: async () => ({ address: "100.101.1.2" }),
      fetch: (async () => {
        throw netError(code);
      }) as unknown as typeof fetch,
    });
    expect(p).toEqual({
      name: "git.home.example.com",
      address: "100.101.1.2",
      reachable,
      status: null,
      why,
    });
  });
});

describe("«A Gitea you already have» says why (p3.7.3)", () => {
  it.each([
    ["ENOTFOUND", "name_not_found", "does not know git.home.example.com"],
    ["EAI_AGAIN", "name_not_found", "does not know git.home.example.com"],
    ["EHOSTUNREACH", "host_unreachable", "its address does not answer"],
    ["UND_ERR_CONNECT_TIMEOUT", "host_unreachable", "its address does not answer"],
    ["ECONNRESET_X", "unreachable", "fetch failed"],
  ])("%s → %s", async (code, want, words) => {
    const g = new GitHosts({
      fetch: (async () => {
        throw netError(code);
      }) as unknown as typeof fetch,
    });
    const err = await g
      .checkGitea("https://git.home.example.com", "marta", "un-token-lungo")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHostError);
    expect((err as GitHostError).code).toBe(want);
    expect((err as Error).message).toContain(words);
  });
});
