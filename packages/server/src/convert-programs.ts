// The outside programs conversions need (G34.3), found on this computer or downloaded only when a
// conversion needs them, with their bar (bytes, speed, time left), like ffmpeg and Git. They are
// separate programs started with execFile (no shell), never part of RedGiant's own bundle. The
// user's rule (2026-11-07): «Niente deve perdere l'impaginazione. Se c'è da scaricare qualcosa si
// scaricherà la prima volta e via».
//   - LibreOffice (MPL-2.0): Office, Apple iWork, Visio, Publisher, CorelDRAW → OpenDocument;
//     PDF → ODG/SVG; ODG → PDF. Linux AppImage (unpacked with --appimage-extract, no FUSE),
//     Windows MSI (administrative install: files only, no registry), macOS DMG (the app copied).
//   - Scribus (GPL-2.0-or-later): InDesign IDML → Scribus .sla + PDF, with its own IDML importer.
//     Linux AppImage (everything inside, even its libc: it only needs a display, Xvfb on a
//     server, and one font); Windows NSIS installer, unpacked by 7-Zip (LGPL, 1.9 MB, itself
//     unpacked from its MSI) without installing; macOS DMG.
//   - Blender (GPL-2.0-or-later): 3D files the browser cannot open → glTF; renders; the agents'
//     `blender` tool. Official portable builds: Linux tar.xz, Windows zip, macOS DMG.
//   - Ghostscript (AGPL-3.0): EPS, PostScript and old Illustrator files → PDF. Used only when it
//     is already on the computer: its builds are installers (Windows, admin rights) or a snap
//     (Linux), and it is AGPL, so RedGiant tells the person how to install it instead.
//   - ffmpeg (GPL/LGPL build): media, see ffmpeg.ts.
// Closed desktop apps (Affinity, InDesign) are never downloaded: RedGiant only finds them, to
// offer «Open in…» when no free program can read their files.

import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { agentEnv } from "@redgiant/tools";
import { ensureFfmpeg, findFfmpeg } from "./ffmpeg.js";
import type { JobHandle, Jobs } from "./jobs.js";

export type ProgramId = "libreoffice" | "scribus" | "blender" | "ghostscript" | "ffmpeg";

/** Programs RedGiant downloads and unpacks by itself (each in `<data>/tools/<id>`). */
export type Downloadable = "libreoffice" | "scribus" | "blender";
const DOWNLOADABLE: ProgramId[] = ["libreoffice", "scribus", "blender"];

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Starts a program without a shell (tests pass a fake that records the arguments). */
export type Runner = (
  file: string,
  args: string[],
  o: {
    cwd?: string;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    /** Added to the agents' environment (never the server's secrets). */
    env?: Record<string, string>;
  },
) => Promise<RunResult>;

/** The real runner: execFile, the agents' environment (never the server's secrets). */
export const execRunner: Runner = (file, args, o) =>
  new Promise((done) => {
    execFile(
      file,
      args,
      {
        ...(o.cwd && { cwd: o.cwd }),
        timeout: o.timeoutMs,
        ...(o.signal && { signal: o.signal }),
        env: { ...agentEnv(), ...o.env },
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        done({
          stdout: String(stdout),
          stderr: String(stderr || (err && code === null ? err.message : "")),
          exitCode: code,
        });
      },
    );
  });

/** What the person reads about each program (the rapport's and the docs' table too). */
export const PROGRAMS: Record<
  ProgramId,
  { name: string; license: string; size: string; install: Record<string, string> }
