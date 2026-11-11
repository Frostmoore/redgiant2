// Text and code in the editor (G37.1, G37.2): CodeMirror, editable, wired to the server's host
// (viewers/collab.ts). Coloured by language (the file's name); Markdown stays text with its
// preview beside it or instead of it (renderMarkdown: sanitised, decision of 2026-11-08: no
// WYSIWYG); JSON, YAML and XML checked as the person types (viewers/syntax.ts: marked, never
// blocking) and shown as a tree on request. The person's Ctrl+Z undoes only their own typing; what
// an agent wrote stays highlighted while it edits and until the person could see it a while
// (viewers/agent-marks.ts), with «Annulla questa modifica» under the pointer (p3.5.6).
// Nothing is saved from here: the host writes; Ctrl+S (Cmd+S) sends the last keystrokes and asks
// it to write now (p3.5.1).
import { syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import {
  type ChangeSet,
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, hoverTooltip, keymap } from "@codemirror/view";
import type { DocFile } from "@redgiant/protocol";
import { PERSON, textDigest } from "@redgiant/protocol";
import { basicSetup } from "codemirror";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconAlert, IconCheck, IconUndo } from "../../icons.js";
import { renderMarkdown } from "../../markdown.js";
import { docResynced, docView, keepMarks, openDoc, saveDoc, sendDoc, status } from "../../state.js";
import { holdMark } from "../../viewers/agent-marks.js";
import { freshAgentWrites, TextCollab } from "../../viewers/collab.js";
import { viewerFor } from "../../viewers/kind.js";
import { useOrders, useReport } from "../../viewers/live.js";
import { type Problem, SYNTAX_NAMES, syntaxOf, syntaxProblems } from "../../viewers/syntax.js";
import { jsonPathAt, linesAround, parseTree, type TreeNode } from "../../viewers/tree.js";
import { codeClasses, languageFor, languageOf } from "./code-style.js";
import { Branch } from "./TreeBranch.js";

/** A pause in typing longer than this starts another gesture (another line of the panel). */
const GESTURE_MS = 2000;
/** The place the person typed in stays held this long after they leave the text (p3.5.3). */
const HOLD_AFTER_BLUR_MS = 3000;
/** The preview, the tree and the syntax check follow the text after this pause. */
const DERIVE_MS = 250;

/** How the text is shown: the text alone, with its preview beside it, the preview alone, a tree. */
export type TextMode = "source" | "split" | "preview" | "tree";

const MD_MODE_KEY = "rg.doc.markdown";
const narrow = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;

/** Markdown opens as the person left it; the first time beside its preview (text alone on a phone). */
function startMode(markdown: boolean): TextMode {
  if (!markdown) return "source";
  const kept = (() => {
    try {
      return localStorage.getItem(MD_MODE_KEY);
    } catch {
      return null;
    }
  })();
  if (kept === "source" || kept === "split" || kept === "preview") return kept;
  return narrow() ? "source" : "split";
}

// ---- the agent's highlight -----------------------------------------------------------------

/** The agent's writes of one revision (`id`: the revision). */
const addMarks = StateEffect.define<{ ranges: [number, number][]; id: number }>();
/** The marks of one revision taken off (-1: every mark). */
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

/** The revision marked at a place of the text, if any (the latest when they overlap). */
export function markedAt(set: DecorationSet, pos: number): number | undefined {
  let found: number | undefined;
  set.between(pos, pos, (from, to, d) => {
    if (pos < from || pos > to) return;
    const id = Number(d.spec.attributes?.["data-mark"]);
    if (Number.isFinite(id) && (found === undefined || id > found)) found = id;
  });
  return found;
}

/**
 * The smallest change from one text to the other (the same start and end kept): a text read
 * again (a resynchronisation) keeps the highlights and the cursor where nothing changed.
 */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end))
    end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

function* iterDecos(set: DecorationSet) {
  const it = set.iter();
  while (it.value) {
    yield it.value.range(it.from, it.to);
    it.next();
  }
}

