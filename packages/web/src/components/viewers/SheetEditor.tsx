// The sheet editor in the canvas (G37.3), inside the editor's shell (DocEditor.tsx): Univer in its
// own island (viewers/univer-island.ts, loaded only now), wired to the server's host through
// viewers/sheet-collab.ts. Around it: what saving keeps (a CSV keeps values only), the
// placeholders for charts and pivot tables (outlined in the grid, seen in «Pagine»), the open
// copy of a closed original with its switch to write it back, «Esporta come…», the save's state.
import type { DocChange, DocFile, DocSnapshot, SheetPlaceholder } from "@redgiant/protocol";
import { docKey, PERSON } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { lang, t, tOptional } from "../../i18n.js";
import { IconDownload, IconSpinner } from "../../icons.js";
import { attempt, docView, getApi, openDoc, sendDoc } from "../../state.js";
import { theme } from "../../theme.js";
import { freshAgentWrites } from "../../viewers/collab.js";
import { cellPos, columnLetters, SheetCollab, wroteAreas } from "../../viewers/sheet-collab.js";
import { download } from "../../viewers/source.js";
import type { Island } from "../../viewers/univer-island.js";
import { PagedView } from "./OpenCopy.js";

/** The sheets the page edits (G37.3); an XLSX/XLS/Numbers is edited on its ODS copy. */
export const SHEET_EDITABLE = /\.(csv|tsv|ods)$/i;

const GESTURE_MS = 2000;
const HIGHLIGHT_MS = 8000;

const dark = () =>
  theme.value === "dark" ||
  (theme.value === "system" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches);

const area = (p: { r0: number; c0: number; r1: number; c1: number }) => {
  const a = `${columnLetters(p.c0 + 1)}${p.r0 + 1}`;
  return p.r0 === p.r1 && p.c0 === p.c1 ? a : `${a}:${columnLetters(p.c1 + 1)}${p.r1 + 1}`;
};

const KEPT: Record<string, string> = {
  "conditional formats": "sheetKeep_conditional",
  "print ranges": "sheetKeep_print",
  validations: "sheetKeep_validations",
  "named ranges": "sheetKeep_named",
  "filters and database ranges": "sheetKeep_filters",
  "macros (never run)": "sheetKeep_macros",
  scenarios: "sheetKeep_scenarios",
  comments: "sheetKeep_comments",
};

/** A placeholder in words: «grafico «Totali» su Vendite A20:F35». */
export function placeholderText(p: SheetPlaceholder, sheetName: (id: string) => string): string {
  const vars = {
    name: p.name ? `«${p.name}» ` : "",
    sheet: sheetName(p.sheet),
    range: area(p),
    source: p.source ?? "",
  };
  const key =
    p.kind === "chart"
      ? p.source
        ? "sheetPhChartReads"
        : "sheetPhChart"
      : p.kind === "pivot"
        ? "sheetPhPivot"
        : p.kind === "image"
          ? "sheetPhImage"
          : p.kind === "shape"
            ? "sheetPhShape"
            : "sheetPhObject";
  return t(key, vars);
}

type Snap = Extract<DocSnapshot, { family: "sheet" }>;

