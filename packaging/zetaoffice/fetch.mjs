#!/usr/bin/env node
// Our copy of ZetaOffice (3.5.2, workflow zetaoffice.yml): the four files of the build tried in
// G37.0, with the names, encodings, sizes and sha256 read from packages/server/src/editor/zeta.ts
// (one list, never a second copy), fetched from ZetaOffice's CDN as they come (brotli kept as
// brotli) and checked. Any file that is not exactly the known one stops everything: nothing is
// written to the output folder unless all four match, so a CDN that moved to another build fails
// with a clear message and nothing gets published.
//
//   node packaging/zetaoffice/fetch.mjs <out-dir> [--only name,name]   download and check
//   node packaging/zetaoffice/fetch.mjs --list                          the files as JSON
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ZETA_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/server/src/editor/zeta.ts",
);
const CDN = "https://cdn.zetaoffice.net/zetaoffice_latest";

/** The files as zeta.ts lists them (ZETA_FILES), with the name they are stored under. */
export function zetaFilesFrom(source) {
  const block = source.match(/export const ZETA_FILES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("ZETA_FILES not found in zeta.ts");
  const files = [];
  for (const m of block[1].matchAll(/\{([\s\S]*?)\}/g)) {
    const field = (k) => m[1].match(new RegExp(`${k}:\\s*"([^"]*)"`))?.[1];
    const size = Number(m[1].match(/size:\s*([\d_]+)/)?.[1].replaceAll("_", ""));
    const f = {
      name: field("name"),
      encoding: field("encoding"),
      sha256: field("sha256"),
      size,
    };
    if (!f.name || !/^[0-9a-f]{64}$/.test(f.sha256 ?? "") || !(size > 0))
      throw new Error(`a ZETA_FILES entry cannot be read: ${m[1].trim().slice(0, 80)}`);
    if (f.encoding !== "br" && f.encoding !== "identity")
      throw new Error(`${f.name}: unknown encoding ${f.encoding}`);
    files.push({ ...f, stored: f.encoding === "br" ? `${f.name}.br` : f.name });
  }
  if (!files.length) throw new Error("ZETA_FILES is empty");
  return files;
}

/** The licences' note served as /zeta/LICENSES.txt (ZETA_LICENSES), published with the files. */
export function licensesFrom(source) {
  const m = source.match(/export const ZETA_LICENSES = `([\s\S]*?)`;/);
  if (!m) throw new Error("ZETA_LICENSES not found in zeta.ts");
  return m[1];
}

/** The build zeta.ts names (ZETA_VERSION). */
export function versionFrom(source) {
  const m = source.match(/export const ZETA_VERSION = "([^"]+)"/);
  if (!m) throw new Error("ZETA_VERSION not found in zeta.ts");
  return m[1];
}

function download(url, encoding, to, redirects = 0) {
  return new Promise((done, failed) => {
    const req = get(url, { headers: { "accept-encoding": encoding } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 5) {
        res.resume();
        download(new URL(res.headers.location, url).href, encoding, to, redirects + 1).then(
          done,
          failed,
        );
        return;
      }
      if (code !== 200) {
        res.resume();
        return failed(new Error(`${url} answered ${code}`));
      }
      const enc = String(res.headers["content-encoding"] ?? "identity");
      if (enc !== encoding) {
        res.resume();
        return failed(new Error(`${url} came as ${enc}, not ${encoding}`));
      }
      const hash = createHash("sha256");
      let size = 0;
      res.on("data", (b) => {
        hash.update(b);
        size += b.length;
      });
      pipeline(res, createWriteStream(to)).then(
        () => done({ sha256: hash.digest("hex"), size }),
        failed,
      );
    });
    req.on("error", failed);
  });
}

async function main(argv) {
  const source = await readFile(ZETA_TS, "utf8");
  const files = zetaFilesFrom(source);
  if (argv[0] === "--list") {
    console.log(JSON.stringify({ version: versionFrom(source), files }, null, 2));
    return;
  }
  const out = argv[0];
  if (!out) throw new Error("usage: fetch.mjs <out-dir> [--only name,name] | --list");
  const only = argv[1] === "--only" ? new Set(argv[2].split(",").filter(Boolean)) : undefined;
  const want = files.filter((f) => !only || only.has(f.stored));
  const tmp = `${out}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const wrong = [];
  for (const f of want) {
    const got = await download(`${CDN}/${f.name}`, f.encoding, join(tmp, f.stored));
    const ok = got.sha256 === f.sha256 && got.size === f.size;
    console.log(
      `${ok ? "ok   " : "WRONG"} ${f.stored} ${got.size} bytes sha256 ${got.sha256}${ok ? "" : ` (expected ${f.size} bytes ${f.sha256})`}`,
    );
    if (!ok) wrong.push(f.stored);
  }
  if (wrong.length) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `ZetaOffice's CDN no longer gives the build RedGiant knows (${versionFrom(source)}): ${wrong.join(", ")} differ. ` +
        "Nothing was kept or published. Try the new build, then change ZETA_VERSION and ZETA_FILES in zeta.ts " +
        "(a new build is a new set of files, never a replacement of the published ones).",
    );
  }
  for (const f of want)
    await writeFile(join(tmp, `${f.stored}.sha256`), `${f.sha256}  ${f.stored}\n`);
  await writeFile(join(tmp, "LICENSES.txt"), licensesFrom(source));
  await rm(out, { recursive: true, force: true });
  await rename(tmp, out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
