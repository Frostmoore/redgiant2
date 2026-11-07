// Archives read in the page (G34.2): the list of a ZIP (fflate reads its directory without
// unpacking anything), of a TAR and of a gzipped TAR; one file taken out when the person opens
// it. Nothing is written anywhere.
import { gunzipSync, unzipSync } from "fflate";

export interface ArchiveEntry {
  path: string;
  size: number;
  /** Bytes inside the archive (ZIP), when it says. */
  packed?: number;
  folder: boolean;
}

/** The entries of a ZIP, folders included, as the archive lists them. */
export function zipList(bytes: Uint8Array): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      out.push({
        path: f.name,
        size: f.originalSize,
        packed: f.size,
        folder: f.name.endsWith("/"),
      });
      return false;
    },
  });
  return out;
}

/** One file of a ZIP, unpacked. */
export function zipFile(bytes: Uint8Array, path: string): Uint8Array | undefined {
  return unzipSync(bytes, { filter: (f) => f.name === path })[path];
}

const field = (b: Uint8Array, at: number, len: number) => {
  let end = at;
  while (end < at + len && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(at, end));
};

interface TarItem extends ArchiveEntry {
  offset: number;
}

/** The entries of a TAR (ustar and the old format; long GNU names understood). */
function tarItems(b: Uint8Array): TarItem[] {
  const out: TarItem[] = [];
  let at = 0;
  let longName: string | undefined;
  while (at + 512 <= b.length) {
    if (b.subarray(at, at + 512).every((x) => x === 0)) break;
    const name = field(b, at, 100);
    const size = Number.parseInt(field(b, at + 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(b[at + 156] ?? 48);
    const prefix = field(b, at + 257, 6).startsWith("ustar") ? field(b, at + 345, 155) : "";
    const data = at + 512;
    if (type === "L") longName = field(b, data, size);
    else if (type !== "x" && type !== "g") {
      const path = longName ?? (prefix ? `${prefix}/${name}` : name);
      longName = undefined;
      out.push({ path, size, folder: type === "5" || path.endsWith("/"), offset: data });
    }
    at = data + Math.ceil(size / 512) * 512;
  }
  return out;
}

export const tarList = (bytes: Uint8Array): ArchiveEntry[] =>
  tarItems(bytes).map(({ offset: _, ...e }) => e);

export function tarFile(bytes: Uint8Array, path: string): Uint8Array | undefined {
  const e = tarItems(bytes).find((x) => x.path === path && !x.folder);
  return e ? bytes.slice(e.offset, e.offset + e.size) : undefined;
}

export const gunzip = (bytes: Uint8Array) => gunzipSync(bytes);

/** Whether unpacked bytes are a TAR (its "ustar" mark, or a header whose sum adds up). */
export function isTar(b: Uint8Array): boolean {
  if (b.length < 512) return false;
  if (field(b, 257, 5) === "ustar") return true;
  const want = Number.parseInt(field(b, 148, 8).trim(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (b[i] ?? 0);
  return want === sum;
}
