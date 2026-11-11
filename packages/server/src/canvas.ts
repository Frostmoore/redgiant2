// The canvas (G25.1): whatever an agent makes can be seen. A site is served from its folder, or
// reached through the server when a program in the agent's container serves it; pictures,
// videos, sheets and models are shown by the page itself. A shown site runs isolated: a link
// signed by the server and valid for a while, a sandboxed frame and a `sandbox` policy, so it
// can never read the person's access to RedGiant.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { FILES_SANDBOX, PROGRAM_SANDBOX } from "@redgiant/protocol";
import { lockedPage } from "./webrtc-lockdown.js";

/** What a preview link opens: a folder of files, or a port in an agent's container. */
export type PreviewTarget =
  | { kind: "dir"; root: string }
  | { kind: "port"; host: string; port: number }
  /** One file and nothing around it (G34.1: a file outside every workspace, approved). */
  | { kind: "file"; path: string }
  /** An artifact (3.5.9): one HTML file run in the artifacts' frame, with the libraries. */
  | { kind: "artifact"; path: string }
  /** A widget of an agent's answer (3.5.9): read from the log, run like an artifact. */
  | { kind: "widget"; sessionId: string; seq: number; index: number };

interface Signed {
  o: string;
  t: PreviewTarget;
  /** Expiry, in seconds since 1970. */
  e: number;
}

const b64 = (b: Buffer) => b.toString("base64url");

/** Links to previews: signed with a key of this process, so they end with it. */
export class Previews {
  constructor(
    private readonly key: Buffer = randomBytes(32),
    private readonly now: () => number = () => Date.now(),
  ) {}

  sign(ownerId: string, target: PreviewTarget, ttlSeconds = 12 * 3600): string {
    const body = b64(
      Buffer.from(
        JSON.stringify({ o: ownerId, t: target, e: Math.floor(this.now() / 1000) + ttlSeconds }),
      ),
    );
    return `${body}.${b64(createHmac("sha256", this.key).update(body).digest())}`;
  }

  verify(token: string): { ownerId: string; target: PreviewTarget } | undefined {
    const [body, mac] = token.split(".");
    if (!body || !mac) return undefined;
    const want = createHmac("sha256", this.key).update(body).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Signed;
      if (s.e * 1000 < this.now()) return undefined;
      return { ownerId: s.o, target: s.t };
    } catch {
      return undefined;
    }
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  // The canvas's viewers (G34.2).
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".bmp": "image/bmp",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".zip": "application/zip",
  ".stl": "model/stl",
  ".obj": "model/obj",
};

export const contentType = (path: string) =>
  TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Headers every preview carries, whatever it shows: never cached, never sniffed, no referrer. */
const PREVIEW_BASE: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * What a preview shows (3.5.8): `files` are pages made by agents (a file, a folder, a board),
 * which never reach the internet; `program` is a program the person's project runs in an
 * agent's container (a dev server), a real app that keeps its network.
 */
export type PreviewUse = "files" | "program";

/**
 * The origins the browser uses for RedGiant, from the request (the host changes: an address on
 * the network, a Tailscale name, a domain behind a proxy). Both schemes, because a proxy in
 * front may speak https while the server sees http. Only well-formed hosts make it into a policy.
 */
export function previewOrigins(req: Request): string[] {
  const hosts = new Set<string>([new URL(req.url).host]);
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwarded && /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i.test(forwarded))
    hosts.add(forwarded.toLowerCase());
  return [...hosts].flatMap((h) => [`http://${h}`, `https://${h}`]);
}

/**
 * The headers of a preview (3.5.8, decision of 2026-11-11: no internet for agent-made HTML).
 * Agent-made pages load only from their own preview (`<origin>/preview/<token>/`, written in full:
 * `'self'` is unreliable in an opaque origin), plus `data:` and `blob:`; inline scripts and styles
 * keep working for single-file pages; nothing else is reached (fetch, beacons, WebSocket,
 * EventSource, pictures, fonts, prefetch), forms post nowhere, and only RedGiant may frame them.
 * Navigating the frame elsewhere is stopped by the frame's parent (`frame-src` on RedGiant's page,
 * or the wrapper of a page opened on its own). A project's program keeps its network.
 */
