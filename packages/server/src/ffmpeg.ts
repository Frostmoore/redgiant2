// ffmpeg for voice notes (2026-11-05, the user's decision: «si deve usare ffmpeg»). M4A/AAC
// (Signal, iPhone) and whatever the WASM decoders do not read go through it. One already on this
// computer is used as it is; otherwise a static build is downloaded once into the data folder,
// with its bar, like Git and whisper.cpp. Builds: the ffmpeg-static project's releases, one
// gzip-compressed program per system (REDGIANT_FFMPEG_RELEASES for a mirror, or a fake in tests).

import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Jobs } from "./jobs.js";

const releases = () =>
  process.env.REDGIANT_FFMPEG_RELEASES ??
  "https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest";

const exe = (platform: string) => (platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/** The release file for a system, if there is a build for it. */
export function ffmpegAsset(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const builds: Record<string, string[]> = {
    win32: ["x64"],
    darwin: ["arm64", "x64"],
    linux: ["x64", "arm64", "arm", "ia32"],
  };
  return builds[platform]?.includes(arch) ? `ffmpeg-${platform}-${arch}.gz` : undefined;
}

/** Where the downloaded ffmpeg lives. */
export const ffmpegPath = (dataDir: string, platform: string = process.platform) =>
  join(dataDir, "tools", "ffmpeg", exe(platform));

/** An ffmpeg on the PATH (the person's own). */
function onPath(path = process.env.PATH ?? process.env.Path ?? ""): string | undefined {
  for (const d of path.split(delimiter)) {
    const p = d && join(d, exe(process.platform));
    if (p && existsSync(p)) return p;
  }
  return undefined;
}

/** The ffmpeg to use, without downloading: REDGIANT_FFMPEG, the PATH's, then the downloaded one. */
export function findFfmpeg(dataDir: string, path?: string): string | undefined {
  const own = process.env.REDGIANT_FFMPEG;
  if (own && existsSync(own)) return own;
  const there = onPath(path);
  if (there) return there;
  const got = ffmpegPath(dataDir);
  return existsSync(got) ? got : undefined;
}

/** Downloads this computer's static ffmpeg into the data folder. Returns its path. */
export async function downloadFfmpeg(
  dataDir: string,
  progress: (done: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<string> {
  const asset = ffmpegAsset();
  if (!asset) throw new Error(`There is no ready ffmpeg for ${process.platform} ${process.arch}`);
  const release = (await (
    await fetch(releases(), { headers: { accept: "application/vnd.github+json" }, signal })
  ).json()) as { assets?: { name: string; browser_download_url: string }[] };
  const found = release.assets?.find((a) => a.name === asset);
  if (!found) throw new Error(`The ffmpeg release has no ${asset}`);
  const r = await fetch(found.browser_download_url, { signal });
  if (!r.ok || !r.body) throw new Error(`GitHub answered ${r.status} for ${asset}`);
  const total = Number(r.headers.get("content-length")) || null;
  const file = ffmpegPath(dataDir);
  const part = `${file}.part`;
  await mkdir(join(dataDir, "tools", "ffmpeg"), { recursive: true });
  let done = 0;
  // Counted and written from the same tick: data that flowed before the pipe would be lost.
  const body = Readable.fromWeb(r.body as never);
  // The bar counts what comes down (compressed), against the size GitHub gives.
  body.on("data", (b: Buffer) => {
    done += b.length;
    progress(done, total);
  });
  try {
    await pipeline(body, createGunzip(), createWriteStream(part));
    await chmod(part, 0o755);
    await rename(part, file);
  } finally {
    await rm(part, { force: true });
  }
  return file;
}

/**
 * ffmpeg for this computer: the one already here, or downloaded now as a job with its bar
 * (`download_ffmpeg`). Several voice notes at once share one download.
 */
let pending: Promise<string | undefined> | undefined;
export function ensureFfmpeg(
  jobs: Jobs,
  owner: string,
  dataDir: string,
): Promise<string | undefined> {
  const here = findFfmpeg(dataDir);
  if (here) return Promise.resolve(here);
  if (!ffmpegAsset()) return Promise.resolve(undefined);
  pending ??= (async () => {
    const job = jobs.start(owner, "download_ffmpeg", ["tool_download"], async (h) => {
      h.step("tool_download");
      await downloadFfmpeg(dataDir, (d, t) => h.progress(d, t), h.signal);
    });
    const end = await jobs.settled(job.id, 500);
    if (end?.state !== "done") throw new Error(end?.error?.message ?? "ffmpeg did not download");
    return ffmpegPath(dataDir);
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
