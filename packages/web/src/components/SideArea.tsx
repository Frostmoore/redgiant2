import { h, type JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconClose, IconFile, IconTerminal } from "../icons.js";
import { activeSide, closeSide, sideViews } from "../state.js";

/**
 * Loads a heavy view (CodeMirror, xterm.js) the first time it is shown, not with the page:
 * most sessions never open an editor or a terminal.
 */
function lazy<P extends object>(load: () => Promise<(props: P) => JSX.Element | null>) {
  let loaded: ((props: P) => JSX.Element | null) | undefined;
  return function Lazy(props: P) {
    const [view, setView] = useState(() => loaded);
    useEffect(() => {
      if (!view)
        void load().then((v) => {
          loaded = v;
          setView(() => v);
        });
    }, [view]);
    return view ? h(view, props) : <div class="empty">…</div>;
  };
}
const Editor = lazy<{ scope: string; path: string }>(() =>
  import("./Editor.js").then((m) => m.Editor),
);
const TerminalView = lazy<{ scope: string }>(() =>
  import("./TerminalView.js").then((m) => m.TerminalView),
);

/**
 * Half of the width next to the chat (as in Officina): open files and terminals in tabs. They
 * stay mounted when not shown, so an edit or a shell is never lost.
 */
export function SideArea() {
  const views = sideViews.value;
  if (views.length === 0) return null;
  return (
    <section class="side-area">
      <div class="side-tabs" role="tablist">
        {views.map((v) => (
          <div key={v.id} class={`side-tab ${activeSide.value === v.id ? "active" : ""}`}>
            <button
              role="tab"
              aria-selected={activeSide.value === v.id}
              type="button"
              class="label"
              onClick={() => (activeSide.value = v.id)}
              title={v.title}
            >
              {v.type === "terminal" ? <IconTerminal size={13} /> : <IconFile size={13} />}
              <span>{v.title}</span>
            </button>
            <button
              type="button"
              class="icon-button"
              title={t("close")}
              onClick={() => closeSide(v.id)}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
      {views.map((v) => (
        <div key={v.id} class="side-content" hidden={activeSide.value !== v.id}>
          {v.type === "editor" ? (
            <Editor scope={v.scope} path={v.path} />
          ) : (
            <TerminalView scope={v.scope} />
          )}
        </div>
      ))}
    </section>
  );
}
