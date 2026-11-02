import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { JobFailure, type JobHandle } from "./jobs.js";

/** Hugging Face: GGUF models for the local engine (G17.2). */
const HF = "https://huggingface.co";

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
}

export interface GgufFile {
  file: string;
  sizeGb: number;
  quant: string | null;
}

/** Best first. A model file should use at most `budget` GB; the best quantisation that fits wins. */
const QUALITY = [
  "Q8_0",
  "UD-Q8_K_XL",
  "UD-Q6_K_XL",
  "Q6_K",
  "UD-Q6_K",
  "UD-Q5_K_XL",
  "Q5_K_M",
  "UD-Q5_K_M",
  "Q5_K_S",
  "UD-Q4_K_XL",
  "Q4_K_M",
  "UD-Q4_K_M",
  "MXFP4_MOE",
  "Q4_K_S",
  "UD-Q4_K_S",
  "IQ4_XS",
  "UD-IQ4_XS",
  "IQ4_NL",
  "UD-IQ4_NL",
  "Q4_0",
  "UD-Q3_K_XL",
  "Q3_K_M",
  "UD-Q3_K_M",
  "IQ3_M",
  "UD-IQ3_S",
  "Q3_K_S",
  "UD-IQ3_XXS",
  "UD-Q2_K_XL",
  "Q2_K",
  "UD-IQ2_M",
];

export function quantOf(file: string): string | null {
  const m = file
    .toUpperCase()
    .match(/(UD-)?(IQ\d_[A-Z]+|Q\d_K_(?:XL|[SML])|Q\d_K|Q\d_\d|MXFP4(?:_MOE)?|BF16|F16|F32)/);
  return m ? `${m[1] ?? ""}${m[2]}` : null;
}

/** How much a quantisation keeps of the model, in three words for people. */
export function qualityOf(quant: string | null): "high" | "good" | "reduced" {
  const q = (quant ?? "").replace(/^UD-/, "");
  if (/^Q[68]_/.test(q)) return "high";
  if (/^(Q[45]_|IQ4_|MXFP4)/.test(q)) return "good";
  return "reduced";
}

/** A file worth offering: a known good quantisation, or one named some other way (not 1-bit). */
export function offered(f: GgufFile): boolean {
  return f.quant === null || QUALITY.includes(f.quant);
}