export function SheetEditor({
  file,
  onReveal,
}: {
  file: DocFile;
  /** The shell's «show me» for a change of the panel. */
  onReveal: (reveal: ((c: DocChange) => void) | undefined) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const [snap, setSnap] = useState<Snap>();
  const [mode, setMode] = useState<"edit" | "pages">("edit");
  const [info, setInfo] = useState<Awaited<ReturnType<ReturnType<typeof getApi>["sheetInfo"]>>>();
  const [reexport, setReexport] = useState(false);
  const [pagesUrl, setPagesUrl] = useState<string>();
  const [exporting, setExporting] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [loadingIsland, setLoadingIsland] = useState(true);
  const v = docView(file).value;

  useEffect(() => {
    void getApi()
      .sheetInfo(file.scope, file.path)
      .then(setInfo, () => {});
    void getApi()
      .editorSettings()
      .then(
        (r) => setReexport(r.settings.reexport?.[docKey(file)] === true),
        () => {},
      );
  }, [file.scope, file.path]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let island: Island | undefined;
    let mount: ((s: Snap) => void) | undefined;
    let latest: { snap: Snap; revision: number } | undefined;
    let sheets: string[] = [];
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    let lastKey = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const collab = new SheetCollab((o) =>
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: o.ops,
        groupId: group,
      }),
    );
    const resync = () => sendDoc({ type: "doc.open", file });
    /** Opened after an agent edited it (p3.5.3): its cells highlighted as if seen live, once. */
    let marked = false;
    const markFresh = () => {
      if (marked || !island) return;
      marked = true;
      const fresh = freshAgentWrites(docView(file).value.changes, collab.revision);
      if (fresh.length)
        setTimeout(() => island?.mark(wroteAreas(fresh, sheets), HIGHLIGHT_MS), 400);
    };
    const show = (s: Snap, revision: number) => {
      collab.reset(revision);
      sheets = (s.workbook.sheetOrder as string[] | undefined) ?? [];
      setSnap(s);
      if (island) island.load(s.workbook, s.placeholders);
      else if (mount) mount(s);
      else latest = { snap: s, revision };
      markFresh();
    };
    const agentColor =
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2f6fde";
    void import("../../viewers/univer-island.js").then(
      (m) => {
        if (closed) return;
        mount = (s: Snap) => {
          island = m.mountSheet({
            container: el,
            workbook: s.workbook,
            placeholders: s.placeholders,
            lang: lang.value === "it" ? "it" : "en",
            dark: dark(),
            toolbar: s.format === "ods",
            agentColor: /^#[0-9a-f]{6}$/i.test(agentColor) ? agentColor : "#2f6fde",
            onOps(op) {
              collab.local(op);
              const now = Date.now();
              if (now - lastKey > GESTURE_MS)
                group = `g-${Math.random().toString(36).slice(2, 10)}`;
              lastKey = now;
              if (sendTimer) clearTimeout(sendTimer);
              sendTimer = setTimeout(() => collab.flush(), 150);
            },
            onPlace(p) {
              const pos = cellPos(p.sheet, p.r, p.c);
              sendDoc({
                type: "doc.presence",
                file,
                editing: p.editing,
                from: pos,
                to: pos,
                revision: collab.revision,
              });
            },
          });
          setLoadingIsland(false);
        };
        if (latest) {
          mount(latest.snap);
          latest = undefined;
          markFresh();
        }
      },
      (e: unknown) => setFailed((e as Error).message),
    );
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family === "sheet") show(snapshot, revision);
      },
      replaced(m) {
        if (m.snapshot.family === "sheet") show(m.snapshot, m.revision);
      },
      changed(m) {
        if (!island) return resync();
        const r = collab.remote(m.revision, m.ops);
        if (r === "resync") return resync();
        const ok = island.remote(m.ops.flatMap((o) => (o.family === "sheet" ? o.op.redo : [])));
        if (!ok) return resync();
        if (m.change.author !== PERSON)
          island.mark(wroteAreas(m.change.wrote ?? [], sheets), HIGHLIGHT_MS);
      },
      ack(m) {
        collab.ack(m.clientId, m.revision);
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) resync();
      },
    });
    onReveal((c) => {
      const a = wroteAreas(c.wrote ?? [], sheets)[0];
      if (a && island) island.reveal(a);
    });
    const unsub = theme.subscribe(() => island?.setDark(dark()));
    return () => {
      closed = true;
      if (sendTimer) clearTimeout(sendTimer);
      collab.flush();
      unsub();
      close();
      onReveal(undefined);
      island?.dispose();
    };
  }, [file.scope, file.path]);

  useEffect(() => {
    if (mode !== "pages" || pagesUrl) return;
    void getApi()
      .canvasLink({ kind: "file", scope: file.scope, path: file.path })
      .then(
        (r) => setPagesUrl(r.url),
        () => {},
      );
  }, [mode]);

  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  const sheetName = (id: string) =>
    (snap?.workbook.sheets as Record<string, { name?: string }> | undefined)?.[id]?.name ?? "?";
  const exportAs = async (to: string) => {
    setExporting(to);
    setFailed(undefined);
    try {
      const blob = await getApi().sheetExport(file.scope, file.path, to);
      const url = URL.createObjectURL(blob);
      download(url, `${name.replace(/\.[^.]+$/, "")}.${to}`);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      setFailed(t("sheetExportFailed", { reason: (e as Error).message }));
    } finally {
      setExporting(undefined);
    }
  };
  const toggleReexport = (on: boolean) =>
    void attempt(async () => {
      const a = getApi();
      const { settings } = await a.editorSettings();
      const next = { ...(settings.reexport ?? {}) };
      if (on) next[docKey(file)] = true;
      else delete next[docKey(file)];
      await a.setEditorSettings({ ...settings, reexport: next });
      setReexport(on);
    });
  const saved = v.saved;
  const kept = (snap?.kept ?? []).map((k) => tOptional(KEPT[k] ?? "") ?? k);
  return (
    <div class="sheet-editor">
      <div class="sheet-bar">
        <fieldset class="vw-seg" aria-label={t("sheetModeHint")}>
          <button
            type="button"
            class={mode === "edit" ? "on" : ""}
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
          >
            {t("sheetModeEdit")}
          </button>
          <button
            type="button"
            class={mode === "pages" ? "on" : ""}
            aria-pressed={mode === "pages"}
            title={t("sheetModeHint")}
            onClick={() => setMode("pages")}
          >
            {t("sheetModePages")}
          </button>
        </fieldset>
        {saved?.error ? (
          <span class="sheet-save warn" role="status">
            {saved.waitsFor ? <IconSpinner size={13} /> : null}
            {saved.waitsFor ? t("sheetSaveWaits") : t("sheetSaveFailed", { reason: saved.error })}
          </span>
        ) : saved ? (
          <span class="sheet-save dim" role="status">
            {t("sheetSaved")}
          </span>
        ) : null}
        <div class="spacer" />
        <label class="sheet-export">
          <IconDownload size={14} />
          <select
            aria-label={t("sheetExport")}
            value=""
            disabled={!!exporting}
            onChange={(e) => {
              const to = (e.target as HTMLSelectElement).value;
              (e.target as HTMLSelectElement).value = "";
              if (to) void exportAs(to);
            }}
          >
            <option value="">{exporting ? t("loading") : t("sheetExport")}</option>
            <option value="xlsx">{t("sheetExportXlsx")}</option>
            <option value="ods">{t("sheetExportOds")}</option>
            <option value="csv">{t("sheetExportCsv")}</option>
            <option value="pdf">{t("sheetExportPdf")}</option>
          </select>
        </label>
      </div>
      {(snap && snap.format !== "ods") ||
      info?.original ||
      snap?.placeholders.length ||
      kept.length ||
      failed ? (
        <div class="sheet-notes">
          {snap && snap.format !== "ods" && (
            <p class="sheet-note">{t("sheetCsvNote", { kind: snap.format.toUpperCase() })}</p>
          )}
          {info?.original && (
            <p class="sheet-note">
              {t("sheetCopyOf", { name: info.original })}{" "}
              {!info.noReexport && (
                <label class="sheet-switch" title={t("sheetReexportHint")}>
                  <input
                    type="checkbox"
                    checked={reexport}
                    onChange={(e) => toggleReexport((e.target as HTMLInputElement).checked)}
                  />
                  {t("sheetReexport", { name: info.original })}
                </label>
              )}
            </p>
          )}
          {snap && snap.placeholders.length > 0 && (
            <p class="sheet-note">
              {t("sheetPlaceholders", {
                list: snap.placeholders
                  .slice(0, 8)
                  .map((p) => placeholderText(p, sheetName))
                  .join("; "),
              })}
            </p>
          )}
          {kept.length > 0 && (
            <p class="sheet-note dim">{t("sheetKept", { list: kept.join(", ") })}</p>
          )}
          {failed && (
            <p class="sheet-note warn" role="alert">
              {failed}
            </p>
          )}
        </div>
      ) : null}
      <div class="sheet-body">
        <section
          class="sheet-grid"
          ref={host}
          aria-label={t("sheetEditorLabel")}
          style={mode === "edit" ? undefined : { display: "none" }}
        />
        {mode === "edit" && loadingIsland && (
          <div class="vw-empty dim sheet-loading">
            <IconSpinner size={16} /> {t("sheetLoading")}
          </div>
        )}
        {mode === "pages" &&
          (pagesUrl ? (
            // Again after each save: the pages of the file as it is now.
            <PagedView
              key={String(saved?.revision ?? 0)}
              scope={file.scope}
              path={file.path}
              name={name}
              url={pagesUrl}
            />
          ) : (
            <div class="vw-empty dim">{t("loading")}</div>
          ))}
      </div>
    </div>
  );
}