export function previewHeaders(
  use: PreviewUse,
  origins: string[],
  prefix: string,
  /** The answer's content type: SVG and XML documents run no scripts (3.5.10). */
  type = "text/html",
): Record<string, string> {
  const ancestors = `frame-ancestors ${origins.join(" ")}`;
  if (use === "program")
    return {
      ...PREVIEW_BASE,
      "Content-Security-Policy": `sandbox ${PROGRAM_SANDBOX}; ${ancestors}`,
    };
  const self = origins.map((o) => `${o}${prefix}/`).join(" ");
  // An SVG or XML file opened as a page could run scripts without the WebRTC lockdown (only HTML
  // gets it): those run none.
  const scripts = !SCRIPTLESS.test(type);
  return {
    ...PREVIEW_BASE,
    "Content-Security-Policy": [
      `sandbox ${scripts ? FILES_SANDBOX : FILES_SANDBOX.replace("allow-scripts ", "")}`,
      "default-src 'none'",
      scripts ? `script-src ${self} 'unsafe-inline' 'unsafe-eval' blob:` : "script-src 'none'",
      `style-src ${self} 'unsafe-inline' blob:`,
      `img-src ${self} data: blob:`,
      `font-src ${self} data: blob:`,
      `media-src ${self} data: blob:`,
      `connect-src ${self}`,
      `worker-src ${self} blob:`,
      // Only the preview's own pages, which carry the lockdown: a blob: or data: page would not.
      `frame-src ${self}`,
      `manifest-src ${self}`,
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      // WebRTC has no fetch directive and no browser applies `webrtc` yet: the page's first
      // script takes it away (webrtc-lockdown.ts); this line is for browsers that learn it.
      "webrtc 'block'",
      ancestors,
    ].join("; "),
    "X-DNS-Prefetch-Control": "off",
  };
}

/** Content types a browser runs as a document with scripts, other than HTML. */
const SCRIPTLESS = /^(image\/svg\+xml|application\/xml|text\/xml|application\/xhtml\+xml)/i;

/** The headers of an answer that is not a page (expired link, refused method). */
export const PREVIEW_HEADERS: Record<string, string> = {
  ...PREVIEW_BASE,
  "Content-Security-Policy": `sandbox; default-src 'none'; base-uri 'none'; form-action 'none'`,
};

/**
 * A page made by an agent, opened on its own in a tab (`Sec-Fetch-Dest: document`): RedGiant
 * frames it in a page of its own, so the same rules hold as in the canvas: its `frame-src` keeps
 * the page inside its preview (a page cannot be stopped from navigating itself when it is the
 * top), and a link the page wants to open is shown to the person as a link to click. The wrapper
 * runs one script of ours (by nonce) and frames nothing else.
 */
export function previewWrapper(
  src: string,
  origins: string[],
  prefix: string,
  italian: boolean,
  /** The frame's sandbox: an artifact's is narrower (3.5.9). */
  sandbox: string = FILES_SANDBOX,
): { body: string; headers: Record<string, string> } {
  const nonce = randomBytes(16).toString("base64");
  const self = origins.map((o) => `${o}${prefix}/`).join(" ");
  const open = italian ? "La pagina vuole aprire" : "The page wants to open";
  const close = italian ? "Chiudi" : "Close";
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>RedGiant</title><style nonce="${nonce}">html,body{margin:0;height:100%;font:14px system-ui,sans-serif}iframe{border:0;width:100%;height:100%;display:block}#rg-link{position:fixed;left:12px;right:12px;bottom:12px;padding:10px 12px;border-radius:8px;background:#1f2328;color:#fff;display:none;gap:10px;align-items:center;box-shadow:0 4px 16px rgba(0,0,0,.3)}#rg-link a{color:#9cd2ff;word-break:break-all;flex:1}#rg-link button{font:inherit}</style></head><body><iframe src="${src.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" sandbox="${sandbox}" allow="fullscreen; autoplay; clipboard-write"></iframe><div id="rg-link" role="dialog"><span>${open}</span><a target="_blank" rel="noopener noreferrer"></a><button type="button">${close}</button></div><script nonce="${nonce}">(()=>{const f=document.querySelector("iframe"),b=document.getElementById("rg-link"),a=b.querySelector("a");b.querySelector("button").onclick=()=>{b.style.display="none"};addEventListener("message",e=>{const d=e.data;if(e.source!==f.contentWindow||!d||d.redgiant!=="open-link"||typeof d.url!=="string")return;let u;try{u=new URL(d.url)}catch{return}if(u.protocol!=="http:"&&u.protocol!=="https:")return;a.href=u.href;a.textContent=u.href;b.style.display="flex"})})();</script></body></html>`;
  return {
    body,
    headers: {
      ...PREVIEW_BASE,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-src ${self}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    },
  };
}

