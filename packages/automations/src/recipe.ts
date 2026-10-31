import { Recipe } from "@redgiant/protocol";
import { Cron } from "croner";
import { parse, YAMLParseError } from "yaml";

export class RecipeError extends Error {}

/** Reads a recipe from YAML; every problem is reported in one error, by field. */
export function parseRecipe(yaml: string): Recipe {
  let raw: unknown;
  try {
    raw = parse(yaml, { prettyErrors: true });
  } catch (err) {
    throw new RecipeError(
      err instanceof YAMLParseError ? `YAML: ${err.message}` : (err as Error).message,
    );
  }
  const r = Recipe.safeParse(raw);
  if (!r.success) {
    throw new RecipeError(
      r.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`).join("; "),
    );
  }
  if (r.data.on.cron) nextRun(r.data, new Date()); // throws on a bad expression or time zone
  return r.data;
}

/** The first scheduled time strictly after `after`, or null for webhook-only recipes. */
export function nextRun(recipe: Recipe, after: Date): Date | null {
  if (!recipe.on.cron) return null;
  try {
    const cron = new Cron(recipe.on.cron, {
      paused: true,
      mode: "5-or-6-parts",
      ...(recipe.on.timezone && { timezone: recipe.on.timezone }),
    });
    return cron.nextRun(after);
  } catch (err) {
    throw new RecipeError(`on: ${(err as Error).message.replace(/^\w+: /, "")}`);
  }
}
