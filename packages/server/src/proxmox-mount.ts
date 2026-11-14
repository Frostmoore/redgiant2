// «Fallo tu» (p3.7.2): RedGiant OS in a Proxmox container cannot mount the host's disks, but when
// the Proxmox host is one of the person's SSH machines (G38.2, recognised by `pveversion`),
// RedGiant can run the steps there itself, with the person's explicit yes: mount the disk on the
// host (and in its fstab, `nofail`), make RedGiant's own folder on it, and pass that folder to the
// container as a mount point. The commands come from one pure function (`proxmoxPlan`, tested as
// a table) with every argument checked and quoted; a disk is never formatted unless it has no
// filesystem at all and the person typed its name as a second confirmation.
import {
  type BlockDisk,
  CONTAINER_BACKUP_BASE,
  HOST_BACKUP_DIR,
  HOST_DEVICE,
  HOST_FOLDER_NAME,
  type MachineView,
  PROXMOX_ID,
} from "@redgiant/protocol";
import { BACKUP_FSTYPES, isSystemMount } from "./backup-disks.js";
import { LSBLK_ARGS, parseLsblk } from "./discovery.js";
import {
  execRemote,
  isWindowsPath,
  type Machines,
  type SshClient,
  shellQuote,
} from "./machines.js";

export interface PlanStep {
  /** The program and its arguments, sent quoted (never through a shell made of their text). */
  argv: string[];
  /** What it does, for the person's request. */
  what: string;
}

export interface ProxmoxPlanInput {
  /** The container's id on the host. */
  ctid: string;
  /** The disk's device on the host ("/dev/sdb1"). */
  device: string;
  /** The folder's name ("Tech"). */
  name: string;
  /** The mount point's number (the first free one in `pct config`). */
  mp: number;
  unprivileged: boolean;
  /** The filesystem the host sees on it ("" when none). */
  fstype: string;
  /** Where the host has it mounted now ("" when nowhere). */
  mountedAt: string;
  /** Format it first (ext4): only for a disk with no filesystem, after the person typed its name. */
  format?: boolean;
  base?: string;
  /** The host's fstab (tests: a file of theirs). */
  fstab?: string;
}

export type PlanRefusal =
  | "bad_name"
  | "bad_device"
  | "bad_id"
  | "bad_mp"
  | "needs_format"
  | "has_filesystem"
  | "unsupported_filesystem"
  | "system_disk";

export type ProxmoxPlan =
  | { ok: true; steps: PlanStep[]; hostDir: string; target: string }
  | { ok: false; why: PlanRefusal };

/** Proxmox maps an unprivileged container's root to this id on the host. */
const LXC_ROOT = "100000";
/** Filesystems without Unix owners: the owner is a mount option. */
const NO_OWNERS = new Set(["vfat", "exfat", "ntfs", "ntfs3"]);

/**
 * Adds the disk to /etc/fstab by its UUID once (the values come as arguments, never inside the
 * script's text): `nofail`, so the host starts also without it.
 */
export const FSTAB_SCRIPT =
  'u=$(blkid -s UUID -o value "$1") && [ -n "$u" ] && { grep -qs "^UUID=$u " "$4" || printf \'UUID=%s %s auto %s,nofail 0 2\\n\' "$u" "$2" "$3" >> "$4"; }';

export function proxmoxPlan(i: ProxmoxPlanInput): ProxmoxPlan {
  if (!HOST_FOLDER_NAME.test(i.name) || i.name.includes(".."))
    return { ok: false, why: "bad_name" };
  if (!HOST_DEVICE.test(i.device)) return { ok: false, why: "bad_device" };
  if (!PROXMOX_ID.test(i.ctid)) return { ok: false, why: "bad_id" };
  if (!Number.isInteger(i.mp) || i.mp < 0 || i.mp > 255) return { ok: false, why: "bad_mp" };
  if (i.mountedAt && isSystemMount(i.mountedAt, [])) return { ok: false, why: "system_disk" };
  if (i.format && i.fstype) return { ok: false, why: "has_filesystem" };
  if (!i.format && !i.fstype) return { ok: false, why: "needs_format" };
  const fstype = i.format ? "ext4" : i.fstype;
  if (!(BACKUP_FSTYPES as readonly string[]).includes(fstype))
    return { ok: false, why: "unsupported_filesystem" };
  const base = (i.base ?? CONTAINER_BACKUP_BASE).replace(/\/+$/, "");
  const disk = i.mountedAt || `${HOST_BACKUP_DIR}/${i.name}`;
  const hostDir = `${disk}/RedGiant`;
  const target = `${base}/${i.name}`;
  const owners = i.unprivileged && NO_OWNERS.has(fstype);
  const opts = owners ? `uid=${LXC_ROOT},gid=${LXC_ROOT},umask=0022` : "defaults";
  const steps: PlanStep[] = [];
  if (i.format)
    steps.push({
      argv: ["mkfs.ext4", "-F", "-L", i.name, i.device],
      what: `FORMAT ${i.device} as ext4 named ${i.name}: everything on it is erased`,
    });
  if (!i.mountedAt)
    steps.push(
      { argv: ["mkdir", "-p", disk], what: `Make ${disk} on the host` },
      {
        argv: ["mount", ...(owners ? ["-o", opts] : []), i.device, disk],
        what: `Mount ${i.device} at ${disk}`,
      },
      {
        argv: ["sh", "-c", FSTAB_SCRIPT, "sh", i.device, disk, opts, i.fstab ?? "/etc/fstab"],
        what: `Mount it again at every start of the host (/etc/fstab, nofail)`,
      },
    );
  steps.push({ argv: ["mkdir", "-p", hostDir], what: `Make RedGiant's folder ${hostDir}` });
  if (i.unprivileged && !owners)
    steps.push({
      argv: ["chown", `${LXC_ROOT}:${LXC_ROOT}`, hostDir],
      what: "Give it to the container's root (an unprivileged container)",
    });
  steps.push({
    argv: ["pct", "set", i.ctid, `-mp${i.mp}`, `${hostDir},mp=${target}`],
    what: `Pass it to container ${i.ctid} at ${target}`,
  });
  return { ok: true, steps, hostDir, target };
}

