// Reading files for the knowledge (G36.3): text and code cut by symbol, Markdown by section, PDF
// by page (pdf.js, no worker, no canvas), Office and OpenDocument through the PDF LibreOffice
// makes (the one the Canvas shows, so pages match) or, without LibreOffice, straight from their
// XML, and HTML cleaned of menus and scripts. Pictures and scanned pages are read by the OCR
// when the person turned it on (G36.6: Tesseract on this computer, `ctx.ocr`); a scanned page's
// picture comes from pdf.js itself, already decoded, so no canvas is needed.

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, extname } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { KnowledgeDocKind } from "@redgiant/protocol";
import { strFromU8, unzipSync } from "fflate";
import { looksBinary } from "./files.js";
import type { ExtractContext, Extracted, ExtractedPart, ExtractOutcome } from "./types.js";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Most text kept from one document (a spreadsheet can unfold into far more). */
const MAX_CHARS = 5_000_000;

const CODE_EXT: Record<string, Lang> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  vue: "js",
  svelte: "js",
  py: "py",
  pyi: "py",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "java",
  kts: "java",
  scala: "java",
  cs: "java",
  swift: "java",
  dart: "java",
  groovy: "java",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  m: "c",
  mm: "c",
  php: "php",
  rb: "ruby",
  rake: "ruby",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  ps1: "ps",
  psm1: "ps",
  bat: "plain",
  cmd: "plain",
  sql: "sql",
  lua: "lua",
  pl: "plain",
  pm: "plain",
  r: "plain",
  jl: "plain",
  ex: "ruby",
  exs: "ruby",
  erl: "plain",
  hs: "plain",
  clj: "plain",
  el: "plain",
  zig: "rust",
  nim: "py",
  v: "go",
  css: "css",
  scss: "css",
  less: "css",
  json: "plain",
  jsonc: "plain",
  json5: "plain",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  xml: "plain",
  xsd: "plain",
  svg: "plain",
  gradle: "java",
  tf: "plain",
  hcl: "plain",
  proto: "java",
  graphql: "plain",
  gql: "plain",
  dockerfile: "plain",
  make: "plain",
  mk: "plain",
  cmake: "plain",
};
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx", "mdown", "mkd"]);
const TEXT_EXT = new Set([
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "rst",
  "adoc",
  "asciidoc",
  "org",
  "tex",
  "bib",
  "srt",
  "vtt",
  "nfo",
  "me",
  "1",
  "man",
  "diff",
  "patch",
  "env.example",
]);
const HTML_EXT = new Set(["html", "htm", "xhtml", "shtml"]);
const OFFICE_XML = new Set([
  "docx",
  "docm",
  "dotx",
  "pptx",
  "pptm",
  "ppsx",
  "potx",
  "xlsx",
  "xlsm",
  "xltx",
  "odt",
  "ott",
  "odp",
  "otp",
  "ods",
  "ots",
]);
const OFFICE_OLD = new Set([
  "doc",
  "dot",
  "rtf",
  "wpd",
  "ppt",
  "pps",
  "pot",
  "xls",
  "xlt",
  "pages",
  "key",
  "numbers",
  "odg",
  "vsdx",
  "pub",
]);
const SPREADSHEETS = new Set(["xlsx", "xlsm", "xltx", "ods", "ots"]);
/** Pictures Tesseract's own decoders read (the others are left out, said why). */
const OCR_EXT = new Set(["png", "jpg", "jpeg", "webp", "bmp", "pbm", "pgm", "ppm"]);
/** Scanned pages read by the OCR in one PDF, at most. */
const MAX_OCR_PAGES = 500;
/** Pictures larger than this are not given to the OCR (a poster, a photo of the sky). */
const MAX_OCR_BYTES = 30 * 1024 * 1024;
const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "heic",
  "heif",
  "avif",
]);
/** Never read: archives, programs, media, models, databases, fonts. */
const BINARY_EXT = new Set([
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "tar",
  "jar",
  "war",
  "apk",
  "dmg",
  "iso",
  "img",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "o",
  "a",
  "lib",
  "obj",
  "class",
  "pyc",
  "pyo",
  "wasm",
  "node",
  "mp3",
  "mp4",
  "m4a",
  "m4v",
  "mov",
  "avi",
  "mkv",
  "webm",
  "wav",
  "flac",
  "ogg",
  "opus",
  "aac",
  "caf",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "ico",
  "icns",
  "psd",
  "ai",
  "sketch",
  "fig",
  "blend",
  "fbx",
  "sqlite",
  "sqlite3",
  "db",
  "mdb",
  "gguf",
  "safetensors",
  "onnx",
  "pt",
  "pth",
  "ckpt",
  "npy",
  "npz",
  "parquet",
  "arrow",
  "pkl",
  "lock",
  "map",
]);
const NAMED_FILES: Record<string, KnowledgeDocKind> = {
  dockerfile: "code",
  makefile: "code",
  gemfile: "code",
  rakefile: "code",
  procfile: "code",
  jenkinsfile: "code",
  vagrantfile: "code",
  "cmakelists.txt": "code",
  readme: "text",
  license: "text",
  licence: "text",
  copying: "text",
  authors: "text",
  changelog: "text",
  contributing: "text",
  notice: "text",
  todo: "text",
};

type Lang =
  | "js"
  | "py"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "php"
  | "ruby"
  | "sh"
  | "ps"
  | "sql"
  | "lua"
  | "css"
  | "yaml"
  | "ini"
  | "plain";

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/** What kind of document a file name is, or undefined when only its bytes can tell. */
export function docKindOf(name: string): KnowledgeDocKind | "image" | undefined {
  const base = basename(name).toLowerCase();
  const ext = extOf(base);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (OFFICE_XML.has(ext) || OFFICE_OLD.has(ext)) return "office";
  if (HTML_EXT.has(ext)) return "html";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext in CODE_EXT) return "code";
  if (TEXT_EXT.has(ext)) return "text";
  const named = NAMED_FILES[base] ?? NAMED_FILES[base.replace(/\.(md|txt)$/, "")];
  if (named) return named;
  return undefined;
}

