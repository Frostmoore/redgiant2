#!/usr/bin/env node
// RedGiant OS (G39.1): the stack of a release, `redgiant-os-stack.json`. It names every image the OS
// runs, pinned for each processor by the registry's manifest digest and the image id (the config
// digest Docker reports), and carries the compose files of the release, so the OS updates RedGiant
// from one signed file (sign.mjs, the same key as release.json). Only Node's own modules.
//
//   node packaging/os/stack.mjs --version 3.7.0 --out <file> [--tag 3.7.0]
//     --tag: the redgiant2 image tag to resolve (default: the version)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const STACK_FORMAT = 1;
export const ARCHES = ["amd64", "arm64"];
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The images the OS keeps ready; the others (sandbox, engines) come down when chosen. */
export function stackImages(tag) {
  return [
    { name: "redgiant", env: "REDGIANT_IMAGE", repo: "ghcr.io/frostmoore/redgiant2", tag },
    {
      name: "postgres",
      env: "REDGIANT_POSTGRES_IMAGE",
      repo: "ghcr.io/frostmoore/redgiant2-postgres",
      tag: "17-pgvector0.8.7",
    },
  ];
}

/** The release's files the compose stack reads, relative to the repository. */
export const STACK_FILES = ["compose.yaml", "docker/egress.json", "docker/searxng/settings.yml"];

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

/** Picks each processor's manifest from an index (attestations, "unknown/unknown", left out). */
export function platformDigests(index) {
  const out = {};
  for (const m of index.manifests ?? []) {
    const p = m.platform ?? {};
    if (p.os === "linux" && ARCHES.includes(p.architecture) && !out[p.architecture])
      out[p.architecture] = m.digest;
  }
  return out;
}

/** Throws unless `s` is a stack this OS can use: the updater trusts nothing else. */
export function checkStack(s) {
  if (!s || s.format !== STACK_FORMAT) throw new Error("stack: unknown format");
  if (!/^\d+\.\d+\.\d+$/.test(s.version ?? "")) throw new Error("stack: version must be x.y.z");
  const digest = /^sha256:[0-9a-f]{64}$/;
  for (const arch of ARCHES) {
    const list = s.images?.[arch];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`stack: no images for ${arch}`);
    for (const i of list) {
      if (!/^[A-Z_]+$/.test(i.env ?? "")) throw new Error("stack: bad env name");
      if (!/^[a-z0-9.-]+(\/[a-z0-9._-]+)+:[A-Za-z0-9._-]+$/.test(i.ref ?? ""))
        throw new Error(`stack: bad image reference ${i.ref}`);
      if (!digest.test(i.digest ?? "") || !digest.test(i.id ?? ""))
        throw new Error(`stack: ${i.ref} needs its digest and id`);
    }
  }
  for (const f of Object.keys(s.files ?? {}))
    if (!STACK_FILES.includes(f)) throw new Error(`stack: unexpected file ${f}`);
  return s;
}

async function registry(repo, path, accept = ACCEPT) {
  const [host, ...rest] = repo.split("/");
  const name = rest.join("/");
  const tok = await fetch(`https://${host}/token?scope=repository:${name}:pull`);
  if (!tok.ok) throw new Error(`${repo}: token ${tok.status}`);
  const { token } = await tok.json();
  const r = await fetch(`https://${host}/v2/${name}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (!r.ok) throw new Error(`${repo} ${path}: ${r.status}`);
  return r;
}

/** Resolves the images of `tag` on the registry: per processor, manifest digest and image id. */
export async function resolveStack(version, tag = version) {
  const images = { amd64: [], arm64: [] };
  for (const img of stackImages(tag)) {
    const index = await (await registry(img.repo, `manifests/${img.tag}`)).json();
    const per = platformDigests(index);
    for (const arch of ARCHES) {
      const digest = per[arch];
      if (!digest) throw new Error(`${img.repo}:${img.tag} has no linux/${arch} image`);
      const manifest = await (await registry(img.repo, `manifests/${digest}`)).json();
      images[arch].push({
        name: img.name,
        env: img.env,
        ref: `${img.repo}:${img.tag}`,
        digest,
        id: manifest.config.digest,
        bytes: manifest.layers.reduce((n, l) => n + l.size, 0),
      });
    }
  }
  const files = {};
  for (const f of STACK_FILES) files[f] = readFileSync(`${ROOT}/${f}`, "utf8");
  return checkStack({ format: STACK_FORMAT, version, images, files });
}

if (process.argv[1]?.endsWith("stack.mjs")) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const version = arg("--version")?.replace(/^v/, "");
  const out = arg("--out");
  if (!version || !out) {
    console.error("usage: stack.mjs --version x.y.z --out <file> [--tag <redgiant2 tag>]");
    process.exit(2);
  }
  const stack = await resolveStack(version, arg("--tag", version));
  writeFileSync(out, `${JSON.stringify(stack, null, 2)}\n`);
  for (const arch of ARCHES)
    for (const i of stack.images[arch])
      console.log(`${arch} ${i.ref} ${i.digest.slice(0, 19)} ${Math.round(i.bytes / 1048576)} MB`);
}
