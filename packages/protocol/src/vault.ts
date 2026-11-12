// The keychain (G33.4, the person: «Creiamo una repo sicura per le credenziali… un po' come un
// password manager/portachiavi… Gli agenti devono poter pescare le credenziali anche da lì senza
// leggerle o scriverle in chat e ovviamente questa non deve essere MAI committata su git»).
// What the page and the server share. A value never travels in these shapes: the page sends it
// once when saving, and gets it back only through the explicit «Show» request.
import { z } from "zod";

/** A credential's name, what agents and tools write in `{{vault:<name>}}`. */
export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,47}$/;

/** When the person is asked before a use: every time, once per conversation, or never. */
export const VaultAsk = z.enum(["always", "session", "never"]);
export type VaultAsk = z.infer<typeof VaultAsk>;

export const VaultCategory = z.enum(["api", "login", "bank", "email", "server", "other"]);
export type VaultCategory = z.infer<typeof VaultCategory>;

/** How the value goes on a request when the agent does not write `{{vault:<name>}}` itself. */
export const VaultInject = z.object({
  /** A header, e.g. `Authorization`; empty: only where the placeholder is written. */
  header: z.string().max(80).default("Authorization"),
  /** The header's value, `{value}` standing for the secret (`Bearer {value}`). */
  format: z.string().max(200).default("Bearer {value}"),
});
export type VaultInject = z.infer<typeof VaultInject>;

/** Who may use a credential. Empty lists with `all` false: nobody but the person. */
export const VaultAllow = z.object({
  /** Every agent may ask for it (each use still follows `ask`). */
  allAgents: z.boolean().default(true),
  agents: z.array(z.string()).default([]),
  /** Tools the person approved (extensions) that receive it on their requests through the proxy. */
  tools: z.array(z.string()).default([]),
  /** Automations whose runs may use it (an automation's run is not a person asking). */
  automations: z.array(z.string()).default([]),
});
export type VaultAllow = z.infer<typeof VaultAllow>;

/** What the person writes for a credential (the value only when it is new or changed). */
export const VaultInput = z.object({
  name: z.string().regex(VAULT_NAME_RE),
  service: z.string().min(1).max(80),
  /** An icon of `brands.tsx`, when the service has one. */
  brand: z.string().max(40).optional(),
  category: VaultCategory.default("api"),
  tags: z.array(z.string().max(30)).max(12).default([]),
  username: z.string().max(200).default(""),
  /** Absent when editing: the value stays as it was. */
  value: z.string().min(1).max(20_000).optional(),
  url: z.string().max(500).default(""),
  /** Where the value may go: host names, `*.example.com` for the subdomains. */
  hosts: z.array(z.string().min(1).max(200)).max(20).default([]),
  notes: z.string().max(4000).default(""),
  /** When it stops working (an ISO date), for the warning. */
  expires: z.string().max(40).nullable().default(null),
  ask: VaultAsk.default("session"),
  allow: VaultAllow.default({ allAgents: true, agents: [], tools: [], automations: [] }),
  inject: VaultInject.default({ header: "Authorization", format: "Bearer {value}" }),
});
export type VaultInput = z.input<typeof VaultInput>;

/** A credential as the page sees it: everything but its value. */
export interface VaultEntry {
  id: string;
  name: string;
  service: string;
  brand?: string | undefined;
  category: VaultCategory;
  tags: string[];
  username: string;
  url: string;
  hosts: string[];
  notes: string;
  expires: string | null;
  ask: VaultAsk;
  allow: VaultAllow;
  inject: VaultInject;
  /** How long the value is, so the page can draw its dots. */
  length: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  uses: number;
  /**
   * A key a part of RedGiant uses (G36.20: a provider's key, a chat's token, a mailbox's password,
   * an MCP service's sign-in): editable here like any other, set and removed from its page.
   */
  usedBy?: VaultUsedBy | undefined;
}

/** The part of RedGiant that uses a key kept in the keychain, and the page that sets it. */
export interface VaultUsedBy {
  /** Which key of that part (`setup:keys.anthropic`, `email:<box>`, `mcp:<server>`). */
  key: string;
  /** The Settings section where it is set and removed. */
  section: string;
  kind: VaultSystemEntry["kind"];
  /** What it is for, in English (the page has its own words for the known ones). */
  what: string;
}

