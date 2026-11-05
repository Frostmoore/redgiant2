import { describe, expect, it } from "vitest";
import { toWav16k, whisperAsset } from "../src/local-voice.js";

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
});
