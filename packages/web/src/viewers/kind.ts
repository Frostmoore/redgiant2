// Which viewer opens a file in the canvas (G34.2): from its name's extension and its first
// bytes. The bytes win when the name lies or says nothing (a PDF called "report", a ZIP called
// ".dat"); a name with no known kind whose bytes read as text opens as text.

export type ViewerKind =
  | "video"
  | "audio"
  | "image"
  | "pdf"
  | "markdown"
  | "code"
  | "text"
  | "table"
  | "sheet"
  | "document"
  | "slides"
  | "model"
  | "archive"
  | "font"
  | "tree"
  | "site"
  | "layers"
  | "unknown";

export interface ViewerChoice {
  kind: ViewerKind;
  /** The format inside the kind: the extension, or what the bytes said ("pdf", "zip"…). */
  format: string;
}

const BY_EXT: Record<string, ViewerKind> = {};
const put = (kind: ViewerKind, exts: string) => {
  for (const e of exts.split(" ")) BY_EXT[e] = kind;
};
put("video", "mp4 m4v webm ogv mov mkv avi wmv flv mpg mpeg 3gp");
put("audio", "mp3 wav ogg oga m4a flac aac opus weba wma aiff aif mid midi amr");
put("image", "png jpg jpeg gif webp avif bmp ico svg tif tiff heic heif");
put("pdf", "pdf");
put("markdown", "md markdown mdx");
put(
  "code",
  "js mjs cjs jsx ts mts cts tsx py rb go rs java kt kts swift c h cc cpp hpp cxx cs php sh bash zsh fish ps1 bat cmd sql css scss sass less vue svelte lua r dart scala clj ex exs erl hs ml fs pl pm toml ini cfg conf dockerfile makefile cmake gradle tf hcl proto graphql gql diff patch vim el nix zig",
);
put("text", "txt log text rst adoc tex bib srt vtt env gitignore editorconfig license readme");
put("table", "csv tsv");
put("sheet", "xlsx xlsm xls ods fods numbers");
put("document", "docx odt fodt rtf");
put("slides", "pptx odp");
put("model", "glb gltf obj stl fbx ply");
put("archive", "zip tar tgz gz jar apk");
put("font", "ttf otf woff woff2");
put("tree", "json jsonc json5 geojson yaml yml xml plist");
put("site", "html htm xhtml");
// OpenRaster (G34.4): the open copy of a PSD, its layers one by one.
put("layers", "ora");

/** Files known by their whole name (no extension). */
const BY_NAME: Record<string, ViewerChoice> = {
  dockerfile: { kind: "code", format: "dockerfile" },
  makefile: { kind: "code", format: "makefile" },
  license: { kind: "text", format: "txt" },
  readme: { kind: "text", format: "txt" },
};

/**
 * A name with no extension (`hosts`, `Procfile`), a dotfile (`.env`, `.npmrc`) or `.env.local`
 * (p3.5.1): text the editor opens until its bytes say otherwise. The same rule as the server's
 * text family (`NO_EXTENSION` in `editor/text-family.ts`).
 */
export const bareText = (name: string): boolean =>
  /^(\.?[^.]+|\.env(\.[\w-]+)+)$/i.test(name.split(/[\\/]/).pop() ?? name);

/** The lower-case extension ("tar.gz" counts as "tgz"), or "". */
export function extensionOf(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  if (base.endsWith(".tar.gz")) return "tgz";
  const m = base.match(/\.([a-z0-9]+)$/);
  return m?.[1] ?? "";
}

const at = (b: Uint8Array, i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
const ascii = (b: Uint8Array, i: number, s: string) =>
  [...s].every((c, j) => b[i + j] === c.charCodeAt(0));

/** Bytes that read as text: no zero bytes and few control characters. */
export function looksText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  let odd = 0;
  for (const c of head) {
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) odd++;
  }
  return odd / head.length < 0.05;
}

