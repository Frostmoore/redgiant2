// The editor in the canvas (G37.1): the shell every family shares (its bar, who is in the file,
// the rule for the agents' edits, the panel «Modifiche» with «Annulla questa modifica» and
// «Annulla tutto il turno», the proposals to accept) around the family's own editor. Plain text is
// the first: CodeMirror, editable, wired to the server's host (viewers/collab.ts). The person's
// Ctrl+Z undoes only their own typing; what an agent wrote is highlighted for a few seconds and
// listed in the panel, where any change can be taken back. Nothing is saved from here: the host
// writes the file.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  type ChangeSet,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { DocChange, DocFile, DocSummary } from "@redgiant/protocol";
import { PERSON } from "@redgiant/protocol";
import { basicSetup } from "codemirror";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconCheck, IconClock, IconList, IconUndo, IconUser, IconX } from "../../icons.js";
import { agents, attempt, docView, openDoc, sendDoc, setDocMode } from "../../state.js";
import { TextCollab } from "../../viewers/collab.js";
import { useReport } from "../../viewers/live.js";
import { isOfficeFile } from "../../viewers/office-bridge.js";
import { OfficeEditor } from "./OfficeEditor.js";

/** The plain text files the page edits (G37.1); code, Markdown and the rest come with G37.2. */
export const EDITABLE = /\.(txt|text|log)$/i;
export const editableInCanvas = (file: { scope: string; path: string }) =>
  file.scope !== "outside" && (EDITABLE.test(file.path) || isOfficeFile(file.path));

/** A pause in typing longer than this starts another gesture (another line of the panel). */
const GESTURE_MS = 2000;
/** How long an agent's text stays highlighted. */
const HIGHLIGHT_MS = 8000;

// ---- the agent's highlight -----------------------------------------------------------------

const addMarks = StateEffect.define<{ ranges: [number, number][]; id: number }>();
const dropMarks = StateEffect.define<number>();
const agentMark = (id: number) =>
  Decoration.mark({ class: "doc-agent-mark", attributes: { "data-mark": String(id) } });

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addMarks)) {
        const b = new RangeSetBuilder<Decoration>();
        const len = tr.state.doc.length;
        for (const [f, to] of [...e.value.ranges].sort((x, y) => x[0] - y[0]))
          if (to > f && to <= len) b.add(f, to, agentMark(e.value.id));
        next = next.update({ add: [...iterDecos(b.finish())] });
      }
      if (e.is(dropMarks)) {
        // -1: every mark (an undo took the marked text back).
        const id = String(e.value);
        next =
          e.value < 0
            ? Decoration.none
            : next.update({ filter: (_f, _t, d) => d.spec.attributes?.["data-mark"] !== id });
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function* iterDecos(set: DecorationSet) {
  const it = set.iter();
  while (it.value) {
    yield it.value.range(it.from, it.to);
    it.next();
  }
}

const classes = HighlightStyle.define([{ tag: [tags.heading], class: "cmv-head" }]);

// ---- words ---------------------------------------------------------------------------------

/** A change in the person's words: «Ada ha inserito 2 righe alla riga 5». */
export function changeText(s: DocSummary): string {
  // Documents and presentations (G37.4) count paragraphs and slides.
  if (s.unit === "paragraph" || s.unit === "slide") {
    const para = s.unit === "paragraph";
    const span = s.lines && s.lines > 1;
    const where =
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
    return where ? `${what} ${where}` : what;
  }
  const where =
    s.line === undefined
      ? ""
      : s.kind === "edit"
        ? t("docFromLine", { n: String(s.line) })
        : s.lines && s.lines > 1
          ? t("docAtLines", { from: String(s.line), to: String(s.line + s.lines - 1) })
          : t("docAtLine", { n: String(s.line) });
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

// ---- the plain text editor -----------------------------------------------------------------

function TextEditor({
  file,
  onReady,
}: {
  file: DocFile;
  onReady: (v: EditorView | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const report = useReport();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let view: EditorView | undefined;
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    let lastKey = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let presenceTimer: ReturnType<typeof setTimeout> | undefined;
    let markId = 0;
    const collab = new TextCollab((o) =>
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: o.ops,
        groupId: group,
      }),
    );
    const remote = Transaction.remote.of(true);
    const noHistory = Transaction.addToHistory.of(false);
    const presence = (editing: boolean) => {
      if (!view) return;
      const sel = view.state.selection.main;
      sendDoc({
        type: "doc.presence",
        file,
        editing,
        from: sel.from,
        to: sel.to,
        revision: collab.revision,
      });
    };
    const setText = (text: string) => {
      if (!view) {
        view = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: text,
            extensions: [
              basicSetup,
              EditorView.lineWrapping,
              syntaxHighlighting(classes),
              marks,
              EditorView.contentAttributes.of({ "aria-label": t("docEditorLabel") }),
              EditorView.updateListener.of((u) => {
                const own = u.transactions.filter(
                  (tr) => tr.docChanged && !tr.annotation(Transaction.remote),
                );
                for (const tr of own) collab.local(tr.changes as ChangeSet);
                if (own.length) {
                  const now = Date.now();
                  if (now - lastKey > GESTURE_MS)
                    group = `g-${Math.random().toString(36).slice(2, 10)}`;
                  lastKey = now;
                  // Keystrokes travel in small batches.
                  if (sendTimer) clearTimeout(sendTimer);
                  sendTimer = setTimeout(() => collab.flush(), 120);
                  if (!presenceTimer)
                    presenceTimer = setTimeout(() => {
                      presenceTimer = undefined;
                      presence(true);
                    }, 250);
                }
                if (u.docChanged || u.viewportChanged) {
                  const v = u.view;
                  report({
                    line: v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from)
                      .number,
                    lines: v.state.doc.lines,
                  });
                }
              }),
              EditorView.domEventHandlers({ blur: () => presence(false) }),
            ],
          }),
        });
        onReady(view);
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [remote, noHistory],
      });
    };
    const highlight = (ranges: [number, number][]) => {
      if (!view || !ranges.length) return;
      const id = ++markId;
      view.dispatch({ effects: addMarks.of({ ranges, id }) });
      setTimeout(() => view?.dispatch({ effects: dropMarks.of(id) }), HIGHLIGHT_MS);
    };
    const resync = () => sendDoc({ type: "doc.open", file });
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family !== "text") return;
        collab.reset(revision);
        setText(snapshot.text);
      },
      replaced(m) {
        if (m.snapshot.family !== "text") return;
        collab.reset(m.revision);
        setText(m.snapshot.text);
      },
      changed(m) {
        const r = collab.remote(m.revision, m.ops, m.change.wrote ?? []);
        if (!r || !view) return resync();
        view.dispatch({
          changes: r.changes,
          annotations: [remote, noHistory],
          ...(m.change.undoOf?.length && { effects: dropMarks.of(-1) }),
        });
        if (m.change.author !== PERSON) highlight(r.wrote);
      },
      ack(m) {
        collab.ack(m.clientId, m.revision);
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) resync();
      },
    });
    return () => {
      if (sendTimer) clearTimeout(sendTimer);
      if (presenceTimer) clearTimeout(presenceTimer);
      collab.flush();
      close();
      onReady(undefined);
      view?.destroy();
    };
  }, [file.scope, file.path]);
  return <div class="vw-code doc-text" ref={host} />;
}

