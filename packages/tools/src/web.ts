import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import type { Tool } from "@redgiant/agent";
import { z } from "zod";
import { describe, type ModelProfile } from "./profiles.js";
import { truncateMiddle } from "./text.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(
    query: string,
    options: { maxResults: number; signal?: AbortSignal | undefined },
  ): Promise<SearchResult[]>;
}

/** SearXNG (self-hosted, no key): `GET /search?format=json`. JSON output must be enabled. */
export class SearxngSearch implements WebSearchProvider {
  readonly name = "searxng";
  constructor(
    private readonly baseURL: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const url = `${this.baseURL.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(query)}`;
    const r = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      ...(signal && { signal }),
    });
    if (!r.ok) throw new Error(`SearXNG HTTP ${r.status}`);
    const body = (await r.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    return (body.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.content ?? "",
    }));
  }
}

/** Brave Search API (needs a key). */
export class BraveSearch implements WebSearchProvider {
  readonly name = "brave";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const r = await this.fetchImpl(url, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      ...(signal && { signal }),
    });
    if (r.status === 401 || r.status === 403) throw new Error("Brave Search: the key was refused");
    if (r.status === 429)
      throw new Error("Brave Search: too many searches (limit or credit reached)");
    if (!r.ok) throw new Error(`Brave Search HTTP ${r.status}`);
    const body = (await r.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] };
    };
    return (body.web?.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.description ?? "",
    }));
  }
}

/** A search service answering JSON over HTTP with a key (2026-11-03). */
async function postJson(
  fetchImpl: typeof fetch,
  name: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  });
  if (r.status === 401 || r.status === 403) throw new Error(`${name}: the key was refused`);
  if (r.status === 429) throw new Error(`${name}: too many searches (limit or credit reached)`);
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  return r.json();
}

/** Tavily: made for AI agents, clean extracts of each page. */
export class TavilySearch implements WebSearchProvider {
  readonly name = "tavily";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const body = (await postJson(
      this.fetchImpl,
      "Tavily",
      "https://api.tavily.com/search",
      { authorization: `Bearer ${this.apiKey}` },
      { query, max_results: maxResults, search_depth: "basic" },
      signal,
    )) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: x.content ?? "",
    }));
  }
}

/** Exa: search by meaning, strong on documentation and technical articles. */
export class ExaSearch implements WebSearchProvider {
  readonly name = "exa";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const body = (await postJson(
      this.fetchImpl,
      "Exa",
      "https://api.exa.ai/search",
      { "x-api-key": this.apiKey },
      {
        query,
        numResults: maxResults,
        type: "auto",
        contents: { highlights: { maxCharacters: 500 } },
      },
      signal,
    )) as {
      results?: { title?: string | null; url?: string; highlights?: string[]; text?: string }[];
    };
    return (body.results ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.url ?? "",
      snippet: (x.highlights ?? []).join(" … ") || (x.text ?? "").slice(0, 500),
    }));
  }
}

/** Serper: Google's results. */
export class SerperSearch implements WebSearchProvider {
  readonly name = "serper";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(
    query: string,
    { maxResults, signal }: { maxResults: number; signal?: AbortSignal | undefined },
  ) {
    const body = (await postJson(
      this.fetchImpl,
      "Serper",
      "https://google.serper.dev/search",
      { "x-api-key": this.apiKey },
      { q: query, num: maxResults },
      signal,
    )) as { organic?: { title?: string; link?: string; snippet?: string }[] };
    return (body.organic ?? []).slice(0, maxResults).map((x) => ({
      title: x.title ?? "",
      url: x.link ?? "",
      snippet: x.snippet ?? "",
    }));
  }
}

/** The services `searchProvider` makes (the same ids as the protocol's SEARCH_PROVIDER_IDS). */
export type SearchProviderId = "searxng" | "brave" | "tavily" | "exa" | "serper";