/** What the first bytes say, if they say anything for sure. */
export function sniff(head: Uint8Array): ViewerChoice | undefined {
  const b = head;
  if (ascii(b, 0, "%PDF")) return { kind: "pdf", format: "pdf" };
  if (at(b, 0, 0x89, 0x50, 0x4e, 0x47)) return { kind: "image", format: "png" };
  if (at(b, 0, 0xff, 0xd8, 0xff)) return { kind: "image", format: "jpg" };
  if (ascii(b, 0, "GIF8")) return { kind: "image", format: "gif" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return { kind: "image", format: "webp" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return { kind: "audio", format: "wav" };
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "AVI ")) return { kind: "video", format: "avi" };
  if (ascii(b, 4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/^(avif|avis)/.test(brand)) return { kind: "image", format: "avif" };
    if (/^(heic|heix|mif1)/.test(brand)) return { kind: "image", format: "heic" };
    if (/^M4A/.test(brand)) return { kind: "audio", format: "m4a" };
    if (/^qt/.test(brand)) return { kind: "video", format: "mov" };
    return { kind: "video", format: "mp4" };
  }
  if (at(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return { kind: "video", format: "webm" };
  if (ascii(b, 0, "OggS")) return { kind: "audio", format: "ogg" };
  if (ascii(b, 0, "fLaC")) return { kind: "audio", format: "flac" };
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0))
    return { kind: "audio", format: "mp3" };
  if (ascii(b, 0, "glTF")) return { kind: "model", format: "glb" };
  if (ascii(b, 0, "Kaydara FBX Binary")) return { kind: "model", format: "fbx" };
  if (ascii(b, 0, "ply\n") || ascii(b, 0, "ply\r")) return { kind: "model", format: "ply" };
  if (ascii(b, 0, "wOFF")) return { kind: "font", format: "woff" };
  if (ascii(b, 0, "wOF2")) return { kind: "font", format: "woff2" };
  if (ascii(b, 0, "OTTO")) return { kind: "font", format: "otf" };
  if (at(b, 0, 0x00, 0x01, 0x00, 0x00, 0x00)) return { kind: "font", format: "ttf" };
  if (at(b, 0, 0x50, 0x4b, 0x03, 0x04) || at(b, 0, 0x50, 0x4b, 0x05, 0x06))
    return { kind: "archive", format: "zip" };
  if (at(b, 0, 0x1f, 0x8b)) return { kind: "archive", format: "gz" };
  if (ascii(b, 257, "ustar")) return { kind: "archive", format: "tar" };
  if (at(b, 0, 0x42, 0x4d) && b.length > 26 && b[14] !== undefined && b[14] >= 12)
    return { kind: "image", format: "bmp" };
  return undefined;
}

