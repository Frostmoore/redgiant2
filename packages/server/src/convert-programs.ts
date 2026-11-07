// The outside programs conversions need (G34.3), found on this computer or downloaded only when a
// conversion needs them, with their bar (bytes, speed, time left), like ffmpeg and Git. They are
// separate programs started with execFile (no shell), never part of RedGiant's own bundle:
//   - LibreOffice (MPL-2.0): Office, Apple iWork, Visio, Publisher, CorelDRAW → OpenDocument;
//     PDF → ODG/SVG. Downloaded from The Document Foundation: Linux AppImage (unpacked with
//     --appimage-extract, no FUSE), Windows MSI (administrative install: files only, no registry),
//     macOS DMG (the app copied out). 220-380 MB, the biggest download RedGiant makes.
//   - Ghostscript (AGPL-3.0): EPS, PostScript and old Illustrator files → PDF. Used only when it
//     is already on the computer: its builds are installers (Windows, admin rights) or a snap
//     (Linux), and it is AGPL, so RedGiant tells the person how to install it instead.
//   - ffmpeg (GPL/LGPL build): media, see ffmpeg.ts.

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { agentEnv } from "@redgiant/tools";
import { ensureFfmpeg, findFfmpeg } from "./ffmpeg.js";
import type { JobHandle, Jobs } from "./jobs.js";

