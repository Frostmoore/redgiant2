// The models catalog, kept up to date (3.5.4, decision of 2026-11-10). At start and every day the
// server downloads the newest signed catalog and, when its signature (the update key, the same
// as `release.json`'s) and its content check out and it is newer than the one in use, applies
// it: new models get their names, limits and prices without a new RedGiant. Without a valid
// signature nothing is used. The catalog built into RedGiant stays the fallback.
//
// Where from: first the fixed pre-release `models-catalog` (published by models-catalog.yml as
// soon as the catalog changes on main, without waiting for a version), then the latest release's
// copy (attached by release.yml). The highest valid version wins. The last good one is kept in
// the data folder (with its signature, checked again when read) so a restart without network
// keeps it.
import { verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MODELS_CATALOG_ASSET,
  MODELS_CATALOG_TAG,
  ModelsCatalog,
  type ModelsCatalogStatus,
} from "@redgiant/protocol";
import { applyCatalog, modelsCatalog } from "@redgiant/providers";
import { debugLog } from "./debug-log.js";
import { RELEASE_PUBLIC_KEY } from "./release-key.js";
import { LATEST_RELEASE } from "./updates.js";

const REPO_DOWNLOADS = "https://github.com/Frostmoore/redgiant2/releases/download";
/** The fixed pre-release's copy: updated without a release. */
export const CATALOG_URL = `${REPO_DOWNLOADS}/${MODELS_CATALOG_TAG}/${MODELS_CATALOG_ASSET}`;
export const CATALOG_EVERY_MS = 24 * 60 * 60 * 1000;
const STORED = "models-catalog.json";

/** The catalog in `bytes` if `signature` is the key's signature of exactly them; null otherwise. */
export function verifyCatalog(
  bytes: Buffer,
  signature: string,
  publicPem: string = RELEASE_PUBLIC_KEY,
): ModelsCatalog | null {
  if (!publicPem.trim()) return null;
  try {
    if (!verify("sha256", bytes, publicPem, Buffer.from(signature.trim(), "base64"))) return null;
    const parsed = ModelsCatalog.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface CatalogWatcherOptions {
  dataDir: string;
  fetch?: typeof fetch;
  publicKey?: string;
  /** The places to look, in order (default: the fixed pre-release, then the latest release). */
  sources?: { url: string; sig: string }[] | undefined;
  /** The latest release's API answer (default GitHub's); null: do not look there. */
  feed?: string | null;
  now?: () => Date;
  everyMs?: number;
  /** Applies a checked catalog (default: the providers' `applyCatalog`). */
  apply?: (c: ModelsCatalog) => boolean;
  current?: () => ModelsCatalog;
}

export class CatalogWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<ModelsCatalogStatus> | undefined;
  private source: "builtin" | "downloaded" = "builtin";
  private checkedAt: string | null = null;
  private problem: ModelsCatalogStatus["problem"];

  constructor(private readonly o: CatalogWatcherOptions) {}

  private current(): ModelsCatalog {
    return (this.o.current ?? modelsCatalog)();
  }

  private apply(c: ModelsCatalog): boolean {
    return (this.o.apply ?? applyCatalog)(c);
  }

  status(): ModelsCatalogStatus {
    const c = this.current();
    return {
      version: c.version,
      updatedAt: c.updatedAt,
      source: this.source,
      checkedAt: this.checkedAt,
      ...(this.problem && { problem: this.problem }),
    };
  }

  /** The copy kept from an earlier run, checked again; then a look now and every day. */
  async start(): Promise<void> {
    await this.loadStored();
    if (this.timer) return;
    this.first = setTimeout(() => void this.check(), 10_000);
    this.first.unref?.();
    this.timer = setInterval(() => void this.check(), this.o.everyMs ?? CATALOG_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async loadStored(): Promise<void> {
    try {
      const bytes = await readFile(join(this.o.dataDir, STORED));
      const sig = await readFile(join(this.o.dataDir, `${STORED}.sig`), "utf8");
      const c = verifyCatalog(bytes, sig, this.o.publicKey);
      if (c && c.version > this.current().version && this.apply(c)) this.source = "downloaded";
    } catch {
      // Nothing kept yet.
    }
  }

  /** Looks now; one look at a time. Never throws. */
  check(): Promise<ModelsCatalogStatus> {
    this.running ??= this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async sources(get: (url: string) => Promise<Response>) {
    const out = [...(this.o.sources ?? [{ url: CATALOG_URL, sig: `${CATALOG_URL}.sig` }])];
    const feed = this.o.feed === undefined ? LATEST_RELEASE : this.o.feed;
    if (feed && !this.o.sources) {
      try {
        const r = await get(feed);
        if (r.ok) {
          const rel = (await r.json()) as {
            assets?: { name?: string; browser_download_url?: string }[];
          };
          const url = (n: string) => rel.assets?.find((a) => a.name === n)?.browser_download_url;
          const a = url(MODELS_CATALOG_ASSET);
          const b = url(`${MODELS_CATALOG_ASSET}.sig`);
          if (a && b) out.push({ url: a, sig: b });
        }
      } catch {
        // The fixed copy is enough.
      }
    }
    return out;
  }

  private async look(): Promise<ModelsCatalogStatus> {
    const f = this.o.fetch ?? fetch;
    const get = (url: string) =>
      f(url, { headers: { "user-agent": "RedGiant" }, signal: AbortSignal.timeout(15_000) });
    let best: { catalog: ModelsCatalog; bytes: Buffer; sig: string } | undefined;
    let reached = false;
    let unsigned = false;
    for (const s of await this.sources(get)) {
      try {
        const [a, b] = await Promise.all([get(s.url), get(s.sig)]);
        if (!a.ok || !b.ok) continue;
        reached = true;
        const bytes = Buffer.from(await a.arrayBuffer());
        const sig = await b.text();
        const c = verifyCatalog(bytes, sig, this.o.publicKey);
        if (!c) {
          unsigned = true;
          debugLog.write("models", `catalog at ${s.url} is not validly signed: not used`);
          continue;
        }
        if (!best || c.version > best.catalog.version) best = { catalog: c, bytes, sig };
      } catch {
        // Unreachable: the next place.
      }
    }
    this.checkedAt = (this.o.now ?? (() => new Date()))().toISOString();
    this.problem = best ? undefined : !reached ? "unreachable" : unsigned ? "unsigned" : undefined;
    if (best && best.catalog.version > this.current().version && this.apply(best.catalog)) {
      this.source = "downloaded";
      debugLog.write("models", `models catalog ${best.catalog.version} in use`);
      await mkdir(this.o.dataDir, { recursive: true }).catch(() => {});
      await writeFile(join(this.o.dataDir, STORED), best.bytes).catch(() => {});
      await writeFile(join(this.o.dataDir, `${STORED}.sig`), best.sig).catch(() => {});
    }
    return this.status();
  }
}
