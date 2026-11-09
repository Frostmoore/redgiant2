// Univer without a view, on the server (G37.3, as in G37.0 prova 3): the same engine the page
// runs, so the server applies the page's mutations as the page did, runs the agents' operations as
// Univer's own commands (with Univer's own undo mutations), and computes formulas for the agent's
// reading. Only Apache-2.0 packages (core, sheets, formula, number formats, filter, sort); no
// `@univerjs/rpc`. Univer is loaded the first time a sheet is opened, not when the server starts.
import { createRequire } from "node:module";
import type { SheetMutation } from "@redgiant/protocol";
import {
  type CellData,
  type SheetData,
  type SheetModel,
  type Style,
  UNIT,
  type WorkbookData,
} from "./model.js";

// biome-ignore lint/suspicious/noExplicitAny: Univer's modules, loaded on demand.
type Mod = any;
interface Mods {
  core: Mod;
  sheets: Mod;
  formula: Mod;
  sheetsFormula: Mod;
  numfmt: Mod;
  filter: Mod;
  sort: Mod;
}

let mods: Mods | undefined;
/** Univer's modules (CommonJS builds, so the first use needs no await). */
export function univer(): Mods {
  if (!mods) {
    const req = createRequire(import.meta.url);
    mods = {
      core: req("@univerjs/core"),
      sheets: req("@univerjs/sheets"),
      formula: req("@univerjs/engine-formula"),
      sheetsFormula: req("@univerjs/sheets-formula"),
      numfmt: req("@univerjs/sheets-numfmt"),
      filter: req("@univerjs/sheets-filter"),
      sort: req("@univerjs/sheets-sort"),
    };
  }
  return mods;
}

export const UNIVER_VERSION = "1.4.0";

/** Resources of plugins the model keeps (the filter); the others are Univer's own bookkeeping. */
const KEPT_RESOURCES = new Set(["SHEET_FILTER_PLUGIN"]);

/** Mutations a command made, with those that take it back. */
export interface Made {
  redo: SheetMutation[];
  undo: SheetMutation[];
}

