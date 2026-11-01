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
  // A one-shot time missed while the server was down still matters: it runs late by default.
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { on?: { at?: unknown } }).on?.at !== undefined &&
    (raw as { missed?: unknown }).missed === undefined
  )
    (raw as { missed?: string }).missed = "run";
  const r = Recipe.safeParse(raw);
  if (!r.success) {
    throw new RecipeError(
      r.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`).join("; "),
    );
  }
  if (r.data.on.cron) nextRun(r.data, new Date()); // throws on a bad expression or time zone
  if (r.data.on.at) atTime(r.data); // throws on a bad date
  return r.data;
}

/** The moment of a one-shot recipe (`on.at`), in its time zone when it has no offset. */
export function atTime(recipe: Recipe): Date {
  const at = recipe.on.at ?? "";
  try {
    const once = new Cron(at, {
      paused: true,
      ...(recipe.on.timezone && { timezone: recipe.on.timezone }),
    });
    const when = once.nextRun(new Date(0));
    if (!when) throw new Error("not a date");
    return when;
  } catch (err) {
    throw new RecipeError(
      `on.at: "${at}" is not a date and time (use e.g. 2026-11-02T09:00): ${(err as Error).message.replace(/^\w+: /, "")}`,
    );
  }
}

/** The first scheduled time strictly after `after`, or null for webhook-only recipes. */
export function nextRun(recipe: Recipe, after: Date): Date | null {
  if (recipe.on.at) {
    const when = atTime(recipe);
    return when > after ? when : null;
  }
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
