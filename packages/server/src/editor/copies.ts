// The closed original of an open copy that lives in its original's canvas tab (p3.5.4, the
// page's `copyOriginal` in packages/web/src/viewers/office-bridge.ts: keep the two together): a
// document's ODT/ODP, a sheet's ODS, a drawing's SVG, a 3D file's GLB.
import { originalOfModelCopy } from "./model-family.js";
import { originalOfCopy } from "./office-family.js";
import { sheetCopyOfOriginal } from "./sheet-family.js";
import { originalOfSvgCopy } from "./svg-family.js";

/** A sheet's ODS copy's original (`x.xlsx.open/x.ods` → `x.xlsx`), if the path is one. */
export function originalOfSheetCopy(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  const m = p.match(/^(.*)\.open\/[^/]+$/);
  return m?.[1] && sheetCopyOfOriginal(m[1]) === p ? m[1] : undefined;
}

/** The original of any open copy shown in its original's tab; undefined for any other path. */
export function originalOfAnyCopy(path: string): string | undefined {
  return (
    originalOfCopy(path) ??
    originalOfSheetCopy(path) ??
    originalOfSvgCopy(path) ??
    originalOfModelCopy(path)
  );
}
