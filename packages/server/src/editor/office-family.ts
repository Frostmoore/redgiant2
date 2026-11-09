// The document family (G37.4): ODT and ODP, the open copies of DOCX, PPTX, DOC, PPT and RTF
// included. The host keeps the outline (office-outline.ts) and the actions accepted since the
// bytes it has (the file on disk, or the file a page saved, a blob); LibreOffice applies them:
// in the person's page when the full editor is open (ZetaOffice, which then saves the file it
// shows), on the server otherwise (office-engine.ts) when the file is written. A closed format's
// copy can be written back into the original at every save (the file's switch); the previous
// version of the original is kept in the copy's folder.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  type DocFile,
  type DocOp,
  type DocSummary,
  docKey,
  type OfficeAction,
  type OfficeDocOp,
  type OfficeOutline,
  type OfficePlainAction,
} from "@redgiant/protocol";
import { pictureInfo } from "../convert-idml.js";
import type { DocFamily, Loaded, PrepareContext, RenderContext } from "./family.js";
import { atomicWrite } from "./host.js";
import type { OfficeEngine } from "./office-engine.js";
import {
  actionsConflict,
  actionsFromAgent,
  applyAction,
  checkAction,
  composeActions,
  describeActions,
  invertAction,
  mapAction,
  OFFICE_CATALOG,
  outlineText,
} from "./office-ops.js";
import { readOutline } from "./office-outline.js";

export const OFFICE_ENGINE_VERSION = "1";
/** The biggest document the editor opens. */
export const MAX_OFFICE_BYTES = 100 * 1024 * 1024;
/** Closed formats whose open copy the editor edits, and the copy's format. */
export const OFFICE_COPIES: Record<string, "odt" | "odp"> = {
  docx: "odt",
  doc: "odt",
  rtf: "odt",
  docm: "odt",
  dotx: "odt",
  pptx: "odp",
  ppt: "odp",
  pptm: "odp",
  ppsx: "odp",
};

export interface OfficeModel {
  outline: OfficeOutline;
  /** The bytes the actions start from: sha256, and the bytes when the host has them in memory. */
  base: { hash: string; bytes?: Uint8Array };
  /** Accepted after `base`, not in it yet. */
  pending: OfficeDocOp[];
  /** An older revision rebuilt with the person's edits taken back: read, never written. */
  virtual?: boolean;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const wrap = (op: OfficeAction): OfficeDocOp => ({
  family: "document",
  engine: "libreoffice-uno",
  engineVersion: OFFICE_ENGINE_VERSION,
  op,
});
const actionOf = (op: DocOp): OfficeAction => {
  if (op.family !== "document") throw new Error("not an operation on a document");
  return op.op;
};
const flatten = (ops: readonly OfficeDocOp[]): OfficePlainAction[] =>
  ops.flatMap((o) =>
    o.op.t === "batch" ? o.op.ops : o.op.t === "file" || o.op.t === "restore" ? [] : [o.op],
  );

/** The open copy's original (`x.docx.open/x.odt` → `x.docx`), when the path is one. */
export function originalOfCopy(path: string): string | undefined {
  const dir = dirname(path).replace(/\\/g, "/");
  const m = dir.match(/^(.*)\.open$/);
  if (!m?.[1]) return undefined;
  const ext = extname(m[1]).slice(1).toLowerCase();
  return OFFICE_COPIES[ext] ? m[1] : undefined;
}

/** Where the open copy of a closed document is (`x.docx` → `x.docx.open/x.odt`). */
export function copyOfOriginal(path: string): string | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  const to = OFFICE_COPIES[ext];
  if (!to) return undefined;
  const stem = basename(path).slice(0, -(ext.length + 1));
  return `${path}.open/${stem}.${to}`;
}

export interface OfficeFamilyOptions {
  dataDir: string;
  engine: OfficeEngine;
  /** Whether the person turned on writing this copy back into its closed original. */
  reexport?(ownerId: string, file: DocFile): boolean;
  /** The engine skipped actions that did not fit when it wrote the file. */
  onSkipped?(file: DocFile, skipped: { index: number; error: string }[]): void;
}

export class OfficeFamily implements DocFamily<OfficeModel> {
  readonly id = "document" as const;
  readonly engine = "libreoffice-uno";
  readonly engineVersion = OFFICE_ENGINE_VERSION;
  /** Outlines of the files pages saved, by sha256 (read back from the blobs when missing). */
  private readonly outlines = new Map<string, OfficeOutline>();
  /** One write-back at a time per original. */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(private readonly o: OfficeFamilyOptions) {}

