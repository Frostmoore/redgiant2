// The sheet family (G37.3): CSV and TSV edited in place, ODS edited with Univer for the view and
// saved with LibreOffice's «toppa» (sheet/toppa.ts), so charts, pivot tables and formats Univer
// does not know stay in the file. An XLSX, XLS or Numbers file is edited on its ODS copy beside it
// (the rule of open formats); written back over the original only with the file's switch. The
// operations are Univer's own mutations with their undo (sheet/ops.ts); the server runs them on a
// headless Univer (sheet/engine.ts), the same engine as the page.
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { DocFile, DocOp, SheetMutation } from "@redgiant/protocol";
import { type DocFamily, type Loaded, SaveWaits } from "./family.js";
import { atomicWrite } from "./host.js";
import { areaName, cellName, parseArea } from "./sheet/a1.js";
import { SHEET_CATALOG, sheetFromAgent } from "./sheet/agent.js";
import { type DelimitedFormat, readDelimited, writeDelimited } from "./sheet/csv.js";
import { keepEngine, takeEngine, UNIVER_VERSION } from "./sheet/engine.js";
import {
  type CellData,
  cellsOf,
  type SheetModel,
  styleOf,
  UNIT,
  type WorkbookData,
} from "./sheet/model.js";
import { readOds } from "./sheet/ods.js";
import {
  asSheet,
  MUTATIONS,
  movePlaceholders,
  posCell,
  refusedMutation,
  sheetCompose,
  sheetConflicts,
  sheetInvert,
  sheetMap,
  sheetSummary,
  targetsOf,
  touchesPos,
  wroteOf,
} from "./sheet/ops.js";
import { sheetStructure } from "./sheet/structure.js";
import { applyPatch, buildPatch, exportWith, pythonFor } from "./sheet/toppa.js";

export const SHEET_FILES = /\.(csv|tsv|ods)$/i;

/** Closed sheets: edited on their ODS copy beside them (the page's «Modifica (copia ODS)»). */
export const SHEET_COPIES = /\.(xlsx|xlsm|xls|numbers)$/i;

/**
 * Where the open copy of a closed sheet is (`x.xlsx` → `x.xlsx.open/x.ods`, as the converter
 * names it): agents edit it too (p3.5.4, the person's test of 3.5.3: «There is no editor for
 * bilancio.xlsx yet»).
 */
export function sheetCopyOfOriginal(path: string): string | undefined {
  if (!SHEET_COPIES.test(path)) return undefined;
  const b = basename(path);
  return `${path}.open/${b.slice(0, b.lastIndexOf("."))}.ods`;
}

export interface SheetFamilyDeps {
  /** LibreOffice's soffice, if it is here. */
  libreoffice(): string | undefined;
  /** Starts LibreOffice's download for this owner (the person sees the bar). */
  fetchLibreOffice?(ownerId: string): void;
  /** Its profile for saving, and a folder for the work files. */
  profileDir: string;
  tmpDir: string;
  /** Whether the open copy is written back over its closed original after each save. */
  reexport?(ownerId: string, file: DocFile): boolean;
  /** Tests: the program runner. */
  run?: (
    file: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string }>;
  python?: (soffice: string) => string | undefined;
}

type Format =
  | { kind: "delimited"; f: DelimitedFormat }
  | { kind: "ods"; ids: Record<string, string> };

/** What `check` already ran: `apply` takes it instead of running the op again. */
const checked = new WeakMap<DocOp, { from: SheetModel; to: SheetModel }>();

function run(model: SheetModel, mutations: readonly SheetMutation[]): SheetModel {
  const e = takeEngine(model);
  const r = e.run(mutations);
  if (!r.ok) {
    e.dispose();
    throw new Error(`${r.id}: ${r.why}`);
  }
  const next: SheetModel = {
    ...model,
    wb: e.snapshot(),
    placeholders: movePlaceholders(model, mutations),
  };
  keepEngine(next, e);
  return next;
}

/**
 * The cells a chart or a pivot table reads are a fixed range (p3.5.3, the person's test: «Luglio»
 * written in row 8 under a chart reading A1:B7 stayed out of it): an edit that writes just below
 * or right of such a range is told how to grow it.
 */
