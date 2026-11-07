// Which file formats are open and which are closed (G34.3, the user's decision of 2026-11-07:
// «deve essere tutto in formati open source ovviamente, se un file è closed source lo deve
// convertire in un formato open»). Agents work on open formats; a closed one (or one the browser
// cannot show) is converted into an open one beside the original. This file only knows formats:
// what a file is (from its name and first bytes) and what it can become. Pure, no I/O.

/** The program that makes a target: our own code, or one downloaded when needed. */
export type Via = "js" | "libreoffice" | "scribus" | "blender" | "ghostscript" | "ffmpeg";

export interface Target {
  /** The open format's extension (`ora`, `odt`, `webm`…). */
  ext: string;
  via: Via;
  /** What this conversion leaves behind, in plain words for the agent and the person. */
  losses: string[];
  /** Made only when asked for by name (e.g. IDML → ODT, text only). */
  asked?: boolean;
  /** Left out by default when this other target was made (the fallback of a better one). */
  unless?: string;
  /** Not a conversion: only the picture the file carries (said as such, never passed off as one). */
  preview?: boolean;
}

/**
 * When no free program can read a format: the closed app that can, and what to export from it
 * so the agents can work without losing the layout (the UI shows the link and «Open in…»).
 */
export interface Needs {
  app: "affinity" | "indesign" | "figma" | "xd";
  name: string;
  /** Where to get it (free for Affinity). */
  url?: string;
  /** The open format another program can make from it instead (INDD: the IDML). */
  alt?: string;
  /** What to export from the app, beside the file. */
  export: string[];
  message: string;
}

export type FormatKind =
  | "image"
  | "design"
  | "vector"
  | "layout"
  | "document"
  | "sheet"
  | "slides"
  | "drawing"
  | "video"
  | "audio"
  | "3d"
  | "data"
  | "archive";

export interface FormatInfo {
  /** Stable id (`psd`, `ai-pdf`, `docx`…). */
  id: string;
  /** The format's name, as people know it. */
  name: string;
  kind: FormatKind;
  /** An open, documented format (free to read and write, no single owner). */
  open: boolean;
  /** Shown by a browser as it is. */
  browser: boolean;
  /** What it can become; the first is the default. Empty when there is nothing to do. */
  targets: Target[];
  /** One line for the agent: what it can do with the file (the closed ones say convert first). */
  note: string;
  needs?: Needs;
}

const t = (ext: string, via: Via, ...losses: string[]): Target => ({ ext, via, losses });
const PREVIEW_ONLY =
  "this is NOT a conversion: only the small preview picture stored inside the file (layers, text and layout cannot be read by any free program)";
const preview = (ext: string, ...losses: string[]): Target => ({
  ext,
  via: "js",
  losses: [PREVIEW_ONLY, ...losses],
  preview: true,
});
const MODEL_LOSS =
  "Blender's glTF export: meshes, materials (PBR), textures, cameras, lights and animations are kept; procedural shaders, modifiers not applied, particles and simulations are baked or left out";
const viaBlender = (open: boolean, name: string, exts: string[], asked = false): Entry => ({
  exts,
  name,
  kind: "3d",
  open,
  browser: false,
  targets: [{ ...t("glb", "blender", MODEL_LOSS), ...(asked && { asked }) }],
});

const OFFICE_LOSS =
  "LibreOffice keeps text, styles, tables, images and most layout; macros, some fonts (replaced by similar ones) and a few advanced effects can differ";
const MEDIA_LOSS = "re-encoded: a small loss of quality (lossy codec)";

type Entry = Omit<FormatInfo, "id" | "note"> & { exts: string[]; note?: string };

