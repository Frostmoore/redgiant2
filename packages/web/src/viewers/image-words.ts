// A layered picture's change in the person's words (G37.5), for the panel «Modifiche»:
// «Dipinto su «Sfondo»», «Filtro Sfocatura su «Cielo»», «Aggiunto il livello «Testo»».
import type { DocSummary } from "@redgiant/protocol";
import { t, tOptional } from "../i18n.js";

export function imageChangeText(s: DocSummary): string {
  const c = s.image;
  if (!c) return s.text;
  const what =
    c.layer !== undefined && c.n <= 1 ? `«${c.layer}»` : t("imgLayersN", { n: String(c.n) });
  const filter = c.filter ? (tOptional(`imgFilter_${c.filter}`) ?? c.filter) : "";
  const n = String(c.n);
  // Several layers added or taken away at once have words of their own.
  if (c.n > 1 && (c.action === "add_layer" || c.action === "remove_layer" || c.action === "edit"))
    return t(`imgChN_${c.action}`, { n });
  return (
    tOptional(`imgCh_${c.action}`, { what, filter }) ?? t("imgCh_edit", { what, filter })
  ).trim();
}