> = {
  libreoffice: {
    name: "LibreOffice",
    license: "MPL-2.0",
    size: "about 290-380 MB (downloaded once, only when needed)",
    install: {
      win32: "it downloads by itself; or install LibreOffice from libreoffice.org",
      darwin: "it downloads by itself; or install LibreOffice from libreoffice.org",
      linux: "it downloads by itself (x86-64); or: sudo apt install libreoffice-core-nogui",
    },
  },
  scribus: {
    name: "Scribus",
    license: "GPL-2.0-or-later",
    size: "about 125-185 MB (downloaded once, only when needed)",
    install: {
      win32: "it downloads by itself; or install Scribus from scribus.net",
      darwin: "it downloads by itself; or install Scribus from scribus.net",
      linux:
        "it downloads by itself (x86-64; on a server it needs a display: sudo apt install xvfb xauth fonts-dejavu-core); or: sudo apt install scribus",
    },
  },
  blender: {
    name: "Blender",
    license: "GPL-2.0-or-later",
    size: "about 275-410 MB (downloaded once, only when needed)",
    install: {
      win32: "it downloads by itself; or install Blender from blender.org",
      darwin: "it downloads by itself; or install Blender from blender.org",
      linux: "it downloads by itself (x86-64); or install Blender from blender.org",
    },
  },
  ghostscript: {
    name: "Ghostscript",
    license: "AGPL-3.0",
    size: "about 20-65 MB",
    install: {
      win32: "winget install ArtifexSoftware.GhostScript (or the installer from ghostscript.com)",
      darwin: "brew install ghostscript",
      linux: "sudo apt install ghostscript (or your distribution's package)",
    },
  },
  ffmpeg: {
    name: "ffmpeg",
    license: "GPL-3.0 (static build)",
    size: "about 30-80 MB",
    install: {
      win32: "it downloads by itself",
      darwin: "it downloads by itself",
      linux: "it downloads by itself",
    },
  },
};

const isWin = (p: string) => p === "win32";

export const programDir = (dataDir: string, id: Downloadable) => join(dataDir, "tools", id);
export const libreOfficeDir = (dataDir: string) => programDir(dataDir, "libreoffice");

/** Where our own download keeps the path of its program (relative to its folder). */
const MARK: Record<Downloadable, string> = {
  libreoffice: "soffice.path",
  scribus: "scribus.path",
  blender: "blender.path",
};

const listDir = (d: string) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
};

/** Where people install each program: names on the PATH and the usual folders. */
function usualPlaces(
  id: Downloadable,
  env: NodeJS.ProcessEnv,
  platform: string,
  list: (dir: string) => string[],
): { names: string[]; usual: string[] } {
  const pf = [
    env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files",
    env["ProgramFiles(x86)"] ?? "",
  ].filter(Boolean);
  // C:\Program Files\<prefix><version>\<exe>, the newest first.
  const versioned = (prefix: string, exe: string[]) =>
    pf.flatMap((root) =>
      list(root)
        .filter((n) => n.startsWith(prefix))
        .sort()
        .reverse()
        .flatMap((n) => exe.map((e) => join(root, n, e))),
    );
  if (id === "libreoffice")
    return {
      names: isWin(platform) ? ["soffice.com", "soffice.exe"] : ["soffice", "libreoffice"],
      usual: isWin(platform)
        ? pf.flatMap((d) => [
            join(d, "LibreOffice", "program", "soffice.com"),
            join(d, "LibreOffice", "program", "soffice.exe"),
          ])
        : platform === "darwin"
          ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
          : [
              "/usr/bin/soffice",
              "/usr/lib/libreoffice/program/soffice",
              "/opt/libreoffice/program/soffice",
            ],
    };
  if (id === "scribus")
    return {
      names: isWin(platform) ? ["Scribus.exe"] : ["scribus", "scribus-ng"],
      usual: isWin(platform)
        ? versioned("Scribus", ["Scribus.exe"])
        : platform === "darwin"
          ? ["/Applications/Scribus.app/Contents/MacOS/Scribus"]
          : ["/usr/bin/scribus", "/usr/local/bin/scribus"],
    };
  return {
    names: isWin(platform) ? ["blender.exe"] : ["blender"],
    usual: isWin(platform)
      ? pf.flatMap((root) =>
          list(join(root, "Blender Foundation"))
            .sort()
            .reverse()
            .map((n) => join(root, "Blender Foundation", n, "blender.exe")),
        )
      : platform === "darwin"
        ? ["/Applications/Blender.app/Contents/MacOS/Blender"]
        : ["/usr/bin/blender", "/snap/bin/blender", "/usr/local/bin/blender"],
  };
}

const ENV_NAME: Record<Downloadable, string> = {
  libreoffice: "REDGIANT_LIBREOFFICE",
  scribus: "REDGIANT_SCRIBUS",
  blender: "REDGIANT_BLENDER",
};

