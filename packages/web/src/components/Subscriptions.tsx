import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { ModelsPage } from "./ModelsPage.js";

/**
 * Models and subscriptions (Settings): a gallery of cards with a panel (2026-11-04), the same
 * pieces as the wizard's "How should RedGiant think?".
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
      <ModelsPage s={s} reload={load} />
    </div>
  );
}
