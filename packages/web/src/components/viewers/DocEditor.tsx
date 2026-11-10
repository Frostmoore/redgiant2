// The editor in the canvas (G37.1): the shell every family shares (its bar, who is in the file,
// the rule for the agents' edits, the panel «Modifiche» with «Annulla questa modifica» and
// «Annulla tutto il turno», the proposals to accept, the differences of a change, a turn or a
// proposal) around the family's own editor. Text and code are the first (TextEditor.tsx, G37.2):
// code, Markdown, JSON/YAML/XML and plain text. Nothing is saved from here: the host writes the file
// after a pause, or at once on Ctrl+S (Cmd+S), and the bar says «Salvato» (p3.5.1).
import type { EditorView } from "@codemirror/view";
import type { DocChange, DocFile, DocSummary } from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Key, t } from "../../i18n.js";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconEye,
  IconList,
  IconUndo,
  IconUser,
  IconX,
} from "../../icons.js";
import {
  agents,
  attempt,
  type DocView as DocViewState,
  dismissHeld,
  dismissOutside,
  dismissRefusal,
  docView,
  HELD_NOTICE_MS,
  saveDoc,
  sendDoc,
  setDocMode,
} from "../../state.js";
import { imageChangeText } from "../../viewers/image-words.js";
import { bareText, viewerFor } from "../../viewers/kind.js";
import { modelChangeText } from "../../viewers/model-ops.js";
import { isOfficeFile } from "../../viewers/office-bridge.js";
import { pdfChangeText } from "../../viewers/pdf-words.js";
import { sheetChangeText } from "../../viewers/sheet-words.js";
import { svgChangeText } from "../../viewers/svg-words.js";
import type { DocDiff as DiffView, DiffWhat } from "./DocDiff.js";
import { ImageEditor, pictureEditable } from "./ImageEditor.js";
import { MODEL_EDITABLE, ModelEditor } from "./ModelEditor.js";
import { OfficeEditor } from "./OfficeEditor.js";
import { isPdfFile, PdfEditor } from "./PdfEditor.js";
import { SHEET_EDITABLE, SheetEditor } from "./SheetEditor.js";
import { SVG_EDITABLE, SvgEditor } from "./SvgEditor.js";
import { TextEditor } from "./TextEditor.js";

/** The kinds of the viewer that are text the page edits (G37.2): code, Markdown, trees, text. */
const TEXT_KINDS = new Set(["text", "code", "markdown", "tree"]);
/** Whether the file is text or code the editor opens (by its name, as the server's text family). */
export const textEditable = (path: string) =>
  TEXT_KINDS.has(viewerFor(path).kind) || bareText(path);
export const editableInCanvas = (file: { scope: string; path: string }) =>
  file.scope !== "outside" &&
  (textEditable(file.path) ||
    SHEET_EDITABLE.test(file.path) ||
    isOfficeFile(file.path) ||
    SVG_EDITABLE.test(file.path) ||
    MODEL_EDITABLE.test(file.path) ||
    isPdfFile(file.path) ||
    pictureEditable(file));

// ---- words ---------------------------------------------------------------------------------

/** «2 righe cambiate e 3 righe aggiunte», or undefined when the summary has no lines (G37.2). */
export function linesText(s: DocSummary): string | undefined {
  if (s.linesChanged === undefined && s.linesAdded === undefined && s.linesRemoved === undefined)
    return undefined;
  const part = (n: number | undefined, one: Key, many: Key) =>
    n ? (n === 1 ? t(one) : t(many, { n: String(n) })) : undefined;
  const parts = [
    part(s.linesChanged, "docLineChanged1", "docLinesChanged"),
    part(s.linesAdded, "docLineAdded1", "docLinesAdded"),
    part(s.linesRemoved, "docLineRemoved1", "docLinesRemoved"),
  ].filter((p): p is string => !!p);
  if (parts.length === 0) return undefined;
  const last = parts.pop() as string;
  return parts.length ? t("docAnd", { a: parts.join(", "), b: last }) : last;
}