/** `pveversion`'s answer on a Proxmox host ("pve-manager/8.2.4/…"); null elsewhere. */
export function proxmoxVersion(out: string): string | null {
  const m = /^pve-manager\/(\d[\w.-]*)/m.exec(out);
  return m?.[1] ?? null;
}

/** `pct list`: the containers with their id, state and name. */
export function parsePctList(out: string): { id: string; status: string; name: string }[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && PROXMOX_ID.test(f[0] ?? ""))
    .map((f) => ({ id: f[0] as string, status: f[1] as string, name: f.at(-1) as string }));
}

/** `pct config <id>`: unprivileged or not, the mount points used and where they arrive. */
export function parsePctConfig(out: string): {
  unprivileged: boolean;
  used: number[];
  targets: string[];
  hostname: string | null;
} {
  const used: number[] = [];
  const targets: string[] = [];
  let unprivileged = false;
  let hostname: string | null = null;
  for (const line of out.split("\n")) {
    const m = /^(mp(\d+)|rootfs|unprivileged|hostname):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "unprivileged") unprivileged = m[3]?.trim() === "1";
    else if (m[1] === "hostname") hostname = m[3]?.trim() || null;
    else if (m[2] !== undefined) {
      used.push(Number(m[2]));
      const t = /(?:^|,)mp=([^,]+)/.exec(m[3] ?? "");
      if (t?.[1]) targets.push(t[1]);
    }
  }
  return { unprivileged, used, targets, hostname };
}

export const firstFreeMp = (used: readonly number[]): number => {
  for (let i = 0; i < 256; i++) if (!used.includes(i)) return i;
  return -1;
};

/**
 * Which container this RedGiant is, among the host's: the one whose name is this machine's
 * hostname (Proxmox names the container's hostname after it); null when none or several.
 */
export function guessContainer(
  list: readonly { id: string; name: string }[],
  hostname: string,
): string | null {
  const h = hostname.trim().toLowerCase().split(".")[0] ?? "";
  const hits = list.filter((c) => c.name.toLowerCase() === h);
  return hits.length === 1 ? (hits[0]?.id ?? null) : null;
}

// ---------------------------------------------------------------- on the host, over SSH

/** A command line for the host's shell: every argument in single quotes. */
export const lineOf = (argv: readonly string[]): string => argv.map(shellQuote).join(" ");

/** What the page shows about one of the person's machines that may be the Proxmox host. */
export interface HostProbe {
  machineId: string;
  name: string;
  /** Proxmox's version there, null when it is not a Proxmox host. */
  proxmox: string | null;
  containers: { id: string; status: string; name: string }[];
  /** This RedGiant's container among them (by its hostname), when clear. */
  guess: string | null;
  /** The host's removable disks, each usable or why not (the host sees their filesystems). */
  disks: (BlockDisk & { usable: boolean; why?: string; title: string })[];
  error?: string;
}

/** Runs one short command there and gives its output (exit code 0), or null. */
async function out(client: SshClient, argv: readonly string[]): Promise<string | null> {
  const r = await execRemote(client, lineOf(argv), { timeoutMs: 30_000 }).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout : null;
}

/** The host's removable disks as backups may use them (formatting is offered apart). */
export function hostCandidates(all: readonly BlockDisk[]): HostProbe["disks"] {
  const parents = new Set(all.filter((x) => x.type === "part").map((x) => x.disk));
  return all
    .filter((d) => d.type === "part" || (d.type === "disk" && !parents.has(d.name)))
    .filter((d) => d.removable || d.hotplug || d.transport === "usb")
    .filter(
      (d) => !all.some((x) => x.disk === d.disk && x.mountpoint && isSystemMount(x.mountpoint, [])),
    )
    .map((d) => {
      const title = d.label || d.model || d.name;
      if (!d.fstype) return { ...d, title, usable: false, why: "no_filesystem" };
      if (!(BACKUP_FSTYPES as readonly string[]).includes(d.fstype))
        return { ...d, title, usable: false, why: "unsupported_filesystem" };
      return { ...d, title, usable: true };
    });
}

