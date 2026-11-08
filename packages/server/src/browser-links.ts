// The keychain in the person's own browser (G36.21, the person: «una piccola estensione per chrome
// per il portachiavi almeno lo possiamo usare anche su chrome al di fuori di redgiant»).
//
// A browser is linked with a short code the keychain's page shows (ten minutes, one browser). The
// code becomes a device token that opens only the extension's routes (`/api/browser-ext/*`), never
// the rest of the API; the server keeps only its hash. The person sees every linked browser in
// Settings > Keychain and unlinks it there.
//
// What a linked browser may do, always for the page it is on (`siteMatches`): list the credentials
// that belong to that site, read one value at the moment of filling or copying, check a password
// just sent in a form, and save or update it. Every read and every save is written in the
// keychain's record of uses, refusals included. A browser filling a form is the person's own use,
// not an agent's: nobody is asked, but a value never goes to a page that is not its site.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { SqlClient } from "@redgiant/events";
import type {
  BrowserExtCheck,
  BrowserExtEntry,
  BrowserExtSite,
  VaultBrowser,
  VaultBrowserCode,
  VaultEntry,
} from "@redgiant/protocol";
import { pageSite, siteMatches, sitesForSave } from "./site-match.js";
import type { Vault, VaultCaller } from "./vault.js";
import { nameFor } from "./vault-import.js";

export type BrowserLinkCode =
  | "bad_code"
  | "too_many"
  | "not_found"
  | "refused"
  | "vault_closed"
  | "bad_request";

export class BrowserLinkError extends Error {
  constructor(
    readonly code: BrowserLinkCode,
    message: string,
  ) {
    super(message);
  }

  get status(): 400 | 403 | 404 | 423 | 429 {
    return this.code === "too_many"
      ? 429
      : this.code === "refused"
        ? 403
        : this.code === "not_found"
          ? 404
          : this.code === "vault_closed"
            ? 423
            : 400;
  }
}

/** A linked browser as the server keeps it: the hash of its token, never the token. */
interface Device {
  id: string;
  ownerId: string;
  name: string;
  browser: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** The linked browser behind a request. */
export interface LinkedBrowser {
  id: string;
  ownerId: string;
  name: string;
}

const SETTINGS_KEY = "vault_browsers";
const CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_DEVICES = 20;
const TOOL = "browser_extension";
export const BROWSER_NAMES = ["chrome", "edge", "brave", "opera", "firefox", "other"] as const;

/** How often each kind of request may come (per browser, or per address for linking). */
const LIMITS = {
  pair: { max: 10, ms: 10 * 60_000 },
  pairAll: { max: 50, ms: 10 * 60_000 },
  site: { max: 120, ms: 60_000 },
  value: { max: 20, ms: 60_000 },
  check: { max: 30, ms: 60_000 },
  save: { max: 10, ms: 60_000 },
} as const;
export type BrowserLimit = keyof typeof LIMITS;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A page on http may hold a password only at home (a router, a NAS, this computer). */
function homeHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (isIP(h) === 6) return h === "::1" || /^f[cd]/i.test(h) || /^fe80:/i.test(h);
  return (
    !h.includes(".") ||
    h === "localhost" ||
    /\.(local|lan|home|internal|home\.arpa|localhost)$/.test(h)
  );
}

/** «github.com» from `www.github.com`, for a new credential's service. */
const serviceOf = (host: string) => host.replace(/^www\./, "");

export interface BrowserLinksOptions {
  db: SqlClient;
  vault: Vault;
  now?: () => number;
}