/** A program: its REDGIANT_* variable, our download, the PATH, then the usual install folders. */
export function findProgram(
  id: Downloadable,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = listDir,
): string | undefined {
  const own = env[ENV_NAME[id]];
  if (own && exists(own)) return own;
  const dir = programDir(dataDir, id);
  const mark = join(dir, MARK[id]);
  if (exists(mark)) {
    const p = join(dir, readFileSync(mark, "utf8").trim());
    if (exists(p)) return p;
  }
  const { names, usual } = usualPlaces(id, env, platform, list);
  const path = env.PATH ?? env.Path ?? "";
  for (const d of path.split(delimiter))
    for (const n of names) {
      const p = d && join(d, n);
      if (p && exists(p)) return p;
    }
  return usual.find((p) => exists(p));
}

/** soffice: REDGIANT_LIBREOFFICE, our download, the PATH, then the usual install folders. */
export const findLibreOffice = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
) => findProgram("libreoffice", dataDir, env, platform, exists);

/** gs: REDGIANT_GHOSTSCRIPT, the PATH, then the usual install folders. Never downloaded. */
export function findGhostscript(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = listDir,
): string | undefined {
  const own = env.REDGIANT_GHOSTSCRIPT;
  if (own && exists(own)) return own;
  const path = env.PATH ?? env.Path ?? "";
  const names = isWin(platform) ? ["gswin64c.exe", "gswin32c.exe"] : ["gs"];
  for (const d of path.split(delimiter))
    for (const n of names) {
      const p = d && join(d, n);
      if (p && exists(p)) return p;
    }
  if (isWin(platform)) {
    for (const root of [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? ""]) {
      if (!root) continue;
      // C:\Program Files\gs\gs10.08.0\bin\gswin64c.exe — the newest first.
      for (const v of list(join(root, "gs")).sort().reverse())
        for (const n of names) {
          const p = join(root, "gs", v, "bin", n);
          if (exists(p)) return p;
        }
    }
    return undefined;
  }
  return ["/opt/homebrew/bin/gs", "/usr/local/bin/gs", "/usr/bin/gs"].find((p) => exists(p));
}

/** Xvfb's wrapper, for Scribus on a Linux without a display. */
export function findXvfbRun(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  for (const d of (env.PATH ?? "").split(delimiter)) {
    const p = d && join(d, "xvfb-run");
    if (p && exists(p)) return p;
  }
  return ["/usr/bin/xvfb-run"].find((p) => exists(p));
}

// ---------------------------------------------------------------- What to download

export type PackageKind = "appimage" | "msi" | "dmg" | "nsis" | "tarxz" | "zip";

export interface ProgramAsset {
  url: string;
  kind: PackageKind;
  /** The .app inside a DMG. */
  app?: string;
}
/** Kept for the LibreOffice tests and callers. */
export type LibreOfficeAsset = ProgramAsset;

const TDF = () =>
  process.env.REDGIANT_LIBREOFFICE_MIRROR ??
  "https://download.documentfoundation.org/libreoffice/stable";
const APPIMAGE = () =>
  process.env.REDGIANT_LIBREOFFICE_APPIMAGE ??
  "https://appimages.libreitalia.org/LibreOffice-still.basic-x86_64.AppImage";

/** The package for a system and a version, if The Document Foundation builds one. */
export function libreOfficeAsset(
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
): ProgramAsset | undefined {
  const v = version;
  if (platform === "linux" && arch === "x64") return { url: APPIMAGE(), kind: "appimage" };
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    const a = arch === "x64" ? ["x86_64", "x86-64"] : ["aarch64", "aarch64"];
    return { url: `${TDF()}/${v}/win/${a[0]}/LibreOffice_${v}_Win_${a[1]}.msi`, kind: "msi" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const a = arch === "arm64" ? ["aarch64", "aarch64"] : ["x86_64", "x86-64"];
    return {
      url: `${TDF()}/${v}/mac/${a[0]}/LibreOffice_${v}_MacOS_${a[1]}.dmg`,
      kind: "dmg",
      app: "LibreOffice.app",
    };
  }
  return undefined;
}

