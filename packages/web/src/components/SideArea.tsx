import { h, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { installKeyboard, rovingKey, syncRoving, typingIn } from "../a11y.js";
import { t } from "../i18n.js";
import {
  IconCanvas,
  IconChat,
  IconClose,
  IconMaximize,
  IconMonitor,
  IconTerminal,
} from "../icons.js";
import {
  activeSide,
  CHAT_MIN,
  clampSideWidth,
  closeSide,
  resetSideWidth,
  SIDE_MIN,
  setSideWidth,
  sideAside,
  sideMax,
  sideViews,
  sideWidth,
  sideWidthByKey,
} from "../state.js";

/**
 * Loads a heavy view (xterm.js) the first time it is shown, not with the page: most sessions
 * never open a terminal.
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

import { Canvas } from "./Canvas.js";
import { Screen } from "./Screen.js";
import { Shortcuts, shortcutsOpen } from "./Shortcuts.js";
import { FileIcon } from "./viewers/FileIcon.js";

const TerminalView = lazy<{ scope: string }>(() =>
  import("./TerminalView.js").then((m) => m.TerminalView),
);

/** The chat's own room (the conversation) next to the area: it and the area share it. */
function roomOf(area: HTMLElement): number {
  const main = area.parentElement?.querySelector<HTMLElement>(":scope > .main");
  return area.offsetWidth + (main?.offsetWidth ?? 0);
}

const phone = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;

/** Esc that belongs to what has the focus (an editor, a terminal, a field, a window) stays there. */
function escTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || document.fullscreenElement) return true;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest("input, textarea, select, [contenteditable], .cm-editor, .xterm")) return true;
  return !!document.querySelector(".ui-modal-back");
}

/**
 * The divider between the chat and the area (p3.3.2): dragged with the mouse or a finger, moved
 * with the arrows when it has the focus, a double click (or Enter) back to the normal width. The
 * width is kept on this device (`sideWidth`).
 */
function Divider({ area }: { area: () => HTMLElement | null }) {
  const [now, setNow] = useState({ width: 0, room: 0 });
  const measure = () => {
    const el = area();
    const m = el ? { width: el.offsetWidth, room: roomOf(el) } : { width: 0, room: 0 };
    setNow(m);
    return m;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    const { width, room } = measure();
    const x0 = e.clientX;
    let last = width;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    document.body.classList.add("side-resizing");
    const move = (m: PointerEvent) => {
      last = clampSideWidth(width + (x0 - m.clientX), room);
      sideWidth.value = last;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("side-resizing");
      if (last !== width) setSideWidth(last, room);
      measure();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      resetSideWidth();
      return;
    }
    const { width, room } = measure();
    const next = sideWidthByKey(e.key, e.shiftKey, sideWidth.value ?? width, room);
    if (next === null) return;
    e.preventDefault();
    setSideWidth(next, room);
    setNow({ width: next, room });
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable divider is a separator with a value (WAI-ARIA window splitter), an <hr> cannot be dragged.
    <div
      class="side-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sideResize")}
      title={t("sideResize")}
      tabIndex={0}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={Math.max(SIDE_MIN, now.room - CHAT_MIN)}
      aria-valuenow={sideWidth.value ?? now.width}
      onPointerDown={down}
      onKeyDown={key}
      onFocus={measure}
      onDblClick={() => resetSideWidth()}
    />
  );
}

/**
 * Half of the width next to the chat (as in Officina): open files and terminals in tabs. They
 * stay mounted when not shown, so an edit or a shell is never lost. Its width follows the divider;
 * «Maximize» puts it over the whole window (Esc or «Back to chat» bring the chat back).
 */
