// Reading text in pictures and scanned PDFs on this computer (G36.6): Tesseract compiled to
// WebAssembly (tesseract.js, Apache-2.0), so the same program runs on Windows, Mac and Linux with
// nothing native to install. Nothing heavy is shipped: the first time the person turns the OCR
// on, its core (one build, 3.8 MB) and the languages chosen (0.7–3 MB each) come down with their
// bar, checked against the sha256 fixed here. One worker thread, one picture at a time, stopped
// after two minutes without work.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OCR_LANGUAGES } from "@redgiant/protocol";
import Tesseract from "tesseract.js";
import { JobFailure, type Jobs } from "../jobs.js";
import { download } from "./local-embed.js";
import type { OcrEngine } from "./service.js";

/** The core used: SIMD with the LSTM engine only (every Node RedGiant runs on has SIMD). */
export const OCR_CORE = {
  version: "7.0.0",
  file: "tesseract-core-simd-lstm.wasm.js",
  sha256: "c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38",
  sizeKb: 3808,
} as const;

/** The languages' data: Tesseract's «best_int» models, as tesseract.js publishes them. */
export const OCR_DATA = "4.0.0_best_int";

const CDN = "https://cdn.jsdelivr.net/npm";
export const ocrCoreUrl = () => `${CDN}/tesseract.js-core@${OCR_CORE.version}/${OCR_CORE.file}`;
export const ocrLanguageUrl = (id: string) =>
  `${CDN}/@tesseract.js-data/${id}/${OCR_DATA}/${id}.traineddata.gz`;

/** A picture that takes longer than this is given up (the worker is started again). */
const RECOGNIZE_MS = 120_000;

export interface LocalOcrOptions {
  dataDir: string;
  jobs: Jobs;
  /** The worker stops after this long without work (default 2 minutes). */
  idleMs?: number;
}

/** The worker script: built next to this file (`.js`), or the source when run by the tests. */
function workerPath(): string {
  const js = fileURLToPath(new URL("./ocr-worker.js", import.meta.url));
  return existsSync(js) ? js : js.replace(/\.js$/, ".ts");
}

export class LocalOcr implements OcrEngine {
  private worker: Tesseract.Worker | undefined;
  private languages = "";
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private readonly downloads = new Map<string, Promise<void>>();

  constructor(private readonly o: LocalOcrOptions) {}

  get dir() {
    return join(this.o.dataDir, "tools", "ocr");
  }
  get corePath() {
    return join(this.dir, `core-${OCR_CORE.version}`, OCR_CORE.file);
  }
  get langDir() {
    return join(this.dir, `lang-${OCR_DATA}`);
  }
  langPath(id: string) {
    return join(this.langDir, `${id}.traineddata.gz`);
  }

  async ready(languages: string[]): Promise<boolean> {
    return existsSync(this.corePath) && languages.every((l) => existsSync(this.langPath(l)));
  }

  /** What is missing comes down as one job with its bar (`download_ocr`); calls share it. */
  ensure(owner: string, languages: string[]): Promise<void> {
    const key = [...languages].sort().join("+");
    const going = this.downloads.get(key);
    if (going) return going;
    const p = (async () => {
      if (await this.ready(languages)) return;
      const langs = languages.map((id) => {
        const l = OCR_LANGUAGES.find((x) => x.id === id);
        if (!l) throw new JobFailure("unknown_language", `Unknown OCR language ${id}`);
        return l;
      });
      const kb =
        (existsSync(this.corePath) ? 0 : OCR_CORE.sizeKb) +
        langs.filter((l) => !existsSync(this.langPath(l.id))).reduce((n, l) => n + l.sizeKb, 0);
      const job = this.o.jobs.start(
        owner,
        "download_ocr",
        ["ocr_program", "ocr_languages"],
        async (h) => {
          h.step("ocr_program");
          if (!existsSync(this.corePath))
            await download(ocrCoreUrl(), this.corePath, OCR_CORE.sha256, h);
          h.step("ocr_languages");
          for (const l of langs)
            if (!existsSync(this.langPath(l.id)))
              await download(ocrLanguageUrl(l.id), this.langPath(l.id), l.sha256, h);
        },
        {
          languages: langs.map((l) => l.name).join(", "),
          size: `${Math.max(1, Math.round(kb / 1024))} MB`,
        },
      );
      const end = await this.o.jobs.settled(job.id, 500);
      if (end?.state !== "done")
        throw new JobFailure(
          end?.error?.code ?? "download_failed",
          end?.error?.message ?? "The OCR did not download",
        );
    })().finally(() => this.downloads.delete(key));
    this.downloads.set(key, p);
    return p;
  }

  /** The text of one picture; pictures wait their turn (one worker, one at a time). */
  recognize(image: Uint8Array, languages: string[], signal?: AbortSignal): Promise<string> {
    const run = async () => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const w = await this.workerFor(languages);
      let timer: NodeJS.Timeout | undefined;
      try {
        const r = await Promise.race([
          w.recognize(Buffer.from(image)),
          new Promise<never>((_, fail) => {
            timer = setTimeout(() => fail(new Error("The OCR took too long")), RECOGNIZE_MS);
          }),
        ]);
        return r.data.text ?? "";
      } catch (err) {
        // A stuck or broken worker is not used again.
        await this.terminate();
        throw err;
      } finally {
        clearTimeout(timer);
        this.sleepLater();
      }
    };
    const out = this.queue.then(run, run);
    this.queue = out.catch(() => {});
    return out;
  }

  private async workerFor(languages: string[]): Promise<Tesseract.Worker> {
    const key = languages.join("+");
    if (this.worker && this.languages === key) return this.worker;
    await this.terminate();
    if (!(await this.ready(languages)))
      throw new JobFailure("ocr_missing", "The OCR is not downloaded yet");
    this.worker = await Tesseract.createWorker(languages, Tesseract.OEM.LSTM_ONLY, {
      workerPath: workerPath(),
      corePath: this.corePath,
      langPath: this.langDir,
      cacheMethod: "none",
      gzip: true,
      legacyCore: false,
      legacyLang: false,
      errorHandler: () => {},
    });
    this.languages = key;
    return this.worker;
  }

  private sleepLater() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.terminate(), this.o.idleMs ?? 120_000);
    this.idle.unref?.();
  }

  private async terminate() {
    const w = this.worker;
    this.worker = undefined;
    this.languages = "";
    if (w) await w.terminate().catch(() => {});
  }

  async bytes(): Promise<number> {
    const walk = async (dir: string): Promise<number> => {
      let n = 0;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, e.name);
        n += e.isDirectory()
          ? await walk(p)
          : await stat(p).then(
              (s) => s.size,
              () => 0,
            );
      }
      return n;
    };
    return walk(this.dir);
  }

  async stop(): Promise<void> {
    clearTimeout(this.idle);
    await this.terminate();
  }
}
