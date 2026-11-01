import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";

/** Above this, the editor would crawl: the file is offered for download instead. */
const MAX_EDIT_BYTES = 1024 * 1024;

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
  const [state, setState] = useState<
    "loading" | "clean" | "dirty" | "binary" | "large" | "error" | "conflict"
  >("loading");
  const [reload, setReload] = useState(0);
  /** The file's time when it was read: a save that finds another one is a conflict. */
  const seen = useRef<string | null>(null);

  const save = async (force = false) => {
    if (!view.current) return;
    try {
      const r = await getApi().write(
        scope,
        path,
        view.current.state.doc.toString(),
        "utf8",
        force ? {} : { expectedModifiedAt: seen.current },
      );
      seen.current = r.modifiedAt;
      setState("clean");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState("conflict");
      else await attempt(() => Promise.reject(err));
    }
  };
  const download = async () => {
    const blob = await attempt(() => getApi().download(scope, path));
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() ?? "file";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  useEffect(() => {
    let cancelled = false;
    const language = new Compartment();
    void getApi()
      .read(scope, path)
      .catch((err: Error) =>
        err instanceof ApiError && /larger/.test(err.message) ? "large" : null,
      )
      .then(async (file) => {
        if (cancelled || !host.current) return;
        if (file === "large") return setState("large");
        if (!file) return setState("error");
        if (file.encoding === "base64") return setState("binary");
        if (file.size > MAX_EDIT_BYTES) return setState("large");
        seen.current = file.modifiedAt;
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
  }, [scope, path, reload]);

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
      {state === "conflict" && (
        <div class="banner error">
          {t("fileChanged")}
          <button type="button" class="danger" onClick={() => void save(true)}>
            {t("overwrite")}
          </button>
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            {t("reloadFile")}
          </button>
        </div>
      )}
      {state === "binary" || state === "large" ? (
        <div class="empty">
          <p>{t(state === "binary" ? "binaryFile" : "tooLargeToEdit")}</p>
          <button type="button" onClick={() => void download()}>
            {t("download")}
          </button>
        </div>
      ) : (
        <div class="cm-host" ref={host} />
      )}
    </div>
  );
}