/**
 * Links in an agent-made page (3.5.8): the frame opens no windows and leaves its preview for
 * nowhere, so a link that would go out (another site, a new window, `window.open`) is handed to
 * the page around it, which shows it to the person to open or not.
 */
const LINKS = `<script>(()=>{const P=new URL(location.href);const out=u=>{try{parent.postMessage({redgiant:"open-link",url:String(new URL(u,location.href))},"*")}catch{}};document.addEventListener("click",e=>{const a=e.target instanceof Element?e.target.closest("a[href]"):null;if(!a||a.hasAttribute("download"))return;const u=new URL(a.href,location.href);if(u.protocol!=="http:"&&u.protocol!=="https:")return;const t=(a.getAttribute("target")||"").toLowerCase();const inside=u.origin===P.origin&&u.pathname.startsWith(P.pathname.split("/").slice(0,3).join("/")+"/");if(inside&&(!t||t==="_self"))return;e.preventDefault();out(u.href)},true);window.open=u=>{if(u)out(u);return null};})();</script>`;

/**
 * Paths that start with "/" mean the root of the site, which here is the preview's own prefix:
 * links, sources and requests made by scripts are moved under it. An agent-made page (`links`)
 * also gets its links handed to the person and, first of all, the WebRTC lockdown (3.5.10); a
 * project's program on a port gets neither.
 */
export function rewrite(body: string, type: string, prefix: string, links = false): string {
  const abs = `(?!\\/)(?!${prefix.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`;
  if (type.startsWith("text/html")) {
    const fixed = body.replace(
      new RegExp(`(\\s(?:src|href|action|poster|data)\\s*=\\s*["'])\\/${abs}`, "gi"),
      `$1${prefix}/`,
    );
    const script = `<script>(()=>{const P=${JSON.stringify(prefix)};const f=u=>typeof u==="string"&&u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(P+"/")?P+u:u;const F=window.fetch;window.fetch=(i,o)=>F(typeof i==="string"?f(i):i,o);const O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return O.call(this,m,f(u),...r)};const E=window.EventSource;if(E)window.EventSource=function(u,o){return new E(f(u),o)};})();</script>${links ? LINKS : ""}`;
    const page = /<head[^>]*>/i.test(fixed)
      ? fixed.replace(/<head[^>]*>/i, (h) => `${h}${script}`)
      : `${script}${fixed}`;
    return links ? lockedPage(page) : page;
  }
  if (type.startsWith("text/css"))
    return body.replace(new RegExp(`url\\((["']?)\\/${abs}`, "g"), `url($1${prefix}/`);
  if (type.startsWith("text/javascript"))
    return body.replace(
      new RegExp(`((?:\\bfrom|\\bimport)\\s*\\(?\\s*)(["'])\\/${abs}`, "g"),
      `$1$2${prefix}/`,
    );
  return body;
}

const REWRITTEN = /^(text\/html|text\/css|text\/javascript)/;

/** The most a single answer to a range request carries: a video plays on in parts. */
const MAX_RANGE = 8 * 1024 * 1024;

/** What a preview answers with. */
export interface Served {
  status: number;
  body: Uint8Array | string | ReadableStream;
  type: string;
  headers?: Record<string, string>;
}

/**
 * A file as it is, streamed, with ranges (G34.2: players seek, a large video is never read
 * whole into memory). `range` is the request's Range header.
 */
