#!/usr/bin/env node
// RedGiant OS (p3.7.3): the system's own files of a release, so an update brings them too, not
// only the containers. `redgiant-os-files.json` (signed with sign.mjs, the same key as
// release.json and the stack) lists every file that comes from the repository: where it goes, its
// sha256, its mode, and what the machine does after it changes (reload systemd, reload a unit,
// enable a new one). `redgiant-os-files-<version>.tar.zst` carries the contents, one blob per
// sha256 (blobs/<sha256>). redgiant-os-update apply checks both, keeps a copy of what it replaces
// and puts the old files back when something fails. Files written on the machine itself (the
// login text, avahi's settings, keys and certificates) and the administrator's settings are never
// in it. Only Node's own modules (zstd included, Node 22.15+), and tar.
//
//   node packaging/os/files.mjs --version 3.7.3 --out <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

export const FILES_FORMAT = 1;
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where the files come from: the system of every board, the container's own, the OS helper. */
const SOURCES = [{ dir: "packaging/os/rootfs" }, { dir: "packaging/os/lxc/rootfs", board: "lxc" }];
const HELPER = {
  from: "packages/server/helpers/redgiant-helper",
  path: "/usr/lib/redgiant/redgiant-helper",
};

/** In the repository but the machine's own after the first start: never replaced by an update. */
export const KEEP = [
  "/etc/issue.d/50-redgiant.issue", // written by redgiant-issue with the machine's addresses
  "/etc/redgiant-os/os.conf", // the administrator's settings
];

/** The only folders an update may write into (the updater checks the same list). */
export const ALLOWED = [
  "/usr/lib/redgiant-os/",
  "/usr/lib/redgiant/",
  "/usr/lib/systemd/system/",
  "/usr/share/redgiant-os/",
  "/etc/systemd/system/",
  "/etc/systemd/network/",
  "/etc/systemd/resolved.conf.d/",
  "/etc/avahi/services/",
  "/etc/caddy/",
  "/etc/ssh/sshd_config.d/",
  "/etc/sudoers.d/",
  "/etc/apt/apt.conf.d/",
  "/etc/docker/",
  "/etc/iwd/",
];

