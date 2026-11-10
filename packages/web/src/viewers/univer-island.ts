// The sheet editor's island (G37.3): Univer with its own view (React inside, our page is Preact),
// loaded only when a sheet opens: its own chunk, never in the main bundle. Only Apache-2.0 packages
// (no import/export of XLSX, charts, pivots or printing: those are paid). The page talks to it
// through a small handle: what the person did (each command's mutations with Univer's own undo
// mutations), others' mutations to apply, the agent's cells to highlight, the placeholders to
// outline, light or dark. Univer's own Ctrl+Z undoes only the person's commands (others' arrive as
// collaboration and never enter its stack).
import "@univerjs/design/lib/index.css";
import "@univerjs/ui/lib/index.css";
import "@univerjs/docs-ui/lib/index.css";
import "@univerjs/sheets-ui/lib/index.css";
import "@univerjs/sheets-formula-ui/lib/index.css";
import "@univerjs/sheets-numfmt-ui/lib/index.css";
import "@univerjs/sheets-filter-ui/lib/index.css";
import "@univerjs/sheets-sort-ui/lib/index.css";

import type { SheetMutation, SheetPlaceholder } from "@redgiant/protocol";
import {
  CommandType,
  ICommandService,
  IUndoRedoService,
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  ThemeService,
  Univer,
  UniverInstanceType,
} from "@univerjs/core";
import DesignEn from "@univerjs/design/locale/en-US";
import DesignIt from "@univerjs/design/locale/it-IT";
import { UniverDocsPlugin } from "@univerjs/docs";
import { UniverDocsUIPlugin } from "@univerjs/docs-ui";
import DocsUiEn from "@univerjs/docs-ui/locale/en-US";
import DocsUiIt from "@univerjs/docs-ui/locale/it-IT";
import { UniverFormulaEnginePlugin } from "@univerjs/engine-formula";
import { UniverRenderEnginePlugin } from "@univerjs/engine-render";
import {
  SetSelectionsOperation,
  SetWorksheetActiveOperation,
  UniverSheetsPlugin,
} from "@univerjs/sheets";
import SheetsEn from "@univerjs/sheets/locale/en-US";
import SheetsIt from "@univerjs/sheets/locale/it-IT";
import { UniverSheetsFilterPlugin } from "@univerjs/sheets-filter";
import { UniverSheetsFilterUIPlugin } from "@univerjs/sheets-filter-ui";
import FilterUiEn from "@univerjs/sheets-filter-ui/locale/en-US";
import FilterUiIt from "@univerjs/sheets-filter-ui/locale/it-IT";
import { UniverSheetsFormulaPlugin } from "@univerjs/sheets-formula";
import { UniverSheetsFormulaUIPlugin } from "@univerjs/sheets-formula-ui";
import FormulaUiEn from "@univerjs/sheets-formula-ui/locale/en-US";
import FormulaUiIt from "@univerjs/sheets-formula-ui/locale/it-IT";
import { UniverSheetsNumfmtPlugin } from "@univerjs/sheets-numfmt";
import { UniverSheetsNumfmtUIPlugin } from "@univerjs/sheets-numfmt-ui";
import NumfmtUiEn from "@univerjs/sheets-numfmt-ui/locale/en-US";
import NumfmtUiIt from "@univerjs/sheets-numfmt-ui/locale/it-IT";
import { UniverSheetsSortPlugin } from "@univerjs/sheets-sort";
import { UniverSheetsSortUIPlugin } from "@univerjs/sheets-sort-ui";
import SortUiEn from "@univerjs/sheets-sort-ui/locale/en-US";
import SortUiIt from "@univerjs/sheets-sort-ui/locale/it-IT";
import {
  IMarkSelectionService,
  SetCellEditVisibleOperation,
  UniverSheetsUIPlugin,
} from "@univerjs/sheets-ui";
import SheetsUiEn from "@univerjs/sheets-ui/locale/en-US";
import SheetsUiIt from "@univerjs/sheets-ui/locale/it-IT";
import { UniverUIPlugin } from "@univerjs/ui";
import UiEn from "@univerjs/ui/locale/en-US";
import UiIt from "@univerjs/ui/locale/it-IT";
import { SHEET_UNIT } from "./sheet-collab.js";

