// Artifacts and widgets (3.5.9, study_artifacts.md §4-5): one engine, two forms. An artifact is a
// file `artefatti/<name>.html` (or any HTML with a `redgiant-artifact` header) shown in the canvas; a
// widget is a ```widget block in an agent's answer, shown in the chat. Both run in the same frame:
// a signed `/preview/<token>/`, a sandbox with scripts and forms only (an opaque origin), a policy
// with no network at all, and libraries served from RedGiant itself under the preview's `lib/`.
// The server puts a small runtime of ours at the top of the page (errors, height, theme, «send to
// chat») and an import map for the libraries; JSX is compiled here, when the file changes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_DIR,
  ARTIFACT_ERRORS_MAX,
  ARTIFACT_SANDBOX,
  type ArtifactError,
  type ArtifactHeader,
  type ArtifactLib,
  artifactHeaderOf,
  isArtifactPath,
} from "@redgiant/protocol";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- the libraries ---------------------------------------------------------------------------

/** One entry of a library's bundle: the file it becomes and the module it stands for. */
interface Entry {
  /** The file under the library's folder, without `.js`. */
  out: string;
  /** The bare names a page imports it by. */
  specifiers: string[];
  /** The npm module bundled. */
  module: string;
  /** CommonJS: its names are listed (read from the module in Node), ES modules re-export. */
  cjs?: boolean;
  /** Its default export too. */
  withDefault?: boolean;
}

interface Family {
  lib: ArtifactLib;
  /** The npm package that gives the version. */
  pkg: string;
  entries: Entry[];
  /** Files served as they are from the package (ES modules that import bare names we map). */
  raw?: { dir: string; specifier: string; ext: RegExp };
  /** Only with the header asking for it (heavy). */
  onDemand?: boolean;
}

const FAMILIES: Family[] = [
  {
    lib: "react",
    pkg: "react",
    entries: [
      { out: "react", specifiers: ["react"], module: "react", cjs: true, withDefault: true },
      {
        out: "react-dom",
        specifiers: ["react-dom"],
        module: "react-dom",
        cjs: true,
        withDefault: true,
      },
      {
        out: "react-dom-client",
        specifiers: ["react-dom/client"],
        module: "react-dom/client",
        cjs: true,
        withDefault: true,
      },
      {
        out: "jsx-runtime",
        specifiers: ["react/jsx-runtime", "react/jsx-dev-runtime"],
        module: "react/jsx-runtime",
        cjs: true,
      },
    ],
  },
  {
    lib: "preact",
    pkg: "preact",
    entries: [
      { out: "preact", specifiers: ["preact"], module: "preact" },
      { out: "hooks", specifiers: ["preact/hooks"], module: "preact/hooks" },
      {
        out: "jsx-runtime",
        specifiers: ["preact/jsx-runtime", "preact/jsx-dev-runtime"],
        module: "preact/jsx-runtime",
      },
    ],
  },
  { lib: "d3", pkg: "d3", entries: [{ out: "d3", specifiers: ["d3"], module: "d3" }] },
  {
    lib: "chartjs",
    pkg: "chart.js",
    entries: [
      { out: "chart", specifiers: ["chart.js"], module: "chart.js" },
      {
        out: "auto",
        specifiers: ["chart.js/auto"],
        module: "chart.js/auto",
        withDefault: true,
      },
    ],
  },
  {
    lib: "three",
    pkg: "three",
    entries: [{ out: "three", specifiers: ["three"], module: "three" }],
    raw: { dir: "examples/jsm", specifier: "three/addons/", ext: /\.js$/ },
  },
  {
    lib: "papaparse",
    pkg: "papaparse",
    entries: [
      {
        out: "papaparse",
        specifiers: ["papaparse"],
        module: "papaparse",
        cjs: true,
        withDefault: true,
      },
    ],
  },
  { lib: "sheetjs", pkg: "xlsx", entries: [{ out: "xlsx", specifiers: ["xlsx"], module: "xlsx" }] },
  {
    lib: "lucide",
    pkg: "lucide",
    entries: [{ out: "lucide", specifiers: ["lucide"], module: "lucide" }],
  },
  {
    lib: "mermaid",
    pkg: "mermaid",
    entries: [],
    raw: { dir: "dist", specifier: "mermaid", ext: /\.mjs$/ },
    onDemand: true,
  },
  {
    lib: "marked",
    pkg: "marked",
    entries: [{ out: "marked", specifiers: ["marked"], module: "marked" }],
  },
];

