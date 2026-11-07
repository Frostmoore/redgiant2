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

/** What a preview link opens: a folder of files, or a port in an agent's container. */
export type PreviewTarget =
  | { kind: "dir"; root: string }
  | { kind: "port"; host: string; port: number }
  /** One file and nothing around it (G34.1: a file outside every workspace, approved). */
  | { kind: "file"; path: string };

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

/**
 * Headers of every preview: an opaque origin even when opened on its own (no access to
 * RedGiant's storage), readable by the page's sandboxed frame, never cached for long.
 */
export const PREVIEW_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Paths that start with "/" mean the root of the site, which here is the preview's own prefix:
 * links, sources and requests made by scripts are moved under it.
 */
export function rewrite(body: string, type: string, prefix: string): string {
  const abs = `(?!\\/)(?!${prefix.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`;
  if (type.startsWith("text/html")) {
    const fixed = body.replace(
      new RegExp(`(\\s(?:src|href|action|poster|data)\\s*=\\s*["'])\\/${abs}`, "gi"),
      `$1${prefix}/`,
    );
    const script = `<script>(()=>{const P=${JSON.stringify(prefix)};const f=u=>typeof u==="string"&&u.startsWith("/")&&!u.startsWith("//")&&!u.startsWith(P+"/")?P+u:u;const F=window.fetch;window.fetch=(i,o)=>F(typeof i==="string"?f(i):i,o);const O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return O.call(this,m,f(u),...r)};const E=window.EventSource;if(E)window.EventSource=function(u,o){return new E(f(u),o)};})();</script>`;
    return /<head[^>]*>/i.test(fixed)
      ? fixed.replace(/<head[^>]*>/i, (h) => `${h}${script}`)
      : `${script}${fixed}`;
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
    body: REWRITTEN.test(type) ? rewrite(data.toString("utf8"), type, prefix) : data,
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
  for (const [k, v] of Object.entries(PREVIEW_HEADERS)) out.set(k, v);
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
