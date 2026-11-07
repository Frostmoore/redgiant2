// How an agent's conversations are summarised (G24.14c): when, and how much stays word for word.
// No JSON: two step sliders with a red dot (2026-11-07) and words a grandmother understands, with
// an example that follows the sliders.
import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi, refresh } from "../state.js";
import { Slider } from "./SettingsKit.js";

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
  // Both are shares of what the model can hold at once: 100 pages make the example easy.
  const pages = (n: number) => t(n === 1 ? "compactOnePage" : "compactPages", { n: String(n) });
  return (
    <div class="compaction-settings wz-look">
      <Slider
        label={t("compactAtTitle")}
        value={at}
        min={50}
        max={95}
        step={5}
        format={(n) => t("compactAtValue", { n: String(n) })}
        help={t("compactAtHint")}
        onChange={(v) => {
          setSaved(false);
          setAt(v);
        }}
      />
      <Slider
        label={t("compactKeepTitle")}
        value={keep}
        min={0}
        max={50}
        step={5}
        format={(n) => (n === 0 ? t("compactKeepNone") : t("compactKeepValue", { n: String(n) }))}
        help={t("compactKeepHint")}
        onChange={(v) => {
          setSaved(false);
          setKeep(v);
        }}
      />
      <p class="compaction-example">
        <b>{t("compactExampleTitle")}</b>{" "}
        {keep === 0
          ? t("compactExampleNone", { at: pages(at) })
          : t("compactExample", { at: pages(at), keep: pages(keep) })}
      </p>
      <div class="row">
        <button type="button" class="wz-btn small primary" onClick={() => void save()}>
          {t("save")}
        </button>
        <button type="button" class="wz-btn small quiet" onClick={() => void save(true)}>
          {t("compactDefaults")}
        </button>
        {saved && <span class="ui-help">{t("asstSavedNewChats")}</span>}
      </div>
    </div>
  );
}
