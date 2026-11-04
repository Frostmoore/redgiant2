// The model read once before the engine starts (2026-11-04). The engine maps the file and reads
// a piece only when a token needs it: right after an activation most of a big model is still on
// the disk, and the first real message waits for it (gpt-oss 120B: 2,600 tokens read in two
// minutes, the next message in two seconds). Reading the whole file in one sequential pass,
// with a bar, leaves it in the system's cache, where the engine finds it.
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitPart } from "./hf.js";
import type { JobHandle } from "./jobs.js";

/** Every file of a model: one, or all the parts of a split one. */
export function modelParts(dir: string, model: string): string[] {
  const sp = splitPart(model);
  if (!sp) return [join(dir, model)];
  return Array.from({ length: sp.of }, (_, i) =>
    join(
      dir,
      `${sp.base}-${String(i + 1).padStart(5, "0")}-of-${String(sp.of).padStart(5, "0")}.gguf`,
    ),
  );
}

/** The model's size in GB, all parts together. */
export async function modelGb(dir: string, model: string): Promise<number> {
  let bytes = 0;
  for (const p of modelParts(dir, model)) bytes += (await stat(p)).size;
  return bytes / 1024 ** 3;
}

/**
 * Reads the files from start to end, the progress in bytes on `h` when there is one. Returns
 * how fast it went, in GB a second, for the page to show.
 */
export async function preloadFiles(
  paths: string[],
  h?: Pick<JobHandle, "progress" | "signal">,
): Promise<number> {
  const sizes = await Promise.all(paths.map(async (p) => (await stat(p)).size));
  const total = sizes.reduce((a, b) => a + b, 0);
  const buffer = Buffer.allocUnsafe(16 * 1024 * 1024);
  const started = Date.now();
  let done = 0;
  let shown = 0;
  for (const path of paths) {
    const file = await open(path, "r");
    try {
      for (;;) {
        if (h?.signal.aborted) throw new Error("cancelled");
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        done += bytesRead;
        if (h && Date.now() - shown > 250) {
          h.progress(done, total);
          shown = Date.now();
        }
      }
    } finally {
      await file.close();
    }
  }
  h?.progress(total, total);
  const seconds = Math.max((Date.now() - started) / 1000, 0.001);
  return Math.round((total / 1024 ** 3 / seconds) * 10) / 10;
}