/** The folder of an installed package (its exports may hide `package.json`). */
function packageDir(name: string): string | undefined {
  let d: string;
  try {
    d = dirname(require.resolve(name));
  } catch {
    return undefined;
  }
  for (;;) {
    const p = join(d, "package.json");
    if (existsSync(p))
      try {
        if ((JSON.parse(readFileSync(p, "utf8")) as { name?: string }).name === name) return d;
      } catch {}
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

const versions = new Map<string, string>();
function versionOf(pkg: string): string {
  let v = versions.get(pkg);
  if (v === undefined) {
    const d = packageDir(pkg);
    v = d
      ? ((JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { version: string })
          .version ?? "0")
      : "0";
    versions.set(pkg, v);
  }
  return v;
}

/** A library's folder under `lib/`: its name and version, fixed (`react-19.3.1`). */
export const libFolder = (f: Family) => `${f.lib}-${versionOf(f.pkg)}`;

/** The import map of a page: every library's bare names, under the preview's `lib/`. */
export function importMap(
  prefix: string,
  libs: readonly ArtifactLib[] = [],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of FAMILIES) {
    if (f.onDemand && !libs.includes(f.lib)) continue;
    const base = `${prefix}/lib/${libFolder(f)}/`;
    for (const e of f.entries) for (const s of e.specifiers) map[s] = `${base}${e.out}.js`;
    if (f.raw)
      map[f.raw.specifier] = f.raw.specifier.endsWith("/")
        ? `${base}raw/`
        : `${base}raw/mermaid.esm.min.mjs`;
  }
  // three's examples by their older name too.
  if (map["three/addons/"]) map["three/examples/jsm/"] = map["three/addons/"];
  return map;
}

type Esbuild = typeof import("esbuild-wasm");
let esbuildP: Promise<Esbuild> | undefined;
/** esbuild, as WebAssembly: the same package on Windows, macOS and Linux, no native binary. */
const esbuild = () => {
  esbuildP ??= import("esbuild-wasm") as Promise<Esbuild>;
  return esbuildP;
};

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A CommonJS module's names, read in Node (the bundle lists them for `import { x }`). */
function namesOf(module: string): string[] {
  const m = require(module) as Record<string, unknown>;
  return Object.keys(m).filter((k) => IDENT.test(k) && k !== "default" && k !== "__esModule");
}

function entryCode(e: Entry): string {
  const id = JSON.stringify(e.module);
  if (e.cjs) {
    const names = namesOf(e.module);
    return `import M from ${id};${e.withDefault ? "export default M;" : ""}export const {${names.join(",")}}=M;`;
  }
  return `export * from ${id};${e.withDefault ? `export {default} from ${id};` : ""}`;
}

/** Each library bundled once per process (on first use), its files by name. */
const bundles = new Map<ArtifactLib, Promise<Map<string, Uint8Array>>>();

async function bundle(f: Family): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (!f.entries.length) return out;
  const es = await esbuild();
  const byOut = new Map(f.entries.map((e) => [e.out, e]));
  const r = await es.build({
    entryPoints: f.entries.map((e) => ({ in: `rg-lib:${e.out}`, out: e.out })),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    write: false,
    outdir: "/lib",
    logLevel: "silent",
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "redgiant-lib",
        setup(b) {
          b.onResolve({ filter: /^rg-lib:/ }, (a) => ({
            path: a.path.slice(7),
            namespace: "rg-lib",
          }));
          b.onLoad({ filter: /.*/, namespace: "rg-lib" }, (a) => ({
            contents: entryCode(byOut.get(a.path) as Entry),
            resolveDir: HERE,
            loader: "js",
          }));
        },
      },
    ],
  });
  for (const file of r.outputFiles) out.set(file.path.replace(/^.*[\\/]/, ""), file.contents);
  return out;
}

