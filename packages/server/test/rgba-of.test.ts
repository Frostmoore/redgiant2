// PNG to RGBA (3.5.11): 8-bit RGBA comes through as it is (fast, a copy), every other kind is
// filled out as before.
import { encode } from "fast-png";
import { describe, expect, it } from "vitest";
import { rgbaOf } from "../src/convert-js.js";

describe("rgbaOf", () => {
  it("gives 8-bit RGBA back as it is, in its own copy", () => {
    const data = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
    const png = encode({ width: 2, height: 1, data, channels: 4, depth: 8 });
    const out = rgbaOf(png);
    expect([...out.data]).toEqual([...data]);
    expect(out.data.buffer).not.toBe(data.buffer);
  });

  it("fills out RGB, grey with alpha and 16-bit", () => {
    const rgb = encode({
      width: 1,
      height: 2,
      data: new Uint8Array([10, 20, 30, 40, 50, 60]),
      channels: 3,
      depth: 8,
    });
    expect([...rgbaOf(rgb).data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
    const ga = encode({
      width: 1,
      height: 1,
      data: new Uint8Array([90, 128]),
      channels: 2,
      depth: 8,
    });
    expect([...rgbaOf(ga).data]).toEqual([90, 90, 90, 128]);
    const deep = encode({
      width: 1,
      height: 1,
      data: new Uint16Array([65535, 0, 257 * 100, 65535]),
      channels: 4,
      depth: 16,
    });
    expect([...rgbaOf(deep).data]).toEqual([255, 0, 100, 255]);
  });
});