// ---- Text ----

/** Bytes as text: UTF-8 (with or without BOM), UTF-16 with BOM, else Windows-1252. */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    const swapped = new Uint8Array(body.length - (body.length % 2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1] as number;
      swapped[i + 1] = body[i] as number;
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // WHATWG "latin1" is Windows-1252: the usual encoding of old Western text files.
    return new TextDecoder("latin1").decode(buf);
  }
}

/** A run of lines as a part, without blank lines around it; lines are 0-based indexes. */
function linesPart(
  lines: string[],
  from: number,
  to: number,
  heading?: string,
): ExtractedPart | undefined {
  let a = from;
  let b = to - 1;
  while (a <= b && !(lines[a] as string).trim()) a++;
  while (b >= a && !(lines[b] as string).trim()) b--;
  if (a > b) return undefined;
  const p: ExtractedPart = {
    text: lines.slice(a, b + 1).join("\n"),
    lineStart: a + 1,
    lineEnd: b + 1,
  };
  if (heading) p.heading = heading;
  return p;
}

function paragraphs(
  lines: string[],
  from = 0,
  to = lines.length,
  heading?: string,
): ExtractedPart[] {
  const out: ExtractedPart[] = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i === to || !(lines[i] as string).trim()) {
      const p = linesPart(lines, start, i, heading);
      if (p) out.push(p);
      start = i + 1;
    }
  }
  return out;
}

/** Text, code or Markdown given as a string. */
export function extractText(name: string, text: string): Extracted {
  const kind = docKindOf(name);
  const clean = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const lines = clean.split("\n");
  const fallback = basename(name);
  if (kind === "markdown") return markdown(lines, fallback);
  if (kind === "code" || (kind === undefined && clean.startsWith("#!"))) {
    const lang =
      CODE_EXT[extOf(name)] ??
      (clean.startsWith("#!") ? langOfShebang(lines[0] as string) : "plain");
    return { kind: "code", title: fallback, parts: code(lines, lang) };
  }
  return { kind: "text", title: fallback, parts: paragraphs(lines) };
}

function langOfShebang(line: string): Lang {
  if (/python/.test(line)) return "py";
  if (/node|deno|bun/.test(line)) return "js";
  if (/ruby/.test(line)) return "ruby";
  return "sh";
}

// ---- Markdown ----

function markdown(lines: string[], fallback: string): Extracted {
  let title: string | undefined;
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^title\s*:\s*(.+?)\s*$/i.exec(l);
        if (m?.[1]) title = m[1].replace(/^["']|["']$/g, "");
      }
      start = end + 1;
    }
  }
  const parts: ExtractedPart[] = [];
  const stack: { level: number; text: string }[] = [];
  let sectionStart = start;
  let fence: string | undefined;
  /** The line before starts nothing: blank, a fence, a heading, or the start. */
  let fresh = true;
  const close = (end: number) => {
    const heading = stack.map((s) => s.text).join(" › ") || undefined;
    const p = linesPart(lines, sectionStart, end, heading);
    if (p) parts.push(p);
  };
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f?.[1]) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = undefined;
      fresh = !fence;
      continue;
    }
    if (fence) continue;
    const startsBlock = fresh;
    fresh = !line.trim();
    let level = 0;
    let text = "";
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx?.[1]) {
      level = atx[1].length;
      text = atx[2] ?? "";
    } else if (
      i + 1 < lines.length &&
      line.trim() &&
      /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1] as string) &&
      !/^\s{0,3}[-*+]\s/.test(line)
    ) {
      // Setext: `Title` over `===` or `---` (not a list item over a rule).
      if (startsBlock) {
        level = (lines[i + 1] as string).trim().startsWith("=") ? 1 : 2;
        text = line.trim();
      }
    }
    if (!level) continue;
    fresh = true;
    close(i);
    while (stack.length && (stack.at(-1) as { level: number }).level >= level) stack.pop();
    const plain = stripInline(text);
    stack.push({ level, text: plain });
    if (level === 1 && !title) title = plain;
    sectionStart = i;
  }
  close(lines.length);
  return { kind: "markdown", title: title || fallback, parts };
}

function stripInline(s: string): string {
  // Emphasis only as pairs around words: `snake_case` names keep their underscores.
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, "$1$3")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
}

// ---- Code ----

const CONTROL =
  /^(if|for|while|switch|catch|return|else|do|try|with|elif|except|foreach|using|lock|unless|until|case|when|match|loop|select|new|throw|await|yield|delete|typeof|sizeof)\b/;

