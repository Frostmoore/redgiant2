// Where a scheduled backup is written (p3.7.2), the same way for every kind of destination: a
// folder here (a disk RedGiant mounted, a folder the host mounted), one of the person's SSH
// machines over SFTP, an SMB share, another RedGiant paired as a node. Each one lists its backup
// folders, keeps the list of those the schedule made, and takes a finished file under a temporary
// name, renamed only once it is all there and checked (size, and SHA-256 where the other side can
// tell it): never a half copy under the good name. A destination that is not there (the NAS off,
// the machine offline) is an error the person sees, never a backup written somewhere else.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BackupEntry } from "@redgiant/protocol";
import type { SFTPWrapper } from "ssh2";
import { SAFETY_FILE, SAFETY_FOLDER } from "./backup.js";
import {
  execRemote,
  isWindowsPath,
  MachineError,
  type Machines,
  type SshClient,
  shellQuote,
} from "./machines.js";
import type { Nodes } from "./nodes/service.js";
import { SmbError, type SmbRun, SmbSession } from "./smb.js";

/** The list of folders the schedule made, kept beside them. */
export const MADE_FILE = "redgiant-scheduled.json";

export class TargetError extends Error {
  constructor(
    readonly code:
      | "unreachable"
      | "auth"
      | "not_found"
      | "denied"
      | "mismatch"
      | "smb_missing"
      | "bad_path"
      | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface BackupTarget {
  /** Where, for messages ("the machine nas: /volume1/backup"). */
  readonly where: string;
  /** The backup folders there ("RedGiant-backup-2026-11-14"…). */
  folders(): Promise<string[]>;
  readMade(): Promise<string[]>;
  writeMade(list: readonly string[]): Promise<void>;
  /** The local file to write the backup into (a temporary name beside it, or a staging file). */
  stage(folder: string, file: string): Promise<string>;
  /** Puts the finished staged file at `<folder>/<file>`: whole and checked, or not at all. */
  put(staged: string, folder: string, file: string): Promise<void>;
  /** The backups there, newest first. */
  list(): Promise<BackupEntry[]>;
  /** A backup as a local file to read (downloaded when it is elsewhere); `done` cleans up. */
  fetch(folder: string, file: string): Promise<{ path: string; done: () => Promise<void> }>;
  removeFolder(folder: string): Promise<void>;
  close(): Promise<void>;
}

const sha256File = async (path: string): Promise<string> => {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
};

const checkName = (folder: string, file?: string) => {
  if (!SAFETY_FOLDER.test(folder) || (file !== undefined && !SAFETY_FILE.test(file)))
    throw new TargetError("bad_path", "Not a backup's name");
};

const newestFirst = (a: BackupEntry, b: BackupEntry) =>
  b.folder.localeCompare(a.folder) || b.file.localeCompare(a.file);

const parseMade = (t: string) => {
  try {
    const v = JSON.parse(t) as { folders?: unknown };
    return Array.isArray(v.folders)
      ? v.folders.filter((f): f is string => typeof f === "string")
      : [];
  } catch {
    return [];
  }
};
const madeText = (list: readonly string[]) => `${JSON.stringify({ folders: list })}\n`;

// ---------------------------------------------------------------- a folder here

/** A folder of this machine (a disk, a folder the host mounted): written in place. */
export function localTarget(dir: string): BackupTarget {
  return {
    where: dir,
    folders: async () =>
      (await readdir(dir).catch(() => [] as string[])).filter((f) => SAFETY_FOLDER.test(f)),
    readMade: async () => parseMade(await readFile(join(dir, MADE_FILE), "utf8").catch(() => "")),
    writeMade: (list) => writeFile(join(dir, MADE_FILE), madeText(list)),
    stage: async (folder, file) => {
      checkName(folder, file);
      await mkdir(join(dir, folder), { recursive: true });
      return join(dir, folder, `.${file}.part`);
    },
    put: async (staged, folder, file) => {
      checkName(folder, file);
      await rename(staged, join(dir, folder, file));
    },
    list: async () => {
      const out: BackupEntry[] = [];
      for (const folder of (await readdir(dir).catch(() => [] as string[])).filter((f) =>
        SAFETY_FOLDER.test(f),
      ))
        for (const file of await readdir(join(dir, folder)).catch(() => [] as string[])) {
          if (!SAFETY_FILE.test(file)) continue;
          const st = await stat(join(dir, folder, file)).catch(() => undefined);
          if (st?.isFile())
            out.push({
              id: `${folder}/${file}`,
              folder,
              file,
              bytes: st.size,
              at: st.mtime.toISOString(),
            });
        }
      return out.sort(newestFirst);
    },
    fetch: async (folder, file) => {
      checkName(folder, file);
      return { path: join(dir, folder, file), done: async () => {} };
    },
    removeFolder: async (folder) => {
      checkName(folder);
      await rm(join(dir, folder), { recursive: true, force: true });
    },
    close: async () => {},
  };
}

/** A staging file in RedGiant's own temporary folder, for a backup that travels elsewhere. */
async function stagingFile(stagingDir: string): Promise<string> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  return join(stagingDir, `stage-${randomUUID()}.rgbackup`);
}

// ---------------------------------------------------------------- SFTP

const sftpCall = <T>(f: (cb: (err: Error | null | undefined, v: T) => void) => void) =>
  new Promise<T>((ok, no) => f((err, v) => (err ? no(err) : ok(v))));

/**
 * The folder there as SFTP names it: absolute, or from the home with `~`; a Windows drive folder
 * (`E:\Backup`) is `/E:/Backup`. Null when it is not a full path or climbs with "..".
 */
export function sftpFolder(home: string, path: string): string | null {
  const p = path.trim();
  if (!p || p.includes("\0")) return null;
  let t: string;
  if (isWindowsPath(p)) t = `/${p.replace(/\\/g, "/")}`;
  else if (p === "~" || p.startsWith("~/")) t = `${home.replace(/\/+$/, "")}${p.slice(1)}`;
  else if (p.startsWith("/")) t = p;
  else return null;
  if (t.split("/").includes("..")) return null;
  return posix.normalize(t).replace(/(.)\/+$/, "$1");
}

const sftpCode = (err: unknown): TargetError => {
  if (err instanceof TargetError) return err;
  if (err instanceof MachineError) {
    const code =
      err.code === "unreachable" || err.code === "timeout"
        ? "unreachable"
        : err.code === "auth"
          ? "auth"
          : "failed";
    return new TargetError(code, err.message);
  }
  const e = err as { code?: number; message?: string };
  // SFTP's status codes: 2 no such file, 3 permission denied.
  if (e.code === 2) return new TargetError("not_found", e.message ?? "No such file there");
  if (e.code === 3) return new TargetError("denied", e.message ?? "Permission denied there");
  return new TargetError("failed", (err as Error).message ?? String(err));
};

export interface SftpTargetOptions {
  machines: Machines;
  ownerId: string;
  machineId: string;
  path: string;
  stagingDir: string;
}

/** A folder on one of the person's machines, over SFTP with its fixed host key. */
export async function sftpTarget(o: SftpTargetOptions): Promise<BackupTarget> {
  let client: SshClient;
  let sftp: SFTPWrapper;
  let name = o.machineId;
  let windows = false;
  try {
    const m = await o.machines.get(o.ownerId, o.machineId);
    name = m.name;
    windows = isWindowsPath(m.folder) || isWindowsPath(o.path);
    client = await o.machines.connect(o.ownerId, m);
    sftp = await new Promise<SFTPWrapper>((ok, no) =>
      client.sftp((err, s) => (err ? no(err) : ok(s))),
    );
  } catch (err) {
    if (err instanceof MachineError && err.code === "not-found")
      throw new TargetError(
        "not_found",
        `The machine for backups is not among the machines any more`,
      );
    throw sftpCode(err);
  }
  const home = await sftpCall<string>((cb) => sftp.realpath(".", cb)).catch(() => "/");
  // Windows' OpenSSH gives its home as /C:/Users/…: no POSIX shell there for sha256sum.
  if (/^\/[A-Za-z]:(\/|$)/.test(home)) windows = true;
  const base = sftpFolder(home, o.path);
  if (!base) {
    client.end();
    throw new TargetError("bad_path", `${o.path} is not a full folder path on ${name}`);
  }
  const where = `${name}: ${o.path}`;
  const at = (...p: string[]) => posix.join(base, ...p);
  const exists = (p: string) =>
    sftpCall<{ size: number }>((cb) => sftp.stat(p, cb)).then(
      (s) => s,
      () => undefined,
    );
  const mkdirs = async (p: string) => {
    const parts = p.split("/").filter(Boolean);
    let cur = p.startsWith("/") ? "" : ".";
    for (const part of parts) {
      cur = `${cur}/${part}`;
      if (/^\/[A-Za-z]:$/.test(cur)) continue;
      if (await exists(cur)) continue;
      await sftpCall<undefined>((cb) => sftp.mkdir(cur, (e) => cb(e, undefined))).catch(
        async (e) => {
          if (!(await exists(cur))) throw e;
        },
      );
    }
  };
  const readdirNames = async (p: string) =>
    (await sftpCall<{ filename: string; attrs: { size?: number; mtime?: number } }[]>((cb) =>
      sftp.readdir(p, cb),
    ).catch(() => [])) as {
      filename: string;
      attrs: { size?: number; mtime?: number; mode?: number };
    }[];
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      throw sftpCode(err);
    }
  };
  await guard(() => mkdirs(base));
  return {
    where,
    folders: () =>
      guard(async () =>
        (await readdirNames(base)).map((e) => e.filename).filter((f) => SAFETY_FOLDER.test(f)),
      ),
    readMade: () =>
      guard(async () => {
        if (!(await exists(at(MADE_FILE)))) return [];
        const buf = await sftpCall<Buffer>((cb) => sftp.readFile(at(MADE_FILE), cb));
        return parseMade(buf.toString("utf8"));
      }),
    writeMade: (list) =>
      guard(async () => {
        const tmp = at(`.${MADE_FILE}.part`);
        await sftpCall<undefined>((cb) =>
          sftp.writeFile(tmp, madeText(list), (e) => cb(e, undefined)),
        );
        await sftpCall<undefined>((cb) =>
          sftp.unlink(at(MADE_FILE), (e) => cb(e, undefined)),
        ).catch(() => {});
        await sftpCall<undefined>((cb) => sftp.rename(tmp, at(MADE_FILE), (e) => cb(e, undefined)));
      }),
    stage: async (folder, file) => {
      checkName(folder, file);
      return stagingFile(o.stagingDir);
    },
    put: (staged, folder, file) =>
      guard(async () => {
        checkName(folder, file);
        await mkdirs(at(folder));
        const tmp = at(folder, `.${file}.part`);
        const final = at(folder, file);
        const size = (await stat(staged)).size;
        try {
          await pipeline(createReadStream(staged), sftp.createWriteStream(tmp));
          const there = await exists(tmp);
          if (there?.size !== size)
            throw new TargetError(
              "mismatch",
              `The copy on ${name} is ${there?.size ?? 0} bytes instead of ${size}: it was not kept`,
            );
          // SHA-256 there when the machine has a shell with sha256sum (a NAS may offer SFTP only).
          if (!windows) {
            const r = await execRemote(client, `sha256sum -- ${shellQuote(tmp)}`, {
              timeoutMs: 30 * 60_000,
            }).catch(() => undefined);
            const theirs = r?.exitCode === 0 ? /^([0-9a-f]{64})\b/.exec(r.stdout)?.[1] : undefined;
            if (theirs && theirs !== (await sha256File(staged)))
              throw new TargetError(
                "mismatch",
                `The copy on ${name} arrived different (SHA-256): it was not kept`,
              );
          }
          await sftpCall<undefined>((cb) => sftp.rename(tmp, final, (e) => cb(e, undefined)));
        } catch (err) {
          await sftpCall<undefined>((cb) => sftp.unlink(tmp, (e) => cb(e, undefined))).catch(
            () => {},
          );
          throw err;
        }
      }),
    list: () =>
      guard(async () => {
        const out: BackupEntry[] = [];
        for (const e of await readdirNames(base)) {
          if (!SAFETY_FOLDER.test(e.filename)) continue;
          for (const f of await readdirNames(at(e.filename)))
            if (SAFETY_FILE.test(f.filename))
              out.push({
                id: `${e.filename}/${f.filename}`,
                folder: e.filename,
                file: f.filename,
                bytes: f.attrs.size ?? 0,
                at: f.attrs.mtime ? new Date(f.attrs.mtime * 1000).toISOString() : null,
              });
        }
        return out.sort(newestFirst);
      }),
    fetch: (folder, file) =>
      guard(async () => {
        checkName(folder, file);
        const local = await stagingFile(o.stagingDir);
        try {
          await pipeline(sftp.createReadStream(at(folder, file)), createWriteStream(local));
        } catch (err) {
          await rm(local, { force: true });
          throw err;
        }
        return { path: local, done: () => rm(local, { force: true }) };
      }),
    removeFolder: (folder) =>
      guard(async () => {
        checkName(folder);
        for (const f of await readdirNames(at(folder)))
          await sftpCall<undefined>((cb) =>
            sftp.unlink(at(folder, f.filename), (e) => cb(e, undefined)),
          );
        await sftpCall<undefined>((cb) => sftp.rmdir(at(folder), (e) => cb(e, undefined)));
      }),
    close: async () => {
      client.end();
    },
  };
}

