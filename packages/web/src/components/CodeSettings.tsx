import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { GitCode } from "./GitCode.js";

/** Settings, Code: GitHub and Gitea, as in the advanced wizard (G24.5). */
export function CodeSettings() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section brain-settings">
      <h2>{t("wzCode")}</h2>
      <p class="ui-purpose">{t("gitPurpose")}</p>
      <GitCode s={s} onChange={load} />
    </div>
  );
}
