import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, platform, totalmem } from "node:os";
import { readLinuxMemory, readWindowsMemory, usableRamGb } from "./memory.js";

export interface Gpu {
  name: string;
  vramGb: number;
  vendor: GpuVendor;
  /** Built into the processor: it shares the computer's memory. */
  integrated: boolean;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

/**
 * The local engine's builds: llama.cpp for the CPU, CUDA (NVIDIA) and Vulkan (AMD, Intel…) in
 * Docker, and `windows`: llama.cpp's Vulkan build running on Windows itself (G24.3b), for the
 * GPUs WSL cannot reach.
 */
export type EngineVariant = "cpu" | "cuda" | "vulkan" | "windows";

/**
 * How the engine's container reaches a GPU that is not NVIDIA's: Linux's /dev/dri. Windows' WSL
 * is not one of them yet: llama.cpp's Vulkan build lacks Mesa's D3D12 driver ("dozen").
 */
export type GpuAccess = "dri" | "";

/** A disk of the computer (2026-11-03): models are streamed only from a solid-state one. */
export interface Disk {
  /** A drive letter on Windows ("C"), "/" for the one Docker uses on Linux. */
  name: string;
  /** Solid state (true), spinning (false), or not said (null). */
  ssd: boolean | null;
  bus: string;
  freeGb: number;
  totalGb: number;
}

/** "C|ssd|nvme|120.5|476.9;D|hdd|sata|900.0|1863.0" as Windows' launcher or the installer write it. */
export function parseDisks(text: string | undefined): Disk[] {
  return (text ?? "")
    .split(";")
    .map((x) => x.trim().split("|"))
    .filter((p) => p.length === 5 && p[0])
    .map(([name, kind, bus, free, total]) => ({
      name: name as string,
      ssd: kind === "ssd" ? true : kind === "hdd" ? false : null,
      bus: bus ?? "other",
      freeGb: Number(free) || 0,
      totalGb: Number(total) || 0,
    }));
}

/** The drive letter of a Windows path ("D:\\x") or of WSL's view of it ("/mnt/d/x"). */
export function driveOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = /^([a-zA-Z]):[\\/]/.exec(path) ?? /^\/mnt\/([a-zA-Z])(?:\/|$)/.exec(path);
  return m?.[1]?.toUpperCase();
}

export interface Hardware {
  os: string;
  cpu: string;
  cores: number;
  ramGb: number;
  /** The RAM a model may use now on the suggested engine: free, not total (2026-11-04). */
  freeRamGb: number;
  diskFreeGb: number | null;
  /** The computer's disks, and the one each kind of engine keeps its models on. */
  disks: Disk[];
  modelDisk: { docker?: string; windows?: string };
  gpus: Gpu[];
  /** Docker can give containers an NVIDIA GPU (the NVIDIA runtime is installed). */
  dockerGpu: boolean;
  /** How containers reach other GPUs (Vulkan), as the installer found it. */
  gpuAccess: GpuAccess;
  /** The engine can run on Windows itself (RedGiant's Windows install, G24.3b). */
  windowsEngine: boolean;
  /**
   * RedGiant's Windows installation: the launcher's folder is shared (2026-11-04). Enough for
   * what goes through files (free RAM, moving models); the Windows engine also needs Windows'
   * address (`windowsEngine`).
   */
  onWindows: boolean;
  suggestion: {
    engine: EngineVariant;
    /** Largest model file that fits comfortably, in GB. */
    maxModelGb: number;
    /** What the numbers mean, for the page to say in its language: a GPU with its memory, a GPU
     * whose memory is unknown, one built into the processor, or none (small models on the CPU,
     * up to `maxModelGb`). */
    kind: "gpu" | "gpu-unknown" | "igpu" | "cpu";
    vramGb: number;
  };
}

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

function nvidiaSmi(): Promise<Gpu[]> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const [name = "GPU", mib = "0"] = l.split(",").map((x) => x.trim());
              return describeGpu(name, round(Number(mib) / 1024));
            }),
        );
      },
    );
  });
}