/** What a text's first characters say: SVG, HTML, XML, JSON. */
function sniffText(head: Uint8Array): ViewerChoice | undefined {
  const s = new TextDecoder().decode(head.slice(0, 512)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(s))
    return { kind: "image", format: "svg" };
  if (/^<!doctype html|^<html[\s>]/i.test(s)) return { kind: "site", format: "html" };
  if (s.startsWith("<?xml")) return { kind: "tree", format: "xml" };
  if (/^[[{]\s*["{[\]0-9tfn-]/.test(s) || s === "{}" || s === "[]")
    return { kind: "tree", format: "json" };
  return undefined;
}

/** Formats inside a ZIP that are documents of their own (by name: the bytes say only "zip"). */
const ZIPPED = new Set([
  "ora",
  "docx",
  "xlsx",
  "xlsm",
  "pptx",
  "odt",
  "ods",
  "odp",
  "jar",
  "apk",
  "numbers",
]);
/** Signatures no text file starts with. */
const STRONG = new Set(["pdf", "png", "jpg", "gif", "webp", "zip", "gz", "glb", "woff", "woff2"]);
/** Kinds whose files must start with these bytes: anything else is not what the name says. */
const MUST: Partial<Record<string, string[]>> = {
  pdf: ["pdf"],
  png: ["png"],
  jpg: ["jpg"],
  jpeg: ["jpg"],
  gif: ["gif"],
  webp: ["webp"],
  zip: ["zip"],
  glb: ["glb"],
};

/**
 * The viewer for a file. `head` is its first bytes (512 are plenty), when known: they decide
 * for a missing or unknown extension and correct a name that lies.
 */
export function viewerFor(name: string, head?: Uint8Array): ViewerChoice {
  const ext = extensionOf(name);
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  const byName = BY_NAME[base];
  const byExt: ViewerChoice | undefined =
    byName ?? (BY_EXT[ext] && { kind: BY_EXT[ext], format: ext });
  if (!head) return byExt ?? { kind: "unknown", format: ext };
  const sniffed = sniff(head);
  if (byExt) {
    // An Office or OpenDocument file is a ZIP: its name says which.
    if (sniffed?.format === "zip" && ZIPPED.has(ext)) return byExt;
    const must = MUST[ext];
    if (must && sniffed && !must.includes(sniffed.format)) return sniffed;
    if (must && !sniffed && !looksText(head)) return byExt;
    if (must && !sniffed) return sniffText(head) ?? { kind: "text", format: "txt" };
    const textual = ["code", "text", "markdown", "table", "tree"].includes(byExt.kind);
    // A PDF or a picture called ".txt" is what its bytes say.
    if (textual && sniffed && STRONG.has(sniffed.format)) return sniffed;
    // A text kind holding binary bytes is not text.
    if (textual && !looksText(head)) return sniffed ?? { kind: "unknown", format: ext };
    return byExt;
  }
  if (sniffed) return sniffed;
  if (looksText(head)) return sniffText(head) ?? { kind: "text", format: ext || "txt" };
  return { kind: "unknown", format: ext };
}

/** The MIME type a player is asked about (canPlayType). */
export const MEDIA_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg; codecs=opus",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  wma: "audio/x-ms-wma",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  mid: "audio/midi",
  midi: "audio/midi",
  amr: "audio/amr",
};

/** Formats a browser never plays: said before trying. */
const NEVER = new Set(["avi", "wmv", "flv", "wma", "mid", "midi", "amr", "mpg", "mpeg"]);

/**
 * Whether this browser can play a format: "no" for those no browser plays, "maybe" when it
 * says it might (the player's own error decides then).
 */
export function playable(format: string, canPlayType?: (type: string) => string): "no" | "maybe" {
  if (NEVER.has(format)) return "no";
  const type = MEDIA_TYPES[format];
  if (!type || !canPlayType) return "maybe";
  // Matroska is often played as WebM (same container) even when the browser says no.
  if (format === "mkv") return "maybe";
  return canPlayType(type) === "" ? "no" : "maybe";
}

/** The language CodeMirror is asked for: by file name (its language-data matches names). */
export function codeLanguageName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/**
 * Office files the canvas shows laid out as on paper (G34.4, decision of 2026-11-07): LibreOffice
 * turns them into a PDF on the server (`/api/files/preview`). The same formats as the server's
 * `PREVIEWABLE`, by extension; the kind says which viewer the person may also want (the table).
 */
const PAGED: Record<string, "document" | "sheet" | "slides" | "drawing"> = {};
const paged = (kind: (typeof PAGED)[string], exts: string) => {
  for (const e of exts.split(" ")) PAGED[e] = kind;
};
paged("document", "docx docm dotx dotm doc dot rtf wpd wps odt ott fodt pages");
paged("sheet", "xlsx xlsm xltx xls xlsb xlt ods ots fods numbers");
paged("slides", "pptx pptm potx ppsx ppt pps pot odp otp fodp key");
paged("drawing", "odg otg fodg vsd vsdx vsdm vdx pub");

/** The kind of a file the canvas lays out as pages, or undefined. */
export function pagedKind(name: string): (typeof PAGED)[string] | undefined {
  return PAGED[extensionOf(name)];
}

/** What the canvas's tabs draw for a file (G34.4): one icon per family. */
export type TabIcon =
  | "video"
  | "audio"
  | "image"
  | "pdf"
  | "document"
  | "sheet"
  | "slides"
  | "model"
  | "archive"
  | "code"
  | "font"
  | "data"
  | "design"
  | "site"
  | "file";

/** Closed design and layout formats (they open through their open copy). */
const DESIGN = new Set(
  "psd psb ai eps indd idml sketch fig xd afdesign afphoto afpub cdr cmx ora kra xcf sla".split(
    " ",
  ),
);

/** The tab icon of a file, from its name. */
export function tabIconFor(name: string): TabIcon {
  const ext = extensionOf(name);
  if (DESIGN.has(ext)) return "design";
  const p = PAGED[ext];
  if (p) return p === "drawing" ? "design" : p;
  const kind = viewerFor(name).kind;
  switch (kind) {
    case "video":
    case "audio":
    case "image":
    case "pdf":
    case "document":
    case "sheet":
    case "slides":
    case "model":
    case "archive":
    case "code":
    case "font":
    case "site":
      return kind;
    case "layers":
      return "design";
    case "table":
      return "sheet";
    case "tree":
      return "data";
    case "markdown":
    case "text":
      return "document";
    default:
      return "file";
  }
}