/** The search service chosen in the settings, ready to use; undefined without what it needs. */
export function searchProvider(
  c: { provider: SearchProviderId; url?: string | undefined; key?: string | undefined },
  fetchImpl: typeof fetch = globalThis.fetch,
): WebSearchProvider | undefined {
  if (c.provider === "searxng") return c.url ? new SearxngSearch(c.url, fetchImpl) : undefined;
  if (!c.key) return undefined;
  if (c.provider === "brave") return new BraveSearch(c.key, fetchImpl);
  if (c.provider === "tavily") return new TavilySearch(c.key, fetchImpl);
  if (c.provider === "exa") return new ExaSearch(c.key, fetchImpl);
  return new SerperSearch(c.key, fetchImpl);
}

const SearchInput = z.object({
  query: z.string().min(1),
  max_results: z.number().int().min(1).max(20).optional(),
});

/** Always present (RD29); without a provider it explains how to configure one. */
export function webSearchTool(
  provider: WebSearchProvider | undefined,
  profile: ModelProfile,
): Tool<z.infer<typeof SearchInput>> {
  return {
    def: {
      name: "web_search",
      description: describe(profile, {
        full: "Search the web. Returns title, URL and snippet for each result; use fetch to read a page.",
        compact: "Search the web.",
      }),
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, max_results: { type: "integer" } },
        required: ["query"],
      },
    },
    schema: SearchInput,
    async run({ query, max_results = 8 }, ctx) {
      if (!provider) {
        return {
          content:
            "Web search is not configured. Tell the user to choose a search provider in the RedGiant settings.",
          isError: true,
        };
      }
      const results = await provider.search(query, { maxResults: max_results, signal: ctx.signal });
      if (results.length === 0) return "No results.";
      return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    },
  };
}

const FetchInput = z.object({
  url: z.url(),
  max_chars: z.number().int().min(100).max(200_000).optional(),
});

/** The addresses a name resolves to (all of them): `dns.lookup` unless a test gives another. */
export type ResolveHost = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolve: ResolveHost = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Loopback, private, link-local, CGNAT, unique-local, multicast and unspecified addresses: the
 * server's own network, never reachable through `fetch` (it runs in the server's process). The
 * same ranges as the sandbox's egress proxy (`@redgiant/sandbox`, kept here so the base tools do
 * not depend on the sandbox), plus a few that are never a public web server.
 */
export function isNonPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 || // multicast and reserved, broadcast
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) // benchmarking
    );
  }
  if (isIP(ip) !== 6) return true; // not an address at all: never trusted
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4 inside IPv6 (mapped, compatible, NAT64, 6to4) carries the IPv4 address's rules.
  const embedded = v6.match(/^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded?.[1]) return isNonPublicAddress(embedded[1]);
  const hex = v6.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const n = (Number.parseInt(hex[1], 16) << 16) | Number.parseInt(hex[2], 16);
    return isNonPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  const first = Number.parseInt(v6.split(":")[0] || "0", 16);
  return (
    v6 === "::1" ||
    v6 === "::" ||
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x2002 || // 6to4: carries an IPv4 address of any kind
    (first === 0 && !v6.startsWith("::ffff:")) // ::/8 and the rest of the reserved zero block
  );
}

class BlockedAddressError extends Error {}

/** Every address `host` resolves to, refused when any of them is not public. */
async function publicAddresses(
  host: string,
  resolveHost: ResolveHost,
): Promise<{ address: string; family: number }[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  const all = kind ? [{ address: bare, family: kind }] : await resolveHost(bare);
  if (all.length === 0) throw new BlockedAddressError(`${host} does not resolve to any address`);
  const bad = all.find((a) => isNonPublicAddress(a.address));
  if (bad)
    throw new BlockedAddressError(
      `${host} is a local or private network address (${bad.address}): fetch reaches only the public web`,
    );
  return all;
}

/**
 * How `fetch` gets one response once the address was checked. The default connects with Node's
 * http/https to exactly the addresses checked (a name cannot resolve again to another one in
 * between); a test or a caller may give a `fetch`-like function instead.
 */
type Transport = (
  url: URL,
  o: { signal: AbortSignal; addresses: { address: string; family: number }[] },
) => Promise<Response>;

const NO_BODY = new Set([101, 103, 204, 205, 304]);

