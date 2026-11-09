// The PDF family (G37.8). The host keeps the outline (pages, annotations, fields) and the actions
// accepted since the bytes on disk; the file is written when the host saves (pdf-write.ts):
// incrementally for annotations, fields and rotations (the original stays at the head of the
// file), anew for pages taken out or moved and for redactions, the version before kept beside the
// editor's state (the last five). A page fetches the head's bytes (`bytesOf`); an agent's words
// become actions on the server (`fromAgent`, words found with pdf.js), and a redaction is checked
// on the written result before it is accepted and again before the file is written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  type DocOp,
  type DocSummary,
  docKey,
  type PdfAction,
  type PdfDocOp,
  type PdfOutline,
  type PdfPlainAction,
  type PdfRect,
  type PdfSource,
} from "@redgiant/protocol";
import type { DocFamily, Loaded, PrepareContext, RenderContext } from "./family.js";
import {
  actionsConflict,
  actionsFromAgent,
  applyAction,
  checkAction,
  composeActions,
  describeActions,
  flat,
  invertAction,
  mapAction,
  outlineText,
  PDF_CATALOG,
} from "./pdf-ops.js";
import { MAX_PDF_BYTES, readPdfOutline } from "./pdf-outline.js";
import { verifyRedaction } from "./pdf-redact.js";
import { findWords, pageLines } from "./pdf-text.js";
import { rewrites, writePdf } from "./pdf-write.js";

export const PDF_ENGINE_VERSION = "1";

