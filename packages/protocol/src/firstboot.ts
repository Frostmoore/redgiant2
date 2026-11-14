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

/**
 * Where scheduled backups go (p3.7.2: the same three kinds wherever RedGiant runs): a disk
 * connected here, a folder already mounted, or a folder on the network reached without mounting
 * anything (one of the person's SSH machines over SFTP, an SMB share, another RedGiant paired
 * as a node). No password or key is ever in it: an SMB password lives in the keychain.
 */
export type BackupDestination =
  | {
      kind: "disk";
      /** The filesystem's UUID: the same disk is found again whatever its /dev name. */
      uuid: string;
      label: string;
      /** Where it is mounted for RedGiant (`/var/lib/redgiant/backups/<label>`, or udisks' place). */
      path: string;
    }
  | { kind: "folder"; path: string }
  | {
      kind: "sftp";
      /** One of the person's machines (Settings › Machines, G38.2), with its fixed host key. */
      machineId: string;
      machineName: string;
      /** The folder there: absolute, or `~/…` from the login's home. */
      path: string;
    }
  | {
      kind: "smb";
      host: string;
      share: string;
      /** The folder inside the share, "/"-separated ("" for the share's top). */
      folder: string;
      user: string;
      domain?: string;
    }
  | {
      kind: "node";
      /** The paired RedGiant's key fingerprint (G39.4); its storage keeps the backups. */
      fingerprint: string;
      name: string;
    };

/** A backup in the destination, for the list and the restore. */
export interface BackupEntry {
  /** "<folder>/<file>". */
  id: string;
  folder: string;
  file: string;
  bytes: number;
  /** When it was written, when the destination says. */
  at: string | null;
}

export interface BackupSettings {
  destination?: BackupDestination;
  schedule: BackupSchedule;
  /** The last scheduled run: when, and how it went. */
  last?: {
    at: string;
    ok: boolean;
    error?: string;
    /** Why it failed, for the page's words: "unreachable", "auth", "disk_missing"… */
    code?: string;
    file?: string;
  };
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
  /**
   * RedGiant OS in a container (p3.7.2: "lxc", "docker"…): the disks it sees are the host's, so
   * none is offered (`hostDisks` says how many were left out); the host mounts folders instead.
   */
  container?: string | null;
  hostDisks?: number;
  /** Folders mounted under /var/lib/redgiant/backups (Proxmox's mount points, a network share). */
  places?: BackupPlace[];
  /**
   * In a container (p3.7.2): the host's disks it sees (lsblk lists them even without their
   * filesystems), to say which one to pass in and how.
   */
  hostDiskList?: HostDisk[];
  /** What may name this container on its host: its hostname (Docker's short id, an LXC's name). */
  containerHint?: { hostname: string; id: string | null };
  /** Where the host's folders must arrive inside RedGiant (`/var/lib/redgiant/backups`). */
  backupBase?: string;
}

/** A disk of the host seen from inside a container. */
export interface HostDisk {
  name: string;
  /** The kernel's device ("/dev/sdb1"): the same name on the host, it is the same kernel. */
  path: string;
  /** Label, model or name: what the person recognises ("Tech"). */
  title: string;
  sizeBytes: number;
  transport: string;
  /** "" when the container cannot read it (no udev), not necessarily «not formatted». */
  fstype: string;
}

/** A folder the host mounted for backups under /var/lib/redgiant/backups/<name>. */
export interface BackupPlace {
  name: string;
  path: string;
  freeGb: number | null;
  totalGb: number | null;
  /** RedGiant writes there, or the OS helper can make its own folder in it. */
  usable: boolean;
  why?: "not_writable";
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
  /**
   * RedGiant is reached already (G39.8): the page came through a proxy at home (X-Forwarded-*
   * headers on a connection from a private address) or with a name instead of an address.
   */
  reachedAs?: ReachedAs | null;
  /** RedGiant on the local network, for the blocks to copy (address null when unknown). */
  lan?: { address: string | null; port: number };
}

/** How the page reached RedGiant when it is reached already (G39.8). */
export interface ReachedAs {
  /** The name, as the person typed it (no port). */
  host: string;
  https: boolean;
  /** "proxy": a reverse proxy in front; "name": a name of the home's DNS, straight to RedGiant. */
  through: "proxy" | "name";
}

/** SSH into the machine (RedGiant OS): off by default, keys only, through the OS helper. */
export type SshAccess =
  | {
      available: false;
      /**
       * Why (p3.7.2): no OS helper here (not RedGiant OS), the helper did not answer, SSH is not
       * installed, or the helper's own error code.
       */
      why?: string;
      /** The container RedGiant OS runs in, when it is one ("lxc"…). */
      container?: string | null;
    }
  | { available: true; on: boolean; keys: number; container?: string | null };

// --- RedGiant OS: Wi-Fi, HTTPS in the local network, updates (G39.1) -------------------------

/** A Wi-Fi network in reach. */
export interface WifiNetwork {
  ssid: string;
  /** iwd's kind: "open", "psk" (a password), "8021x" (a company network, not joined from here). */
  security: "open" | "psk" | "8021x" | "wep" | "other";
  /** 0–100, from the signal in dBm. */
  signal: number;
  connected: boolean;
  /** Saved on this machine. */
  known: boolean;
}

/** Wi-Fi on this machine (RedGiant OS, through the OS helper and iwd). */
export type WifiState =
  | { available: false; why: "no_helper" | "no_wifi" | "wifi_off" | "not_installed" | "failed" }
  | {
      available: true;
      device: string;
      /** iwd's station state: connected, connecting, disconnected… */
      state: string;
      connected: string | null;
      networks: WifiNetwork[];
      /** Saved networks (names), also those not in reach. */
      known: string[];
      /** A cable is connected with an address (it is used first). */
      wired: boolean;
      /** The Wi-Fi card's address, when it has one. */
      address: string | null;
    };

/** HTTPS in the local network (RedGiant OS): the machine's own CA, Caddy in front. */
export type LocalHttps =
  | { available: false }
  | {
      available: true;
      /** Caddy answers on 443 (and 80). */
      on: boolean;
      /** The CA's certificate (PEM): public, what the person installs. */
      ca: string | null;
      /** SHA-256 of the CA's certificate, to compare on the phone. */
      fingerprint: string | null;
      /** When the server's certificate expires (the CA lasts ten years). */
      until: string | null;
      names: string[];
      /** http redirects to https and HSTS is sent (the person said the certificate is trusted). */
      redirect: boolean;
      /** This request came through the local HTTPS (or its port 80). */
      viaLocal: boolean;
      /** Something else already gives HTTPS (a proxy in front, Tailscale): not needed twice. */
      inFront: string | null;
    };

/** RedGiant OS's own updates: RedGiant's signed stack, and Debian's security updates. */
export interface OsUpdates {
  available: boolean;
  /** The last look of redgiant-os-update (os-update.json). */
  update: {
    state: "latest" | "available" | "applying" | "error" | "breaking" | "unsigned" | "unreachable";
    installed: string | null;
    latest: string | null;
    gate: "none" | "normal" | "mandatory" | "breaking";
    note: string | null;
    /** While applying: download, files, restart, wait, rollback. */
    step: string | null;
    checkedAt: string | null;
  } | null;
  /** The updater is running now. */
  running: boolean;
  security: {
    /** When unattended-upgrades last ran (ISO). */
    lastRun: string | null;
    result: string | null;
    /** Packages it installed that time (null: unknown). */
    upgraded: number | null;
    rebootRequired: boolean;
    /** What asks for the restart (a new kernel…). */
    packages: string[];
  } | null;
}