export class BrowserLinks {
  private readonly devices = new Map<string, Device>();
  private readonly byHash = new Map<string, Device>();
  private readonly codes = new Map<string, { ownerId: string; expiresAt: number }>();
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly o: BrowserLinksOptions) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get ready(): boolean {
    return this.o.vault.ready;
  }

  async load(): Promise<void> {
    const rows = await this.o.db.query<{ owner_id: string; value: unknown }>(
      "SELECT owner_id, value FROM rg_settings WHERE key = $1",
      [SETTINGS_KEY],
    );
    for (const r of rows) {
      const list = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as unknown;
      if (!Array.isArray(list)) continue;
      for (const d of list as Omit<Device, "ownerId">[]) {
        if (typeof d?.tokenHash !== "string" || typeof d.id !== "string") continue;
        const dev: Device = { ...d, ownerId: r.owner_id };
        this.devices.set(dev.id, dev);
        this.byHash.set(dev.tokenHash, dev);
      }
    }
  }

  private async persist(ownerId: string): Promise<void> {
    const list = [...this.devices.values()]
      .filter((d) => d.ownerId === ownerId)
      .map(({ ownerId: _o, ...d }) => d);
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, SETTINGS_KEY, JSON.stringify(list)],
    );
  }

  /** False when `key` asked more than its limit allows in the window (and counts this one). */
  allow(kind: BrowserLimit, key: string): boolean {
    const { max, ms } = LIMITS[kind];
    const now = this.now();
    const k = `${kind}\0${key}`;
    const recent = (this.hits.get(k) ?? []).filter((t) => now - t < ms);
    if (recent.length >= max) {
      this.hits.set(k, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(k, recent);
    return true;
  }

  private limit(kind: BrowserLimit, key: string) {
    if (!this.allow(kind, key))
      throw new BrowserLinkError("too_many", "Too many requests: wait a minute");
  }

  // -------------------------------------------------------------------------------------------
  // Linking

  /** A new code for the person's page; an older code of theirs stops working. */
  newCode(ownerId: string): VaultBrowserCode {
    for (const [c, v] of this.codes) if (v.ownerId === ownerId) this.codes.delete(c);
    const bytes = randomBytes(8);
    let code = "";
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const expiresAt = this.now() + CODE_TTL_MS;
    this.codes.set(code, { ownerId, expiresAt });
    return {
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** The code typed in the extension becomes the browser's token (shown once, kept hashed). */
  async pair(
    rawCode: string,
    name: string,
    browser: string,
    address: string,
  ): Promise<{ token: string; id: string; name: string }> {
    if (!this.allow("pairAll", "*") || !this.allow("pair", address))
      throw new BrowserLinkError("too_many", "Too many tries: wait ten minutes");
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const found = this.codes.get(code);
    if (!found || found.expiresAt < this.now()) {
      if (found) this.codes.delete(code);
      throw new BrowserLinkError(
        "bad_code",
        "This code is wrong or expired: make a new one in RedGiant",
      );
    }
    this.codes.delete(code);
    const mine = [...this.devices.values()].filter((d) => d.ownerId === found.ownerId);
    if (mine.length >= MAX_DEVICES)
      throw new BrowserLinkError("too_many", `At most ${MAX_DEVICES} browsers: unlink one first`);
    const token = `rgb_${randomBytes(32).toString("base64url")}`;
    const dev: Device = {
      id: `brw_${randomUUID().slice(0, 12)}`,
      ownerId: found.ownerId,
      name: name.trim().slice(0, 60) || "Browser",
      browser: (BROWSER_NAMES as readonly string[]).includes(browser) ? browser : "other",
      tokenHash: hash(token),
      createdAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
    };
    this.devices.set(dev.id, dev);
    this.byHash.set(dev.tokenHash, dev);
    await this.persist(dev.ownerId);
    return { token, id: dev.id, name: dev.name };
  }

  /** The browser a token belongs to, or null (only the extension's routes ask). */
  authenticate(token: string | undefined): LinkedBrowser | null {
    if (!token?.startsWith("rgb_")) return null;
    const dev = this.byHash.get(hash(token));
    if (!dev) return null;
    const now = this.now();
    const seen = dev.lastSeenAt ? Date.parse(dev.lastSeenAt) : 0;
    if (now - seen > 5 * 60_000) {
      dev.lastSeenAt = new Date(now).toISOString();
      void this.persist(dev.ownerId).catch(() => {});
    }
    return { id: dev.id, ownerId: dev.ownerId, name: dev.name };
  }

  list(ownerId: string): VaultBrowser[] {
    return [...this.devices.values()]
      .filter((d) => d.ownerId === ownerId)
      .map(({ id, name, browser, createdAt, lastSeenAt }) => ({
        id,
        name,
        browser,
        createdAt,
        lastSeenAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** «Unlink»: the token stops working at once. */
  async revoke(ownerId: string, id: string): Promise<void> {
    const dev = this.devices.get(id);
    if (!dev || dev.ownerId !== ownerId)
      throw new BrowserLinkError("not_found", "That browser is not linked");
    this.devices.delete(id);
    this.byHash.delete(dev.tokenHash);
    await this.persist(ownerId);
  }

  // -------------------------------------------------------------------------------------------
  // What a linked browser may do

  private caller(dev: LinkedBrowser): VaultCaller {
    return {
      ownerId: dev.ownerId,
      agentId: null,
      agentName: dev.name,
      sessionId: null,
      tool: TOOL,
    };
  }

  private open() {
    if (!this.o.vault.ready) throw new BrowserLinkError("vault_closed", "The keychain is closed");
  }

  /** The credentials that belong to the page (keys RedGiant uses itself are never offered). */
  private matching(ownerId: string, pageUrl: string): { e: VaultEntry; site: string }[] {
    const out: { e: VaultEntry; site: string }[] = [];
    for (const e of this.o.vault.entriesOf(ownerId)) {
      if (e.usedBy) continue;
      const v = siteMatches(e, pageUrl);
      if (v.ok) out.push({ e, site: v.via });
    }
    return out;
  }

  site(dev: LinkedBrowser, pageUrl: string, q = ""): BrowserExtSite {
    this.limit("site", dev.id);
    this.open();
    const page = pageSite(pageUrl);
    if (!page) return { host: "", secure: false, entries: [] };
    const words = q.trim().toLowerCase();
    const entries: BrowserExtEntry[] = this.matching(dev.ownerId, pageUrl)
      .filter(
        ({ e }) => !words || `${e.service} ${e.username} ${e.name}`.toLowerCase().includes(words),
      )
      // The exact host first, then the domain's wildcards; by service within each.
      .sort(
        (a, b) =>
          Number(a.site.startsWith("*.")) - Number(b.site.startsWith("*.")) ||
          a.e.service.localeCompare(b.e.service),
      )
      .map(({ e, site }) => ({
        id: e.id,
        service: e.service,
        ...(e.brand && { brand: e.brand }),
        category: e.category,
        username: e.username,
        site,
      }));
    return { host: page.host, secure: page.protocol === "https:", entries };
  }

  /**
   * The value of one credential, for the page the browser is on, at the moment of filling or
   * copying. Refused (and recorded) when the page is not the credential's site.
   */
  async value(
    dev: LinkedBrowser,
    id: string,
    pageUrl: string,
    purpose: "fill" | "copy",
  ): Promise<{ value: string; username: string }> {
    this.limit("value", dev.id);
    this.open();
    const e = this.o.vault.entriesOf(dev.ownerId).find((x) => x.id === id);
    if (!e) throw new BrowserLinkError("not_found", "That credential is no longer in the keychain");
    const host = pageSite(pageUrl)?.host ?? "";
    const method = purpose === "fill" ? "FILL" : "COPY";
    const why = e.usedBy
      ? "a key RedGiant uses itself is never given to a page"
      : (() => {
          const v = siteMatches(e, pageUrl);
          return v.ok ? null : v.why;
        })();
    if (why) {
      await this.o.vault.recordUse(this.caller(dev), e.id, host, method, "refused", why);
      throw new BrowserLinkError("refused", `Not for this page: ${why}`);
    }
    await this.o.vault.recordUse(this.caller(dev), e.id, host, method, "used");
    return { value: this.o.vault.reveal(dev.ownerId, e.id), username: e.username };
  }

  /** May this page hold a password at all (https, or http at home)? */
  private safe(pageUrl: string) {
    const page = pageSite(pageUrl);
    if (!page) throw new BrowserLinkError("bad_request", "Not a web page");
    return { page, ok: page.protocol === "https:" || homeHost(page.host) };
  }

  /** After a form with a password went: new, changed, or already there? */
  check(dev: LinkedBrowser, pageUrl: string, username: string, password: string): BrowserExtCheck {
    this.limit("check", dev.id);
    this.open();
    const { page, ok } = this.safe(pageUrl);
    const service = serviceOf(page.host);
    const hosts = sitesForSave(pageUrl) ?? [page.host];
    const domain = page.registrable ?? page.host;
    if (!ok) return { state: "unsafe", service, hosts, domain };
    const user = username.trim().toLowerCase();
    const found = this.matching(dev.ownerId, pageUrl).map((m) => m.e);
    const same = user
      ? found.filter((e) => e.username.trim().toLowerCase() === user)
      : found.length === 1
        ? found
        : [];
    const e = same[0];
    if (!e) return { state: "new", service, hosts, domain };
    const state = this.o.vault.reveal(dev.ownerId, e.id) === password ? "same" : "changed";
    return { state, entryId: e.id, service: e.service, hosts: e.hosts, domain };
  }

  /** «Save in the keychain» / «Update», after the person confirmed on the page. */
  async save(
    dev: LinkedBrowser,
    input: {
      url: string;
      username: string;
      password: string;
      service: string;
      hosts: string[];
      entryId?: string | undefined;
    },
  ): Promise<{ entryId: string; state: "saved" | "updated" }> {
    this.limit("save", dev.id);
    this.open();
    const { page, ok } = this.safe(input.url);
    if (!ok)
      throw new BrowserLinkError(
        "refused",
        "A password typed on a page that is not secure (http) is not saved",
      );
    const v = this.o.vault;
    if (input.entryId) {
      const e = v.entriesOf(dev.ownerId).find((x) => x.id === input.entryId);
      if (!e)
        throw new BrowserLinkError("not_found", "That credential is no longer in the keychain");
      const m = e.usedBy
        ? { ok: false as const, why: "a key RedGiant uses" }
        : siteMatches(e, input.url);
      if (!m.ok) {
        await v.recordUse(this.caller(dev), e.id, page.host, "UPDATE", "refused", m.why);
        throw new BrowserLinkError("refused", `Not for this page: ${m.why}`);
      }
      await v.put(
        dev.ownerId,
        {
          name: e.name,
          service: e.service,
          ...(e.brand && { brand: e.brand }),
          category: e.category,
          tags: e.tags,
          username: input.username.trim() || e.username,
          value: input.password,
          url: e.url,
          hosts: e.hosts,
          notes: e.notes,
          expires: e.expires,
          ask: e.ask,
          allow: e.allow,
          inject: e.inject,
        },
        e.id,
      );
      await v.recordUse(this.caller(dev), e.id, page.host, "UPDATE", "used");
      return { entryId: e.id, state: "updated" };
    }
    const hosts = sitesForSave(input.url, input.hosts) ?? [page.host];
    const taken = new Set(v.entriesOf(dev.ownerId).map((e) => e.name));
    const service = input.service.trim().slice(0, 80) || serviceOf(page.host);
    const saved = await v.put(dev.ownerId, {
      name: nameFor(service, taken),
      service,
      category: "login",
      username: input.username.trim().slice(0, 200),
      value: input.password,
      url: page.origin,
      hosts,
      // Saved from a browser: for the person; agents get it only if the person allows them later.
      ask: "always",
      allow: { allAgents: false, agents: [], tools: [], automations: [] },
      inject: { header: "", format: "{value}" },
    });
    await v.recordUse(this.caller(dev), saved.id, page.host, "SAVE", "used");
    return { entryId: saved.id, state: "saved" };
  }
}
