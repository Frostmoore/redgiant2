// The personal agents' browser, live (G24.14b): watch what they do; take control to sign in
// (what you type goes to the page only, never to a model or the log), then give it back.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { browserScreen, getLive } from "../state.js";

/** Keys sent as such; everything else printable is typed as text. */
const KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function Screen() {
  const s = browserScreen.value;
  const area = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState("");
  useEffect(() => {
    const live = getLive();
    live.send({ type: "browser.watch" });
    return () => live.send({ type: "browser.unwatch" });
  }, []);
  useEffect(() => {
    if (s.control === "person") area.current?.focus();
  }, [s.control]);
  const mine = s.control === "person";
  const input = (
    event:
      | { kind: "click"; x: number; y: number }
      | { kind: "scroll"; x: number; y: number; dy: number }
      | { kind: "text"; text: string }
      | { kind: "key"; key: string },
  ) => mine && getLive().send({ type: "browser.input", event });
  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  if (s.unavailable) return <p class="notice warn screen-note">{t("screenUnavailable")}</p>;
  return (
    <div class="screen">
      <div class="screen-bar">
        {mine ? (
          <form
            class="screen-address"
            onSubmit={(e) => {
              e.preventDefault();
              if (address.trim()) getLive().send({ type: "browser.goto", url: address.trim() });
            }}
          >
            <input
              aria-label={t("screenAddress")}
              placeholder={s.url || t("screenAddress")}
              value={address}
              onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
            />
          </form>
        ) : (
          <span class="screen-url dim" title={s.url}>
            {s.url || "about:blank"}
          </span>
        )}
        <button
          type="button"
          class={mine ? "" : "primary"}
          onClick={() => getLive().send({ type: "browser.control", take: !mine })}
        >
          {mine ? t("screenGiveBack") : t("screenTake")}
        </button>
      </div>
      <p class={`ui-help screen-note${mine ? " mine" : ""}`}>
        {mine ? t("screenYours") : t("screenShared")}
      </p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: while it is the person's, the screen takes their keyboard. */}
      <div
        ref={area}
        class={`screen-view${mine ? " mine" : ""}`}
        tabIndex={mine ? 0 : -1}
        role="img"
        aria-label={t("screenTitle")}
        onClick={(e) => input({ kind: "click", ...at(e as unknown as MouseEvent) })}
        onWheel={(e) => {
          if (!mine) return;
          e.preventDefault();
          input({ kind: "scroll", ...at(e as unknown as MouseEvent), dy: e.deltaY });
        }}
        onKeyDown={(e) => {
          if (!mine || e.isComposing) return;
          if (KEYS.has(e.key)) {
            e.preventDefault();
            input({ kind: "key", key: e.key });
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            input({ kind: "text", text: e.key });
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData?.getData("text") ?? "";
          if (mine && text) {
            e.preventDefault();
            input({ kind: "text", text });
          }
        }}
      >
        {s.frame ? (
          <img src={`data:image/jpeg;base64,${s.frame.data}`} alt="" draggable={false} />
        ) : (
          <div class="empty">{t("screenStarting")}</div>
        )}
      </div>
    </div>
  );
}