/** Content types of what `lib/` serves. */
const LIB_TYPE = "text/javascript; charset=utf-8";

/**
 * A file under a preview's `lib/` (`<lib>-<version>/<file>`), or undefined. Bundles are made the
 * first time they are asked for and kept for the life of the process.
 */
export async function serveLib(
  rest: string,
): Promise<{ body: Uint8Array | string; type: string } | undefined> {
  const m = /^([a-z]+)-([0-9][\w.+-]*)\/(.+)$/.exec(rest);
  if (!m) return undefined;
  const f = FAMILIES.find((x) => x.lib === m[1]);
  if (!f || versionOf(f.pkg) !== m[2]) return undefined;
  const file = m[3] as string;
  if (file.startsWith("raw/")) {
    if (!f.raw) return undefined;
    const dir = packageDir(f.pkg);
    if (!dir) return undefined;
    const base = resolve(dir, f.raw.dir);
    const abs = resolve(base, file.slice(4));
    if (!abs.startsWith(base + sep) || !f.raw.ext.test(abs)) return undefined;
    const body = await readFile(abs).catch(() => undefined);
    return body && { body: new Uint8Array(body), type: LIB_TYPE };
  }
  if (!/^[\w.-]+\.js$/.test(file)) return undefined;
  let p = bundles.get(f.lib);
  if (!p) {
    p = bundle(f);
    bundles.set(f.lib, p);
    p.catch(() => bundles.delete(f.lib));
  }
  const body = (await p).get(file);
  return body && { body, type: LIB_TYPE };
}

// ---- the page ----------------------------------------------------------------------------------

/**
 * The headers of an artifact or a widget (3.5.9): scripts and forms in an opaque origin, nothing
 * but inline code and the preview's own `lib/`; pictures and sounds only from `data:` and `blob:`;
 * no requests, no frames, no forms posted, no base; only RedGiant frames it.
 */
export function artifactHeaders(origins: string[], prefix: string): Record<string, string> {
  const lib = origins.map((o) => `${o}${prefix}/lib/`).join(" ");
  return {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    "Content-Security-Policy": [
      `sandbox ${ARTIFACT_SANDBOX}`,
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' ${lib}`,
      `style-src 'unsafe-inline' ${lib}`,
      "img-src data: blob:",
      `font-src data: ${lib}`,
      "media-src data: blob:",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "manifest-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      `frame-ancestors ${origins.join(" ")}`,
    ].join("; "),
  };
}

/** The headers of a library file: the same isolation, cached (names carry the version). */
export const LIB_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=86400",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'",
};

/** Whether an HTML file runs as an artifact: by its folder, or by its header. */
export async function isArtifactFile(abs: string, path: string): Promise<boolean> {
  if (!/\.html?$/i.test(path)) return false;
  if (isArtifactPath(path)) return true;
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile() || st.size > 4 * 1024 * 1024) return false;
  const head = (await readFile(abs, "utf8").catch(() => "")).slice(0, 4096);
  return artifactHeaderOf(head) !== undefined;
}

const COMPILED = new Map<string, { code?: string; error?: string }>();
const JSX_TYPES = /^(text\/(babel|jsx|tsx|typescript)|application\/(babel|jsx))$/i;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const typeOf = (attrs: string) => /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "";

