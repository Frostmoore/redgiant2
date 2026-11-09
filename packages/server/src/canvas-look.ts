// What canvas_look shows the agent (G36.12): a picture of a file as the canvas shows it, made on
// the server (never in the person's browser), small enough to send to a model, with a few words
// of text. A PDF's page (or an Office document's paged preview: LibreOffice's PDF, then the page)
// through Ghostscript or LibreOffice; a video's frame at a time and a sound's waveform through
// ffmpeg; a 3D model drawn in RedGiant's own code (model-render.ts); pictures, Photoshop and
// OpenRaster files shrunk; a sheet's cells and a text's lines as text. A program that is not here
// yet is fetched in the background (its bar shows), and the answer says to look again.

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { type FileConverter, formatOfFile, PREVIEWABLE } from "./convert.js";
import { pngOf, psdComposite, type Rgba, rgbaOf, shrink } from "./convert-js.js";
import { execRunner, type Programs, type Runner } from "./convert-programs.js";
import { pdfPage } from "./knowledge/extract.js";
import { LO_QUIET, loProfiles, profileArg } from "./lo-profiles.js";
import { type ModelView, readModel, renderModel, SIMPLE_MODELS } from "./model-render.js";

export type LookKind =
  | "image"
  | "photoshop"
  | "openraster"
  | "pdf"
  | "paged"
  | "video"
  | "audio"
  | "model"
  | "sheet"
  | "text"
  | "other";

const IMAGE = /^(png|jpe?g|gif|webp|bmp|avif|tiff?)$/;
const VIDEO = /^(mp4|webm|mov|m4v|mkv|avi|ogv|wmv|flv|mpe?g|3gp|m2ts|mts)$/;
const AUDIO = /^(mp3|wav|ogg|oga|m4a|flac|aac|opus|wma|aiff?)$/;
const MODEL = /^(stl|obj|glb|gltf|fbx|ply|dae|3ds|blend|usdz?|usd[ac]|abc)$/;
const PAGED = /^(docx?|odt|fodt|rtf|pptx?|odp|fodp|odg|fodg|pages|key|vsdx?|pub)$/;
const SHEET = /^(csv|tsv|xlsx|xlsm|xls|ods|fods|numbers)$/;
const BINARY = /^(zip|tar|gz|tgz|7z|rar|exe|dll|so|dylib|bin|iso|dmg|woff2?|ttf|otf|sqlite|db)$/;

const extOf = (name: string) => extname(name).slice(1).toLowerCase();

/** The kind of look a file gets, from its name. */
export function lookKindOf(name: string): LookKind {
  const ext = extOf(name);
  if (ext === "pdf" || ext === "ai") return "pdf";
  if (ext === "psd" || ext === "psb") return "photoshop";
  if (ext === "ora") return "openraster";
  if (IMAGE.test(ext)) return "image";
  if (VIDEO.test(ext)) return "video";
  if (AUDIO.test(ext)) return "audio";
  if (MODEL.test(ext)) return "model";
  if (SHEET.test(ext)) return "sheet";
  if (PAGED.test(ext)) return "paged";
  if (BINARY.test(ext)) return "other";
  return "text";
}

/** What the agent asked to see; anything left out comes from where the person is. */
export interface LookAsk {
  page?: number | undefined;
  /** Seconds. */
  time?: number | undefined;
  fromLine?: number | undefined;
  toLine?: number | undefined;
  /** A1:F30. */
  cells?: string | undefined;
  sheet?: string | undefined;
  view?: ModelView | undefined;
  /** The picture's longest side, in pixels. */
  width?: number | undefined;
}

export interface LookDeps {
  owner: string;
  programs: Pick<Programs, "find" | "canDownload" | "ensure">;
  converter: Pick<FileConverter, "preview" | "previewState">;
  /** LibreOffice's own profile (one for RedGiant, never the person's). */
  profileDir: string;
  /** Where the work files go (removed after). */
  tmpDir: string;
  run?: Runner;
  signal?: AbortSignal | undefined;
}