export interface Area {
  sheet: string;
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface IslandOptions {
  container: HTMLElement;
  workbook: Record<string, unknown>;
  placeholders: SheetPlaceholder[];
  lang: "it" | "en";
  dark: boolean;
  /** CSV/TSV keep values only: no formatting bar. */
  toolbar: boolean;
  /** The agent's colour, for its highlight. */
  agentColor: string;
  /** One of the person's commands: its mutations and the ones that take it back. */
  onOps(op: { redo: SheetMutation[]; undo: SheetMutation[] }): void;
  /** Where the person is (the active cell), and whether they are typing in it. */
  onPlace(place: { sheet: string; r: number; c: number; editing: boolean }): void;
}

export interface Island {
  /** Others' mutations; false when one could not apply (the page loads the file again). */
  remote(mutations: readonly SheetMutation[]): boolean;
  /** The workbook again (opened, replaced, resynchronised). */
  load(workbook: Record<string, unknown>, placeholders: SheetPlaceholder[]): void;
  /** The agent's cells highlighted; the function returned takes the highlight off. */
  mark(areas: readonly Area[]): () => void;
  /** Shows an area (the panel «Modifiche»: «show me»). */
  reveal(area: Area): void;
  setDark(dark: boolean): void;
  dispose(): void;
}

type Locale = Record<string, unknown>;
function merge(...all: Locale[]): Locale {
  const out: Locale = {};
  const into = (t: Locale, s: Locale) => {
    for (const [k, v] of Object.entries(s)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const cur = (t[k] && typeof t[k] === "object" ? t[k] : {}) as Locale;
        t[k] = cur;
        into(cur, v as Locale);
      } else t[k] = v;
    }
  };
  for (const l of all) into(out, l);
  return out;
}

const EN = [
  DesignEn,
  UiEn,
  DocsUiEn,
  SheetsEn,
  SheetsUiEn,
  FormulaUiEn,
  NumfmtUiEn,
  FilterUiEn,
  SortUiEn,
];
const IT = [
  DesignIt,
  UiIt,
  DocsUiIt,
  SheetsIt,
  SheetsUiIt,
  FormulaUiIt,
  NumfmtUiIt,
  FilterUiIt,
  SortUiIt,
];

const isMutation = (id: string) => id.includes(".mutation.");
/** A mutation of the sheet itself (not of Univer's own cell editor, a document of its own). */
const isSheetMutation = (m: { id: string; params?: unknown }) =>
  m.id.startsWith("sheet.mutation.") &&
  ((m.params as { unitId?: string } | undefined)?.unitId ?? SHEET_UNIT) === SHEET_UNIT;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

