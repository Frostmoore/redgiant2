// The keychain (G33.4, the person: «Creiamo una repo sicura per le credenziali… un po' come un
// password manager/portachiavi… Gli agenti devono poter pescare le credenziali anche da lì senza
// leggerle o scriverle in chat e ovviamente questa non deve essere MAI committata su git»).
//
//   - At rest: one file, AES-256-GCM, under RedGiant's data folder (never inside a project, a
//     worktree or any git repository: the keychain refuses to open there). The master key is
//     protected by the system where it can be (DPAPI on Windows, the Keychain on a Mac), or kept in
//     a 0600 file beside it (Linux and Docker, whose data volume no sandbox mounts whole).
//   - Agents never see a value. They name a credential (`use_credential`, or `{{vault:<name>}}` in
//     a request's headers, address or body) and the value is put on the request on its way out,
//     only towards the hosts the person allowed; an answer that repeats it comes back hidden.
//     Extensions' tools the person bound to a credential reach it through the egress proxy.
//   - Every use is recorded (who, when, where to); the person decides who may use each credential
//     and whether to be asked every time, once per conversation, or never.
//   - Values are added to the event log's Redactor: never in the log in clear.
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "@redgiant/agent";
import type { Redactor } from "@redgiant/events";
import {
  hideSecrets,
  type VaultEntry,
  type VaultImportPreview,
  VaultInput,
  type VaultProtection,
  type VaultSystemEntry,
  type VaultUse,
  type VaultView,
} from "@redgiant/protocol";
import { hostAllowed } from "@redgiant/sandbox";
import { z } from "zod";
import { hostOf, nameFor, readExport } from "./vault-import.js";

const run = promisify(execFile);

export class VaultError extends Error {
  constructor(
    readonly code:
      | "vault_closed"
      | "vault_in_git"
      | "vault_not_found"
      | "vault_name_taken"
      | "vault_no_value"
      | "vault_bad_passphrase"
      | "vault_bad_file"
      | "vault_host"
      | "vault_inject",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Where the keychain may live

/** The git repository a folder is inside (its root), if any: `.git` in it or a parent. */
export async function gitRootOf(dir: string): Promise<string | null> {
  let d = resolve(dir);
  const { root } = parse(d);
  for (;;) {
    if (await stat(join(d, ".git")).catch(() => null)) return d;
    if (d === root) return null;
    d = dirname(d);
  }
}

// ---------------------------------------------------------------------------------------------
// The master key

/** Where the master key is kept, and how it is protected. */
export interface MasterKeyStore {
  kind: VaultProtection;
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
}

/** A 0600 file beside the keychain (Linux, Docker; the fallback everywhere). */
export function fileKeyStore(path: string): MasterKeyStore {
  return {
    kind: "file",
    async load() {
      const t = await readFile(path, "utf8").catch(() => null);
      return t ? Buffer.from(t.trim(), "base64") : null;
    },
    async save(key) {
      await writeFile(path, `${key.toString("base64")}\n`, { mode: 0o600 });
      await chmod(path, 0o600).catch(() => {});
    },
  };
}

/** Windows: the key sealed by DPAPI for this Windows user, in a file beside the keychain. */
export function dpapiKeyStore(path: string): MasterKeyStore {
  const ps = async (script: string, input: string) => {
    const child = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, RG_VAULT_FILE: path },
      windowsHide: true,
    });
    child.child.stdin?.end(input);
    return (await child).stdout.trim();
  };
  const prelude =
    "Add-Type -AssemblyName System.Security; $s=[Security.Cryptography.DataProtectionScope]::CurrentUser;";
  return {
    kind: "dpapi",
    async load() {
      if (!(await stat(path).catch(() => null))) return null;
      const out = await ps(
        `${prelude} $b=[IO.File]::ReadAllBytes($env:RG_VAULT_FILE); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,$s))`,
        "",
      );
      return Buffer.from(out, "base64");
    },
    async save(key) {
      await ps(
        `${prelude} $k=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [IO.File]::WriteAllBytes($env:RG_VAULT_FILE,[Security.Cryptography.ProtectedData]::Protect($k,$null,$s))`,
        key.toString("base64"),
      );
    },
  };
}