export function suggest(files: GgufFile[], budgetGb: number): GgufFile | undefined {
  const fitting = files.filter((f) => f.sizeGb <= budgetGb);
  for (const q of QUALITY) {
    const f = fitting.find((x) => x.quant === q);
    if (f) return f;
  }
  // A file named some other way may still be good; the 1-bit ones (IQ1, TQ1) are not offered.
  return fitting.filter((f) => f.quant === null).sort((a, b) => b.sizeGb - a.sizeGb)[0];
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_");

/**
 * Files in a GGUF repository that are not a model to run: multi-token-prediction heads, image
 * projectors, importance matrices, unquantised weights and pieces of split files.
 */
export function isModelFile(path: string): boolean {
  const p = path.toLowerCase();
  const name = p.split("/").pop() ?? p;
  return (
    p.endsWith(".gguf") &&
    !/(^|\/)mtp[-/]|^mtp-|mmproj|imatrix/.test(p) &&
    !/-\d{5}-of-\d{5}\.gguf$/.test(name) &&
    !/\b(bf16|f16|f32)\b/.test(name.replace(/[-_.]/g, " "))
  );
}

/** A file of the models folder: done, or partly downloaded (a pause). */
export interface LocalFile {
  file: string;
  bytes: number;
  partial: boolean;
}

export class HuggingFace {
  private readonly cache = new Map<string, { at: number; files: GgufFile[] }>();

  constructor(
    private readonly modelsDir: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async search(query: string): Promise<HfModel[]> {
    const r = await this.fetchImpl(
      `${HF}/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=20`,
    );
    if (!r.ok) throw new Error(`Hugging Face answered ${r.status}`);
    const list = (await r.json()) as { id: string; downloads?: number; likes?: number }[];
    return list.map((m) => ({ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0 }));
  }

  /** The model files of a repository (`isModelFile`), smallest first; cached for an hour. */
  async files(repo: string): Promise<GgufFile[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("A repository is owner/name");
    const hit = this.cache.get(repo);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.files;
    const r = await this.fetchImpl(`${HF}/api/models/${repo}/tree/main?recursive=true`);
    if (!r.ok) throw new Error(`Hugging Face answered ${r.status}`);
    const tree = (await r.json()) as { path: string; size?: number; lfs?: { size?: number } }[];
    const files = tree
      .filter((f) => isModelFile(f.path))
      .map((f) => ({
        file: f.path,
        sizeGb: Math.round(((f.lfs?.size ?? f.size ?? 0) / 1024 ** 3) * 100) / 100,
        quant: quantOf(f.path),
      }))
      .sort((a, b) => a.sizeGb - b.sizeGb);
    this.cache.set(repo, { at: Date.now(), files });
    return files;
  }

  /** The name a repository's file gets in the models folder. */
  static target(file: string): string {
    return safeName(file.split("/").pop() as string);
  }

  /** What the models folder holds: models ready to start, and downloads paused halfway. */
  async local(): Promise<LocalFile[]> {
    const names = await readdir(this.modelsDir).catch(() => [] as string[]);
    const out: LocalFile[] = [];
    for (const n of names) {
      const partial = n.endsWith(".gguf.part");
      if (!partial && !n.endsWith(".gguf")) continue;
      const st = await stat(join(this.modelsDir, n)).catch(() => null);
      if (st?.isFile()) out.push({ file: partial ? n.slice(0, -5) : n, bytes: st.size, partial });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
  }

  /** Throws away a paused download, or a model no longer wanted. */
  async remove(target: string): Promise<void> {
    if (target !== safeName(target) || !target.endsWith(".gguf"))
      throw new Error("Not a model of the models folder");
    await rm(join(this.modelsDir, `${target}.part`), { force: true });
    await rm(join(this.modelsDir, target), { force: true });
  }

  /**
   * Downloads a file into the models folder, reporting progress. A download stopped halfway
   * (cancelled, or cut) goes on from where it was the next time.
   */
  async download(repo: string, file: string, h: JobHandle): Promise<{ target: string }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || file.includes("..") || !file.endsWith(".gguf"))
      throw new JobFailure("bad_file", "Not a GGUF file of a Hugging Face repository");
    const target = HuggingFace.target(file);
    const final = join(this.modelsDir, target);
    const part = `${final}.part`;
    await mkdir(this.modelsDir, { recursive: true });
    h.step("download");
    if (await stat(final).catch(() => null)) return { target };
    const have = (await stat(part).catch(() => null))?.size ?? 0;
    let r: Response;
    try {
      r = await this.fetchImpl(`${HF}/${repo}/resolve/main/${file}`, {
        redirect: "follow",
        signal: h.signal,
        ...(have > 0 && { headers: { range: `bytes=${have}-` } }),
      });
    } catch (err) {
      if (h.signal.aborted) throw err;
      throw new JobFailure("unreachable", `Hugging Face did not answer: ${(err as Error).message}`);
    }
    if (!r.ok || !r.body) throw new JobFailure("unreachable", `Hugging Face answered ${r.status}`);
    // 206: the rest of the file; 200: the whole file again (the server ignored the range).
    const resumed = r.status === 206;
    let done = resumed ? have : 0;
    const length = Number(r.headers.get("content-length")) || 0;
    const total = length ? done + length : null;
    h.progress(done, total);
    const body = Readable.fromWeb(r.body as never);
    body.on("data", (chunk: Buffer) => {
      done += chunk.length;
      h.progress(done, total);
    });
    await pipeline(body, createWriteStream(part, { flags: resumed ? "a" : "w" }), {
      signal: h.signal,
    });
    if (total !== null && (await stat(part)).size !== total)
      throw new JobFailure(
        "incomplete",
        "The download stopped before the end: start it again to go on",
      );
    await rename(part, final);
    return { target };
  }
}
