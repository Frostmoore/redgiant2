// The person's machines (G38.2): other computers the agents reach over SSH, through ssh2 (pure
// JavaScript, MIT: no ssh program on this computer is needed, on Windows, macOS or Linux).
//
// What is kept where:
//  - the machine (name, host, port, user, working folder, who may use it, the public key, the
//    machine's own key once trusted) in rg_settings, key "machines": never a secret;
//  - the private key, its passphrase and the password in the keychain (G36.20), as entries used
//    by RedGiant (`ssh:<id>:key`, `ssh:<id>:passphrase`, `ssh:<id>:password`), read by this server
//    only when it connects. An agent never sees them; no command's environment carries them.
//
// The machine's own key (its host key) is fixed the first time the person tests it from the page,
// after seeing its fingerprint (trust on first use). Before that no agent may connect, and no
// password is ever sent to a machine whose key is not the fixed one: a different key ends the
// connection before logging in, with a message that says so. Agent forwarding is never asked.
import { createHash, randomUUID } from "node:crypto";
import type { SqlClient } from "@redgiant/events";
import {
  type MachineAccess,
  MachineBody,
  type MachineHostKey,
  type MachineTest,
  type MachineTestCode,
  type MachineView,
  WINDOWS_FOLDER,
} from "@redgiant/protocol";
import ssh2 from "ssh2";
import type { SystemKeyMeta, Vault } from "./vault.js";

const { Client, utils } = ssh2;

/**
 * A new ed25519 key pair. ssh2's generator drops a leading zero byte about once in 256 keys,
 * leaving a 31-byte public key that nothing (ssh2 itself included) can read: such a pair is
 * thrown away and made again.
 */
export function newSshKeyPair(comment?: string): { private: string; public: string } {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519", comment ? { comment } : {});
    const priv = utils.parseKey(pair.private);
    const pub = utils.parseKey(pair.public);
    if (!(priv instanceof Error) && !(pub instanceof Error)) return pair;
  }
}
export type SshClient = InstanceType<typeof Client>;

const SETTING = "machines";

export class MachineError extends Error {
  constructor(
    readonly code: MachineTestCode | "not-found" | "invalid" | "vault" | "not-trusted",
    message: string,
    /** The fingerprint the machine showed (a new or a changed key). */
    readonly hostKey?: { type: string; fingerprint: string },
  ) {
    super(message);
  }
}

/** A machine as kept: the view, without anything secret (there is none in it). */
type Stored = MachineView;

/** `SHA256:…` as OpenSSH prints it, and the key's type, from the key's wire form. */
export function hostKeyOf(blob: Buffer): { type: string; fingerprint: string } {
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = len > 0 && len < 64 ? blob.subarray(4, 4 + len).toString("latin1") : "unknown";
  const hash = createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { type, fingerprint: `SHA256:${hash}` };
}

/** A Windows drive path (`E:\…`, `E:/…`): the machine is a Windows one (p3.7.2). */
export const isWindowsPath = (p: string | undefined): boolean =>
  p !== undefined && /^[A-Za-z]:[\\/]/.test(p);

/** The home of the user a machine logs in as (for `~` and the rules), as most systems put it. */
export function homeOf(user: string, windows = false): string {
  if (windows) return `C:\\Users\\${user}`;
  return user === "root" ? "/root" : `/home/${user}`;
}