/** JSX/TSX compiled to a module, once per text (a cache keyed by its hash). */
export async function compileJsx(
  code: string,
  importSource: "react" | "preact",
): Promise<{ code?: string; error?: string }> {
  const key = createHash("sha256").update(importSource).update("\0").update(code).digest("hex");
  const hit = COMPILED.get(key);
  if (hit) return hit;
  let out: { code?: string; error?: string };
  try {
    const es = await esbuild();
    const r = await es.transform(code, {
      loader: "tsx",
      jsx: "automatic",
      jsxImportSource: importSource,
      format: "esm",
      target: "es2020",
      logLevel: "silent",
    });
    out = { code: r.code };
  } catch (err) {
    const e = err as { errors?: { text: string; location?: { line: number; column: number } }[] };
    const first = e.errors?.[0];
    out = {
      error: first
        ? `${first.text}${first.location ? ` (line ${first.location.line}:${first.location.column})` : ""}`
        : String(err),
    };
  }
  if (COMPILED.size > 200) COMPILED.clear();
  COMPILED.set(key, out);
  return out;
}

const BARE =
  /(?:\bimport\s*(?:[\w$*{}\s,]+\s*from\s*)?|\bexport\s*[\w$*{}\s,]+\s*from\s*|\bimport\s*\(\s*)(["'])([^"'./][^"']*)\1/g;

/** Bare imports of a module's code that the import map does not know. */
export function missingImports(code: string, map: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(BARE)) {
    const s = m[2] as string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) continue;
    if (map[s] || Object.keys(map).some((k) => k.endsWith("/") && s.startsWith(k))) continue;
    out.add(s);
  }
  return [...out];
}

/** The theme variables a page gets before the host says its own (light, then dark). */
const BASE_STYLE = `:root{color-scheme:light dark;--rg-bg:#f6f7f9;--rg-panel:#ffffff;--rg-line:#dde1e8;--rg-text:#1c2230;--rg-dim:#6b7385;--rg-accent:#d23a2c;--rg-ok:#2e9d5b;--rg-warn:#c99a14;--rg-err:#d23d3d;--rg-radius:10px;--rg-font:system-ui,-apple-system,"Segoe UI",sans-serif;--rg-mono:ui-monospace,Consolas,monospace}@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--rg-bg:#15171c;--rg-panel:#1c1f26;--rg-line:#313642;--rg-text:#e8e6e3;--rg-dim:#8f96a3;--rg-accent:#ef4b3a}}:root[data-theme=dark]{color-scheme:dark}:root[data-theme=light]{color-scheme:light}:where(body){font-family:var(--rg-font);color:var(--rg-text)}`;

/**
 * Our runtime, first in the page: errors (window.onerror, rejections, console.error, a library or
 * script that did not load) and the page's height go to the page around it; the theme comes from
 * it; `redgiant.sendMessage(text)` asks to send a message to the chat (the page decides). Links
 * that would leave go to the person, as in every agent-made page (3.5.8).
 */
