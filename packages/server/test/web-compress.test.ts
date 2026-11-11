import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  COMPRESSIBLE,
  CompressedFiles,
  compressBody,
  type Encoding,
  pickEncoding,
} from "../src/web-compress.js";

describe("the page's files compressed (3.5.11)", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["gzip, deflate, br", "br"],
    ["gzip, deflate", "gzip"],
    ["br;q=0, gzip", "gzip"],
    ["identity", undefined],
    ["*", "br"],
    ["*;q=0", undefined],
    ["deflate, GZIP;q=0.5", "gzip"],
  ] as const)("Accept-Encoding %j → %j", (accept, enc) => {
    expect(pickEncoding(accept)).toBe(enc);
  });

  it("compresses text and wasm, never pictures or archives", () => {
    for (const f of ["a.js", "a.mjs", "a.css", "index.html", "a.js.map", "x.svg", "y.wasm"])
      expect(COMPRESSIBLE.test(f)).toBe(true);
    for (const f of ["a.png", "a.woff2", "a.zip", "a.webp"])
      expect(COMPRESSIBLE.test(f)).toBe(false);
  });

  it("makes brotli and gzip that read back to the same bytes", async () => {
    const body = Buffer.from("export const x = 1;\n".repeat(500));
    const br = await compressBody(body, "br");
    const gz = await compressBody(body, "gzip");
    expect(br.length).toBeLessThan(body.length / 10);
    expect(brotliDecompressSync(br).equals(body)).toBe(true);
    expect(gunzipSync(gz).equals(body)).toBe(true);
  });

  it("compresses a file once, even for requests at the same time", async () => {
    let calls = 0;
    const files = new CompressedFiles(1000, async (b) => {
      calls++;
      return b.subarray(0, 10);
    });
    const body = Buffer.alloc(100, 1);
    const [a, b] = await Promise.all([files.get("k", "br", body), files.get("k", "br", body)]);
    expect(a).toBe(b);
    await files.get("k", "br", body);
    expect(calls).toBe(1);
    // Another encoding, another copy.
    await files.get("k", "gzip", body);
    expect(calls).toBe(2);
    expect(files.bytes).toBe(20);
  });

  it("keeps at most its cap, the least recently used out first", async () => {
    let calls = 0;
    const files = new CompressedFiles(30, async (b) => {
      calls++;
      return b;
    });
    const ten = Buffer.alloc(10);
    const enc: Encoding = "br";
    await files.get("a", enc, ten);
    await files.get("b", enc, ten);
    await files.get("c", enc, ten);
    // «a» used again: «b» is now the oldest.
    await files.get("a", enc, ten);
    await files.get("d", enc, ten);
    expect(files.bytes).toBe(30);
    expect(files.size).toBe(3);
    expect(calls).toBe(4);
    await files.get("a", enc, ten);
    expect(calls).toBe(4);
    await files.get("b", enc, ten);
    expect(calls).toBe(5);
    expect(files.bytes).toBeLessThanOrEqual(30);
  });

  it("forgets a failed compression, so the next request tries again", async () => {
    let fail = true;
    const files = new CompressedFiles(100, async (b) => {
      if (fail) throw new Error("no");
      return b;
    });
    await expect(files.get("k", "br", Buffer.alloc(5))).rejects.toThrow("no");
    fail = false;
    expect((await files.get("k", "br", Buffer.alloc(5))).length).toBe(5);
    expect(files.bytes).toBe(5);
  });
});