/** A change in the person's words: «3 righe aggiunte alla riga 7», «Cambiata la riga 4». */
export function changeText(s: DocSummary): string {
  // A sheet's change (G37.3) has its own words.
  if (s.sheet && s.kind !== "undo" && s.kind !== "replaced") return sheetChangeText(s);
  // A drawing's change (G37.6) too.
  if (s.svg && s.kind !== "undo" && s.kind !== "replaced") return svgChangeText(s);
  // A PDF's change (G37.8) too.
  if (s.pdf && s.kind !== "undo" && s.kind !== "replaced") return pdfChangeText(s);
  // A layered picture's change (G37.5) too.
  if (s.image && s.kind !== "undo" && s.kind !== "replaced") return imageChangeText(s);
  // A 3D model's change (G37.7) too.
  if (s.model && s.kind !== "undo" && s.kind !== "replaced") return modelChangeText(s);
  // Documents and presentations (G37.4) count paragraphs and slides.
  if (s.unit === "paragraph" || s.unit === "slide") {
    const para = s.unit === "paragraph";
    const span = s.lines && s.lines > 1;
    const at =
      s.line === undefined
        ? ""
        : span
          ? t(para ? "docAtParas" : "docAtSlides", {
              from: String(s.line),
              to: String(s.line + (s.lines ?? 1) - 1),
            })
          : t(para ? "docAtPara" : "docAtSlide", { n: String(s.line) });
    const what =
      s.kind === "undo"
        ? t("docUndid")
        : s.kind === "replaced"
          ? t("docReplaced")
          : s.count && s.count > 1
            ? t("docEdits", { n: String(s.count) })
            : s.kind === "insert"
              ? t("docOfficeInsert")
              : s.kind === "delete"
                ? t("docOfficeDelete")
                : s.kind === "replace"
                  ? t("docOfficeReplace")
                  : t("docOfficeEdit");
    return at ? `${what} ${at}` : what;
  }
  const at =
    s.line === undefined
      ? ""
      : s.lines && s.lines > 1
        ? t("docAtLines", { from: String(s.line), to: String(s.line + s.lines - 1) })
        : t("docAtLine", { n: String(s.line) });
  const lines = linesText(s);
  if (lines !== undefined) {
    const line = String(s.line ?? 1);
    if (s.kind === "edit")
      return t("docEditsLines", { n: String(s.count ?? 2), line, what: lines });
    if (s.kind === "undo") return t("docUndidLines", { what: lines });
    if (s.kind === "replaced") return t("docReplacedLines", { what: lines });
    if (!s.linesAdded && !s.linesRemoved)
      return s.lines && s.lines > 1
        ? t("docChangedLines", { from: line, to: String((s.line ?? 1) + s.lines - 1) })
        : t("docChangedLine", { n: line });
    if (s.kind === "delete") return `${lines} ${t("docFromLine", { n: line })}`;
    return at ? `${lines} ${at}` : lines;
  }
  // Changes told before G37.2: in characters.
  const where =
    s.kind === "edit" && s.line !== undefined ? t("docFromLine", { n: String(s.line) }) : at;
  const n = (k: "docInserted" | "docDeleted", v: number | undefined) => t(k, { n: String(v ?? 0) });
  const what =
    s.kind === "insert"
      ? n("docInserted", s.added)
      : s.kind === "delete"
        ? n("docDeleted", s.removed)
        : s.kind === "undo"
          ? t("docUndid")
          : s.kind === "replaced"
            ? t("docReplaced")
            : s.kind === "edit"
              ? t("docEdits", { n: String(s.count ?? 2) })
              : t("docReplacedChars", { a: String(s.removed ?? 0), b: String(s.added ?? 0) });
  return where ? `${what} ${where}` : what;
}

/** Why an agent's edit stopped, in the person's words (p3.5.4). */
export function heldText(
  h: { code: "busy" | "conflict"; line?: number | undefined },
  name: string,
): string {
  const line = h.line === undefined ? undefined : String(h.line);
  if (h.code === "busy")
    return line ? t("docHeldBusyLine", { name, line }) : t("docHeldBusy", { name });
  return line ? t("docHeldConflictLine", { name, line }) : t("docHeldConflict", { name });
}