const nodeTransport: Transport = (url, { signal, addresses }) =>
  new Promise((ok, ko) => {
    const pinned = (_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
      const first = addresses[0] as { address: string; family: number };
      if (opts.all) cb(null, addresses);
      else cb(null, first.address, first.family);
    };
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        signal,
        lookup: pinned as never,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; RedGiant)",
          accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, x);
        const status = res.statusCode ?? 502;
        if (NO_BODY.has(status) || status < 200) {
          res.resume();
          ok(new Response(null, { status: NO_BODY.has(status) ? status : 204, headers }));
          return;
        }
        const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
        const body: Readable =
          enc === "gzip" || enc === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        if (body !== res) {
          res.on("error", (e) => body.destroy(e));
          headers.delete("content-encoding");
          headers.delete("content-length");
        }
        ok(
          new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, {
            status,
            headers,
          }),
        );
      },
    );
    req.on("error", ko);
    req.end();
  });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The body as text, at most `max` bytes read (the rest is never downloaded). */
async function readCapped(r: Response, max: number): Promise<{ text: string; cut: boolean }> {
  if (!r.body) return { text: "", cut: false };
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      cut = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), cut };
}

export interface FetchToolOptions {
  /** Name resolution (tests give a fake one): every address is checked before connecting. */
  lookup?: ResolveHost;
  /** Bytes of a body read at most (5 MB); the rest is dropped and the text says so. */
  maxBytes?: number;
  /** The whole fetch, redirects and body included (30 s). */
  timeoutMs?: number;
}

/**
 * Reads a web page from the server's process: so only public addresses (never the server's own
 * network: loopback, private, link-local, CGNAT, unique-local), checked on every redirect.
 */
export function fetchTool(
  profile: ModelProfile,
  fetchImpl?: typeof fetch,
  o: FetchToolOptions = {},
): Tool<z.infer<typeof FetchInput>> {
  const resolveHost = o.lookup ?? systemResolve;
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const transport: Transport = fetchImpl
    ? (url, { signal }) => fetchImpl(url.href, { redirect: "manual", signal })
    : nodeTransport;
  return {
    def: {
      name: "fetch",
      description: describe(profile, {
        full: "Fetch a public URL (http or https) and return its content; HTML is converted to plain text. Local and private network addresses are refused.",
        compact: "Read a web page.",
      }),
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, max_chars: { type: "integer" } },
        required: ["url"],
      },
    },
    schema: FetchInput,
    async run({ url, max_chars = 20_000 }, ctx) {
      const timeout = AbortSignal.timeout(o.timeoutMs ?? 30_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      let current: URL;
      try {
        current = new URL(url);
      } catch {
        return { content: `Not a valid URL: ${url}`, isError: true };
      }
      try {
        for (let hops = 0; ; hops++) {
          if (current.protocol !== "http:" && current.protocol !== "https:")
            return { content: "Only http and https URLs are supported.", isError: true };
          if (current.username || current.password)
            return { content: "URLs with a user name or password are refused.", isError: true };
          const addresses = await publicAddresses(current.hostname, resolveHost);
          const r = await transport(current, { signal, addresses });
          const location = r.headers.get("location");
          if (REDIRECTS.has(r.status) && location) {
            await r.body?.cancel().catch(() => {});
            if (hops >= 5)
              return {
                content: `Too many redirects (more than 5), last at ${current.href}`,
                isError: true,
              };
            current = new URL(location, current);
            continue;
          }
          const type = r.headers.get("content-type") ?? "";
          const { text: raw, cut } = await readCapped(r, maxBytes);
          const text =
            type.includes("html") || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
          const note = cut ? `\n[only the first ${maxBytes} bytes were read]` : "";
          return {
            content: `URL: ${current.href === new URL(url).href ? url : current.href}\nStatus: ${r.status}\n\n${truncateMiddle(text, max_chars)}${note}`,
            isError: !r.ok,
          };
        }
      } catch (err) {
        if (err instanceof BlockedAddressError) return { content: err.message, isError: true };
        if (timeout.aborted && !ctx.signal?.aborted)
          return { content: `Timed out fetching ${current.href}`, isError: true };
        throw err;
      }
    },
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|section|article|header|footer|pre|blockquote)>|<br\s*\/?>/gi,
      "\n",
    )
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}
