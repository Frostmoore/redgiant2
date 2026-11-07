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

/** How far a schedule looks for a time its conditions allow before giving up for now. */
const LOOKAHEAD = 5000;

/**
 * The first scheduled time strictly after `after` that the recipe's time conditions allow
 * (G33.3), or null for recipes without a schedule. When no allowed time comes soon, the next
 * raw one is returned: at that time the conditions are checked again and it is skipped.
 */
export function nextRun(recipe: Recipe, after: Date): Date | null {
  if (recipe.on.at) {
    const when = atTime(recipe);
    return when > after ? when : null;
  }
  if (!recipe.on.cron) return null;
  let cron: Cron;
  try {
    cron = new Cron(recipe.on.cron, {
      paused: true,
      mode: "5-or-6-parts",
      ...(recipe.on.timezone && { timezone: recipe.on.timezone }),
    });
  } catch (err) {
    throw new RecipeError(`on: ${(err as Error).message.replace(/^\w+: /, "")}`);
  }
  const first = cron.nextRun(after);
  if (!first || !recipe.only) return first;
  let at: Date | null = first;
  for (let i = 0; at && i < LOOKAHEAD; i++) {
    if (timeAllowed(recipe, at)) return at;
    at = cron.nextRun(at);
  }
  return first;
}

/** The next `count` times a recipe runs on its schedule (the preview in the editor). */
export function nextRuns(recipe: Recipe, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let from = after;
  while (out.length < count) {
    const at = nextRun(recipe, from);
    if (!at || !timeAllowed(recipe, at)) break;
    out.push(at);
    from = at;
  }
  return out;
}

/** The day, weekday and minute of the day of a moment, in a time zone. */
export function localTime(
  at: Date,
  timezone: string | undefined,
): { day: string; weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timezone && { timeZone: timezone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    weekday,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const minutes = (hm: string) => {
  const [h = "0", m = "0"] = hm.split(":");
  return Number(h) * 60 + Number(m);
};

/** Whether the recipe's hours, days and dates allow a start at this moment. */
export function timeAllowed(recipe: Recipe, at: Date): boolean {
  const only = recipe.only;
  if (!only) return true;
  const t = localTime(at, recipe.on.timezone);
  if (only.days && !only.days.includes(t.weekday)) return false;
  if (only.dates?.from && t.day < only.dates.from) return false;
  if (only.dates?.to && t.day > only.dates.to) return false;
  if (only.hours) {
    const from = minutes(only.hours.from);
    const to = minutes(only.hours.to);
    // "22:00 to 06:00" crosses midnight.
    const inside =
      from <= to ? t.minute >= from && t.minute <= to : t.minute >= from || t.minute <= to;
    if (!inside) return false;
  }
  return true;
}

/** What an event says about itself, for the conditions on senders and words. */
export interface EventFacts {
  from?: string;
  text?: string;
}

const lower = (s: string) => s.toLowerCase();

/** Whether the recipe's conditions on senders and words hold for an event (G33.3). */
export function factsAllowed(recipe: Recipe, facts: EventFacts): boolean {
  const only = recipe.only;
  if (!only) return true;
  const from = lower(facts.from ?? "");
  const text = lower(facts.text ?? "");
  if (only.from && !only.from.some((f) => from.includes(lower(f)))) return false;
  if (only.words) {
    const has = (w: string) => text.includes(lower(w));
    if (only.match === "all" ? !only.words.every(has) : !only.words.some(has)) return false;
  }
  if (only.without?.some((w) => text.includes(lower(w)))) return false;
  return true;
}
