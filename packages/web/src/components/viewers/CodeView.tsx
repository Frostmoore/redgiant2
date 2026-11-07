// Text and code (G34.2): CodeMirror, read-only, with the language found from the file's name and
// colours that follow the theme (classes, coloured in styles.css). Markdown is shown rendered
// (renderMarkdown: sanitised), with its source a press away.
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { basicSetup, EditorView } from "codemirror";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { renderMarkdown } from "../../markdown.js";
import { codeLanguageName } from "../../viewers/kind.js";
import { useText, type ViewerProps } from "../../viewers/source.js";

/** Above this the rest is cut: a viewer, not an editor of logs of gigabytes. */
export const MAX_TEXT = 2 * 1024 * 1024;

/** Token classes, coloured by the theme's variables. */
const classes = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier],
    class: "cmv-kw",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: "cmv-str" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "cmv-num" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "cmv-com" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "cmv-fn" },
  { tag: [tags.typeName, tags.className, tags.namespace], class: "cmv-type" },
  { tag: [tags.propertyName, tags.attributeName], class: "cmv-prop" },
  { tag: [tags.heading], class: "cmv-head" },
  { tag: [tags.link, tags.url], class: "cmv-link" },
  { tag: [tags.meta, tags.processingInstruction, tags.tagName], class: "cmv-meta" },
]);

function Code({
  text,
  name,
  wrap,
  line,
}: {
  text: string;
  name: string;
  wrap: boolean;
  /** A citation's line (G36.4): selected and brought to the middle. */
  line?: number | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let view: EditorView | undefined;
    let live = true;
    void (async () => {
      const lang = LanguageDescription.matchFilename(languages, codeLanguageName(name));
      const support = lang ? await lang.load().catch(() => undefined) : undefined;
      if (!live) return;
      view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            syntaxHighlighting(classes),
            ...(wrap ? [EditorView.lineWrapping] : []),
            ...(support ? [support] : []),
          ],
        }),
      });
      if (line && line >= 1) {
        const at = view.state.doc.line(Math.min(line, view.state.doc.lines));
        view.dispatch({
          selection: { anchor: at.from, head: at.to },
          effects: EditorView.scrollIntoView(at.from, { y: "center" }),
        });
      }
    })();
    return () => {
      live = false;
      view?.destroy();
    };
  }, [text, name, wrap, line]);
  return <div class="vw-code" ref={host} />;
}

export function CodeView({ src }: ViewerProps) {
  const { value, error } = useText(src.url);
  const markdown = src.kind === "markdown";
  // A citation's line is in the source: Markdown opens there instead of rendered.
  const [source, setSource] = useState(!markdown || Boolean(src.at?.line));
  const [wrap, setWrap] = useState(src.kind !== "code");
  if (error) return <div class="vw-empty">{error}</div>;
  if (value === undefined) return <div class="vw-empty dim">{t("loading")}</div>;
  const cut = value.length > MAX_TEXT;
  const text = cut ? value.slice(0, MAX_TEXT) : value;
  const lines = text.split("\n").length;
  return (
    <div class="vw-text">
      <div class="vw-bar">
        {markdown && (
          <div class="vw-seg">
            <button
              type="button"
              class={!source ? "on" : ""}
              aria-pressed={!source}
              onClick={() => setSource(false)}
            >
              {t("vwRendered")}
            </button>
            <button
              type="button"
              class={source ? "on" : ""}
              aria-pressed={source}
              onClick={() => setSource(true)}
            >
              {t("vwSource")}
            </button>
          </div>
        )}
        <span class="dim">{t("vwLines", { n: lines.toLocaleString() })}</span>
        <div class="spacer" />
        {source && (
          <button
            type="button"
            class={`vw-toggle ${wrap ? "on" : ""}`}
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            {t("vwWrap")}
          </button>
        )}
      </div>
      {cut && <p class="vw-note">{t("vwCut", { size: "2 MB" })}</p>}
      {markdown && !source ? (
        <div class="md vw-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      ) : (
        <Code text={text} name={src.name} wrap={wrap} line={src.at?.line} />
      )}
    </div>
  );
}