export function SideArea() {
  const views = sideViews.value;
  const area = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const max = sideMax.value;
  useEffect(() => {
    if (!max) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escTaken(e)) return;
      e.preventDefault();
      sideMax.value = false;
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [max]);
  // The editors' toolbars, tab lists and menus answer the arrows (p3.5.11).
  useEffect(() => {
    const el = area.current;
    if (el && views.length > 0) return installKeyboard(el);
  }, [views.length > 0]);
  // One tab stop in the strip (p3.5.11): the arrows move between the tabs.
  useEffect(() => syncRoving(strip.current, "[role=tab]"));
  // «?» (outside a field or an editor) opens the keyboard map.
  useEffect(() => {
    if (views.length === 0) return;
    const help = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
      if (document.querySelector(".ui-modal-back")) return;
      e.preventDefault();
      shortcutsOpen.value = true;
    };
    window.addEventListener("keydown", help);
    return () => window.removeEventListener("keydown", help);
  }, [views.length > 0]);
  // The tab just opened or chosen is always in sight, however many there are.
  useEffect(() => {
    strip.current
      ?.querySelector(".side-tab.active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeSide.value, views.length]);
  if (views.length === 0) return shortcutsOpen.value ? <Shortcuts /> : null;
  // The arrows choose a tab (the tab follows the focus), Delete closes the one with the focus.
  const tabKey = (e: KeyboardEvent) => {
    const el = strip.current;
    if (!el) return;
    const reached = rovingKey(e, el, "[role=tab]", "horizontal");
    if (reached?.dataset.view) {
      activeSide.value = reached.dataset.view;
      return;
    }
    const id = (e.target as HTMLElement).closest<HTMLElement>("[role=tab]")?.dataset.view;
    if (id && e.key === "Delete") {
      e.preventDefault();
      const at = views.findIndex((v) => v.id === id);
      closeSide(id);
      // The focus stays in the strip, on the tab that took its place.
      requestAnimationFrame(() =>
        strip.current
          ?.querySelectorAll<HTMLElement>("[role=tab]")
          [Math.max(0, Math.min(at, views.length - 2))]?.focus(),
      );
    }
  };
  const width = sideWidth.value;
  const toChat = () => {
    sideMax.value = false;
    if (phone()) sideAside.value = true;
  };
  // A mouse wheel scrolls the tabs sideways when they do not fit.
  const wheel = (e: WheelEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  };
  return (
    <section
      ref={area}
      class={`side-area ${sideAside.value ? "aside" : ""} ${max ? "max" : ""}`}
      style={width && !max ? { flexBasis: `${width}px`, maxWidth: "none" } : undefined}
    >
      {/* On a phone the area covers the chat: this brings it back (G34.2). */}
      <button type="button" class="side-pill" onClick={() => (sideAside.value = false)}>
        <IconCanvas size={16} />
        {t("vwCanvasBack", { n: String(views.length) })}
      </button>
      {!max && <Divider area={() => area.current} />}
      <div class="side-bar">
        <button
          type="button"
          class="side-to-chat"
          title={max ? t("sideBackToChat") : t("vwToChat")}
          onClick={toChat}
        >
          <IconChat size={15} />
          <span>{max ? t("sideBackToChat") : t("vwToChat")}</span>
        </button>
        <div
          class="side-tabs"
          role="tablist"
          aria-label={t("sideTabsLabel")}
          ref={strip}
          onWheel={wheel}
          onKeyDown={tabKey}
        >
          {views.map((v) => (
            <div
              key={v.id}
              class={`side-tab ${activeSide.value === v.id ? "active" : ""}`}
              role="presentation"
            >
              <button
                role="tab"
                id={`side-tab-${v.id}`}
                aria-selected={activeSide.value === v.id}
                aria-controls={`side-panel-${v.id}`}
                aria-keyshortcuts="Delete"
                data-view={v.id}
                type="button"
                class="label"
                onClick={() => (activeSide.value = v.id)}
                title={v.title}
              >
                {v.type === "terminal" ? (
                  <IconTerminal size={13} />
                ) : v.type === "screen" ? (
                  <IconMonitor size={13} />
                ) : v.target.kind === "file" ? (
                  <FileIcon name={v.target.path} />
                ) : (
                  <IconCanvas size={13} />
                )}
                <span>{v.title}</span>
              </button>
              {/* Out of the tab order and of the tab list (a tab list holds tabs only): from the
                  keyboard, Delete on the tab closes it (p3.5.11). */}
              <button
                type="button"
                class="icon-button"
                title={`${t("close")} (${t("kDelete")})`}
                aria-hidden="true"
                tabIndex={-1}
                onClick={() => closeSide(v.id)}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
        </div>
        {!max && (
          <button
            type="button"
            class="icon-button side-max"
            title={t("sideMaximize")}
            aria-label={t("sideMaximize")}
            onClick={() => (sideMax.value = true)}
          >
            <IconMaximize />
          </button>
        )}
      </div>
      {views.map((v) => (
        <div
          key={v.id}
          class="side-content"
          hidden={activeSide.value !== v.id}
          role="tabpanel"
          id={`side-panel-${v.id}`}
          aria-labelledby={`side-tab-${v.id}`}
        >
          {v.type === "screen" ? (
            <Screen />
          ) : v.type === "canvas" ? (
            <Canvas title={v.title} target={v.target} />
          ) : (
            <TerminalView scope={v.scope} />
          )}
        </div>
      ))}
      {shortcutsOpen.value && <Shortcuts />}
    </section>
  );
}
