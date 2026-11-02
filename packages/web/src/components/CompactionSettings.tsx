// How an agent's conversations are summarised (G24.14c): when, and how much stays word for word.
// No JSON: two sliders with what they mean.
import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi, refresh } from "../state.js";
import { Field } from "./ui.js";

export function CompactionSettings({ agent }: { agent: Agent }) {
  const [at, setAt] = useState(Math.round((agent.compaction?.at ?? 0.8) * 100));
  const [keep, setKeep] = useState(Math.round((agent.compaction?.keep ?? 0.25) * 100));
  const [saved, setSaved] = useState(false);
  const save = async (reset = false) => {
    const ok = await attempt(() =>
      getApi().configureAgent(agent.id, {
        compaction: reset ? {} : { at: at / 100, keep: keep / 100 },
      }),
    );
    if (ok) {
      if (reset) {
        setAt(80);
        setKeep(25);
      }
      setSaved(true);
      await refresh();
    }
  };
  return (
    <div class="compaction-settings">
      <Field label={t("compactAtLabel", { n: String(at) })} help={t("compactAtHelp")}>
        <input
          type="range"
          min={50}
          max={95}
          step={5}
          value={at}
          onInput={(e) => {
            setSaved(false);
            setAt(Number((e.target as HTMLInputElement).value));
          }}
        />
      </Field>
      <Field label={t("compactKeepLabel", { n: String(keep) })} help={t("compactKeepHelp")}>
        <input
          type="range"
          min={0}
          max={50}
          step={5}
          value={keep}
          onInput={(e) => {
            setSaved(false);
            setKeep(Number((e.target as HTMLInputElement).value));
          }}
        />
      </Field>
      <div class="row">
        <button type="button" class="tiny primary" onClick={() => void save()}>
          {t("save")}
        </button>
        <button type="button" class="tiny" onClick={() => void save(true)}>
          {t("compactDefaults")}
        </button>
        {saved && <span class="ui-help">{t("asstSavedNewChats")}</span>}
      </div>
    </div>
  );
}
