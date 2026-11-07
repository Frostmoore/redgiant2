#!/usr/bin/env node
// Differential updates (G36.18): the app of one version as a zip whose entries the launcher can
// download one by one with HTTP Range requests, and the manifest that says, for every file, its
// size, its sha256 and where its bytes sit in the zip.
//
//   node packaging/update/pack.mjs --tree <app folder> --version 3.4.0 --platform win-x64 --out <dir>
//     → <out>/RedGiant-<platform>.zip, <out>/RedGiant-<platform>.manifest.json and its .gz
//   node packaging/update/pack.mjs --estimate <old manifest> <new manifest>
//     → what an update from the old files to the new ones downloads (bytes and requests)
//
// Only Node's own modules: it runs in the release job before anything is installed. The zip is
// reproducible (sorted entries, fixed dates): the same files give the same bytes.
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync, gzipSync, inflateRawSync } from "node:zlib";

export const MANIFEST_FORMAT = 1;
/** Two runs of missing entries closer than this are one request (GitHub serves one range each). */
export const DEFAULT_GAP = 256 * 1024;
// 1980-01-01 00:00, the earliest DOS date: every entry the same, so the zip is reproducible.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function archiveName(platform) {
  return `RedGiant-${platform}.zip`;
}
export function manifestName(platform) {
  return `RedGiant-${platform}.manifest.json`;
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Every file under `root`, as "a/b/c" paths sorted bytewise (links are not followed). */
export function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) out.push(relative(root, full).split(sep).join("/"));
      else throw new Error(`not a plain file or folder: ${full}`);
    }
  };
  walk(root);
  return out.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? -1 : 1));
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * Writes the zip of `root` to `zipPath` and returns the manifest (without writing it). Every
 * entry is deflated on its own (stored when that is not smaller), so any one of them can be read
 * from its offset alone.
 */
export function packTree(root, zipPath, { version, platform, installer } = {}) {
  if (!version || !platform) throw new Error("version and platform are required");
  const paths = listTree(root);
  if (paths.length >= 0xffff)
    throw new Error(`too many files for a zip without zip64: ${paths.length}`);
  const fd = openSync(zipPath, "w");
  const whole = createHash("sha256");
  let at = 0;
  const write = (buf) => {
    writeSync(fd, buf);
    whole.update(buf);
    at += buf.length;
  };
  const files = [];
  const central = [];
  try {
    for (const path of paths) {
      const data = readFileSync(join(root, ...path.split("/")));
      const deflated = deflateRawSync(data, { level: 9 });
      const method = deflated.length < data.length ? 8 : 0;
      const body = method === 8 ? deflated : data;
      const name = Buffer.from(path, "utf8");
      const crc = crc32(data);
      const headerAt = at;
      if (headerAt > 0xffffffff - body.length - 1024) throw new Error("the zip passes 4 GB");
      // Local file header; bit 11: the name is UTF-8.
      write(
        Buffer.concat([
          u32(0x04034b50),
          u16(20),
          u16(0x0800),
          u16(method),
          u16(DOS_TIME),
          u16(DOS_DATE),
          u32(crc),
          u32(body.length),
          u32(data.length),
          u16(name.length),
          u16(0),
          name,
        ]),
      );
      const offset = at;
      write(body);
      files.push({
        path,
        size: data.length,
        sha256: sha256(data),
        offset,
        csize: body.length,
        method,
      });
      central.push(
        Buffer.concat([
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x0800),
          u16(method),
          u16(DOS_TIME),
          u16(DOS_DATE),
          u32(crc),
          u32(body.length),
          u32(data.length),
          u16(name.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(headerAt),
          name,
        ]),
      );
    }
    const cdAt = at;
    const cd = Buffer.concat(central);
    write(cd);
    write(
      Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(cd.length),
        u32(cdAt),
        u16(0),
      ]),
    );
  } finally {
    closeSync(fd);
  }
  const roots = [...new Set(paths.map((p) => p.split("/")[0]))].sort();
  return {
    format: MANIFEST_FORMAT,
    version,
    platform,
    archive: { name: archiveName(platform), size: at, sha256: whole.digest("hex") },
    ...(installer ? { installer } : {}),
    roots,
    files,
  };
}

