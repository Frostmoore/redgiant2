import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { Brain, DefaultModel } from "./Brain.js";

/**
 * Models and subscriptions (Settings): the same cards as the wizard's "How should RedGiant
 * think?", so everything is changed where it was chosen.
 */
export function Subscriptions() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section brain-settings">
      <h2>{t("subscriptions")}</h2>
      <p class="ui-purpose">{t("brainPurpose")}</p>
      <Brain s={s} reload={load} />
      <DefaultModel s={s} onSaved={load} />
    </div>
  );
}
