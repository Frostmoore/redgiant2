// A sheet's change in the person's words (G37.3), from the parts the host sends with its summary:
// «Cambiate 3 celle in B2:B4», «Inserite 2 righe alla riga 5», «Aggiunto il foglio «Note»».
import type { DocSummary } from "@redgiant/protocol";
import { t } from "../i18n.js";
import { columnLetters } from "./sheet-collab.js";

export function sheetChangeText(s: DocSummary): string {
  const p = s.sheet;
  if (!p) return s.text;
  const n = p.n ?? 0;
  const range = p.range ?? "";
  const at = String(p.at ?? 1);
  const col = columnLetters(p.at ?? 1);
  let what: string;
  switch (p.action) {
    case "cells":
      what = n === 1 ? t("docSheetCell", { range }) : t("docSheetCells", { n: String(n), range });
      break;
    case "clear":
      what = t("docSheetClear", { n: String(n), range });
      break;
    case "format":
      what = t("docSheetFormat", { n: String(n), range });
      break;
    case "insert_rows":
      what =
        n === 1 ? t("docSheetInsertRow", { at }) : t("docSheetInsertRows", { n: String(n), at });
      break;
    case "delete_rows":
      what =
        n === 1 ? t("docSheetDeleteRow", { at }) : t("docSheetDeleteRows", { n: String(n), at });
      break;
    case "insert_cols":
      what =
        n === 1
          ? t("docSheetInsertCol", { at: col })
          : t("docSheetInsertCols", { n: String(n), at: col });
      break;
    case "delete_cols":
      what =
        n === 1
          ? t("docSheetDeleteCol", { at: col })
          : t("docSheetDeleteCols", { n: String(n), at: col });
      break;
    case "move":
      what = t("docSheetMove");
      break;
    case "merge":
      what = t("docSheetMerge", { range });
      break;
    case "unmerge":
      what = t("docSheetUnmerge", { range });
      break;
    case "add_sheet":
      return t("docSheetAdd", { name: p.name ?? "" });
    case "delete_sheet":
      return t("docSheetDelete", { name: p.name ?? "" });
    case "rename_sheet":
      return t("docSheetRename", { name: p.name ?? "" });
    case "order_sheet":
      return t("docSheetOrder");
    case "sort":
      what = t("docSheetSort", { range });
      break;
    case "filter":
      what = t("docSheetFilter");
      break;
    case "size":
      what = t("docSheetSize");
      break;
    default:
      what = t("docSheetOther");
  }
  const text = p.name ? t("docSheetOn", { what, name: p.name }) : what;
  return s.count && s.count > 1 ? `${text} (${t("docEdits", { n: String(s.count) })})` : text;
}
