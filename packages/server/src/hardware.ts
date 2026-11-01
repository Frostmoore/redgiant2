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
    note: string;
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

/**
 * What this machine can run (G17.1). Inside a container the GPU is often invisible: Docker's
 * NVIDIA runtime then tells that one can be handed to the engine.
 */
export async function detectHardware(o: {
  dataDir: string;
  dockerRuntimes?: () => Promise<string[]>;
  gpus?: () => Promise<Gpu[]>;
}): Promise<Hardware> {
  const list = cpus();
  const disk = await statfs(o.dataDir)
    .then((s) => round((s.bavail * s.bsize) / GB))
    .catch(() => null);
  const gpus = await (o.gpus ?? nvidiaSmi)();
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
      maxModelGb,
      note: cuda
        ? vram > 0
          ? `NVIDIA GPU with ${vram} GB: models up to about ${maxModelGb} GB run on it.`
          : "Docker can use an NVIDIA GPU; check its memory and pick a model that fits."
        : `No GPU: small models (up to about ${Math.min(maxModelGb, 6)} GB) run on the CPU, slowly. A cloud model is faster.`,
    },
  };
}