function runtime(initial: ArtifactError[]): string {
  return `(()=>{"use strict";const P=window.parent;const S=m=>{try{P.postMessage(Object.assign({jsonrpc:"2.0"},m),"*")}catch(_){}};const seen=new Set();const all=[];let n=0;const E=(kind,message,where)=>{message=String(message==null?"":message).slice(0,2000);const k=kind+"|"+message+"|"+(where||"");if(seen.has(k)||n>=${ARTIFACT_ERRORS_MAX})return;seen.add(k);n++;const p={kind,message};if(where)p.where=String(where).slice(0,200);all.push(p);S({method:"redgiant/error",params:p})};const txt=x=>{if(x&&x.message)return x.message;if(typeof x==="string")return x;try{return JSON.stringify(x)}catch(_){return String(x)}};addEventListener("error",e=>{const t=e.target;if(t&&t!==window&&t.tagName){E("lib","Could not load "+(t.src||t.href||t.tagName.toLowerCase()));return}E("error",e.message||txt(e.error),e.lineno?"line "+e.lineno+(e.colno?":"+e.colno:""):"")},true);addEventListener("unhandledrejection",e=>E("rejection",txt(e.reason)));const ce=console.error;console.error=function(){try{E("console",Array.prototype.map.call(arguments,txt).join(" "))}catch(_){}return ce.apply(console,arguments)};for(const x of ${JSON.stringify(initial)})E(x.kind,x.message,x.where);let last=-1;const size=()=>{const b=document.body;if(!b)return;const c=getComputedStyle(b);const h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0));if(h!==last){last=h;S({method:"ui/notifications/size-changed",params:{height:h}})}};const watch=()=>{try{const o=new ResizeObserver(size);o.observe(document.documentElement);if(document.body)o.observe(document.body)}catch(_){}size()};if(document.readyState==="loading")addEventListener("DOMContentLoaded",watch);else watch();addEventListener("load",size);const theme=p=>{if(!p||typeof p!=="object")return;const r=document.documentElement;if(p.theme==="dark"||p.theme==="light"){r.dataset.theme=p.theme;r.style.colorScheme=p.theme}const v=p.styles&&p.styles.variables;if(v&&typeof v==="object")for(const k of Object.keys(v))if(/^--rg-[a-z0-9-]{1,40}$/.test(k))r.style.setProperty(k,String(v[k]).slice(0,200));try{dispatchEvent(new CustomEvent("redgiant:theme",{detail:{theme:p.theme}}))}catch(_){}};addEventListener("message",e=>{if(e.source!==P)return;const d=e.data;if(d&&d.method==="ui/notifications/host-context-changed"){theme(d.params);last=-1;size();for(const p of all)S({method:"redgiant/error",params:p})}});let id=0;window.redgiant=Object.freeze({sendMessage:t=>{S({method:"ui/message",id:++id,params:{role:"user",content:[{type:"text",text:String(t)}]}})}});const out=u=>{try{P.postMessage({redgiant:"open-link",url:String(new URL(u,location.href))},"*")}catch(_){}};document.addEventListener("click",e=>{const a=e.target instanceof Element?e.target.closest("a[href]"):null;if(!a||a.hasAttribute("download"))return;let u;try{u=new URL(a.href,location.href)}catch(_){return}if(u.protocol!=="http:"&&u.protocol!=="https:")return;if(u.origin===location.origin&&u.pathname===location.pathname&&u.hash)return;e.preventDefault();out(u.href)},true);window.open=u=>{if(u)out(u);return null};S({method:"ui/notifications/initialized",params:{}})})();`;
}