// ---------------------------------------------------------------- SMB

export interface SmbTargetOptions {
  host: string;
  share: string;
  folder: string;
  user: string;
  password: string;
  domain?: string | undefined;
  /** RedGiant's private temporary folder (the login file, the staging file). */
  privateDir: string;
  run?: SmbRun;
}

const smbCode = (err: unknown): TargetError => {
  if (err instanceof TargetError) return err;
  if (err instanceof SmbError) {
    const code =
      err.code === "smb_missing" ||
      err.code === "auth" ||
      err.code === "unreachable" ||
      err.code === "not_found" ||
      err.code === "denied"
        ? err.code
        : err.code === "no_share"
          ? "not_found"
          : "failed";
    return new TargetError(code, err.message);
  }
  return new TargetError("failed", (err as Error).message);
};

/** A shared folder over SMB, through smbclient (smb.ts). */
export async function smbTarget(o: SmbTargetOptions): Promise<BackupTarget> {
  const s = new SmbSession(
    { host: o.host, share: o.share, folder: o.folder },
    { user: o.user, password: o.password, domain: o.domain },
    join(o.privateDir, "smb"),
    o.run,
  );
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      throw smbCode(err);
    }
  };
  const staging = join(o.privateDir, "backup-staging");
  try {
    await s.ensureBase();
  } catch (err) {
    await s.close();
    throw smbCode(err);
  }
  const where = `${s.where}${o.folder ? `\\${o.folder.replace(/\//g, "\\")}` : ""}`;
  return {
    where,
    folders: () =>
      guard(async () =>
        (await s.ls()).filter((e) => e.dir && SAFETY_FOLDER.test(e.name)).map((e) => e.name),
      ),
    readMade: () =>
      guard(async () => {
        if (!(await s.ls()).some((e) => e.name === MADE_FILE)) return [];
        const local = await stagingFile(staging);
        try {
          await s.get([], MADE_FILE, staging, basename(local));
          return parseMade(await readFile(local, "utf8"));
        } finally {
          await rm(local, { force: true });
        }
      }),
    writeMade: (list) =>
      guard(async () => {
        const local = await stagingFile(staging);
        try {
          await writeFile(local, madeText(list));
          await s.put(staging, basename(local), [], MADE_FILE);
        } finally {
          await rm(local, { force: true });
        }
      }),
    stage: async (folder, file) => {
      checkName(folder, file);
      return stagingFile(staging);
    },
    put: (staged, folder, file) =>
      guard(async () => {
        checkName(folder, file);
        await s.mkdir(folder);
        const tmp = `.${file}.part`;
        const size = (await stat(staged)).size;
        try {
          await s.put(staging, basename(staged), [folder], tmp);
          const there = (await s.ls(folder)).find((e) => e.name === tmp);
          if (there?.size !== size)
            throw new TargetError(
              "mismatch",
              `The copy on ${where} is ${there?.size ?? 0} bytes instead of ${size}: it was not kept`,
            );
          await s.rename([folder], tmp, file);
        } catch (err) {
          await s.del([folder], tmp).catch(() => {});
          throw err;
        }
      }),
    list: () =>
      guard(async () => {
        const out: BackupEntry[] = [];
        for (const d of await s.ls()) {
          if (!d.dir || !SAFETY_FOLDER.test(d.name)) continue;
          for (const f of await s.ls(d.name))
            if (!f.dir && SAFETY_FILE.test(f.name))
              out.push({
                id: `${d.name}/${f.name}`,
                folder: d.name,
                file: f.name,
                bytes: f.size,
                at: f.at,
              });
        }
        return out.sort(newestFirst);
      }),
    fetch: (folder, file) =>
      guard(async () => {
        checkName(folder, file);
        const local = await stagingFile(staging);
        try {
          await s.get([folder], file, staging, basename(local));
        } catch (err) {
          await rm(local, { force: true });
          throw err;
        }
        return { path: local, done: () => rm(local, { force: true }) };
      }),
    removeFolder: (folder) =>
      guard(async () => {
        checkName(folder);
        await s.deltree(folder);
      }),
    close: () => s.close(),
  };
}

// ---------------------------------------------------------------- a node

/** Where a node keeps this machine's scheduled backups, inside the storage it lends (G39.4). */
export const NODE_PREFIX = "system";
const PIECE = 4 * 1024 * 1024;

export interface NodeTargetOptions {
  nodes: Pick<Nodes, "request">;
  ownerId: string;
  fingerprint: string;
  name: string;
  stagingDir: string;
}

const nodeCode = (err: unknown): TargetError => {
  if (err instanceof TargetError) return err;
  const code = (err as { code?: string }).code;
  if (code === "offline" || code === "unreachable" || code === "timeout" || code === "lost")
    return new TargetError("unreachable", (err as Error).message);
  if (code === "forbidden" || code === "refused")
    return new TargetError("denied", (err as Error).message);
  if (code === "not-found") return new TargetError("not_found", (err as Error).message);
  return new TargetError("failed", (err as Error).message);
};

/** The storage a paired RedGiant lends (its own rules: `use`, and storage switched on there). */
export async function nodeTarget(o: NodeTargetOptions): Promise<BackupTarget> {
  const ask = async (body: Record<string, unknown>, what: string) => {
    try {
      return await o.nodes.request(o.ownerId, o.fingerprint, "storage", body, {
        timeoutMs: 120_000,
        log: { what },
      });
    } catch (err) {
      throw nodeCode(err);
    }
  };
  const files = async () =>
    (
      (await ask({ action: "list" }, "backup list")) as { name: string; size: number; at: string }[]
    ).filter((f) => f.name.startsWith(`${NODE_PREFIX}/`));
  const putFile = async (local: string, name: string) => {
    const h = await open(local, "r");
    try {
      const size = (await h.stat()).size;
      const buf = Buffer.alloc(PIECE);
      for (let at = 0; at < size || at === 0; at += PIECE) {
        const { bytesRead } = await h.read(buf, 0, PIECE, at);
        await ask(
          {
            action: "put",
            name,
            offset: at,
            data: buf.subarray(0, bytesRead).toString("base64"),
            last: at + PIECE >= size,
          },
          `backup ${name} (piece at ${at})`,
        );
        if (size === 0) break;
      }
      return size;
    } finally {
      await h.close();
    }
  };
  const getFile = async (name: string, local: string) => {
    const h = await open(local, "w");
    try {
      for (let at = 0; ; ) {
        const r = (await ask({ action: "get", name, offset: at }, `backup read ${name}`)) as {
          data: string;
          done: boolean;
        };
        const b = Buffer.from(r.data, "base64");
        await h.write(b, 0, b.length, at);
        at += b.length;
        if (r.done || b.length === 0) break;
      }
    } finally {
      await h.close();
    }
  };
  // Online and lending its storage: a node that is not there fails now, not halfway.
  await files();
  const where = `${o.name}`;
  return {
    where,
    folders: async () => [
      ...new Set(
        (await files()).map((f) => f.name.split("/")[1] ?? "").filter((f) => SAFETY_FOLDER.test(f)),
      ),
    ],
    readMade: async () => {
      if (!(await files()).some((f) => f.name === `${NODE_PREFIX}/${MADE_FILE}`)) return [];
      const local = await stagingFile(o.stagingDir);
      try {
        await getFile(`${NODE_PREFIX}/${MADE_FILE}`, local);
        return parseMade(await readFile(local, "utf8"));
      } finally {
        await rm(local, { force: true });
      }
    },
    writeMade: async (list) => {
      const local = await stagingFile(o.stagingDir);
      try {
        await writeFile(local, madeText(list));
        await putFile(local, `${NODE_PREFIX}/${MADE_FILE}`);
      } finally {
        await rm(local, { force: true });
      }
    },
    stage: async (folder, file) => {
      checkName(folder, file);
      return stagingFile(o.stagingDir);
    },
    put: async (staged, folder, file) => {
      checkName(folder, file);
      const name = `${NODE_PREFIX}/${folder}/${file}`;
      // The node writes `<name>.part` and renames it only with the last piece.
      const size = await putFile(staged, name);
      const there = (await files()).find((f) => f.name === name);
      const fail = async (why: string) => {
        await ask({ action: "remove", name }, `backup remove ${name}`).catch(() => {});
        throw new TargetError("mismatch", why);
      };
      if (there?.size !== size)
        await fail(`The copy on ${o.name} is ${there?.size ?? 0} bytes instead of ${size}`);
      // Nodes of 3.7.2 and later tell the file's SHA-256; older ones only its size.
      const h = (await ask({ action: "hash", name }, `backup check ${name}`).catch(() => null)) as {
        sha256?: string;
      } | null;
      if (h?.sha256 && h.sha256 !== (await sha256File(staged)))
        await fail(`The copy on ${o.name} arrived different (SHA-256)`);
    },
    list: async () =>
      (await files())
        .map((f): BackupEntry | null => {
          const [, folder = "", file = "", more] = f.name.split("/");
          return more === undefined && SAFETY_FOLDER.test(folder) && SAFETY_FILE.test(file)
            ? { id: `${folder}/${file}`, folder, file, bytes: f.size, at: f.at }
            : null;
        })
        .filter((e): e is BackupEntry => e !== null)
        .sort(newestFirst),
    fetch: async (folder, file) => {
      checkName(folder, file);
      const local = await stagingFile(o.stagingDir);
      try {
        await getFile(`${NODE_PREFIX}/${folder}/${file}`, local);
      } catch (err) {
        await rm(local, { force: true });
        throw err;
      }
      return { path: local, done: () => rm(local, { force: true }) };
    },
    removeFolder: async (folder) => {
      checkName(folder);
      for (const f of await files())
        if (f.name.startsWith(`${NODE_PREFIX}/${folder}/`))
          await ask({ action: "remove", name: f.name }, `backup remove ${f.name}`);
    },
    close: async () => {},
  };
}
