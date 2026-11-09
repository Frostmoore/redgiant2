// A drawing's change in the person's words (G37.6), for the panel «Modifiche»: «Aggiunto:
// rettangolo «promo»», «Cambiato lo stile di 3 elementi».
import type { DocSummary, SvgChange } from "@redgiant/protocol";
import { type Key, t, tOptional } from "../i18n.js";

/** «rettangolo «promo»», «testo» (the element's kind, and its id when it has one of its own). */
export function svgWhat(c: Pick<SvgChange, "tag" | "id">): string {
  const kind = tOptional(`svgTag_${c.tag ?? "other"}`) ?? t("svgTag_other");
  return c.id && !c.id.startsWith("rgv-") ? `${kind} «${c.id}»` : kind;
}

export function svgChangeText(s: DocSummary): string {
  const c = s.svg;
  if (!c) return s.text;
  const one = c.n <= 1;
  const what = svgWhat(c);
  const pick = (a: Key, many: Key) => (one ? t(a, { what }) : t(many, { n: String(c.n) }));
  switch (c.action) {
    case "add":
      return pick("svgChAdd", "svgChAddN");
    case "delete":
      return pick("svgChDelete", "svgChDeleteN");
    case "style":
      return pick("svgChStyle", "svgChStyleN");
    case "shape":
      return pick("svgChShape", "svgChShapeN");
    case "transform":
      return pick("svgChTransform", "svgChTransformN");
    case "text":
      return pick("svgChText", "svgChTextN");
    case "order":
      return pick("svgChOrder", "svgChOrderN");
    case "group":
      return t("svgChGroup", { n: String(c.n) });
    case "ungroup":
      return t("svgChUngroup", {
        what: c.id && !c.id.startsWith("rgv-") ? `«${c.id}»` : "",
      }).replace(/\s+$/, "");
    case "replace":
      return t("docReplaced");
    default:
      return pick("svgChChange", "svgChEditN");
  }
}