export async function serveRaw(abs: string, range?: string | null): Promise<Served> {
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile()) return { status: 404, body: "Not found", type: "text/plain" };
  const type = contentType(abs);
  const size = st.size;
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (start >= size || start > end)
      return {
        status: 416,
        body: "",
        type,
        headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
      };
    end = Math.min(end, size - 1, start + MAX_RANGE - 1);
    start = Math.max(0, start);
    return {
      status: 206,
      body: Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream,
      type,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    };
  }
  return {
    status: 200,
    body: size === 0 ? "" : (Readable.toWeb(createReadStream(abs)) as ReadableStream),
    type,
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(size) },
  };
}

/** A file of a folder preview, confined to the folder; a folder gives its index.html. */
export async function serveFile(
  root: string,
  path: string,
  prefix: string,
  range?: string | null,
): Promise<Served> {
  const base = resolve(root);
  let abs = resolve(base, `.${sep}${decodeURIComponent(path)}`);
  if (abs !== base && !abs.startsWith(base + sep))
    return { status: 403, body: "Outside the preview", type: "text/plain" };
  const st = await stat(abs).catch(() => undefined);
  if (st?.isDirectory()) abs = join(abs, "index.html");
  // Pictures, videos, documents: as they are, in ranges.
  if (!REWRITTEN.test(contentType(abs))) return serveRaw(abs, range);
  const data = await readFile(abs).catch(() => undefined);
  if (!data) return { status: 404, body: "Not found", type: "text/plain" };
  const type = contentType(abs);
  return {
    status: 200,
    body: REWRITTEN.test(type) ? rewrite(data.toString("utf8"), type, prefix, true) : data,
    type,
  };
}

/** Request headers never passed to a program in a container: the person's credentials. */
const DROP = new Set(["host", "cookie", "authorization", "origin", "referer", "connection"]);

/** A request passed to a program in an agent's container, its answer brought back. */
export async function bridge(
  target: { host: string; port: number },
  path: string,
  req: Request,
  prefix: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers();
  for (const [k, v] of req.headers) if (!DROP.has(k.toLowerCase())) headers.set(k, v);
  headers.set("accept-encoding", "identity");
  let res: Response;
  try {
    res = await fetcher(`http://${target.host}:${target.port}/${path}${url.search}`, {
      method: req.method,
      headers,
      redirect: "manual",
      ...(req.method !== "GET" && req.method !== "HEAD" && { body: await req.arrayBuffer() }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return new Response(
      `Nothing answers on port ${target.port} in the agent's container (${(err as Error).message}).`,
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", ...PREVIEW_HEADERS } },
    );
  }
  const out = new Headers();
  for (const [k, v] of res.headers)
    if (!["content-length", "content-encoding", "transfer-encoding", "set-cookie"].includes(k))
      out.set(k, v);
  const location = res.headers.get("location");
  if (location?.startsWith("/") && !location.startsWith("//"))
    out.set("location", `${prefix}${location}`);
  for (const [k, v] of Object.entries(previewHeaders("program", previewOrigins(req), prefix)))
    out.set(k, v);
  const type = res.headers.get("content-type") ?? "";
  if (REWRITTEN.test(type))
    return new Response(rewrite(await res.text(), type, prefix), {
      status: res.status,
      headers: out,
    });
  return new Response(res.body, { status: res.status, headers: out });
}

/** When anything under a folder (or a file) last changed: the canvas reloads when it moves. */
export async function lastChange(path: string, limit = 3000): Promise<number> {
  let latest = 0;
  let seen = 0;
  const walk = async (p: string): Promise<void> => {
    if (seen++ > limit) return;
    const st = await stat(p).catch(() => undefined);
    if (!st) return;
    latest = Math.max(latest, st.mtimeMs);
    if (!st.isDirectory()) return;
    for (const d of await readdir(p).catch(() => [] as string[]))
      if (d !== "node_modules" && d !== ".git" && d !== ".trash") await walk(join(p, d));
  };
  await walk(path);
  return Math.floor(latest);
}

/**
 * A path inside a root, as the root's relative path ("" for the root), or undefined. On Windows a
 * path on another drive comes back from `relative` absolute ("D:\\x"): that is outside too.
 */
export function inside(root: string, abs: string): string | undefined {
  const r = relative(resolve(root), resolve(abs));
  if (r.startsWith("..") || isAbsolute(r) || resolve(root, r) !== resolve(abs)) return undefined;
  return r.split(sep).join("/");
}
