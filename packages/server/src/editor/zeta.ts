// ZetaOffice (LibreOffice in WebAssembly, G37.4) served by RedGiant itself, never by its site:
// the server downloads the engine's files once (the person sees the bar), checks each one against
// the hash of the build tried in G37.0, keeps them in the data folder and serves them under
// /zeta/ to the page's isolated frame. Only that frame and its files get the isolation headers
// (Document-Isolation-Policy, COOP/COEP, CORP): the rest of the page keeps its own. Brotli as it
// came (52 MB on the wire), decompressed on the fly for a browser that does not take it.
// zetajs (MIT) and our frame are in the web UI (packages/web/public/zeta); the engine's licences:
// LibreOffice MPL-2.0, Qt for WebAssembly LGPL-3.0 (sources linked in /zeta/LICENSES.txt).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress } from "node:zlib";
import type { OfficeEngineState } from "@redgiant/protocol";
import type { JobHandle, Jobs } from "../jobs.js";

/** The build tried in G37.0 (zeta-24-2, LibreOffice 24.2, published 2025-05-13). */
export const ZETA_VERSION = "zeta-24-2-2025-05-13";

export interface ZetaFile {
  name: string;
  /** As stored and served: brotli (as the CDN gives it) or as is. */
  encoding: "br" | "identity";
  sha256: string;
  size: number;
  type: string;
}

export const ZETA_FILES: readonly ZetaFile[] = [
  {
    name: "soffice.js",
    encoding: "identity",
    sha256: "5143e5354f470b87f86ba272bcfef857bd13e6f07b59666e48a7ccb89643cd77",
    size: 858_124,
    type: "text/javascript",
  },
  {
    name: "soffice.data.js.metadata",
    encoding: "identity",
    sha256: "5d9d909d0b9b38443c0f19704032d0fc12d654f6c9c24c2c3b237739c4848ae3",
    size: 215_180,
    type: "application/octet-stream",
  },
  {
    name: "soffice.wasm",
    encoding: "br",
    sha256: "a11808aaba3c9a4412a865bde645247fd9d0b262b5baa0680a9fced29a8656e4",
    size: 36_279_250,
    type: "application/wasm",
  },
  {
    name: "soffice.data",
    encoding: "br",
    sha256: "9d3c1cf3c904ce570905052ba6844f3383fde93ad1267b65a3ae4b236db2fd05",
    size: 15_891_013,
    type: "application/octet-stream",
  },
];
export const ZETA_SIZE = ZETA_FILES.reduce((n, f) => n + f.size, 0);

/** Where the engine's files come from (G37.4, 3.5.2): tried one after the other, every file
 * checked against the same sha256 above, so a source that changed its build is skipped, never kept.
 * `cdn` asks for each file with its encoding (brotli as content-encoding); `stored` holds the bytes
 * as we keep them (`soffice.wasm.br`…), plain files: our pre-release is one. */
export interface ZetaSource {
  name: string;
  base: string;
  layout: "cdn" | "stored";
}

/** Our own copy: the pre-release `zetaoffice-cache` (workflow zetaoffice.yml), files never replaced. */
export const ZETA_RELEASE =
  "https://github.com/Frostmoore/redgiant2/releases/download/zetaoffice-cache";
export const ZETA_CDN = "https://cdn.zetaoffice.net/zetaoffice_latest";

/** The order: the administrator's mirror if set, our pre-release, then ZetaOffice's own CDN. */
export function zetaSources(env: NodeJS.ProcessEnv = process.env): ZetaSource[] {
  const out: ZetaSource[] = [];
  const mirror = env.REDGIANT_ZETAOFFICE_MIRROR?.trim();
  if (mirror) out.push({ name: "mirror", base: mirror, layout: "cdn" });
  out.push({ name: "redgiant", base: ZETA_RELEASE, layout: "stored" });
  out.push({ name: "zetaoffice", base: ZETA_CDN, layout: "cdn" });
  return out.map((x) => ({ ...x, base: x.base.replace(/\/+$/, "") }));
}

/** A file's name as we store it (and as our pre-release holds it). */
export const storedName = (f: ZetaFile) => (f.encoding === "br" ? `${f.name}.br` : f.name);

/** One file's request from one source: its address and the encoding the answer must have. */
export function sourceRequest(
  src: ZetaSource,
  f: ZetaFile,
): { url: string; encoding: "br" | "identity" } {
  return src.layout === "stored"
    ? { url: `${src.base}/${storedName(f)}`, encoding: "identity" }
    : { url: `${src.base}/${f.name}`, encoding: f.encoding };
}

