// Backups on a removable disk (G39.3): which disks may take them and where they are mounted.
// The rules are one pure function (`checkBackupDisk`, tested as a table): only a disk that can be
// unplugged (USB, card readers, hot-plug bays), never one holding the system or RedGiant's own
// data, only filesystems Linux writes safely, mounted under /var/lib/redgiant/backups/<label>.
// The privileged helper (helpers/redgiant-helper) checks the same rules again on its side.
import { posix } from "node:path";
import type { BlockDisk, StorageInfo } from "@redgiant/protocol";

export const BACKUP_MOUNT_BASE = "/var/lib/redgiant/backups";

/** Filesystems a backup may be written to (no swap, LVM or encrypted containers, no ISO). */
export const BACKUP_FSTYPES = [
  "ext4",
  "ext3",
  "ext2",
  "xfs",
  "btrfs",
  "f2fs",
  "exfat",
  "vfat",
  "ntfs",
  "ntfs3",
] as const;

/** Mount points that make a disk a system disk. */
const SYSTEM = new Set([
  "/",
  "/boot",
  "/usr",
  "/var",
  "/home",
  "/etc",
  "/opt",
  "/srv",
  "/root",
  "/tmp",
  "/var/lib",
  "/var/log",
  "[SWAP]",
]);

/** Where a disk the person mounted elsewhere may already be (a desktop's automount). */
const USER_PLACES = ["/media/", "/run/media/", "/mnt/", `${BACKUP_MOUNT_BASE}/`];

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** A mount point that belongs to the system or holds RedGiant's data. */
export function isSystemMount(mountpoint: string, dataDirs: readonly string[]): boolean {
  if (!mountpoint) return false;
  if (SYSTEM.has(mountpoint) || under(mountpoint, "/boot")) return true;
  if (dataDirs.some((d) => d && (under(d, mountpoint) || under(mountpoint, d)))) return true;
  // Mounted somewhere else than the places for removable disks: treated as the system's.
  return !USER_PLACES.some((p) => mountpoint.startsWith(p));
}

/** A name for the mount folder: letters, digits, dot, dash, underscore; else from the UUID. */
export function safeLabel(label: string, uuid: string): string {
  const clean = label
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 40);
  if (clean && clean !== "." && clean !== "..") return clean;
  const id = uuid.replace(/[^A-Fa-f0-9]/g, "").slice(0, 8);
  return id ? `disk-${id.toLowerCase()}` : "disk";
}

export type DiskRefusal =
  | "not_removable"
  | "system_disk"
  | "no_filesystem"
  | "unsupported_filesystem"
  | "no_uuid"
  | "not_a_disk";

export type DiskCheck = { ok: true; target: string } | { ok: false; why: DiskRefusal };

/**
 * May this filesystem take RedGiant's backups? `all` is every disk and partition (to see what
 * else lives on the same disk), `dataDirs` RedGiant's data folder as this process and the host
 * see it. The target is where it is (a disk already mounted in a place for removable disks) or
 * where it will be mounted.
 */
export function checkBackupDisk(
  d: BlockDisk,
  all: readonly BlockDisk[],
  dataDirs: readonly string[],
  base = BACKUP_MOUNT_BASE,
): DiskCheck {
  if (d.type === "other") return { ok: false, why: "not_a_disk" };
  if (!(d.removable || d.hotplug || d.transport === "usb"))
    return { ok: false, why: "not_removable" };
  const sameDisk = all.filter((x) => x.disk === d.disk);
  if ([d, ...sameDisk].some((x) => isSystemMount(x.mountpoint, dataDirs)))
    return { ok: false, why: "system_disk" };
  if (!d.fstype) return { ok: false, why: "no_filesystem" };
  if (!(BACKUP_FSTYPES as readonly string[]).includes(d.fstype))
    return { ok: false, why: "unsupported_filesystem" };
  if (!/^[A-Fa-f0-9-]{4,36}$/.test(d.uuid)) return { ok: false, why: "no_uuid" };
  const target = d.mountpoint || posix.join(base, safeLabel(d.label, d.uuid));
  return { ok: true, target };
}

/**
 * The removable disks offered for backups: their filesystems (a whole disk without partitions
 * counts as one), each usable or with the reason it is not. System disks are never listed.
 */
export function backupCandidates(
  all: readonly BlockDisk[],
  dataDirs: readonly string[],
): StorageInfo["candidates"] {
  const parents = new Set(all.filter((x) => x.type === "part").map((x) => x.disk));
  return all
    .filter((d) => d.type === "part" || (d.type === "disk" && !parents.has(d.name)))
    .filter((d) => d.removable || d.hotplug || d.transport === "usb")
    .map((d) => {
      const c = checkBackupDisk(d, all, dataDirs);
      return c.ok ? { ...d, usable: true, target: c.target } : { ...d, usable: false, why: c.why };
    })
    .filter((d) => !("why" in d) || d.why !== "system_disk");
}

/** "Mounted /dev/sdb1 at /media/root/Eternatus" (udisksctl), the folder; null when not said. */
export function parseUdisksMount(out: string): string | null {
  const m = /Mounted \S+ at (\/.+?)\.?\s*$/m.exec(out.trim());
  return m?.[1] ?? null;
}
