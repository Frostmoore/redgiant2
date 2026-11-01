import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  "Q6_K",
  "Q5_K_M",
  "Q5_K_S",
  "Q4_K_M",
  "Q4_K_S",
  "IQ4_XS",
  "Q4_0",
  "Q3_K_M",
  "IQ3_M",
  "Q3_K_S",
  "Q2_K",
];

export function quantOf(file: string): string | null {
  const m = file.toUpperCase().match(/(IQ\d_[A-Z]+|Q\d_K_[SML]|Q\d_K|Q\d_\d|BF16|F16|F32)/);
  return m?.[1] ?? null;
}

export function suggest(files: GgufFile[], budgetGb: number): GgufFile | undefined {
  const fitting = files.filter((f) => f.sizeGb <= budgetGb);
  for (const q of QUALITY) {
    const f = fitting.find((x) => x.quant === q);
    if (f) return f;
  }
  return fitting.sort((a, b) => b.sizeGb - a.sizeGb)[0];
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "_");

export interface Download {
  repo: string;
  file: string;
  target: string;
  bytes: number;
  total: number | null;
  state: "running" | "done" | "failed";
  error?: string;
}

export class HuggingFace {
  private readonly downloads = new Map<string, Download>();

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

  /** The GGUF files of a repository (projector files for images excluded). */
  async files(repo: string): Promise<GgufFile[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("A repository is owner/name");
    const r = await this.fetchImpl(`${HF}/api/models/${repo}/tree/main?recursive=true`);
    if (!r.ok) throw new Error(`Hugging Face answered ${r.status}`);
    const tree = (await r.json()) as { path: string; size?: number; lfs?: { size?: number } }[];
    return tree
      .filter((f) => f.path.toLowerCase().endsWith(".gguf") && !/mmproj/i.test(f.path))
      .map((f) => ({
        file: f.path,
        sizeGb: Math.round(((f.lfs?.size ?? f.size ?? 0) / 1024 ** 3) * 100) / 100,
        quant: quantOf(f.path),
      }))
      .sort((a, b) => a.sizeGb - b.sizeGb);
  }

  list(): Download[] {
    return [...this.downloads.values()];
  }

  /** Starts downloading into the models folder (one at a time per file); returns at once. */
  start(repo: string, file: string): Download {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || file.includes("..") || !file.endsWith(".gguf"))
      throw new Error("Not a GGUF file of a Hugging Face repository");
    const target = safeName(file.split("/").pop() as string);
    const existing = this.downloads.get(target);
    if (existing?.state === "running") return existing;
    const d: Download = { repo, file, target, bytes: 0, total: null, state: "running" };
    this.downloads.set(target, d);
    void this.run(d);
    return d;
  }

  private async run(d: Download) {
    const part = join(this.modelsDir, `${d.target}.part`);
    try {
      await mkdir(this.modelsDir, { recursive: true });
      const r = await this.fetchImpl(`${HF}/${d.repo}/resolve/main/${d.file}`, {
        redirect: "follow",
      });
      if (!r.ok || !r.body) throw new Error(`Hugging Face answered ${r.status}`);
      d.total = Number(r.headers.get("content-length")) || null;
      const body = Readable.fromWeb(r.body as never);
      body.on("data", (chunk: Buffer) => {
        d.bytes += chunk.length;
      });
      await pipeline(body, createWriteStream(part));
      if (d.total !== null && (await stat(part)).size !== d.total)
        throw new Error("Incomplete download");
      await rename(part, join(this.modelsDir, d.target));
      d.state = "done";
    } catch (err) {
      d.state = "failed";
      d.error = (err as Error).message;
      await rm(part, { force: true }).catch(() => {});
    }
  }
}
