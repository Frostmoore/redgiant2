// The models catalog in use (3.5.4): the copy built into RedGiant until the server applies a
// newer signed one (`applyCatalog`, after checking its signature: this package never trusts a
// catalog by itself). Providers read their models' limits and prices from here.
import type { CatalogModel, ModelsCatalog } from "@redgiant/protocol";
import { BUILTIN_CATALOG } from "./catalog-data.js";
import type { Pricing } from "./types.js";

let active: ModelsCatalog = BUILTIN_CATALOG;

/** The catalog in use now. */
export function modelsCatalog(): ModelsCatalog {
  return active;
}

/**
 * Uses `catalog` from now on (already checked: signed and valid). An older version than the one
 * in use is refused (false): a copied old file cannot bring back old prices.
 */
export function applyCatalog(catalog: ModelsCatalog): boolean {
  if (catalog.version < active.version) return false;
  active = catalog;
  return true;
}

/** Back to the built-in copy (tests). */
export function resetCatalog(): void {
  active = BUILTIN_CATALOG;
}

/** One model's data, or undefined when the catalog does not know it. */
export function catalogModel(provider: string, model: string): CatalogModel | undefined {
  const models = active.providers[provider]?.models;
  return models && Object.hasOwn(models, model) ? models[model] : undefined;
}

/** A provider's models in the catalog's order. */
export function catalogModels(provider: string): [string, CatalogModel][] {
  return Object.entries(active.providers[provider]?.models ?? {});
}

/** The newest release day the catalog knows for a provider (models released later are new). */
export function newestRelease(provider: string): string | undefined {
  let newest: string | undefined;
  for (const [, m] of catalogModels(provider))
    if (m.released && (!newest || m.released > newest)) newest = m.released;
  return newest;
}

/** A catalog model's prices as the providers count them. */
export function catalogPricing(m: CatalogModel | undefined): Pricing | undefined {
  return m?.pricing ? { ...m.pricing } : undefined;
}

/** Days a model counts as "new" in the menus after its release. */
export const NEW_FOR_DAYS = 30;

/** "new" for a model released in the last weeks, per the catalog. */
export function isNewModel(m: CatalogModel | undefined, now = Date.now()): boolean {
  if (!m?.released) return false;
  const at = Date.parse(`${m.released}T00:00:00Z`);
  return Number.isFinite(at) && now - at >= 0 && now - at < NEW_FOR_DAYS * 86_400_000;
}
