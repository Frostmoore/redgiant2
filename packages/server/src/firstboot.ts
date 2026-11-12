// The machine-side half of the first boot (G39.3): where the data lives and how much room it
// has, the removable disks for backups and how to mount one, a folder instead when no disk can
// be mounted here, what already reaches the machine from outside, and SSH. Root actions go
// through the OS helper (os-helper.ts) or udisks2; without either the page says so.
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, posix, win32 } from "node:path";
import type {
  BackupDestination,
  BlockDisk,
  MountMethod,
  NetDetected,
  SshAccess,
  StorageInfo,
} from "@redgiant/protocol";
import { backupCandidates, checkBackupDisk, parseUdisksMount } from "./backup-disks.js";
import { LSBLK_ARGS, parseLsblk, run, withFree } from "./discovery.js";
import {
  hostName,
  localDnsServer,
  parseTailscaleStatus,
  proxiesRunning,
  proxyInFront,
} from "./net-detect.js";
import { HelperError, type OsHelper } from "./os-helper.js";

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

/** Folders a backup folder may never be in (the system's own), on Linux and macOS. */
const SYSTEM_DIRS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/System",
  "/Library",
];
/** The same on Windows (any drive's root is refused too). */
const WINDOWS_DIRS = ["\\windows", "\\program files", "\\program files (x86)", "\\programdata"];

/**
 * Why a folder cannot take backups, or null when it can (still to be checked as writable): it
 * must be a full path, not a system folder, and not inside the data folder (a backup there is
 * lost with the data).
 */
export function folderRefusal(
  path: string,
  dataDir: string,
  os: NodeJS.Platform = platform(),
): "not_absolute" | "system" | "data" | null {
  if (path.includes("\0")) return "not_absolute";
  if (os === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(path)) return "not_absolute";
    const p = win32
      .normalize(path)
      .replace(/[\\]+$/, "")
      .toLowerCase();
    const rest = p.slice(2);
    if (!rest || WINDOWS_DIRS.some((d) => rest === d || rest.startsWith(`${d}\\`))) return "system";
    const d = win32
      .normalize(dataDir)
      .replace(/[\\]+$/, "")
      .toLowerCase();
    return p === d || p.startsWith(`${d}\\`) ? "data" : null;
  }
  if (!posix.isAbsolute(path)) return "not_absolute";
  const p = posix.normalize(path).replace(/\/+$/, "") || "/";
  if (p === "/" || SYSTEM_DIRS.some((d) => p === d || p.startsWith(`${d}/`))) return "system";
  const d = posix.normalize(dataDir).replace(/\/+$/, "");
  return p === d || p.startsWith(`${d}/`) ? "data" : null;
}

export class FirstBootError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

export interface FirstBootOptions {
  dataDir: string;
  /** The data folder as the host sees it (RedGiant in a container). */
  hostDataDir?: string | undefined;
  helper?: OsHelper | undefined;
  /** Tests: another system and other programs. */
  platform?: NodeJS.Platform;
  run?: typeof run;
  exists?: (path: string) => Promise<boolean>;
}

export class FirstBoot {
  constructor(private readonly o: FirstBootOptions) {}

  private get exec() {
    return this.o.run ?? run;
  }

  private get dataDirs(): string[] {
    return [this.o.dataDir, this.o.hostDataDir ?? ""].filter(Boolean);
  }

  /** How a disk can be mounted here: the helper, udisks2, or not at all. */
  async method(): Promise<MountMethod> {
    if (this.o.helper) return "helper";
    if ((this.o.platform ?? platform()) !== "linux") return "none";
    const has =
      this.o.exists ??
      ((p: string) =>
        access(p, constants.F_OK).then(
          () => true,
          () => false,
        ));
    if (!(await has("/run/dbus/system_bus_socket"))) return "none";
    return (await this.exec("udisksctl", ["help"], true)) !== null ? "udisks" : "none";
  }

  /** The disks: the helper's (the host's), else lsblk here. null when nothing can be read. */
  async disks(): Promise<BlockDisk[] | null> {
    if (this.o.helper) {
      const r = await this.o.helper.call({ op: "list" }).catch(() => null);
      if (r && r.lsblk) return parseLsblk(JSON.stringify(r.lsblk));
    }
    if ((this.o.platform ?? platform()) !== "linux") return null;
    const out = await this.exec("lsblk", LSBLK_ARGS);
    return out === null ? null : withFree(parseLsblk(out));
  }

  async storage(): Promise<StorageInfo> {
    const s = await statfs(this.o.dataDir).catch(() => null);
    const all = (await this.disks()) ?? [];
    return {
      dataDir: this.o.hostDataDir ?? this.o.dataDir,
      dataFreeGb: s ? round((s.bavail * s.bsize) / GB) : null,
      dataTotalGb: s ? round((s.blocks * s.bsize) / GB) : null,
      method: await this.method(),
      candidates: backupCandidates(all, this.dataDirs),
    };
  }

