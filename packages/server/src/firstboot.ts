// The machine-side half of the first boot (G39.3): where the data lives and how much room it
// has, the removable disks for backups and how to mount one, a folder instead when no disk can
// be mounted here, what already reaches the machine from outside, and SSH. Root actions go
// through the OS helper (os-helper.ts) or udisks2; without either the page says so.
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { networkInterfaces, platform } from "node:os";
import { join, posix, win32 } from "node:path";
import type {
  BackupDestination,
  BackupPlace,
  BlockDisk,
  LocalHttps,
  MountMethod,
  NetDetected,
  OsUpdates,
  SshAccess,
  StorageInfo,
  WifiState,
} from "@redgiant/protocol";
import {
  BACKUP_MOUNT_BASE,
  backupCandidates,
  checkBackupDisk,
  parseUdisksMount,
} from "./backup-disks.js";
import { LSBLK_ARGS, parseLsblk, run, withFree } from "./discovery.js";
import { bareHost, LanHttpsStore } from "./lan-https.js";
import {
  hostName,
  lanEndpoint,
  localDnsServer,
  parseTailscaleStatus,
  proxiesRunning,
  proxyInFront,
  reachedAs,
} from "./net-detect.js";
import { HelperError, type OsHelper } from "./os-helper.js";
import { lanAddresses } from "./setup-code.js";
import { parseWifi, wifiUnavailable } from "./wifi.js";

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
  /** Tests: this process's mount table (/proc/self/mountinfo) and where backups are mounted. */
  mountinfo?: () => Promise<string>;
  backupBase?: string;
}

/** The mount points in /proc/self/mountinfo (field 5, with its octal escapes undone). */
export function mountPoints(mountinfo: string): string[] {
  return mountinfo
    .split("\n")
    .map((l) => l.split(" ")[4] ?? "")
    .filter(Boolean)
    .map((m) => m.replace(/\\([0-7]{3})/g, (_x, o: string) => String.fromCharCode(parseInt(o, 8))));
}

/**
 * The folders mounted right under the backups' base (Proxmox's mount points in a container, a
 * share the person mounted there), not those of the disks RedGiant mounts itself (`disks`).
 */
export function backupPlaces(mounts: readonly string[], base: string, disks: readonly string[]) {
  const seen = new Set(disks);
  return [...new Set(mounts)]
    .filter((m) => posix.dirname(m) === base && !seen.has(m))
    .sort()
    .map((path) => ({ path, name: posix.basename(path) }));
}

export class FirstBoot {
  /** HTTPS in the local network: the person's choice, read by every request (lan-https.ts). */
  readonly lan: LanHttpsStore;
  private caCache: { at: number; pem: string | null } | undefined;

  constructor(private readonly o: FirstBootOptions) {
    this.lan = new LanHttpsStore(o.dataDir);
    void this.lan.load();
  }

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

  /** The container RedGiant OS runs in, as the helper said at its last list (null: none). */
  private container: string | null = null;

  private get base(): string {
    return this.o.backupBase ?? BACKUP_MOUNT_BASE;
  }

  /** The disks: the helper's (the host's), else lsblk here. null when nothing can be read. */
  async disks(): Promise<BlockDisk[] | null> {
    if (this.o.helper) {
      const r = await this.o.helper.call({ op: "list" }).catch(() => null);
      this.container =
        typeof r?.container === "string" && r.container !== "none" ? r.container : null;
      if (r && r.lsblk) return parseLsblk(JSON.stringify(r.lsblk));
    }
    if ((this.o.platform ?? platform()) !== "linux") return null;
    const out = await this.exec("lsblk", LSBLK_ARGS);
    return out === null ? null : withFree(parseLsblk(out));
  }

  async storage(): Promise<StorageInfo> {
    const s = await statfs(this.o.dataDir).catch(() => null);
    const all = (await this.disks()) ?? [];
    const candidates = backupCandidates(all, this.dataDirs);
    // In a container the disks are the host's: lsblk sees them, but they have no filesystem it
    // can read and no device to mount (the «Tech, not formatted» of the 3.7.1 test). Never offered.
    const container = this.container;
    return {
      dataDir: this.o.hostDataDir ?? this.o.dataDir,
      dataFreeGb: s ? round((s.bavail * s.bsize) / GB) : null,
      dataTotalGb: s ? round((s.blocks * s.bsize) / GB) : null,
      method: container ? "none" : await this.method(),
      candidates: container ? [] : candidates,
      container,
      hostDisks: container ? candidates.length : 0,
      places: await this.places(all),
    };
  }