/** Every format RedGiant knows by name. Open ones need nothing; the rest say what they become. */
const FORMATS: Record<string, Entry> = {
  // Open images, vectors, documents: agents use them directly.
  png: {
    exts: ["png", "apng"],
    name: "PNG",
    kind: "image",
    open: true,
    browser: true,
    targets: [],
  },
  jpeg: {
    exts: ["jpg", "jpeg", "jfif"],
    name: "JPEG",
    kind: "image",
    open: true,
    browser: true,
    targets: [],
  },
  gif: { exts: ["gif"], name: "GIF", kind: "image", open: true, browser: true, targets: [] },
  webp: { exts: ["webp"], name: "WebP", kind: "image", open: true, browser: true, targets: [] },
  avif: { exts: ["avif"], name: "AVIF", kind: "image", open: true, browser: true, targets: [] },
  bmp: { exts: ["bmp"], name: "BMP", kind: "image", open: true, browser: true, targets: [] },
  ico: { exts: ["ico"], name: "Icon", kind: "image", open: true, browser: true, targets: [] },
  svg: {
    exts: ["svg"],
    name: "SVG",
    kind: "vector",
    open: true,
    browser: true,
    targets: [],
    note: "Open XML vector: read and change it with read_file and edit_file.",
  },
  ora: {
    exts: ["ora"],
    name: "OpenRaster",
    kind: "image",
    open: true,
    browser: false,
    targets: [],
    note: "Open layered image (zip): stack.xml lists the layers, data/*.png are their pixels; use edit_package (render updates mergedimage.png).",
  },
  kra: {
    exts: ["kra"],
    name: "Krita",
    kind: "image",
    open: true,
    browser: false,
    targets: [],
    note: "Open layered image (zip, like OpenRaster): use edit_package.",
  },
  xcf: { exts: ["xcf"], name: "GIMP", kind: "image", open: true, browser: false, targets: [] },
  tiff: {
    exts: ["tif", "tiff"],
    name: "TIFF",
    kind: "image",
    open: true,
    browser: false,
    targets: [
      t("png", "ffmpeg", "only the first page or frame; layers and color profiles are flattened"),
    ],
  },
  pdf: {
    exts: ["pdf"],
    name: "PDF",
    kind: "document",
    open: true,
    browser: true,
    targets: [
      t(
        "odg",
        "libreoffice",
        "each page becomes an editable drawing; complex text runs and some fonts can shift",
      ),
      t("svg", "libreoffice", "only the first page; some fonts and effects can shift"),
    ],
    note: "Open (ISO 32000). To edit its text and shapes, convert it to ODG (or SVG for one page).",
  },
  odt: {
    exts: ["odt", "ott", "fodt"],
    name: "OpenDocument Text",
    kind: "document",
    open: true,
    browser: false,
    targets: [t("pdf", "libreoffice")],
    note: "Open: content.xml and styles.xml inside, use edit_package.",
  },
  ods: {
    exts: ["ods", "ots", "fods"],
    name: "OpenDocument Spreadsheet",
    kind: "sheet",
    open: true,
    browser: false,
    targets: [t("pdf", "libreoffice")],
    note: "Open: content.xml inside, use edit_package.",
  },
  odp: {
    exts: ["odp", "otp", "fodp"],
    name: "OpenDocument Presentation",
    kind: "slides",
    open: true,
    browser: false,
    targets: [t("pdf", "libreoffice")],
    note: "Open: content.xml and styles.xml inside, use edit_package.",
  },
  odg: {
    exts: ["odg", "otg", "fodg"],
    name: "OpenDocument Drawing",
    kind: "drawing",
    open: true,
    browser: false,
    targets: [t("pdf", "libreoffice"), t("svg", "libreoffice", "only the first page")],
    note: "Open: content.xml and styles.xml inside, use edit_package.",
  },
  sla: {
    exts: ["sla"],
    name: "Scribus",
    kind: "layout",
    open: true,
    browser: false,
    targets: [],
    note: "Open XML layout: read and change it with read_file and edit_file.",
  },
  epub: {
    exts: ["epub"],
    name: "EPUB",
    kind: "document",
    open: true,
    browser: false,
    targets: [],
    note: "Open (zip of XHTML): use edit_package.",
  },
  text: {
    exts: ["txt", "md", "markdown", "rst", "tex", "html", "htm", "xml", "css", "js", "ts"],
    name: "Text",
    kind: "data",
    open: true,
    browser: true,
    targets: [],
  },
  data: {
    exts: ["csv", "tsv", "json", "yaml", "yml", "toml"],
    name: "Data",
    kind: "data",
    open: true,
    browser: true,
    targets: [],
  },
  zip: { exts: ["zip"], name: "ZIP", kind: "archive", open: true, browser: false, targets: [] },

  // Open or standard media the browser plays.
  webm: { exts: ["webm"], name: "WebM", kind: "video", open: true, browser: true, targets: [] },
  ogg: {
    exts: ["ogg", "ogv", "oga", "opus"],
    name: "Ogg",
    kind: "audio",
    open: true,
    browser: true,
    targets: [],
  },
  mp4: { exts: ["mp4", "m4v"], name: "MP4", kind: "video", open: true, browser: true, targets: [] },
  m4a: { exts: ["m4a", "aac"], name: "AAC", kind: "audio", open: true, browser: true, targets: [] },
  mp3: { exts: ["mp3"], name: "MP3", kind: "audio", open: true, browser: true, targets: [] },
  wav: { exts: ["wav"], name: "WAV", kind: "audio", open: true, browser: true, targets: [] },
  flac: { exts: ["flac"], name: "FLAC", kind: "audio", open: true, browser: true, targets: [] },
  // Media the browser does not play, or closed containers: WebM (VP9 + Opus), Opus or FLAC.
  mkv: {
    exts: ["mkv"],
    name: "Matroska",
    kind: "video",
    open: true,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  mov: {
    exts: ["mov", "qt"],
    name: "QuickTime",
    kind: "video",
    open: false,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  avi: {
    exts: ["avi"],
    name: "AVI",
    kind: "video",
    open: false,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  wmv: {
    exts: ["wmv", "asf"],
    name: "Windows Media Video",
    kind: "video",
    open: false,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  flv: {
    exts: ["flv", "f4v"],
    name: "Flash Video",
    kind: "video",
    open: false,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  mpeg: {
    exts: ["mpg", "mpeg", "m2ts", "mts", "ts", "vob", "3gp", "3g2"],
    name: "MPEG",
    kind: "video",
    open: false,
    browser: false,
    targets: [t("webm", "ffmpeg", MEDIA_LOSS)],
  },
  wma: {
    exts: ["wma"],
    name: "Windows Media Audio",
    kind: "audio",
    open: false,
    browser: false,
    targets: [t("opus", "ffmpeg", MEDIA_LOSS)],
  },
  aiff: {
    exts: ["aif", "aiff", "aifc"],
    name: "AIFF",
    kind: "audio",
    open: false,
    browser: false,
    targets: [t("flac", "ffmpeg")],
  },
  ape: {
    exts: ["ape", "wv"],
    name: "Monkey's Audio",
    kind: "audio",
    open: false,
    browser: false,
    targets: [t("flac", "ffmpeg")],
  },
  amr: {
    exts: ["amr", "ac3", "eac3", "dts", "caf", "mka"],
    name: "Audio",
    kind: "audio",
    open: false,
    browser: false,
    targets: [t("opus", "ffmpeg", MEDIA_LOSS)],
  },

  // Office: open XML standards, but the user wants OpenDocument.
  docx: {
    exts: ["docx", "docm", "dotx", "dotm", "doc", "dot", "rtf", "wpd", "wps"],
    name: "Word",
    kind: "document",
    open: false,
    browser: false,
    targets: [t("odt", "libreoffice", OFFICE_LOSS), t("pdf", "libreoffice")],
  },
  xlsx: {
    exts: ["xlsx", "xlsm", "xltx", "xls", "xlsb", "xlt"],
    name: "Excel",
    kind: "sheet",
    open: false,
    browser: false,
    targets: [t("ods", "libreoffice", OFFICE_LOSS), t("pdf", "libreoffice")],
  },
  pptx: {
    exts: ["pptx", "pptm", "potx", "ppsx", "ppt", "pps", "pot"],
    name: "PowerPoint",
    kind: "slides",
    open: false,
    browser: false,
    targets: [t("odp", "libreoffice", OFFICE_LOSS), t("pdf", "libreoffice")],
  },
  pages: {
    exts: ["pages"],
    name: "Apple Pages",
    kind: "document",
    open: false,
    browser: false,
    targets: [t("odt", "libreoffice", OFFICE_LOSS)],
  },
  numbers: {
    exts: ["numbers"],
    name: "Apple Numbers",
    kind: "sheet",
    open: false,
    browser: false,
    targets: [t("ods", "libreoffice", OFFICE_LOSS)],
  },
  key: {
    exts: ["key"],
    name: "Apple Keynote",
    kind: "slides",
    open: false,
    browser: false,
    targets: [t("odp", "libreoffice", OFFICE_LOSS)],
  },
  visio: {
    exts: ["vsd", "vsdx", "vsdm", "vdx"],
    name: "Visio",
    kind: "drawing",
    open: false,
    browser: false,
    targets: [t("odg", "libreoffice", "connectors and some shapes can lose their behaviour")],
  },
  publisher: {
    exts: ["pub"],
    name: "Publisher",
    kind: "layout",
    open: false,
    browser: false,
    targets: [t("odg", "libreoffice", "text frames and fonts can shift")],
  },
  cdr: {
    exts: ["cdr", "cmx"],
    name: "CorelDRAW",
    kind: "vector",
    open: false,
    browser: false,
    targets: [t("odg", "libreoffice", "effects, lenses and some fills are simplified")],
  },

  // Graphics and layout (G34.3).
  psd: {
    exts: ["psd", "psb"],
    name: "Photoshop",
    kind: "design",
    open: false,
    browser: false,
    targets: [t("ora", "js"), t("png", "js", "one flat picture: no layers")],
  },
  "ai-pdf": {
    exts: ["ai"],
    name: "Illustrator",
    kind: "vector",
    open: false,
    browser: false,
    targets: [
      t(
        "pdf",
        "js",
        "Illustrator's own editing data (live effects, symbols, artboard settings) stays only in the original",
      ),
      t(
        "svg",
        "libreoffice",
        "only the first artboard; gradients, blends and some fonts can shift",
      ),
      t(
        "odg",
        "libreoffice",
        "every artboard as an editable drawing; effects and some fonts can shift",
      ),
    ],
  },
  "ai-ps": {
    exts: ["ai"],
    name: "Illustrator (old, PostScript)",
    kind: "vector",
    open: false,
    browser: false,
    targets: [
      t("pdf", "ghostscript", "Illustrator's own editing data stays only in the original"),
      t("svg", "libreoffice", "only the first page; some fonts can shift"),
    ],
  },
  eps: {
    exts: ["eps", "epsf", "epsi", "ps"],
    name: "PostScript",
    kind: "vector",
    open: false,
    browser: false,
    targets: [
      t("pdf", "ghostscript"),
      t("svg", "libreoffice", "only the first page; some fonts can shift"),
    ],
  },
  idml: {
    exts: ["idml"],
    name: "InDesign Markup (IDML)",
    kind: "layout",
    open: false,
    browser: false,
    targets: [
      t(
        "sla",
        "scribus",
        "Scribus's own IDML import: pages, master pages, layers, frames at their place, text flowing through linked frames, styles, colours and images; tints, page-number markers, some crops of pictures and effects can differ (the PDF beside it shows how it came out)",
      ),
      {
        ...t(
          "odg",
          "js",
          "RedGiant's own import (when Scribus cannot be had): pages, frames, shapes and pictures at their exact place and size, text with its formatting, colours, layers",
        ),
        unless: "sla",
      },
      t("pdf", "libreoffice", "printed from the ODG (Scribus makes its own PDF with the SLA)"),
      {
        ...t(
          "odt",
          "js",
          "text only: the page layout (frames, positions, master pages, images) is not carried over, only the stories with their paragraph and character styles",
        ),
        asked: true,
      },
    ],
    note: "Closed: convert it (Scribus .sla, or an ODG with the same layout) and work on the copy.",
  },
  indd: {
    exts: ["indd", "indt"],
    name: "InDesign",
    kind: "layout",
    open: false,
    browser: false,
    targets: [preview("jpg", "often just the first page")],
    needs: {
      app: "indesign",
      name: "Adobe InDesign",
      alt: "idml",
      export: ["idml", "pdf"],
      message:
        "No free program can read an INDD. It needs InDesign, or the IDML exported by whoever sent it (InDesign: File > Export > InDesign Markup); with the IDML, RedGiant keeps the layout (Scribus or ODG).",
    },
    note: "Closed and unreadable by free programs: only its stored preview. Ask for the IDML (or a PDF).",
  },
  sketch: {
    exts: ["sketch"],
    name: "Sketch",
    kind: "design",
    open: false,
    browser: false,
    targets: [
      t(
        "svg",
        "js",
        "RedGiant's own reading of the Sketch file: every artboard at its size, shapes, paths, text, colours, borders, opacity and images at their place; shadows, blurs, gradients beyond their first colour and symbol overrides are simplified",
      ),
      preview("png", "the last page you looked at in Sketch"),
      t("txt", "js", "only the pages, artboards, layer names and texts: no shapes or styles"),
    ],
  },
  fig: {
    exts: ["fig"],
    name: "Figma (local copy)",
    kind: "design",
    open: false,
    browser: false,
    targets: [preview("png")],
    needs: {
      app: "figma",
      name: "Figma",
      url: "https://www.figma.com",
      export: ["svg", "pdf"],
      message:
        "A .fig copy cannot be read. Give its Figma link (convert_file with url): RedGiant exports every frame as SVG or PDF through Figma's API, with a token from the Keychain.",
    },
  },
  xd: {
    exts: ["xd"],
    name: "Adobe XD",
    kind: "design",
    open: false,
    browser: false,
    targets: [preview("png")],
    needs: {
      app: "xd",
      name: "Adobe XD",
      export: ["svg", "pdf"],
      message: "No free program can read XD files: export SVG or PDF from Adobe XD beside it.",
    },
  },
  affinity: {
    exts: ["afdesign", "afphoto", "afpub", "af"],
    name: "Affinity",
    kind: "design",
    open: false,
    browser: false,
    targets: [preview("png")],
    needs: {
      app: "affinity",
      name: "Affinity",
      url: "https://www.affinity.studio",
      export: ["pdf", "svg"],
      message:
        "To work on it you need Affinity (free, affinity.studio): open it and export PDF or SVG beside the file; the agents then work on that without losses.",
    },
    note: "Closed and unreadable by free programs: only its stored preview. Export PDF or SVG from Affinity.",
  },

  // 3D: glTF is the open one (the canvas shows glb, gltf, obj, stl, ply and fbx as they are).
  gltf: {
    exts: ["glb", "gltf"],
    name: "glTF",
    kind: "3d",
    open: true,
    browser: true,
    targets: [],
    note: "Open 3D (Khronos): use it as it is; the blender tool changes or renders it.",
  },
  obj: { ...viaBlender(true, "Wavefront OBJ", ["obj"], true), browser: true },
  stl: { ...viaBlender(true, "STL", ["stl"], true), browser: true },
  ply: { ...viaBlender(true, "PLY", ["ply"], true), browser: true },
  fbx: { ...viaBlender(false, "Autodesk FBX", ["fbx"]), browser: true },
  blend: viaBlender(true, "Blender", ["blend"]),
  usd: viaBlender(true, "Universal Scene Description", ["usd", "usda", "usdc", "usdz"]),
  abc: viaBlender(true, "Alembic", ["abc"]),
};

const BY_EXT = new Map<string, string>();
for (const [id, f] of Object.entries(FORMATS))
  for (const e of f.exts) if (!BY_EXT.has(e)) BY_EXT.set(e, id);

const view = (id: string): FormatInfo => {
  const f = FORMATS[id] as Entry;
  const { exts: _exts, note, ...rest } = f;
  const def = f.targets[0];
  return {
    id,
    ...rest,
    note:
      note ??
      (f.open && f.browser
        ? "Open format: use it as it is."
        : f.open
          ? `Open format; the browser does not show it${def ? `: convert it to ${def.ext.toUpperCase()} to show it` : ""}.`
          : `Closed format: convert it first (convert_file) and work on the ${def?.ext.toUpperCase() ?? "open"} copy; the original stays as it is.`),
  };
};

/** Every known format (the list the UI and the tests read). */
export function knownFormats(): FormatInfo[] {
  return Object.keys(FORMATS).map(view);
}

export const formatById = (id: string): FormatInfo | undefined =>
  FORMATS[id] ? view(id) : undefined;

const startsWith = (b: Uint8Array, at: number, ...bytes: number[]) =>
  bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, at: number, s: string) =>
  startsWith(b, at, ...[...s].map((c) => c.charCodeAt(0)));

/** InDesign's document GUID, at the start of every INDD. */
const INDD_GUID = [
  0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d,
];

export const extOf = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
};

/**
 * What a file is: from its name, corrected by its first bytes (an `.ai` is a PDF or a PostScript
 * file; a zip says what it is by its entries). `zipNames` are the entry names when it is a zip.
 */
export function detectFormat(
  name: string,
  head: Uint8Array = new Uint8Array(),
  zipNames?: string[],
): FormatInfo | undefined {
  const ext = extOf(name);
  const isPdf = ascii(head, 0, "%PDF");
  const isPs = ascii(head, 0, "%!PS") || startsWith(head, 0, 0xc5, 0xd0, 0xd3, 0xc6);
  if (ext === "ai") return view(isPs && !isPdf ? "ai-ps" : "ai-pdf");
  if (ascii(head, 0, "8BPS")) return view("psd");
  if (startsWith(head, 0, ...INDD_GUID)) return view("indd");
  if (zipNames) {
    const has = (n: string) => zipNames.includes(n);
    if (zipNames.some((n) => n.startsWith("designmap.xml")) || has("designmap.xml"))
      return view("idml");
    if (has("document.json") && has("meta.json")) return view("sketch");
    if (has("canvas.fig")) return view("fig");
    if (has("stack.xml")) return view("ora");
    if (has("[Content_Types].xml")) {
      if (zipNames.some((n) => n.startsWith("word/"))) return view("docx");
      if (zipNames.some((n) => n.startsWith("xl/"))) return view("xlsx");
      if (zipNames.some((n) => n.startsWith("ppt/"))) return view("pptx");
      if (zipNames.some((n) => n.startsWith("visio/"))) return view("visio");
    }
  }
  const byName = BY_EXT.get(ext);
  if (byName) return view(byName);
  // No known name: the bytes alone.
  if (isPdf) return view("pdf");
  if (isPs) return view("eps");
  if (startsWith(head, 0, 0x89, 0x50, 0x4e, 0x47)) return view("png");
  if (startsWith(head, 0, 0xff, 0xd8, 0xff)) return view("jpeg");
  return undefined;
}

/** Whether the agents must work on a converted copy: the format is closed. */
export const needsConversion = (f: FormatInfo) => !f.open && f.targets.length > 0;

/**
 * Whether a conversion is worth offering at once: closed, or a picture or a sound the browser
 * cannot show (an open document the browser cannot show is the viewer's job, not a conversion's).
 */
export const suggestConversion = (f: FormatInfo) =>
  needsConversion(f) ||
  (!f.browser && f.targets.length > 0 && ["image", "video", "audio", "3d"].includes(f.kind));
