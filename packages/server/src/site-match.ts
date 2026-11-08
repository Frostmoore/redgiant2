// Which keychain credentials belong to a web page (G36.21, the browser extension). One pure
// function decides, and the server applies it to every request of the extension: a credential is
// offered, read or updated only for the exact site it is bound to. Phishing pages live on look-alike
// names (`examp1e.com`, `example.com.evil.net`, punycode twins), on a subdomain someone else controls,
// on another port or on plain http: none of them matches.
//
// The rules, in order:
// - only http: and https: pages; the host compared in its ASCII form (punycode), lower case, without a
//   trailing dot; user names and passwords in the address do not count (the URL parser drops them);
// - the credential's sites are its `hosts` and the host of its `url`; `*.example.com` matches the
//   subdomains only (not example.com itself), and never when example.com is a public suffix
//   (`*.co.uk`, `*.github.io`): there every subdomain belongs to someone else;
// - an IP address matches only itself;
// - a page on http: matches only a credential whose `url` is http: on that very host (a home router);
//   a credential for https never goes to http;
// - the port: the `url`'s port when the page is on the `url`'s host, otherwise the default port only;
// - and, as a last guard, the page and the matching site must share their registrable domain.

import { isIP } from "node:net";

/** Public suffixes under which every name belongs to a different owner (a subset of the PSL). */
const PUBLIC_SUFFIXES = new Set([
  // Second levels of country domains.
  ...["co", "org", "ac", "gov", "ltd", "plc", "me", "net", "nhs", "sch"].map((s) => `${s}.uk`),
  ...["com", "net", "org", "edu", "gov", "asn", "id"].map((s) => `${s}.au`),
  ...["co", "ne", "or", "ac", "go", "ad", "ed", "gr", "lg"].map((s) => `${s}.jp`),
  ...["co", "org", "net", "ac", "govt", "geek", "school"].map((s) => `${s}.nz`),
  ...["com", "net", "org", "gov", "edu", "art", "blog", "eco", "app"].map((s) => `${s}.br`),
  ...["com", "net", "org", "gov", "edu", "ac"].map((s) => `${s}.cn`),
  ...["com", "net", "org", "gob", "edu"].map((s) => `${s}.mx`),
  ...["co", "net", "org", "gen", "firm", "ind", "ac", "edu", "gov", "res"].map((s) => `${s}.in`),
  ...["co", "org", "net", "ac", "gov", "web"].map((s) => `${s}.za`),
  ...["com", "net", "org", "gen", "biz", "info", "av", "bel", "edu", "gov", "k12", "web"].map(
    (s) => `${s}.tr`,
  ),
  ...["com", "net", "org", "gob", "edu", "int"].map((s) => `${s}.ar`),
  ...["co", "or", "ac", "go", "ne", "re"].map((s) => `${s}.kr`),
  ...["com", "net", "org", "edu", "gov", "idv"].map((s) => `${s}.tw`),
  ...["com", "net", "org", "edu", "gov", "idv"].map((s) => `${s}.hk`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.sg`),
  ...["co", "or", "ac", "go", "ne"].map((s) => `${s}.id`),
  ...["com", "net", "org", "edu", "gov"].map((s) => `${s}.my`),
  ...["co", "com", "net", "org", "ac", "gov"].map((s) => `${s}.il`),
  ...["com", "net", "org", "edu", "gov", "pp"].map((s) => `${s}.ru`),
  ...["com", "net", "org", "edu", "gov", "in"].map((s) => `${s}.ua`),
  ...["com", "net", "org", "edu", "gov", "info", "waw"].map((s) => `${s}.pl`),
  ...["com", "net", "org", "edu", "gob", "nom"].map((s) => `${s}.es`),
  ...["com", "org", "edu", "gov"].map((s) => `${s}.pt`),
  ...["co", "or", "gv", "ac"].map((s) => `${s}.at`),
  ...["com", "asso", "gouv", "nom", "tm"].map((s) => `${s}.fr`),
  ...["gov", "edu"].map((s) => `${s}.it`),
  // Hosting and dynamic DNS: each subdomain is a different customer.
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "vercel.app",
  "now.sh",
  "netlify.app",
  "netlify.com",
  "pages.dev",
  "workers.dev",
  "herokuapp.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "azurestaticapps.net",
  "cloudfront.net",
  "s3.amazonaws.com",
  "elasticbeanstalk.com",
  "blogspot.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "repl.co",
  "replit.dev",
  "surge.sh",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "trycloudflare.com",
  "duckdns.org",
  "ddns.net",
  "dyndns.org",
  "no-ip.org",
  "myqnapcloud.com",
  "synology.me",
  "tailscale.net",
  "ts.net",
  "localhost",
]);

/** A host as the URL parser writes it (ASCII, lower case), or null when it is not a host. */
export function normalizeHost(raw: string): string | null {
  const h = raw.trim().replace(/\.+$/, "");
  if (!h || /[\s/?#@\\]/.test(h)) return null;
  try {
    const host = new URL(`http://${h}`).hostname.replace(/\.+$/, "");
    return host || null;
  } catch {
    return null;
  }
}

const isAddress = (host: string) => isIP(host.replace(/^\[|\]$/g, "")) !== 0;

/** True for a public suffix: a TLD, or a name under which every subdomain has its own owner. */
export function isPublicSuffix(host: string): boolean {
  return !host.includes(".") || PUBLIC_SUFFIXES.has(host);
}

/**
 * The registrable domain (eTLD+1) of a host: `login.example.co.uk` ⇒ `example.co.uk`,
 * `me.github.io` ⇒ `me.github.io`. An IP address is its own; a public suffix has none.
 */
export function registrableDomain(host: string): string | null {
  if (isAddress(host)) return host;
  if (isPublicSuffix(host)) return host === "localhost" ? host : null;
  const labels = host.split(".");
  for (let i = 1; i < labels.length; i++) {
    const rest = labels.slice(i).join(".");
    if (PUBLIC_SUFFIXES.has(rest)) return labels.slice(i - 1).join(".");
  }
  return labels.slice(-2).join(".");
}

const defaultPort = (protocol: string) => (protocol === "https:" ? "443" : "80");
const portOf = (u: URL) => u.port || defaultPort(u.protocol);

export interface PageSite {
  origin: string;
  protocol: "http:" | "https:";
  host: string;
  port: string;
  registrable: string | null;
}

/** A page's address read for matching, or null when it is not an http(s) page. */
export function pageSite(pageUrl: string): PageSite | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/\.+$/, "");
  if (!host) return null;
  return {
    origin: u.origin,
    protocol: u.protocol,
    host,
    port: portOf(u),
    registrable: registrableDomain(host),
  };
}