/** macOS: the key in the login Keychain (service `redgiant-vault`, one account per data folder). */
export function keychainKeyStore(account: string): MasterKeyStore {
  return {
    kind: "keychain",
    async load() {
      const r = await run("security", [
        "find-generic-password",
        "-s",
        "redgiant-vault",
        "-a",
        account,
        "-w",
      ]).catch(() => null);
      return r?.stdout.trim() ? Buffer.from(r.stdout.trim(), "base64") : null;
    },
    async save(key) {
      await run("security", [
        "add-generic-password",
        "-U",
        "-s",
        "redgiant-vault",
        "-a",
        account,
        "-w",
        key.toString("base64"),
      ]);
    },
  };
}

/** The key from the environment (`REDGIANT_VAULT_KEY`, base64 of 32 bytes): servers' choice. */
export function envKeyStore(b64: string): MasterKeyStore {
  return {
    kind: "env",
    load: async () => Buffer.from(b64, "base64"),
    save: async () => {
      throw new Error("REDGIANT_VAULT_KEY is set: the key cannot change");
    },
  };
}

/**
 * The system's protection where there is one, a file otherwise. A system store that fails
 * (no PowerShell, a locked Keychain) falls back to the file, and the page says which it is.
 */
export function systemKeyStores(dir: string, env = process.env): MasterKeyStore[] {
  if (env.REDGIANT_VAULT_KEY) return [envKeyStore(env.REDGIANT_VAULT_KEY)];
  const file = fileKeyStore(join(dir, "master.key"));
  if (process.platform === "win32") return [dpapiKeyStore(join(dir, "master.dpapi")), file];
  if (process.platform === "darwin")
    return [keychainKeyStore(Buffer.from(resolve(dir)).toString("base64url").slice(-60)), file];
  return [file];
}

// ---------------------------------------------------------------------------------------------
// Sealing

interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  /** Exports only: the passphrase's salt. */
  salt?: string;
}

export function seal(key: Buffer, plain: Buffer, salt?: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    ...(salt && { salt: salt.toString("base64") }),
  };
}

export function unseal(key: Buffer, s: Sealed): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]);
}

/** A key from the person's passphrase, for exports and backups (scrypt). */
const passKey = (pass: string, salt: Buffer) =>
  scryptSync(pass.normalize("NFKC"), salt, 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });

/** The first line of an exported keychain, so a wrong file is told apart from a wrong passphrase. */
export const EXPORT_MAGIC = "REDGIANT-KEYCHAIN 1";

// ---------------------------------------------------------------------------------------------
// The keychain

interface Stored extends Omit<VaultEntry, "length" | "uses" | "lastUsedAt"> {
  ownerId: string;
  value: string;
}

interface StoredUse extends VaultUse {
  ownerId: string;
}

interface Contents {
  entries: Stored[];
  uses: StoredUse[];
}

/** Who wants a credential, for its rules and its record. */
export interface VaultCaller {
  ownerId: string;
  agentId: string | null;
  agentName: string | null;
  sessionId: string | null;
  /** The automation whose run this is, if any. */
  automationId?: string | null | undefined;
  tool: string;
}

/** Where sandboxes' programs get credentials on their way out (the egress proxy). */
export interface VaultEgress {
  /** The proxy as sandboxes reach it (`http://egress:3128`). */
  url: string;
  publish(entries: VaultRoute[]): Promise<void>;
}

/** What the proxy knows of one credential: reached through `/vault/<cap>/<host>/<path>`. */
export interface VaultRoute {
  cap: string;
  name: string;
  value: string;
  hosts: string[];
  inject: { header: string; format: string };
}

export interface VaultOptions {
  dir: string;
  keyStores?: MasterKeyStore[];
  redactor?: Redactor | undefined;
  egress?: VaultEgress | undefined;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Asks the person before a use (the permission card); false on a no, a failure or a timeout. */
  ask?: (caller: VaultCaller, entry: VaultEntry, host: string, method: string) => Promise<boolean>;
  /** The keys RedGiant keeps elsewhere, shown in the keychain (never their values). */
  system?: (ownerId: string) => Promise<VaultSystemEntry[]>;
}