/** A machine's working folder with `~` spelled out; a Windows one with backslashes. */
export function folderOf(m: Pick<MachineView, "folder" | "user">): string | undefined {
  if (!m.folder) return undefined;
  if (isWindowsPath(m.folder)) {
    const w = m.folder.replace(/\//g, "\\").replace(/\\+$/, "");
    return w.length === 2 ? `${w}\\` : w;
  }
  return m.folder.replace(/^~(?=\/|$)/, homeOf(m.user)).replace(/\/+$/, "") || "/";
}

/** Who asks: an agent, the one it works for, its project. */
export interface MachineCaller {
  id: string;
  parentId?: string | null | undefined;
  projectId?: string | null | undefined;
}

/** Whether an agent may use a machine (the person's choice on the page). */
export function mayUse(access: MachineAccess, a: MachineCaller): boolean {
  if (access.everyone) return true;
  if (access.agents.includes(a.id)) return true;
  if (a.parentId && access.agents.includes(a.parentId)) return true;
  return a.projectId != null && access.projects.includes(a.projectId);
}

export interface MachineOptions {
  db: SqlClient;
  /** Where the keys are kept; without it (or closed) no machine can be added or used. */
  vault: () => Vault | undefined;
  /** Seconds to reach a machine and log in (default 15). */
  connectTimeoutMs?: number;
  now?: () => Date;
  /** Tests: where the machine really is (a fake server on 127.0.0.1). Never the person's network. */
  dial?: (m: MachineView) => { host: string; port: number };
}

export interface MachinePatch {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  folder?: string | null;
  access?: MachineAccess;
  /** A new password (auth "password"), or null to remove it. */
  password?: string | null;
  /** A pasted private key that takes the place of the one kept. */
  privateKey?: string;
  passphrase?: string | null;
  /** A new pair made by RedGiant (the old public key must leave the machine's authorized_keys). */
  newKey?: boolean;
}

/** The machines of every person, kept in rg_settings and in memory for the rules. */
export class Machines {
  private readonly cache = new Map<string, Stored[]>();

  constructor(private readonly o: MachineOptions) {}

  private now() {
    return (this.o.now ?? (() => new Date()))();
  }

  private vault(): Vault {
    const v = this.o.vault();
    if (!v?.ready)
      throw new MachineError(
        "vault",
        "The keychain is closed: a machine's keys live only there. Open it in Settings > Keychain first.",
      );
    return v;
  }

  private keyOf(id: string, what: "key" | "passphrase" | "password") {
    return `ssh:${id}:${what}`;
  }

  private meta(m: Pick<MachineView, "id" | "name" | "host" | "user">, what: string): SystemKeyMeta {
    return {
      name: `ssh-${m.name}-${what}`,
      service: `SSH ${m.name}`,
      brand: "ssh",
      category: "server",
      username: m.user,
      hosts: [m.host.toLowerCase()],
      inject: { header: "", format: "{value}" },
      section: "machines",
      kind: "ssh",
      what: `${what} for ${m.user}@${m.host}`,
    };
  }

  /** Every machine of the person, oldest first (also refreshes what the rules read). */
  async list(ownerId: string): Promise<MachineView[]> {
    const [row] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = $2",
      [ownerId, SETTING],
    );
    const v = row ? (typeof row.value === "string" ? JSON.parse(row.value) : row.value) : [];
    const list = Array.isArray(v) ? (v as Stored[]) : [];
    this.cache.set(ownerId, list);
    return list;
  }

  /** What was read last (the permission rules need it without waiting). */
  cached(ownerId: string): readonly MachineView[] {
    return this.cache.get(ownerId) ?? [];
  }

  /** Each machine's working folder and home, by name, for `criticalOf` (G38.2). */
  rulesInfo(ownerId: string): Record<string, { folder?: string; home: string }> {
    const out: Record<string, { folder?: string; home: string }> = {};
    for (const m of this.cached(ownerId)) {
      const folder = folderOf(m);
      out[m.name] = { home: homeOf(m.user, isWindowsPath(m.folder)), ...(folder && { folder }) };
    }
    return out;
  }

  private async save(ownerId: string, list: Stored[]): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, SETTING, JSON.stringify(list)],
    );
    this.cache.set(ownerId, list);
  }

  async get(ownerId: string, idOrName: string): Promise<MachineView> {
    const m = (await this.list(ownerId)).find((x) => x.id === idOrName || x.name === idOrName);
    if (!m) throw new MachineError("not-found", `There is no machine "${idOrName}"`);
    return m;
  }

  /** The machines an agent may use. */
  async allowed(ownerId: string, a: MachineCaller): Promise<MachineView[]> {
    return (await this.list(ownerId)).filter((m) => mayUse(m.access, a));
  }

  /** A private key pasted by the person: checked, and its public half. */
  private parsePrivate(text: string, passphrase?: string): string {
    const parsed = utils.parseKey(text.trim(), passphrase || undefined);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error)
      throw new MachineError(
        "invalid",
        key instanceof Error && /passphrase|encrypted/i.test(key.message)
          ? "The private key is protected by a passphrase: write it too"
          : "This is not a private key RedGiant can read (OpenSSH or PEM)",
      );
    if (!key.isPrivateKey())
      throw new MachineError("invalid", "This is a public key: paste the private one");
    return `${key.type} ${key.getPublicSSH().toString("base64")}`;
  }

  async add(ownerId: string, raw: unknown): Promise<MachineView> {
    const b = MachineBody.parse(raw);
    const vault = this.vault();
    const list = await this.list(ownerId);
    if (list.some((m) => m.name.toLowerCase() === b.name.toLowerCase()))
      throw new MachineError("invalid", `There is already a machine called "${b.name}"`);
    if (b.auth === "password" && !b.password)
      throw new MachineError("invalid", "Write the password, or choose a key");
    const at = this.now().toISOString();
    const id = `mach_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const m: Stored = {
      id,
      name: b.name,
      host: b.host,
      port: b.port,
      user: b.user,
      auth: b.auth,
      ...(b.folder && { folder: b.folder }),
      access: b.access,
      createdAt: at,
      updatedAt: at,
    };
    const want = new Map<string, { value: string; meta: SystemKeyMeta }>();
    if (b.auth === "key") {
      if (b.privateKey?.trim()) {
        m.publicKey = `${this.parsePrivate(b.privateKey, b.passphrase)} redgiant-${b.name}`;
        m.keySource = "imported";
        want.set(this.keyOf(id, "key"), {
          value: b.privateKey.trim(),
          meta: this.meta(m, "private key"),
        });
        if (b.passphrase)
          want.set(this.keyOf(id, "passphrase"), {
            value: b.passphrase,
            meta: this.meta(m, "key passphrase"),
          });
      } else {
        const pair = newSshKeyPair(`redgiant-${b.name}`);
        m.publicKey = pair.public.trim();
        m.keySource = "generated";
        want.set(this.keyOf(id, "key"), { value: pair.private, meta: this.meta(m, "private key") });
      }
    } else if (b.password) {
      want.set(this.keyOf(id, "password"), { value: b.password, meta: this.meta(m, "password") });
    }
    m.hasPassword = want.has(this.keyOf(id, "password")) || want.has(this.keyOf(id, "passphrase"));
    await vault.syncSystem(ownerId, `ssh:${id}:`, want);
    await this.save(ownerId, [...list, m]);
    return m;
  }

  async update(ownerId: string, id: string, p: MachinePatch): Promise<MachineView> {
    const list = await this.list(ownerId);
    const i = list.findIndex((m) => m.id === id);
    const old = list[i];
    if (!old) throw new MachineError("not-found", `There is no machine "${id}"`);
    // Field by field: a partial schema would fill in the defaults (port 22, nobody may use it).
    const f = MachineBody.shape;
    const check = {
      ...(p.name !== undefined && { name: f.name.parse(p.name) }),
      ...(p.host !== undefined && { host: f.host.parse(p.host) }),
      ...(p.port !== undefined && { port: f.port.parse(p.port) }),
      ...(p.user !== undefined && { user: f.user.parse(p.user) }),
      ...(typeof p.folder === "string" && p.folder !== "" && { folder: f.folder.parse(p.folder) }),
      ...(p.access && { access: f.access.parse(p.access) }),
    };
    if (
      check.name &&
      list.some((m) => m.id !== id && m.name.toLowerCase() === check.name?.toLowerCase())
    )
      throw new MachineError("invalid", `There is already a machine called "${check.name}"`);
    const m: Stored = { ...old, updatedAt: this.now().toISOString() };
    if (check.name) m.name = check.name;
    if (check.port !== undefined) m.port = check.port;
    if (check.user) m.user = check.user;
    if (check.access) m.access = check.access;
    if (p.folder === null || p.folder === "") delete m.folder;
    else if (check.folder) m.folder = check.folder;
    // Another address is another machine: its key is asked again.
    if ((check.host && check.host !== old.host) || (check.port && check.port !== old.port)) {
      if (check.host) m.host = check.host;
      delete m.hostKey;
      delete m.lastTest;
    }
    const touchesSecrets =
      p.password !== undefined ||
      p.privateKey !== undefined ||
      p.passphrase !== undefined ||
      p.newKey === true;
    if (touchesSecrets) {
      const vault = this.vault();
      if (p.newKey) {
        const pair = newSshKeyPair(`redgiant-${m.name}`);
        await vault.setSystem(
          ownerId,
          this.keyOf(id, "key"),
          pair.private,
          this.meta(m, "private key"),
        );
        await vault.setSystem(ownerId, this.keyOf(id, "passphrase"), null);
        m.publicKey = pair.public.trim();
        m.keySource = "generated";
        m.auth = "key";
      } else if (p.privateKey?.trim()) {
        const pass = p.passphrase ?? undefined;
        m.publicKey = `${this.parsePrivate(p.privateKey, pass)} redgiant-${m.name}`;
        await vault.setSystem(
          ownerId,
          this.keyOf(id, "key"),
          p.privateKey.trim(),
          this.meta(m, "private key"),
        );
        await vault.setSystem(
          ownerId,
          this.keyOf(id, "passphrase"),
          pass || null,
          this.meta(m, "key passphrase"),
        );
        m.keySource = "imported";
        m.auth = "key";
      }
      if (p.password !== undefined) {
        await vault.setSystem(
          ownerId,
          this.keyOf(id, "password"),
          p.password || null,
          this.meta(m, "password"),
        );
        if (p.password && !m.publicKey) m.auth = "password";
      }
      m.hasPassword =
        vault.systemValue(ownerId, this.keyOf(id, "password")) !== undefined ||
        vault.systemValue(ownerId, this.keyOf(id, "passphrase")) !== undefined;
    }
    const next = [...list];
    next[i] = m;
    await this.save(ownerId, next);
    return m;
  }

  /** The machine and its keys go (from the keychain too). */
  async remove(ownerId: string, id: string): Promise<void> {
    const list = await this.list(ownerId);
    if (!list.some((m) => m.id === id))
      throw new MachineError("not-found", `There is no machine "${id}"`);
    const vault = this.o.vault();
    if (vault?.ready) await vault.syncSystem(ownerId, `ssh:${id}:`, new Map());
    await this.save(
      ownerId,
      list.filter((m) => m.id !== id),
    );
  }

  /** The secrets to log in, read from the keychain at the moment of connecting. */
  private credentials(ownerId: string, m: MachineView) {
    const vault = this.vault();
    const privateKey = vault.systemValue(ownerId, this.keyOf(m.id, "key"));
    const passphrase = vault.systemValue(ownerId, this.keyOf(m.id, "passphrase"));
    const password = vault.systemValue(ownerId, this.keyOf(m.id, "password"));
    if (!privateKey && !password)
      throw new MachineError(
        "no-secret",
        `The machine "${m.name}" has no key or password in the keychain: set one in Settings > Machines`,
      );
    void vault.recordSystemUse(
      ownerId,
      this.keyOf(m.id, privateKey ? "key" : "password"),
      "ssh",
      m.host,
    );
    return { privateKey, passphrase, password };
  }

  /**
   * Connects and logs in. The machine's key must be the fixed one (`expect`), or, for the page's
   * first test, is only looked at (`firstLook`: the connection ends before logging in).
   */
  async connect(
    ownerId: string,
    m: MachineView,
    o: { signal?: AbortSignal; firstLook?: boolean } = {},
  ): Promise<SshClient> {
    if (!m.hostKey && !o.firstLook)
      throw new MachineError(
        "not-trusted",
        `The machine "${m.name}" was never checked: the person must test it once in Settings > Machines and trust its key`,
      );
    const creds = o.firstLook ? undefined : this.credentials(ownerId, m);
    const where = this.o.dial?.(m) ?? { host: m.host, port: m.port };
    const client = new Client();
    let seen: { type: string; fingerprint: string } | undefined;
    return await new Promise<SshClient>((resolve, reject) => {
      let settled = false;
      const fail = (e: MachineError) => {
        if (settled) return;
        settled = true;
        client.end();
        reject(e);
      };
      const onAbort = () => fail(new MachineError("error", "Stopped"));
      o.signal?.addEventListener("abort", onAbort, { once: true });
      client.on("ready", () => {
        settled = true;
        o.signal?.removeEventListener("abort", onAbort);
        resolve(client);
      });
      client.on("error", (err: Error & { level?: string; code?: string }) => {
        o.signal?.removeEventListener("abort", onAbort);
        if (seen && !m.hostKey)
          return fail(
            new MachineError(
              "host-key-new",
              `First connection to "${m.name}": its key is ${seen.type} ${seen.fingerprint}. Check it and trust it.`,
              seen,
            ),
          );
        if (seen && m.hostKey && seen.fingerprint !== m.hostKey.fingerprint)
          return fail(
            new MachineError(
              "host-key-changed",
              `DANGER: the machine "${m.name}" (${m.host}) answered with a different key (${seen.fingerprint}, fixed: ${m.hostKey.fingerprint}). Another computer may be in its place: nothing was sent and the connection was refused. Only the person can trust the new key, in Settings > Machines.`,
              seen,
            ),
          );
        if (err.level === "client-authentication")
          return fail(
            new MachineError(
              "auth",
              `The machine "${m.name}" refused the login of ${m.user}: is the public key in ~/.ssh/authorized_keys there (or the password right)?`,
            ),
          );
        if (err.level === "client-timeout" || /timed out/i.test(err.message))
          return fail(
            new MachineError("timeout", `The machine "${m.name}" did not answer in time`),
          );
        if (err.code && /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ENETUNREACH|EAI_AGAIN/.test(err.code))
          return fail(
            new MachineError(
              "unreachable",
              `The machine "${m.name}" cannot be reached: ${err.code}`,
            ),
          );
        fail(new MachineError("error", `SSH to "${m.name}": ${err.message}`));
      });
      client.on("close", () => {
        if (!settled)
          fail(new MachineError("error", `The machine "${m.name}" closed the connection`));
      });
      client.connect({
        host: where.host,
        port: where.port,
        username: m.user,
        readyTimeout: this.o.connectTimeoutMs ?? 15_000,
        // Never: the person's keys stay here.
        agentForward: false,
        hostVerifier: (key: Buffer) => {
          seen = hostKeyOf(key);
          if (o.firstLook) return false;
          return m.hostKey !== undefined && seen.fingerprint === m.hostKey.fingerprint;
        },
        ...(creds?.privateKey && { privateKey: creds.privateKey }),
        ...(creds?.passphrase && { passphrase: creds.passphrase }),
        ...(creds?.password && { password: creds.password }),
        // Keyboard-interactive with the password, for servers that ask that way.
        ...(creds?.password && { tryKeyboard: true }),
      });
      if (creds?.password)
        client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) =>
          finish(prompts.map(() => creds.password as string)),
        );
    });
  }

  /**
   * «Prova la connessione»: the machine's key (shown at the first time, compared afterwards),
   * then the login and `uname -a`. Nothing is sent before the key is the fixed one.
   */
  async test(ownerId: string, id: string): Promise<MachineTest> {
    const m = await this.get(ownerId, id);
    let r: MachineTest;
    if (!m.hostKey) {
      try {
        const c = await this.connect(ownerId, m, { firstLook: true });
        c.end();
        r = { ok: false, code: "error", message: "The machine did not show its key" };
      } catch (err) {
        const e = err as MachineError;
        r = {
          ok: false,
          code: e.code === "host-key-new" ? "host-key-new" : this.codeOf(e),
          message: e.message,
          ...(e.hostKey && { hostKey: e.hostKey }),
        };
      }
    } else {
      try {
        const c = await this.connect(ownerId, m);
        try {
          const out = await execText(c, 'uname -a 2>/dev/null || ver; printf "%s" "$HOME"');
          const [system = "", home = ""] = splitLast(out.stdout);
          r = {
            ok: true,
            code: "ok",
            message: "Connected",
            hostKey: { type: m.hostKey.type, fingerprint: m.hostKey.fingerprint },
            system: system.trim().slice(0, 300),
            ...(home && { home: home.trim().slice(0, 300) }),
          };
        } finally {
          c.end();
        }
      } catch (err) {
        const e = err as MachineError;
        r = {
          ok: false,
          code: this.codeOf(e),
          message: e.message,
          ...(e.hostKey && { hostKey: e.hostKey }),
          ...(e.code === "host-key-changed" && { expected: m.hostKey.fingerprint }),
        };
      }
    }
    await this.setTest(ownerId, m.id, r);
    return r;
  }

  private codeOf(e: unknown): MachineTestCode {
    const c = e instanceof MachineError ? e.code : "error";
    return c === "not-found" || c === "invalid" || c === "vault" || c === "not-trusted"
      ? "error"
      : c;
  }

  private async setTest(ownerId: string, id: string, r: MachineTest) {
    const list = await this.list(ownerId);
    const next = list.map((m) =>
      m.id === id
        ? { ...m, lastTest: { at: this.now().toISOString(), ok: r.ok, code: r.code } }
        : m,
    );
    await this.save(ownerId, next);
  }

  /**
   * The person trusts the key they saw: it is fixed only if the machine shows that same key now
   * (a key changed between the look and the yes is not taken).
   */
  async trust(ownerId: string, id: string, fingerprint: string): Promise<MachineView> {
    const m = await this.get(ownerId, id);
    let seen: { type: string; fingerprint: string } | undefined;
    try {
      (await this.connect(ownerId, withoutHostKey(m), { firstLook: true })).end();
    } catch (err) {
      seen = (err as MachineError).hostKey;
    }
    if (!seen)
      throw new MachineError("unreachable", `The machine "${m.name}" did not show its key now`);
    if (seen.fingerprint !== fingerprint)
      throw new MachineError(
        "host-key-changed",
        `The machine "${m.name}" shows another key now (${seen.fingerprint}): nothing was trusted`,
        seen,
      );
    const hostKey: MachineHostKey = { ...seen, pinnedAt: this.now().toISOString() };
    const list = await this.list(ownerId);
    const out = { ...m, hostKey, updatedAt: hostKey.pinnedAt };
    await this.save(
      ownerId,
      list.map((x) => (x.id === id ? out : x)),
    );
    return out;
  }
}

function withoutHostKey(m: MachineView): MachineView {
  const { hostKey: _k, ...rest } = m;
  return rest;
}

/** The last line apart from the rest (printf without a new line). */
function splitLast(text: string): [string, string] {
  const i = text.lastIndexOf("\n");
  return i < 0 ? ["", text] : [text.slice(0, i), text.slice(i + 1)];
}

// ---------------------------------------------------------------- Running and copying there

export interface RemoteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
}

/**
 * The command line sent: the command, started in `cwd` when there is one. A Windows folder is
 * entered with `pushd "E:\…" &&`, which PowerShell 7 (OpenSSH's usual shell there) and cmd both
 * take; one with a character either shell would expand inside the quotes is refused. Anything
 * else goes through a POSIX shell's `cd`.
 */
export function remoteLine(command: string, cwd: string | undefined): string {
  if (!cwd) return command;
  if (isWindowsPath(cwd)) {
    if (!WINDOWS_FOLDER.test(cwd))
      throw new MachineError("invalid", `The folder ${cwd} cannot be used in a command there`);
    const w = cwd.replace(/\//g, "\\");
    return `pushd "${w}" && ${command}`;
  }
  return `cd ${shellQuote(cwd)} && ${command}`;
}

/** A path for a POSIX shell, in single quotes; `~` and `~/…` keep meaning the home. */
export function shellQuote(p: string): string {
  if (p === "~") return '"$HOME"';
  if (p.startsWith("~/")) return `"$HOME"/${shellQuote(p.slice(2))}`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

const OUTPUT_CAP = 4 * 1024 * 1024;

/**
 * Runs a command there: no terminal, no environment of ours (nothing of RedGiant's travels), in
 * `cwd`. A timeout or a stop sends TERM, then KILL, and closes the channel.
 */
export function execRemote(
  client: SshClient,
  command: string,
  o: {
    cwd?: string | undefined;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    onOutput?: ((text: string, stream: "out" | "err") => void) | undefined;
  },
): Promise<RemoteResult> {
  let line: string;
  try {
    line = remoteLine(command, o.cwd);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    client.exec(line, { pty: false }, (err, ch) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let stopped = false;
      let code: number | null = null;
      const take = (d: Buffer, s: "out" | "err") => {
        const text = d.toString("utf8");
        if (o.onOutput) return o.onOutput(text, s);
        if (s === "out" && stdout.length < OUTPUT_CAP) stdout += text;
        if (s === "err" && stderr.length < OUTPUT_CAP) stderr += text;
      };
      ch.on("data", (d: Buffer) => take(d, "out"));
      ch.stderr.on("data", (d: Buffer) => take(d, "err"));
      ch.on("exit", (c: number | null) => {
        code = typeof c === "number" ? c : null;
      });
      const end = (why: "timeout" | "stop") => {
        if (why === "timeout") timedOut = true;
        else stopped = true;
        try {
          ch.signal("TERM");
          setTimeout(() => {
            try {
              ch.signal("KILL");
            } catch {}
            ch.close();
          }, 1500).unref();
        } catch {
          ch.close();
        }
      };
      const timer = Number.isFinite(o.timeoutMs)
        ? setTimeout(() => end("timeout"), o.timeoutMs)
        : undefined;
      const onAbort = () => end("stop");
      if (o.signal?.aborted) onAbort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      ch.on("close", () => {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        resolve({ stdout, stderr, exitCode: code, timedOut, stopped });
      });
    });
  });
}

/** A short command whose output is text (the page's test). */
export function execText(client: SshClient, command: string): Promise<RemoteResult> {
  return execRemote(client, command, { timeoutMs: 15_000 });
}