  private readonly outlineOf = (hash: string): OfficeOutline | undefined => {
    const have = this.outlines.get(hash);
    if (have) return have;
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    try {
      const b = new Uint8Array(readFileSync(join(this.o.dataDir, "editor", "blobs", hash)));
      if (sha256(b) !== hash) return undefined;
      const o = readOutline(b);
      this.remember(hash, o);
      return o;
    } catch {
      return undefined;
    }
  };

  /** A page's saved file, read: its outline kept for the actions that cite it. */
  remember(hash: string, outline: OfficeOutline): void {
    this.outlines.delete(hash);
    this.outlines.set(hash, outline);
    while (this.outlines.size > 64)
      this.outlines.delete(this.outlines.keys().next().value as string);
  }

  accepts(path: string): boolean {
    return /\.(odt|odp)$/i.test(path);
  }

  load(bytes: Uint8Array): Loaded<OfficeModel> {
    if (bytes.length > MAX_OFFICE_BYTES)
      throw new Error(`it is over ${MAX_OFFICE_BYTES / 1024 / 1024} MB`);
    const outline = readOutline(bytes);
    return {
      model: { outline, base: { hash: sha256(bytes), bytes }, pending: [] },
      format: { app: outline.app },
    };
  }

  save(model: OfficeModel): Uint8Array {
    if (!model.pending.length && model.base.bytes) return model.base.bytes;
    throw new Error("a document is written by LibreOffice");
  }

  async render(
    model: OfficeModel,
    _format: unknown,
    ctx: RenderContext,
  ): Promise<{ bytes: Uint8Array; model: OfficeModel }> {
    if (model.virtual) throw new Error("an older revision rebuilt for reading cannot be written");
    const base = model.base.bytes ?? (await ctx.blob(model.base.hash));
    if (!base) throw new Error("the file the page saved is not here anymore");
    const ops = flatten(model.pending);
    if (!ops.length)
      return { bytes: base, model: { ...model, base: { hash: model.base.hash, bytes: base } } };
    const r = await this.o.engine.apply(ctx.ownerId, base, ops, model.outline.app);
    if (r.skipped.length) this.o.onSkipped?.(ctx.file, r.skipped);
    // What LibreOffice made is the truth from here (its outline read again).
    return { bytes: r.bytes, model: this.load(r.bytes).model };
  }

  /** The closed original written again from its copy, when the person asked (the previous kept). */
  async saved(_model: OfficeModel, ctx: RenderContext): Promise<void> {
    const original = originalOfCopy(ctx.file.path);
    if (!original || !this.o.reexport?.(ctx.ownerId, ctx.file)) return;
    const openDir = dirname(ctx.abs);
    const target = openDir.slice(0, -".open".length);
    const run = async () => {
      const bytes = await readFile(ctx.abs);
      const to = extname(target).slice(1).toLowerCase();
      const from = extname(ctx.abs).slice(1).toLowerCase();
      const out = await this.o.engine.convert(ctx.ownerId, new Uint8Array(bytes), from, to);
      await keepPrevious(target, openDir);
      await atomicWrite(target, out);
      // The copy stays the conversion of the original it wrote (not «changed since»).
      const mf = join(openDir, "conversion.json");
      const m = await readFile(mf, "utf8").then(
        (t) => JSON.parse(t) as Record<string, unknown>,
        () => undefined,
      );
      if (m) {
        const st = await stat(target);
        await writeFile(
          mf,
          `${JSON.stringify({ ...m, sourceSize: st.size, sourceModifiedAt: st.mtime.toISOString(), writtenBackAt: new Date().toISOString() }, null, 2)}\n`,
        );
      }
    };
    const k = docKey(ctx.file);
    const p = (this.writing.get(k) ?? Promise.resolve()).then(run, run);
    this.writing.set(
      k,
      p.catch(() => {}),
    );
    await p;
  }

  snapshot(model: OfficeModel) {
    return {
      family: "document" as const,
      app: model.outline.app,
      base: model.base.hash,
      pending: model.pending,
      count:
        model.outline.app === "writer" ? model.outline.items.length : model.outline.slides.length,
    };
  }

  check(model: OfficeModel, op: DocOp): string | undefined {
    if (op.family !== "document") return "not an operation on a document";
    return checkAction(model.outline, op.op, this.outlineOf);
  }

