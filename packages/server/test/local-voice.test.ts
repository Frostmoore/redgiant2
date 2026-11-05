import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forWhisperCpp,
  oggOpusToWav,
  sniffAudio,
  toWav16k,
  webmOpusPackets,
  webmOpusToWav,
  whisperAsset,
} from "../src/local-voice.js";

// Real recordings, 1 s of a 440 Hz tone (48 kHz mono, 20 ms Opus frames), encoded with libopus
// (opusscript). tone.webm holds the same packets the way Chrome's MediaRecorder writes them:
// unknown-size Segment and Clusters.
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

/** Checks a 16 kHz mono WAV and returns its length in seconds and its tone's pitch. */
function inspect(wav: Uint8Array) {
  const b = Buffer.from(wav);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  expect(b.toString("ascii", 8, 16)).toBe("WAVEfmt ");
  expect([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)]).toEqual([
    1, 1, 16000, 16,
  ]);
  expect(b.toString("ascii", 36, 40)).toBe("data");
  const n = b.readUInt32LE(40) / 2;
  expect(b.length).toBe(44 + n * 2);
  let crossings = 0;
  for (let i = 1; i < n; i++)
    if (b.readInt16LE(42 + i * 2) < 0 !== b.readInt16LE(44 + i * 2) < 0) crossings++;
  return { seconds: n / 16000, hz: crossings / 2 / (n / 16000) };
}

describe("voice messages on this computer (RedGiant 3.0)", () => {
  it("knows whisper.cpp's ready programs", () => {
    expect(whisperAsset("win32", "x64")).toBe("whisper-bin-x64.zip");
    expect(whisperAsset("linux", "x64")).toBe("whisper-bin-ubuntu-x64.tar.gz");
    expect(whisperAsset("darwin", "arm64")).toBeUndefined();
  });

  it("turns decoded audio into the 16 kHz mono WAV whisper.cpp reads", () => {
    // One second of stereo at 48 kHz: a tone on the left, silence on the right.
    const left = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10));
    const right = new Float32Array(48000);
    const wav = Buffer.from(toWav16k([left, right], 48000));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 15)).toBe("WAVEfmt");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(16000 * 2); // one second of 16-bit samples
    // Mixed down: the tone at half its height.
    const peak = Math.max(
      ...Array.from({ length: 16000 }, (_, i) => Math.abs(wav.readInt16LE(44 + i * 2))),
    );
    expect(peak).toBeGreaterThan(15000);
    expect(peak).toBeLessThan(17000);
  });

  it("decodes a real Ogg/Opus voice note to a WAV of the right length", async () => {
    const wav = await oggOpusToWav(await fixture("tone.opus"));
    const { seconds, hz } = inspect(wav);
    expect(seconds).toBeCloseTo(1, 2);
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
  });

  it("decodes a WebM/Opus recording as browsers write it", async () => {
    const webm = await fixture("tone.webm");
    expect(webmOpusPackets(webm).packets).toHaveLength(51);
    const { seconds, hz } = inspect(await webmOpusToWav(webm));
    // WebM has no end position like Ogg's: the last frame's padding (13.5 ms here) stays.
    expect(seconds).toBeCloseTo(1.0135, 3);
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
  });

  it("recognises formats from their first bytes", async () => {
    const bytes = (...b: (number | string)[]) =>
      Buffer.concat(
        b.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.from([x]))),
      );
    expect(sniffAudio(await fixture("tone.opus"))).toBe("ogg-opus");
    expect(sniffAudio(await fixture("tone.webm"))).toBe("webm");
    expect(sniffAudio(toWav16k([new Float32Array(16)], 16000))).toBe("wav");
    expect(sniffAudio(bytes("ID3", 4, 0))).toBe("mp3");
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90))).toBe("mp3");
    expect(sniffAudio(bytes(0xff, 0xf1, 0x50))).toBe("aac"); // ADTS (Signal)
    expect(sniffAudio(bytes(0, 0, 0, 0x20, "ftypM4A "))).toBe("mp4");
    expect(sniffAudio(bytes("fLaC"))).toBe("flac");
    const vorbis = Buffer.alloc(40);
    vorbis.write("OggS", 0);
    vorbis[26] = 1;
    vorbis.write("\x01vorbis", 28, "latin1");
    expect(sniffAudio(vorbis)).toBe("ogg-vorbis");
    expect(sniffAudio(bytes(1, 2, 3))).toBe("unknown");
  });

  it("passes what whisper.cpp reads and decodes Opus without ffmpeg", async () => {
    const wav = toWav16k([new Float32Array(160)], 16000);
    const none = { ffmpeg: "/nonexistent/ffmpeg" };
    expect(await forWhisperCpp(wav, "audio/x-wav", none)).toEqual({
      audio: wav,
      type: "audio/wav",
    });
    const opus = await forWhisperCpp(await fixture("tone.opus"), "audio/ogg", none);
    expect(opus.type).toBe("audio/wav");
    expect(inspect(opus.audio).seconds).toBeCloseTo(1, 2);
    const webm = await forWhisperCpp(await fixture("tone.webm"), "audio/webm", none);
    expect(inspect(webm.audio).seconds).toBeCloseTo(1.0135, 3);
  });

  it("says when a format needs ffmpeg and there is none", async () => {
    const none = { ffmpeg: "/nonexistent/ffmpeg" };
    const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]);
    await expect(forWhisperCpp(m4a, "audio/mp4", none)).rejects.toThrow(
      /M4A\/MP4 need ffmpeg on this computer/,
    );
    await expect(forWhisperCpp(Buffer.from([0xff, 0xf1, 0x50]), "audio/aac", none)).rejects.toThrow(
      /AAC need ffmpeg/,
    );
    // WebM without Opus: not ours to decode, and no ffmpeg to fall back on.
    const vorbis = Buffer.from(
      (await fixture("tone.webm")).toString("latin1").replace("A_OPUS", "A_VORB"),
      "latin1",
    );
    await expect(forWhisperCpp(vorbis, "audio/webm", none)).rejects.toThrow(
      "This voice note could not be decoded: no Opus track (A_VORB)",
    );
  });

  it.skipIf(process.platform === "win32")(
    "converts other formats with ffmpeg when there is one",
    async () => {
      // A stand-in for ffmpeg: records its arguments and writes a WAV to the last one.
      const dir = await mkdtemp(join(tmpdir(), "rg-ffmpeg-"));
      try {
        const wav = toWav16k([new Float32Array(1600)], 16000);
        await writeFile(join(dir, "ref.wav"), wav);
        const program = join(dir, "ffmpeg");
        await writeFile(
          program,
          `#!/bin/sh\necho "$@" > "${dir}/args"\nfor a; do last="$a"; done\ncp "${dir}/ref.wav" "$last"\n`,
        );
        await chmod(program, 0o755);
        const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]);
        const got = await forWhisperCpp(m4a, "audio/mp4", { ffmpeg: program });
        expect(got.type).toBe("audio/wav");
        expect(Buffer.from(got.audio).equals(Buffer.from(wav))).toBe(true);
        expect(await readFile(join(dir, "args"), "utf8")).toMatch(/-i \S+ -vn -ar 16000 -ac 1 /);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
