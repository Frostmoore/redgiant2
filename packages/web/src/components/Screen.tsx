// The personal agents' browser, live (G24.14b): watch what they do; take control to sign in
// (what you type goes to the page only, never to a model or the log), then give it back.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { agents, browserScreen, getLive } from "../state.js";
import { askText } from "./dialogs.js";

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
  const personal = agents.value.filter((a) => a.kind === "assistant" && a.status === "active");
  const [pupil, setPupil] = useState(personal[0]?.id ?? "");
  const teaching = agents.value.find((a) => a.id === s.teaching);
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
        {/* While a task is being taught, "Done" gives the browser back. */}
        {!teaching && (
          <button
            type="button"
            class={mine ? "" : "primary"}
            onClick={() => getLive().send({ type: "browser.control", take: !mine })}
          >
            {mine ? t("screenGiveBack") : t("screenTake")}
          </button>
        )}
      </div>
      <p class={`ui-help screen-note${mine ? " mine" : ""}`}>
        {teaching
          ? t("teachRecording", { name: teaching.name })
          : mine
            ? t("screenYours")
            : t("screenShared")}
      </p>
      {/* "Teach a task" (G24.14b): do it once, the agent writes it as a skill you approve. */}
      {teaching ? (
        <div class="row screen-teach">
          <button
            type="button"
            class="primary"
            onClick={async () => {
              const title = (await askText(t("teachTitle"))) ?? "";
              getLive().send({
                type: "browser.teach",
                agentId: teaching.id,
                start: false,
                ...(title.trim() && { title: title.trim() }),
              });
            }}
          >
            {t("teachDone")}
          </button>
        </div>
      ) : (
        personal.length > 0 && (
          <div class="row screen-teach">
            <select
              aria-label={t("teachWho")}
              value={pupil}
              onChange={(e) => setPupil((e.target as HTMLSelectElement).value)}
            >
              {personal.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              title={t("teachHint")}
              onClick={() =>
                pupil && getLive().send({ type: "browser.teach", agentId: pupil, start: true })
              }
            >
              {t("teachStart")}
            </button>
          </div>
        )
      )}
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
