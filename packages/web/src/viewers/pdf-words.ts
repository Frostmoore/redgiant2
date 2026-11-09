// A PDF's change in the person's words (G37.8): «Evidenziato a pagina 2», «Compilato il campo
// «nome»», «Tolta la pagina 3». The server's summary carries the parts (DocSummary.pdf); the
// words are the page's, in Italian or English.
import type { DocSummary } from "@redgiant/protocol";
import { type Key, t } from "../i18n.js";

const KIND: Record<string, Key> = {
  highlight: "pdfDidHighlight",
  underline: "pdfDidUnderline",
  strikeout: "pdfDidStrike",
  freetext: "pdfDidText",
  ink: "pdfDidInk",
  note: "pdfDidNote",
  square: "pdfDidBox",
  stamp: "pdfDidStamp",
  signature: "pdfDidSign",
};

export function pdfChangeText(s: DocSummary): string {
  const p = s.pdf;
  if (!p) return s.text;
  const page = String(p.page ?? 1);
  const n = String(p.n ?? 1);
  switch (p.action) {
    case "annotate":
      if (p.n && p.n > 1) return t("pdfDidAnnots", { n, page });
      return t(KIND[p.kind ?? ""] ?? "pdfDidAnnot", { page });
    case "remove_annotation":
      return p.n && p.n > 1
        ? t("pdfDidRemoveAnnots", { n, page })
        : t("pdfDidRemoveAnnot", { page });
    case "fill_field":
      return p.n && p.n > 1
        ? t("pdfDidFields", { n })
        : t("pdfDidField", { name: (p.field ?? "").slice(0, 60) });
    case "rotate_page":
      return p.n && p.n > 1
        ? t("pdfDidRotates", { n })
        : t("pdfDidRotate", { page, to: String(p.to ?? 0) });
    case "delete_page":
      return p.n && p.n > 1 ? t("pdfDidDeletes", { n }) : t("pdfDidDelete", { page });
    case "restore_page":
      return t("pdfDidRestore", { page });
    case "move_page":
      return t("pdfDidMove", { page, to: String(p.to ?? 1) });
    case "redact":
      return p.n === 1 ? t("pdfDidRedact1", { page }) : t("pdfDidRedact", { n, page });
    case "unredact":
      return t("pdfDidUnredact", { page });
    default:
      return p.n && p.n > 1 ? t("docEdits", { n }) : s.text;
  }
}