/** Downloads one address to a file as it comes (no decompression); the caller checks the hash. */
export type ZetaFetch = (
  req: { url: string; encoding: "br" | "identity"; to: string },
  progress: (n: number) => void,
  signal: AbortSignal,
) => Promise<void>;

/** The headers that isolate the frame (and only it): SharedArrayBuffer for LibreOffice's threads. */
export const ISOLATION_HEADERS: Record<string, string> = {
  "document-isolation-policy": "isolate-and-require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

export const ZETA_LICENSES = `LibreOffice in the browser (ZetaOffice), served by RedGiant as a separate program.

- LibreOffice (zeta-24-2 build by allotropia): Mozilla Public License 2.0 (MPL-2.0), parts LGPL-3.0.
  Sources: https://git.libreoffice.org/core/+/refs/heads/distro/allotropia/zeta-24-2
- Qt 5.15 for WebAssembly (allotropia's fork): LGPL-3.0. Sources: https://github.com/allotropia/qt5
- Emscripten: MIT. Sources: https://github.com/allotropia/emscripten
- zetajs 1.2.0: MIT. https://github.com/allotropia/zetajs

The files are the ones published at cdn.zetaoffice.net on 2025-05-13 (ZetaOffice is now by Collabora
Productivity), kept unchanged by RedGiant in the pre-release zetaoffice-cache of
https://github.com/Frostmoore/redgiant2 (the CDN is the second source), downloaded once, checked by
their sha256 and served from this computer.
`;

/** The real download: HTTPS, redirects followed, the encoding asked and checked. */
export const fetchRaw: ZetaFetch = (req, progress, signal) => fetchOne(req, progress, signal, 0);

function fetchOne(
  req: { url: string; encoding: "br" | "identity"; to: string },
  progress: (n: number) => void,
  signal: AbortSignal,
  redirects: number,
): Promise<void> {
  return new Promise((done, failed) => {
    const name = req.url.split("/").pop();
    const r = httpsGet(
      req.url,
      {
        headers: {
          "accept-encoding": req.encoding === "br" ? "br" : "identity",
          "user-agent": "RedGiant (zetaoffice; +https://github.com/Frostmoore/redgiant2)",
        },
        signal,
      },
      (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects < 5) {
          res.resume();
          fetchOne(
            { ...req, url: new URL(res.headers.location, req.url).href },
            progress,
            signal,
            redirects + 1,
          ).then(done, failed);
          return;
        }
        if (code !== 200) {
          res.resume();
          failed(new Error(`${new URL(req.url).host} answered ${code} for ${name}`));
          return;
        }
        const enc = String(res.headers["content-encoding"] ?? "identity");
        if (enc !== req.encoding) {
          res.resume();
          failed(new Error(`${name} came as ${enc}, not ${req.encoding}`));
          return;
        }
        res.on("data", (b: Buffer) => progress(b.length));
        pipeline(res, createWriteStream(req.to)).then(done, failed);
      },
    );
    r.on("error", failed);
  });
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export class ZetaOffice {
  private job: string | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly o: {
      dataDir: string;
      jobs: Jobs;
      /** Tests: how a file is fetched, from where, and which files. */
      fetch?: ZetaFetch;
      sources?: ZetaSource[];
      files?: readonly ZetaFile[];
    },
  ) {}

  private get files(): readonly ZetaFile[] {
    return this.o.files ?? ZETA_FILES;
  }

  /**
   * One file from the first source that gives exactly it: a source that fails or gives other
   * bytes (another build) is skipped and said; nothing that does not match is ever kept.
   */
  async fetchFile(
    f: ZetaFile,
    target: string,
    progress: (n: number) => void,
    signal: AbortSignal,
  ): Promise<string> {
    const errors: string[] = [];
    for (const src of this.o.sources ?? zetaSources()) {
      const req = sourceRequest(src, f);
      const part = `${target}.part`;
      let got = 0;
      try {
        await (this.o.fetch ?? fetchRaw)(
          { ...req, to: part },
          (n) => {
            got += n;
            progress(n);
          },
          signal,
        );
        const hash = await sha256Of(part);
        if (hash !== f.sha256)
          throw new Error(
            `${f.name} is not the file RedGiant knows (sha256 ${hash.slice(0, 12)}…): it was not kept`,
          );
        await rename(part, target);
        return src.name;
      } catch (err) {
        await rm(part, { force: true }).catch(() => {});
        // The bar goes back by what this source gave.
        if (got) progress(-got);
        if (signal.aborted) throw err;
        errors.push(`${src.name}: ${(err as Error).message}`);
      }
    }
    throw new Error(`${f.name}: no source gave it (${errors.join("; ")})`);
  }

  get dir(): string {
    return join(this.o.dataDir, "tools", "zetaoffice", ZETA_VERSION);
  }

  private stored(f: ZetaFile) {
    return join(this.dir, storedName(f));
  }

  /** Every file is here with its size (its hash was checked when it came). */
  async ready(): Promise<boolean> {
    for (const f of this.files) {
      const st = await stat(this.stored(f)).catch(() => undefined);
      if (st?.size !== f.size) return false;
    }
    return true;
  }

  async state(serverEngine: OfficeEngineState["serverEngine"]): Promise<OfficeEngineState> {
    const ready = await this.ready();
    const job = this.job && this.o.jobs.get(this.owner ?? "", this.job);
    return {
      ready,
      version: ZETA_VERSION,
      size: this.files.reduce((n, f) => n + f.size, 0),
      ...(job && job.state === "running" && { job: job.id }),
      ...(!ready && this.lastError && { error: this.lastError }),
      serverEngine,
    };
  }

  private owner: string | undefined;

  /** The download, as a job with its bar (one at a time); undefined when everything is here. */
  async prepare(owner: string): Promise<string | undefined> {
    if (await this.ready()) return undefined;
    const running = this.job && this.o.jobs.get(owner, this.job);
    if (running && running.state === "running") return running.id;
    this.owner = owner;
    this.lastError = undefined;
    const job = this.o.jobs.start(
      owner,
      "download_zetaoffice",
      ["tool_download"],
      async (h: JobHandle) => {
        h.step("tool_download");
        await mkdir(this.dir, { recursive: true });
        const total = this.files.reduce((n, f) => n + f.size, 0);
        let done = 0;
        for (const f of this.files) {
          const target = this.stored(f);
          const st = await stat(target).catch(() => undefined);
          if (st?.size === f.size) {
            done += f.size;
            h.progress(done, total);
            continue;
          }
          await this.fetchFile(
            f,
            target,
            (n) => {
              done += n;
              h.progress(done, total);
            },
            h.signal,
          );
        }
        await writeFile(join(this.dir, "LICENSES.txt"), ZETA_LICENSES);
      },
    );
    this.job = job.id;
    void this.o.jobs.settled(job.id, 500).then((j) => {
      if (j?.state === "failed") this.lastError = j.error?.message ?? "the download failed";
    });
    return job.id;
  }

  /** One of the engine's files for the frame: undefined when it is not one (or not here). */
  async serve(name: string, acceptEncoding: string): Promise<Response | undefined> {
    if (name === "LICENSES.txt")
      return new Response(ZETA_LICENSES, {
        headers: { ...ISOLATION_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    const f = this.files.find((x) => x.name === name);
    if (!f) return undefined;
    const path = this.stored(f);
    if (!existsSync(path)) return undefined;
    const headers: Record<string, string> = {
      ...ISOLATION_HEADERS,
      "content-type": f.type,
      "cache-control": "public, max-age=31536000, immutable",
      vary: "accept-encoding",
    };
    if (f.encoding === "br" && /\bbr\b/.test(acceptEncoding)) {
      headers["content-encoding"] = "br";
      headers["content-length"] = String(f.size);
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
    }
    const raw = createReadStream(path);
    const body = f.encoding === "br" ? raw.pipe(createBrotliDecompress()) : raw;
    if (f.encoding !== "br") headers["content-length"] = String(f.size);
    return new Response(Readable.toWeb(body) as ReadableStream, { headers });
  }
}

/** The frame's own files from the web UI's folder (zeta/), with the isolation headers. */
export async function serveFrameFile(webDir: string, rel: string): Promise<Response | undefined> {
  const root = resolve(webDir, "zeta");
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return undefined;
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  const type = file.endsWith(".html")
    ? "text/html; charset=utf-8"
    : file.endsWith(".js")
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { ...ISOLATION_HEADERS, "content-type": type, "cache-control": "no-cache" },
  });
}
