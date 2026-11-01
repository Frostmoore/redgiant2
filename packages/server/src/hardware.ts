import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, platform, totalmem } from "node:os";

export interface Gpu {
  name: string;
  vramGb: number;
}

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
  suggestion: {
    engine: "cuda" | "cpu";
    /** Largest model file that fits comfortably, in GB. */
    maxModelGb: number;
    /** What the numbers mean, for the page to say in its language: a GPU with its memory, a GPU
     * whose memory is unknown, or none (small models on the CPU, up to `maxModelGb`). */
    kind: "gpu" | "gpu-unknown" | "cpu";
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
              return { name, vramGb: round(Number(mib) / 1024) };
            }),
        );
      },
    );
  });
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
      return i > 0 && Number.isFinite(vram) && vram > 0
        ? [{ name: x.slice(0, i).trim(), vramGb: round(vram) }]
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
  const ramGb = round(totalmem() / GB);
  const vram = Math.max(0, ...gpus.map((g) => g.vramGb));
  const cuda = vram > 0 || dockerGpu;
  // The model must leave room for the KV cache and the system: about 80 % of VRAM, 50 % of RAM.
  const maxModelGb = round(vram > 0 ? vram * 0.8 : ramGb * 0.5);
  return {
    os: platform(),
    cpu: list[0]?.model.trim() ?? "unknown",
    cores: list.length,
    ramGb,
    freeRamGb: round(freemem() / GB),
    diskFreeGb: disk,
    gpus,
    dockerGpu,
    suggestion: {
      engine: cuda ? "cuda" : "cpu",
      maxModelGb: cuda ? maxModelGb : Math.min(maxModelGb, 6),
      kind: cuda ? (vram > 0 ? "gpu" : "gpu-unknown") : "cpu",
      vramGb: vram,
    },
  };
}