/** One file's bytes from the zip, by its manifest entry (what the launcher does with a range). */
export function readEntry(zipPath, entry) {
  const fd = openSync(zipPath, "r");
  try {
    const body = Buffer.alloc(entry.csize);
    readSync(fd, body, 0, entry.csize, entry.offset);
    const data = entry.method === 8 ? inflateRawSync(body) : body;
    if (data.length !== entry.size || sha256(data) !== entry.sha256)
      throw new Error(`${entry.path}: not the file the manifest names`);
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Checks a parsed manifest's shape; throws on anything the launcher would refuse. */
export function checkManifest(m) {
  if (m?.format !== MANIFEST_FORMAT) throw new Error(`unknown manifest format: ${m?.format}`);
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(m.version ?? "")) throw new Error("bad version");
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error("no files");
  const seen = new Set();
  for (const f of m.files) {
    if (
      typeof f.path !== "string" ||
      f.path === "" ||
      f.path.startsWith("/") ||
      f.path.includes("\\") ||
      f.path.split("/").some((s) => s === "" || s === "." || s === "..") ||
      /[:*?"<>|]/.test(f.path)
    )
      throw new Error(`unsafe path: ${f.path}`);
    if (seen.has(f.path.toLowerCase())) throw new Error(`twice: ${f.path}`);
    seen.add(f.path.toLowerCase());
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256: ${f.path}`);
    if (![0, 8].includes(f.method)) throw new Error(`bad method: ${f.path}`);
    for (const k of ["size", "offset", "csize"])
      if (!Number.isSafeInteger(f[k]) || f[k] < 0) throw new Error(`bad ${k}: ${f.path}`);
    if (f.offset + f.csize > m.archive.size) throw new Error(`past the end: ${f.path}`);
  }
  return m;
}

/**
 * What an update downloads (the launcher's Delta.Compare and Delta.Runs, in JavaScript): the
 * entries whose file is missing or different locally, grouped into runs of the zip, one request
 * each, joining runs closer than `gap` bytes.
 * `local` maps a path to the sha256 of the file there now.
 */
export function plan(next, local, gap = DEFAULT_GAP) {
  const fetch = next.files.filter((f) => local.get(f.path) !== f.sha256);
  const sorted = [...fetch].sort((a, b) => a.offset - b.offset);
  const runs = [];
  for (const f of sorted) {
    const last = runs[runs.length - 1];
    if (last && f.offset - last.end <= gap) {
      last.end = f.offset + f.csize;
      last.files.push(f);
    } else runs.push({ start: f.offset, end: f.offset + f.csize, files: [f] });
  }
  const bytes = runs.reduce((n, r) => n + (r.end - r.start), 0);
  const keep = next.files.length - fetch.length;
  return { fetch, keep, runs, bytes };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else {
      o._ = o._ ?? [];
      o._.push(argv[i]);
    }
  }
  return o;
}

function mb(n) {
  return `${(n / 1048576).toFixed(1)} MB`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("pack.mjs")) {
  const o = args(process.argv.slice(2));
  if (o.estimate) {
    const [a, b] = [o.estimate, ...(o._ ?? [])];
    const old = checkManifest(JSON.parse(readFileSync(a, "utf8")));
    const next = checkManifest(JSON.parse(readFileSync(b, "utf8")));
    const p = plan(next, new Map(old.files.map((f) => [f.path, f.sha256])));
    console.log(
      `${old.version} → ${next.version}: ${p.fetch.length} of ${next.files.length} files, ` +
        `${mb(p.bytes)} in ${p.runs.length} requests (whole zip ${mb(next.archive.size)}` +
        `${next.installer ? `, installer ${mb(next.installer.size)}` : ""})`,
    );
    const gone = old.files.filter((f) => !next.files.some((g) => g.path === f.path)).length;
    console.log(`${gone} files removed`);
    for (const f of [...p.fetch].sort((x, y) => y.csize - x.csize).slice(0, 15))
      console.log(`  ${mb(f.csize).padStart(9)}  ${f.path}`);
  } else {
    if (!o.tree || !o.version || !o.platform || !o.out) {
      console.error(
        "usage: pack.mjs --tree <dir> --version <v> --platform <p> --out <dir> [--installer <file>]",
      );
      process.exit(2);
    }
    mkdirSync(o.out, { recursive: true });
    let installer;
    if (o.installer) {
      const data = readFileSync(o.installer);
      installer = {
        name: o.installer.split(/[\\/]/).pop(),
        size: data.length,
        sha256: sha256(data),
      };
    }
    const zip = join(o.out, archiveName(o.platform));
    const m = packTree(o.tree, zip, { version: o.version, platform: o.platform, installer });
    checkManifest(m);
    // Compact, and gzipped beside it: with ~19 000 files the manifest is most of what a small
    // update downloads (4.6 MB indented, 2026-11-08 CI), so the launcher fetches the .gz.
    const text = Buffer.from(`${JSON.stringify(m)}\n`);
    writeFileSync(join(o.out, manifestName(o.platform)), text);
    writeFileSync(join(o.out, `${manifestName(o.platform)}.gz`), gzipSync(text, { level: 9 }));
    const total = m.files.reduce((n, f) => n + f.size, 0);
    console.log(
      `${m.files.length} files, ${mb(total)} → ${zip} ${mb(m.archive.size)} (sha256 ${m.archive.sha256})`,
    );
  }
}