  apply(model: OfficeModel, op: DocOp): OfficeModel {
    const a = actionOf(op);
    if (a.t === "restore") return { ...model, outline: a.outline, virtual: true };
    const outline = applyAction(model.outline, a, this.outlineOf, false);
    if (a.t === "file")
      return {
        outline,
        base: { hash: a.blob },
        pending: (a.replay ?? []).map(wrap),
        ...(model.virtual && { virtual: true }),
      };
    return { ...model, outline, pending: [...model.pending, op as OfficeDocOp] };
  }

  invert(model: OfficeModel, op: DocOp): DocOp {
    return wrap(invertAction(model.outline, actionOf(op), this.outlineOf));
  }

  compose(ops: readonly DocOp[]): DocOp | undefined {
    const a = composeActions(ops.map(actionOf));
    return a && wrap(a);
  }

  conflicts(a: DocOp, b: DocOp): boolean {
    return actionsConflict(actionOf(a), actionOf(b));
  }

  map(a: DocOp, b: DocOp): DocOp {
    return wrap(mapAction(actionOf(a), actionOf(b)));
  }

  /** While the person types in the document the agents' edits wait (the whole file is theirs). */
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

  summarize(model: OfficeModel, ops: readonly DocOp[], kind?: DocSummary["kind"]): DocSummary {
    const d = describeActions(model.outline, ops.map(actionOf));
    return {
      text: d.text,
      kind: kind ?? d.kind,
      unit: d.unit,
      ...(d.line !== undefined && { line: d.line, lines: d.lines ?? 1 }),
      ...(d.added && { added: d.added }),
      ...(d.removed && { removed: d.removed }),
      ...(ops.length > 1 && { count: ops.length }),
    };
  }

  wrote(): [number, number][] {
    return [];
  }

  fromAgent(model: OfficeModel, ops: readonly unknown[]) {
    const r = actionsFromAgent(model.outline, ops, this.outlineOf);
    if ("error" in r) return r;
    return { ops: r.actions.map(wrap) };
  }

  /** Pictures named by path become blobs (size read from the file, width in mm if asked). */
  async prepare(ops: readonly unknown[], ctx: PrepareContext): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const raw of ops) {
      const x = raw as Record<string, unknown>;
      const name = String(x?.op ?? x?.action ?? x?.type ?? "").toLowerCase();
      if ((name === "insert_image" || name === "add_image") && typeof x.path === "string") {
        const bytes = await ctx.read(x.path);
        const info = pictureInfo(bytes);
        if (!/^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(info.mime))
          throw new Error(
            `${x.path} is not a picture LibreOffice puts in a document (PNG, JPEG, GIF, SVG)`,
          );
        const blob = await ctx.putBlob(bytes);
        // Natural size in points (72 dpi when unknown), at most 16 cm wide unless asked.
        const wPt = info.w ?? 400;
        const hPt = info.h ?? 300;
        let w = Math.round((wPt / 72) * 2540);
        let h = Math.round((hPt / 72) * 2540);
        const want =
          x.width_mm !== undefined ? Math.round(Number(x.width_mm) * 100) : Math.min(w, 16_000);
        if (Number.isFinite(want) && want > 0) {
          h = Math.round((h * want) / w);
          w = want;
        }
        const { path: _p, ...rest } = x;
        out.push({ ...rest, picture: { blob, mime: info.mime, w, h } });
      } else out.push(raw);
    }
    return out;
  }

  catalog(): string {
    return OFFICE_CATALOG;
  }

  structure(
    model: OfficeModel,
    ask: { fromLine?: number | undefined; toLine?: number | undefined },
  ): string {
    return outlineText(model.outline, ask);
  }
}

/** The original as it was before being written again: kept in the copy's folder (the last 5). */
async function keepPrevious(original: string, openDir: string): Promise<void> {
  const st = await stat(original).catch(() => undefined);
  if (!st) return;
  const dir = join(openDir, "versions");
  await mkdir(dir, { recursive: true });
  const ext = extname(original);
  const stem = basename(original, ext);
  const stamp = st.mtime.toISOString().replace(/[:.]/g, "-");
  await copyFile(original, join(dir, `${stem}.${stamp}${ext}`));
  const all = (await readdir(dir))
    .filter((n) => n.startsWith(`${stem}.`) && n.endsWith(ext))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - 5)))
    await rm(join(dir, old), { force: true });
}
