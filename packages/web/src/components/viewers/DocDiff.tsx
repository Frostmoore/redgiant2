// The differences of a change, an agent's turn or a proposal (G37.2), with @codemirror/merge (MIT):
// the file before and after, asked to the host (`/api/editor/diff`), side by side or in one text
// (the phone's choice), unchanged stretches folded. Read-only: a proposal is accepted or rejected
// whole, from the buttons of its head.
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { DocFile } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconClose } from "../../icons.js";
import { getApi } from "../../state.js";
import { codeClasses, languageFor } from "./code-style.js";

export type DiffWhat = { revision?: number; groupId?: string; proposalId?: string };
type Layout = "side" | "inline";

const FOLD = { margin: 3, minSize: 4 };

const startLayout = (): Layout =>
  typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches
    ? "inline"
    : "side";

export function DocDiff({
  file,
  name,
  what,
  title,
  onClose,
  children,
}: {
  file: DocFile;
  name: string;
  what: DiffWhat;
  /** Who and what, as the panel says it. */
  title: string;
  onClose: () => void;
  /** The proposal's buttons. */
  children?: ComponentChildren;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(startLayout);
  const [texts, setTexts] = useState<{ before: string; after: string }>();
  const [error, setError] = useState<string>();
  const key = JSON.stringify(what);
  useEffect(() => {
    let live = true;
    setTexts(undefined);
    setError(undefined);
    void getApi()
      .editorDiff(file, what)
      .then(
        (r) => {
          if (!live) return;
          if (r.before.family !== "text" || r.after.family !== "text")
            return setError(t("docDiffNotText"));
          setTexts({ before: r.before.text, after: r.after.text });
        },
        (e: unknown) => live && setError((e as Error).message),
      );
    return () => {
      live = false;
    };
  }, [file.scope, file.path, key]);
  useEffect(() => {
    const el = host.current;
    if (!el || !texts) return;
    let live = true;
    let destroy: (() => void) | undefined;
    void languageFor(name).then((support) => {
      if (!live) return;
      const common: Extension[] = [
        lineNumbers(),
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        syntaxHighlighting(codeClasses),
        EditorState.phrases.of({ "$ unchanged lines": t("docDiffUnchanged") }),
        ...(support ? [support] : []),
      ];
      if (layout === "side") {
        const m = new MergeView({
          a: {
            doc: texts.before,
            extensions: [
              ...common,
              EditorView.contentAttributes.of({ "aria-label": t("docDiffBefore") }),
            ],
          },
          b: {
            doc: texts.after,
            extensions: [
              ...common,
              EditorView.contentAttributes.of({ "aria-label": t("docDiffAfter") }),
            ],
          },
          parent: el,
          collapseUnchanged: FOLD,
          gutter: true,
        });
        destroy = () => m.destroy();
      } else {
        const v = new EditorView({
          parent: el,
          state: EditorState.create({
            doc: texts.after,
            extensions: [
              ...common,
              unifiedMergeView({
                original: texts.before,
                mergeControls: false,
                gutter: true,
                allowInlineDiffs: true,
                collapseUnchanged: FOLD,
              }),
            ],
          }),
        });
        destroy = () => v.destroy();
      }
    });
    return () => {
      live = false;
      destroy?.();
    };
  }, [texts, layout, name]);
  const same = texts && texts.before === texts.after;
  return (
    <section class="doc-diff" aria-label={t("docDiffTitle")}>
      <div class="vw-bar doc-diff-bar">
        <strong class="doc-diff-title" title={title}>
          {title}
        </strong>
        <div class="vw-seg">
          {(["side", "inline"] as const).map((l) => (
            <button
              key={l}
              type="button"
              class={layout === l ? "on" : ""}
              aria-pressed={layout === l}
              onClick={() => setLayout(l)}
            >
              {l === "side" ? t("docDiffSide") : t("docDiffInline")}
            </button>
          ))}
        </div>
        <div class="spacer" />
        {children}
        <button
          type="button"
          class="vw-icon doc-diff-close"
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <IconClose size={15} />
        </button>
      </div>
      {layout === "side" && texts && !same && (
        <div class="doc-diff-heads" aria-hidden="true">
          <span>{t("docDiffBefore")}</span>
          <span>{t("docDiffAfter")}</span>
        </div>
      )}
      {error && <p class="vw-note">{t("docDiffError", { reason: error })}</p>}
      {!texts && !error && <div class="vw-empty dim">{t("loading")}</div>}
      {same && <p class="vw-note">{t("docDiffSame")}</p>}
      <div class={`doc-diff-body ${same ? "hidden" : ""}`} ref={host} />
    </section>
  );
}
