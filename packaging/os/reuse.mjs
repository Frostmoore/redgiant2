#!/usr/bin/env node
// RedGiant OS (3.7.4): may a release attach the images an earlier os.yml run built and booted?
// Only when what they carry is the release's own: the stack they hold (redgiant-os-stack.json:
// version, every image's digest and id, the compose files) equals the one resolved now from the
// registry, and their system's files (redgiant-os-files.json) equal the ones made from the tagged
// commit. The archive of those files is checked against its manifest, blob by blob. Anything else
// and the release builds the images again (os.yml), as before. Only Node's own modules, and tar.
//
//   node packaging/os/reuse.mjs --dir <artifact dir> --version x.y.z [--source-tag <tag>]
//     --dir: holds redgiant-os-stack.json, redgiant-os-files.json, redgiant-os-files-<v>.tar.zst
//     --source-tag: compare with the branch's images (ci-<version>-<sha>) instead of the
//       release's tags (a dry run, before anything is copied)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { buildFiles, checkFiles } from "./files.mjs";
import { ARCHES, checkStack, resolveStack } from "./stack.mjs";

/** What differs between the stack an image carries and the release's (empty: the same). */
export function stackDifferences(expected, got) {
  const out = [];
  if (got?.format !== expected.format) out.push(`format ${got?.format} is not ${expected.format}`);
  if (got?.version !== expected.version)
    out.push(`version ${got?.version} is not ${expected.version}`);
  for (const arch of ARCHES) {
    const want = expected.images[arch] ?? [];
    const have = got?.images?.[arch] ?? [];
    if (want.length !== have.length) out.push(`${arch}: ${have.length} images, not ${want.length}`);
    for (const w of want) {
      const h = have.find((i) => i.name === w.name);
      if (!h) {
        out.push(`${arch}: no ${w.name}`);
        continue;
      }
      for (const k of ["env", "ref", "digest", "id"])
        if (h[k] !== w[k]) out.push(`${arch} ${w.name}: ${k} ${h[k]} is not ${w[k]}`);
    }
  }
  const files = new Set([...Object.keys(expected.files ?? {}), ...Object.keys(got?.files ?? {})]);
  for (const f of files) if (got?.files?.[f] !== expected.files?.[f]) out.push(`file ${f} differs`);
  return out;
}

/** What differs between two files manifests, the archive's own sha256 left out (empty: the same). */
export function filesDifferences(expected, got) {
  const out = [];
  if (got?.format !== expected.format) out.push(`files format ${got?.format}`);
  if (got?.version !== expected.version)
    out.push(`files version ${got?.version} is not ${expected.version}`);
  if (got?.archive?.name !== expected.archive.name) out.push(`archive ${got?.archive?.name}`);
  const key = (f) => `${f.board ?? ""}:${f.path}`;
  const have = new Map((got?.files ?? []).map((f) => [key(f), f]));
  const want = new Map(expected.files.map((f) => [key(f), f]));
  for (const [k, w] of want) {
    const h = have.get(k);
    if (!h) out.push(`no ${k}`);
    else if (JSON.stringify(h) !== JSON.stringify(w)) out.push(`${k} differs`);
  }
  for (const k of have.keys()) if (!want.has(k)) out.push(`${k} is not the release's`);
  return out;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The archive is the one its manifest names, and holds exactly the manifest's blobs. */
export function archiveDifferences(manifest, dir) {
  const file = join(dir, manifest.archive.name);
  if (!existsSync(file)) return [`no ${manifest.archive.name}`];
  const data = readFileSync(file);
  if (sha256(data) !== manifest.archive.sha256) return ["the archive is not its manifest's"];
  const stage = mkdtempSync(join(tmpdir(), "rg-os-reuse-"));
  try {
    writeFileSync(join(stage, "files.tar"), zstdDecompressSync(data));
    execFileSync("tar", ["-xf", join(stage, "files.tar"), "-C", stage]);
    const blobs = readdirSync(join(stage, "blobs"));
    const out = [];
    for (const b of blobs)
      if (sha256(readFileSync(join(stage, "blobs", b))) !== b) out.push(`blob ${b} is damaged`);
    const wanted = new Set(manifest.files.map((f) => f.sha256));
    for (const w of wanted) if (!blobs.includes(w)) out.push(`no blob ${w}`);
    for (const b of blobs) if (!wanted.has(b)) out.push(`blob ${b} is not listed`);
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("reuse.mjs")) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const dir = arg("--dir");
  const version = arg("--version")?.replace(/^v/, "");
  if (!dir || !version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: reuse.mjs --dir <dir> --version x.y.z [--source-tag <tag>]");
    process.exit(2);
  }
  const problems = [];
  try {
    const got = checkStack(JSON.parse(readFileSync(join(dir, "redgiant-os-stack.json"), "utf8")));
    const expected = await resolveStack(version, version, arg("--source-tag", ""));
    problems.push(...stackDifferences(expected, got));
  } catch (e) {
    problems.push(`stack: ${e.message}`);
  }
  try {
    const got = checkFiles(JSON.parse(readFileSync(join(dir, "redgiant-os-files.json"), "utf8")));
    const fresh = mkdtempSync(join(tmpdir(), "rg-os-files-now-"));
    try {
      problems.push(...filesDifferences(buildFiles(version, fresh), got));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
    problems.push(...archiveDifferences(got, dir));
  } catch (e) {
    problems.push(`files: ${e.message}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`not reusable: ${p}`);
    process.exit(1);
  }
  console.log(`reusable: the stack and the system's files are ${version}'s`);
}
