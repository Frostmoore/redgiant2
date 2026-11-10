// The models catalog (3.5.4, decision of 2026-11-10 «I modelli nuovi arrivano senza aspettare una
// versione»): for each provider and model, its shown name, context, output limit, thinking and
// effort, vision and prices. One copy is built into RedGiant (the fallback); the signed copy
// published on GitHub (`packaging/models/catalog.json`, signed with the update key like
// `release.json`) replaces it as soon as it is downloaded and its signature checks out, so new
// models and new prices arrive without a new version. Data only from official sources.
import { z } from "zod";

/** USD per million tokens. */
export const CatalogPriceSet = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  /** Cache writes with the default (5-minute) lifetime. */
  cacheWrite: z.number().nonnegative(),
  /** Cache writes that last one hour. */
  cacheWrite1h: z.number().nonnegative().optional(),
});
export type CatalogPriceSet = z.infer<typeof CatalogPriceSet>;

export const CatalogPricing = CatalogPriceSet.extend({
  /** A prompt over `overTokens` (all input tokens) pays these prices for all its tokens. */
  longPrompt: z
    .object({ overTokens: z.number().int().positive(), prices: CatalogPriceSet })
    .optional(),
});
export type CatalogPricing = z.infer<typeof CatalogPricing>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CatalogModel = z.object({
  /** As people say it: "Claude Fable 5.2". */
  name: z.string().min(1).max(80),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** It takes an effort level. */
  effort: z.boolean(),
  /** Adaptive thinking is asked for explicitly (some models run without it when omitted). */
  adaptiveThinking: z.boolean(),
  vision: z.boolean(),
  /** Anthropic's server-side fallback on a refusal (`fallbacks: "default"`). */
  serverFallback: z.boolean().optional(),
  /** Absent: prices not known (costs are shown as unknown, never as zero). */
  pricing: CatalogPricing.optional(),
  /** "current": offered in the menus; "legacy": still works when named, not offered. */
  status: z.enum(["current", "legacy"]),
  /** The day it was released, when the source says it. */
  released: Day.optional(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const ModelsCatalog = z.object({
  format: z.literal(1),
  /** Grows with every published change: an older catalog never replaces a newer one. */
  version: z.number().int().positive(),
  updatedAt: Day,
  providers: z.record(
    z.string(),
    z.object({
      /** Where the data was read (official pages). */
      sources: z.array(z.string().url()).default([]),
      /** In the order the menus show them. */
      models: z.record(z.string(), CatalogModel),
    }),
  ),
});
export type ModelsCatalog = z.infer<typeof ModelsCatalog>;

/** What Settings shows of the catalog in use. */
export interface ModelsCatalogStatus {
  version: number;
  updatedAt: string;
  /** "builtin": the copy inside this RedGiant; "downloaded": a signed newer one. */
  source: "builtin" | "downloaded";
  /** Last look at GitHub (null: not yet). */
  checkedAt: string | null;
  /** The last look failed (unreachable, or no valid signature). */
  problem?: "unreachable" | "unsigned" | undefined;
}

/** The release asset names, and the fixed pre-release where a newer catalog is published. */
export const MODELS_CATALOG_ASSET = "models-catalog.json";
export const MODELS_CATALOG_TAG = "models-catalog";