/** Looks at a machine: is it a Proxmox host, which containers, which disks. */
export async function probeHost(
  machines: Machines,
  ownerId: string,
  m: MachineView,
  here: string,
): Promise<HostProbe> {
  const base: HostProbe = {
    machineId: m.id,
    name: m.name,
    proxmox: null,
    containers: [],
    guess: null,
    disks: [],
  };
  if (!m.hostKey || isWindowsPath(m.folder)) return base;
  let client: SshClient;
  try {
    client = await machines.connect(ownerId, m);
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  try {
    const v = await out(client, ["pveversion"]);
    const proxmox = v ? proxmoxVersion(v) : null;
    if (!proxmox) return base;
    const containers = parsePctList((await out(client, ["pct", "list"])) ?? "");
    const disks = hostCandidates(parseLsblk((await out(client, ["lsblk", ...LSBLK_ARGS])) ?? ""));
    return { ...base, proxmox, containers, guess: guessContainer(containers, here), disks };
  } finally {
    client.end();
  }
}

export interface HostMountRequest {
  ctid: string;
  device: string;
  name: string;
  /** The disk's name as the person typed it to format it (only for a disk with no filesystem). */
  format?: string | undefined;
}

export class HostMountError extends Error {
  constructor(
    readonly code:
      | PlanRefusal
      | "not_proxmox"
      | "no_container"
      | "no_disk"
      | "already"
      | "format_name"
      | "failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads the host again and makes the plan for this disk and container: everything is checked
 * on the host just before (the device, the container, its free mount point, the filesystem).
 */
export async function planOnHost(
  client: SshClient,
  r: HostMountRequest,
  base?: string,
  fstab?: string,
): Promise<{ plan: Extract<ProxmoxPlan, { ok: true }>; disk: string }> {
  if (!PROXMOX_ID.test(r.ctid)) throw new HostMountError("bad_id", "Not a container id");
  if (!HOST_DEVICE.test(r.device)) throw new HostMountError("bad_device", "Not a disk device");
  const v = await out(client, ["pveversion"]);
  if (!v || !proxmoxVersion(v))
    throw new HostMountError("not_proxmox", "That machine is not a Proxmox host");
  const conf = await out(client, ["pct", "config", r.ctid]);
  if (conf === null)
    throw new HostMountError("no_container", `There is no container ${r.ctid} on that host`);
  const c = parsePctConfig(conf);
  const target = `${(base ?? CONTAINER_BACKUP_BASE).replace(/\/+$/, "")}/${r.name}`;
  if (c.targets.includes(target))
    throw new HostMountError("already", `Container ${r.ctid} already has a folder at ${target}`);
  const all = parseLsblk((await out(client, ["lsblk", ...LSBLK_ARGS])) ?? "");
  const d = hostCandidates(all).find((x) => x.path === r.device);
  if (!d) throw new HostMountError("no_disk", `${r.device} is not a removable disk of that host`);
  const format = r.format !== undefined;
  if (format) {
    if (r.format?.trim() !== d.title)
      throw new HostMountError("format_name", `To format it, type its name exactly: ${d.title}`);
    if (d.type === "disk" && all.some((x) => x.type === "part" && x.disk === d.name))
      throw new HostMountError(
        "has_filesystem",
        "That disk has partitions: it is not formatted here",
      );
  }
  const plan = proxmoxPlan({
    ctid: r.ctid,
    device: r.device,
    name: r.name,
    mp: firstFreeMp(c.used),
    unprivileged: c.unprivileged,
    fstype: d.fstype,
    mountedAt: d.mountpoint,
    format,
    ...(base && { base }),
    ...(fstab && { fstab }),
  });
  if (!plan.ok) throw new HostMountError(plan.why, `That disk cannot be passed in (${plan.why})`);
  return { plan, disk: d.title };
}

/** Runs the plan's steps in order; the first that fails stops the rest, and says which. */
export async function runPlan(
  client: SshClient,
  steps: readonly PlanStep[],
  onStep?: (i: number) => void,
): Promise<void> {
  for (const [i, s] of steps.entries()) {
    onStep?.(i);
    const r = await execRemote(client, lineOf(s.argv), { timeoutMs: 10 * 60_000 });
    if (r.exitCode !== 0)
      throw new HostMountError(
        "failed",
        `${s.what}: failed (${r.timedOut ? "timed out" : `exit ${r.exitCode}`}) ${r.stderr.trim().slice(0, 300)}`,
      );
  }
}
