// Hands-free voice (G38.4): the wake word is heard in the browser, never here. The page runs Vosk
// (Apache-2.0) in WASM with a small speech model (Apache-2.0) and a grammar limited to the wake
// phrase, so «Ehi RedGiant» works without a trained model and no audio leaves the page before it.
// The model comes down once into the data folder, as a job with its bar, and is handed to the page
// as the `.tar.gz` (one folder on top) that vosk-browser unpacks into its own storage.
//
// Why not openWakeWord: its code is Apache-2.0, but every pre-trained model (hey jarvis, alexa…)
// is CC BY-NC-SA 4.0 (2026-11-12). Porcupine needs an account and a licence key.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Job } from "@redgiant/protocol";
import { unzipSync } from "fflate";
import type { JobHandle, Jobs } from "./jobs.js";

/** The small models, Apache-2.0 both (alphacephei.com/vosk/models), 40-48 MB as zip. */
export const WAKE_MODELS = {
  it: "vosk-model-small-it-0.22",
  en: "vosk-model-small-en-us-0.15",
} as const;
export type WakeLang = keyof typeof WAKE_MODELS;

export const isWakeLang = (l: string | undefined): l is WakeLang =>
  l !== undefined && Object.hasOwn(WAKE_MODELS, l);

/** The file names the page may ask for (the open route serves these and nothing else). */
export const wakeFile = (lang: WakeLang) => `${WAKE_MODELS[lang]}.tar.gz`;

/** A tar archive (ustar) of these entries, in this order: folders end with "/". */
export function tar(entries: [string, Uint8Array | null][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of entries) {
    const h = new Uint8Array(512);
    const put = (at: number, s: string) => h.set(enc.encode(s), at);
    const octal = (at: number, len: number, n: number) =>
      put(at, `${n.toString(8).padStart(len - 1, "0")}\0`);
    const path = enc.encode(name);
    if (path.length > 100) {
      // Longer names go in the prefix field, split at a slash.
      const cut = name.lastIndexOf("/", name.length - 2);
      if (cut < 0 || cut > 155 || name.length - cut - 1 > 100)
        throw new Error(`Name too long: ${name}`);
      put(0, name.slice(cut + 1));
      put(345, name.slice(0, cut));
    } else put(0, name);
    const dir = data === null;
    octal(100, 8, dir ? 0o755 : 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, dir ? 0 : data.length);
    octal(136, 12, 0);
    h[156] = dir ? 0x35 : 0x30;
    put(257, "ustar\0");
    put(263, "00");
    // The checksum counts its own field as spaces.
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h);
    if (data && data.length > 0) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** A zip (as alphacephei publishes the models) as the `.tar.gz` vosk-browser reads. */
export function zipToTarGz(zip: Uint8Array): Uint8Array {
  const files = unzipSync(zip);
  const entries: [string, Uint8Array | null][] = Object.keys(files)
    .sort()
    .map((name) => [name, name.endsWith("/") ? null : (files[name] as Uint8Array)]);
  if (!entries.some(([n]) => n.endsWith("/am/final.mdl")))
    throw new Error("The archive is not a Vosk model");
  return gzipSync(tar(entries), { level: 6 });
}

export class WakeModels {
  constructor(
    private readonly dataDir: string,
    private readonly o: { fetch?: typeof fetch; baseUrl?: string } = {},
  ) {}

  path(lang: WakeLang): string {
    return join(this.dataDir, "tools", "vosk", wakeFile(lang));
  }

  /** The model is here, and how big it is (what the page downloads). */
  async state(lang: WakeLang): Promise<{ ready: boolean; file: string; size: number | null }> {
    const s = await stat(this.path(lang)).catch(() => undefined);
    return { ready: Boolean(s?.isFile()), file: wakeFile(lang), size: s?.size ?? null };
  }

  private running = new Map<WakeLang, string>();

  /** Downloads and prepares the model as a job with its bar; undefined when it is here already. */
  ensure(jobs: Jobs, owner: string, lang: WakeLang): Job | undefined {
    if (existsSync(this.path(lang))) return undefined;
    const now = this.running.get(lang);
    const same = now ? jobs.get(owner, now) : undefined;
    if (same?.state === "running") return same;
    const job = jobs.start(
      owner,
      "download_wake_model",
      ["model_download", "model_prepare"],
      async (h) => {
        h.step("model_download");
        const zip = await this.download(lang, h);
        h.step("model_prepare");
        const out = this.path(lang);
        await mkdir(join(this.dataDir, "tools", "vosk"), { recursive: true });
        await writeFile(`${out}.part`, zipToTarGz(zip));
        await rename(`${out}.part`, out);
      },
      { lang },
    );
    this.running.set(lang, job.id);
    return job;
  }

  private async download(lang: WakeLang, h: JobHandle): Promise<Uint8Array> {
    const base = (this.o.baseUrl ?? "https://alphacephei.com/vosk/models").replace(/\/+$/, "");
    const r = await (this.o.fetch ?? fetch)(`${base}/${WAKE_MODELS[lang]}.zip`, {
      signal: h.signal,
    });
    if (!r.ok || !r.body) throw new Error(`The model's address answered ${r.status}`);
    const total = Number(r.headers.get("content-length")) || null;
    const parts: Uint8Array[] = [];
    let done = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      parts.push(value);
      done += value.length;
      h.progress(done, total);
    }
    const zip = new Uint8Array(done);
    let at = 0;
    for (const p of parts) {
      zip.set(p, at);
      at += p.length;
    }
    return zip;
  }

  /** The prepared file, for the page. */
  read(lang: WakeLang): Promise<Buffer> {
    return readFile(this.path(lang));
  }

  remove(lang: WakeLang): Promise<void> {
    return rm(this.path(lang), { force: true });
  }
}