export function chartAdvice(model: SheetModel, ops: readonly DocOp[]): string | undefined {
  const written = ops.flatMap((op) => targetsOf(asSheet(op))).filter((t) => !t.shift);
  if (!written.length) return undefined;
  const notes: string[] = [];
  for (const p of model.placeholders) {
    if ((p.kind !== "chart" && p.kind !== "pivot") || !p.source) continue;
    for (const src of p.source.split(/,\s*/)) {
      const a = parseArea(src);
      if (!a) continue;
      const sheet = a.sheet
        ? model.wb.sheetOrder.find(
            (id) => model.wb.sheets[id]?.name.toLowerCase() === a.sheet?.toLowerCase(),
          )
        : p.sheet;
      const r = a.area;
      const below = written.find(
        (t) => t.sheet === sheet && t.r0 === r.r1 + 1 && t.c0 <= r.c1 && r.c0 <= t.c1,
      );
      const right = written.find(
        (t) => t.sheet === sheet && t.c0 === r.c1 + 1 && t.r0 <= r.r1 && r.r0 <= t.r1,
      );
      const what = `${p.kind === "chart" ? "The chart" : "The pivot table"}${p.name ? ` «${p.name}»` : ""} reads ${src}`;
      if (below)
        notes.push(
          `${what}: what you wrote in row ${r.r1 + 2} (${areaName(below)}) is just below it, so it is NOT included. A chart's range grows only with rows inserted inside it: undo this edit, then insert_rows before row ${r.r1 + 1} (its last row; the range becomes ${cellName(r.r0, r.c0)}:${cellName(r.r1 + 1, r.c1)}) and write the rows ${r.r1 + 1}-${r.r1 + 2} in the order you want (the old last row moved to row ${r.r1 + 2}).`,
        );
      else if (right)
        notes.push(
          `${what}: what you wrote in column ${areaName(right).replace(/\d+.*$/, "")} is just right of it, so it is NOT included. To grow it, undo this edit and insert_cols before its last column, then write the columns in the order you want.`,
        );
    }
  }
  return notes.length ? notes.join("\n") : undefined;
}

/** The workbook with its formulas computed (what a CSV writes in their place). */
async function calculated(model: SheetModel): Promise<WorkbookData | undefined> {
  const hasFormula = model.wb.sheetOrder.some((id) =>
    Object.values(model.wb.sheets[id]?.cellData ?? {}).some((row) =>
      Object.values(row).some((c) => !!c?.f || !!c?.si),
    ),
  );
  if (!hasFormula) return undefined;
  const e = takeEngine(model);
  try {
    await e.calculate(2500);
    return e.snapshot();
  } catch {
    return undefined;
  } finally {
    keepEngine(model, e);
  }
}

/** The pivot table an operation would write into (their output is LibreOffice's, never ours). */
function pivotHit(model: SheetModel, op: DocOp): string | undefined {
  const pivots = model.placeholders.filter((p) => p.kind === "pivot");
  if (!pivots.length) return undefined;
  for (const m of asSheet(op).op.redo) {
    if (
      m.id !== MUTATIONS.values &&
      m.id !== MUTATIONS.merge &&
      m.id !== MUTATIONS.unmerge &&
      m.id !== MUTATIONS.reorder
    )
      continue;
    for (const t of targetsOf({
      ...asSheet(op),
      op: { redo: [m], undo: [] },
      target: undefined,
    } as never))
      for (const p of pivots)
        if (t.sheet === p.sheet && t.r0 <= p.r1 && p.r0 <= t.r1 && t.c0 <= p.c1 && p.c0 <= t.c1)
          return `the pivot table${p.name ? ` «${p.name}»` : ""} at ${areaName(p)} is kept as LibreOffice made it: its cells cannot be changed here (change its source data instead)`;
  }
  return undefined;
}

/** A copy in `<file>.open/` of a closed original, if it is one (G34.3 conversion.json). */
async function originalOf(abs: string): Promise<string | undefined> {
  const dir = dirname(abs);
  if (!dir.endsWith(".open")) return undefined;
  const manifest = await readFile(join(dir, "conversion.json"), "utf8")
    .then((t) => JSON.parse(t) as { source?: string })
    .catch(() => undefined);
  const src = dir.slice(0, -".open".length);
  if (!manifest || basename(src) !== (manifest.source ? basename(manifest.source) : basename(src)))
    return undefined;
  // An xlsm keeps macros LibreOffice would not write back: never over it.
  return /\.(xlsx|xls)$/i.test(src) ? src : undefined;
}