/** Apple Silicon's GPU: Metal can give it about 75 % of the shared memory. */
export function appleGpu(name: string, ramGb: number): Gpu {
  return { name, vramGb: round(ramGb * 0.75), vendor: "apple", integrated: false };
}

/** The maker and kind of a GPU from its name (and its memory: a tiny one is shared). */
export function describeGpu(name: string, vramGb: number): Gpu {
  const n = name.toLowerCase();
  const vendor: GpuVendor = /nvidia|geforce|quadro|tesla|rtx|gtx/.test(n)
    ? "nvidia"
    : /\bamd\b|radeon|\bati\b/.test(n)
      ? "amd"
      : /intel|\barc\b|iris|uhd|hd graphics/.test(n)
        ? "intel"
        : "other";
  const integrated =
    vramGb < 2 ||
    (vendor === "intel" && !/\barc\b/.test(n)) ||
    (vendor === "amd" &&
      /radeon(\(tm\))? graphics|vega \d+ graphics|\d+m\b/.test(n) &&
      !/\brx\b|pro w/.test(n));
  return { name, vramGb, vendor, integrated };
}

/** "NVIDIA GeForce RTX 4080 SUPER:16;…" (memory in GB) as GPUs; anything malformed is skipped. */
export function hostGpus(text: string | undefined): Gpu[] {
  return (text ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x) => {
      const i = x.lastIndexOf(":");
      const vram = Number(x.slice(i + 1));
      // Integrated GPUs report little or no memory of their own: they are kept, as 0 GB.
      return i > 0 && Number.isFinite(vram) && vram >= 0
        ? [describeGpu(x.slice(0, i).trim(), round(vram))]
        : [];
    });
}

/**
 * What this machine can run (G17.1). Inside a container the GPU is often invisible: Docker's
 * NVIDIA runtime then tells that one can be handed to the engine.
 */
