// The RAM a local model can use right now (2026-11-04). SSD stream decides how much of a model
// stays in RAM and how much is read from the SSD at each token: counting the computer's total
// RAM was too hopeful when other programs hold half of it. Two places know what is free:
//   - Linux (and the WSL distribution): /proc/meminfo's MemAvailable, the free memory plus the
//     file cache the system can give back;
//   - Windows: the launcher writes memory.json in the engine's folder every few seconds
//     (launcher/Memory.cs), because WSL does not see the programs running on Windows.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface LinuxMemory {
  availableGb: number;
  /** File cache: the pages of a model already read, which stay usable for it. */
  cachedGb: number;
}

export interface WindowsMemory {
  availableGb: number;
  /** Windows' whole RAM (2026-11-05: the page showed WSL's half next to Windows' free). */
  totalGb?: number;
  /** What the Windows engine holds now; it goes when the engine loads another model. */
  engineGb: number;
}

const GB = 1024 ** 3;
const round = (n: number) => Math.round(n * 10) / 10;

export function parseMeminfo(text: string): LinuxMemory | undefined {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? (Number(m[1]) * 1024) / GB : undefined;
  };
  const availableGb = kb("MemAvailable");
  if (availableGb === undefined) return undefined;
  return { availableGb: round(availableGb), cachedGb: round(kb("Cached") ?? 0) };
}

export function parseWindowsMemory(text: string): WindowsMemory | undefined {
  try {
    const j = JSON.parse(text) as { availableGb?: unknown; engineGb?: unknown; totalGb?: unknown };
    if (typeof j.availableGb !== "number" || !Number.isFinite(j.availableGb)) return undefined;
    const engineGb = typeof j.engineGb === "number" && j.engineGb > 0 ? j.engineGb : 0;
    const totalGb = typeof j.totalGb === "number" && j.totalGb > 0 ? j.totalGb : undefined;
    return { availableGb: j.availableGb, engineGb, ...(totalGb && { totalGb }) };
  } catch {
    return undefined;
  }
}

/**
 * The RAM the engine may count on for a model, in GB. The Windows engine reads its model on
 * Windows: what Windows has free, plus what the engine itself holds (its old model leaves). The
 * engines in Docker read inside the distribution: what it has free, but never more than Windows
 * can still give it (its own cache included). Unknown: 60 % of the total, as before.
 */
export function usableRamGb(o: {
  windowsEngine: boolean;
  totalGb: number;
  linux?: LinuxMemory | undefined;
  windows?: WindowsMemory | undefined;
}): { gb: number; measured: boolean } {
  if (o.windowsEngine) {
    if (o.windows) return { gb: round(o.windows.availableGb + o.windows.engineGb), measured: true };
    return { gb: round(o.totalGb * 0.6), measured: false };
  }
  if (o.linux) {
    const gb = o.windows
      ? Math.min(o.linux.availableGb, o.windows.availableGb + o.linux.cachedGb)
      : o.linux.availableGb;
    return { gb: round(gb), measured: true };
  }
  return { gb: round(o.totalGb * 0.6), measured: false };
}

/** What the launcher wrote, when it is recent (the launcher writes every five seconds). */
export async function readWindowsMemory(
  dir: string | undefined,
): Promise<WindowsMemory | undefined> {
  if (!dir) return undefined;
  const file = join(dir, "memory.json");
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs > 60_000) return undefined;
    return parseWindowsMemory(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readLinuxMemory(): Promise<LinuxMemory | undefined> {
  return parseMeminfo(await readFile("/proc/meminfo", "utf8").catch(() => ""));
}
