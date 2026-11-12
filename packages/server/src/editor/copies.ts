// The closed original of an open copy that lives in its original's canvas tab (p3.5.4, the
// page's `copyOriginal` in packages/web/src/viewers/office-bridge.ts: keep the two together): a
// document's ODT/ODP, a sheet's ODS, a drawing's SVG, a 3D file's GLB, a Photoshop file's
// OpenRaster (p3.5.12).
import { IMAGE_COPIES, oraCopyOfOriginal } from "./image-family.js";
import { modelCopyOfOriginal, originalOfModelCopy } from "./model-family.js";
import { copyOfOriginal, originalOfCopy } from "./office-family.js";
import { sheetCopyOfOriginal } from "./sheet-family.js";
import { originalOfSvgCopy, svgCopyOfOriginal } from "./svg-family.js";

/** A sheet's ODS copy's original (`x.xlsx.open/x.ods` → `x.xlsx`), if the path is one. */
export function originalOfSheetCopy(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  const m = p.match(/^(.*)\.open\/[^/]+$/);
  return m?.[1] && sheetCopyOfOriginal(m[1]) === p ? m[1] : undefined;
}

/**
 * A Photoshop file's OpenRaster copy's original (`x.psd.open/x.ora` → `x.psd`); never a PNG's
 * own layers (`x.png.open/x.ora`), which stay beside the picture the person edits.
 */
export function originalOfPsdCopy(path: string): string | undefined {
  const p = path.replace(/\\/g, "/");
  const m = p.match(/^(.*)\.open\/[^/]+$/);
  return m?.[1] && IMAGE_COPIES.test(m[1]) && oraCopyOfOriginal(m[1]) === p ? m[1] : undefined;
}

/** The original of any open copy shown in its original's tab; undefined for any other path. */
export function originalOfAnyCopy(path: string): string | undefined {
  return (
    originalOfCopy(path) ??
    originalOfSheetCopy(path) ??
    originalOfSvgCopy(path) ??
    originalOfModelCopy(path) ??
    originalOfPsdCopy(path)
  );
}

/**
 * The open copy an original's tab shows when it exists (p3.5.12, the person's test of 3.5.11: a
 * slide added to `x.pptx.open/x.odp`, then show_file on `x.pptx` showed the PPTX without it and
 * no bar said why): `x.pptx` → `x.pptx.open/x.odp`; undefined for a file with no such copy.
 */
export function copyOfAnyOriginal(path: string): string | undefined {
  if (/\.open[\\/]/.test(path)) return undefined;
  return (
    copyOfOriginal(path) ??
    sheetCopyOfOriginal(path) ??
    svgCopyOfOriginal(path) ??
    modelCopyOfOriginal(path) ??
    oraCopyOfOriginal(path)
  );
}
