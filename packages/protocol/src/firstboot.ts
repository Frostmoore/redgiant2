/**
 * First boot anywhere (G39.3): what RedGiant finds on the machine it runs on, the role it plays
 * (a complete RedGiant or a node of another one), where its data and backups live, and the
 * one-time code that opens the wizard from another device of the local network.
 */

/** «Unavailable here» rather than a guess: a value, or why it is missing. */
export type Found<T> = { value: T } | { missing: "unsupported" | "unreadable" | "not_installed" };

/** A whole disk or one of its partitions, as `lsblk` (or the mount helper) lists it. */
export interface BlockDisk {
  /** The kernel's name: "sda", "sda1", "nvme0n1p2". */
  name: string;
  /** "/dev/sda1". */
  path: string;
  type: "disk" | "part" | "other";
  sizeBytes: number;
  /** The kernel says it is removable (USB sticks, card readers). */
  removable: boolean;
  /** It can be unplugged while running (USB and Thunderbolt disks, some SATA bays). */
  hotplug: boolean;
  /** How it is attached: "usb", "sata", "nvme"… "" when not said. */
  transport: string;
  model: string;
  label: string;
  uuid: string;
  fstype: string;
  /** Where it is mounted now, if anywhere ("[SWAP]" for swap). */
  mountpoint: string;
  /** Free space where it is mounted and readable, else null. */
  freeBytes: number | null;
  /** The whole disk this partition belongs to ("sda"), its own name for a whole disk. */
  disk: string;
}

export type GpuMaker = "nvidia" | "amd" | "intel" | "apple" | "other";

export interface SystemInfo {
  /** "linux", "win32", "darwin". */
  os: string;
  /** "x64", "arm64". */
  arch: string;
  cpu: { model: string; cores: number };
  ram: { totalGb: number; freeGb: Found<number> };
  /** The disks: only where the system lets RedGiant see them. */
  disks: Found<BlockDisk[]>;
  gpus: Found<{ maker: GpuMaker; name: string; vramGb: number | null }[]>;
  /** Running in a virtual machine or a container: what systemd-detect-virt (or a hint) says. */
  virt: Found<{ kind: "none" | "vm" | "container"; name: string }>;
}

/**
 * What the wizard offers on this machine (never forced): cloud models always; local models only
 * when one fits the memory (the card's, or the RAM for the processor).
 */
export interface LocalOffer {
  cloud: true;
  local: boolean;
  /** The largest model file that fits comfortably, GB (0 when none does). */
  maxModelGb: number;
  /** Why: a card with its memory, the processor with the RAM, or too little memory. */
  reason: "gpu" | "cpu" | "too_little_memory";
}

/** The role chosen at first boot (G39.3); pairing with the main RedGiant arrives in G39.4. */
export type RedGiantRole = "full" | "node";

/** When scheduled backups run. */
export interface BackupSchedule {
  every: "off" | "daily" | "weekly";
  /** Local hour, 0-23. */
  hour: number;
  /** 0 = Sunday … 6 = Saturday, for weekly backups. */
  weekday?: number;
  /** How many backups stay (older ones are removed), 1-60. */
  keep: number;
}

/** Where scheduled backups go: a removable disk the person picked, or a folder. */
export type BackupDestination =
  | {
      kind: "disk";
      /** The filesystem's UUID: the same disk is found again whatever its /dev name. */
      uuid: string;
      label: string;
      /** Where it is mounted for RedGiant (`/var/lib/redgiant/backups/<label>`, or udisks' place). */
      path: string;
    }
  | { kind: "folder"; path: string };

export interface BackupSettings {
  destination?: BackupDestination;
  schedule: BackupSchedule;
  /** The last scheduled run: when, and how it went. */
  last?: { at: string; ok: boolean; error?: string; file?: string };
}

/** How this installation can mount a disk for backups. */
export type MountMethod = "helper" | "udisks" | "none";

/** The storage step: the data folder, the removable disks, how they can be mounted. */
export interface StorageInfo {
  dataDir: string;
  dataFreeGb: number | null;
  dataTotalGb: number | null;
  method: MountMethod;
  /** Removable disks with a filesystem, each with what keeps it from being used, if anything. */
  candidates: (BlockDisk & { usable: boolean; why?: string; target?: string })[];
}

/** What already reaches this machine, found before offering a way in from outside. */
export interface NetDetected {
  tailscale:
    | { state: "absent" | "stopped" | "logged_out" }
    | { state: "running"; name?: string; ip?: string };
  /** A proxy in front of RedGiant (seen in the page's request): "cloudflare", "caddy", "proxy". */
  proxyInFront: string | null;
  /** Reverse proxies running on this machine (when RedGiant can see its programs). */
  proxiesRunning: string[];
  /** A name server on the local network (Pi-hole, a router…). */
  localDns: string | null;
  /** The name the page used to reach RedGiant, when it is a name. */
  hostName: string | null;
}

/** SSH into the machine (RedGiant OS): off by default, keys only, through the OS helper. */
export type SshAccess = { available: false } | { available: true; on: boolean; keys: number };
