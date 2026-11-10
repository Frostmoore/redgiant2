// «Models catalog: updated on …» with «Update now» (3.5.4): which catalog of models' names,
// limits and prices is in use (built in, or a newer signed one downloaded), and a look at
// GitHub on request. New models arrive with it, without a new RedGiant.
import type { ModelsCatalogStatus } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { Box, Row } from "./SettingsKit.js";

const day = (d: string) => {
  const at = new Date(`${d}T12:00:00`);
  return Number.isNaN(at.getTime()) ? d : at.toLocaleDateString();
};

export function ModelsCatalogRow() {
  const [s, setS] = useState<ModelsCatalogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getApi()
      .modelsCatalog()
      .then(setS)
      .catch(() => {});
  }, []);
  if (!s?.updatedAt) return null;
  const refresh = async () => {
    setBusy(true);
    try {
      setS(await getApi().refreshModelsCatalog());
    } catch {
      // The row keeps what it showed.
    } finally {
      setBusy(false);
    }
  };
  const help = [
    s.source === "downloaded" ? t("catalogDownloaded") : t("catalogBuiltin"),
    t("catalogVersion", { n: String(s.version) }),
    s.checkedAt && t("catalogChecked", { when: new Date(s.checkedAt).toLocaleString() }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box class="mp-catalog">
      <Row
        title={t("catalogRow", { date: day(s.updatedAt) })}
        help={
          <>
            {help}
            {s.problem && (
              <span class="mp-catalog-problem">
                {" "}
                {t(s.problem === "unsigned" ? "catalogUnsigned" : "catalogUnreachable")}
              </span>
            )}
          </>
        }
      >
        <button type="button" class="wz-btn" disabled={busy} onClick={() => void refresh()}>
          {busy ? t("catalogRefreshing") : t("catalogRefresh")}
        </button>
      </Row>
    </Box>
  );
}