export function whoText(c: {
  author: string;
  authorName?: string | undefined;
  replaced?: boolean | undefined;
}): string {
  if (c.replaced || c.author === "outside") return t("docWhoOutside");
  if (c.author === PERSON) return t("docWhoYou");
  return c.authorName ?? agents.value.find((a) => a.id === c.author)?.name ?? c.author;
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return t("docJustNow");
  if (s < 3600) return t("docMinutesAgo", { n: String(Math.round(s / 60)) });
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/** The panel's lines grouped as they were made: an agent's turn, the person's gestures. */
export function groupChanges(
  changes: readonly DocChange[],
): { groupId: string; items: DocChange[] }[] {
  const out: { groupId: string; items: DocChange[] }[] = [];
  for (const c of changes) {
    const last = out.at(-1);
    if (last && last.groupId === c.groupId) last.items.push(c);
    else out.push({ groupId: c.groupId, items: [c] });
  }
  return out;
}

/** What the bar says of the file on disk (p3.5.1): saving, saved, not yet, or why not. */
export function saveState(
  v: Pick<DocViewState, "revision" | "saved" | "opened" | "saving">,
): "saving" | "saved" | "unsaved" | "failed" | undefined {
  if (v.saved?.error) return "failed";
  if (v.saving) return "saving";
  const onDisk = v.saved?.revision ?? v.opened;
  if (onDisk === undefined) return undefined;
  if (v.revision > onDisk) return "unsaved";
  return v.saved ? "saved" : undefined;
}

/** The «as set for the agent» choice in words: what it means for this file now. */
export function defaultModeLabel(proposing: readonly string[]): string {
  if (!proposing.length) return t("docModeDefaultNow");
  const names = proposing.slice(0, 3).join(", ") + (proposing.length > 3 ? "…" : "");
  return t("docModeDefaultSome", { names });
}

/** Ctrl+S or Cmd+S (not with Alt or Shift: those are the browser's or the person's own). */
export const isSaveKey = (
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s";

// ---- the shell -----------------------------------------------------------------------------

let asks = 0;
const askId = () => `u${Date.now().toString(36)}${(asks++).toString(36)}`;

export function DocEditor({
  file,
  line,
  page,
  fallback,
}: {
  file: DocFile;
  /** A citation's line (G36.4). */
  line?: number | undefined;
  /** A citation's page, in a PDF (G37.8). */
  page?: number | undefined;
  /** What to show when the host cannot edit this file (too big, not UTF-8): the viewer. */
  fallback?: () => ComponentChildren;
}) {
  const v = docView(file).value;
  const name = file.path.split(/[\\/]/).pop() ?? file.path;
  /** The differences shown over the text (G37.2): of a group (turn, gesture) or a proposal. */
  const [diff, setDiffNow] = useState<{ what: DiffWhat; title: string; proposalId?: string }>();
  // @codemirror/merge comes only when a difference is asked.
  const [Diff, setDiffView] = useState<typeof DiffView>();
  const setDiff = (d: typeof diff) => {
    if (d && !Diff) void import("./DocDiff.js").then((m) => setDiffView(() => m.DocDiff));
    setDiffNow(d);
  };
  const [panel, setPanel] = useState(() =>
    typeof window.matchMedia === "function"
      ? !window.matchMedia("(max-width: 760px)").matches
      : true,
  );
  const view = useRef<EditorView | undefined>(undefined);
  const reveal = useRef<((c: DocChange) => void) | undefined>(undefined);
  const sheet = SHEET_EDITABLE.test(file.path);
  const pdf = isPdfFile(file.path);
  /** What each of the person's requests was about (to offer «Torna a prima» after a refusal). */
  const asked = useRef(new Map<string, { revision?: number; groupId?: string }>());
  const [, tick] = useState(0);
  // «2 minuti fa» stays true.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const groups = useMemo(() => groupChanges(v.changes), [v.changes]);
  // An agent stopped by the person (p3.5.4): the notice goes after a moment.
  const heldAt = v.held?.at;
  useEffect(() => {
    if (heldAt === undefined) return;
    const timer = setTimeout(() => dismissHeld(file, heldAt), HELD_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [heldAt]);
  const refusal = v.refusal && asked.current.get(v.refusal.clientId);
  const undo = (what: { revision?: number; toBefore?: boolean; groupId?: string }) => {
    dismissRefusal(file);
    const clientId = askId();
    asked.current.set(clientId, what);
    sendDoc({ type: "doc.undo", file, clientId, ...what });
  };
  const show = (c: DocChange) => {
    if (sheet) return c.revision === v.revision ? reveal.current?.(c) : undefined;
    if (pdf) return reveal.current?.(c);
    const ed = view.current;
    const r = c.wrote?.[0];
    if (!ed || !r || c.revision !== v.revision) return;
    ed.dispatch({
      selection: {
        anchor: Math.min(r[0], ed.state.doc.length),
        head: Math.min(r[1], ed.state.doc.length),
      },
      scrollIntoView: true,
    });
  };
  // The differences of a proposal close when the host takes it off the list (below), not before:
  // refused, they stay with the reason above them.
  const decide = (proposalId: string, accept: boolean) => {
    dismissRefusal(file);
    sendDoc({ type: "doc.decide", file, clientId: askId(), proposalId, accept });
  };
  // A proposal shown that is not open anymore (decided elsewhere) closes its differences.
  useEffect(() => {
    if (diff?.proposalId && !v.proposals.some((p) => p.proposalId === diff.proposalId))
      setDiff(undefined);
  }, [v.proposals]);
  const canDiff = textEditable(file.path);
  const others =
    Date.now() - v.presenceAt < 60_000 ? v.presence.filter((p) => p.who !== PERSON) : [];
  const people = v.presence.filter((p) => p.who === PERSON).length;
  const save = saveState(v);
  // «As set for the agent» says what that is (p3.5.3): right away, or which agents propose.
  const proposing = (v.agentsPropose ?? []).map(
    (id) => agents.value.find((a) => a.id === id)?.name ?? id,
  );
  const defaultLabel = defaultModeLabel(proposing);
  const modeHint = v.modeOwn ? undefined : defaultLabel;
  // Ctrl+S anywhere in the tab saves now; the text editor sends its last keystrokes first (its
  // own key binding, which marks the event as handled).
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = shell.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSaveKey(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      if (!handled) saveDoc(file);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });
  // The host cannot edit it (too big, not text): the viewer instead, and why.
  if (fallback && v.status === "loading" && v.refusal?.clientId === "open")
    return (
      <div class="doc-fallback">
        <p class="vw-note">{t("docCannotEditShown", { reason: v.refusal.reason })}</p>
        {fallback()}
      </div>
    );
  return (
    <div class={`doc-shell ${panel ? "with-panel" : ""}`} ref={shell}>
      <div class="vw-bar doc-bar">
        <span class="doc-rev" title={t("docRevisionHint")}>
          {t("docRevision", { n: String(v.revision) })}
        </span>
        {save && !sheet && (
          <span class={`doc-save ${save}`} role="status" title={t("docSaveHint")} data-save={save}>
            {save === "saved" && <IconCheck size={13} />}
            {save === "failed" && <IconAlert size={13} />}
            {save === "saved"
              ? t("docSaved")
              : save === "saving"
                ? t("docSaving")
                : save === "unsaved"
                  ? t("docUnsaved")
                  : t("docSaveFailed", { reason: v.saved?.error ?? "" })}
          </span>
        )}
        {people > 1 && (
          <span class="doc-who dim">
            <IconUser size={13} />
            {t("docPages", { n: String(people) })}
          </span>
        )}
        {others.map((p) => (
          <span key={p.who} class="doc-who agent" role="status">
            <span class="doc-dot" aria-hidden="true" />
            {t("docAgentEditing", { name: p.name ?? p.who })}
          </span>
        ))}
        <div class="spacer" />
        <label class="doc-mode">
          <span>{t("docModeLabel")}</span>
          <select
            value={v.modeOwn ? v.mode : "default"}
            title={modeHint}
            onChange={(e) =>
              void attempt(() =>
                setDocMode(
                  file,
                  (e.target as HTMLSelectElement).value as "now" | "propose" | "default",
                ),
              )
            }
          >
            <option value="default">{defaultLabel}</option>
            <option value="now">{t("docModeNow")}</option>
            <option value="propose">{t("docModePropose")}</option>
          </select>
        </label>
        <button
          type="button"
          class={`vw-toggle ${panel ? "on" : ""}`}
          aria-pressed={panel}
          aria-controls="doc-changes"
          onClick={() => setPanel(!panel)}
        >
          <IconList size={14} />
          {t("docChanges")}
          {v.proposals.length > 0 && <span class="doc-badge">{v.proposals.length}</span>}
        </button>
      </div>
      {v.outside && (
        <div class="doc-notice doc-outside" role="alert">
          <IconAlert size={14} />
          <span>{t("docOutside", { name })}</span>
          <button
            type="button"
            class="vw-btn small"
            onClick={() => {
              undo({ revision: v.outside?.revision as number });
              dismissOutside(file);
            }}
          >
            <IconUndo size={13} />
            {t("docOutsideUndo")}
          </button>
          <button type="button" class="vw-btn small" onClick={() => dismissOutside(file)}>
            {t("docOutsideClose")}
          </button>
        </div>
      )}
      {v.held && (
        <div class="doc-notice doc-held" role="status">
          <IconUser size={14} />
          <span>{heldText(v.held, whoText({ author: v.held.who, authorName: v.held.name }))}</span>
          <button
            type="button"
            class="vw-icon doc-held-close"
            title={t("close")}
            aria-label={t("close")}
            onClick={() => dismissHeld(file)}
          >
            <IconX size={13} />
          </button>
        </div>
      )}
      {v.refusal && v.refusal.clientId !== "open" && (
        <div class="doc-notice doc-refused" role="alert">
          <span>{t("docRefused", { reason: v.refusal.reason })}</span>
          {refusal?.revision && !refusal.groupId && v.refusal.code === "conflict" && (
            <button
              type="button"
              class="vw-btn small"
              onClick={() => undo({ revision: refusal.revision as number, toBefore: true })}
            >
              {t("docBackBefore")}
            </button>
          )}
          <button type="button" class="vw-btn small" onClick={() => dismissRefusal(file)}>
            {t("docOutsideClose")}
          </button>
        </div>
      )}
      <div class="doc-main">
        {v.status === "loading" && (
          <div class="vw-empty dim doc-loading">
            {v.refusal?.clientId === "open"
              ? t("docCannotEdit", { reason: v.refusal.reason })
              : t("loading")}
          </div>
        )}
        {isOfficeFile(file.path) ? (
          <OfficeEditor file={file} />
        ) : pictureEditable(file) ? (
          <ImageEditor file={file} />
        ) : pdf ? (
          <PdfEditor file={file} page={page} onReveal={(r) => (reveal.current = r)} />
        ) : (
          <div class="doc-work">
            {sheet ? (
              <SheetEditor file={file} onReveal={(r) => (reveal.current = r)} />
            ) : SVG_EDITABLE.test(file.path) ? (
              <SvgEditor file={file} />
            ) : MODEL_EDITABLE.test(file.path) ? (
              <ModelEditor file={file} />
            ) : (
              <TextEditor file={file} name={name} line={line} onReady={(e) => (view.current = e)} />
            )}
            {diff && Diff && (
              <Diff
                file={file}
                name={name}
                what={diff.what}
                title={diff.title}
                onClose={() => setDiff(undefined)}
              >
                {diff.proposalId && (
                  <>
                    <button
                      type="button"
                      class="vw-btn small primary"
                      onClick={() => decide(diff.proposalId as string, true)}
                    >
                      <IconCheck size={14} />
                      {t("docAccept")}
                    </button>
                    <button
                      type="button"
                      class="vw-btn small"
                      onClick={() => decide(diff.proposalId as string, false)}
                    >
                      <IconX size={14} />
                      {t("docReject")}
                    </button>
                  </>
                )}
              </Diff>
            )}
          </div>
        )}
        {panel && (
          <aside class="doc-panel" id="doc-changes" aria-label={t("docChanges")}>
            {v.proposals.length > 0 && (
              <section class="doc-proposals">
                <h4>{t("docProposals")}</h4>
                {v.proposals.map((p) => (
                  <div key={p.proposalId} class="doc-change proposal">
                    <div class="doc-change-head">
                      <strong>{whoText(p)}</strong>
                      <span class="dim">{ago(p.ts)}</span>
                    </div>
                    <div class="doc-change-what">{changeText(p.summary)}</div>
                    <div class="doc-change-actions">
                      <button
                        type="button"
                        class="vw-btn small primary"
                        onClick={() => decide(p.proposalId, true)}
                      >
                        <IconCheck size={14} />
                        {t("docAccept")}
                      </button>
                      <button
                        type="button"
                        class="vw-btn small"
                        onClick={() => decide(p.proposalId, false)}
                      >
                        <IconX size={14} />
                        {t("docReject")}
                      </button>
                      {canDiff && (
                        <button
                          type="button"
                          class="vw-btn small"
                          aria-pressed={diff?.proposalId === p.proposalId}
                          onClick={() =>
                            setDiff({
                              what: { proposalId: p.proposalId },
                              proposalId: p.proposalId,
                              title: `${whoText(p)}: ${changeText(p.summary)}`,
                            })
                          }
                        >
                          <IconEye size={14} />
                          {t("docShowDiff")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            <h4>{t("docChanges")}</h4>
            {groups.length === 0 && <p class="dim doc-none">{t("docNoChanges")}</p>}
            {groups.map((g) => {
              const first = g.items[0] as DocChange;
              const agentTurn =
                first.author !== PERSON && !first.replaced && g.groupId.startsWith("turn:");
              const open = g.items.filter((c) => !c.undoneBy && !c.undoOf);
              return (
                <div
                  key={`${g.groupId}-${first.revision}`}
                  class={`doc-group ${agentTurn ? "agent" : ""}`}
                >
                  <div class="doc-group-head">
                    <strong>{whoText(first)}</strong>
                    <span class="dim">
                      <IconClock size={12} /> {ago(first.ts)}
                    </span>
                    {canDiff && !(first.replaced && g.items.length === 1 && !first.wrote) && (
                      <button
                        type="button"
                        class="vw-icon doc-diff-open"
                        title={t("docShowDiff")}
                        aria-label={t("docShowDiff")}
                        aria-pressed={diff?.what.groupId === g.groupId}
                        onClick={() =>
                          setDiff({
                            what: { groupId: g.groupId },
                            title: `${whoText(first)}: ${
                              g.items.length === 1
                                ? changeText(first.summary)
                                : t("docDiffGroup", { n: String(g.items.length) })
                            }`,
                          })
                        }
                      >
                        <IconEye size={13} />
                      </button>
                    )}
                    {agentTurn && open.length > 0 && (
                      <button
                        type="button"
                        class="link doc-undo-turn"
                        onClick={() => undo({ groupId: g.groupId })}
                      >
                        {t("docUndoTurn")}
                      </button>
                    )}
                  </div>
                  {g.items.map((c) => (
                    <div key={c.revision} class={`doc-change ${c.undoneBy ? "undone" : ""}`}>
                      <button
                        type="button"
                        class="doc-change-what link"
                        onClick={() => show(c)}
                        title={t("docRevision", { n: String(c.revision) })}
                      >
                        {changeText(c.summary)}
                      </button>
                      {c.undoneBy ? (
                        <span class="dim doc-undone">{t("docUndone")}</span>
                      ) : (
                        !c.undoOf && (
                          <button
                            type="button"
                            class="vw-icon doc-undo"
                            title={t("docUndoThis")}
                            aria-label={t("docUndoThis")}
                            onClick={() => undo({ revision: c.revision })}
                          >
                            <IconUndo size={13} />
                            <span>{t("docUndoThis")}</span>
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </aside>
        )}
      </div>
    </div>
  );
}
