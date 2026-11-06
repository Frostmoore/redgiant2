// Settings > Access from outside home, drawn as the wizard (2026-11-06): the advanced wizard's
// step (the password, then one of three ways out, in a big box), then Pi-hole, the home's own
// DNS, in a box of its own.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { PiholePanel } from "./Pihole.js";
import { RemoteAccess } from "./RemoteAccess.js";
import { Box, Sub } from "./SettingsKit-cornice.js";
import { Head } from "./SetupKit.js";

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
    <div class="settings-section wz-look st-page st-remote">
      <section class="wz-inner">
        <Head eyebrow={t("wzRemote")} q={t("stRemoteQ")} lead={t("remotePurpose")} />
        <Box>
          <RemoteAccess s={s} onChange={load} />
        </Box>
        <Sub title={t("piholeTitle")} />
        <Box class="st-pihole">
          <PiholePanel s={s} onChange={load} />
        </Box>
      </section>
    </div>
  );
}
