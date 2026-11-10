// The models catalog downloaded from GitHub (3.5.4): used only with a valid signature of the
// update key, only when newer, kept in the data folder and checked again when read.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelsCatalog } from "@redgiant/protocol";
import { modelsCatalog, resetCatalog } from "@redgiant/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG_URL, CatalogWatcher, verifyCatalog } from "../src/models-catalog.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUB = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const signed = (c: unknown, key = keys.privateKey) => {
  const bytes = Buffer.from(JSON.stringify(c));
  return { bytes, sig: sign("sha256", bytes, key).toString("base64") };
};

/** A catalog newer than the built-in one, with a model only it knows. */
const newer = (bump = 1): ModelsCatalog => {
  const c = structuredClone(modelsCatalog());
  c.version += bump;
  c.updatedAt = "2026-12-01";
  const anthropic = c.providers.anthropic;
  if (!anthropic) throw new Error("no anthropic");
  anthropic.models["claude-nova-6"] = {
    name: "Claude Nova 6",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    effort: true,
    adaptiveThinking: true,
    vision: true,
    pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
    status: "current",
    released: "2026-12-01",
  };
  return c;
};

/** GitHub answering the fixed pre-release's two files. */
const github = (files: Record<string, string | Buffer | null>) => {
  const asked: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const body = files[url];
    return body == null ? new Response("no", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetch: f, asked };
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-catalog-"));
  resetCatalog();
});
afterEach(async () => {
  resetCatalog();
  await rm(dir, { recursive: true, force: true });
});

describe("models catalog downloads", () => {
  it("applies a newer catalog with a valid signature and keeps it for the next start", async () => {
    const c = newer();
    const { bytes, sig } = signed(c);
    const gh = github({ [CATALOG_URL]: bytes, [`${CATALOG_URL}.sig`]: sig });
    const w = new CatalogWatcher({ dataDir: dir, fetch: gh.fetch, publicKey: PUB, feed: null });
    const s = await w.check();
    expect(s).toMatchObject({ version: c.version, source: "downloaded", updatedAt: "2026-12-01" });
    expect(modelsCatalog().providers.anthropic?.models["claude-nova-6"]?.name).toBe(
      "Claude Nova 6",
    );
    // After a restart (the built-in copy again), the kept one is checked and used, offline.
    resetCatalog();
    const offline = new CatalogWatcher({
      dataDir: dir,
      fetch: github({}).fetch,
      publicKey: PUB,
      feed: null,
    });
    await offline.loadStored();
    expect(offline.status()).toMatchObject({ version: c.version, source: "downloaded" });
  });

  it("never uses a catalog without a valid signature", async () => {
    const before = modelsCatalog().version;
    const { bytes } = signed(newer());
    const forged = signed(newer(), other.privateKey).sig;
    const gh = github({ [CATALOG_URL]: bytes, [`${CATALOG_URL}.sig`]: forged });
    const w = new CatalogWatcher({ dataDir: dir, fetch: gh.fetch, publicKey: PUB, feed: null });
    expect(await w.check()).toMatchObject({
      version: before,
      source: "builtin",
      problem: "unsigned",
    });
    // A file changed after signing fails too.
    const good = signed(newer());
    const tampered = Buffer.from(good.bytes.toString().replace('"input":1', '"input":0'));
    expect(verifyCatalog(tampered, good.sig, PUB)).toBeNull();
    expect(verifyCatalog(good.bytes, good.sig, PUB)?.version).toBe(before + 1);
    // No key at all: nothing is trusted.
    expect(verifyCatalog(good.bytes, good.sig, "")).toBeNull();
  });

  it("ignores an older or equal version, and says when GitHub does not answer", async () => {
    const same = structuredClone(modelsCatalog());
    const { bytes, sig } = signed(same);
    const gh = github({ [CATALOG_URL]: bytes, [`${CATALOG_URL}.sig`]: sig });
    const w = new CatalogWatcher({ dataDir: dir, fetch: gh.fetch, publicKey: PUB, feed: null });
    expect(await w.check()).toMatchObject({ source: "builtin" });
    const down = new CatalogWatcher({
      dataDir: dir,
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
      publicKey: PUB,
      feed: null,
    });
    expect(await down.check()).toMatchObject({ source: "builtin", problem: "unreachable" });
  });

  it("also looks at the latest release's copy and takes the highest version", async () => {
    const fixed = signed(newer(1));
    const rel = signed(newer(2));
    const feed = "https://api.example/releases/latest";
    const gh = github({
      [CATALOG_URL]: fixed.bytes,
      [`${CATALOG_URL}.sig`]: fixed.sig,
      [feed]: JSON.stringify({
        tag_name: "v3.5.4",
        assets: [
          { name: "models-catalog.json", browser_download_url: "https://dl/models-catalog.json" },
          {
            name: "models-catalog.json.sig",
            browser_download_url: "https://dl/models-catalog.json.sig",
          },
        ],
      }),
      "https://dl/models-catalog.json": rel.bytes,
      "https://dl/models-catalog.json.sig": rel.sig,
    });
    const w = new CatalogWatcher({ dataDir: dir, fetch: gh.fetch, publicKey: PUB, feed });
    const base = modelsCatalog().version;
    expect((await w.check()).version).toBe(base + 2);
  });
});
