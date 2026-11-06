// Settings > Code, drawn as the wizard (2026-11-06): the advanced wizard's step (GitHub and Gitea
// as two squares, each with its window), then the projects' repositories, made again on request.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { GitSync, GitTiles } from "./GitCode.js";
import { Head, Sub, WzPage } from "./SettingsKit.js";

/** Settings, Code: GitHub and Gitea, as in the advanced wizard (G24.5). */
export function CodeSettings() {
  const [s, setS] = useState<SetupState | null>(null);
  const load = () =>
    void getApi()
      .setup()
      .then(setS, () => {});
  useEffect(load, []);
  if (!s) return null;
  const any = s.config.git?.github || s.config.git?.gitea;
  return (
    <WzPage class="st-code">
      <Head eyebrow={t("stCodeEyebrow")} q={t("wzCodeQ")} lead={t("gitPurpose")} />
      <GitTiles s={s} reload={load} />
      {any && (
        <>
          <Sub title={t("gitProjects")} lead={t("gitProjectsHint")} />
          <GitSync />
        </>
      )}
    </WzPage>
  );
}