const USES_KEPT = 2000;
const IMPORT_TTL_MS = 15 * 60_000;
const PLACEHOLDER = /\{\{\s*vault:([a-z0-9][a-z0-9_-]{1,47})\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*vault:[a-z0-9][a-z0-9_-]{1,47}\s*\}\}/;

export class Vault {
  private key: Buffer | null = null;
  private protection: VaultProtection | null = null;
  private reason: string | undefined;
  private data: Contents = { entries: [], uses: [] };
  private writing: Promise<void> = Promise.resolve();
  /** Conversations where the person said yes once (`ask: "session"`). */
  private readonly granted = new Set<string>();
  /** The proxy's capability of each credential: new at every start, never stored. */
  private readonly caps = new Map<string, string>();
  private readonly imports = new Map<
    string,
    { ownerId: string; at: number; preview: VaultImportPreview; values: Map<number, string> }
  >();

  constructor(private readonly o: VaultOptions) {}

  private get file() {
    return join(this.o.dir, "keychain.enc");
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  get ready(): boolean {
    return this.key !== null;
  }

  /** Opens (or creates) the keychain. It stays closed, with the reason, when it may not open. */
  async open(): Promise<void> {
    try {
      const repo = await gitRootOf(this.o.dir);
      if (repo)
        throw new VaultError(
          "vault_in_git",
          `The keychain's folder ${this.o.dir} is inside the git repository ${repo}: it must never be committed. Set REDGIANT_VAULT_DIR (or REDGIANT_DATA_DIR) to a folder outside any repository.`,
        );
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
      // A second guard should the folder ever be copied into a repository.
      await writeFile(join(this.o.dir, ".gitignore"), "# RedGiant's keychain: never commit\n*\n", {
        mode: 0o600,
      });
      const stores = this.o.keyStores ?? systemKeyStores(this.o.dir);
      const exists = await stat(this.file).catch(() => null);
      let key: Buffer | null = null;
      for (const s of stores) {
        key = await s.load().catch(() => null);
        if (key) {
          this.protection = s.kind;
          break;
        }
      }
      if (!key && exists)
        throw new VaultError("vault_closed", "The keychain's master key is missing or unreadable");
      if (!key) {
        key = randomBytes(32);
        for (const s of stores) {
          const saved = await s
            .save(key)
            .then(async () => (await s.load())?.equals(key as Buffer) === true)
            .catch(() => false);
          if (saved) {
            this.protection = s.kind;
            break;
          }
        }
        if (!this.protection)
          throw new VaultError("vault_closed", "The master key could not be saved");
      }
      if (exists) {
        const sealed = JSON.parse(await readFile(this.file, "utf8")) as Sealed;
        this.data = JSON.parse(unseal(key, sealed).toString("utf8")) as Contents;
      }
      this.key = key;
      this.reason = undefined;
      for (const e of this.data.entries) this.remember(e);
      await this.publish();
    } catch (err) {
      this.key = null;
      this.reason = (err as Error).message;
      if (!(err instanceof VaultError)) this.reason = `The keychain could not open: ${this.reason}`;
    }
  }

  private need(): Buffer {
    if (!this.key) throw new VaultError("vault_closed", this.reason ?? "The keychain is closed");
    return this.key;
  }

  /** Written whole, then renamed; one write at a time. */
  private save(): Promise<void> {
    const key = this.need();
    const job = this.writing.then(async () => {
      const sealed = seal(key, Buffer.from(JSON.stringify(this.data)));
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(sealed), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.writing = job.catch(() => {});
    return job;
  }

  private remember(e: Stored) {
    this.o.redactor?.addSecret(`vault-${e.name}`, e.value);
    if (!this.caps.has(e.id)) this.caps.set(e.id, randomBytes(18).toString("base64url"));
  }

  /** What the proxy injects (only credentials bound to some tool, only towards their hosts). */
  private async publish(): Promise<void> {
    if (!this.o.egress) return;
    await this.o.egress.publish(
      this.data.entries
        .filter((e) => e.allow.tools.length > 0 && e.hosts.length > 0)
        .map((e) => ({
          cap: this.caps.get(e.id) as string,
          name: e.name,
          value: e.value,
          hosts: e.hosts,
          inject: e.inject,
        })),
    );
  }

  private show(e: Stored): VaultEntry {
    const { ownerId: _o, value, ...rest } = e;
    const mine = this.data.uses.filter((u) => u.entryId === e.id && u.outcome === "used");
    return {
      ...rest,
      length: value.length,
      uses: mine.length,
      lastUsedAt: mine.at(-1)?.at ?? null,
    };
  }

  private entry(ownerId: string, idOrName: string): Stored {
    const e = this.data.entries.find(
      (x) => x.ownerId === ownerId && (x.id === idOrName || x.name === idOrName),
    );
    if (!e) throw new VaultError("vault_not_found", `There is no credential "${idOrName}"`);
    return e;
  }

  async view(ownerId: string): Promise<VaultView> {
    const system = (await this.o.system?.(ownerId).catch(() => [])) ?? [];
    return {
      ready: this.ready,
      ...(this.reason && { reason: this.reason }),
      protection: this.protection,
      entries: this.ready
        ? this.data.entries
            .filter((e) => e.ownerId === ownerId)
            .map((e) => this.show(e))
            .sort((a, b) => a.service.localeCompare(b.service))
        : [],
      system,
      uses: this.data.uses
        .filter((u) => u.ownerId === ownerId)
        .slice(-200)
        .reverse()
        .map(({ ownerId: _o, ...u }) => u),
      proxy: this.o.egress !== undefined,
    };
  }

  /** The names and services of the credentials, for agents (never a value). */
  names(ownerId: string): { name: string; service: string; hosts: string[] }[] {
    if (!this.ready) return [];
    return this.data.entries
      .filter((e) => e.ownerId === ownerId)
      .map((e) => ({ name: e.name, service: e.service, hosts: e.hosts }));
  }

  has(ownerId: string, name: string): boolean {
    return this.ready && this.data.entries.some((e) => e.ownerId === ownerId && e.name === name);
  }

  /** A new credential, or a change of one (the value stays when none is given). */
  async put(ownerId: string, raw: unknown, id?: string): Promise<VaultEntry> {
    this.need();
    const input = VaultInput.parse(raw);
    const hosts = [...new Set(input.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
    const taken = this.data.entries.find(
      (e) => e.ownerId === ownerId && e.name === input.name && e.id !== id,
    );
    if (taken)
      throw new VaultError(
        "vault_name_taken",
        `A credential called "${input.name}" already exists`,
      );
    const at = this.now().toISOString();
    const old = id ? this.entry(ownerId, id) : undefined;
    const value = input.value ?? old?.value;
    if (!value) throw new VaultError("vault_no_value", "The credential needs its value");
    const e: Stored = {
      id: old?.id ?? `key_${randomUUID().slice(0, 12)}`,
      ownerId,
      name: input.name,
      service: input.service.trim(),
      ...(input.brand && { brand: input.brand }),
      category: input.category,
      tags: input.tags,
      username: input.username,
      value,
      url: input.url,
      hosts,
      notes: input.notes,
      expires: input.expires,
      ask: input.ask,
      allow: input.allow,
      inject: input.inject,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    this.data.entries = old
      ? this.data.entries.map((x) => (x.id === old.id ? e : x))
      : [...this.data.entries, e];
    // A changed name or value: the grants and the proxy's capability start again.
    if (old && (old.value !== e.value || old.name !== e.name)) {
      this.caps.delete(e.id);
      for (const g of [...this.granted]) if (g.endsWith(`:${e.id}`)) this.granted.delete(g);
    }
    this.remember(e);
    await this.save();
    await this.publish();
    return this.show(e);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const e = this.entry(ownerId, id);
    this.data.entries = this.data.entries.filter((x) => x.id !== e.id);
    this.caps.delete(e.id);
    await this.save();
    await this.publish();
  }

  /** The value, for the person's «Show» and «Copy» (never for an agent). */
  reveal(ownerId: string, id: string): string {
    this.need();
    return this.entry(ownerId, id).value;
  }

  /** When each credential's use by the server itself was last recorded (one record a while). */
  private readonly serviceUses = new Map<string, number>();

  /**
   * A request RedGiant itself makes with a credential the person chose for it in a page (G36.2:
   * the knowledge's embeddings and reranker). The person's choice is the permission, so nobody is
   * asked; the value still goes only to the credential's hosts, redirects are not followed, and the
   * use is recorded (once every ten minutes, not once per batch). `{{vault:<name>}}` in a header
   * marks where the value goes; without one the credential's own header is used. The whole
   * answer comes back (vectors are large); it never reaches a model.
   */
  async serviceFetch(
    ownerId: string,
    name: string,
    purpose: string,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    signal?: AbortSignal,
  ): Promise<Response> {
    this.need();
    const e = this.entry(ownerId, name);
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:")
      throw new VaultError("vault_host", "Only http and https addresses");
    const host = target.hostname.toLowerCase();
    if (!e.hosts.some((h) => h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)))))
      throw new VaultError(
        "vault_host",
        `Credential "${name}" is not for ${host}: add the host to it in the keychain`,
      );
    const headers: Record<string, string> = {};
    let placed = false;
    for (const [k, v] of Object.entries(init.headers)) {
      if (HAS_PLACEHOLDER.test(v)) placed = true;
      headers[k] = v.replace(PLACEHOLDER, (_m, n: string) =>
        n === e.name ? e.value : this.valueOf(ownerId, n),
      );
    }
    if (!placed) {
      if (!e.inject.header)
        throw new VaultError("vault_inject", `Credential "${name}" has no header of its own`);
      headers[e.inject.header] = e.inject.format.includes("{value}")
        ? e.inject.format.replace("{value}", e.value)
        : e.value;
    }
    const key = `${ownerId}\0${e.id}\0${purpose}`;
    if (Date.now() - (this.serviceUses.get(key) ?? 0) > 10 * 60_000) {
      this.serviceUses.set(key, Date.now());
      await this.record(
        { ownerId, agentId: null, agentName: null, sessionId: null, tool: purpose },
        e,
        host,
        init.method.toUpperCase(),
        "used",
      );
    }
    return (this.o.fetch ?? fetch)(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined && { body: init.body }),
      redirect: "manual",
      ...(signal && { signal }),
    });
  }

  private async record(
    caller: VaultCaller,
    e: Stored,
    host: string,
    method: string,
    outcome: VaultUse["outcome"],
    reason?: string,
  ) {
    this.data.uses.push({
      id: `use_${randomUUID().slice(0, 12)}`,
      ownerId: caller.ownerId,
      entryId: e.id,
      name: e.name,
      at: this.now().toISOString(),
      agentId: caller.agentId,
      agentName: caller.agentName,
      sessionId: caller.sessionId,
      tool: caller.tool,
      host,
      method,
      outcome,
      ...(reason && { reason }),
    });
    if (this.data.uses.length > USES_KEPT)
      this.data.uses.splice(0, this.data.uses.length - USES_KEPT);
    await this.save().catch(() => {});
  }

  /**
   * May this caller use this credential towards this host? Its rules first (who, where to), then
   * the person when the credential asks. Every answer is recorded. A failure is a no.
   */
  async authorize(
    caller: VaultCaller,
    name: string,
    host: string,
    method: string,
  ): Promise<true | string> {
    this.need();
    const e = this.data.entries.find((x) => x.ownerId === caller.ownerId && x.name === name);
    if (!e)
      return `There is no credential "${name}" in the keychain. Ask the person to add it in Settings > Keychain.`;
    const refuse = async (why: string) => {
      await this.record(caller, e, host, method, "refused", why);
      return `Credential "${name}" not used: ${why}.`;
    };
    if (e.hosts.length === 0)
      return refuse("it has no allowed hosts (the person sets them in the keychain)");
    if (!hostAllowed(host, e.hosts))
      return refuse(`${host} is not among its hosts (${e.hosts.join(", ")})`);
    if (caller.automationId) {
      if (!e.allow.automations.includes(caller.automationId))
        return refuse("this automation may not use it");
    } else if (caller.tool !== "use_credential" && !e.allow.tools.includes(caller.tool))
      return refuse(`the tool ${caller.tool} may not use it`);
    else if (
      caller.tool === "use_credential" &&
      !e.allow.allAgents &&
      !(caller.agentId && e.allow.agents.includes(caller.agentId))
    )
      return refuse("this agent may not use it");
    const grant = `${caller.sessionId ?? "-"}:${e.id}`;
    const askNow = e.ask === "always" || (e.ask === "session" && !this.granted.has(grant));
    if (askNow) {
      const yes = this.o.ask
        ? await this.o.ask(caller, this.show(e), host, method).catch(() => false)
        : false;
      if (!yes) {
        await this.record(caller, e, host, method, "denied", "the person said no");
        return `Credential "${name}" not used: the person said no.`;
      }
      if (e.ask === "session") this.granted.add(grant);
    }
    await this.record(caller, e, host, method, "used");
    return true;
  }

  /** The value for a request that was authorised (inside the server only). */
  private valueOf(ownerId: string, name: string): string {
    return this.entry(ownerId, name).value;
  }

  /** Every value of these credentials hidden in a text coming back to a model. */
  private hide(ownerId: string, names: string[], text: string): string {
    let out = text;
    for (const n of names) {
      const v = this.valueOf(ownerId, n);
      if (v.length >= 4) out = out.split(v).join(`[vault:${n}]`);
      const b64 = Buffer.from(v).toString("base64");
      if (b64.length >= 8) out = out.split(b64).join(`[vault:${n}]`);
    }
    return out;
  }

  /**
   * `use_credential`: an HTTP request made by the server with the credential put on it. The
   * value goes only towards the credential's hosts, redirects are not followed (they would carry
   * it elsewhere), and the answer comes back with the value hidden.
   */
  async request(
    caller: VaultCaller,
    i: {
      credential?: string | undefined;
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<{ content: string; isError?: boolean }> {
    if (!this.ready) return { content: this.reason ?? "The keychain is closed", isError: true };
    let url: URL;
    try {
      url = new URL(i.url);
    } catch {
      return { content: `Not a valid address: ${i.url}`, isError: true };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:")
      return { content: "Only http and https addresses", isError: true };
    const found = new Set<string>();
    const scan = (s: string) => {
      for (const m of s.matchAll(PLACEHOLDER)) if (m[1]) found.add(m[1]);
    };
    scan(i.url);
    for (const v of Object.values(i.headers)) scan(v);
    if (i.body) scan(i.body);
    if (i.credential) found.add(i.credential);
    if (found.size === 0)
      return {
        content: "Name a credential (credential) or write {{vault:<name>}} where its value goes",
        isError: true,
      };
    const method = i.method.toUpperCase();
    for (const name of found) {
      const ok = await this.authorize(caller, name, url.hostname, method);
      if (ok !== true) return { content: ok, isError: true };
    }
    const owner = caller.ownerId;
    const fill = (s: string) => s.replace(PLACEHOLDER, (_m, n: string) => this.valueOf(owner, n));
    const headers: Record<string, string> = {};
    let placed = false;
    for (const [k, v] of Object.entries(i.headers)) {
      if (HAS_PLACEHOLDER.test(v)) placed = true;
      headers[k] = fill(v);
    }
    if (HAS_PLACEHOLDER.test(i.url) || (i.body && HAS_PLACEHOLDER.test(i.body))) placed = true;
    if (i.credential && !placed) {
      const e = this.entry(owner, i.credential);
      if (!e.inject.header)
        return {
          content: `Write {{vault:${e.name}}} where its value goes: it has no header of its own`,
          isError: true,
        };
      headers[e.inject.header] = e.inject.format.includes("{value}")
        ? e.inject.format.replace("{value}", e.value)
        : e.value;
    }
    const names = [...found];
    try {
      const r = await (this.o.fetch ?? fetch)(fill(i.url), {
        method,
        headers,
        ...(i.body !== undefined &&
          method !== "GET" &&
          method !== "HEAD" && { body: fill(i.body) }),
        redirect: "manual",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      const text = await r.text();
      const where = r.headers.get("location");
      const out = [
        `HTTP ${r.status}${r.statusText ? ` ${r.statusText}` : ""}`,
        `content-type: ${r.headers.get("content-type") ?? ""}`,
        ...(where
          ? [`location: ${where} (not followed: the credential stays with its hosts)`]
          : []),
        "",
        text.length > 30_000
          ? `${text.slice(0, 30_000)}\n… (${text.length - 30_000} more characters)`
          : text,
      ].join("\n");
      return { content: this.hide(owner, names, out), ...(r.status >= 400 && { isError: true }) };
    } catch (err) {
      return {
        content: this.hide(owner, names, `The request failed: ${(err as Error).message}`),
        isError: true,
      };
    }
  }

  /**
   * The environment an extension's tool gets for one run: for each credential bound to it and
   * allowed now, `REDGIANT_VAULT_<NAME>` = the proxy's address for it. Never a value.
   */
  async toolEnv(caller: VaultCaller): Promise<Record<string, string>> {
    if (!this.ready || !this.o.egress) return {};
    const env: Record<string, string> = {};
    for (const e of this.data.entries) {
      if (e.ownerId !== caller.ownerId || !e.allow.tools.includes(caller.tool) || !e.hosts.length)
        continue;
      const ok = await this.authorize(caller, e.name, e.hosts[0] as string, "TOOL");
      const cap = this.caps.get(e.id);
      if (ok === true && cap)
        env[`REDGIANT_VAULT_${e.name.toUpperCase().replace(/-/g, "_")}`] =
          `${this.o.egress.url.replace(/\/$/, "")}/vault/${cap}`;
    }
    return env;
  }

  // -------------------------------------------------------------------------------------------
  // Import and export

  /** Reads a password manager's CSV; the values wait here until the person confirms. */
  previewImport(ownerId: string, csv: string): VaultImportPreview {
    this.need();
    const { format, rows, skipped } = readExport(csv);
    const taken = new Set(
      this.data.entries.filter((e) => e.ownerId === ownerId).map((e) => e.name),
    );
    const values = new Map<number, string>();
    const preview: VaultImportPreview = {
      format,
      skipped,
      id: `imp_${randomUUID().slice(0, 12)}`,
      rows: rows.map((r, n) => {
        values.set(n, r.value);
        const name = nameFor(r.service, taken);
        return {
          service: r.service,
          username: r.username,
          url: r.url,
          notes: r.notes,
          length: r.value.length,
          name,
          exists: false,
        };
      }),
    };
    for (const [id, v] of this.imports)
      if (Date.now() - v.at > IMPORT_TTL_MS) this.imports.delete(id);
    this.imports.set(preview.id, { ownerId, at: Date.now(), preview, values });
    return preview;
  }

  /** Saves the rows the person kept (by index); website logins are for the person only. */
  async confirmImport(ownerId: string, id: string, keep: number[]): Promise<number> {
    const imp = this.imports.get(id);
    if (!imp || imp.ownerId !== ownerId)
      throw new VaultError("vault_bad_file", "That import is over: choose the file again");
    this.imports.delete(id);
    let n = 0;
    const taken = new Set(
      this.data.entries.filter((e) => e.ownerId === ownerId).map((e) => e.name),
    );
    for (const i of keep) {
      const r = imp.preview.rows[i];
      const value = imp.values.get(i);
      if (!r || !value) continue;
      const name = taken.has(r.name) ? nameFor(r.service, taken) : r.name;
      taken.add(name);
      const h = hostOf(r.url);
      await this.put(ownerId, {
        name,
        service: r.service.slice(0, 80),
        category: "login",
        username: r.username.slice(0, 200),
        value,
        url: r.url.slice(0, 500),
        hosts: h ? [h] : [],
        notes: r.notes.slice(0, 4000),
        allow: { allAgents: false, agents: [], tools: [], automations: [] },
        ask: "always",
        inject: { header: "", format: "{value}" },
      });
      n++;
    }
    return n;
  }

  /** The person's credentials sealed with a passphrase of theirs (a file to keep or to move). */
  exportSealed(ownerId: string, passphrase: string): string {
    this.need();
    if (passphrase.length < 8)
      throw new VaultError("vault_bad_passphrase", "The passphrase needs at least 8 characters");
    const salt = randomBytes(16);
    const entries = this.data.entries
      .filter((e) => e.ownerId === ownerId)
      .map(({ ownerId: _o, ...e }) => e);
    const sealed = seal(passKey(passphrase, salt), Buffer.from(JSON.stringify({ entries })), salt);
    return `${EXPORT_MAGIC}\n${JSON.stringify(sealed)}\n`;
  }

  /** An exported keychain back in (names already there get a new one). */
  async importSealed(ownerId: string, file: string, passphrase: string): Promise<number> {
    this.need();
    const [magic, body] = file.trim().split("\n");
    if (magic !== EXPORT_MAGIC || !body)
      throw new VaultError("vault_bad_file", "This is not a RedGiant keychain file");
    let entries: Omit<Stored, "ownerId">[];
    try {
      const sealed = JSON.parse(body) as Sealed;
      const plain = unseal(passKey(passphrase, Buffer.from(sealed.salt ?? "", "base64")), sealed);
      entries = (JSON.parse(plain.toString("utf8")) as { entries: Omit<Stored, "ownerId">[] })
        .entries;
    } catch {
      throw new VaultError("vault_bad_passphrase", "Wrong passphrase, or a damaged file");
    }
    const taken = new Set(
      this.data.entries.filter((e) => e.ownerId === ownerId).map((e) => e.name),
    );
    let n = 0;
    for (const e of entries) {
      const same = this.data.entries.find(
        (x) => x.ownerId === ownerId && x.name === e.name && x.value === e.value,
      );
      if (same) continue;
      const name = taken.has(e.name) ? nameFor(e.service, taken) : e.name;
      taken.add(name);
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = e;
      await this.put(ownerId, { ...rest, name });
      n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------------------------------------
// The agents' tool

const UseInput = z.object({
  credential: z.string().optional(),
  method: z.string().default("GET"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
});

/**
 * `use_credential`: offered to every agent that acts (the tool list never depends on what the
 * keychain holds); without credentials it says where the person adds them.
 */
export function vaultTool(
  agent: { id: string; name: string; ownerId: string },
  vault: Vault,
  automationOf: (sessionId: string) => Promise<string | null>,
): Tool {
  return {
    def: {
      name: "use_credential",
      description:
        'HTTP request with a credential from the person\'s keychain, never seeing it: name it, or write {{vault:<name>}} where its value goes. Only to its allowed hosts. url "list": the names. Secrets never go in a chat: the person adds them in Settings > Keychain.',
      inputSchema: {
        type: "object",
        properties: {
          credential: { type: "string" },
          method: { type: "string" },
          url: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          body: { type: "string" },
        },
        required: ["url"],
      },
    },
    schema: UseInput,
    async run(i: z.output<typeof UseInput>, ctx) {
      if (i.url === "list") {
        if (!vault.ready)
          return { content: "The keychain is closed on this computer.", isError: true };
        const all = vault.names(agent.ownerId);
        return all.length
          ? all
              .map(
                (c) =>
                  `${c.name} (${c.service}): ${c.hosts.length ? c.hosts.join(", ") : "no hosts yet"}`,
              )
              .join("\n")
          : "The keychain is empty. The person adds a credential in Settings > Keychain.";
      }
      return vault.request(
        {
          ownerId: agent.ownerId,
          agentId: agent.id,
          agentName: agent.name,
          sessionId: ctx.sessionId,
          automationId: ctx.sessionId ? await automationOf(ctx.sessionId).catch(() => null) : null,
          tool: "use_credential",
        },
        i,
        ctx.signal,
      );
    },
  } as Tool;
}

/** The person's words with any secret blanked, and a line for the agent when one was. */
export function blankPastedSecrets(text: string): string {
  const { text: clean, found } = hideSecrets(text, "[secret removed]");
  return found.length === 0
    ? text
    : `${clean}\n\n(RedGiant removed ${found.length === 1 ? "a secret" : `${found.length} secrets`} from this message before it reached you. Tell the person, in their language, that secrets never go in a chat, and that they can keep it safely in Settings > Keychain, where you can use it by name without seeing it.)`;
}