/** Scribus's stable release (checked 2026-11-07 on SourceForge: AppImage 133 MB, Windows x64 125 MB, DMG 181-186 MB). */
export const SCRIBUS_VERSION = "1.6.7";
const SCRIBUS = () =>
  process.env.REDGIANT_SCRIBUS_MIRROR ??
  "https://downloads.sourceforge.net/project/scribus/scribus";

export function scribusAsset(
  version: string = process.env.REDGIANT_SCRIBUS_VERSION ?? SCRIBUS_VERSION,
  platform: string = process.platform,
  arch: string = process.arch,
): ProgramAsset | undefined {
  const at = `${SCRIBUS()}/${version}/scribus-${version}`;
  if (platform === "linux" && arch === "x64")
    return { url: `${at}-linux-x86_64.AppImage`, kind: "appimage" };
  // The x64 build also runs on Windows on Arm (emulated).
  if (platform === "win32" && (arch === "x64" || arch === "arm64"))
    return { url: `${at}-windows-x64.exe`, kind: "nsis" };
  if (platform === "darwin" && arch === "arm64")
    return { url: `${at}-arm64.dmg`, kind: "dmg", app: "Scribus.app" };
  if (platform === "darwin" && arch === "x64")
    return { url: `${at}.dmg`, kind: "dmg", app: "Scribus.app" };
  return undefined;
}

/**
 * Blender's builds (download.blender.org, checked 2026-11-07): 5.2.3 for Linux x64 (tar.xz,
 * 385 MB), Windows x64/arm64 (zip, 406/274 MB), macOS arm64 (DMG, 346 MB); Intel Macs stop at
 * the 4.5 LTS (4.5.15, DMG 340 MB).
 */
export const BLENDER_VERSION = "5.2.3";
export const BLENDER_INTEL_MAC = "4.5.15";
const BLENDER = () => process.env.REDGIANT_BLENDER_MIRROR ?? "https://download.blender.org/release";

export function blenderAsset(
  version: string = process.env.REDGIANT_BLENDER_VERSION ?? BLENDER_VERSION,
  platform: string = process.platform,
  arch: string = process.arch,
): ProgramAsset | undefined {
  const at = (v: string, file: string) =>
    `${BLENDER()}/Blender${v.split(".").slice(0, 2).join(".")}/blender-${v}-${file}`;
  if (platform === "linux" && arch === "x64")
    return { url: at(version, "linux-x64.tar.xz"), kind: "tarxz" };
  if (platform === "win32" && (arch === "x64" || arch === "arm64"))
    return { url: at(version, `windows-${arch}.zip`), kind: "zip" };
  if (platform === "darwin" && arch === "arm64")
    return { url: at(version, "macos-arm64.dmg"), kind: "dmg", app: "Blender.app" };
  if (platform === "darwin" && arch === "x64")
    return { url: at(BLENDER_INTEL_MAC, "macos-x64.dmg"), kind: "dmg", app: "Blender.app" };
  return undefined;
}

/** 7-Zip's MSI (LGPL-2.1, 1.9 MB): only to unpack Scribus's NSIS installer on Windows. */
export const SEVEN_ZIP_MSI = () =>
  process.env.REDGIANT_7ZIP_MSI ?? "https://www.7-zip.org/a/7z2501-x64.msi";

/** The newest stable version, from the download site's folder list ("26.8.2/"…). */
export function newestVersion(listing: string): string | undefined {
  const versions = [...listing.matchAll(/href="(\d+(?:\.\d+){1,3})\/"/g)].map(
    (m) => m[1] as string,
  );
  const key = (v: string) => v.split(".").map((n) => Number(n));
  return versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  })[versions.length - 1];
}

/** Downloads a file, telling how much came down (the job's bar). */
export async function downloadFile(
  url: string,
  file: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const r = await fetchFn(url, { signal });
  if (!r.ok || !r.body) throw new Error(`${new URL(url).host} answered ${r.status}`);
  const total = Number(r.headers.get("content-length")) || null;
  const part = `${file}.part`;
  let done = 0;
  const body = Readable.fromWeb(r.body as never);
  body.on("data", (b: Buffer) => {
    done += b.length;
    progress(done, total);
  });
  try {
    await pipeline(body, createWriteStream(part));
    await rename(part, file);
  } finally {
    await rm(part, { force: true });
  }
}

