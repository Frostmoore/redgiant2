/**
 * A disk for backups when RedGiant runs in a container (p3.7.2): the container cannot mount the
 * host's disks, so the host mounts it and passes a folder in. These are the steps the page shows,
 * filled in with what RedGiant knows (the disk's device, the container's id when it is known), to
 * copy into the host's shell: Proxmox (an LXC mount point), Docker (a bind in the compose file),
 * or any other host. A pure function, tested as a table; nothing a person typed reaches a line
 * unchecked.
 */

/** Where the host mounts disks for RedGiant. */
export const HOST_BACKUP_DIR = "/mnt/redgiant-backups";
/** Where the folders arrive inside RedGiant. */
export const CONTAINER_BACKUP_BASE = "/var/lib/redgiant/backups";

export type HostKind = "proxmox" | "docker" | "other";

export interface HostGuideInput {
  kind: HostKind;
  /** The folder's name: the disk's label, cleaned ("Tech"). */
  name: string;
  /** The disk's device on the host ("/dev/sdb1"); a placeholder when none was picked. */
  device?: string | undefined;
  /** The Proxmox container's id ("105"); a placeholder when not known. */
  containerId?: string | undefined;
  /** The first free mount point number in the container's configuration (0 when not known). */
  mp?: number | undefined;
  /** An unprivileged container (Proxmox's default): its root is 100000 on the host. */
  unprivileged?: boolean | undefined;
  /** Where the folder arrives inside RedGiant. */
  base?: string | undefined;
}

export type HostGuide =
  | {
      ok: true;
      /** Lines for the host's shell, in order ("#" lines explain). */
      lines: string[];
      /** The folder on the host that enters the container. */
      hostDir: string;
      /** Where it arrives inside RedGiant. */
      target: string;
      /** Something was not known and is a placeholder in the lines (`<id>`, `/dev/sdX1`). */
      placeholders: string[];
    }
  | { ok: false; why: "bad_name" | "bad_device" | "bad_id" | "bad_mp" };

/** A folder name: letters, digits, dot, dash, underscore, not starting with a dot or dash. */
export const HOST_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** A block device: `/dev/` and a kernel name, or one of udev's stable links. */
export const HOST_DEVICE =
  /^\/dev\/(?:[a-z]{1,8}[0-9a-z]{0,12}|mapper\/[A-Za-z0-9_.-]{1,64}|disk\/by-(?:uuid|id|label|partuuid)\/[A-Za-z0-9_.:+-]{1,120})$/;
/** A Proxmox guest id: 100 to 999999999. */
export const PROXMOX_ID = /^[1-9][0-9]{2,8}$/;

/** The id of the user RedGiant runs as in its container image (Debian's `node`). */
const IMAGE_UID = 1000;
/** Proxmox maps an unprivileged container's root to this id on the host. */
const LXC_ROOT = 100000;

export function hostMountGuide(i: HostGuideInput): HostGuide {
  if (!HOST_FOLDER_NAME.test(i.name) || i.name.includes(".."))
    return { ok: false, why: "bad_name" };
  if (i.device !== undefined && i.device !== "" && !HOST_DEVICE.test(i.device))
    return { ok: false, why: "bad_device" };
  if (i.containerId !== undefined && i.containerId !== "" && !PROXMOX_ID.test(i.containerId))
    return { ok: false, why: "bad_id" };
  const mp = i.mp ?? 0;
  if (!Number.isInteger(mp) || mp < 0 || mp > 255) return { ok: false, why: "bad_mp" };
  const placeholders: string[] = [];
  if (!i.device) placeholders.push("device");
  const device = i.device || "/dev/sdX1";
  const base = (i.base ?? CONTAINER_BACKUP_BASE).replace(/\/+$/, "");
  const disk = `${HOST_BACKUP_DIR}/${i.name}`;
  const hostDir = `${disk}/RedGiant`;
  const target = `${base}/${i.name}`;
  const lines = [
    "# 1. Mount the disk on the host, also after a restart (nofail: the host starts without it)",
    `mkdir -p ${disk}`,
    `mount ${device} ${disk}`,
    `echo "UUID=$(blkid -s UUID -o value ${device}) ${disk} auto defaults,nofail 0 2" >> /etc/fstab`,
    "# 2. RedGiant's own folder on it (the rest of the disk stays out of the container)",
    `mkdir -p ${hostDir}`,
  ];
  if (i.kind === "proxmox") {
    if (!i.containerId) placeholders.push("containerId");
    const id = i.containerId || "<id>";
    if (i.unprivileged !== false) lines.push(`chown ${LXC_ROOT}:${LXC_ROOT} ${hostDir}`);
    lines.push(
      "# 3. Pass it to the container (a mount point; restart the container if it does not appear)",
      `pct set ${id} -mp${mp} ${hostDir},mp=${target}`,
    );
  } else if (i.kind === "docker") {
    lines.push(
      `chown ${IMAGE_UID}:${IMAGE_UID} ${hostDir}`,
      "# 3. In compose.yaml, under the redgiant service, then: docker compose up -d",
      "    volumes:",
      `      - ${hostDir}:${target}`,
    );
  } else {
    lines.push(`# 3. Make ${hostDir} appear inside RedGiant at ${target} (a bind mount)`);
  }
  return { ok: true, lines, hostDir, target, placeholders };
}
