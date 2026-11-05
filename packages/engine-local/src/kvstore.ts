import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest } from "@redgiant/providers";

/**
 * One saved KV cache (a llama.cpp slot file) and what it contains. Inspired by DwarfStar 4:
 * checkpoints are found by prefix, carry compatibility data, and are evicted by a score
 * of hits and recency within a byte budget.
 */
export interface KvEntry {
  file: string;
  scope: string;
  sessionId: string;
  /** Compatibility: a file is only restored into the same model and context size. */
  model: string;
  ctx: number;
  /**
   * Hash of the conversation at each boundary. Version 2 (2026-11-05): index 0 is the start
   * alone (system and tools), index k ⇒ the start and the first k messages. Without `v`: the
   * older form, index k ⇒ the first k+1 messages (no hash of the start alone).
   */
  prefixHashes: string[];
  v?: 2;
  tokens: number;
  bytes: number;
  reason: "turn" | "evict" | "shutdown";
  hits: number;
  createdAt: string;
  lastUsedAt: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Cumulative hashes of the request at every message boundary: system and tools first
 * (they lead the rendered prompt), then each message. Two requests share a prefix up to
 * the last index where their hashes agree.
 */
export function prefixHashes(
  request: Pick<CompletionRequest, "system" | "tools" | "messages">,
): string[] {
  let h = sha(JSON.stringify({ system: request.system, tools: request.tools }));
  // The start alone first (2026-11-05): a new conversation of the same agent shares it with
  // the saved ones (3,200 tokens of system and tools for gpt-oss: 50 s on Rig, read again).
  return [
    h,
    ...request.messages.map((m) => {
      h = sha(h + JSON.stringify({ role: m.role, parts: m.parts }));
      return h;
    }),
  ];
}

/** Files llama.cpp accepts: letters, digits, dot, dash, underscore. */
export const kvFileName = (scope: string, sessionId: string) =>
  `${`${scope}__${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_")}.bin`;

const HALF_LIFE_MS = 6 * 3600_000;

/** Higher is more worth keeping: hits, decaying with age (half-life 6 hours, as in ds4). */
export function score(e: KvEntry, now = Date.now()): number {
  const age = Math.max(0, now - Date.parse(e.lastUsedAt));
  return (1 + e.hits) * 0.5 ** (age / HALF_LIFE_MS);
}

/** Manifests live next to the slot files (`<name>.bin.json`), in the engine's save directory. */
export class KvStore {
  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private manifest(file: string) {
    return join(this.dir, `${file}.json`);
  }

  async list(): Promise<KvEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: KvEntry[] = [];
    for (const n of names.filter((x) => x.endsWith(".bin.json"))) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, n), "utf8")) as KvEntry);
      } catch {
        // a manifest being written, or damaged: ignored
      }
    }
    return out;
  }

  /** Records a slot file that the engine just wrote. */
  async put(
    entry: Omit<KvEntry, "bytes" | "hits" | "createdAt" | "lastUsedAt"> &
      Partial<Pick<KvEntry, "hits" | "createdAt">>,
  ): Promise<KvEntry> {
    const bytes = (await stat(join(this.dir, entry.file)).catch(() => undefined))?.size ?? 0;
    const at = new Date(this.now()).toISOString();
    const full: KvEntry = { hits: 0, createdAt: at, ...entry, bytes, lastUsedAt: at };
    await writeFile(this.manifest(entry.file), JSON.stringify(full));
    return full;
  }

  /** The compatible entry sharing the longest prefix with `hashes` (and how long it is). */
  async find(o: {
    scope: string;
    model: string;
    ctx: number;
    hashes: string[];
  }): Promise<{ entry: KvEntry; messages: number } | undefined> {
    let best: { entry: KvEntry; messages: number } | undefined;
    for (const e of await this.list()) {
      if (e.scope !== o.scope || e.model !== o.model || e.ctx !== o.ctx) continue;
      // Files saved before the start had a hash of its own are compared the old way.
      const mine = e.v === 2 ? o.hashes : o.hashes.slice(1);
      let k = 0;
      while (k < e.prefixHashes.length && k < mine.length && e.prefixHashes[k] === mine[k]) k++;
      if (e.v !== 2 && k > 0) k++;
      if (
        k > 0 &&
        (!best ||
          k > best.messages ||
          (k === best.messages && e.lastUsedAt > best.entry.lastUsedAt))
      ) {
        best = { entry: e, messages: k };
      }
    }
    return best;
  }

  async touch(entry: KvEntry): Promise<void> {
    await writeFile(
      this.manifest(entry.file),
      JSON.stringify({
        ...entry,
        hits: entry.hits + 1,
        lastUsedAt: new Date(this.now()).toISOString(),
      }),
    );
  }

  async remove(file: string): Promise<void> {
    await rm(join(this.dir, file), { force: true });
    await rm(this.manifest(file), { force: true });
  }

  /** Drops a session's KV cache, keeping its transcript (ds4's `/strip`). */
  async strip(sessionId: string): Promise<number> {
    const victims = (await this.list()).filter((e) => e.sessionId === sessionId);
    for (const v of victims) await this.remove(v.file);
    return victims.length;
  }

  /** Keeps a scope within `budgetBytes`, removing the lowest-scoring files first. */
  async enforceBudget(
    scope: string,
    budgetBytes: number,
    keep: Set<string> = new Set(),
  ): Promise<string[]> {
    const entries = (await this.list()).filter((e) => e.scope === scope);
    let total = entries.reduce((n, e) => n + e.bytes, 0);
    const removed: string[] = [];
    const now = this.now();
    for (const e of entries
      .filter((x) => !keep.has(x.file))
      .sort((a, b) => score(a, now) - score(b, now))) {
      if (total <= budgetBytes) break;
      await this.remove(e.file);
      total -= e.bytes;
      removed.push(e.file);
    }
    return removed;
  }
}
