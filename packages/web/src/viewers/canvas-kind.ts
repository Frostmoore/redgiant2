// The canvas's rough kind of a file from its name (the chat's cards), apart from the canvas itself
// (3.5.11): the chat needs it at once, the canvas and its editors load only when a tab opens.
import { isArtifactPath } from "@redgiant/protocol";
import type { CanvasTarget } from "../state.js";

export type CanvasKind =
  | "site"
  /** An HTML app made by an agent (3.5.9): `artefatti/*.html` or a file with its header. */
  | "artifact"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "sheet"
  | "xlsx"
  | "model"
  | "markdown"
  | "json"
  | "text";

/**
 * A rough kind from the name alone (the chat's cards: pictures, videos and sounds in place). A
 * folder is a site. The canvas itself chooses with `viewerFor`, which reads the file too.
 */
export function canvasKind(target: CanvasTarget): CanvasKind {
  if (target.kind === "port") return "site";
  if (isArtifactPath(target.path)) return "artifact";
  const ext = target.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext || ext === "html" || ext === "htm") return "site";
  if (/^(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(ext)) return "image";
  if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return "video";
  if (/^(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/.test(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "sheet";
  if (ext === "xlsx") return "xlsx";
  if (/^(glb|gltf|stl|obj|fbx|ply)$/.test(ext)) return "model";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  return "text";
}