export function sheetFamily(d: SheetFamilyDeps): DocFamily<SheetModel> & {
  exportAs(
    model: SheetModel,
    bytes: Uint8Array,
    to: "xlsx" | "csv" | "pdf" | "ods",
  ): Promise<Uint8Array>;
} {
  const soffice = (ownerId: string) => {
    const lo = d.libreoffice();
    if (!lo) {
      d.fetchLibreOffice?.(ownerId);
      throw new SaveWaits(
        "Saving this sheet needs LibreOffice, which is coming down now (the first time only): the changes are kept and saved when it is here",
        "libreoffice",
      );
    }
    const python = (d.python ?? pythonFor)(lo);
    if (!python)
      throw new Error("LibreOffice's Python was not found beside it: it is needed to save sheets");
    return { soffice: lo, python };
  };
  const fam: DocFamily<SheetModel> & {
    exportAs(
      model: SheetModel,
      bytes: Uint8Array,
      to: "xlsx" | "csv" | "pdf" | "ods",
    ): Promise<Uint8Array>;
  } = {
    id: "sheet",
    engine: "univer",
    engineVersion: UNIVER_VERSION,
    accepts: (path) => SHEET_FILES.test(path),
    load(bytes, path = "") {
      const ext = extname(path).toLowerCase();
      if (ext === ".ods" || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        const r = readOds(bytes);
        return {
          model: r.model,
          format: { kind: "ods", ids: r.format.ids } satisfies Format,
        } as Loaded<SheetModel>;
      }
      const r = readDelimited(bytes, ext === ".tsv" || ext === ".tab");
      return { model: r.model, format: { kind: "delimited", f: r.format } satisfies Format };
    },
    save(model, format) {
      const f = format as Format;
      if (f.kind === "delimited") return writeDelimited(model, f.f);
      throw new Error("An ODS is saved through LibreOffice (saveTo)");
    },
    async saveTo(ctx) {
      const f = ctx.format as Format;
      // A CSV keeps values only (p3.5.3): the formulas computed first, their values written.
      if (f.kind === "delimited")
        return writeDelimited(ctx.model, f.f, await calculated(ctx.model));
      if (!ctx.ops.length || !ctx.before) return ctx.bytes;
      const lo = soffice(ctx.ownerId);
      const patch = buildPatch(ctx.before, ctx.ops);
      const bytes = await applyPatch(ctx.bytes, patch, {
        ...lo,
        profileDir: d.profileDir,
        tmpDir: d.tmpDir,
        ...(d.run && { run: d.run }),
      });
      // The switch of the file: the closed original written again from the copy.
      if (d.reexport?.(ctx.ownerId, ctx.file)) {
        const original = await originalOf(ctx.abs);
        if (original) {
          const ext = extname(original).slice(1).toLowerCase() === "xls" ? "xls" : "xlsx";
          const out = await exportWith(bytes, ext, {
            soffice: lo.soffice,
            profileDir: d.profileDir,
            tmpDir: d.tmpDir,
            ...(d.run && { run: d.run }),
          });
          await atomicWrite(original, out);
          // The copy is not «out of date» because of it: the manifest follows the original.
          const mf = join(dirname(ctx.abs), "conversion.json");
          const m = await readFile(mf, "utf8")
            .then((t) => JSON.parse(t) as Record<string, unknown>)
            .catch(() => undefined);
          const st = await stat(original).catch(() => undefined);
          if (m && st)
            await atomicWrite(
              mf,
              new TextEncoder().encode(
                JSON.stringify(
                  { ...m, sourceSize: st.size, sourceModifiedAt: st.mtime.toISOString() },
                  null,
                  2,
                ),
              ),
            );
        }
      }
      return bytes;
    },
    async exportAs(model, bytes, to) {
      if (model.kind !== "ods" && to === "csv") return bytes;
      const lo = d.libreoffice();
      if (!lo)
        throw new SaveWaits("LibreOffice is needed to export: it is coming down", "libreoffice");
      return exportWith(bytes, to, {
        soffice: lo,
        profileDir: d.profileDir,
        tmpDir: d.tmpDir,
        ...(d.run && { run: d.run }),
      });
    },
    snapshot: (model) => ({
      family: "sheet",
      format: model.kind,
      workbook: model.wb as unknown as Record<string, unknown>,
      placeholders: model.placeholders,
      kept: model.kept,
    }),
    check(model, op) {
      if (op.family !== "sheet") return "not a sheet operation";
      const sheets = new Set(model.wb.sheetOrder);
      for (const m of [...op.op.redo, ...op.op.undo]) {
        const no = refusedMutation(model.kind, m);
        if (no) return no;
        const p = (m.params ?? {}) as Record<string, unknown>;
        if (p.unitId !== undefined && p.unitId !== UNIT)
          return "the operation is for another workbook";
      }
      for (const m of op.op.redo) {
        const p = (m.params ?? {}) as Record<string, unknown>;
        if (m.id === MUTATIONS.insertSheet) {
          const id = (p.sheet as { id?: string } | undefined)?.id;
          if (!id) return "a new sheet needs its id";
          sheets.add(id);
          continue;
        }
        if (typeof p.subUnitId === "string" && !sheets.has(p.subUnitId))
          return "that sheet is not in the file anymore: look again";
        if (m.id === MUTATIONS.removeSheet && typeof p.subUnitId === "string")
          sheets.delete(p.subUnitId);
      }
      const pivot = pivotHit(model, op);
      if (pivot) return pivot;
      // Run once: what apply returns, and the reason if the engine refuses it.
      try {
        checked.set(op, { from: model, to: run(model, op.op.redo) });
      } catch (err) {
        return `the sheet cannot take it (${(err as Error).message})`;
      }
      return undefined;
    },
    apply(model, op) {
      const c = checked.get(op);
      if (c && c.from === model) return c.to;
      return run(model, asSheet(op).op.redo);
    },
    invert: (_model, op) => sheetInvert(asSheet(op)),
    compose: (ops) => sheetCompose(ops.map(asSheet)),
    conflicts: (a, b) => sheetConflicts(asSheet(a), asSheet(b)),
    map: (a, b) => sheetMap(asSheet(a), asSheet(b)),
    touches: (op, from, to) => touchesPos(asSheet(op), from, to),
    mapPos: (_op, pos) => pos,
    lineOf: (_model, pos) => posCell(pos).r + 1,
    placeOf(model, pos) {
      const p = posCell(pos);
      const sheet = model.wb.sheetOrder.find((id) => {
        let h = 2166136261;
        for (let i = 0; i < id.length; i++) {
          h ^= id.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        return h % 131_072 === p.key;
      });
      const name = sheet ? model.wb.sheets[sheet]?.name : undefined;
      return `cell ${cellName(p.r, p.c)}${name && model.wb.sheetOrder.length > 1 ? ` of «${name}»` : ""}`;
    },
    diff(before, after, maxBytes) {
      // Only cell contents on the same sheets: anything else starts again from the file.
      const a = before.wb;
      const b = after.wb;
      if (JSON.stringify(a.sheetOrder) !== JSON.stringify(b.sheetOrder)) return undefined;
      const redo: SheetMutation[] = [];
      const undo: SheetMutation[] = [];
      for (const id of a.sheetOrder) {
        const x = a.sheets[id];
        const y = b.sheets[id];
        if (!x || !y || x.name !== y.name) return undefined;
        if (JSON.stringify(x.mergeData ?? []) !== JSON.stringify(y.mergeData ?? []))
          return undefined;
        const fwd: Record<number, Record<number, CellData>> = {};
        const back: Record<number, Record<number, CellData>> = {};
        const keys = new Set<string>();
        for (const [r, c] of cellsOf(x)) keys.add(`${r},${c}`);
        for (const [r, c] of cellsOf(y)) keys.add(`${r},${c}`);
        for (const k of keys) {
          const [r, c] = k.split(",").map(Number) as [number, number];
          const cx = x.cellData[r]?.[c];
          const cy = y.cellData[r]?.[c];
          const vx = { v: cx?.v ?? null, f: cx?.f ?? null, s: styleOf(a, cx) };
          const vy = { v: cy?.v ?? null, f: cy?.f ?? null, s: styleOf(b, cy) };
          if (JSON.stringify(vx) === JSON.stringify(vy)) continue;
          const full = (
            v: { v: unknown; f: unknown; s: Record<string, unknown> },
            other: Record<string, unknown>,
          ) => {
            const s: Record<string, unknown> = { ...v.s };
            for (const key of Object.keys(other)) if (!(key in s)) s[key] = null;
            return { v: v.v, f: v.f, si: null, s: Object.keys(s).length ? s : null } as CellData;
          };
          const f1 = fwd[r] ?? {};
          f1[c] = full(vy, vx.s);
          fwd[r] = f1;
          const b1 = back[r] ?? {};
          b1[c] = full(vx, vy.s);
          back[r] = b1;
        }
        if (Object.keys(fwd).length) {
          redo.push({
            id: MUTATIONS.values,
            params: { unitId: UNIT, subUnitId: id, cellValue: fwd },
          });
          undo.push({
            id: MUTATIONS.values,
            params: { unitId: UNIT, subUnitId: id, cellValue: back },
          });
        }
      }
      if (!redo.length) return undefined;
      const op: DocOp = {
        family: "sheet",
        engine: "univer",
        engineVersion: UNIVER_VERSION,
        op: { redo, undo },
      };
      return JSON.stringify(op).length <= maxBytes ? op : undefined;
    },
    summarize: (model, ops, kind) => sheetSummary(model, ops.map(asSheet), kind),
    wrote: (ops) => wroteOf(ops.map(asSheet)),
    fromAgent: (model, ops) => sheetFromAgent(model, ops, (m, op) => pivotHit(m, op)),
    advice: (model, ops) => chartAdvice(model, ops),
    catalog: () => SHEET_CATALOG,
    structure: (model, ask) => sheetStructure(model, ask),
  };
  return fam;
}