export type ProgramId = "libreoffice" | "ghostscript" | "ffmpeg";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Starts a program without a shell (tests pass a fake that records the arguments). */
export type Runner = (
  file: string,
  args: string[],
  o: { cwd?: string; timeoutMs: number; signal?: AbortSignal | undefined },
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
        env: agentEnv(),
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
    size: "about 220-380 MB (downloaded once, only when needed)",
    install: {
      win32: "it downloads by itself; or install LibreOffice from libreoffice.org",
      darwin: "it downloads by itself; or install LibreOffice from libreoffice.org",
      linux: "it downloads by itself (x86-64); or: sudo apt install libreoffice-core-nogui",
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

export const libreOfficeDir = (dataDir: string) => join(dataDir, "tools", "libreoffice");

/** Where our own download keeps the path of its soffice (relative to its folder). */
const MARK = "soffice.path";

/** soffice: REDGIANT_LIBREOFFICE, our download, the PATH, then the usual install folders. */
export function findLibreOffice(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const own = env.REDGIANT_LIBREOFFICE;
  if (own && exists(own)) return own;
  const mark = join(libreOfficeDir(dataDir), MARK);
  if (exists(mark)) {
    const p = join(libreOfficeDir(dataDir), readFileSync(mark, "utf8").trim());
    if (exists(p)) return p;
  }
  const path = env.PATH ?? env.Path ?? "";
  const names = isWin(platform) ? ["soffice.com", "soffice.exe"] : ["soffice", "libreoffice"];
  for (const d of path.split(delimiter))
    for (const n of names) {
      const p = d && join(d, n);
      if (p && exists(p)) return p;
    }
  const usual = isWin(platform)
    ? [env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? ""]
        .filter(Boolean)
        .flatMap((d) => [
          join(d, "LibreOffice", "program", "soffice.com"),
          join(d, "LibreOffice", "program", "soffice.exe"),
        ])
    : platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
      : [
          "/usr/bin/soffice",
          "/usr/lib/libreoffice/program/soffice",
          "/opt/libreoffice/program/soffice",
        ];
  return usual.find((p) => exists(p));
}

/** gs: REDGIANT_GHOSTSCRIPT, the PATH, then the usual install folders. Never downloaded. */
export function findGhostscript(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
  list: (dir: string) => string[] = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
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

export interface LibreOfficeAsset {
  url: string;
  kind: "appimage" | "msi" | "dmg";
}

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
): LibreOfficeAsset | undefined {
  const v = version;
  if (platform === "linux" && arch === "x64") return { url: APPIMAGE(), kind: "appimage" };
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) {
    const a = arch === "x64" ? ["x86_64", "x86-64"] : ["aarch64", "aarch64"];
    return { url: `${TDF()}/${v}/win/${a[0]}/LibreOffice_${v}_Win_${a[1]}.msi`, kind: "msi" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const a = arch === "arm64" ? ["aarch64", "aarch64"] : ["x86_64", "x86-64"];
    return { url: `${TDF()}/${v}/mac/${a[0]}/LibreOffice_${v}_MacOS_${a[1]}.dmg`, kind: "dmg" };
  }
  return undefined;
}

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

/**
 * Downloads LibreOffice for this computer into `<data>/tools/libreoffice` and unpacks it there,
 * without installing anything in the system. Returns soffice's path.
 */
export async function downloadLibreOffice(
  dataDir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
  unpacking: () => void = () => {},
  d: DownloadDeps = {},
): Promise<string> {
  const platform = d.platform ?? process.platform;
  const run = d.run ?? execRunner;
  const f = d.fetch ?? fetch;
  let version = process.env.REDGIANT_LIBREOFFICE_VERSION;
  if (!version && platform !== "linux") {
    const listing = await (await f(`${TDF()}/`, { signal })).text();
    version = newestVersion(listing);
    if (!version) throw new Error("Could not find LibreOffice's newest version");
  }
  const asset = libreOfficeAsset(version ?? "", platform, d.arch ?? process.arch);
  if (!asset)
    throw new Error(
      `There is no ready LibreOffice for ${platform} ${d.arch ?? process.arch}: ${PROGRAMS.libreoffice.install[platform] ?? "install LibreOffice"}`,
    );
  const dir = libreOfficeDir(dataDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const pkg = join(dir, `package.${asset.kind}`);
  await downloadFile(asset.url, pkg, progress, signal, f);
  unpacking();
  const check = (r: RunResult, what: string) => {
    if (r.exitCode !== 0)
      throw new Error(`${what} failed (${r.exitCode}): ${(r.stderr || r.stdout).slice(-400)}`);
  };
  const long = { timeoutMs: 20 * 60_000, signal };
  if (asset.kind === "appimage") {
    await chmod(pkg, 0o755);
    check(await run(pkg, ["--appimage-extract"], { ...long, cwd: dir }), "Unpacking the AppImage");
  } else if (asset.kind === "msi") {
    // An administrative install only unpacks the files: nothing in the registry, no admin rights.
    check(
      await run("msiexec", ["/a", pkg, "/qn", `TARGETDIR=${join(dir, "app")}`], long),
      "Unpacking the MSI",
    );
  } else {
    const mount = join(dir, "mnt");
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
      check(
        await run("ditto", [join(mount, "LibreOffice.app"), join(dir, "LibreOffice.app")], long),
        "Copying LibreOffice.app",
      );
    } finally {
      await run("hdiutil", ["detach", mount, "-force"], { timeoutMs: 60_000 });
    }
  }
  await rm(pkg, { force: true });
  const names = isWin(platform) ? ["soffice.com", "soffice.exe"] : ["soffice"];
  const soffice =
    platform === "darwin"
      ? join(dir, "LibreOffice.app", "Contents", "MacOS", "soffice")
      : findUnder(dir, names);
  if (!soffice || !existsSync(soffice))
    throw new Error("LibreOffice was unpacked but its soffice program was not found");
  await writeFile(join(dir, MARK), relative(dir, soffice));
  return soffice;
}

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
    if (id === "libreoffice") return findLibreOffice(this.o.dataDir);
    if (id === "ghostscript") return findGhostscript();
    return findFfmpeg(this.o.dataDir);
  }

  /** Whether RedGiant can get it by itself on this computer. */
  canDownload(id: ProgramId): boolean {
    if (id === "ghostscript") return false;
    if (id === "ffmpeg") return true;
    const platform = this.o.download?.platform ?? process.platform;
    const arch = this.o.download?.arch ?? process.arch;
    return libreOfficeAsset("0", platform, arch) !== undefined;
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
    if (!this.canDownload(id)) return Promise.reject(new MissingProgramError(id));
    const running = this.pending.get(id);
    if (running) return running;
    const fetchInto = async (h: JobHandle) => {
      h.step("tool_download");
      return downloadLibreOffice(
        this.o.dataDir,
        (d, t) => h.progress(d, t),
        h.signal,
        () => h.step("tool_unpack"),
        this.o.download,
      );
    };
    const p = (async () => {
      if (into) return fetchInto(into);
      let soffice = "";
      const job = this.o.jobs.start(
        owner,
        "download_libreoffice",
        ["tool_download", "tool_unpack"],
        async (h) => {
          soffice = await fetchInto(h);
        },
      );
      const end = await this.o.jobs.settled(job.id, 500);
      if (end?.state !== "done")
        throw new Error(end?.error?.message ?? "LibreOffice did not download");
      return soffice;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }
}
