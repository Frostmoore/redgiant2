import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";

const dark = EditorView.theme(
  {
    "&": { backgroundColor: "#120f10", color: "#e8dfdc", height: "100%" },
    ".cm-content": {
      caretColor: "#ef4b3a",
      fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
    },
    ".cm-gutters": { backgroundColor: "#171314", color: "#6f6260", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#1f1a1b" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "#5a2320 !important",
    },
    ".cm-cursor": { borderLeftColor: "#ef4b3a" },
  },
  { dark: true },
);

/** Syntax colours readable on the dark background, in the RedGiant palette. */
const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier],
    color: "#ff7b6b",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#e6c07b" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#ffa96b" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "#7d6f6c",
    fontStyle: "italic",
  },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#7cc6ff" },
  {
    tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)],
    color: "#e8dfdc",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#c9a2ff" },
  { tag: [tags.propertyName, tags.attributeName], color: "#9fd3c7" },
  { tag: [tags.heading], color: "#ff8a5c", fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "#7cc6ff", textDecoration: "underline" },
  { tag: [tags.meta, tags.processingInstruction], color: "#9a8b87" },
  { tag: tags.invalid, color: "#ff5d5d" },
]);

/** Opens a workspace file in CodeMirror; Ctrl/Cmd+S saves. */
export function Editor({ scope, path }: { scope: string; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [state, setState] = useState<"loading" | "clean" | "dirty" | "binary" | "error">("loading");

  const save = async () => {
    if (!view.current) return;
    const ok = await attempt(() =>
      getApi().write(scope, path, view.current?.state.doc.toString() ?? ""),
    );
    if (ok) setState("clean");
  };

  useEffect(() => {
    let cancelled = false;
    const language = new Compartment();
    void attempt(() => getApi().read(scope, path)).then(async (file) => {
      if (cancelled || !host.current) return;
      if (!file) return setState("error");
      if (file.encoding === "base64") return setState("binary");
      view.current = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: file.content,
          extensions: [
            basicSetup,
            dark,
            syntaxHighlighting(highlight),
            language.of([]),
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  void save();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((u) => u.docChanged && setState("dirty")),
          ],
        }),
      });
      setState("clean");
      const desc = LanguageDescription.matchFilename(languages, path);
      if (desc) {
        const support = await desc.load();
        if (!cancelled) view.current.dispatch({ effects: language.reconfigure(support) });
      }
    });
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [scope, path]);

  return (
    <div class="editor">
      <div class="toolbar">
        <span class="path">{path}</span>
        {state === "dirty" && <span class="badge">{t("unsaved")}</span>}
        <button
          type="button"
          class="primary"
          disabled={state !== "dirty"}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </div>
      {state === "binary" ? (
        <div class="empty">{t("binaryFile")}</div>
      ) : (
        <div class="cm-host" ref={host} />
      )}
    </div>
  );
}
