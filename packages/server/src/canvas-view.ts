// What the person sees when an agent opens a file in the canvas (p3.3.1, the agent who tried
// 3.3.0: «non so nemmeno se il file .avi è stato convertito da solo quando l'ho aperto: il tool
// non lo dice»). show_file's answer says which viewer shows the file, whether a conversion is
// needed and whether it happened or is only offered, and whether a paged preview is ready or
// being prepared. The rules mirror the page's (web: OpenCopy.tsx, CanvasFile).

import { posix } from "node:path";
import type { FileConverter, FileReport } from "./convert.js";

const KIND_WORD: Record<string, string> = {
  video: "video player",
  audio: "audio player",
  image: "picture viewer",
  vector: "picture viewer",
  pdf: "PDF viewer",
  document: "document viewer",
  sheet: "table viewer",
  slides: "slides viewer",
  drawing: "drawing viewer",
  "3d": "3D viewer",
  layers: "layers viewer",
};

/** The output the canvas shows first, as the page picks it (OpenCopy.tsx, bestOutput). */
const ORDER = [
  "ora",
  "webm",
  "opus",
  "flac",
  "png",
  "jpg",
  "svg",
  "pdf",
  "odt",
  "odg",
  "odp",
  "ods",
];
export function shownCopy(outputs: { path: string; ext: string }[]) {
  const rank = (ext: string) => {
    const i = ORDER.indexOf(ext);
    return i < 0 ? ORDER.length : i;
  };
  return [...outputs].filter((o) => o.ext !== "json").sort((a, b) => rank(a.ext) - rank(b.ext))[0];
}

/** The same choice as the page's MaybeConverted: whether the canvas offers a conversion. */
export function canvasWantsConversion(r: FileReport): boolean {
  const kind = r.format?.kind;
  const media = kind === "video" || kind === "audio";
  return (
    r.targets.length > 0 && (r.needsConversion || (r.suggested && (media || kind === "image")))
  );
}

/** The lines show_file adds about a file inside a workspace. */
export async function canvasView(
  converter: FileConverter,
  root: string,
  path: string,
  libreOffice: { here: boolean; canDownload: boolean },
): Promise<string> {
  // Office files: laid out as on paper, LibreOffice's PDF made as soon as the canvas opens.
  const paged = await converter.previewState(root, path).catch(() => undefined);
  if (paged) {
    if (paged.ready)
      return "The canvas shows it laid out as pages (LibreOffice's PDF, already prepared); nothing is converted beside the file.";
    if (!libreOffice.here && !libreOffice.canDownload)
      return "LibreOffice cannot run on this computer, so the canvas shows a simple reading of it (not laid out as on paper) and says so.";
    return `The canvas is preparing its paged preview now (LibreOffice prints it to PDF${libreOffice.here ? "" : "; LibreOffice is downloaded first, once, with a bar"}): the person sees a progress bar, then the pages. Nothing is converted beside the file.`;
  }
  const r = await converter.inspect(root, path).catch(() => undefined);
  const name = posix.basename(path);
  if (!r?.format) return "The canvas shows it as it is, in the viewer its contents call for.";
  const viewer = KIND_WORD[r.format.kind] ?? "viewer for its kind";
  if (!canvasWantsConversion(r))
    return `The canvas shows it as it is, in its ${viewer}: no conversion is needed.`;
  const done = r.converted;
  const copy = done ? shownCopy(done.outputs) : undefined;
  const media = r.format.kind === "video" || r.format.kind === "audio";
  if (copy && done) {
    const what = done.previewOnly
      ? `only the preview picture stored inside it (${copy.path}): no free program reads ${r.format.name}`
      : `its open copy ${copy.path}, made earlier (${done.outputs.map((o) => o.path).join(", ")})`;
    return [
      `The canvas shows ${what}, with a box saying it is a copy${done.losses.length ? " and what the conversion lost" : ""}. Nothing was converted now.`,
      ...(done.stale
        ? [
            `The original changed after that conversion: the person sees a notice; convert_file on ${path} makes the copy again.`,
          ]
        : []),
    ].join(" ");
  }
  if (r.needs || r.targets.every((t) => t.preview))
    return `No free program reads ${r.format.name}: the canvas says so, shows which app the person needs and what to export from it, and offers to take the preview picture stored inside. Nothing was converted.`;
  if (media)
    return `The browser cannot play ${r.format.name} (${name}) as it is: the canvas shows a «Convert to see it» button and the download. It was NOT converted automatically; the person decides. To do it yourself: convert_file with path "${path}" (it makes a ${(r.targets[0]?.ext ?? "webm").toUpperCase()} copy in ${path}.open/), then show_file on that copy.`;
  return `${r.format.name} is a closed format: the canvas shows a box offering the person to convert it into ${r.targets
    .filter((t) => !t.asked)
    .map((t) => t.ext.toUpperCase())
    .join(
      ", ",
    )} (with the original under it when a viewer can show it). It was NOT converted automatically. convert_file with path "${path}" makes the open copy; show_file on the original then shows that copy.`;
}