/** What a page gets before its own code: our runtime, the import map, the theme's variables. */
async function prepared(
  html: string,
  prefix: string,
  header: ArtifactHeader | undefined,
): Promise<string> {
  const libs = header?.libs ?? [];
  const map = importMap(prefix, libs);
  const errors: ArtifactError[] = [];
  const jsxFrom = libs.includes("preact") && !libs.includes("react") ? "preact" : "react";
  // JSX blocks become modules (compiled here, cached by their text).
  const parts: { start: number; end: number; text: string }[] = [];
  const modules: string[] = [];
  for (const m of html.matchAll(SCRIPT)) {
    const attrs = m[1] ?? "";
    const type = typeOf(attrs);
    if (JSX_TYPES.test(type)) {
      const c = await compileJsx(m[2] ?? "", jsxFrom);
      if (c.error) errors.push({ kind: "compile", message: c.error });
      const code = (c.code ?? "").replace(/<\/script/gi, "<\\/script");
      modules.push(code);
      parts.push({
        start: m.index,
        end: m.index + m[0].length,
        text: `<script type="module">${code}</script>`,
      });
    } else if (type.toLowerCase() === "module") modules.push(m[2] ?? "");
  }
  let body = html;
  for (const p of parts.reverse()) body = body.slice(0, p.start) + p.text + body.slice(p.end);
  for (const code of modules)
    for (const s of missingImports(code, map))
      errors.push({
        kind: "lib",
        message: `"${s}" is not a library RedGiant serves (artifacts reach no internet): use one of react, preact, d3, chart.js, three, papaparse, xlsx, lucide, marked${libs.includes("mermaid") ? ", mermaid" : ' (mermaid with "libs":["mermaid"] in the header)'}, or put the code in the page`,
      });
  const head = `<meta charset="utf-8"><script>${runtime(errors.slice(0, ARTIFACT_ERRORS_MAX))}</script><script type="importmap">${JSON.stringify({ imports: map })}</script><style>${BASE_STYLE}</style>`;
  if (/<head[^>]*>/i.test(body)) return body.replace(/<head[^>]*>/i, (h) => `${h}${head}`);
  if (/<html[^>]*>/i.test(body))
    return body.replace(/<html[^>]*>/i, (h) => `${h}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;
}

/** An artifact's page as the frame gets it. */
export function artifactPage(html: string, prefix: string): Promise<string> {
  return prepared(html, prefix, artifactHeaderOf(html));
}

/**
 * A widget's page: the block's HTML (a whole document or a fragment), with a transparent
 * background and no margin, so it sits in the chat bubble.
 */
export function widgetPage(html: string, prefix: string): Promise<string> {
  const whole = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:where(html,body){background:transparent;margin:0}:where(body){padding:2px}</style></head><body>${html}</body></html>`;
  return prepared(whole, prefix, artifactHeaderOf(html));
}

/** A widget kept as an artifact (`Tienilo`): its header written, its name made into a file name. */
export function keptWidget(
  html: string,
  title: string,
  from: string | undefined,
): { name: string; file: string; text: string } {
  const old = artifactHeaderOf(html);
  const name = (old?.name ?? title.trim()) || "widget";
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "widget";
  const whole = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${name.replace(/[<&]/g, "")}</title>\n</head>\n<body>\n${html}\n</body>\n</html>\n`;
  const header: ArtifactHeader = {
    name,
    version: old?.version ?? 1,
    libs: old?.libs ?? [],
    wants: [],
    ...((old?.from ?? from) && { from: old?.from ?? from }),
  };
  const withHeader = old ? whole : `<!-- redgiant-artifact ${JSON.stringify(header)} -->\n${whole}`;
  return { name, file: `${ARTIFACT_DIR}/${slug}.html`, text: withHeader };
}

// ---- errors back to the agent ----------------------------------------------------------------

/**
 * The errors artifacts and widgets met in the person's page (3.5.9): the last ones of each (for
 * canvas_look) and the lines waiting for a conversation (its next tool result carries them, as the
 * editor's notes). Deduplicated, at most 20 of each; in memory only.
 */
export class ArtifactErrors {
  private readonly last = new Map<string, ArtifactError[]>();
  private readonly pending = new Map<string, Map<string, string>>();
  /** The conversations that showed a file (show, show_file), by the file's key. */
  private readonly shownIn = new Map<string, Set<string>>();

  static fileKey(ownerId: string, scope: string, path: string): string {
    return `${ownerId}\u0000${scope}\u0000${path.replace(/\\/g, "/")}`;
  }

  shown(key: string, sessionId: string): void {
    let s = this.shownIn.get(key);
    if (!s) {
      s = new Set();
      this.shownIn.set(key, s);
    }
    s.add(sessionId);
    if (s.size > 20) s.delete(s.values().next().value as string);
  }

  sessionsOf(key: string): string[] {
    return [...(this.shownIn.get(key) ?? [])];
  }

  /** New errors of one artifact (`name` as the agent knows it); returns how many were new. */
  report(key: string, name: string, errors: ArtifactError[], sessions: Iterable<string>): number {
    const kept = this.last.get(key) ?? [];
    const fresh: ArtifactError[] = [];
    for (const e of errors) {
      if (kept.length >= ARTIFACT_ERRORS_MAX) break;
      if (kept.some((k) => k.kind === e.kind && k.message === e.message && k.where === e.where))
        continue;
      kept.push(e);
      fresh.push(e);
    }
    this.last.set(key, kept);
    if (!fresh.length) return 0;
    for (const s of sessions) {
      let m = this.pending.get(s);
      if (!m) {
        m = new Map();
        this.pending.set(s, m);
      }
      for (const e of fresh) {
        if (m.size >= ARTIFACT_ERRORS_MAX) break;
        m.set(`${key}\u0000${e.kind}\u0000${e.message}`, `${name} ${errorLine(e)}`);
      }
    }
    return fresh.length;
  }

  /** The page loaded it again: what it says now replaces what it said before. */
  reset(key: string): void {
    this.last.delete(key);
  }

  /** The last errors of one artifact, in words (canvas_look), or "". */
  text(key: string): string {
    const e = this.last.get(key);
    if (!e?.length) return "";
    return `It met ${e.length} error${e.length === 1 ? "" : "s"} in the person's page: ${e.map(errorLine).join("; ")}.`;
  }

  /** A line for a conversation (Fanne un progetto…), carried like the errors. */
  note(sessionId: string, line: string): void {
    let m = this.pending.get(sessionId);
    if (!m) {
      m = new Map();
      this.pending.set(sessionId, m);
    }
    m.set(`note\u0000${line}`, line);
  }

  /** The lines waiting for a conversation, taken. */
  take(sessionId: string): string[] {
    const m = this.pending.get(sessionId);
    if (!m?.size) return [];
    this.pending.delete(sessionId);
    const lines = [...m.values()];
    return [`An artifact or widget you made reported, in the person's page: ${lines.join(" | ")}`];
  }
}

