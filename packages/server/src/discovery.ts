// What this machine is (G39.3): processor, memory, disks, graphics cards, architecture, and
// whether it runs in a virtual machine or a container. RedGiant installs anywhere, so nothing is
// assumed: every reading is a pure parser of a program's output (tested as tables) behind a thin
// reader, and what a system does not tell is said as missing, never guessed.
import { execFile } from "node:child_process";
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { cpus, arch as osArch, platform, totalmem } from "node:os";
import { join } from "node:path";
import type { BlockDisk, Found, GpuMaker, LocalOffer, SystemInfo } from "@redgiant/protocol";
import type { Hardware } from "./hardware.js";
import { parseMeminfo } from "./memory.js";

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

// --- lsblk ----------------------------------------------------------------------------------

/** The columns asked of lsblk: all of them exist since util-linux 2.33 (Debian 10). */
export const LSBLK_ARGS = [
  "-J",
  "-b",
  "-o",
  "NAME,PATH,TYPE,SIZE,RM,HOTPLUG,TRAN,MODEL,LABEL,UUID,FSTYPE,MOUNTPOINT",
];

type LsblkNode = Record<string, unknown> & { children?: LsblkNode[] };

/** lsblk writes booleans as true/false, or "0"/"1" in older versions. */
const flag = (v: unknown) => v === true || v === 1 || v === "1";
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const count = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * `lsblk -J -b -o …` as a flat list: whole disks and their partitions. A partition takes from
 * its disk what lsblk says only of the disk (how it is attached, whether it can be unplugged).
 * Loop devices, RAM disks and optical drives are left out. Anything unreadable gives [].
 */
export function parseLsblk(json: string): BlockDisk[] {
  let root: { blockdevices?: LsblkNode[] };
  try {
    root = JSON.parse(json) as { blockdevices?: LsblkNode[] };
  } catch {
    return [];
  }
  const out: BlockDisk[] = [];
  const walk = (n: LsblkNode, parent: BlockDisk | undefined) => {
    const type = text(n.type);
    if (!parent && type !== "disk") return;
    const name = text(n.name);
    if (!name) return;
    const d: BlockDisk = {
      name,
      path: text(n.path) || `/dev/${name}`,
      type: type === "disk" ? "disk" : type === "part" ? "part" : "other",
      sizeBytes: count(n.size),
      removable: flag(n.rm) || Boolean(parent?.removable),
      hotplug: flag(n.hotplug) || Boolean(parent?.hotplug),
      transport: (text(n.tran) || parent?.transport || "").toLowerCase(),
      model: text(n.model) || parent?.model || "",
      label: text(n.label),
      uuid: text(n.uuid),
      fstype: text(n.fstype).toLowerCase(),
      mountpoint: text(n.mountpoint),
      freeBytes: null,
      disk: parent?.disk ?? name,
    };
    out.push(d);
    for (const c of n.children ?? []) walk(c, d);
  };
  for (const n of root.blockdevices ?? []) walk(n, undefined);
  return out;
}

// --- graphics cards ---------------------------------------------------------------------------

/** The maker from a card's name or vendor string. */
export function gpuMaker(name: string): GpuMaker {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|tesla/.test(n)) return "nvidia";
  if (/advanced micro devices|\bamd\b|\bati\b|radeon/.test(n)) return "amd";
  if (/intel/.test(n)) return "intel";
  if (/apple/.test(n)) return "apple";
  return "other";
}

/**
 * `lspci` output: the display controllers ("VGA compatible controller", "3D controller",
 * "Display controller"), with the product in brackets when lspci knows it.
 */
