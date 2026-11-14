// Settings > Access from outside home, drawn as the wizard (2026-11-06): the advanced wizard's
// step (the password, then one of three ways out, in a big box), the guide for who already has a
// proxy, a VPN or a home DNS (G39.8, folded until opened), then Pi-hole, the home's own DNS, in a box of its own.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { OwnInfra } from "./OwnInfra.js";
import { PiholePanel } from "./Pihole.js";
import { RemoteAccess } from "./RemoteAccess.js";
import { Box, Head, Sub, WzPage } from "./SettingsKit.js";

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
    <WzPage class="st-remote">
      <Head eyebrow={t("wzRemote")} q={t("stRemoteQ")} lead={t("remotePurpose")} />
      <Box>
        <RemoteAccess s={s} onChange={load} />
      </Box>
      {/* «Already have your own infrastructure» (G39.8): under the password, folded (3.7.2). */}
      <Sub title={t("oiTitle")} lead={t("oiLead")} />
      <Box class="st-own-infra">
        <OwnInfra s={s} onChange={load} folded />
      </Box>
      <Sub title={t("piholeTitle")} />
      <Box class="st-pihole">
        <PiholePanel s={s} onChange={load} />
      </Box>
    </WzPage>
  );
}