export interface PdfModel {
  outline: PdfOutline;
  /** The bytes the actions start from (the file as last saved). */
  base: { hash: string; bytes?: Uint8Array };
  /** Accepted after `base`, not in it yet. */
  pending: PdfDocOp[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const wrapPdf = (op: PdfAction): PdfDocOp => ({
  family: "pdf",
  engine: "redgiant-pdf",
  engineVersion: PDF_ENGINE_VERSION,
  op,
});
const actionOf = (op: DocOp): PdfAction => {
  if (op.family !== "pdf") throw new Error("not an operation on a PDF");
  return op.op;
};
const plainOf = (ops: readonly PdfDocOp[]): PdfPlainAction[] => ops.flatMap((o) => flat(o.op));

export interface PdfFamilyOptions {
  /** RedGiant's data folder: blobs and the versions kept. */
  dataDir: string;
}

/** Whether a redaction in a list of actions stays on the same page index to the end of it. */
function redactionsToCheck(ops: PdfPlainAction[]): { page: number; rects: PdfRect[] }[] {
  const out: { page: number; rects: PdfRect[] }[] = [];
  ops.forEach((a, i) => {
    if (a.t !== "redact") return;
    // Checked when it was accepted; here only while its page is still at the same place.
    if (ops.slice(i + 1).some(rewrites)) return;
    out.push({ page: a.page, rects: a.rects });
  });
  return out;
}

export class PdfFamily implements DocFamily<PdfModel> {
  readonly id = "pdf" as const;
  readonly engine = "redgiant-pdf";
  readonly engineVersion = PDF_ENGINE_VERSION;
  /** The bytes of the latest heads asked (a page loads them, the agent's words are found in them). */
  private readonly rendered = new Map<string, Promise<Uint8Array>>();

  constructor(private readonly o: PdfFamilyOptions) {}

  private blobPath(hash: string) {
    return join(this.o.dataDir, "editor", "blobs", hash);
  }

  /** A blob of the host (the bytes a page comes back from, a picture). */
  readonly blob = async (hash: string): Promise<Uint8Array | undefined> => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const { readFile } = await import("node:fs/promises");
    const b = await readFile(this.blobPath(hash)).catch(() => undefined);
    return b && sha256(b) === hash ? new Uint8Array(b) : undefined;
  };

  /** The model's base kept as a blob (a page taken out comes back from it). */
  private keepBase(model: PdfModel): void {
    const p = this.blobPath(model.base.hash);
    if (existsSync(p) || !model.base.bytes) return;
    mkdirSync(join(this.o.dataDir, "editor", "blobs"), { recursive: true });
    writeFileSync(p, model.base.bytes);
  }

  private async baseBytes(model: PdfModel): Promise<Uint8Array> {
    const b = model.base.bytes ?? (await this.blob(model.base.hash));
    if (!b) throw new Error("the PDF the editor started from is not here anymore");
    return b;
  }

  /** The file at the model's revision (not written to disk). */
  async bytesOf(model: PdfModel): Promise<Uint8Array> {
    if (!model.pending.length) return this.baseBytes(model);
    const key = `${model.base.hash}:${sha256(new TextEncoder().encode(JSON.stringify(model.pending)))}`;
    let p = this.rendered.get(key);
    if (!p) {
      p = (async () =>
        (await writePdf(await this.baseBytes(model), plainOf(model.pending), this.blob)).bytes)();
      p.catch(() => this.rendered.delete(key));
      this.rendered.set(key, p);
      while (this.rendered.size > 8)
        this.rendered.delete(this.rendered.keys().next().value as string);
    }
    return p;
  }

  accepts(path: string): boolean {
    return /\.pdf$/i.test(path);
  }

  load(): Loaded<PdfModel> {
    throw new Error("a PDF is read asynchronously");
  }

  async loadAsync(bytes: Uint8Array): Promise<Loaded<PdfModel>> {
    if (bytes.length > MAX_PDF_BYTES)
      throw new Error(`it is over ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) throw new Error("it is not a PDF");
    const outline = await readPdfOutline(bytes);
    return { model: { outline, base: { hash: sha256(bytes), bytes }, pending: [] }, format: {} };
  }

  save(model: PdfModel): Uint8Array {
    if (!model.pending.length && model.base.bytes) return model.base.bytes;
    throw new Error("a PDF is written by its own writer");
  }

  async render(
    model: PdfModel,
    _format: unknown,
    ctx: RenderContext,
  ): Promise<{ bytes: Uint8Array; model: PdfModel }> {
    const base = await this.baseBytes(model);
    const ops = plainOf(model.pending);
    if (!ops.length)
      return { bytes: base, model: { ...model, base: { hash: model.base.hash, bytes: base } } };
    const w = await writePdf(base, ops, this.blob);
    // Never written unchecked: what was under a redaction must be gone from the file itself.
    for (const r of redactionsToCheck(ops)) {
      const left = await verifyRedaction(w.bytes, r.page, r.rects);
      if (left)
        throw new Error(
          `the redaction of page ${r.page + 1} could not be checked: ${left} is still under it. Nothing was written; undo the redaction`,
        );
    }
    if (w.rewrote) await this.keepVersion(ctx, base);
    const next = await this.loadAsync(w.bytes);
    return { bytes: w.bytes, model: next.model };
  }

  /** Where the versions of a file written anew are kept. */
  versionsOf(ownerId: string, file: { scope: string; path: string }): string {
    return versionsDir(this.o.dataDir, ownerId, file);
  }

  /** The file as it was before being written anew: kept with the editor's state (the last 5). */
  private async keepVersion(ctx: RenderContext, bytes: Uint8Array): Promise<void> {
    const dir = versionsDir(this.o.dataDir, ctx.ownerId, ctx.file);
    await mkdir(dir, { recursive: true });
    const ext = extname(ctx.file.path) || ".pdf";
    const stem = basename(ctx.file.path, ext);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `${stem}.${stamp}${ext}`), bytes);
    const all = (await readdir(dir)).filter((n) => n.startsWith(`${stem}.`)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 5)))
      await rm(join(dir, old), { force: true });
  }

  snapshot(model: PdfModel) {
    return {
      family: "pdf" as const,
      outline: model.outline,
      base: model.base.hash,
      pending: model.pending.length,
    };
  }

  check(model: PdfModel, op: DocOp): string | undefined {
    if (op.family !== "pdf") return "not an operation on a PDF";
    return checkAction(model.outline, op.op);
  }

  apply(model: PdfModel, op: DocOp): PdfModel {
    const outline = applyAction(model.outline, actionOf(op));
    return { ...model, outline, pending: [...model.pending, op as PdfDocOp] };
  }

  invert(model: PdfModel, op: DocOp): DocOp {
    const a = actionOf(op);
    const source = (before: PdfPlainAction[]): PdfSource => {
      this.keepBase(model);
      return { base: model.base.hash, ops: [...plainOf(model.pending), ...before] };
    };
    return wrapPdf(invertAction(model.outline, a, source));
  }

  compose(ops: readonly DocOp[]): DocOp | undefined {
    const a = composeActions(ops.map(actionOf));
    return a && wrapPdf(a);
  }

  conflicts(a: DocOp, b: DocOp): boolean {
    return actionsConflict(actionOf(a), actionOf(b));
  }

  map(a: DocOp, b: DocOp): DocOp | undefined {
    try {
      return wrapPdf(mapAction(actionOf(a), actionOf(b)));
    } catch {
      return undefined;
    }
  }

  /** While the person types in a field or a text box, the agents' edits wait (the whole file). */
  touches(): boolean {
    return true;
  }

  mapPos(_op: DocOp, pos: number): number {
    return pos;
  }

  lineOf(): number {
    return 1;
  }

  diff(): DocOp | undefined {
    return undefined;
  }

  summarize(model: PdfModel, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary {
    const d = describeActions(model.outline, ops.map(actionOf));
    const n = ops.flatMap((o) => flat(actionOf(o))).length;
    return {
      text: d.text.slice(0, 500),
      kind: kind ?? d.kind,
      pdf: d.words,
      ...(n > 1 && { count: n }),
    };
  }

  wrote(): [number, number][] {
    return [];
  }

  async fromAgent(model: PdfModel, ops: readonly unknown[]) {
    if (model.outline.encrypted)
      return { error: "the PDF is encrypted: it is shown, never written" };
    let bytes: Uint8Array | undefined;
    const r = await actionsFromAgent(model.outline, ops, {
      find: async (page, words) => {
        bytes ??= await this.bytesOf(model);
        return findWords(bytes, page, words);
      },
      newId: () => `rg-${Math.random().toString(36).slice(2, 10)}`,
    });
    if ("error" in r) return r;
    // A redaction is tried first: refused unless the written file has nothing under its areas.
    const before = plainOf(model.pending);
    for (const [i, a] of r.actions.entries()) {
      if (a.t !== "redact") continue;
      const list = [...before, ...r.actions.slice(0, i + 1)];
      try {
        const w = await writePdf(await this.baseBytes(model), list, this.blob);
        const left = await verifyRedaction(w.bytes, a.page, a.rects);
        if (left)
          return {
            error: `the redaction of page ${a.page + 1} cannot be done safely: ${left} would stay under the area. Nothing was changed`,
          };
      } catch (err) {
        return {
          error: `the redaction of page ${a.page + 1} cannot be done: ${(err as Error).message}`,
        };
      }
    }
    return { ops: r.actions.map(wrapPdf) };
  }

  /** Pictures named by path (a signature, a stamp) become blobs. */
  async prepare(ops: readonly unknown[], ctx: PrepareContext): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const raw of ops) {
      const x = raw as Record<string, unknown>;
      const name = String(x?.op ?? x?.action ?? x?.type ?? "").toLowerCase();
      if ((name === "sign" || name === "stamp") && typeof x.image === "string") {
        const bytes = await ctx.read(x.image);
        const mime =
          bytes[0] === 0x89 && bytes[1] === 0x50
            ? "image/png"
            : bytes[0] === 0xff && bytes[1] === 0xd8
              ? "image/jpeg"
              : undefined;
        if (!mime) throw new Error(`${x.image} is not a PNG or a JPEG`);
        const blob = await ctx.putBlob(bytes);
        const { image: _i, ...rest } = x;
        out.push({ ...rest, picture: { blob, mime } });
      } else out.push(raw);
    }
    return out;
  }

  catalog(): string {
    return PDF_CATALOG;
  }

  async structure(
    model: PdfModel,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
  ): Promise<string> {
    const n = model.outline.pages.length;
    const from = Math.max(1, Math.min(n, ask.fromLine ?? 1));
    const to = Math.max(
      from,
      Math.min(n, ask.toLine ?? (ask.fromLine ? from : Math.min(n, 2)), from + 19),
    );
    const pages: number[] = [];
    for (let p = from; p <= to; p++) pages.push(p - 1);
    let lines = new Map<number, { text: string; rect: [number, number, number, number] }[]>();
    if (!model.outline.encrypted && n)
      lines = await pageLines(await this.bytesOf(model), pages).catch(() => new Map());
    return outlineText(model.outline, lines);
  }
}

/** Where the versions of a PDF written anew are kept. */
export function versionsDir(
  dataDir: string,
  ownerId: string,
  file: { scope: string; path: string },
) {
  const id = createHash("sha256").update(docKey(file)).digest("hex").slice(0, 24);
  return join(dataDir, "editor", ownerId.replace(/[^a-zA-Z0-9_-]/g, "_"), id, "versions");
}
