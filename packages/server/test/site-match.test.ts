// G36.21: which page a keychain credential belongs to. A table: change it first.
import { describe, expect, it } from "vitest";
import {
  normalizeHost,
  pageSite,
  registrableDomain,
  siteMatches,
  sitesForSave,
} from "../src/site-match.js";

const github = { url: "https://github.com/login", hosts: ["github.com"] };
const wild = { url: "", hosts: ["*.example.com"] };
const router = { url: "http://192.168.1.1", hosts: [] };
const nas = { url: "https://nas.home.lan:5001", hosts: [] };
const bank = { url: "https://www.banca.it", hosts: ["www.banca.it"] };
const apex = { url: "", hosts: ["example.com"] };
const idn = { url: "", hosts: ["münchen.de"] };

const table: [string, { url: string; hosts: string[] }, string, boolean][] = [
  // The exact site.
  ["the exact host", github, "https://github.com/login", true],
  ["another path of the same host", github, "https://github.com/session?x=1", true],
  ["upper case and a trailing dot", github, "https://GitHub.COM./login", true],
  ["the default port written out", github, "https://github.com:443/login", true],
  // Look-alike names.
  ["a subdomain not listed", github, "https://gist.github.com/", false],
  ["the name as a subdomain of another", github, "https://github.com.evil.net/login", false],
  ["a name that only ends the same", github, "https://evilgithub.com/", false],
  ["a hyphenated look-alike", github, "https://github-login.com/", false],
  ["a digit for a letter", github, "https://g1thub.com/", false],
  ["a Cyrillic twin (punycode)", github, "https://gіthub.com/", false],
  ["a Cyrillic twin written as punycode", github, "https://xn--gthub-n4a.com/", false],
  ["a user name in the address", github, "https://github.com@evil.net/", false],
  ["a user name that looks like the site", github, "https://github.com:x@evil.net/", false],
  // Scheme and port.
  ["https downgraded to http", github, "http://github.com/login", false],
  ["another port", github, "https://github.com:8443/login", false],
  ["a file page", github, "file:///home/me/github.com/login.html", false],
  ["a data page", github, "data:text/html,<form>", false],
  ["a javascript address", github, "javascript:alert(1)", false],
  ["not an address", github, "github.com", false],
  // Wildcards.
  ["a wildcard's subdomain", wild, "https://login.example.com/", true],
  ["a wildcard's deeper subdomain", wild, "https://a.b.example.com/", true],
  ["a wildcard does not match the domain itself", wild, "https://example.com/", false],
  ["a wildcard and a look-alike", wild, "https://login.example.com.evil.net/", false],
  ["a wildcard and a name ending the same", wild, "https://badexample.com/", false],
  [
    "a wildcard over a public suffix",
    { url: "", hosts: ["*.co.uk"] },
    "https://bank.co.uk/",
    false,
  ],
  [
    "a wildcard over a hosting suffix",
    { url: "", hosts: ["*.github.io"] },
    "https://me.github.io/",
    false,
  ],
  ["a wildcard over a TLD", { url: "", hosts: ["*.com"] }, "https://github.com/", false],
  ["a wildcard over localhost", { url: "", hosts: ["*.localhost"] }, "http://a.localhost/", false],
  [
    "a hosting subdomain listed exactly",
    { url: "", hosts: ["me.github.io"] },
    "https://me.github.io/",
    true,
  ],
  [
    "a neighbour on the same hosting suffix",
    { url: "", hosts: ["me.github.io"] },
    "https://you.github.io/",
    false,
  ],
  // Home devices on http.
  ["a router on http, its own address", router, "http://192.168.1.1/login", true],
  ["the router on https", router, "https://192.168.1.1/", true],
  ["the router's neighbour", router, "http://192.168.1.2/", false],
  ["the router on another port", router, "http://192.168.1.1:8080/", false],
  ["a NAS on its port", nas, "https://nas.home.lan:5001/", true],
  ["the NAS on the default port", nas, "https://nas.home.lan/", false],
  ["the NAS on http", nas, "http://nas.home.lan:5001/", false],
  // www and the domain.
  ["www listed, the bare domain asked", bank, "https://banca.it/", false],
  ["the bare domain listed, www asked", apex, "https://www.example.com/", false],
  // International names are compared in their ASCII form.
  ["an international name written in Unicode", idn, "https://münchen.de/", true],
  ["an international name written as punycode", idn, "https://xn--mnchen-3ya.de/", true],
  ["a twin of an international name", idn, "https://munchen.de/", false],
  // Nothing to compare with.
  ["a credential without sites", { url: "", hosts: [] }, "https://github.com/", false],
  ["a credential with a broken site", { url: "::", hosts: ["a b"] }, "https://github.com/", false],
];

describe("siteMatches (G36.21: phishing table)", () => {
  for (const [what, entry, page, ok] of table)
    it(`${ok ? "matches" : "refuses"}: ${what}`, () => {
      const v = siteMatches(entry, page);
      expect(v.ok, JSON.stringify(v)).toBe(ok);
    });

  it("says why it refuses", () => {
    const v = siteMatches(github, "http://github.com/");
    expect(v).toEqual({ ok: false, why: expect.stringContaining("not secure") });
    expect(siteMatches(github, "https://github.com:8443/")).toEqual({
      ok: false,
      why: expect.stringContaining("port 8443"),
    });
  });

  it("knows registrable domains", () => {
    expect(registrableDomain("login.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("me.github.io")).toBe("me.github.io");
    expect(registrableDomain("co.uk")).toBeNull();
    expect(registrableDomain("192.168.1.1")).toBe("192.168.1.1");
    expect(registrableDomain("localhost")).toBe("localhost");
  });

  it("normalizes hosts and pages", () => {
    expect(normalizeHost(" GitHub.com. ")).toBe("github.com");
    expect(normalizeHost("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeHost("a b")).toBeNull();
    expect(normalizeHost("evil.net/github.com")).toBeNull();
    expect(pageSite("https://github.com@evil.net/")?.host).toBe("evil.net");
    expect(pageSite("ftp://github.com/")).toBeNull();
  });

  it("gives a saved credential the page's host and only same-domain extras", () => {
    expect(sitesForSave("https://login.example.com/x")).toEqual(["login.example.com"]);
    expect(
      sitesForSave("https://login.example.com/", [
        "*.example.com",
        "evil.net",
        "*.co.uk",
        "www.example.com",
      ]),
    ).toEqual(["login.example.com", "*.example.com", "www.example.com"]);
    expect(sitesForSave("file:///x")).toBeNull();
  });
});