const DECL: Record<Lang, RegExp | undefined> = {
  js: /^(export\s+(default\s+)?)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?\s|class\s|interface\s|type\s+\w|enum\s|namespace\s|module\s|const\s|let\s|var\s)/,
  py: /^(async\s+)?(def|class)\s+\w/,
  go: /^(func|type|var|const)\s/,
  rust: /^(pub(\([^)]*\))?\s+)?(async\s+)?(const\s+)?(unsafe\s+)?(extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|impl|mod|type|union|static|const|macro_rules!)[\s<]/,
  java: /^((public|private|protected|internal|static|final|abstract|sealed|open|data|override|partial|async|virtual|suspend|inline|export|default|synchronized|native|unsafe|extern|readonly|new|operator|infix|tailrec|external|lateinit|annotation|enum|value|inner|companion)\s+)*(class|interface|enum|record|struct|object|trait|fun|func|def|init|namespace|extension|protocol|actor)\b/,
  c: /^(struct|class|namespace|enum|union|typedef|template)\b/,
  php: /^((abstract|final|public|private|protected|static|readonly)\s+)*(class|interface|trait|enum|function)\s/,
  ruby: /^(def|class|module)\s/,
  sh: /^(function\s+[\w:-]+|[\w:-]+\s*\(\s*\)\s*\{?)/,
  ps: /^(function|filter|class|enum)\s/i,
  sql: /^(create|alter|drop|insert|update|delete|select|with|grant|revoke|comment|do|begin)\b/i,
  lua: /^(local\s+)?function\s/,
  css: /^[^\s{}/@][^{}]*\{\s*$|^@(media|supports|keyframes|layer|font-face|container)\b/,
  yaml: /^[\w"'.-][^:#]*:(\s|$)/,
  ini: /^\[[^\]]+\]/,
  plain: undefined,
};

/** A method or function inside a class or block: a name, arguments, and a body opening. */
const METHOD =
  /^((public|private|protected|internal|static|async|override|virtual|abstract|final|readonly|get|set|def|fun|func|function|fn|pub|suspend|inline|synchronized|unsafe|extern|const|constexpr|explicit|operator|\*)\s+)*[A-Za-z_$#~][\w$<>,.:[\]?*&\s]*\([^;]*$/;

/** Signature lines in C-like code at the top: `type name(args) {` without a semicolon. */
const C_FUNCTION =
  /^[A-Za-z_][\w\s*&:<>,~]*\b[\w:~]+\s*\([^;]*\)\s*(const\s*)?(noexcept\s*)?(override\s*)?\{?\s*$/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

const METHOD_LANGS = new Set<Lang>(["js", "java", "c", "php", "rust", "go", "ps"]);

function isDecl(line: string, lang: Lang, inner: boolean): boolean {
  const t = line.trim();
  if (!t || CONTROL.test(t)) return false;
  const re = DECL[lang];
  if (re?.test(t)) {
    // `const x = 1` inside a function body is not a symbol; only on the outermost level.
    if (lang === "js" && inner && /^(const|let|var)\s/.test(t)) return false;
    return true;
  }
  if (lang === "c" && !inner && C_FUNCTION.test(t)) return true;
  if (!inner || !METHOD_LANGS.has(lang)) return false;
  // A method inside a class or block: a name with arguments opening a body, never a call.
  if (!METHOD.test(t) || t.endsWith(";") || t.endsWith(",")) return false;
  if (/^(this|self|super|await|return|yield)\b/.test(t) || /^[\w$]+(\.[\w$]+)+\s*\(/.test(t))
    return false;
  if (/=\s*(function|\(|async)/.test(t)) return /\{\s*$|=>\s*\{?\s*$/.test(t);
  // JS bodies open on the same line; Java/C#/C++ may open on the next one.
  return lang === "js" || lang === "php" || lang === "rust" || lang === "go"
    ? /\{\s*$/.test(t)
    : /(\{|\)|=>)\s*$/.test(t) && /\s/.test(t.slice(0, t.indexOf("(")).trim());
}

function isAttached(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("#[") ||
    t.startsWith("@") ||
    t.startsWith("///") ||
    t.startsWith("--") ||
    t.startsWith("'''") ||
    t.startsWith('"""') ||
    (t.startsWith("#") && !t.startsWith("#include") && !t.startsWith("#!")) ||
    (t.startsWith("[") && t.endsWith("]") && !t.includes("="))
  );
}

function signature(line: string): string {
  let s = line
    .trim()
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*:\s*$/, "")
    .replace(/\s+/g, " ");
  if (s.length > 120) s = `${s.slice(0, 117)}…`;
  return s;
}

/** Above this a symbol is looked into for its methods. */
const SPLIT_SYMBOL = 2400;

function code(lines: string[], lang: Lang): ExtractedPart[] {
  if (!DECL[lang] && lang !== "plain") return paragraphs(lines);
  const out: ExtractedPart[] = [];
  symbols(lines, 0, lines.length, undefined, -1, lang, 0, out);
  return out.length ? out : paragraphs(lines);
}

function sizeOf(lines: string[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) n += (lines[i] as string).length + 1;
  return n;
}

/**
 * Cuts lines [from, to) at the declarations of one indentation level (the outermost found),
 * the comments and decorators above each one going with it; long symbols are cut again at the
 * level inside them (methods of a class), up to three levels.
 */
function symbols(
  lines: string[],
  from: number,
  to: number,
  prefix: string | undefined,
  containerIndent: number,
  lang: Lang,
  depth: number,
  out: ExtractedPart[],
): void {
  const inner = depth > 0;
  const firstLine = inner ? from + 1 : from;
  const candidates: number[] = [];
  let level = Number.POSITIVE_INFINITY;
  for (let i = firstLine; i < to; i++) {
    const l = lines[i] as string;
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind <= containerIndent) continue;
    if (isDecl(l, lang, inner)) {
      if (ind < level) {
        level = ind;
        candidates.length = 0;
      }
      if (ind === level) candidates.push(i);
    }
  }
  // Without declarations (or plain text): paragraphs, with the container's name.
  if (!candidates.length || !DECL[lang]) {
    if (inner) {
      const p = linesPart(lines, from, to, prefix);
      if (p) out.push(p);
    } else out.push(...paragraphs(lines, from, to, prefix));
    return;
  }
  // Move each boundary up over the comments and decorators that belong to it.
  const bounds = candidates.map((c, k) => {
    const floor = k === 0 ? firstLine : (candidates[k - 1] as number) + 1;
    let b = c;
    while (
      b - 1 >= floor &&
      (lines[b - 1] as string).trim() &&
      isAttached(lines[b - 1] as string) &&
      indentOf(lines[b - 1] as string) >= level
    )
      b--;
    return b;
  });
  const head = linesPart(lines, from, bounds[0] as number, prefix);
  if (head) out.push(head);
  for (let k = 0; k < bounds.length; k++) {
    const a = bounds[k] as number;
    const b = k + 1 < bounds.length ? (bounds[k + 1] as number) : to;
    const decl = candidates[k] as number;
    const name = signature(lines[decl] as string);
    const heading = prefix ? `${prefix} › ${name}` : name;
    if (sizeOf(lines, a, b) > SPLIT_SYMBOL && depth < 3) {
      // The comments above stay with the symbol's first piece.
      const before = linesPart(lines, a, decl, heading);
      const sub: ExtractedPart[] = [];
      symbols(lines, decl, b, heading, indentOf(lines[decl] as string), lang, depth + 1, sub);
      if (before && sub[0] && sub[0].lineStart === decl + 1) {
        sub[0] = {
          ...sub[0],
          text: `${before.text}\n${sub[0].text}`,
          lineStart: before.lineStart as number,
        };
      } else if (before) out.push(before);
      out.push(...sub);
      continue;
    }
    const p = linesPart(lines, a, b, heading);
    if (p) out.push(p);
  }
}

// ---- HTML ----

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  agrave: "à",
  egrave: "è",
  eacute: "é",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
  Agrave: "À",
  Egrave: "È",
  Eacute: "É",
  ccedil: "ç",
  times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

const DROP =
  /<(script|style|noscript|template|svg|iframe|object|canvas|select|button|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const CHROME = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const MARK = "\u0000H";

function innerOf(html: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  let best: string | undefined;
  for (let m = re.exec(html); m; m = re.exec(html))
    if (!best || (m[1] ?? "").length > best.length) best = m[1];
  return best;
}

/** A web page or HTML file without menus, scripts and forms, by its headings. */
export function extractHtml(html: string, url?: string): Extracted {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  let body = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP, " ");
  // The main content when the page marks it; otherwise the body without its chrome.
  const main = innerOf(body, "main") ?? innerOf(body, "article");
  if (main && main.replace(/<[^>]+>/g, "").trim().length > 200)
    body = main.replace(/<(nav|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  else body = (innerOf(body, "body") ?? body).replace(CHROME, " ");
  body = body
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_m, n: string, t: string) =>
        `\n${MARK}${n}\u0000${t
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()}\n`,
    )
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(
      /<\/(p|div|li|tr|section|article|pre|blockquote|dd|dt|table|ul|ol|figure|figcaption|h[1-6])\s*>|<br\s*\/?>/gi,
      "\n",
    )
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(body)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const parts: ExtractedPart[] = [];
  const stack: { level: number; text: string }[] = [];
  let buf: string[] = [];
  let firstH1: string | undefined;
  const flush = () => {
    const t = buf.join("\n").trim();
    buf = [];
    if (!t) return;
    const heading = stack.map((s) => s.text).join(" › ");
    parts.push(heading ? { text: t, heading } : { text: t });
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(MARK)) {
      flush();
      const level = Number(line[2]);
      const h = decodeEntities(line.slice(4)).trim();
      while (stack.length && (stack.at(-1) as { level: number }).level >= level) stack.pop();
      if (h) {
        stack.push({ level, text: h });
        buf.push(h);
        if (level === 1 && !firstH1) firstH1 = h;
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  const title =
    decodeEntities((titleTag ?? "").replace(/\s+/g, " ").trim()) || firstH1 || url || "page";
  return { kind: url ? "web" : "html", title, parts };
}

// ---- PDF ----

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsLoaded: Promise<{ lib: PdfJs; dir: string }> | undefined;

function pdfjs(): Promise<{ lib: PdfJs; dir: string }> {
  pdfjsLoaded ??= (async () => {
    const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const req = createRequire(import.meta.url);
    const dir = req.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");
    return { lib, dir };
  })();
  return pdfjsLoaded;
}

interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform: number[];
  width: number;
  height: number;
}

/** One page's text with its lines back: pdf.js gives runs with their positions. */
function pageText(items: TextItemLike[]): string {
  let out = "";
  let lastY: number | undefined;
  let lastEnd = 0;
  let lastH = 10;
  for (const it of items) {
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const h = Math.abs(it.height) || lastH;
    if (lastY !== undefined && it.str) {
      const dy = Math.abs(y - lastY);
      if (dy > Math.max(2, h * 0.5)) {
        if (!out.endsWith("\n")) out += "\n";
        if (dy > h * 1.9) out += "\n";
      } else if (
        !out.endsWith("\n") &&
        x - lastEnd > h * 0.15 &&
        !out.endsWith(" ") &&
        !it.str.startsWith(" ")
      )
        out += " ";
    }
    out += it.str;
    if (it.str) {
      lastY = y;
      lastEnd = x + it.width;
      lastH = h;
    }
    if (it.hasEOL) out += "\n";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One page of a PDF (G36.12, canvas_look): its text, its size in points, how many pages. */
export async function pdfPage(
  data: Uint8Array,
  n: number,
): Promise<{ pages: number; page: number; width: number; height: number; text: string }> {
  const { lib, dir } = await pdfjs();
  const task = lib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    cMapUrl: `${dir}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${dir}standard_fonts/`,
  });
  try {
    const doc = await task.promise;
    const page = Math.max(1, Math.min(doc.numPages, Math.floor(n) || 1));
    const p = await doc.getPage(page);
    const vp = p.getViewport({ scale: 1 });
    const content = await p.getTextContent();
    const text = pageText(content.items.filter((i) => "str" in i) as unknown as TextItemLike[]);
    return { pages: doc.numPages, page, width: vp.width, height: vp.height, text };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** A PDF's text page by page. */
export async function extractPdfData(
  data: Uint8Array,
  fallbackTitle: string,
  signal?: AbortSignal,
  ocr?: ExtractContext["ocr"],
): Promise<ExtractOutcome> {
  const { lib, dir } = await pdfjs();
  const task = lib.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    // Pictures decoded by pdf.js into plain pixels (what the OCR is given), never a canvas.
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    cMapUrl: `${dir}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${dir}standard_fonts/`,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") return { ok: false, skipped: "encrypted" };
    return { ok: false, skipped: "unsupported", message: (err as Error).message };
  }
  try {
    const meta = await doc.getMetadata().catch(() => undefined);
    const info = (meta?.info ?? {}) as { Title?: unknown };
    const title =
      typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : fallbackTitle;
    const parts: ExtractedPart[] = [];
    let chars = 0;
    let scanned = 0;
    let read = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = pageText(content.items.filter((i) => "str" in i) as unknown as TextItemLike[]);
      // A page with (almost) no text is a scan: its biggest picture goes to the OCR.
      if (text.length < 20 && ocr && read < MAX_OCR_PAGES) {
        const png = await pagePicture(lib, page);
        if (png) {
          scanned++;
          read++;
          const seen = (await ocr(png, signal)).trim();
          if (seen.length > text.length) text = seen;
        }
      }
      page.cleanup();
      if (!text) continue;
      chars += text.length;
      if (chars > MAX_CHARS) break;
      parts.push({ text, page: n });
    }
    if (chars < Math.min(20, doc.numPages * 5) || !parts.length)
      return { ok: false, skipped: ocr ? "empty" : "needs_ocr" };
    return {
      ok: true,
      doc: {
        kind: "pdf",
        title,
        pages: doc.numPages,
        parts,
        ...(scanned > 0 && { note: `ocr:${scanned}` }),
      },
    };
  } finally {
    // pdf.js 6: the loading task ends the document and its worker.
    await task.destroy().catch(() => {});
  }
}

/**
 * The biggest picture painted on a page, as a PNG (pdf.js decodes JPEG, JBIG2, CCITT and Flate
 * into pixels itself). Undefined when the page has no picture: vector-only pages would need a
 * canvas to draw them, which RedGiant does not ship (a native module on every system).
 */
async function pagePicture(
  lib: PdfJs,
  page: Awaited<ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>>,
): Promise<Uint8Array | undefined> {
  const ops = await page.getOperatorList();
  let best: { name: string; area: number } | undefined;
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== lib.OPS.paintImageXObject) continue;
    const args = ops.argsArray[i] as [string, number, number];
    const area = (args[1] ?? 0) * (args[2] ?? 0);
    if (typeof args[0] === "string" && (!best || area > best.area)) best = { name: args[0], area };
  }
  if (!best) return undefined;
  const name = best.name;
  const objs = name.startsWith("g_") ? page.commonObjs : page.objs;
  const img = await new Promise<PdfImage | undefined>((done) => {
    const t = setTimeout(() => done(undefined), 10_000);
    try {
      objs.get(name, (v: unknown) => {
        clearTimeout(t);
        done(v as PdfImage);
      });
    } catch {
      clearTimeout(t);
      done(undefined);
    }
  });
  if (!img?.data || !img.width || !img.height) return undefined;
  return pngOf(img);
}

interface PdfImage {
  width: number;
  height: number;
  /** pdf.js ImageKind: 1 one bit per pixel (set = white), 2 RGB, 3 RGBA. */
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Pixels as a PNG (no filter, deflated): what Tesseract reads. */
export function pngOf(img: PdfImage): Uint8Array {
  const { width: w, height: h } = img;
  const channels = img.kind === 3 ? 4 : img.kind === 2 ? 3 : 1;
  const row = w * channels;
  const raw = Buffer.alloc((row + 1) * h);
  if (img.kind === 1) {
    const stride = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bit = (img.data[y * stride + (x >> 3)] ?? 0) & (128 >> (x & 7));
        raw[y * (row + 1) + 1 + x] = bit ? 255 : 0;
      }
  } else
    for (let y = 0; y < h; y++)
      raw.set(img.data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const chunk = (type: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// ---- Office and OpenDocument ----

interface Tag {
  close: boolean;
  self: boolean;
  name: string;
  attrs: string;
}

/** Tags and text of an XML document in order (enough for Office's well-formed XML). */
function* xmlTokens(xml: string): Generator<Tag | string> {
  const re =
    /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[2]) yield { close: m[1] === "/", self: m[4] === "/", name: m[2], attrs: m[3] ?? "" };
    else if (m[5] !== undefined) yield m[5];
    else if (m[6] !== undefined) yield decodeEntities(m[6]);
  }
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(
    `(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`,
  ).exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined;
}

function unzip(buf: Uint8Array, want: (name: string) => boolean): Record<string, string> {
  const files = unzipSync(buf, { filter: (f) => want(f.name) });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k] = strFromU8(v);
  return out;
}

/** Paragraphs with their outline level (0 = body) and page, from Word or Writer. */
interface Para {
  text: string;
  level: number;
  page?: number;
}

/** Paragraphs grouped by heading into parts, split where the page changes. */
function sectionsOf(paras: Para[]): ExtractedPart[] {
  const parts: ExtractedPart[] = [];
  const stack: { level: number; text: string }[] = [];
  let buf: string[] = [];
  let page: number | undefined;
  const flush = () => {
    const t = buf.join("\n").trim();
    buf = [];
    if (!t) return;
    const p: ExtractedPart = { text: t };
    const heading = stack.map((s) => s.text).join(" › ");
    if (heading) p.heading = heading;
    if (page !== undefined) p.page = page;
    parts.push(p);
  };
  for (const para of paras) {
    if (para.page !== page) {
      flush();
      page = para.page;
    }
    if (para.level > 0 && para.text.trim()) {
      flush();
      while (stack.length && (stack.at(-1) as { level: number }).level >= para.level) stack.pop();
      stack.push({ level: para.level, text: para.text.trim() });
    }
    buf.push(para.text);
  }
  flush();
  return parts;
}

function docxParas(
  docXml: string,
  stylesXml: string | undefined,
): { paras: Para[]; breaks: boolean } {
  // Heading levels by style id, from the style names Word writes in English ("heading 1").
  const levels = new Map<string, number>();
  if (stylesXml) {
    for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
      const id = attr(m[1] ?? "", "w:styleId");
      const name = /<w:name\s+w:val="([^"]*)"/.exec(m[2] ?? "")?.[1]?.toLowerCase();
      const outline = /<w:outlineLvl\s+w:val="(\d)"/.exec(m[2] ?? "")?.[1];
      if (!id) continue;
      const h = name ? /^heading\s*(\d)$/.exec(name)?.[1] : undefined;
      if (h) levels.set(id, Number(h));
      else if (name === "title") levels.set(id, 1);
      else if (outline !== undefined) levels.set(id, Number(outline) + 1);
    }
  }
  const paras: Para[] = [];
  let page = 1;
  let breaks = false;
  let text = "";
  let level = 0;
  let inText = false;
  let pendingBreak = false;
  let tableDepth = 0;
  let cells: string[] = [];
  let cell: string[] = [];
  const pushPara = (t: string, lvl: number) => paras.push({ text: t, level: lvl, page });
  for (const tok of xmlTokens(docXml)) {
    if (typeof tok === "string") {
      if (inText) text += tok;
      continue;
    }
    const { name, close, self, attrs } = tok;
    if (name === "w:t" || name === "w:delText") {
      inText = !close && !self && name === "w:t";
      continue;
    }
    if (name === "w:tab" && !close) text += "\t";
    else if (name === "w:br" && !close) {
      if (attr(attrs, "w:type") === "page") {
        breaks = true;
        if (text.trim()) pendingBreak = true;
        else page++;
      } else text += "\n";
    } else if (name === "w:lastRenderedPageBreak") {
      breaks = true;
      if (text.trim()) pendingBreak = true;
      else page++;
    } else if (name === "w:pStyle" && !close) {
      level = levels.get(attr(attrs, "w:val") ?? "") ?? level;
    } else if (name === "w:outlineLvl" && !close) {
      const v = Number(attr(attrs, "w:val"));
      if (Number.isFinite(v) && v < 9) level = v + 1;
    } else if (name === "w:tbl") {
      tableDepth += close ? -1 : 1;
    } else if (name === "w:tc" && close && tableDepth > 0) {
      cells.push(cell.join(" ").trim());
      cell = [];
    } else if (name === "w:tr" && close && tableDepth > 0) {
      const row = cells.join(" | ").trim();
      if (row.replace(/[|\s]/g, "")) pushPara(row, 0);
      cells = [];
    } else if (name === "w:p") {
      if (!close && !self) {
        text = "";
        level = 0;
      } else {
        if (tableDepth > 0) cell.push(text.trim());
        else pushPara(text, text.trim() ? level : 0);
        text = "";
        level = 0;
        if (pendingBreak) {
          page++;
          pendingBreak = false;
        }
      }
    }
  }
  return { paras, breaks };
}

function odfParas(xml: string): { paras: Para[]; breaks: boolean } {
  const paras: Para[] = [];
  let page = 1;
  let breaks = false;
  let depth = 0;
  let text = "";
  let level = 0;
  let tableDepth = 0;
  let cells: string[] = [];
  let cell: string[] = [];
  let inNote = 0;
  for (const tok of xmlTokens(xml)) {
    if (typeof tok === "string") {
      if (depth > 0 && !inNote) text += tok;
      continue;
    }
    const { name, close, self, attrs } = tok;
    if (name === "text:note-citation" || name === "office:annotation") {
      if (!self) inNote += close ? -1 : 1;
      continue;
    }
    if (name === "text:soft-page-break") {
      breaks = true;
      page++;
    } else if (name === "text:s" && depth > 0)
      text += " ".repeat(Math.min(100, Number(attr(attrs, "text:c") ?? 1) || 1));
    else if ((name === "text:tab" || name === "text:line-break") && depth > 0)
      text += name === "text:tab" ? "\t" : "\n";
    else if (name === "table:table") tableDepth += close ? -1 : self ? 0 : 1;
    else if (name === "table:table-cell" && close && tableDepth > 0) {
      cells.push(cell.join(" ").trim());
      cell = [];
    } else if (name === "table:table-row" && close && tableDepth > 0) {
      const row = cells.join(" | ").trim();
      if (row.replace(/[|\s]/g, "")) paras.push({ text: row, level: 0, page });
      cells = [];
    } else if (name === "text:p" || name === "text:h") {
      if (self) continue;
      if (!close) {
        if (depth === 0) {
          text = "";
          level = name === "text:h" ? Number(attr(attrs, "text:outline-level") ?? 1) || 1 : 0;
        }
        depth++;
      } else {
        depth = Math.max(0, depth - 1);
        if (depth === 0) {
          if (tableDepth > 0) cell.push(text.trim());
          else paras.push({ text, level: text.trim() ? level : 0, page });
          text = "";
        }
      }
    }
  }
  return { paras, breaks };
}

function relsMap(xml: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1] ?? "", "Id");
    const target = attr(m[1] ?? "", "Target");
    if (id && target) out.set(id, target);
  }
  return out;
}