/**
 * A key RedGiant keeps elsewhere (a provider's key, a chat's token, a mailbox's password, an MCP
 * service's sign-in): listed in the keychain so there is one place to see them, managed where it
 * was set. Never its value.
 */
export interface VaultSystemEntry {
  id: string;
  service: string;
  brand?: string | undefined;
  category: VaultCategory;
  /** Where it is managed: a Settings section. */
  section: string;
  /** What it is for, in English (the page has its own words for the known ones). */
  what: string;
  kind: "provider" | "chat" | "email" | "mcp" | "git" | "search" | "ssh" | "other";
  /** Set by whoever installed the server (an environment variable): it cannot change here. */
  locked?: boolean | undefined;
}

/** One use of a credential: who, when, where to, and how it went. */
export interface VaultUse {
  id: string;
  entryId: string;
  name: string;
  at: string;
  agentId: string | null;
  agentName: string | null;
  sessionId: string | null;
  /** `use_credential`, or the extension's tool that received it. */
  tool: string;
  host: string;
  method: string;
  /** `moved`: brought into the keychain from an older file (`host` names it, G36.20). */
  outcome: "used" | "denied" | "refused" | "moved";
  /** Why it was denied or refused. */
  reason?: string | undefined;
}

/** How the keychain's master key is protected on this computer. */
export type VaultProtection = "dpapi" | "keychain" | "file" | "env";

export interface VaultView {
  /** False when the keychain cannot open (its folder inside a git repository, a broken key). */
  ready: boolean;
  reason?: string | undefined;
  protection: VaultProtection | null;
  entries: VaultEntry[];
  system: VaultSystemEntry[];
  uses: VaultUse[];
  /** True when sandbox programs can receive credentials through the egress proxy. */
  proxy: boolean;
}

/** One row of a password manager's export, before it is saved. */
export interface VaultImportRow {
  service: string;
  username: string;
  url: string;
  notes: string;
  /** Only how long it is: the value stays on the server until the person saves. */
  length: number;
  name: string;
  /** Already in the keychain under this name. */
  exists: boolean;
}

export interface VaultImportPreview {
  format: "bitwarden" | "1password" | "chrome" | "firefox" | "generic";
  rows: VaultImportRow[];
  /** Rows without a value, skipped. */
  skipped: number;
  /** The upload's id, for the confirmation. */
  id: string;
}

// ---------------------------------------------------------------------------------------------
// The browser extension (G36.21): the keychain in Chrome, Edge, Brave, Opera and Firefox, outside
// RedGiant. A browser is linked with a short code from Settings > Keychain and gets a token of its
// own that opens only the extension's routes; the person unlinks it from the same page.

/** A linked browser, as the keychain's page lists it (never its token). */
export interface VaultBrowser {
  id: string;
  /** What the person called it in the extension («Opera on the desk»). */
  name: string;
  /** The browser it said it is (chrome, edge, brave, opera, firefox, other). */
  browser: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** The code that links a browser: shown once, valid ten minutes, good for one browser. */
export interface VaultBrowserCode {
  code: string;
  expiresAt: string;
}

/** A credential the extension may offer on a page (its value comes only when filling). */
export interface BrowserExtEntry {
  id: string;
  service: string;
  brand?: string | undefined;
  category: VaultCategory;
  username: string;
  /** The site of the credential that matched the page (`example.com`, `*.example.com`). */
  site: string;
}

/** What the extension knows about a page: its site and the credentials that belong to it. */
export interface BrowserExtSite {
  /** The page's host, ASCII (punycode shows as such: a look-alike name is visible). */
  host: string;
  secure: boolean;
  entries: BrowserExtEntry[];
}

/** After a form with a password was sent: is it new, changed, or already in the keychain? */
export interface BrowserExtCheck {
  state: "new" | "changed" | "same" | "unsafe";
  /** The credential that would be updated («changed», «same»). */
  entryId?: string | undefined;
  service: string;
  /** The sites a new credential would get (the page's host). */
  hosts: string[];
  /** The page's registrable domain: the only one the sites may be on. */
  domain: string;
}
