import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { RemoteAccess } from "./RemoteAccess.js";

/** Settings, access from outside home (G24.6): as in the advanced wizard. */
export function RemoteSettings() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  return (
    <div class="settings-section brain-settings">
      <h2>{t("wzRemote")}</h2>
      <p class="ui-purpose">{t("remotePurpose")}</p>
      <RemoteAccess s={s} onChange={load} />
    </div>
  );
}
