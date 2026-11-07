import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ensureFfmpeg, ffmpegAsset, ffmpegPath, findFfmpeg } from "../src/ffmpeg.js";
import { Jobs } from "../src/jobs.js";
import { forWhisperCpp, toWav16k } from "../src/local-voice.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("ffmpeg for voice notes (2026-11-05)", () => {
  it("knows the build of each system", () => {
    const table: [string, string, string | undefined][] = [
      ["win32", "x64", "ffmpeg-win32-x64.gz"],
      ["win32", "arm64", undefined],
      ["darwin", "arm64", "ffmpeg-darwin-arm64.gz"],
      ["darwin", "x64", "ffmpeg-darwin-x64.gz"],
      ["linux", "x64", "ffmpeg-linux-x64.gz"],
      ["linux", "arm64", "ffmpeg-linux-arm64.gz"],
      ["linux", "arm", "ffmpeg-linux-arm.gz"],
      ["freebsd", "x64", undefined],
    ];
    for (const [platform, arch, asset] of table)
      expect([platform, arch, ffmpegAsset(platform, arch)]).toEqual([platform, arch, asset]);
    expect(ffmpegPath("/d", "win32")).toBe(join("/d", "tools", "ffmpeg", "ffmpeg.exe"));
    expect(ffmpegPath("/d", "linux")).toBe(join("/d", "tools", "ffmpeg", "ffmpeg"));
  });

  it("uses REDGIANT_FFMPEG, then the PATH's, then the downloaded one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-ffmpeg-find-"));
    try {
      const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
      const data = join(dir, "data");
      const bin = join(dir, "bin");
      await mkdir(bin);
      delete process.env.REDGIANT_FFMPEG;
      expect(findFfmpeg(data, "/nowhere")).toBeUndefined();
      await mkdir(join(data, "tools", "ffmpeg"), { recursive: true });
      await writeFile(ffmpegPath(data), "");
      expect(findFfmpeg(data, "/nowhere")).toBe(ffmpegPath(data));
      await writeFile(join(bin, name), "");
      // The PATH's is taken through its links (a WinGet link): its real path (macOS: /private/var).
      expect(findFfmpeg(data, ["/nowhere", bin].join(delimiter))).toBe(
        realpathSync(join(bin, name)),
      );
      await writeFile(join(dir, "own"), "");
      process.env.REDGIANT_FFMPEG = join(dir, "own");
      expect(findFfmpeg(data, bin)).toBe(join(dir, "own"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || !ffmpegAsset())(
    "downloads this computer's build once, with its bar, and a voice note goes through it",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "rg-ffmpeg-dl-"));
      const wav = toWav16k([new Float32Array(1600)], 16000);
      await writeFile(join(dir, "ref.wav"), wav);
      // A stand-in for ffmpeg: writes the reference WAV to its last argument.
      const program = gzipSync(
        Buffer.from(
          `#!/bin/sh\nPATH=/bin:/usr/bin\nfor a; do last="$a"; done\ncp "${dir}/ref.wav" "$last"\n`,
        ),
      );
      let base = "";
      let downloads = 0;
      const server = createServer((req, res) => {
        if (req.url === "/releases/latest") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              assets: [
                { name: "ffmpeg-plan9-x64.gz", browser_download_url: `${base}/wrong` },
                { name: ffmpegAsset(), browser_download_url: `${base}/ffmpeg.gz` },
              ],
            }),
          );
        } else if (req.url === "/ffmpeg.gz") {
          downloads++;
          res.writeHead(200, { "content-length": program.length });
          res.end(program);
        } else res.writeHead(404).end();
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      process.env.REDGIANT_FFMPEG_RELEASES = `${base}/releases/latest`;
      delete process.env.REDGIANT_FFMPEG;
      // No ffmpeg on this PATH.
      process.env.PATH = join(dir, "empty");
      const data = join(dir, "data");
      const jobs = new Jobs();
      const seen: number[] = [];
      const real = jobs.start.bind(jobs);
      jobs.start = (owner, kind, steps, run, vars) =>
        real(
          owner,
          kind,
          steps,
          (h) => run({ ...h, progress: (d, t) => (seen.push(d), h.progress(d, t)) }),
          vars,
        );
      try {
        // Two voice notes at once: one download.
        const [a, b] = await Promise.all([
          ensureFfmpeg(jobs, "me", data),
          ensureFfmpeg(jobs, "me", data),
        ]);
        expect(a).toBe(ffmpegPath(data));
        expect(b).toBe(a);
        expect(downloads).toBe(1);
        expect(seen.at(-1)).toBe(program.length);
        expect(existsSync(`${ffmpegPath(data)}.part`)).toBe(false);
        expect(await readFile(ffmpegPath(data), "utf8")).toMatch(/^#!\/bin\/sh/);
        // Already here: nothing more comes down.
        expect(await ensureFfmpeg(jobs, "me", data)).toBe(a);
        expect(downloads).toBe(1);

        const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]);
        const got = await forWhisperCpp(m4a, "audio/mp4", {
          ffmpeg: () => ensureFfmpeg(jobs, "me", data),
        });
        expect(got.type).toBe("audio/wav");
        expect(Buffer.from(got.audio).equals(Buffer.from(wav))).toBe(true);
      } finally {
        server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")("says why when ffmpeg cannot come down", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-ffmpeg-fail-"));
    const server = createServer((_req, res) => res.writeHead(503).end());
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.REDGIANT_FFMPEG_RELEASES = `http://127.0.0.1:${(server.address() as { port: number }).port}/x`;
    delete process.env.REDGIANT_FFMPEG;
    process.env.PATH = join(dir, "empty");
    try {
      const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]);
      await expect(
        forWhisperCpp(m4a, "audio/mp4", {
          ffmpeg: () => ensureFfmpeg(new Jobs(), "me", join(dir, "data")),
        }),
      ).rejects.toThrow(/ffmpeg could not be downloaded/);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
