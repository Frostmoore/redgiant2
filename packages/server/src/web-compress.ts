// The web page's files compressed (3.5.11): the server sent every script raw (2.5 MB before the
// first paint, 6.5 MB for the sheet editor). Each file is compressed once, with brotli when the
// browser takes it (gzip otherwise), on the thread pool, and kept in memory up to a cap (least
// recently used out first); a file that changes on disk has another key.
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

export type Encoding = "br" | "gzip";

/** Kinds worth compressing (text, and wasm); pictures, fonts and archives are compressed already. */
export const COMPRESSIBLE = /\.(js|mjs|css|html|json|map|svg|txt|webmanifest|wasm)$/i;
/** Below this the headers cost more than the bytes saved. */
export const MIN_COMPRESS = 1024;

/** The encoding to use for an `Accept-Encoding` header: brotli first, then gzip, else none. */
export function pickEncoding(accept: string | undefined): Encoding | undefined {
  if (!accept) return undefined;
  const offered = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    offered.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  const ok = (n: string) => (offered.get(n) ?? offered.get("*") ?? 0) > 0;
  if (ok("br")) return "br";
  if (ok("gzip")) return "gzip";
  return undefined;
}

/** Compressed copies of the page's files, at most `maxBytes` of them in memory. */
export class CompressedFiles {
  private readonly kept = new Map<string, Promise<Buffer>>();
  private readonly sizes = new Map<string, number>();
  private total = 0;

  constructor(
    readonly maxBytes = 64 * 1024 * 1024,
    private readonly compress: (body: Buffer, enc: Encoding) => Promise<Buffer> = compressBody,
  ) {}

  /** Bytes held now (for tests and the page's health). */
  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.kept.size;
  }

  /** The compressed body for `key` (the file's path, size and time), made once. */
  get(key: string, enc: Encoding, body: Buffer): Promise<Buffer> {
    const k = `${enc}\0${key}`;
    const held = this.kept.get(k);
    if (held) {
      // Most recently used goes last.
      this.kept.delete(k);
      this.kept.set(k, held);
      return held;
    }
    const made = this.compress(body, enc).then(
      (out) => {
        if (this.kept.get(k) === made) {
          this.sizes.set(k, out.length);
          this.total += out.length;
          this.evict();
        }
        return out;
      },
      (err: unknown) => {
        if (this.kept.get(k) === made) this.kept.delete(k);
        throw err;
      },
    );
    this.kept.set(k, made);
    return made;
  }

  private evict(): void {
    for (const k of this.kept.keys()) {
      if (this.total <= this.maxBytes) return;
      const n = this.sizes.get(k);
      // Still compressing: it counts once it is done.
      if (n === undefined) continue;
      this.kept.delete(k);
      this.sizes.delete(k);
      this.total -= n;
    }
  }
}

/** Brotli at quality 6 (most of quality 11's gain for a fifth of the time), gzip at 6. */
export function compressBody(body: Buffer, enc: Encoding): Promise<Buffer> {
  return enc === "br"
    ? brotli(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 6,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gz(body, { level: 6 });
}
