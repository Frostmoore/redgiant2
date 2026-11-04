// The suggested local models for this computer (G24.3): for each one, the best file that fits
// (`suggest`), its quality in words, or why none fits.
import { LOCAL_MODELS, type LocalModel } from "@redgiant/protocol";
import { type GgufFile, type HuggingFace, offered, qualityOf, suggest } from "./hf.js";

/** Room left on the models' disk after a download beyond memory. */
const DISK_MARGIN_GB = 10;

export interface LocalModelChoice extends LocalModel {
  /** The best file that fits, with its size and quality; none if even the smallest is too big. */
  file: (GgufFile & { quality: "high" | "good" | "reduced" }) | null;
  /** The smallest file worth offering, to say how much room it would need. */
  smallestGb: number | null;
  /** Hugging Face could not be asked (offline): the card says so. */
  unavailable?: boolean;
  /** SSD stream: bigger than RAM and card together, part of it read from the SSD at each token. */
  beyondMemory?: boolean;
}

export async function localModelChoices(
  hf: HuggingFace,
  budgetGb: number,
  /** SSD stream (2026-11-04): a model bigger than memory may still come, if the disk has room. */
  stream?: { diskFreeGb: number },
): Promise<LocalModelChoice[]> {
  return Promise.all(
    LOCAL_MODELS.map(async (m) => {
      try {
        const files = await hf.files(m.repo);
        const best = suggest(files, budgetGb);
        const smallest = files.find(offered);
        // Nothing fits in memory: with SSD stream the smallest good file still runs, reading
        // what does not fit from the SSD (slower, said in the table).
        const beyond =
          !best && stream && smallest && smallest.sizeGb <= stream.diskFreeGb - DISK_MARGIN_GB
            ? smallest
            : undefined;
        const file = best ?? beyond;
        return {
          ...m,
          file: file ? { ...file, quality: qualityOf(file.quant) } : null,
          smallestGb: smallest?.sizeGb ?? null,
          ...(beyond && { beyondMemory: true }),
        };
      } catch {
        return { ...m, file: null, smallestGb: null, unavailable: true };
      }
    }),
  );
}