export async function detectHardware(o: {
  dataDir: string;
  dockerRuntimes?: () => Promise<string[]>;
  gpus?: () => Promise<Gpu[]>;
  hostGpus?: string | undefined;
  hostDisks?: string | undefined;
  gpuAccess?: string | undefined;
  /** The engine can run on Windows itself (RedGiant's Windows install). */
  windowsEngine?: boolean | undefined;
  /** The Windows engine's folder, where the launcher says how much memory Windows has free. */
  winEngineDir?: string | undefined;
  /** Tests: another system. */
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}): Promise<Hardware> {
  const list = cpus();
  const disk = await statfs(o.dataDir)
    .then((s) => round((s.bavail * s.bsize) / GB))
    .catch(() => null);
  // In a container (Windows' WSL distribution included) nvidia-smi is not there: the host says
  // which GPUs it has in REDGIANT_HOST_GPUS ("name:GB;name:GB").
  let gpus = await (o.gpus ?? nvidiaSmi)();
  if (gpus.length === 0) gpus = hostGpus(o.hostGpus ?? process.env.REDGIANT_HOST_GPUS);
  // A Mac with Apple Silicon (2026-11-05): its GPU shares the memory, and Metal lets it use
  // about three quarters of it.
  if (
    gpus.length === 0 &&
    (o.platform ?? process.platform) === "darwin" &&
    (o.arch ?? process.arch) === "arm64"
  )
    gpus = [appleGpu(list[0]?.model.trim() ?? "Apple Silicon", totalmem() / GB)];
  const runtimes: string[] = await (o.dockerRuntimes?.() ?? Promise.resolve([])).catch(() => []);
  const dockerGpu = runtimes.includes("nvidia");
  const access = o.gpuAccess ?? process.env.REDGIANT_ENGINE_GPU ?? "";
  const gpuAccess: GpuAccess = access === "dri" ? "dri" : "";
  // Natively on Windows (RedGiant 3.0) the engine there is the only one.
  o = {
    ...o,
    // A Mac runs llama.cpp next to the server the same way (native-launcher.ts).
    windowsEngine:
      o.windowsEngine ??
      (Boolean(process.env.REDGIANT_WIN_HOST) ||
        ["win32", "darwin"].includes(o.platform ?? process.platform)),
  };
  const onWindows =
    o.windowsEngine === true || Boolean(o.winEngineDir ?? process.env.REDGIANT_HOST_ENGINE_DIR);
  const ramGb = round(totalmem() / GB);
  const disks = parseDisks(o.hostDisks ?? process.env.REDGIANT_HOST_DISKS);
  // On Windows the engines in Docker read from the distribution's disk, the Windows engine from
  // its folder; on Linux there is one entry, the disk of Docker's volumes.
  const dockerDisk =
    driveOf(process.env.REDGIANT_HOST_DATA_DIR) ??
    (disks.length === 1 ? disks[0]?.name : undefined);
  const windowsDisk = driveOf(process.env.REDGIANT_HOST_ENGINE_DIR);
  const modelDisk = {
    ...(dockerDisk && { docker: dockerDisk }),
    ...(windowsDisk && { windows: windowsDisk }),
  };
  const nvidia = gpus.filter((g) => g.vendor === "nvidia" && !g.integrated);
  // Without Docker's NVIDIA runtime an NVIDIA card still works through Vulkan.
  const others = gpus.filter((g) => !g.integrated && (g.vendor !== "nvidia" || !dockerGpu));
  const igpu = gpus.some((g) => g.integrated);
  const best = (list: Gpu[]) => Math.max(0, ...list.map((g) => g.vramGb));
  // The model must leave room for the KV cache and the system: about 80 % of VRAM, 50 % of RAM.
  let suggestion: Hardware["suggestion"];
  if (o.windowsEngine && (others.length > 0 || nvidia.length > 0)) {
    // On Windows every card runs natively, NVIDIA too (2026-11-04, the person's decision: no
    // virtualisation where it is not needed; through WSL copies to the card were slow).
    const vram = best([...others, ...nvidia]);
    suggestion = { engine: "windows", maxModelGb: round(vram * 0.8), kind: "gpu", vramGb: vram };
  } else if (dockerGpu && (nvidia.length > 0 || gpus.length === 0)) {
    const vram = best(nvidia);
    suggestion = {
      engine: "cuda",
      maxModelGb: round(vram > 0 ? vram * 0.8 : ramGb * 0.5),
      kind: vram > 0 ? "gpu" : "gpu-unknown",
      vramGb: vram,
    };
  } else if (o.windowsEngine && igpu) {
    suggestion = {
      engine: "windows",
      maxModelGb: Math.min(round(ramGb * 0.4), 8),
      kind: "igpu",
      vramGb: 0,
    };
  } else if (others.length > 0 && gpuAccess) {
    const vram = best(others);
    suggestion = { engine: "vulkan", maxModelGb: round(vram * 0.8), kind: "gpu", vramGb: vram };
  } else if (igpu && gpuAccess) {
    // A GPU in the processor shares the memory: a bit faster than the CPU alone, as small.
    suggestion = {
      engine: "vulkan",
      maxModelGb: Math.min(round(ramGb * 0.4), 8),
      kind: "igpu",
      vramGb: 0,
    };
  } else {
    suggestion = {
      engine: "cpu",
      maxModelGb: Math.min(round(ramGb * 0.5), 6),
      kind: "cpu",
      vramGb: 0,
    };
  }
  const [linux, windows] = await Promise.all([
    readLinuxMemory(),
    onWindows
      ? readWindowsMemory(o.winEngineDir ?? process.env.REDGIANT_WIN_ENGINE_DIR ?? "/winengine")
      : undefined,
  ]);
  const freeRam = usableRamGb({
    windowsEngine: suggestion.engine === "windows",
    totalGb: ramGb,
    linux,
    windows,
  });
  return {
    os: platform(),
    cpu: list[0]?.model.trim() ?? "unknown",
    cores: list.length,
    // The computer's RAM: Windows' own when it says (inside WSL totalmem() is the VM's share).
    ramGb: windows?.totalGb !== undefined ? round(windows.totalGb) : ramGb,
    freeRamGb: freeRam.gb,
    diskFreeGb: disk,
    disks,
    modelDisk,
    gpus,
    dockerGpu,
    gpuAccess,
    windowsEngine: o.windowsEngine === true,
    onWindows,
    suggestion,
  };
}