  /** The folders mounted under the backups' base, each with its room and whether it can be used. */
  async places(all?: readonly BlockDisk[]): Promise<BackupPlace[]> {
    const info = await (
      this.o.mountinfo ?? (() => readFile("/proc/self/mountinfo", "utf8"))
    )().catch(() => "");
    const disks = (all ?? []).map((d) => d.mountpoint).filter(Boolean);
    return Promise.all(
      backupPlaces(mountPoints(info), this.base, disks).map(async ({ path, name }) => {
        const s = await statfs(path).catch(() => null);
        const writable = await access(path, constants.W_OK).then(
          () => true,
          () => false,
        );
        const usable = writable || this.o.helper !== undefined;
        return {
          name,
          path,
          freeGb: s ? round((s.bavail * s.bsize) / GB) : null,
          totalGb: s ? round((s.blocks * s.bsize) / GB) : null,
          usable,
          ...(!usable && { why: "not_writable" as const }),
        };
      }),
    );
  }

  /**
   * A folder the host mounted under the backups' base, picked by the person: used as it is when
   * RedGiant writes there, else the OS helper makes RedGiant's own folder in it.
   */
  async usePlace(path: string): Promise<BackupDestination & { kind: "folder" }> {
    const place = (await this.places()).find((p) => p.path === path);
    if (!place) throw new FirstBootError("not_found", "That folder is not mounted");
    try {
      await this.writable(place.path);
      return { kind: "folder", path: place.path };
    } catch (err) {
      if (!this.o.helper) throw err;
    }
    await this.o.helper.call({ op: "place-prepare", name: place.name }).catch((err: unknown) => {
      throw new FirstBootError(err instanceof HelperError ? err.code : "not_writable");
    });
    // The helper's folder, as this process sees it (the same path inside RedGiant's container).
    const dir = posix.join(place.path, "RedGiant");
    await this.writable(dir);
    return { kind: "folder", path: dir };
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
    // A folder the host mounts (a Proxmox mount point): when it is not mounted now, writing there
    // would fill the system's disk instead.
    if (dest.kind === "folder" && dest.path.startsWith(`${this.base}/`)) {
      const place = posix.join(
        this.base,
        dest.path.slice(this.base.length + 1).split("/")[0] ?? "",
      );
      const info = await (
        this.o.mountinfo ?? (() => readFile("/proc/self/mountinfo", "utf8"))
      )().catch(() => null);
      if (info !== null && !mountPoints(info).includes(place))
        throw new FirstBootError("place_missing", `${place} is not mounted`);
    }
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

  /**
   * What already reaches the machine (the page's request says if a proxy is in front, and with
   * its connection whether RedGiant is reached already, G39.8).
   */
  async net(
    header: (name: string) => string | undefined,
    conn: { remote?: string | undefined; localPort?: number | undefined } = {},
  ): Promise<NetDetected> {
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
      reachedAs: reachedAs(header, conn.remote),
      lan: lanEndpoint(header("host"), lanAddresses(networkInterfaces()), conn.localPort),
    };
  }

  /**
   * SSH: its real state, or why it cannot be read here (p3.7.2: the page said nothing useful
   * when the helper failed). A container (LXC) runs its own sshd, so SSH works there too.
   */
  async ssh(): Promise<SshAccess> {
    if (!this.o.helper) return { available: false, why: "no_helper" };
    let r: Record<string, unknown>;
    try {
      r = await this.o.helper.call({ op: "ssh-status" });
    } catch (err) {
      return { available: false, why: err instanceof HelperError ? err.code : "failed" };
    }
    const container =
      typeof r.container === "string" && r.container !== "none" ? r.container : null;
    if (r.installed === false) return { available: false, why: "not_installed", container };
    return {
      available: true,
      on: r.on === true,
      keys: typeof r.keys === "number" ? r.keys : 0,
      container,
    };
  }

  /** Wi-Fi: the networks in reach and the one in use (a scan first when asked). */
  async wifi(scan = false): Promise<WifiState> {
    if (!this.o.helper) return { available: false, why: "no_helper" };
    try {
      return parseWifi(await this.o.helper.call({ op: scan ? "wifi-scan" : "wifi-status" }));
    } catch (err) {
      return wifiUnavailable(err instanceof HelperError ? err.code : "failed");
    }
  }

  /** Joins a network; the password goes to the helper only (never logged, never kept here). */
  async wifiConnect(
    ssid: string,
    password: string,
    hidden = false,
  ): Promise<{ state: "connected" | "saved"; wifi: WifiState }> {
    const r = await ask(
      this.o.helper,
      { op: "wifi-connect", ssid, password, ...(hidden && { hidden }) },
      "cannot_wifi",
    );
    return { state: r.state === "saved" ? "saved" : "connected", wifi: await this.wifi() };
  }

  async wifiForget(ssid: string): Promise<WifiState> {
    await ask(this.o.helper, { op: "wifi-forget", ssid }, "cannot_wifi");
    return this.wifi();
  }