  /**
   * Mounts the disk the person picked (by its filesystem's UUID) for backups, after the same
   * checks the helper makes again. Already mounted in a place for removable disks: used there.
   */
  async mountDisk(uuid: string): Promise<BackupDestination & { kind: "disk" }> {
    const all = (await this.disks()) ?? [];
    const d = all.find((x) => x.uuid === uuid);
    if (!d) throw new FirstBootError("not_found", "That disk is not connected");
    const c = checkBackupDisk(d, all, this.dataDirs);
    if (!c.ok) throw new FirstBootError(c.why);
    const label = c.target.split("/").at(-1) ?? "disk";
    if (d.mountpoint) return { kind: "disk", uuid, label, path: d.mountpoint };
    const method = await this.method();
    if (method === "helper" && this.o.helper) {
      const r = await this.o.helper.call({ op: "mount", uuid, label }).catch((err: unknown) => {
        throw new FirstBootError(err instanceof HelperError ? err.code : "mount_failed");
      });
      const path = typeof r.path === "string" ? r.path : c.target;
      return { kind: "disk", uuid, label, path };
    }
    if (method === "udisks") {
      const out = await this.exec("udisksctl", ["mount", "-b", d.path, "--no-user-interaction"]);
      const path = out && parseUdisksMount(out);
      if (!path) throw new FirstBootError("mount_failed");
      return { kind: "disk", uuid, label, path };
    }
    throw new FirstBootError("cannot_mount", "Disks cannot be mounted in this installation");
  }

  /**
   * The destination's folder for a backup now: a disk is mounted again when it is connected but
   * not mounted (after a restart); a disk that is not there is an error, never another place.
   */
  async prepare(dest: BackupDestination): Promise<string> {
    let dir = dest.path;
    if (dest.kind === "disk") {
      const all = await this.disks();
      const d = all?.find((x) => x.uuid === dest.uuid);
      if (all && !d)
        throw new FirstBootError("disk_missing", `The disk ${dest.label} is not connected`);
      if (d && !d.mountpoint) dir = (await this.mountDisk(dest.uuid)).path;
      else if (d?.mountpoint) dir = d.mountpoint;
    }
    const target = dest.kind === "disk" ? join(dir, "RedGiant") : dir;
    await this.writable(target);
    return target;
  }

  /** A folder for backups: allowed, created, and written to once. */
  async checkFolder(path: string): Promise<BackupDestination & { kind: "folder" }> {
    // The folder is a real one of the machine RedGiant runs on: its own system's rules.
    const why = folderRefusal(path, this.o.dataDir);
    if (why) throw new FirstBootError(`folder_${why}`);
    const p =
      platform() === "win32" ? win32.normalize(path) : posix.normalize(path).replace(/\/+$/, "");
    await this.writable(p);
    return { kind: "folder", path: p };
  }

  private async writable(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.redgiant-write-${process.pid}`);
      await writeFile(probe, "ok");
      await rm(probe, { force: true });
    } catch (err) {
      throw new FirstBootError("not_writable", `Cannot write in ${dir}: ${(err as Error).message}`);
    }
  }

  /** What already reaches the machine (the page's request says if a proxy is in front). */
  async net(header: (name: string) => string | undefined): Promise<NetDetected> {
    let tailscale: NetDetected["tailscale"] = { state: "absent" };
    if (this.o.helper) {
      const r = await this.o.helper
        .call({ op: "tailscale" })
        .catch((err: unknown) =>
          err instanceof HelperError && err.code === "stopped" ? ("stopped" as const) : null,
        );
      if (r === "stopped") tailscale = { state: "stopped" };
      else if (r?.status) tailscale = parseTailscaleStatus(JSON.stringify(r.status));
    } else {
      const out = await this.exec("tailscale", ["status", "--json"], true);
      if (out !== null) tailscale = parseTailscaleStatus(out);
    }
    const linux = (this.o.platform ?? platform()) === "linux";
    const comms = linux ? await processNames() : [];
    const resolv = linux ? await readFile("/etc/resolv.conf", "utf8").catch(() => "") : "";
    return {
      tailscale,
      proxyInFront: proxyInFront(header),
      proxiesRunning: proxiesRunning(comms),
      localDns: localDnsServer(resolv),
      hostName: hostName(header("host")),
    };
  }

  async ssh(): Promise<SshAccess> {
    if (!this.o.helper) return { available: false };
    const r = await this.o.helper.call({ op: "ssh-status" }).catch(() => null);
    if (!r) return { available: false };
    return { available: true, on: r.on === true, keys: typeof r.keys === "number" ? r.keys : 0 };
  }

  /** SSH on with one more public key (keys only), or off. */
  async setSsh(on: boolean, key?: string): Promise<SshAccess> {
    if (!this.o.helper)
      throw new FirstBootError("cannot_ssh", "SSH is not managed by this installation");
    try {
      if (on) {
        if (!key) throw new FirstBootError("bad_key");
        await this.o.helper.call({ op: "ssh-on", key });
      } else await this.o.helper.call({ op: "ssh-off" });
    } catch (err) {
      if (err instanceof FirstBootError) throw err;
      throw new FirstBootError(err instanceof HelperError ? err.code : "ssh_failed");
    }
    return this.ssh();
  }
}

/** The names of the programs running (Linux, as far as this process sees them). */
async function processNames(): Promise<string[]> {
  const pids = (await readdir("/proc").catch(() => [] as string[])).filter((p) => /^\d+$/.test(p));
  const names = await Promise.all(
    pids.slice(0, 2000).map((p) => readFile(`/proc/${p}/comm`, "utf8").catch(() => "")),
  );
  return names.filter(Boolean);
}
