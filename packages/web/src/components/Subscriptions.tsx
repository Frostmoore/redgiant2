import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { getApi } from "../state.js";
import { ModelsPage } from "./ModelsPage.js";

/**
 * Models and subscriptions (Settings), drawn as the wizard (2026-11-06): the wizard's squares
 * and windows inside the page (`wz-look`), with everything the page could already do.
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
    <div class="settings-section brain-settings wz-look">
      <ModelsPage s={s} reload={load} />
    </div>
  );
}