  /** HTTPS in the local network, as this request sees it. */
  async https(header: (name: string) => string | undefined): Promise<LocalHttps> {
    if (!this.o.helper) return { available: false };
    const r = await this.o.helper.call({ op: "https-status" }).catch(() => null);
    if (!r) return { available: false };
    const pem = typeof r.ca === "string" ? Buffer.from(r.ca, "base64").toString("utf8") : null;
    this.caCache = { at: Date.now(), pem };
    const host = bareHost(header("host"));
    const inFront = proxyInFront(header) ?? (host.endsWith(".ts.net") ? "tailscale" : null);
    const s = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      available: true,
      on: r.on === true,
      ca: pem,
      fingerprint: s(r.fingerprint),
      until: s(r.until),
      names: Array.isArray(r.names)
        ? r.names.filter((n): n is string => typeof n === "string")
        : [],
      redirect: this.lan.settings.redirect,
      viaLocal: header("x-redgiant-local-tls") === "1",
      inFront,
    };
  }

  /**
   * Local HTTPS on or off (Caddy), and the redirect to it. The redirect is turned on only when
   * the page has just reached https with this machine's certificate trusted (`trusted`), and
   * only while HTTPS is on: nobody is locked out of their own machine.
   */
  async setHttps(
    b: {
      local?: boolean | undefined;
      redirect?: boolean | undefined;
      trusted?: boolean | undefined;
    },
    header: (name: string) => string | undefined,
  ): Promise<LocalHttps> {
    if (b.local !== undefined) {
      await ask(this.o.helper, { op: "https-local", on: b.local }, "cannot_https");
      if (!b.local && this.lan.settings.redirect) await this.lan.save({ redirect: false });
    }
    if (b.redirect === true) {
      const now = await this.https(header);
      if (!now.available || !now.on) throw new FirstBootError("https_off");
      if (b.trusted !== true) throw new FirstBootError("not_trusted");
      await this.lan.save({ redirect: true, trustedAt: new Date().toISOString() });
    } else if (b.redirect === false) await this.lan.save({ redirect: false });
    return this.https(header);
  }

  /** The CA's certificate (public), for the download link; asked of the helper once a minute at most. */
  async caCertificate(): Promise<string | null> {
    if (this.caCache && Date.now() - this.caCache.at < 60_000) return this.caCache.pem;
    if (!this.o.helper) return null;
    const r = await this.o.helper.call({ op: "https-status" }).catch(() => null);
    const pem = typeof r?.ca === "string" ? Buffer.from(r.ca, "base64").toString("utf8") : null;
    this.caCache = { at: Date.now(), pem };
    return pem;
  }

  /** RedGiant OS's updates: RedGiant's signed stack and Debian's security updates. */
  async osUpdates(check = false): Promise<OsUpdates> {
    if (!this.o.helper) return { available: false, update: null, running: false, security: null };
    const r = await ask(
      this.o.helper,
      { op: check ? "os-update-check" : "os-update-status" },
      "cannot_update",
    );
    return parseOsUpdates(r);
  }

  /** Restarts the machine (the person said yes in the page): in five seconds. */
  async reboot(): Promise<{ in: number }> {
    const r = await ask(this.o.helper, { op: "reboot" }, "cannot_reboot");
    return { in: typeof r.in === "number" ? r.in : 5 };
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

const UPDATE_STATES = new Set([
  "latest",
  "available",
  "applying",
  "error",
  "breaking",
  "unsigned",
  "unreachable",
]);
const GATES = new Set(["none", "normal", "mandatory", "breaking"]);

/** The helper's os-update-status reply, checked field by field. */
export function parseOsUpdates(r: Record<string, unknown>): OsUpdates {
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const u = r.update && typeof r.update === "object" ? (r.update as Record<string, unknown>) : null;
  const sec =
    r.security && typeof r.security === "object" ? (r.security as Record<string, unknown>) : null;
  return {
    available: true,
    update: u
      ? {
          state: (UPDATE_STATES.has(String(u.state)) ? u.state : "error") as NonNullable<
            OsUpdates["update"]
          >["state"],
          installed: s(u.installed),
          latest: s(u.latest),
          gate: (GATES.has(String(u.gate)) ? u.gate : "none") as NonNullable<
            OsUpdates["update"]
          >["gate"],
          note: s(u.note),
          step: s(u.step),
          checkedAt: s(u.checkedAt),
        }
      : null,
    running: r.running === true,
    security: sec
      ? {
          lastRun:
            typeof sec.lastRun === "number" && sec.lastRun > 0
              ? new Date(sec.lastRun * 1000).toISOString()
              : null,
          result: s(sec.result),
          upgraded: typeof sec.upgraded === "number" ? sec.upgraded : null,
          rebootRequired: sec.rebootRequired === true,
          packages: Array.isArray(sec.packages)
            ? sec.packages.filter((p): p is string => typeof p === "string").slice(0, 50)
            : [],
        }
      : null,
  };
}

async function ask(
  helper: OsHelper | undefined,
  op: Parameters<OsHelper["call"]>[0],
  missing: string,
): Promise<Record<string, unknown>> {
  if (!helper) throw new FirstBootError(missing, "Not managed by this installation");
  try {
    return await helper.call(op);
  } catch (err) {
    throw new FirstBootError(err instanceof HelperError ? err.code : "failed");
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