// ---- the shell -----------------------------------------------------------------------------

let asks = 0;
const askId = () => `u${Date.now().toString(36)}${(asks++).toString(36)}`;

export function DocEditor({ file }: { file: DocFile }) {
  const v = docView(file).value;
  const [panel, setPanel] = useState(() =>
    typeof window.matchMedia === "function"
      ? !window.matchMedia("(max-width: 760px)").matches
      : true,
  );
  const view = useRef<EditorView | undefined>(undefined);
  /** What each of the person's requests was about (to offer «Torna a prima» after a refusal). */
  const asked = useRef(new Map<string, { revision?: number; groupId?: string }>());
  const [, tick] = useState(0);
  // «2 minuti fa» stays true.
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const groups = useMemo(() => groupChanges(v.changes), [v.changes]);
  const refusal = v.refusal && asked.current.get(v.refusal.clientId);
  const undo = (what: { revision?: number; toBefore?: boolean; groupId?: string }) => {
    const clientId = askId();
    asked.current.set(clientId, what);
    sendDoc({ type: "doc.undo", file, clientId, ...what });
  };
  const show = (c: DocChange) => {
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
  const others =
    Date.now() - v.presenceAt < 60_000 ? v.presence.filter((p) => p.who !== PERSON) : [];
  const people = v.presence.filter((p) => p.who === PERSON).length;
  return (
    <div class={`doc-shell ${panel ? "with-panel" : ""}`}>
      <div class="vw-bar doc-bar">
        <span class="doc-rev" title={t("docRevisionHint")}>
          {t("docRevision", { n: String(v.revision) })}
        </span>
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
            onChange={(e) =>
              void attempt(() =>
                setDocMode(
                  file,
                  (e.target as HTMLSelectElement).value as "now" | "propose" | "default",
                ),
              )
            }
          >
            <option value="default">{t("docModeDefault")}</option>
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
      {v.refusal && (
        <div class="doc-notice" role="alert">
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
        ) : (
          <TextEditor file={file} onReady={(e) => (view.current = e)} />
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
                        onClick={() =>
                          sendDoc({
                            type: "doc.decide",
                            file,
                            clientId: askId(),
                            proposalId: p.proposalId,
                            accept: true,
                          })
                        }
                      >
                        <IconCheck size={14} />
                        {t("docAccept")}
                      </button>
                      <button
                        type="button"
                        class="vw-btn small"
                        onClick={() =>
                          sendDoc({
                            type: "doc.decide",
                            file,
                            clientId: askId(),
                            proposalId: p.proposalId,
                            accept: false,
                          })
                        }
                      >
                        <IconX size={14} />
                        {t("docReject")}
                      </button>
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
                    {agentTurn && open.length > 1 && (
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
