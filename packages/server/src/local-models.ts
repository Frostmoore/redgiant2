// The suggested local models for this computer (G24.3): for each one, the best file that fits
// (`suggest`), its quality in words, or why none fits.
import { LOCAL_MODELS, type LocalModel } from "@redgiant/protocol";
import { type GgufFile, type HuggingFace, offered, qualityOf, suggest } from "./hf.js";

export interface LocalModelChoice extends LocalModel {
  /** The best file that fits, with its size and quality; none if even the smallest is too big. */
  file: (GgufFile & { quality: "high" | "good" | "reduced" }) | null;
  /** The smallest file worth offering, to say how much room it would need. */
  smallestGb: number | null;
  /** Hugging Face could not be asked (offline): the card says so. */
  unavailable?: boolean;
}

export async function localModelChoices(
  hf: HuggingFace,
  budgetGb: number,
): Promise<LocalModelChoice[]> {
  return Promise.all(
    LOCAL_MODELS.map(async (m) => {
      try {
        const files = await hf.files(m.repo);
        const best = suggest(files, budgetGb);
        return {
          ...m,
          file: best ? { ...best, quality: qualityOf(best.quant) } : null,
          smallestGb: files.find(offered)?.sizeGb ?? null,
        };
      } catch {
        return { ...m, file: null, smallestGb: null, unavailable: true };
      }
    }),
  );
}
