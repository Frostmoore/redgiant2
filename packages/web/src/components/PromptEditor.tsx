// An agent's instructions, always readable (2026-11-06, the person: «i system prompt degli agenti,
// anche quelli predefiniti, si dovrebbero vedere ... e modificare un po'»): the field holds the text
// in use, built-in or one's own, with the agents' names as they are now. Saving keeps the names as
// placeholders on the server, so renaming an agent later keeps the text right. A conversation keeps
// the instructions it started with (the cache): new ones apply to new conversations.
import { useEffect, useState } from "preact/hooks";
import type { PromptView } from "../api.js";
import { t } from "../i18n.js";
import { IconRetry } from "../icons.js";
import { attempt } from "../state.js";

export function PromptEditor({
  load,
  save,
  label,
  help,
  rows = 12,
}: {
  load: () => Promise<PromptView>;
  /** null: the built-in instructions again. */
  save: (text: string | null) => Promise<PromptView>;
  label?: string;
  help?: string;
  rows?: number;
}) {
  const [view, setView] = useState<PromptView | null>(null);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const show = (v: PromptView | undefined) => {
    if (!v) return;
    setView(v);
    setText(v.text);
  };
  // Read once: the caller gives each agent its own editor (`key`).
  useEffect(() => {
    void attempt(load).then(show);
  }, []);
  if (!view) return <p class="dim">{t("loading")}</p>;
  const changed = text.trim() !== view.text.trim();
  const store = async (next: string | null) => {
    const v = await attempt(() => save(next));
    if (!v) return;
    show(v);
    setSaved(true);
  };
  return (
    <div class="st-field pe wz-look">
      <div class="pe-head">
        <span class="wz-lb">{label ?? t("agentInstructions")}</span>
        <span class={`pe-tag${view.isDefault ? "" : " own"}`}>
          {view.isDefault ? t("promptDefault") : t("promptOwn")}
        </span>
      </div>
      {help && <span class="ui-help">{help}</span>}
      <textarea
        class="wz-field pe-text"
        rows={rows}
        aria-label={label ?? t("agentInstructions")}
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setSaved(false);
        }}
      />
      <span class="ui-help">{t("promptNewChats")}</span>
      <div class="st-save pe-acts">
        {saved && !changed && <span class="st-on">{t("agentSaved")}</span>}
        {!view.isDefault && (
          <button
            type="button"
            class="wz-btn small quiet"
            onClick={() => {
              if (confirm(t("promptResetConfirm"))) void store(null);
            }}
          >
            <IconRetry size={15} /> {t("promptReset")}
          </button>
        )}
        {changed && (
          <button type="button" class="wz-btn small quiet" onClick={() => setText(view.text)}>
            {t("cancel")}
          </button>
        )}
        <button
          type="button"
          class="wz-btn small primary"
          disabled={!changed}
          onClick={() => void store(text)}
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
}