export function parseLspci(out: string): { maker: GpuMaker; name: string; vramGb: null }[] {
  const list: { maker: GpuMaker; name: string; vramGb: null }[] = [];
  for (const line of out.split("\n")) {
    const m =
      /^\S+\s+(?:VGA compatible controller|3D controller|Display controller)[^:]*:\s*(.+)$/.exec(
        line.trim(),
      );
    if (!m?.[1]) continue;
    const full = m[1].replace(/\s*\(rev [0-9a-f]+\)\s*$/i, "").trim();
    const maker = gpuMaker(full);
    // "NVIDIA Corporation AD103 [GeForce RTX 4080 SUPER]" → the product in the last brackets.
    const product = [...full.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]).at(-1);
    const brand = { nvidia: "NVIDIA", amd: "AMD", intel: "Intel", apple: "Apple", other: "" }[
      maker
    ];
    const name =
      product && !/^AMD\/ATI$/i.test(product)
        ? `${brand && !product.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ` : ""}${product}`
        : full;
    list.push({ maker, name, vramGb: null });
  }
  return list;
}

/** PCI vendor ids of /sys/class/drm/card*\/device/vendor, as makers (without lspci). */
export function drmGpus(vendors: string[]): { maker: GpuMaker; name: string; vramGb: null }[] {
  const KNOWN: Record<string, [GpuMaker, string]> = {
    "0x10de": ["nvidia", "NVIDIA"],
    "0x1002": ["amd", "AMD"],
    "0x1022": ["amd", "AMD"],
    "0x8086": ["intel", "Intel"],
    "0x106b": ["apple", "Apple"],
  };
  return vendors
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((v) => {
      const k = KNOWN[v];
      return k
        ? { maker: k[0], name: `${k[1]} GPU`, vramGb: null }
        : { maker: "other" as const, name: `GPU ${v}`, vramGb: null };
    });
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(out: string): { maker: GpuMaker; name: string; vramGb: number }[] {
  return out
    .split("\n")
    .map((l) => l.split(",").map((x) => x.trim()))
    .filter((p) => p.length >= 2 && p[0] && Number.isFinite(Number(p[1])))
    .map(([name = "", mib = "0"]) => ({
      maker: "nvidia" as const,
      name,
      vramGb: round(Number(mib) / 1024),
    }));
}

// --- virtual machine or container -------------------------------------------------------------

const CONTAINERS = new Set([
  "docker",
  "podman",
  "lxc",
  "lxc-libvirt",
  "systemd-nspawn",
  "openvz",
  "rkt",
  "wsl",
  "proot",
  "pouch",
  "container-other",
]);

/**
 * `systemd-detect-virt`: "none" (exit 1) on bare metal, the hypervisor's name ("kvm", "vmware",
 * "microsoft"…) in a virtual machine, the container's ("docker", "lxc"…) in one.
 */
export function parseDetectVirt(out: string): { kind: "none" | "vm" | "container"; name: string } {
  const name = out.trim().split("\n")[0]?.trim().toLowerCase() ?? "";
  if (!name || name === "none") return { kind: "none", name: "" };
  return { kind: CONTAINERS.has(name) ? "container" : "vm", name };
}

/** Without systemd-detect-virt (most containers): the files container engines leave. */
export function containerHint(h: {
  dockerenv: boolean;
  containerenv: boolean;
  cgroup: string;
}): { kind: "container"; name: string } | undefined {
  if (h.dockerenv || /\/docker[/-]/.test(h.cgroup)) return { kind: "container", name: "docker" };
  if (h.containerenv || /libpod/.test(h.cgroup)) return { kind: "container", name: "podman" };
  if (/\/lxc[/.]/.test(h.cgroup)) return { kind: "container", name: "lxc" };
  if (/kubepods/.test(h.cgroup)) return { kind: "container", name: "kubernetes" };
  return undefined;
}

// --- what to offer --------------------------------------------------------------------------

/** The smallest local model worth offering, GB (a 3-4B model, 4-bit). */
export const MIN_LOCAL_MODEL_GB = 2;

/**
 * Cloud models always; local models only when one fits (the engine's suggestion measured it:
 * 80 % of a card's memory, half the RAM on the processor). Never forced either way.
 */
export function localOffer(s: Hardware["suggestion"]): LocalOffer {
  const max = round(s.maxModelGb);
  if (max < MIN_LOCAL_MODEL_GB)
    return { cloud: true, local: false, maxModelGb: 0, reason: "too_little_memory" };
  return {
    cloud: true,
    local: true,
    maxModelGb: max,
    reason: s.kind === "gpu" || s.kind === "gpu-unknown" ? "gpu" : "cpu",
  };
}

// --- the reader -----------------------------------------------------------------------------

/** A program's output, or null when it is missing, fails (unless `anyExit`) or takes too long. */
export function run(
  file: string,
  args: string[],
  anyExit = false,
  timeout = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && (!anyExit || (err as NodeJS.ErrnoException).code === "ENOENT" || !stdout))
        return resolve(null);
      resolve(String(stdout));
    });
  });
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Free space where each mounted filesystem is, when this process can read it. */
export async function withFree(disks: BlockDisk[]): Promise<BlockDisk[]> {
  return Promise.all(
    disks.map(async (d) => {
      if (!d.mountpoint.startsWith("/")) return d;
      const s = await statfs(d.mountpoint).catch(() => null);
      return s ? { ...d, freeBytes: s.bavail * s.bsize } : d;
    }),
  );
}

export interface DiscoverOptions {
  /** The engine's view (G17.1): GPUs with their memory, Windows' disks, the suggestion. */
  hardware: Hardware;
  /** The disks from somewhere else than lsblk here (the mount helper on the host). */
  listDisks?: () => Promise<BlockDisk[] | null>;
  /** Tests: another system, other programs, other files. */
  platform?: NodeJS.Platform;
  run?: typeof run;
  readFile?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
}

/** Everything RedGiant can find out about the machine, each part said missing when it cannot. */
export async function discoverSystem(o: DiscoverOptions): Promise<SystemInfo> {
  const os = o.platform ?? platform();
  const exec = o.run ?? run;
  const read = o.readFile ?? ((p: string) => readFile(p, "utf8").catch(() => null));
  const has = o.exists ?? exists;
  const hw = o.hardware;
  const list = cpus();
  const linux = os === "linux";

  // Memory: free as Linux counts it (MemAvailable); elsewhere the engine's measure.
  let freeGb: Found<number>;
  if (linux) {
    const m = parseMeminfo((await read("/proc/meminfo")) ?? "");
    freeGb = m ? { value: m.availableGb } : { missing: "unreadable" };
  } else freeGb = hw.freeRamGb > 0 ? { value: hw.freeRamGb } : { missing: "unsupported" };

  // Disks: lsblk (or the helper's list) on Linux, the launcher's list on Windows.
  let disks: Found<BlockDisk[]>;
  if (linux) {
    const fromHelper = await o.listDisks?.().catch(() => null);
    if (fromHelper) disks = { value: fromHelper };
    else {
      const out = await exec("lsblk", LSBLK_ARGS);
      const parsed = out === null ? null : parseLsblk(out);
      disks =
        parsed === null
          ? { missing: "not_installed" }
          : parsed.length
            ? { value: await withFree(parsed) }
            : { missing: "unreadable" };
    }
  } else if (hw.disks.length) {
    disks = {
      value: hw.disks.map((d) => ({
        name: d.name,
        path: `${d.name}:\\`,
        type: "disk",
        sizeBytes: d.totalGb * GB,
        removable: false,
        hotplug: false,
        transport: d.bus,
        model: "",
        label: "",
        uuid: "",
        fstype: "",
        mountpoint: `${d.name}:\\`,
        freeBytes: d.freeGb * GB,
        disk: d.name,
      })),
    };
  } else disks = { missing: "unsupported" };

  // Graphics cards: nvidia-smi gives the memory; lspci or /sys names the others.
  let gpus: SystemInfo["gpus"];
  const known = hw.gpus.map((g) => ({
    maker: g.vendor as GpuMaker,
    name: g.name,
    vramGb: g.vramGb > 0 ? g.vramGb : null,
  }));
  if (linux) {
    const pci = await exec("lspci", []);
    let found = pci !== null ? parseLspci(pci) : [];
    if (pci === null) {
      const cards = await readdir("/sys/class/drm").catch(() => [] as string[]);
      const vendors = await Promise.all(
        cards
          .filter((c) => /^card\d+$/.test(c))
          .map((c) => read(join("/sys/class/drm", c, "device", "vendor"))),
      );
      found = drmGpus(vendors.filter((v): v is string => v !== null));
    }
    // The cards nvidia-smi measured replace the same maker's unmeasured ones.
    const measured = new Set(known.map((k) => k.maker));
    const merged = [...known, ...found.filter((f) => !measured.has(f.maker))];
    gpus =
      merged.length || pci !== null ? { value: merged } : { missing: "not_installed" as const };
  } else gpus = { value: known };

  // Virtual machine or container.
  let virt: SystemInfo["virt"];
  if (linux) {
    const out = await exec("systemd-detect-virt", [], true);
    const hint = containerHint({
      dockerenv: await has("/.dockerenv"),
      containerenv: await has("/run/.containerenv"),
      cgroup: (await read("/proc/1/cgroup")) ?? "",
    });
    if (out !== null) {
      const v = parseDetectVirt(out);
      virt = { value: v.kind === "none" && hint ? hint : v };
    } else virt = hint ? { value: hint } : { missing: "not_installed" };
  } else virt = { missing: "unsupported" };

  return {
    os,
    arch: osArch(),
    cpu: { model: list[0]?.model.trim() || hw.cpu, cores: list.length || hw.cores },
    ram: { totalGb: hw.ramGb || round(totalmem() / GB), freeGb },
    disks,
    gpus,
    virt,
  };
}