/** The first file with one of these names under `dir` (a few levels down). */
export function findUnder(dir: string, names: string[], depth = 6): string | undefined {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const e of entries) if (e.isFile() && names.includes(e.name)) return join(dir, e.name);
  if (depth === 0) return undefined;
  for (const e of entries)
    if (e.isDirectory()) {
      const got = findUnder(join(dir, e.name), names, depth - 1);
      if (got) return got;
    }
  return undefined;
}

export interface DownloadDeps {
  fetch?: typeof fetch;
  run?: Runner;
  platform?: string;
  arch?: string;
}

const check = (r: RunResult, what: string) => {
  if (r.exitCode !== 0)
    throw new Error(`${what} failed (${r.exitCode}): ${(r.stderr || r.stdout).slice(-400)}`);
};

/** 7-Zip unpacked from its MSI into `<data>/tools/7zip` (Windows only), for NSIS installers. */
async function sevenZip(dataDir: string, signal: AbortSignal, d: DownloadDeps): Promise<string> {
  const dir = join(dataDir, "tools", "7zip");
  const have = findUnder(dir, ["7z.exe"]);
  if (have) return have;
  await mkdir(dir, { recursive: true });
  const msi = join(dir, "7zip.msi");
  await downloadFile(SEVEN_ZIP_MSI(), msi, () => {}, signal, d.fetch ?? fetch);
  check(
    await (d.run ?? execRunner)("msiexec", ["/a", msi, "/qn", `TARGETDIR=${join(dir, "app")}`], {
      timeoutMs: 5 * 60_000,
      signal,
    }),
    "Unpacking 7-Zip",
  );
  await rm(msi, { force: true });
  const exe = findUnder(dir, ["7z.exe"]);
  if (!exe) throw new Error("7-Zip was unpacked but 7z.exe was not found");
  return exe;
}

/** Unpacks a downloaded package into `dir` without installing anything in the system. */
async function unpack(
  asset: ProgramAsset,
  pkg: string,
  dir: string,
  dataDir: string,
  signal: AbortSignal,
  d: DownloadDeps,
): Promise<void> {
  const run = d.run ?? execRunner;
  const long = { timeoutMs: 20 * 60_000, signal };
  switch (asset.kind) {
    case "appimage":
      await chmod(pkg, 0o755);
      check(
        await run(pkg, ["--appimage-extract"], { ...long, cwd: dir }),
        "Unpacking the AppImage",
      );
      return;
    case "msi":
      // An administrative install only unpacks the files: nothing in the registry, no admin rights.
      check(
        await run("msiexec", ["/a", pkg, "/qn", `TARGETDIR=${join(dir, "app")}`], long),
        "Unpacking the MSI",
      );
      return;
    case "nsis": {
      const z = await sevenZip(dataDir, signal, d);
      check(
        await run(z, ["x", "-y", `-o${join(dir, "app")}`, pkg], long),
        "Unpacking the installer",
      );
      return;
    }
    case "tarxz":
      check(await run("tar", ["-xJf", pkg, "-C", dir], long), "Unpacking the archive");
      return;
    case "zip":
      // Windows 10 and later carry bsdtar, which reads zip.
      check(await run("tar", ["-xf", pkg, "-C", dir], long), "Unpacking the zip");
      return;
    case "dmg": {
      const mount = join(dir, "mnt");
      const app = asset.app ?? "App.app";
      await mkdir(mount, { recursive: true });
      check(
        await run(
          "hdiutil",
          ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, pkg],
          long,
        ),
        "Opening the DMG",
      );
      try {
        check(await run("ditto", [join(mount, app), join(dir, app)], long), `Copying ${app}`);
      } finally {
        await run("hdiutil", ["detach", mount, "-force"], { timeoutMs: 60_000 });
      }
    }
  }
}

