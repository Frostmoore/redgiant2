// Reading a web page for the knowledge (G36.3): only public http(s) addresses, every redirect
// checked again, no cookies and no logins, a limit on the bytes. What comes back is the page's
// text (HTML or plain) or a PDF's bytes, for the readers in extract.ts.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isNonPublicAddress } from "@redgiant/tools";

export type FetchPageErrorCode =
  | "bad_url"
  | "non_public_address"
  | "too_many_redirects"
  | "too_big"
  | "http_error"
  | "unsupported_type";

export class FetchPageError extends Error {
  constructor(
    readonly code: FetchPageErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchPageError";
  }
}

export interface FetchPageOptions {
  fetch?: typeof fetch;
  /** Every address a host name stands for (default: the system's resolver). */
  lookup?: (host: string) => Promise<string[]>;
  /** Largest answer read, bytes (default 10 MB). */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Whole read, redirects included (default 20 s). */
  timeoutMs?: number;
}

export interface FetchedPage {
  /** `html` for web pages, `text` for plain text, `pdf` for a PDF. */
  kind: "html" | "text" | "pdf";
  /** The decoded text (HTML or plain); empty for a PDF. */
  html: string;
  /** The raw bytes (what a PDF reader wants). */
  bytes: Uint8Array;
  /** The address after redirects. */
  finalUrl: string;
  contentType: string;
}

const MAX_REDIRECTS = 5;

async function systemLookup(host: string): Promise<string[]> {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

async function checkHost(url: URL, lookup: (host: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost"))
    throw new FetchPageError("non_public_address", `${url.hostname} is not a public address`);
  const addresses = isIP(host) ? [host] : await lookup(host).catch(() => []);
  if (!addresses.length) throw new FetchPageError("bad_url", `${url.hostname} was not found`);
  for (const a of addresses) {
    if (isNonPublicAddress(a))
      throw new FetchPageError(
        "non_public_address",
        `${url.hostname} leads to ${a}, which is not a public address`,
      );
  }
}

function parseUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new FetchPageError("bad_url", `Not a valid address: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchPageError("bad_url", "Only http and https addresses");
  if (url.username || url.password)
    throw new FetchPageError("bad_url", "Addresses with a user name or password are not read");
  return url;
}

/** The charset a page declares, in its header or in its first bytes. */
function charsetOf(contentType: string, head: Uint8Array): string {
  const fromHeader = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const start = new TextDecoder("latin1").decode(head.subarray(0, 2048));
  return (
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(start)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(start)?.[1] ??
    "utf-8"
  );
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readCapped(r: Response, max: number): Promise<Uint8Array> {
  const declared = Number(r.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await r.body?.cancel().catch(() => {});
    throw new FetchPageError("too_big", `The page is larger than ${max} bytes`);
  }
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new FetchPageError("too_big", `The page is larger than ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A public web page, read as a person's browser would without any of their logins. */
export async function fetchPage(url: string, o: FetchPageOptions = {}): Promise<FetchedPage> {
  const doFetch = o.fetch ?? fetch;
  const lookup = o.lookup ?? systemLookup;
  const max = o.maxBytes ?? 10 * 1024 * 1024;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let current = parseUrl(url);
  for (let hop = 0; ; hop++) {
    await checkHost(current, lookup);
    const r = await doFetch(current.href, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: {
        "user-agent": "RedGiant/3 (knowledge; +https://github.com/Frostmoore/redgiant2)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.5",
      },
      signal,
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS)
        throw new FetchPageError("too_many_redirects", "The page redirects too many times");
      current = parseUrl(r.headers.get("location") as string, current.href);
      continue;
    }
    if (r.status >= 400) {
      await r.body?.cancel().catch(() => {});
      throw new FetchPageError("http_error", `The page answered ${r.status}`, r.status);
    }
    const contentType = (r.headers.get("content-type") ?? "").toLowerCase();
    const mime = contentType.split(";")[0]?.trim() ?? "";
    const isPdf = mime === "application/pdf" || (!mime && current.pathname.endsWith(".pdf"));
    const isHtml =
      mime === "text/html" ||
      mime === "application/xhtml+xml" ||
      (mime.endsWith("+xml") && mime.includes("html"));
    const isText =
      mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
    if (!isPdf && !isHtml && !isText && mime) {
      await r.body?.cancel().catch(() => {});
      throw new FetchPageError("unsupported_type", `Pages of type ${mime} are not read`);
    }
    const bytes = await readCapped(r, max);
    if (isPdf || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46))
      return { kind: "pdf", html: "", bytes, finalUrl: current.href, contentType };
    const text = decode(bytes, charsetOf(contentType, bytes));
    const html = isHtml || (!mime && /<html|<body|<!doctype html/i.test(text.slice(0, 2048)));
    return { kind: html ? "html" : "text", html: text, bytes, finalUrl: current.href, contentType };
  }
}