/** The syntax problems as CodeMirror's diagnostics (the gutter and the underline). */
const diagnostics = (list: readonly Problem[], len: number): Diagnostic[] =>
  list.map((p) => ({
    from: Math.min(p.from, len),
    to: Math.min(Math.max(p.to, p.from), len),
    severity: "error",
    message: p.message,
  }));

/** Selects lines A..B and brings them to the middle. */
function selectLines(view: EditorView, a: number, b = a) {
  const doc = view.state.doc;
  const from = doc.line(Math.max(1, Math.min(a, doc.lines)));
  const to = doc.line(Math.max(from.number, Math.min(b, doc.lines)));
  view.dispatch({
    selection: { anchor: from.from, head: to.to },
    effects: EditorView.scrollIntoView(from.from, { y: "center" }),
  });
  return { from, to };
}

export function TextEditor({
  file,
  name,
  line,
  onReady,
}: {
  file: DocFile;
  /** The file's name: its language, Markdown, a tree. */
  name: string;
  /** A citation's line (G36.4): selected and brought to the middle once the text is there. */
  line?: number | undefined;
  onReady: (v: EditorView | undefined) => void;
}) {
  const choice = viewerFor(name);
  const markdown = choice.kind === "markdown";
  const treeable = choice.kind === "tree";
  const syntax = syntaxOf(choice.format);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | undefined>(undefined);
  const wrapping = useRef(new Compartment());
  const report = useReport();
  const [ready, setReady] = useState(false);
  const [mode, setModeNow] = useState<TextMode>(() => startMode(markdown));
  const [wrap, setWrap] = useState(choice.kind !== "code" && !treeable);
  const [text, setText] = useState<string>();
  const [problems, setProblems] = useState<Problem[]>();
  const [tree, setTree] = useState<{ node?: TreeNode; error?: string }>();
  const langName = languageOf(name)?.name;
  const setMode = (m: TextMode) => {
    setModeNow(m);
    if (markdown && m !== "tree")
      try {
        localStorage.setItem(MD_MODE_KEY, m);
      } catch {
        // Private windows: the choice lasts for this tab.
      }
  };
  // An agent's move (G36.12): a line brought to the middle, or lines selected; the preview alone
  // turns to the text beside it.
  useOrders((d) => {
    const view = editor.current;
    if (!view || !d.line) return false;
    if (mode === "preview") setModeNow("split");
    if (mode === "tree") setModeNow("source");
    const { from, to } = selectLines(view, d.line, d.toLine ?? d.line);
    report({
      line: from.number,
      selection: d.toLine ? view.state.doc.sliceString(from.from, to.to).slice(0, 2000) : undefined,
    });
    return true;
  }, ready);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let view: EditorView | undefined;
    let live = true;
    let group = `g-${Math.random().toString(36).slice(2, 10)}`;
    let lastKey = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let presenceTimer: ReturnType<typeof setTimeout> | undefined;
    let deriveTimer: ReturnType<typeof setTimeout> | undefined;
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    let checks = 0;
    /** The highlights waiting to be seen (p3.5.4), by revision: dropped when the editor closes. */
    const fading = new Map<number, () => void>();
    /** «Annulla questa modifica» under the pointer, on the agent's highlight (p3.5.6). */
    const undoTip = hoverTooltip(
      (v, pos) => {
        const rev = markedAt(v.state.field(marks), pos);
        if (rev === undefined) return null;
        const c = docView(file).value.changes.find((x) => x.revision === rev);
        if (!c || c.undoneBy) return null;
        return {
          pos,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "doc-mark-tip";
            render(
              <>
                <span class="dim">{t("docMarkBy", { who: c.authorName ?? c.author })}</span>
                <button
                  type="button"
                  class="vw-btn small"
                  onClick={() => {
                    keepMarks(file);
                    sendDoc({
                      type: "doc.undo",
                      file,
                      clientId: `m${Date.now().toString(36)}${rev}`,
                      revision: rev,
                    });
                  }}
                >
                  <IconUndo size={13} />
                  {t("docUndoThis")}
                </button>
              </>,
              dom,
            );
            return { dom, destroy: () => render(null, dom) };
          },
        };
      },
      { hoverTime: 250 },
    );
    let citation = line;
    /** Ctrl+S waits for the keystrokes in flight: the save is asked once the host has them. */
    let saveAfter = false;
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
    const saveNow = () => {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = undefined;
      collab.flush();
      if (collab.pending) {
        saveAfter = true;
        saveDoc(file, false);
      } else saveDoc(file);
      return true;
    };
    const savePending = () => {
      if (!saveAfter || collab.pending) return;
      saveAfter = false;
      sendDoc({ type: "doc.save", file });
    };
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
    // The preview, the tree and the check follow the text, a moment after it changes.
    const derive = () => {
      if (deriveTimer) clearTimeout(deriveTimer);
      deriveTimer = setTimeout(() => {
        deriveTimer = undefined;
        const v = view;
        if (!v || !live) return;
        const now = v.state.doc.toString();
        if (markdown || treeable) setText(now);
        if (!syntax) return;
        const n = ++checks;
        void syntaxProblems(now, choice.format, file.path).then((list) => {
          if (!live || n !== checks || !view) return;
          setProblems(list);
          view.dispatch(setDiagnostics(view.state, diagnostics(list, view.state.doc.length)));
        });
      }, DERIVE_MS);
    };
    const tellPlace = () => {
      const v = view;
      if (!v) return;
      report({
        line: v.state.doc.lineAt(v.lineBlockAtHeight(v.scrollDOM.scrollTop).from).number,
        lines: v.state.doc.lines,
      });
    };
    const languages = new Compartment();
    const setTextNow = (doc: string) => {
      if (!view) {
        view = new EditorView({
          parent: el,
          state: EditorState.create({
            doc,
            extensions: [
              keymap.of([{ key: "Mod-s", preventDefault: true, run: saveNow }]),
              basicSetup,
              wrapping.current.of(wrap ? EditorView.lineWrapping : []),
              languages.of([]),
              syntaxHighlighting(codeClasses),
              ...(syntax ? [lintGutter()] : []),
              marks,
              undoTip,
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
                if (u.docChanged) derive();
                if (u.docChanged || u.viewportChanged) tellPlace();
              }),
              // Leaving the text (to ask an agent in the chat, p3.5.3) sends what was typed at
              // once and keeps the place held a moment more: the agent asked right away does
              // not write over the line the person was just typing.
              EditorView.domEventHandlers({
                blur: () => {
                  if (sendTimer) clearTimeout(sendTimer);
                  sendTimer = undefined;
                  collab.flush();
                  if (Date.now() - lastKey < GESTURE_MS) presence(true);
                  if (blurTimer) clearTimeout(blurTimer);
                  blurTimer = setTimeout(() => {
                    blurTimer = undefined;
                    if (!view?.hasFocus) presence(false);
                  }, HOLD_AFTER_BLUR_MS);
                },
              }),
            ],
          }),
        });
        view.scrollDOM.addEventListener("scroll", tellPlace, { passive: true });
        editor.current = view;
        onReady(view);
        setReady(true);
        const shown = view;
        void languageFor(name).then((support) => {
          if (live && support) shown.dispatch({ effects: languages.reconfigure(support) });
        });
      }
      // Only what differs (p3.5.6): the whole text replaced took every highlight with it.
      else
        view.dispatch({
          changes: minimalChange(view.state.doc.toString(), doc),
          annotations: [remote, noHistory],
        });
      derive();
      if (citation && citation >= 1) {
        selectLines(view, citation);
        citation = undefined;
      }
    };
    const highlight = (ranges: [number, number][], revision: number) => {
      if (!view || !ranges.length || fading.has(revision)) return;
      view.dispatch({ effects: addMarks.of({ ranges, id: revision }) });
      // It fades after the person could see it a while (p3.5.4), not after a fixed time, and
      // not while an agent still edits the file (p3.5.6).
      fading.set(
        revision,
        holdMark(
          file,
          revision,
          () => view?.dom,
          () => {
            fading.delete(revision);
            view?.dispatch({ effects: dropMarks.of(revision) });
          },
        ),
      );
    };
    /** The highlights of undone revisions go (only theirs: p3.5.6, every one went). */
    const unmark = (revisions: readonly number[]) => {
      const effects = revisions
        .filter((r) => fading.has(r))
        .map((r) => {
          fading.get(r)?.();
          fading.delete(r);
          return dropMarks.of(r);
        });
      return effects;
    };
    /**
     * The file read again from the host. `drift`: the page found it no longer matched (p3.5.7, the
     * person's test of 3.5.6: one Ctrl+Z never reached the host, the page never knew): the
     * person is told, and whether unconfirmed typing went with it.
     */
    let resyncing = false;
    const resync = (drift = false) => {
      if (drift) docResynced(file, collab.pending);
      if (resyncing) return;
      resyncing = true;
      sendDoc({ type: "doc.open", file });
    };
    /** The host's text after a revision against the page's, when nothing of the person waits. */
    const check = (digest: string | undefined) => {
      if (!digest || !view || collab.pending || resyncing) return;
      if (textDigest(view.state.doc.toString()) !== digest) resync(true);
    };
    // A batch the host never answered (an answer lost on the way): read again, not waited for ever.
    const watchdog = setInterval(() => {
      if (status.value === "online" && collab.stuck() && !resyncing) resync(true);
    }, 2000);
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family !== "text") return;
        resyncing = false;
        const first = !view;
        const before = collab.revision;
        collab.reset(revision);
        setTextNow(snapshot.text);
        savePending();
        // Opened after an agent edited it, or opened again with an agent's revision this page
        // had not seen (p3.5.4: a change that came by a resynchronisation, not live): what it
        // just wrote, highlighted as if seen live.
        if (first || revision > before)
          highlight(freshAgentWrites(docView(file).value.changes, revision, { max: 1 }), revision);
      },
      replaced(m) {
        if (m.snapshot.family !== "text") return;
        collab.reset(m.revision);
        setTextNow(m.snapshot.text);
        savePending();
      },
      changed(m) {
        const r = collab.remote(m.revision, m.ops, m.change.wrote ?? []);
        if (!r || !view) return resync();
        const effects = unmark(m.change.undoOf ?? []);
        view.dispatch({
          changes: r.changes,
          annotations: [remote, noHistory],
          ...(effects.length && { effects }),
        });
        if (m.change.author !== PERSON) highlight(r.wrote, m.revision);
        check(m.digest);
      },
      ack(m) {
        if (collab.ack(m.clientId, m.revision)) check(m.digest);
        // A batch let go by a reset that the host applied after all: the page lacks it.
        else if (collab.orphan(m.clientId)) resync(true);
        savePending();
      },
      rejected(m) {
        collab.orphan(m.clientId);
        // Refused for a reason other than the text (the file not open here, an error): said too.
        if (collab.rejected(m.clientId)) resync(m.code === "closed" || m.code === "failed");
      },
    });
    return () => {
      live = false;
      clearInterval(watchdog);
      if (sendTimer) clearTimeout(sendTimer);
      if (presenceTimer) clearTimeout(presenceTimer);
      if (deriveTimer) clearTimeout(deriveTimer);
      if (blurTimer) clearTimeout(blurTimer);
      for (const cancel of fading.values()) cancel();
      collab.flush();
      close();
      editor.current = undefined;
      setReady(false);
      onReady(undefined);
      view?.destroy();
    };
  }, [file.scope, file.path]);
  // Wrapping long lines, switched without rebuilding the editor.
  useEffect(() => {
    editor.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);
  // The tree, only while it is shown.
  useEffect(() => {
    if (mode !== "tree" || text === undefined) return;
    let live = true;
    void parseTree(text, choice.format).then(
      (node) => live && setTree({ node }),
      (e: unknown) => live && setTree({ error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [mode, text]);
  const preview = useMemo(
    () => (markdown && mode !== "source" && text !== undefined ? renderMarkdown(text) : ""),
    [markdown, mode, text],
  );
  const first = problems?.[0];
  // Where the text stops being valid, in the tree too (p3.5.4): the node there marked, or, when
  // no tree can be built, the lines around the error.
  const treeMark = useMemo(
    () =>
      mode === "tree" && first && syntax === "json" && text !== undefined
        ? jsonPathAt(text, first.from)
        : undefined,
    [mode, first?.from, syntax, text],
  );
  const seg = (list: [TextMode, string][]) => (
    <div class="vw-seg">
      {list.map(([m, label]) => (
        <button
          key={m}
          type="button"
          class={mode === m ? "on" : ""}
          aria-pressed={mode === m}
          onClick={() => setMode(m)}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div class="doc-text-wrap">
      <div class="vw-bar doc-sub">
        {markdown &&
          seg([
            ["source", t("vwSource")],
            ["split", t("docMdSplit")],
            ["preview", t("vwRendered")],
          ])}
        {treeable &&
          seg([
            ["source", t("vwSource")],
            ["tree", t("vwTree")],
          ])}
        {langName && !markdown && !syntax && <span class="dim doc-lang">{langName}</span>}
        {syntax && problems && (
          <span
            class={`doc-syntax ${first ? "bad" : "ok"}`}
            title={t("docSyntaxHint")}
            role={first ? "status" : undefined}
          >
            {first ? (
              <button
                type="button"
                class="link"
                onClick={() => {
                  const v = editor.current;
                  if (!v) return;
                  if (mode === "tree") setModeNow("source");
                  selectLines(v, first.line);
                  v.focus();
                }}
              >
                <IconAlert size={13} />
                {problems.length === 1
                  ? t("docSyntaxBad1", { lang: SYNTAX_NAMES[syntax], line: String(first.line) })
                  : t("docSyntaxBad", {
                      lang: SYNTAX_NAMES[syntax],
                      n: String(problems.length),
                      line: String(first.line),
                    })}
                <span class="doc-syntax-msg">{first.message}</span>
              </button>
            ) : (
              <>
                <IconCheck size={13} />
                {t("docSyntaxOk", { lang: SYNTAX_NAMES[syntax] })}
              </>
            )}
          </span>
        )}
        <div class="spacer" />
        {(mode === "source" || mode === "split") && (
          <button
            type="button"
            class={`vw-toggle ${wrap ? "on" : ""}`}
            aria-pressed={wrap}
            title={t("vwWrap")}
            onClick={() => setWrap(!wrap)}
          >
            {t("docWrap")}
          </button>
        )}
      </div>
      <div class={`doc-text-body mode-${mode}`}>
        <div class="vw-code doc-text" ref={host} />
        {markdown && mode !== "source" && (
          // Sanitised by renderMarkdown (DOMPurify), like every Markdown shown.
          <div class="md vw-md doc-preview" dangerouslySetInnerHTML={{ __html: preview }} />
        )}
        {treeable && mode === "tree" && (
          <div class="vw-tree doc-tree">
            {first && (
              <p class="vw-note doc-tree-bad" role="status">
                <IconAlert size={13} />
                {t(tree?.error ? "docTreeBadNoTree" : "docTreeBad", {
                  line: String(first.line),
                  why: first.message,
                })}
              </p>
            )}
            {tree?.error && !first && <p class="vw-note">{t("vwTreeNo", { why: tree.error })}</p>}
            {tree?.error && first && text !== undefined && (
              <pre class="doc-tree-lines" title={t("docTreeLines")}>
                {linesAround(text, first.line).map((l) => (
                  <div key={l.n} class={l.bad ? "bad" : ""}>
                    <span class="n">{l.n}</span>
                    {l.text}
                  </div>
                ))}
              </pre>
            )}
            {tree?.node && (
              <div class="vw-tree-body">
                <Branch node={tree.node} depth={0} open={2} mark={treeMark} why={first?.message} />
              </div>
            )}
            {!tree && <div class="vw-empty dim">{t("loading")}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