/** The program's file once unpacked. */
function unpackedProgram(id: Downloadable, dir: string, platform: string): string | undefined {
  const win = isWin(platform);
  if (id === "libreoffice")
    return platform === "darwin"
      ? join(dir, "LibreOffice.app", "Contents", "MacOS", "soffice")
      : findUnder(dir, win ? ["soffice.com", "soffice.exe"] : ["soffice"]);
  if (id === "scribus")
    return platform === "darwin"
      ? join(dir, "Scribus.app", "Contents", "MacOS", "Scribus")
      : win
        ? findUnder(dir, ["Scribus.exe"])
        : // The AppImage's own starter sets its libraries and Python up.
          findUnder(dir, ["AppRun"], 1);
  return platform === "darwin"
    ? join(dir, "Blender.app", "Contents", "MacOS", "Blender")
    : findUnder(dir, [win ? "blender.exe" : "blender"], 2);
}

/**
 * Downloads a program for this computer into `<data>/tools/<id>` and unpacks it there, without
 * installing anything in the system. Returns the program's path.
 */
export async function downloadProgram(
  id: Downloadable,
  dataDir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
  unpacking: () => void = () => {},
  d: DownloadDeps = {},
): Promise<string> {
  const platform = d.platform ?? process.platform;
  const arch = d.arch ?? process.arch;
  const f = d.fetch ?? fetch;
  let asset: ProgramAsset | undefined;
  if (id === "libreoffice") {
    let version = process.env.REDGIANT_LIBREOFFICE_VERSION;
    if (!version && platform !== "linux") {
      const listing = await (await f(`${TDF()}/`, { signal })).text();
      version = newestVersion(listing);
      if (!version) throw new Error("Could not find LibreOffice's newest version");
    }
    asset = libreOfficeAsset(version ?? "", platform, arch);
  } else if (id === "scribus") asset = scribusAsset(undefined, platform, arch);
  else asset = blenderAsset(undefined, platform, arch);
  const p = PROGRAMS[id];
  if (!asset)
    throw new Error(
      `There is no ready ${p.name} for ${platform} ${arch}: ${p.install[platform] ?? `install ${p.name}`}`,
    );
  const dir = programDir(dataDir, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const pkg = join(
    dir,
    `package.${asset.kind === "tarxz" ? "tar.xz" : asset.kind === "nsis" ? "exe" : asset.kind}`,
  );
  await downloadFile(asset.url, pkg, progress, signal, f);
  unpacking();
  await unpack(asset, pkg, dir, dataDir, signal, d);
  await rm(pkg, { force: true });
  const exe = unpackedProgram(id, dir, platform);
  if (!exe || !existsSync(exe))
    throw new Error(`${p.name} was unpacked but its program was not found`);
  await writeFile(join(dir, MARK[id]), relative(dir, exe));
  return exe;
}

/** LibreOffice for this computer (see downloadProgram). */
export const downloadLibreOffice = (
  dataDir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
  unpacking: () => void = () => {},
  d: DownloadDeps = {},
) => downloadProgram("libreoffice", dataDir, progress, signal, unpacking, d);

/** Thrown when a program is missing and RedGiant cannot get it by itself. */
export class MissingProgramError extends Error {
  constructor(
    readonly program: ProgramId,
    platform: string = process.platform,
  ) {
    const p = PROGRAMS[program];
    super(
      `${p.name} (${p.license}) is needed for this conversion and is not on this computer. To install it: ${p.install[platform] ?? p.install.linux}. Then try again.`,
    );
  }
}

/** Finds and, if needed, downloads the programs (one download at a time per program). */
export class Programs {
  private readonly pending = new Map<ProgramId, Promise<string>>();

  constructor(
    private readonly o: {
      jobs: Jobs;
      dataDir: string;
      /** Tests: what is "on this computer", and the download itself. */
      find?: (id: ProgramId) => string | undefined;
      download?: DownloadDeps;
    },
  ) {}

  /** The program, without downloading. */
  find(id: ProgramId): string | undefined {
    if (this.o.find) return this.o.find(id);
    if (id === "ghostscript") return findGhostscript();
    if (id === "ffmpeg") return findFfmpeg(this.o.dataDir);
    return findProgram(id, this.o.dataDir);
  }

  /** Whether RedGiant can get it by itself on this computer. */
  canDownload(id: ProgramId): boolean {
    if (id === "ghostscript") return false;
    if (id === "ffmpeg") return true;
    const platform = this.o.download?.platform ?? process.platform;
    const arch = this.o.download?.arch ?? process.arch;
    if (id === "libreoffice") return libreOfficeAsset("0", platform, arch) !== undefined;
    if (id === "scribus") return scribusAsset("0", platform, arch) !== undefined;
    return blenderAsset("0", platform, arch) !== undefined;
  }

  /**
   * The program, downloaded now if it is not here: as a job with its bar, or inside the job
   * `into` (its `tool_download` and `tool_unpack` steps) when one is given.
   */
  ensure(owner: string, id: ProgramId, into?: JobHandle): Promise<string> {
    const here = this.find(id);
    if (here) return Promise.resolve(here);
    if (id === "ghostscript") return Promise.reject(new MissingProgramError("ghostscript"));
    if (id === "ffmpeg")
      return ensureFfmpeg(this.o.jobs, owner, this.o.dataDir).then((p) => {
        if (!p) throw new MissingProgramError("ffmpeg");
        return p;
      });
    if (!DOWNLOADABLE.includes(id) || !this.canDownload(id))
      return Promise.reject(new MissingProgramError(id));
    const running = this.pending.get(id);
    if (running) return running;
    const fetchInto = async (h: JobHandle) => {
      h.step("tool_download");
      return downloadProgram(
        id as Downloadable,
        this.o.dataDir,
        (d, t) => h.progress(d, t),
        h.signal,
        () => h.step("tool_unpack"),
        this.o.download,
      );
    };
    const p = (async () => {
      if (into) return fetchInto(into);
      let exe = "";
      const job = this.o.jobs.start(
        owner,
        `download_${id}`,
        ["tool_download", "tool_unpack"],
        async (h) => {
          exe = await fetchInto(h);
        },
      );
      const end = await this.o.jobs.settled(job.id, 500);
      if (end?.state !== "done")
        throw new Error(end?.error?.message ?? `${PROGRAMS[id].name} did not download`);
      return exe;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }
}

// ---------------------------------------------------------------- Closed desktop apps

/** Closed apps RedGiant never downloads, only finds, for formats no free program can read. */
export type DesktopApp = "affinity" | "indesign";

/** Where Affinity (the free one by Canva, or the v1/v2 apps) and InDesign usually are. */
export function findDesktopApp(
  app: DesktopApp,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = listDir,
): string | undefined {
  if (platform === "darwin") {
    const apps = list("/Applications");
    const names =
      app === "affinity"
        ? [
            "Affinity.app",
            ...apps
              .filter((n) => /^Affinity (Designer|Photo|Publisher)( 2)?\.app$/.test(n))
              .sort()
              .reverse(),
          ]
        : apps
            .filter((n) => /^Adobe InDesign/.test(n))
            .sort()
            .reverse()
            .map((d) => join(d, `${d.replace(/\.app$/, "")}.app`));
    return names.map((n) => join("/Applications", n)).find((p) => exists(p));
  }
  if (!isWin(platform)) return undefined;
  const pf = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  if (app === "affinity") {
    const candidates = [
      join(pf, "Affinity", "Affinity", "Affinity.exe"),
      ...["Designer 2", "Photo 2", "Publisher 2", "Designer", "Photo", "Publisher"].map((n) =>
        join(pf, "Affinity", n, `${n.split(" ")[0]}.exe`),
      ),
    ];
    return candidates.find((p) => exists(p));
  }
  return list(join(pf, "Adobe"))
    .filter((n) => /^Adobe InDesign/.test(n))
    .sort()
    .reverse()
    .map((n) => join(pf, "Adobe", n, "InDesign.exe"))
    .find((p) => exists(p));
}

/** Starts a desktop app and lets it live on its own (tests pass a fake). */
export type Launcher = (file: string, args: string[]) => void;
const detached: Launcher = (file, args) => {
  const child = spawn(file, args, { detached: true, stdio: "ignore", env: agentEnv() });
  child.on("error", () => {});
  child.unref();
};

/**
 * Opens a file with a closed app on this computer (the person's «Open in Affinity»), never with a
 * shell: the app's program with the file (Windows), `open -a` (macOS).
 */
export function openInApp(
  appPath: string,
  file: string,
  platform: string = process.platform,
  launch: Launcher = detached,
): void {
  if (platform === "darwin") launch("open", ["-a", appPath, file]);
  else launch(appPath, [file]);
}