export interface LookPicture {
  mediaType: "image/png" | "image/jpeg";
  data: Uint8Array;
}

export interface Looked {
  kind: LookKind;
  text: string;
  image?: LookPicture;
}

/** The longest side of a picture sent to the model: big enough to read, light to send. */
export const LOOK_SIDE = 1280;
const sideOf = (ask: LookAsk) => Math.max(256, Math.min(1600, Math.round(ask.width ?? LOOK_SIDE)));

/** Fits a picture in the side and makes it a PNG. */
function fitted(img: Rgba, side: number): { png: LookPicture; width: number; height: number } {
  const small = shrink(img, side);
  return {
    png: { mediaType: "image/png", data: pngOf(small) },
    width: small.width,
    height: small.height,
  };
}

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.ceil(n / 1024)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** A program here now; if not, its download starts (the person sees its bar) and the words say so. */
function programOr(d: LookDeps, id: "ffmpeg" | "libreoffice"): string | { note: string } {
  const exe = d.programs.find(id);
  if (exe) return exe;
  const name = id === "ffmpeg" ? "ffmpeg" : "LibreOffice";
  if (!d.programs.canDownload(id))
    return { note: `No picture: ${name} is not on this computer and cannot be downloaded here.` };
  void d.programs.ensure(d.owner, id).catch(() => {});
  return {
    note: `No picture yet: ${name} is being downloaded (the person sees its bar). Look again in a minute or two.`,
  };
}

const run = (d: LookDeps, file: string, args: string[], timeoutMs = 120_000) =>
  (d.run ?? execRunner)(file, args, { timeoutMs, signal: d.signal });

async function workDir(d: LookDeps): Promise<string> {
  await mkdir(d.tmpDir, { recursive: true });
  return mkdtemp(join(d.tmpDir, "look-"));
}

/** The one file a program wrote into a folder. */
async function madeIn(dir: string, ext: string): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const name = names.find((n) => n.toLowerCase().endsWith(`.${ext}`));
  return name ? join(dir, name) : undefined;
}

// ---------------------------------------------------------------- Pages