function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${baseDir}/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

/** The text runs of a DrawingML shape tree, paragraph by paragraph. */
function drawingText(xml: string): { title?: string; text: string } {
  let title: string | undefined;
  const paras: string[] = [];
  for (const sp of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
    const shape = sp[0];
    const isTitle = /<p:ph\b[^>]*type="(title|ctrTitle)"/.test(shape);
    const lines: string[] = [];
    for (const p of shape.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const t = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)]
        .map((m) => (m[0].startsWith("<a:br") ? "\n" : decodeEntities(m[1] ?? "")))
        .join("");
      if (t.trim()) lines.push(t);
    }
    if (isTitle && !title && lines.length) title = lines.join(" ").trim();
    paras.push(...lines);
  }
  // Tables in graphic frames.
  for (const tbl of xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)) {
    for (const tr of tbl[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)) {
      const cells = [...tr[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((tc) =>
        [...tc[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((m) => decodeEntities(m[1] ?? ""))
          .join(" ")
          .trim(),
      );
      if (cells.some(Boolean)) paras.push(cells.join(" | "));
    }
  }
  return title ? { title, text: paras.join("\n") } : { text: paras.join("\n") };
}

function pptx(files: Record<string, string>): ExtractedPart[] {
  const rels = relsMap(files["ppt/_rels/presentation.xml.rels"]);
  const order = [...(files["ppt/presentation.xml"] ?? "").matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((m) => rels.get(attr(m[1] ?? "", "r:id") ?? ""))
    .filter((t): t is string => !!t)
    .map((t) => resolveTarget("ppt", t));
  const slides = order.length
    ? order
    : Object.keys(files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  const parts: ExtractedPart[] = [];
  slides.forEach((path, i) => {
    const xml = files[path];
    if (!xml) return;
    const { title, text } = drawingText(xml);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const name = path.slice(path.lastIndexOf("/") + 1);
    const srels = relsMap(files[`${dir}/_rels/${name}.rels`]);
    let notes = "";
    for (const target of srels.values()) {
      if (!/notesSlide/.test(target)) continue;
      const n = files[resolveTarget(dir, target)];
      if (n)
        notes = drawingText(n)
          .text.replace(/^\s*\d+\s*$/gm, "")
          .trim();
    }
    const body = [text.trim(), notes ? `Notes: ${notes}` : ""].filter(Boolean).join("\n\n");
    if (!body) return;
    parts.push({ text: body, page: i + 1, heading: title ?? `Slide ${i + 1}` });
  });
  return parts;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Each sheet as rows of tab-separated cells; `lineStart`/`lineEnd` are row numbers. */
function xlsx(files: Record<string, string>): ExtractedPart[] {
  const shared: string[] = [];
  for (const si of (files["xl/sharedStrings.xml"] ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(
      [...(si[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((m) => decodeEntities(m[1] ?? ""))
        .join(""),
    );
  }
  const rels = relsMap(files["xl/_rels/workbook.xml.rels"]);
  const parts: ExtractedPart[] = [];
  let chars = 0;
  for (const m of (files["xl/workbook.xml"] ?? "").matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1] ?? "", "name") ?? "Sheet";
    const target = rels.get(attr(m[1] ?? "", "r:id") ?? "");
    const xml = target ? files[resolveTarget("xl", target)] : undefined;
    if (!xml) continue;
    const lines: string[] = [];
    let first: number | undefined;
    let last = 0;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(attr(row[1] ?? "", "r") ?? last + 1);
      const cells: string[] = [];
      for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1] ?? "";
        const inner = c[2] ?? "";
        const type = attr(a, "t");
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value: string;
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr")
          value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map((x) => decodeEntities(x[1] ?? ""))
            .join("");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else value = decodeEntities(v ?? "");
        if (!value) continue;
        const col = columnIndex(attr(a, "r") ?? "");
        while (cells.length < col && cells.length < 1000) cells.push("");
        cells[Math.min(col, 1000)] = value.replace(/[\t\n]+/g, " ");
      }
      if (!cells.some(Boolean)) continue;
      // Rows keep their place: empty rows in between stay as empty lines.
      if (first === undefined) first = r;
      while (first + lines.length < r) lines.push("");
      lines.push(cells.join("\t"));
      last = r;
      chars += lines.at(-1)?.length ?? 0;
      if (chars > MAX_CHARS) break;
    }
    if (first !== undefined && lines.length)
      parts.push({
        text: lines.join("\n"),
        heading: name,
        lineStart: first,
        lineEnd: first + lines.length - 1,
      });
    if (chars > MAX_CHARS) break;
  }
  return parts;
}

function ods(xml: string): ExtractedPart[] {
  const parts: ExtractedPart[] = [];
  for (const t of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    const name = attr(t[1] ?? "", "table:name") ?? "Sheet";
    const lines: string[] = [];
    let rowNo = 0;
    let first: number | undefined;
    for (const row of (t[2] ?? "").matchAll(
      /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g,
    )) {
      const repeat = Math.min(
        Number(attr(row[1] ?? "", "table:number-rows-repeated") ?? 1) || 1,
        100000,
      );
      const cells: string[] = [];
      for (const c of (row[2] ?? "").matchAll(
        /<table:(?:table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:table-cell|covered-table-cell)>)/g,
      )) {
        const n = Math.min(
          Number(attr(c[1] ?? "", "table:number-columns-repeated") ?? 1) || 1,
          1000,
        );
        const value = [...(c[2] ?? "").matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
          .map((p) =>
            decodeEntities((p[1] ?? "").replace(/<text:s\b[^>]*\/>/g, " ").replace(/<[^>]+>/g, "")),
          )
          .join(" ")
          .trim();
        for (let k = 0; k < n && cells.length < 1000; k++) cells.push(value);
      }
      while (cells.length && !cells.at(-1)) cells.pop();
      const has = cells.some(Boolean);
      for (let k = 0; k < repeat; k++) {
        rowNo++;
        if (!has) continue;
        if (first === undefined) first = rowNo;
        while (first + lines.length < rowNo) lines.push("");
        lines.push(cells.join("\t"));
      }
    }
    if (first !== undefined)
      parts.push({
        text: lines.join("\n"),
        heading: name,
        lineStart: first,
        lineEnd: first + lines.length - 1,
      });
  }
  return parts;
}

function odp(xml: string): ExtractedPart[] {
  const parts: ExtractedPart[] = [];
  let n = 0;
  for (const page of xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g)) {
    n++;
    const body = page[2] ?? "";
    let title: string | undefined;
    const lines: string[] = [];
    for (const frame of body.matchAll(/<draw:frame\b([^>]*)>([\s\S]*?)<\/draw:frame>/g)) {
      const isTitle = /presentation:class="title"/.test(frame[1] ?? "");
      const t = odfParas(frame[2] ?? "")
        .paras.map((p) => p.text)
        .filter((s) => s.trim());
      if (isTitle && t.length && !title) title = t.join(" ").trim();
      lines.push(...t);
    }
    const notes = /<presentation:notes\b[\s\S]*?<\/presentation:notes>/.exec(body)?.[0];
    const noteText = notes
      ? odfParas(notes)
          .paras.map((p) => p.text)
          .filter((s) => s.trim())
          .join("\n")
      : "";
    const text = [
      lines.filter((l) => !notes || !noteText.includes(l)).join("\n"),
      noteText ? `Notes: ${noteText}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (text.trim())
      parts.push({
        text,
        page: n,
        heading: title ?? attr(page[1] ?? "", "draw:name") ?? `Slide ${n}`,
      });
  }
  return parts;
}

function officeTitle(files: Record<string, string>): string | undefined {
  const core = files["docProps/core.xml"] ?? files["meta.xml"];
  const t = core ? /<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] : undefined;
  return t ? decodeEntities(t).trim() || undefined : undefined;
}

/** An Office or OpenDocument file read straight from its XML (no LibreOffice). */
export function extractOfficeXml(buf: Uint8Array, name: string): ExtractOutcome {
  const ext = extOf(name);
  const fallback = basename(name);
  let files: Record<string, string>;
  try {
    files = unzip(
      buf,
      (f) => /\.(xml|rels)$/.test(f) && !f.startsWith("customXml/") && !/media\//.test(f),
    );
  } catch {
    // An encrypted OOXML file is an OLE container, not a zip.
    if (buf[0] === 0xd0 && buf[1] === 0xcf) return { ok: false, skipped: "encrypted" };
    return { ok: false, skipped: "unsupported", message: "not a valid Office file" };
  }
  const title = officeTitle(files) || fallback;
  let parts: ExtractedPart[] = [];
  let note: string | undefined;
  let pages: number | undefined;
  if (ext.startsWith("doc") || ext === "dotx") {
    const docXml = files["word/document.xml"];
    if (!docXml) return { ok: false, skipped: "unsupported", message: "no word/document.xml" };
    const { paras, breaks } = docxParas(docXml, files["word/styles.xml"]);
    parts = sectionsOf(breaks ? paras : paras.map(({ page: _p, ...p }) => p));
    if (breaks) {
      pages = Math.max(...paras.map((p) => p.page ?? 1));
      note = "pages estimated from the document's last layout (LibreOffice not available)";
    } else note = "no page numbers (LibreOffice not available)";
  } else if (ext.startsWith("pp") || ext === "potx") {
    parts = pptx(files);
    pages = parts.length ? Math.max(...parts.map((p) => p.page ?? 0)) : undefined;
  } else if (ext.startsWith("xl")) {
    parts = xlsx(files);
  } else if (ext === "odt" || ext === "ott") {
    const { paras, breaks } = odfParas(files["content.xml"] ?? "");
    parts = sectionsOf(breaks ? paras : paras.map(({ page: _p, ...p }) => p));
    if (breaks) {
      pages = Math.max(...paras.map((p) => p.page ?? 1));
      note = "pages estimated from the document's last layout (LibreOffice not available)";
    } else note = "no page numbers (LibreOffice not available)";
  } else if (ext === "odp" || ext === "otp") {
    parts = odp(files["content.xml"] ?? "");
    pages = parts.length ? Math.max(...parts.map((p) => p.page ?? 0)) : undefined;
  } else if (ext === "ods" || ext === "ots") {
    parts = ods(files["content.xml"] ?? "");
  } else return { ok: false, skipped: "unsupported" };
  parts = parts.filter((p) => p.text.trim());
  if (!parts.length) return { ok: false, skipped: "empty" };
  const doc: Extracted = { kind: "office", title, parts };
  if (pages) doc.pages = pages;
  if (note) doc.note = note;
  return { ok: true, doc };
}

// ---- Files ----

/** Reads one file into its parts, or says why it was left out. */
export async function extractFile(abs: string, ctx: ExtractContext = {}): Promise<ExtractOutcome> {
  const name = basename(abs);
  const ext = extOf(name);
  const s = await stat(abs);
  if (!s.isFile()) return { ok: false, skipped: "unsupported", message: "not a file" };
  if (s.size === 0) return { ok: false, skipped: "empty" };
  const max = ctx.maxBytes ?? MAX_BYTES;
  const kind = docKindOf(name);
  if (kind === "image") {
    if (!OCR_EXT.has(ext))
      return { ok: false, skipped: "unsupported", message: "a picture format the OCR cannot read" };
    if (!ctx.ocr) return { ok: false, skipped: "needs_ocr" };
    if (s.size > MAX_OCR_BYTES) return { ok: false, skipped: "too_big" };
    const seen = (await ctx.ocr(new Uint8Array(await readFile(abs)), ctx.signal)).trim();
    if (!seen) return { ok: false, skipped: "empty" };
    // One part, no lines: a picture opens whole.
    return {
      ok: true,
      doc: { kind: "image", title: name, parts: [{ text: seen }], note: "ocr:1" },
    };
  }
  if (BINARY_EXT.has(ext)) return { ok: false, skipped: "binary" };
  if (s.size > max) return { ok: false, skipped: "too_big" };
  if (kind === "pdf") {
    return extractPdfData(new Uint8Array(await readFile(abs)), name, ctx.signal, ctx.ocr);
  }
  if (kind === "office") {
    const spreadsheet = SPREADSHEETS.has(ext);
    // Through LibreOffice's PDF when it is here (pages as the Canvas shows them); spreadsheets
    // read better as rows than as printed pages.
    if (!spreadsheet && ctx.officePdf) {
      const pdf = await ctx.officePdf(abs, ctx.signal).catch(() => undefined);
      if (pdf) {
        const r = await extractPdfData(new Uint8Array(await readFile(pdf)), name, ctx.signal);
        if (r.ok) {
          r.doc.kind = "office";
          if (OFFICE_XML.has(ext)) {
            const title = officeTitle(unzipSafe(await readFile(abs)));
            r.doc.title =
              title ||
              (r.doc.title === name || /^untitled/i.test(r.doc.title) ? name : r.doc.title);
          } else if (/^untitled/i.test(r.doc.title)) r.doc.title = name;
          return r;
        }
      }
    }
    if (OFFICE_XML.has(ext)) return extractOfficeXml(new Uint8Array(await readFile(abs)), name);
    if (ctx.officePdf && SPREADSHEETS.has(ext)) return { ok: false, skipped: "unsupported" };
    if (ctx.officePdf) {
      const pdf = await ctx.officePdf(abs, ctx.signal).catch(() => undefined);
      if (pdf) {
        const r = await extractPdfData(new Uint8Array(await readFile(pdf)), name, ctx.signal);
        if (r.ok) r.doc.kind = "office";
        return r;
      }
    }
    return { ok: false, skipped: "needs_libreoffice" };
  }
  if (s.size > Math.min(max, MAX_TEXT_BYTES)) return { ok: false, skipped: "too_big" };
  const buf = new Uint8Array(await readFile(abs));
  if (looksBinary(buf)) return { ok: false, skipped: "binary" };
  const text = decodeText(buf);
  if (!text.trim()) return { ok: false, skipped: "empty" };
  const doc = kind === "html" ? extractHtml(text) : extractText(name, text);
  if (!doc.parts.length) return { ok: false, skipped: "empty" };
  return { ok: true, doc };
}

function unzipSafe(buf: Uint8Array): Record<string, string> {
  try {
    return unzip(buf, (f) => f === "docProps/core.xml" || f === "meta.xml");
  } catch {
    return {};
  }
}