/** What a credential says about where it belongs. */
export interface CredentialSites {
  url: string;
  hosts: string[];
}

export type SiteVerdict = { ok: true; via: string } | { ok: false; why: string };

/** Does this page belong to this credential? See the rules at the top of the file. */
export function siteMatches(entry: CredentialSites, pageUrl: string): SiteVerdict {
  const page = pageSite(pageUrl);
  if (!page) return { ok: false, why: "not a web page (only http and https)" };
  let url: URL | null = null;
  if (entry.url.trim()) {
    try {
      const u = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`,
      );
      if (u.protocol === "http:" || u.protocol === "https:") url = u;
    } catch {
      url = null;
    }
  }
  const urlHost = url ? url.hostname.replace(/\.+$/, "") : null;
  const patterns: string[] = [];
  for (const raw of entry.hosts) {
    const wild = raw.trim().startsWith("*.");
    const h = normalizeHost(wild ? raw.trim().slice(2) : raw);
    if (h) patterns.push(wild ? `*.${h}` : h);
  }
  if (urlHost) patterns.push(urlHost);
  if (patterns.length === 0) return { ok: false, why: "the credential has no site" };

  const onUrlHost = urlHost !== null && page.host === urlHost;
  const hit = patterns.find((p) => {
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      if (isAddress(base) || isPublicSuffix(base)) return false;
      return page.host.endsWith(`.${base}`);
    }
    return page.host === p;
  });
  if (!hit) return { ok: false, why: `${page.host} is not one of the credential's sites` };

  if (page.protocol === "http:" && !(onUrlHost && url?.protocol === "http:"))
    return { ok: false, why: "the page is not secure (http) and the credential is for https" };
  const wantPort = onUrlHost && url ? portOf(url) : defaultPort(page.protocol);
  // A credential for http://router:8080 also fits the same router on https at its default port.
  const portOk =
    page.port === wantPort ||
    (onUrlHost &&
      url &&
      page.protocol !== url.protocol &&
      page.port === defaultPort(page.protocol) &&
      !url.port);
  if (!portOk) return { ok: false, why: `port ${page.port} is not the credential's (${wantPort})` };

  const site = hit.startsWith("*.") ? hit.slice(2) : hit;
  if (registrableDomain(site) !== page.registrable)
    return { ok: false, why: "the page and the credential are on different domains" };
  return { ok: true, via: hit };
}

/**
 * The sites a new credential saved from a page gets: that page's host only (the person may add
 * more of the same domain). An entry's hosts are kept only when they are the page's own domain.
 */
export function sitesForSave(pageUrl: string, wanted: string[] = []): string[] | null {
  const page = pageSite(pageUrl);
  if (!page) return null;
  const out = new Set<string>([page.host]);
  for (const raw of wanted) {
    const wild = raw.trim().startsWith("*.");
    const h = normalizeHost(wild ? raw.trim().slice(2) : raw);
    if (!h) continue;
    if (wild && (isAddress(h) || isPublicSuffix(h))) continue;
    if (registrableDomain(h) !== page.registrable) continue;
    out.add(wild ? `*.${h}` : h);
  }
  return [...out].slice(0, 20);
}
