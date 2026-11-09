// The page's side of documents and presentations (G37.4), pure: what the canvas checks before
// loading LibreOffice in the browser, the plain actions of a revision for the frame, the pictures
// they need, the undo entry an agent's revision becomes in Writer, the open copy's original.
import type { DocOp, OfficeAction, OfficePlainAction } from "@redgiant/protocol";

/** Why the full editor cannot run here (the fallback says it in the person's words). */
export type OfficeFallback = "insecure" | "browser" | "webgl" | "memory" | "failed";

/** What the frame found, checked in this order (the first that fails is the reason). */
export function fallbackOf(c: {
  secure: boolean;
  isolated?: boolean | undefined;
  webgl?: boolean | undefined;
  memory?: number | null | undefined;
}): OfficeFallback | undefined {
  if (!c.secure) return "insecure";
  // Chromium says how much memory the device has (GB, rounded): LibreOffice wants 1-2 GB.
  if (typeof c.memory === "number" && c.memory > 0 && c.memory < 4) return "memory";
  if (c.isolated === false) return "browser";
  if (c.webgl === false) return "webgl";
  return undefined;
}

/** The actions of a revision the frame applies (a page's saved file: undefined, reload instead). */
export function plainActions(ops: readonly DocOp[]): OfficePlainAction[] | undefined {
  const out: OfficePlainAction[] = [];
  for (const o of ops) {
    if (o.family !== "document") return undefined;
    const a: OfficeAction = o.op;
    if (a.t === "file" || a.t === "restore") return undefined;
    if (a.t === "batch") out.push(...a.ops);
    else out.push(a);
  }
  return out;
}

/** The pictures (blob hashes) the actions put in the document. */
export function picturesOf(actions: readonly OfficePlainAction[]): string[] {
  const out = new Set<string>();
  for (const a of actions) {
    if ((a.t === "insert_item" || a.t === "delete_item") && a.picture) out.add(a.picture.blob);
    if (a.t === "add_shape") out.add(a.picture.blob);
    if (a.t === "delete_shape" && a.picture) out.add(a.picture.blob);
    if (a.t === "add_slide")
      for (const s of a.snap?.shapes ?? []) if (s.picture) out.add(s.picture.blob);
  }
  return [...out];
}

/** The closed original of an open copy (`x.docx.open/x.odt` → `x.docx`). */
export function originalOf(path: string): string | undefined {
  const m = path.match(
    /^(.*\.(docx|docm|dotx|doc|rtf|pptx|pptm|ppsx|ppt))\.open\/[^/]+\.(odt|odp)$/i,
  );
  return m?.[1];
}

/** Whether the editor's document family takes this file (the canvas opens it editable). */
export const isOfficeFile = (path: string) => /\.(odt|odp)$/i.test(path);

/** A closed document the canvas offers to edit on its open copy. */
export const hasOfficeCopy = (path: string) =>
  /\.(docx|docm|dotx|doc|rtf|pptx|pptm|ppsx|ppt)$/i.test(path) && !/\.open\//.test(path);

/** What «Esporta come…» offers for a document. */
export const exportsOf = (path: string): string[] =>
  /\.odp$/i.test(path) ? ["pptx", "ppt", "pdf", "odp"] : ["docx", "doc", "rtf", "pdf", "odt"];