const errorLine = (e: ArtifactError) => `[${e.kind}] ${e.message}${e.where ? ` (${e.where})` : ""}`;

// ---- words for the agents ----------------------------------------------------------------------

export { ARTIFACT_TOOL_LINE } from "@redgiant/protocol";

/** Said after show or show_file opens an artifact. */
export const ARTIFACT_SHOWN =
  " It runs as an artifact (isolated, no network); errors it meets in the person's page come back with your next tool result, and canvas_look tells them too.";

/** canvas_edit help on an HTML file: the artifact's format (3.5.9). */
export const ARTIFACT_HELP = `

## Artifacts (HTML that runs in the canvas)
An HTML file in ${ARTIFACT_DIR}/ (or any HTML whose first line is the header) runs as an artifact: one file, no network.
- Header, first line: <!-- redgiant-artifact {"name":"Budget","version":1,"libs":["react","chartjs"]} -->. Raise "version" when you change it. "libs" from: react, preact, d3, chartjs, three, papaparse, sheetjs, lucide, mermaid, marked (mermaid loads only when listed).
- Imports by bare name through RedGiant's import map: "react", "react-dom/client", "react/jsx-runtime", "preact", "preact/hooks", "d3", "chart.js/auto", "three", "three/addons/…", "papaparse", "xlsx", "lucide", "marked", "mermaid". Use <script type="module">, or <script type="text/babel"> for JSX/TSX (compiled by RedGiant; React's automatic runtime, Preact's when libs has preact and not react).
- Not allowed (blocked by the frame): fetch/XHR/WebSocket, pictures or fonts from the web, CDNs, other frames, popups, form posts, localStorage. Pictures: data: or blob: URLs; files: an <input type=file> the person picks.
- Theme: CSS variables --rg-bg, --rg-panel, --rg-line, --rg-text, --rg-dim, --rg-accent, --rg-ok, --rg-warn, --rg-err, --rg-radius, --rg-font, --rg-mono follow the person's light or dark theme (event "redgiant:theme").
- redgiant.sendMessage(text) (max 4000 characters), from a button the person clicks, sends text to the chat as their message.
- Errors (exceptions, rejected promises, console.error, a library that is not there, JSX that does not compile) come back to you with your next tool result and in canvas_look.
- The same HTML in a \`\`\`widget block of your answer runs in the chat instead (at most 64 KB).`;
