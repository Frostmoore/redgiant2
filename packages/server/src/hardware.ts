import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, platform, totalmem } from "node:os";

export interface Gpu {
  name: string;
  vramGb: number;
  vendor: GpuVendor;
  /** Built into the processor: it shares the computer's memory. */
  integrated: boolean;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "other";

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

export interface Hardware {
  os: string;
  cpu: string;
  cores: number;
  ramGb: number;
  freeRamGb: number;
  diskFreeGb: number | null;
  gpus: Gpu[];
  /** Docker can give containers an NVIDIA GPU (the NVIDIA runtime is installed). */
  dockerGpu: boolean;
  /** How containers reach other GPUs (Vulkan), as the installer found it. */
  gpuAccess: GpuAccess;
  /** The engine can run on Windows itself (RedGiant's Windows install, G24.3b). */
  windowsEngine: boolean;
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
  gpuAccess?: string | undefined;
  /** The engine can run on Windows itself (RedGiant's Windows install). */
  windowsEngine?: boolean | undefined;
}): Promise<Hardware> {
  const list = cpus();
  const disk = await statfs(o.dataDir)
    .then((s) => round((s.bavail * s.bsize) / GB))
    .catch(() => null);
  // In a container (Windows' WSL distribution included) nvidia-smi is not there: the host says
  // which GPUs it has in REDGIANT_HOST_GPUS ("name:GB;name:GB").
  let gpus = await (o.gpus ?? nvidiaSmi)();
  if (gpus.length === 0) gpus = hostGpus(o.hostGpus ?? process.env.REDGIANT_HOST_GPUS);
  const runtimes: string[] = await (o.dockerRuntimes?.() ?? Promise.resolve([])).catch(() => []);
  const dockerGpu = runtimes.includes("nvidia");
  const access = o.gpuAccess ?? process.env.REDGIANT_ENGINE_GPU ?? "";
  const gpuAccess: GpuAccess = access === "dri" ? "dri" : "";
  o = { ...o, windowsEngine: o.windowsEngine ?? Boolean(process.env.REDGIANT_WIN_HOST) };
  const ramGb = round(totalmem() / GB);
  const nvidia = gpus.filter((g) => g.vendor === "nvidia" && !g.integrated);
  // Without Docker's NVIDIA runtime an NVIDIA card still works through Vulkan.
  const others = gpus.filter((g) => !g.integrated && (g.vendor !== "nvidia" || !dockerGpu));
  const igpu = gpus.some((g) => g.integrated);
  const best = (list: Gpu[]) => Math.max(0, ...list.map((g) => g.vramGb));
  // The model must leave room for the KV cache and the system: about 80 % of VRAM, 50 % of RAM.
  let suggestion: Hardware["suggestion"];
  if (dockerGpu && (nvidia.length > 0 || gpus.length === 0)) {
    const vram = best(nvidia);
    suggestion = {
      engine: "cuda",
      maxModelGb: round(vram > 0 ? vram * 0.8 : ramGb * 0.5),
      kind: vram > 0 ? "gpu" : "gpu-unknown",
      vramGb: vram,
    };
  } else if (o.windowsEngine && (others.length > 0 || nvidia.length > 0)) {
    // On Windows every GPU works through the Windows engine (Vulkan with Windows' drivers).
    const vram = best([...others, ...nvidia]);
    suggestion = { engine: "windows", maxModelGb: round(vram * 0.8), kind: "gpu", vramGb: vram };
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
  return {
    os: platform(),
    cpu: list[0]?.model.trim() ?? "unknown",
    cores: list.length,
    ramGb,
    freeRamGb: round(freemem() / GB),
    diskFreeGb: disk,
    gpus,
    dockerGpu,
    gpuAccess,
    windowsEngine: o.windowsEngine === true,
    suggestion,
  };
}
