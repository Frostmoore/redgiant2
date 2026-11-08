#!/usr/bin/env node
// The release's own metadata (G36.19): `release.json`, written at release time from
// `packaging/release-kind.json` and the tag, then signed with sign.mjs (the same key as the
// manifests) and attached to the release before anything else, so no launcher or server ever
// sees the release's files without it.
//
//   node packaging/update/release-info.mjs --version 3.5.0 [--kind-file packaging/release-kind.json] --out <dir>
//     → <dir>/release.json
//
// `release-kind.json` names the release its kind is for ("version"): any other tag is "normal".
// What a mandatory or breaking release says is carried by every later one (`requiredBelow`,
// `cleanInstallBelow`), so whoever skips versions still meets it. Only Node's own modules.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_INFO_FORMAT = 1;
const VERSION = /^\d+\.\d+\.\d+$/;
const KINDS = ["normal", "mandatory", "breaking"];

export function compareVersions(a, b) {
  const x = String(a).replace(/^v/, "").split(".");
  const y = String(b).replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = Number.parseInt(x[i] ?? "0", 10) || 0;
    const q = Number.parseInt(y[i] ?? "0", 10) || 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const higher = (a, b) => (!a ? b : !b ? a : compareVersions(a, b) >= 0 ? a : b);

/** Throws on anything a release must not carry: the job stops before publishing. */
export function checkKindFile(k) {
  if (!k || typeof k !== "object") throw new Error("release-kind.json: not an object");
  if (!VERSION.test(k.version ?? "")) throw new Error("release-kind.json: version must be x.y.z");
  if (!KINDS.includes(k.kind))
    throw new Error(`release-kind.json: kind must be ${KINDS.join(", ")}`);
  for (const f of ["minVersion", "requiredBelow", "cleanInstallBelow"])
    if (k[f] != null && !VERSION.test(k[f]))
      throw new Error(`release-kind.json: ${f} must be x.y.z or null`);
  if (k.minVersion != null && compareVersions(k.minVersion, k.version) > 0)
    throw new Error("release-kind.json: minVersion cannot be above version");
  if (k.kind !== "normal") {
    const n = k.note ?? {};
    if (typeof n.it !== "string" || typeof n.en !== "string" || !n.it.trim() || !n.en.trim())
      throw new Error(
        "release-kind.json: a mandatory or breaking release needs note.it and note.en",
      );
    if (n.it.length > 600 || n.en.length > 600)
      throw new Error("release-kind.json: notes up to 600 characters");
  }
}

/** The release.json of `version` from the repository's release-kind.json. */
export function releaseInfo(kindFile, version, publishedAt = new Date().toISOString()) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  checkKindFile(kindFile);
  const k = kindFile;
  let requiredBelow = k.requiredBelow ?? undefined;
  let cleanInstallBelow = k.cleanInstallBelow ?? undefined;
  // The file's own kind binds its version and every later one (carried); a file prepared for a
  // later version does not touch this one.
  const applies = compareVersions(k.version, version) <= 0;
  if (applies && k.kind === "mandatory")
    requiredBelow = higher(requiredBelow, k.minVersion ?? k.version);
  if (applies && k.kind === "breaking")
    cleanInstallBelow = higher(cleanInstallBelow, k.minVersion ?? k.version);
  const own = k.version === version;
  const out = {
    format: RELEASE_INFO_FORMAT,
    version,
    kind: own ? k.kind : "normal",
    ...(own && k.kind !== "normal" && k.minVersion && { minVersion: k.minVersion }),
    ...(own && k.kind !== "normal" && { note: { it: k.note.it.trim(), en: k.note.en.trim() } }),
    ...(requiredBelow && compareVersions(requiredBelow, version) <= 0 && { requiredBelow }),
    ...(cleanInstallBelow &&
      compareVersions(cleanInstallBelow, version) <= 0 && { cleanInstallBelow }),
    publishedAt,
  };
  return out;
}

if (process.argv[1]?.endsWith("release-info.mjs")) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const version = arg("--version");
  const out = arg("--out");
  const file = arg("--kind-file", fileURLToPath(new URL("../release-kind.json", import.meta.url)));
  if (!version || !out) {
    console.error("usage: release-info.mjs --version x.y.z --out <dir> [--kind-file <file>]");
    process.exit(2);
  }
  const info = releaseInfo(JSON.parse(readFileSync(file, "utf8")), version.replace(/^v/, ""));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "release.json"), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`release.json: ${info.version} ${info.kind}`);
}