const isMutation = (id: string) => id.includes(".mutation.");
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export class SheetEngine {
  private readonly u: Mod;
  private readonly cmd: Mod;
  private readonly undoSvc: Mod;
  private readonly res: Mod;
  private readonly wb: Mod;
  private recording: SheetMutation[] | undefined;
  private disposed = false;

  constructor(data: WorkbookData) {
    const m = univer();
    const { Univer, LocaleType, LogLevel, UniverInstanceType, ICommandService, IUndoRedoService } =
      m.core;
    this.u = new Univer({
      locale: LocaleType.EN_US,
      logLevel: LogLevel.SILENT ?? LogLevel.ERROR,
      locales: { [LocaleType.EN_US]: {} },
    });
    this.u.registerPlugin(m.formula.UniverFormulaEnginePlugin, { notExecuteFormula: false });
    this.u.registerPlugin(m.sheets.UniverSheetsPlugin);
    this.u.registerPlugin(m.sheetsFormula.UniverSheetsFormulaPlugin, { notExecuteFormula: false });
    this.u.registerPlugin(m.numfmt.UniverSheetsNumfmtPlugin);
    this.u.registerPlugin(m.filter.UniverSheetsFilterPlugin);
    this.u.registerPlugin(m.sort.UniverSheetsSortPlugin);
    this.wb = this.u.createUnit(UniverInstanceType.UNIVER_SHEET, plain({ ...data, id: UNIT }));
    const inj = this.u.__getInjector();
    // Undo works on the unit in focus: without a view nothing is focused unless we say so.
    inj.get(m.core.IUniverInstanceService).focusUnit(UNIT);
    this.cmd = inj.get(ICommandService);
    this.undoSvc = inj.get(IUndoRedoService);
    this.res = inj.get(m.core.IResourceManagerService);
    this.cmd.onCommandExecuted(
      (
        info: { id: string; type: number; params: unknown },
        o?: { onlyLocal?: boolean; fromCollab?: boolean },
      ) => {
        // Only what goes to collaborators: the rest each side makes again by itself (G37.0).
        if (!this.recording || info.type !== m.core.CommandType.MUTATION) return;
        if (o?.onlyLocal || o?.fromCollab) return;
        this.recording.push(plain({ id: info.id, params: info.params ?? {} }));
      },
    );
  }

  /** Applies mutations made elsewhere (the page, the log); false with the first that failed. */
  run(mutations: readonly SheetMutation[]): { ok: true } | { ok: false; id: string; why: string } {
    for (const mu of mutations) {
      if (!isMutation(mu.id)) continue;
      let ok = false;
      let why = "refused by the engine";
      try {
        ok = this.cmd.syncExecuteCommand(mu.id, plain({ ...(mu.params as object), unitId: UNIT }), {
          fromCollab: true,
        });
      } catch (err) {
        why = (err as Error).message;
      }
      if (!ok) return { ok: false, id: mu.id, why };
    }
    return { ok: true };
  }

  /** Runs one of Univer's commands; its mutations and their undo, or why not. */
  async command(id: string, params: object): Promise<Made | { error: string }> {
    const before = this.undoSvc.getUndoRedoStatus(UNIT).undos as number;
    const top = this.undoSvc.pitchTopUndoElement();
    const rec: SheetMutation[] = [];
    this.recording = rec;
    let ok = false;
    try {
      ok = await this.cmd.executeCommand(id, { ...params, unitId: UNIT });
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      this.recording = undefined;
    }
    if (!ok) return { error: "the sheet refused it" };
    const after = this.undoSvc.getUndoRedoStatus(UNIT).undos as number;
    const item = this.undoSvc.pitchTopUndoElement();
    const undo: SheetMutation[] =
      item && (after > before || item !== top)
        ? plain(item.undoMutations as SheetMutation[]).filter((x) => isMutation(x.id))
        : [];
    return { redo: rec.filter((x) => isMutation(x.id)), undo };
  }

  /** The workbook as it is now (a copy). */
  snapshot(): WorkbookData {
    const data = plain(this.wb.save()) as WorkbookData;
    delete data.rev;
    const resources = (this.res.getResources(UNIT) as { name: string; data: string }[]).filter(
      (r) => KEPT_RESOURCES.has(r.name) && r.data && r.data !== "{}" && r.data !== "",
    );
    if (resources.length) data.resources = plain(resources);
    else delete data.resources;
    return data;
  }

  /** Formulas computed again (all of them), waiting at most `ms`. */
  async calculate(ms = 3000): Promise<void> {
    const m = univer();
    const calc = this.u.__getInjector().get(m.formula.ICalculateFormulaService);
    const done = new Promise<void>((resolve) => {
      const sub = calc.executionCompleteListener$.subscribe(() => {
        sub.unsubscribe();
        resolve();
      });
      setTimeout(() => {
        sub.unsubscribe();
        resolve();
      }, ms).unref?.();
    });
    this.cmd.executeCommand(
      m.formula.SetFormulaCalculationStartMutation.id,
      { commands: [], forceCalculation: true },
      { onlyLocal: true },
    );
    await done;
  }

  /** The formula of a cell, also when it shares another cell's (`si`). */
  formulaAt(sheet: string, r: number, c: number): string | undefined {
    const m = univer();
    const raw = this.wb.getSheetBySheetId(sheet)?.getCellRaw(r, c);
    if (raw?.f) return raw.f as string;
    if (!raw?.si) return undefined;
    try {
      const fd = this.u.__getInjector().get(m.formula.FormulaDataModel);
      return (fd.getFormulaStringByCell(r, c, sheet, UNIT) as string | null) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** A cell as it is now: its value, formula (shared ones resolved) and style as an object. */
  cellAt(sheet: string, r: number, c: number): CellData & { s?: Style } {
    const ws = this.wb.getSheetBySheetId(sheet);
    const raw = ws?.getCellRaw(r, c) as CellData | undefined;
    if (!raw) return {};
    const out: CellData & { s?: Style } = {};
    if (raw.v !== undefined && raw.v !== null) out.v = raw.v;
    if (raw.t !== undefined && raw.t !== null) out.t = raw.t;
    const f = raw.f ?? (raw.si ? this.formulaAt(sheet, r, c) : undefined);
    if (f) out.f = f;
    const s =
      typeof raw.s === "string"
        ? (this.wb.getStyles().get(raw.s) as Style | undefined)
        : (raw.s as Style | undefined);
    if (s && Object.keys(s).length) out.s = plain(s);
    return out;
  }

  /** A sheet's name and place, if it is there. */
  sheetInfo(sheet: string): { name: string; index: number } | undefined {
    const ws = this.wb.getSheetBySheetId(sheet);
    if (!ws) return undefined;
    const order = (this.wb.getSheetOrders?.() as string[] | undefined) ?? [];
    return { name: ws.getName() as string, index: order.indexOf(sheet) };
  }

  /** A sheet's data as it is now (a copy). */
  sheetData(sheet: string): SheetData | undefined {
    const ws = this.wb.getSheetBySheetId(sheet);
    return ws ? (plain(ws.getSnapshot()) as SheetData) : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.u.dispose();
    } catch {}
  }
}

// ---- one engine per model, a few at a time ------------------------------------------------

const MAX_ENGINES = 4;
const live = new Map<SheetModel, SheetEngine>();

/** The engine standing at this model (taken: the caller moves it to the next model or drops it). */
export function takeEngine(model: SheetModel): SheetEngine {
  const e = live.get(model);
  if (e) {
    live.delete(model);
    return e;
  }
  return new SheetEngine(model.wb);
}

/** The engine stands at this model now. */
export function keepEngine(model: SheetModel, e: SheetEngine): void {
  live.set(model, e);
  while (live.size > MAX_ENGINES) {
    const [oldest, oe] = live.entries().next().value as [SheetModel, SheetEngine];
    live.delete(oldest);
    oe.dispose();
  }
}

/** Every engine dropped (tests, shutdown). */
export function dropEngines(): void {
  for (const e of live.values()) e.dispose();
  live.clear();
}
