// HTTPS in the local network (RedGiant OS, G39.1). Caddy on the machine answers on 443 with a
// certificate of the machine's own CA and on 80, both leading here with X-RedGiant-Local-TLS;
// RedGiant itself stays on 7600. http keeps working until the person says the certificate is
// trusted on their devices (the page checks it first: no lock-out); from then on a plain http
// request for the machine's local name or private address is sent to https, and HSTS goes with
// every https answer. Names reached another way (Tailscale, a domain of one's own) are never
// redirected: they have their own HTTPS. The rule is one pure function, tested as a table.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Paths that answer over http whatever the setting: health checks and the CA's certificate. */
const ALWAYS_HTTP = new Set(["/api/health", "/redgiant-ca.crt"]);

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)\d+\.\d+(\.\d+)?$/;
const PRIVATE_V6 = /^\[(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*\]$/i;

/** The host without its port ("redgiant.local:7600" → "redgiant.local", "[fd00::1]:80" → "[fd00::1]"). */
export function bareHost(host: string | undefined): string {
  const h = (host ?? "").trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

/** A name or address of the local network the machine's certificate is for. */
export function isLanHost(host: string): boolean {
  if (!host || LOOPBACK.test(host)) return false;
  return host.endsWith(".local") || PRIVATE_V4.test(host) || PRIVATE_V6.test(host);
}

export interface LanRequest {
  /** The person turned the redirect on. */
  redirect: boolean;
  path: string;
  /** Host header. */
  host: string | undefined;
  /** X-Forwarded-Proto, when the local proxy (or another) sent one. */
  forwardedProto: string | undefined;
  /** Search part of the URL, with its "?" (kept by the redirect). */
  search?: string;
}

/** Where a plain http request goes instead, or null when it is answered as it is. */
export function lanRedirect(r: LanRequest): string | null {
  if (!r.redirect || ALWAYS_HTTP.has(r.path)) return null;
  if ((r.forwardedProto ?? "").toLowerCase() === "https") return null;
  const host = bareHost(r.host);
  if (!isLanHost(host)) return null;
  return `https://${host}${r.path}${r.search ?? ""}`;
}

/**
 * HSTS on an https answer of the local network, only once the redirect is on. Thirty days, not
 * a year: a browser that saw it keeps asking https for the local name until then, also if the
 * person switches local HTTPS off later (the addresses are never concerned: HSTS ignores them).
 */
export function lanHsts(r: Omit<LanRequest, "path" | "search">): string | null {
  if (!r.redirect || (r.forwardedProto ?? "").toLowerCase() !== "https") return null;
  return isLanHost(bareHost(r.host)) ? "max-age=2592000" : null;
}

export interface LanHttpsSettings {
  redirect: boolean;
  /** When the person said the certificate is trusted (and the page checked it). */
  trustedAt?: string;
}

/** The person's choice, in the data folder; read once, kept in memory for every request. */
export class LanHttpsStore {
  private value: LanHttpsSettings = { redirect: false };
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "lan-https.json");
  }

  get settings(): LanHttpsSettings {
    return this.value;
  }

  async load(): Promise<LanHttpsSettings> {
    try {
      const j = JSON.parse(await readFile(this.file, "utf8")) as Partial<LanHttpsSettings>;
      this.value = {
        redirect: j.redirect === true,
        ...(typeof j.trustedAt === "string" && { trustedAt: j.trustedAt }),
      };
    } catch {
      this.value = { redirect: false };
    }
    return this.value;
  }

  async save(next: LanHttpsSettings): Promise<LanHttpsSettings> {
    const tmp = `${this.file}.new`;
    await writeFile(tmp, `${JSON.stringify(next)}\n`);
    await rename(tmp, this.file);
    this.value = next;
    return next;
  }
}
