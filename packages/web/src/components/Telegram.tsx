import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { TelegramLink } from "./TelegramLink.js";

/** Settings, Telegram: the same steps as the wizard, and the linked accounts. */
export function Telegram() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section brain-settings">
      <h2>{t("telegram")}</h2>
      <p class="ui-purpose">{t("tgPurpose")}</p>
      <TelegramLink s={s} onChange={load} />
    </div>
  );
}