/** A PDF page as a picture: Ghostscript when it is here, LibreOffice otherwise. */
async function pdfPicture(
  pdf: string,
  page: number,
  pts: { width: number; height: number },
  side: number,
  d: LookDeps,
): Promise<{ image?: LookPicture; note?: string }> {
  const long = Math.max(pts.width, pts.height) || 792;
  const work = await workDir(d);
  try {
    const gs = d.programs.find("ghostscript");
    if (gs) {
      const dpi = Math.max(36, Math.min(300, Math.round((side / long) * 72)));
      const out = join(work, "page.png");
      const r = await run(d, gs, [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        "-sDEVICE=png16m",
        `-r${dpi}`,
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-sOutputFile=${out}`,
        pdf,
      ]);
      const png = r.exitCode === 0 ? await readFile(out).catch(() => undefined) : undefined;
      if (png) return { image: fitted(rgbaOf(png), side).png };
    }
    const lo = programOr(d, "libreoffice");
    if (typeof lo !== "string") return { note: lo.note };
    const w = Math.round((pts.width / long) * side);
    const h = Math.round((pts.height / long) * side);
    const filter = `png:draw_png_Export:${JSON.stringify({
      PageRange: { type: "string", value: String(page) },
      PixelWidth: { type: "long", value: String(w) },
      PixelHeight: { type: "long", value: String(h) },
    })}`;
    // Its own profile, one run at a time (p3.5.3: never two soffice on one profile).
    const r = await loProfiles(d.profileDir).use((profile) =>
      run(d, lo, [
        ...LO_QUIET,
        profileArg(profile),
        "--infilter=draw_pdf_import",
        "--convert-to",
        filter,
        "--outdir",
        work,
        pdf,
      ]),
    );
    const made = await madeIn(work, "png");
    if (r.exitCode !== 0 || !made)
      return {
        note: `No picture: LibreOffice could not draw the page (${r.exitCode ?? "timeout"}).`,
      };
    return { image: fitted(rgbaOf(await readFile(made)), side).png };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A PDF (or a paged preview's PDF) at a page: its text and its picture. */
async function lookPdf(
  pdf: string,
  ask: LookAsk,
  d: LookDeps,
  what: string,
): Promise<{ text: string; image?: LookPicture }> {
  const info = await pdfPage(new Uint8Array(await readFile(pdf)), ask.page ?? 1);
  const pic = await pdfPicture(pdf, info.page, info, sideOf(ask), d);
  const words = info.text.trim();
  return {
    text: [
      `${what}: page ${info.page} of ${info.pages}.`,
      ...(ask.page && ask.page > info.pages ? [`(There is no page ${ask.page}.)`] : []),
      ...(pic.note ? [pic.note] : []),
      words
        ? `Text on the page:\n${words.slice(0, 6000)}`
        : "No text on this page (a picture or a scan).",
    ].join("\n"),
    ...(pic.image && { image: pic.image }),
  };
}

// ---------------------------------------------------------------- Video, sound, pictures

const durationOf = (stderr: string) => {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
};
const clock = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(r % 1 ? 1 : 0)}`;
};

/** A video's frame at a time (JPEG), through ffmpeg. */
async function lookVideo(abs: string, ask: LookAsk, d: LookDeps) {
  const ff = programOr(d, "ffmpeg");
  if (typeof ff !== "string") return { text: ff.note };
  const side = sideOf(ask);
  const work = await workDir(d);
  try {
    const grab = async (t: number) => {
      const out = join(work, `frame-${Math.round(t * 1000)}.jpg`);
      const r = await run(d, ff, [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        String(t),
        "-i",
        abs,
        "-frames:v",
        "1",
        "-vf",
        `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(gt(iw,ih),-2,min(${side},ih))'`,
        "-q:v",
        "4",
        out,
      ]);
      const data = await readFile(out).catch(() => undefined);
      return { data, duration: durationOf(r.stderr), r };
    };
    let t = Math.max(0, ask.time ?? 0);
    let got = await grab(t);
    // Past the end: the last moment instead.
    if (!got.data && got.duration !== undefined && t >= got.duration) {
      t = Math.max(0, got.duration - 0.5);
      got = await grab(t);
    }
    const total = got.duration !== undefined ? ` of ${clock(got.duration)}` : "";
    if (!got.data)
      return {
        text: `Video: no frame at ${clock(t)}${total} (ffmpeg: ${got.r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? got.r.exitCode}).`,
      };
    return {
      text: `Video: the frame at ${clock(t)}${total}.`,
      image: { mediaType: "image/jpeg" as const, data: new Uint8Array(got.data) },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A sound: its length and its waveform. */
async function lookAudio(abs: string, ask: LookAsk, d: LookDeps) {
  const ff = programOr(d, "ffmpeg");
  if (typeof ff !== "string") return { text: ff.note };
  const work = await workDir(d);
  try {
    const out = join(work, "wave.png");
    const w = Math.min(sideOf(ask), 1200);
    const r = await run(d, ff, [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      abs,
      "-filter_complex",
      `showwavespic=s=${w}x${Math.round(w / 5)}:colors=0x3b6fd8`,
      "-frames:v",
      "1",
      out,
    ]);
    const duration = durationOf(r.stderr);
    const png = await readFile(out).catch(() => undefined);
    const at = ask.time !== undefined ? ` The person's place: ${clock(ask.time)}.` : "";
    return {
      text: `Sound${duration !== undefined ? ` of ${clock(duration)}` : ""}: its waveform.${at}`,
      ...(png && { image: fitted(rgbaOf(png), sideOf(ask)).png }),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const imageTypeOf = (
  b: Uint8Array,
): LookPicture["mediaType"] | "image/gif" | "image/webp" | undefined => {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[8] === 0x57) return "image/webp";
  return undefined;
};

async function lookImage(abs: string, bytes: Uint8Array, ask: LookAsk, d: LookDeps) {
  const side = sideOf(ask);
  if (imageTypeOf(bytes) === "image/png") {
    const img = rgbaOf(bytes);
    const f = fitted(img, side);
    return {
      text: `Picture ${img.width}×${img.height}${f.width !== img.width ? `, shown at ${f.width}×${f.height}` : ""}.`,
      image: f.png,
    };
  }
  // JPEG, GIF, WebP, BMP, AVIF, TIFF: ffmpeg shrinks them (a GIF's first frame).
  const ff = d.programs.find("ffmpeg");
  if (ff) {
    const work = await workDir(d);
    try {
      const out = join(work, "picture.png");
      await run(d, ff, [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        abs,
        "-frames:v",
        "1",
        "-vf",
        `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(gt(iw,ih),-2,min(${side},ih))'`,
        out,
      ]);
      const png = await readFile(out).catch(() => undefined);
      if (png) {
        const img = rgbaOf(png);
        return {
          text: `Picture, shown at ${img.width}×${img.height}.`,
          image: fitted(img, side).png,
        };
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  // Without ffmpeg: a small JPEG as it is.
  const type = imageTypeOf(bytes);
  if (type === "image/jpeg" && bytes.byteLength <= 1_500_000)
    return { text: "Picture (as it is).", image: { mediaType: type, data: bytes } };
  const ffm = programOr(d, "ffmpeg");
  return {
    text: `Picture of ${size(bytes.byteLength)}. ${typeof ffm === "string" ? "" : ffm.note}`.trim(),
  };
}

// ---------------------------------------------------------------- Sheets and text

/** A1:F30 → zero-based columns and rows, inclusive. */
export function cellRange(
  cells: string | undefined,
): { c0: number; r0: number; c1: number; r1: number } | undefined {
  const m = cells
    ?.trim()
    .toUpperCase()
    .match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/);
  if (!m) return undefined;
  const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const a = { c: col(m[1] as string), r: Number(m[2]) - 1 };
  const b = m[3] ? { c: col(m[3]), r: Number(m[4]) - 1 } : a;
  return {
    c0: Math.min(a.c, b.c),
    r0: Math.min(a.r, b.r),
    c1: Math.max(a.c, b.c),
    r1: Math.max(a.r, b.r),
  };
}

export const columnName = (c: number): string =>
  c < 26 ? String.fromCharCode(65 + c) : columnName(Math.floor(c / 26) - 1) + columnName(c % 26);

/** CSV or TSV rows (quotes understood), separator guessed from the first line. */
export function parseDelimited(text: string): string[][] {
  const first = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  const sep = [",", ";", "\t", "|"]
    .map((s) => [s, first.split(s).length] as const)
    .sort((a, b) => b[1] - a[1])[0]?.[0] as string;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const xmlText = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** An Excel workbook's sheet names, and one sheet's cells as text (values, not formulas). */
export function readXlsx(
  bytes: Uint8Array,
  want?: string,
): { sheets: string[]; sheet: string; rows: string[][] } {
  const files = unzipSync(bytes, {
    filter: (f) =>
      f.name === "xl/workbook.xml" ||
      f.name === "xl/_rels/workbook.xml.rels" ||
      f.name === "xl/sharedStrings.xml" ||
      f.name.startsWith("xl/worksheets/sheet"),
  });
  const text = (n: string) => (files[n] ? strFromU8(files[n]) : "");
  const book = text("xl/workbook.xml");
  const rels = new Map(
    [...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      m[0].match(/\bId="([^"]+)"/)?.[1],
      m[0].match(/\bTarget="([^"]+)"/)?.[1],
    ]),
  );
  const sheets = [...book.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: xmlText(m[0].match(/\bname="([^"]*)"/)?.[1] ?? ""),
    target: rels.get(m[0].match(/\br:id="([^"]+)"/)?.[1]) ?? "",
  }));
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText((m[1] as string).replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")),
  );
  const chosen = sheets.find((s) => s.name.toLowerCase() === want?.toLowerCase()) ?? sheets[0];
  const path = chosen ? `xl/${chosen.target.replace(/^\/?xl\//, "").replace(/^\//, "")}` : "";
  const rows: string[][] = [];
  for (const m of text(path).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1] as string;
    const ref = attrs.match(/\br="([A-Z]+)(\d+)"/);
    if (!ref) continue;
    const r = cellRange(`${ref[1]}${ref[2]}`);
    if (!r) continue;
    const type = attrs.match(/\bt="(\w+)"/)?.[1];
    const body = m[2] ?? "";
    const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    const value =
      type === "s"
        ? (shared[Number(v)] ?? "")
        : type === "inlineStr"
          ? xmlText(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "")
          : type === "b"
            ? v === "1"
              ? "TRUE"
              : "FALSE"
            : xmlText(v ?? "");
    const row = rows[r.r0] ?? [];
    rows[r.r0] = row;
    row[r.c0] = value;
  }
  return {
    sheets: sheets.map((s) => s.name),
    sheet: chosen?.name ?? "",
    rows: Array.from(rows, (r) => Array.from(r ?? [], (c) => c ?? "")),
  };
}

/** A block of cells as a text table, columns and rows named as in the sheet. */
export function cellsTable(rows: string[][], cells: string | undefined): string {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const range = cellRange(cells) ?? {
    c0: 0,
    r0: 0,
    c1: Math.min(width, 12) - 1,
    r1: Math.min(rows.length, 40) - 1,
  };
  const c1 = Math.min(range.c1, range.c0 + 25);
  const r1 = Math.min(range.r1, range.r0 + 99);
  const cut = (s: string) => {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > 40 ? `${one.slice(0, 39)}…` : one;
  };
  const head = [
    "",
    ...Array.from({ length: c1 - range.c0 + 1 }, (_, i) => columnName(range.c0 + i)),
  ];
  const lines = [head.join(" | ")];
  for (let r = range.r0; r <= r1; r++)
    lines.push(
      [
        String(r + 1),
        ...Array.from({ length: c1 - range.c0 + 1 }, (_, i) => cut(rows[r]?.[range.c0 + i] ?? "")),
      ].join(" | "),
    );
  return lines.join("\n");
}

async function lookSheet(abs: string, bytes: Uint8Array, ask: LookAsk, d: LookDeps, name: string) {
  const ext = extOf(name);
  // A page of its paged preview when one is asked for (how it prints).
  if (ask.page && PAGED_SHEETS.test(ext))
    return lookPaged(abs, ask, d, "Sheet, paged as it prints");
  let rows: string[][];
  let where = "";
  if (ext === "csv" || ext === "tsv") rows = parseDelimited(new TextDecoder().decode(bytes));
  else if (ext === "xlsx" || ext === "xlsm") {
    const book = readXlsx(bytes, ask.sheet);
    rows = book.rows;
    where = ` Sheet «${book.sheet}»${book.sheets.length > 1 ? ` (sheets: ${book.sheets.join(", ")})` : ""}.`;
  } else return lookPaged(abs, { ...ask, page: ask.page ?? 1 }, d, "Sheet, paged as it prints");
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return {
    text: `Sheet of ${rows.length} rows and ${width} columns.${where} Cells ${ask.cells ?? "from A1"}:\n${cellsTable(rows, ask.cells)}`,
  };
}
const PAGED_SHEETS = /^(xlsx|xlsm|xls|ods|fods|numbers)$/;

/** Lines of a text, numbered; around the asked line, or the first ones. */
export function textLines(text: string, from?: number, to?: number): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Math.min(lines.length, from ?? 1));
  const end = Math.max(start, Math.min(lines.length, to ?? start + 79, start + 299));
  const pad = String(end).length;
  const out = lines
    .slice(start - 1, end)
    .map(
      (l, i) => `${String(start + i).padStart(pad)}| ${l.length > 400 ? `${l.slice(0, 400)}…` : l}`,
    );
  return `Lines ${start}-${end} of ${lines.length}:\n${out.join("\n")}`;
}

async function lookPaged(abs: string, ask: LookAsk, d: LookDeps, what: string) {
  const root = dirname(abs);
  const path = basename(abs);
  const state = await d.converter.previewState(root, path);
  if (!state.ready) {
    const lo = d.programs.find("libreoffice");
    if (!lo) {
      const got = programOr(d, "libreoffice");
      return {
        text: `${what}: there is no paged preview yet. ${typeof got === "string" ? "" : got.note}`.trim(),
      };
    }
  }
  const pdf = await d.converter.preview(root, path, { owner: d.owner, signal: d.signal });
  return lookPdf(pdf, ask, d, what);
}

// ---------------------------------------------------------------- Everything

/** A file seen as the canvas shows it: words, and a picture when there is one. */
export async function lookAt(abs: string, ask: LookAsk, d: LookDeps): Promise<Looked> {
  const name = basename(abs);
  const kind = lookKindOf(name);
  const st = await stat(abs);
  const head = `${name} (${size(st.size)}).`;
  const done = (r: { text: string; image?: LookPicture | undefined }): Looked => ({
    kind,
    text: `${head} ${r.text}`,
    ...(r.image && { image: r.image }),
  });
  const big = st.size > 200 * 1024 * 1024;
  switch (kind) {
    case "pdf":
      return done(await lookPdf(abs, ask, d, "PDF"));
    case "paged": {
      const f = await formatOfFile(abs);
      if (!f || !PREVIEWABLE.has(f.id))
        return done({ text: "No paged preview for this format: convert_file makes an open copy." });
      return done(await lookPaged(abs, ask, d, "Document, paged as LibreOffice prints it"));
    }
    case "video":
      return done(await lookVideo(abs, ask, d));
    case "audio":
      return done(await lookAudio(abs, ask, d));
    case "model": {
      const ext = extOf(name);
      if (!SIMPLE_MODELS.has(ext) || big)
        return done({
          text: `3D model: no simple picture of ${ext.toUpperCase()} here; for a real render use the blender tool with render.`,
        });
      const m = renderModel(
        readModel(ext, new Uint8Array(await readFile(abs))),
        ask.view ?? "iso",
        800,
        600,
      );
      const [x, y, z] = m.size.map((v) => Number(v.toPrecision(4)));
      return done({
        text: `3D model, ${m.triangles} triangles, ${x} × ${y} × ${z} (X × Y × Z), seen from ${ask.view ?? "iso"} (a simple flat drawing; the blender tool renders it for real).`,
        image: fitted(m.img, sideOf(ask)).png,
      });
    }
    case "image":
      if (big) return done({ text: "Picture too large to look at here." });
      return done(await lookImage(abs, new Uint8Array(await readFile(abs)), ask, d));
    case "photoshop": {
      if (big) return done({ text: "Photoshop file too large to look at here." });
      const img = psdComposite(new Uint8Array(await readFile(abs)));
      if (!img)
        return done({
          text: "This Photoshop file keeps no flattened picture: convert_file makes its layers.",
        });
      const f = fitted(img, sideOf(ask));
      return done({ text: `Photoshop file ${img.width}×${img.height}, flattened.`, image: f.png });
    }
    case "openraster": {
      const files = unzipSync(new Uint8Array(await readFile(abs)), {
        filter: (f) => f.name === "mergedimage.png",
      });
      const merged = files["mergedimage.png"];
      if (!merged) return done({ text: "This OpenRaster file has no merged picture." });
      const img = rgbaOf(merged);
      return done({
        text: `OpenRaster picture ${img.width}×${img.height}, layers merged.`,
        image: fitted(img, sideOf(ask)).png,
      });
    }
    case "sheet":
      if (big) return done({ text: "Sheet too large to read here." });
      return done(await lookSheet(abs, new Uint8Array(await readFile(abs)), ask, d, name));
    case "text": {
      if (st.size > 20 * 1024 * 1024)
        return done({ text: "Text too large: read_file reads parts of it." });
      const bytes = new Uint8Array(await readFile(abs));
      if (bytes.subarray(0, 8192).includes(0))
        return done({ text: "Not text and no viewer draws it: nothing to see here." });
      return done({ text: textLines(new TextDecoder().decode(bytes), ask.fromLine, ask.toLine) });
    }
    default:
      return done({ text: "No picture for this kind of file (the canvas offers it to download)." });
  }
}