export const PATH_RE = /^\/(?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+$/;
export const UNIT_RE = /^[A-Za-z0-9@._-]+\.(?:service|socket|timer)$/;
export const ACTION_RE =
  /^(?:daemon-reload|network-reload|(?:reload|restart) [A-Za-z0-9@._-]+\.(?:service|socket|timer)|enable [A-Za-z0-9@._-]+\.(?:service|socket|timer))$/;
const MODES = ["0644", "0755", "0440"];

/** The mode a file gets on the machine (what setup-chroot.sh gives the image). */
export function modeOf(path) {
  if (/^\/usr\/lib\/redgiant-os\/redgiant-[^/]+$/.test(path)) return "0755";
  if (path === HELPER.path) return "0755";
  if (path.startsWith("/etc/sudoers.d/")) return "0440";
  return "0644";
}

// Units an update never restarts by itself: the stack and the updater (the update restarts
// them its own way), Docker (it would stop every container), and the ones that run once at start.
const NO_RESTART = new Set([
  "redgiant.service",
  "redgiant-os-update.service",
  "redgiant-os-check.service",
  "redgiant-growroot.service",
  "redgiant-selftest.service",
  "redgiant-ssh-keys.service",
  "redgiant-wifi-file.service",
  "redgiant-issue.service",
  "redgiant-tls.service",
  "systemd-networkd-wait-online.service",
  "docker.service",
]);

/**
 * What the machine does after `path` changes, and `enable` for the units the image enables
 * (`enabled`: setup-chroot.sh's list), done only when the unit is new on the machine. "reload"
 * is systemctl try-reload-or-restart, "restart" try-restart (for settings a reload does not
 * read again): only a unit that runs, and never a template.
 */
export function actionsOf(path, enabled = new Set()) {
  const out = [];
  const reload = (unit) => {
    if (UNIT_RE.test(unit) && !unit.includes("@.") && !NO_RESTART.has(unit))
      out.push(`reload ${unit}`);
  };
  let m = /^\/(?:usr\/lib|etc)\/systemd\/system\/([^/]+)$/.exec(path);
  if (m) {
    out.push("daemon-reload");
    if (enabled.has(m[1])) out.push(`enable ${m[1]}`);
    if (/\.(?:socket|timer)$/.test(m[1])) reload(m[1]);
    else if (m[1] === "redgiant-console.service") reload(m[1]);
    return out;
  }
  m = /^\/etc\/systemd\/system\/([^/]+)\.d\/[^/]+$/.exec(path);
  if (m) {
    out.push("daemon-reload");
    reload(m[1]);
    return out;
  }
  if (path.startsWith("/etc/systemd/network/")) return ["network-reload"];
  if (path.startsWith("/etc/systemd/resolved.conf.d/")) return ["restart systemd-resolved.service"];
  if (path.startsWith("/etc/avahi/services/")) return ["reload avahi-daemon.service"];
  if (path === "/etc/caddy/Caddyfile") return ["reload caddy.service"];
  if (path.startsWith("/etc/ssh/sshd_config.d/")) return ["reload ssh.service"];
  if (path === "/usr/lib/redgiant-os/redgiant-console") return ["reload redgiant-console.service"];
  // Scripts and the helper are read at each run; Docker, iwd and apt read theirs at the next start.
  return out;
}

/** The units setup-chroot.sh enables in the image. */
export function enabledUnits(
  text = readFileSync(join(ROOT, "packaging/os/setup-chroot.sh"), "utf8"),
) {
  const m = /systemctl enable ((?:[^\n]*\\\n)*[^\n]*)/.exec(text);
  return new Set((m?.[1] ?? "").split(/[\s\\]+/).filter((u) => UNIT_RE.test(u)));
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every file of the system that comes from the repository, with its contents. */
export function collectFiles(root = ROOT) {
  const enabled = enabledUnits(readFileSync(join(root, "packaging/os/setup-chroot.sh"), "utf8"));
  const list = [];
  const add = (path, data, board) => {
    const entry = { path, sha256: sha256(data), mode: modeOf(path) };
    if (board) entry.board = board;
    const after = [...new Set(actionsOf(path, enabled))];
    if (after.length) entry.after = after;
    list.push({ entry, data });
  };
  for (const s of SOURCES)
    for (const f of walk(join(root, s.dir))) {
      const path = `/${relative(join(root, s.dir), f).split("\\").join("/")}`;
      if (!KEEP.includes(path)) add(path, readFileSync(f), s.board);
    }
  add(HELPER.path, readFileSync(join(root, HELPER.from)));
  return list;
}

/** Throws unless `m` is a files manifest the updater may apply: it trusts nothing else. */
export function checkFiles(m) {
  if (!m || m.format !== FILES_FORMAT) throw new Error("files: unknown format");
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) throw new Error("files: version must be x.y.z");
  if (m.archive?.name !== `redgiant-os-files-${m.version}.tar.zst`)
    throw new Error("files: bad archive name");
  if (!/^[0-9a-f]{64}$/.test(m.archive?.sha256 ?? ""))
    throw new Error("files: the archive needs its sha256");
  if (!Array.isArray(m.files) || m.files.length === 0) throw new Error("files: no files");
  const seen = new Set();
  for (const f of m.files) {
    if (!PATH_RE.test(f.path ?? "") || f.path.split("/").some((p) => p === "." || p === ".."))
      throw new Error(`files: bad path ${f.path}`);
    if (!ALLOWED.some((a) => f.path.startsWith(a)))
      throw new Error(`files: ${f.path} is outside the system's folders`);
    if (KEEP.includes(f.path)) throw new Error(`files: ${f.path} belongs to the machine`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? ""))
      throw new Error(`files: ${f.path} needs its sha256`);
    if (!MODES.includes(f.mode)) throw new Error(`files: ${f.path} has a bad mode`);
    if (f.board !== undefined && !/^[a-z]+$/.test(f.board))
      throw new Error(`files: ${f.path} has a bad board`);
    for (const a of f.after ?? [])
      if (!ACTION_RE.test(a)) throw new Error(`files: bad action ${a}`);
    const key = `${f.board ?? ""}:${f.path}`;
    if (seen.has(key)) throw new Error(`files: ${f.path} twice`);
    seen.add(key);
  }
  return m;
}

/** Writes the manifest and the archive of `version` into `out`; returns the manifest. */
export function buildFiles(version, out, root = ROOT) {
  const list = collectFiles(root);
  const stage = mkdtempSync(join(tmpdir(), "rg-os-files-"));
  try {
    mkdirSync(join(stage, "blobs"));
    for (const { entry, data } of list) writeFileSync(join(stage, "blobs", entry.sha256), data);
    const name = `redgiant-os-files-${version}.tar.zst`;
    mkdirSync(out, { recursive: true });
    // The same inputs give the same archive: names sorted, fixed time and owner.
    execFileSync("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mode=a=r,u+w",
      "-C",
      stage,
      "-cf",
      join(stage, "files.tar"),
      "blobs",
    ]);
    writeFileSync(join(out, name), zstdCompressSync(readFileSync(join(stage, "files.tar"))));
    const manifest = {
      format: FILES_FORMAT,
      version,
      archive: { name, sha256: sha256(readFileSync(join(out, name))) },
      files: list.map((l) => l.entry),
    };
    checkFiles(manifest);
    writeFileSync(join(out, "redgiant-os-files.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("files.mjs")) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const version = arg("--version")?.replace(/^v/, "");
  const out = arg("--out");
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !out) {
    console.error("usage: files.mjs --version x.y.z --out <dir>");
    process.exit(2);
  }
  const m = buildFiles(version, out);
  for (const f of m.files)
    console.log(`${f.mode} ${f.board ?? "all"} ${f.path} ${(f.after ?? []).join(", ")}`);
  console.log(`${m.files.length} files, ${m.archive.name}`);
}