export function mountSheet(o: IslandOptions): Island {
  const locale = o.lang === "it" ? LocaleType.IT_IT : LocaleType.EN_US;
  const univer = new Univer({
    locale,
    locales: {
      [LocaleType.EN_US]: merge(...(EN as Locale[])) as never,
      [LocaleType.IT_IT]: merge(...(EN as Locale[]), ...(IT as Locale[])) as never,
    },
    logLevel: LogLevel.ERROR,
    darkMode: o.dark,
  });
  univer.registerPlugin(UniverRenderEnginePlugin);
  univer.registerPlugin(UniverFormulaEnginePlugin);
  univer.registerPlugin(UniverUIPlugin, {
    container: o.container,
    header: true,
    toolbar: o.toolbar,
    footer: true,
    contextMenu: true,
  });
  univer.registerPlugin(UniverDocsPlugin);
  univer.registerPlugin(UniverDocsUIPlugin);
  univer.registerPlugin(UniverSheetsPlugin);
  univer.registerPlugin(UniverSheetsUIPlugin);
  univer.registerPlugin(UniverSheetsFormulaPlugin);
  univer.registerPlugin(UniverSheetsFormulaUIPlugin);
  univer.registerPlugin(UniverSheetsNumfmtPlugin);
  univer.registerPlugin(UniverSheetsNumfmtUIPlugin);
  univer.registerPlugin(UniverSheetsFilterPlugin);
  univer.registerPlugin(UniverSheetsFilterUIPlugin);
  univer.registerPlugin(UniverSheetsSortPlugin);
  univer.registerPlugin(UniverSheetsSortUIPlugin);
  const inj = univer.__getInjector();
  const cmd = inj.get(ICommandService);
  const undo = inj.get(IUndoRedoService);
  const instances = inj.get(IUniverInstanceService);
  let placeholders = o.placeholders;
  const activeWs = () =>
    (
      instances.getUnit(SHEET_UNIT) as unknown as
        | { getActiveSheet?(): { getSheetId(): string } | undefined }
        | undefined
    )?.getActiveSheet?.();
  let applyingRemote = false;
  let disposed = false;

  const create = (wb: Record<string, unknown>) => {
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, plain({ ...wb, id: SHEET_UNIT }));
  };
  create(o.workbook);

  // ---- the person's commands, with their undo ------------------------------------------
  let depth = 0;
  let collected: SheetMutation[] = [];
  let undoBefore = 0;
  let topBefore: unknown;
  let undoItem: { undoMutations: SheetMutation[]; redoMutations: SheetMutation[] } | null = null;
  let undoKind: "undo" | "redo" | undefined;
  const subs: { dispose(): void }[] = [];
  subs.push(
    cmd.beforeCommandExecuted((info: { id: string; type?: number }) => {
      if (applyingRemote || info.type !== CommandType.COMMAND) return;
      if (depth++ > 0) return;
      collected = [];
      undoBefore = undo.getUndoRedoStatus(SHEET_UNIT).undos;
      topBefore = undo.pitchTopUndoElement();
      undoKind =
        info.id === "univer.command.undo"
          ? "undo"
          : info.id === "univer.command.redo"
            ? "redo"
            : undefined;
      undoItem =
        undoKind === "undo"
          ? (undo.pitchTopUndoElement() as never)
          : undoKind === "redo"
            ? (undo.pitchTopRedoElement() as never)
            : null;
    }),
  );
  const finish = () => {
    const redo = collected.filter(isSheetMutation);
    collected = [];
    if (!redo.length) return;
    let back: SheetMutation[] = [];
    if (undoKind && undoItem)
      back = plain(undoKind === "undo" ? undoItem.redoMutations : undoItem.undoMutations);
    else {
      const top = undo.pitchTopUndoElement() as { undoMutations?: SheetMutation[] } | null;
      if (top && (undo.getUndoRedoStatus(SHEET_UNIT).undos > undoBefore || top !== topBefore))
        back = plain(top.undoMutations ?? []);
    }
    o.onOps({ redo, undo: back.filter(isSheetMutation) });
  };
  subs.push(
    cmd.onCommandExecuted(
      (
        info: { id: string; type?: number; params?: unknown },
        opts?: { onlyLocal?: boolean; fromCollab?: boolean },
      ) => {
        if (applyingRemote) return;
        if (info.type === CommandType.MUTATION) {
          if (opts?.onlyLocal || opts?.fromCollab) return;
          const m = { id: info.id, params: plain(info.params ?? {}) };
          if (!isSheetMutation(m)) return;
          collected.push(m);
          // A mutation outside any command (rare): sent on its own.
          if (depth === 0) queueMicrotask(finish);
          return;
        }
        if (info.type === CommandType.COMMAND && depth > 0 && --depth === 0) finish();
        if (info.id === SetSelectionsOperation.id) {
          const p = info.params as {
            subUnitId?: string;
            selections?: { range: { startRow: number; startColumn: number } }[];
          };
          const r = p.selections?.[0]?.range;
          if (p.subUnitId && r)
            o.onPlace({ sheet: p.subUnitId, r: r.startRow, c: r.startColumn, editing: false });
        }
        if (info.id === SetCellEditVisibleOperation.id) {
          const visible = (info.params as { visible?: boolean })?.visible === true;
          const ws = activeWs();
          const sel = lastSel;
          if (ws && sel)
            o.onPlace({ sheet: ws.getSheetId(), r: sel.r, c: sel.c, editing: visible });
        }
        if (info.id === SetWorksheetActiveOperation.id) setTimeout(outline, 0);
      },
    ),
  );
  let lastSel: { r: number; c: number } | undefined;
  subs.push(
    cmd.onCommandExecuted((info: { id: string; params?: unknown }) => {
      if (info.id !== SetSelectionsOperation.id) return;
      const r = (
        info.params as { selections?: { range: { startRow: number; startColumn: number } }[] }
      )?.selections?.[0]?.range;
      if (r) lastSel = { r: r.startRow, c: r.startColumn };
    }),
  );

  // ---- marks: the agent's cells and the placeholders ------------------------------------
  const marks = () => {
    try {
      return inj.get(IMarkSelectionService) as {
        addShape(s: unknown, exits?: string[], z?: number): string | null;
        removeShape(id: string): void;
      };
    } catch {
      return undefined;
    }
  };
  const activeSheet = () => activeWs()?.getSheetId();
  const shape = (a: Area, style: Record<string, unknown>) =>
    marks()?.addShape({
      range: { startRow: a.r0, endRow: a.r1, startColumn: a.c0, endColumn: a.c1, rangeType: 0 },
      primary: null,
      style,
    });
  let outlines: string[] = [];
  function outline() {
    if (disposed) return;
    for (const id of outlines) marks()?.removeShape(id);
    outlines = [];
    const sheet = activeSheet();
    // Only a pivot table's output is outlined (its cells cannot be edited here). A chart or a
    // picture floats over cells it has nothing to do with: outlined, it looked like a strange
    // selection over the data (p3.5.3); the notes above the grid name it and its cells.
    for (const p of placeholders)
      if (p.sheet === sheet && p.kind === "pivot") {
        const id = shape(p, {
          strokeWidth: 1.5,
          stroke: "#8a8f98",
          strokeDash: 6,
          fill: "rgba(138, 143, 152, 0.10)",
          widgets: {},
          hasAutoFill: false,
          hasRowHeader: false,
          hasColumnHeader: false,
        });
        if (id) outlines.push(id);
      }
  }
  setTimeout(outline, 300);

  return {
    remote(mutations) {
      applyingRemote = true;
      try {
        for (const m of mutations) {
          if (!isMutation(m.id)) continue;
          const ok = cmd.syncExecuteCommand(
            m.id,
            plain({ ...(m.params as object), unitId: SHEET_UNIT }),
            {
              fromCollab: true,
            },
          );
          if (!ok) return false;
        }
        return true;
      } catch {
        return false;
      } finally {
        applyingRemote = false;
      }
    },
    load(workbook, ph) {
      placeholders = ph;
      applyingRemote = true;
      try {
        univer.__getInjector().get(IUniverInstanceService).disposeUnit(SHEET_UNIT);
        create(workbook);
      } finally {
        applyingRemote = false;
      }
      setTimeout(outline, 300);
    },
    mark(areas) {
      const sheet = activeSheet();
      const ids: string[] = [];
      for (const a of areas.slice(0, 50))
        if (a.sheet === sheet) {
          const id = shape(a, {
            strokeWidth: 2,
            stroke: o.agentColor,
            fill: `${o.agentColor}33`,
            widgets: {},
            hasAutoFill: false,
            hasRowHeader: false,
            hasColumnHeader: false,
          });
          if (id) ids.push(id);
        }
      return () => {
        if (!disposed) for (const id of ids) marks()?.removeShape(id);
      };
    },
    reveal(a) {
      void cmd
        .executeCommand(SetWorksheetActiveOperation.id, { unitId: SHEET_UNIT, subUnitId: a.sheet })
        .then(() =>
          cmd.executeCommand(SetSelectionsOperation.id, {
            unitId: SHEET_UNIT,
            subUnitId: a.sheet,
            selections: [
              {
                range: {
                  startRow: a.r0,
                  endRow: a.r1,
                  startColumn: a.c0,
                  endColumn: a.c1,
                  rangeType: 0,
                },
                primary: {
                  startRow: a.r0,
                  endRow: a.r0,
                  startColumn: a.c0,
                  endColumn: a.c0,
                  actualRow: a.r0,
                  actualColumn: a.c0,
                  isMerged: false,
                  isMergedMainCell: false,
                },
                style: null,
              },
            ],
          }),
        )
        .catch(() => {});
    },
    setDark(dark) {
      try {
        inj.get(ThemeService).setDarkMode(dark);
      } catch {}
    },
    dispose() {
      disposed = true;
      for (const s of subs) s.dispose();
      try {
        univer.dispose();
      } catch {}
    },
  };
}
