// A shared folder over SMB (p3.7.2: Windows, a NAS) for backups, without mounting anything, so it
// works in a container and in Docker too. There is no well-kept pure-JavaScript SMB2/3 client
// (the forks of node-smb2 stopped in 2021-2022 at SMB 2.0.2 without signing or encryption), so
// Samba's own `smbclient` runs, with execFile and no shell. The password never goes in its
// arguments, its environment or a log: it is written to an authentication file (0600, in a
// private folder of the data folder) only for the call, and the folder is removed right after.
// Every name that reaches smbclient's own command language is checked first (no quotes, no `;`).
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SmbAddress {
  host: string;
  share: string;
  /** "/"-separated, "" for the share's top. */
  folder: string;
}

export interface SmbLogin {
  user: string;
  password: string;
  domain?: string | undefined;
}

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*|\d{1,3}(?:\.\d{1,3}){3})$/;
const SHARE = /^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$/;
/** A file or folder name inside smbclient's quotes: no quote, `;`, backslash or control. */
export const SMB_NAME = /^[A-Za-z0-9 _.()+,=@[\]{}-]{1,120}$/;
const USER = /^[^\0\r\n"\\/[\]:;|=,+*?<>]{1,104}$/;
const DOMAIN = /^[A-Za-z0-9._-]{0,64}$/;

const okName = (n: string) => SMB_NAME.test(n) && n !== "." && n !== ".." && !/^\s|\s$/.test(n);

/**
 * `\\nas\backup\RedGiant`, `//nas/backup/RedGiant` or `smb://nas/backup/RedGiant`: the host, the
 * share and the folder in it; null when it is not one (or a name could not be used safely).
 */
export function parseSmbAddress(raw: string): SmbAddress | null {
  const s = raw.trim();
  const m = /^(?:smb:\/\/|\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)((?:[\\/]+[^\\/]+)*)[\\/]*$/i.exec(s);
  if (!m) return null;
  const host = (m[1] ?? "").toLowerCase();
  const share = m[2] ?? "";
  const parts = (m[3] ?? "").split(/[\\/]+/).filter(Boolean);
  if (!HOST.test(host) || !SHARE.test(share) || !parts.every(okName)) return null;
  return { host, share, folder: parts.join("/") };
}

/** Why a login cannot be used, or null. */
export function smbLoginRefusal(l: SmbLogin): "bad_user" | "bad_password" | "bad_domain" | null {
  if (!USER.test(l.user)) return "bad_user";
  if (/[\0\r\n]/.test(l.password) || l.password.length > 256) return "bad_password";
  if (l.domain !== undefined && !DOMAIN.test(l.domain)) return "bad_domain";
  return null;
}

/** The authentication file smbclient reads with `-A` (never its arguments). */
export function authFile(l: SmbLogin): string {
  return [
    `username = ${l.user}`,
    `password = ${l.password}`,
    ...(l.domain ? [`domain = ${l.domain}`] : []),
    "",
  ].join("\n");
}

/** A path inside the share as smbclient's `-D` takes it. */
const dirArg = (parts: readonly string[]) => parts.join("\\");

/** The arguments of one smbclient call: the share, the login file, the folder, one command. */
export function smbArgs(a: SmbAddress, auth: string, dir: readonly string[], command: string) {
  return [
    `//${a.host}/${a.share}`,
    "-A",
    auth,
    "--option=client min protocol=SMB2",
    ...(dir.length ? ["-D", dirArg(dir)] : []),
    "-c",
    command,
  ];
}

/** One entry of smbclient's `ls`. */
export interface SmbEntry {
  name: string;
  dir: boolean;
  size: number;
  at: string | null;
}

/** smbclient's `ls`: "  name   D   0  Sat Nov 14 03:00:00 2026" (without "." and ".."). */
export function parseSmbLs(out: string): SmbEntry[] {
  const re = /^ {2}(.+?)\s+([ADHSRNVIL]*)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*$/;
  const list: SmbEntry[] = [];
  for (const line of out.split("\n")) {
    const m = re.exec(line.replace(/\r$/, ""));
    if (!m || m[1] === "." || m[1] === "..") continue;
    const t = new Date(`${m[4]}`);
    list.push({
      name: m[1] as string,
      dir: (m[2] ?? "").includes("D"),
      size: Number(m[3]),
      at: Number.isNaN(t.getTime()) ? null : t.toISOString(),
    });
  }
  return list;
}

export type SmbCode =
  | "smb_missing"
  | "auth"
  | "no_share"
  | "unreachable"
  | "not_found"
  | "denied"
  | "exists"
  | "failed";

export class SmbError extends Error {
  constructor(
    readonly code: SmbCode,
    message: string,
  ) {
    super(message);
  }
}

/** What went wrong, from smbclient's NT_STATUS code (only the code is kept, never its output). */
export function smbFailure(out: string, where: string): SmbError {
  const status = /NT_STATUS_[A-Z_]+/.exec(out)?.[0] ?? "";
  if (/LOGON_FAILURE|WRONG_PASSWORD|ACCOUNT_|PASSWORD_EXPIRED/.test(status))
    return new SmbError("auth", `${where} refused the user name or the password`);
  if (/BAD_NETWORK_NAME/.test(status))
    return new SmbError("no_share", `${where}: there is no such shared folder`);
  if (
    /Connection to .* failed|Unable to connect|not known/i.test(out) ||
    /HOST_UNREACHABLE|IO_TIMEOUT|CONNECTION_(REFUSED|RESET|DISCONNECTED)|NETWORK_UNREACHABLE/.test(
      status,
    )
  )
    return new SmbError("unreachable", `${where} does not answer: is it on and on the network?`);
  if (/OBJECT_(PATH|NAME)_NOT_FOUND|NO_SUCH_FILE/.test(status))
    return new SmbError("not_found", `${where}: the folder or file is not there`);
  if (/OBJECT_NAME_COLLISION/.test(status))
    return new SmbError("exists", `${where}: it is there already`);
  if (/ACCESS_DENIED|MEDIA_WRITE_PROTECTED/.test(status))
    return new SmbError("denied", `${where}: writing there is not allowed for this user`);
  return new SmbError("failed", `${where}: ${status || "smbclient failed"}`);
}

export type SmbRun = (
  args: string[],
  o: { cwd: string; timeoutMs: number; home: string },
) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

/** smbclient itself: no shell, no environment of ours beyond PATH (nothing secret travels). */
export const runSmbclient: SmbRun = (args, o) =>
  new Promise((resolve) => {
    execFile(
      "smbclient",
      args,
      {
        cwd: o.cwd,
        timeout: o.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: o.home, LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (e && e.code === "ENOENT")
          return resolve({ code: null, stdout: "", stderr: "", missing: true });
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/** A share reached for a while: every call with the same short-lived authentication file. */
export class SmbSession {
  private dir: string | undefined;

  constructor(
    private readonly a: SmbAddress,
    private readonly login: SmbLogin,
    /** A private folder of RedGiant's (its data's tmp): the login file lives here, briefly. */
    private readonly privateDir: string,
    private readonly run: SmbRun = runSmbclient,
    private readonly timeoutMs = 30 * 60_000,
  ) {
    const why = smbLoginRefusal(login);
    if (why)
      throw new SmbError(
        "auth",
        `The sign-in for \\\\${a.host}\\${a.share} cannot be used (${why})`,
      );
  }

  get where(): string {
    return `\\\\${this.a.host}\\${this.a.share}`;
  }

  private async auth(): Promise<string> {
    if (!this.dir) {
      await mkdir(this.privateDir, { recursive: true, mode: 0o700 });
      this.dir = await mkdtemp(join(this.privateDir, "smb-"));
      await chmod(this.dir, 0o700);
      await writeFile(join(this.dir, "auth"), authFile(this.login), { mode: 0o600 });
    }
    return join(this.dir, "auth");
  }

  /** Removes the login file: always, after the last call. */
  async close(): Promise<void> {
    const d = this.dir;
    this.dir = undefined;
    if (d) await rm(d, { recursive: true, force: true });
  }

  /** One command in `dir` (inside the share's folder); `cwd` is where local files are. */
  async cmd(dir: readonly string[], command: string, cwd?: string): Promise<string> {
    const auth = await this.auth();
    const home = this.dir as string;
    const r = await this.run(smbArgs(this.a, auth, dir, command), {
      cwd: cwd ?? home,
      timeoutMs: this.timeoutMs,
      home,
    });
    if (r.missing)
      throw new SmbError(
        "smb_missing",
        "smbclient is not installed here: shared folders over SMB need it (Samba's smbclient)",
      );
    const out = `${r.stdout}\n${r.stderr}`;
    // smbclient prints NT_STATUS errors and may still exit 0 for some commands.
    if (r.code !== 0 || /NT_STATUS_(?!OK)[A-Z_]+/.test(out)) throw smbFailure(out, this.where);
    return r.stdout;
  }

  private base(): string[] {
    return this.a.folder ? this.a.folder.split("/") : [];
  }

  private path(...names: string[]): string[] {
    for (const n of names)
      if (!okName(n)) throw new SmbError("failed", `"${n}" cannot be used as a name there`);
    return [...this.base(), ...names];
  }

  /** The folder in the share, made when missing (each level). */
  async ensureBase(): Promise<void> {
    const parts = this.base();
    for (let i = 0; i < parts.length; i++) {
      try {
        await this.cmd(parts.slice(0, i), `mkdir "${parts[i]}"`);
      } catch (err) {
        if (!(err instanceof SmbError && err.code === "exists")) throw err;
      }
    }
  }

  async ls(...sub: string[]): Promise<SmbEntry[]> {
    return parseSmbLs(await this.cmd(this.path(...sub), "ls"));
  }

  async mkdir(name: string): Promise<void> {
    try {
      await this.cmd(this.path(), `mkdir "${this.path(name).at(-1)}"`);
    } catch (err) {
      if (!(err instanceof SmbError && err.code === "exists")) throw err;
    }
  }

  /** Sends `localDir/localName` as `<folder>/<sub…>/remoteName`. */
  async put(localDir: string, localName: string, sub: string[], remoteName: string) {
    if (!okName(localName)) throw new SmbError("failed", "Bad local name");
    const dir = this.path(...sub);
    this.path(remoteName);
    await this.cmd(dir, `put "${localName}" "${remoteName}"`, localDir);
  }

  async get(sub: string[], remoteName: string, localDir: string, localName: string) {
    if (!okName(localName)) throw new SmbError("failed", "Bad local name");
    const dir = this.path(...sub);
    this.path(remoteName);
    await this.cmd(dir, `get "${remoteName}" "${localName}"`, localDir);
  }

  async rename(sub: string[], from: string, to: string) {
    const dir = this.path(...sub);
    this.path(from, to);
    await this.cmd(dir, `rename "${from}" "${to}"`);
  }

  async del(sub: string[], name: string) {
    const dir = this.path(...sub);
    this.path(name);
    await this.cmd(dir, `del "${name}"`);
  }

  async deltree(name: string) {
    this.path(name);
    await this.cmd(this.path(), `deltree "${name}"`);
  }
}
