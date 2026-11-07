// The flat picture of a Photoshop file (p3.3.1, the user's cover.psd): a file saved without
// "Maximize compatibility" holds only a stand-in (the background) as its composite, so the PNG
// must be drawn from the layers: positions, opacity, blend modes, masks, clipping, groups.

import { initializeCanvas, writePsdBuffer } from "ag-psd";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { blendOver, psdToOra, type Rgba, rgbaOf } from "../src/convert-js.js";

initializeCanvas(
  () => {
    throw new Error("no canvas");
  },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as never,
);

const W = 60;
const H = 90;
const solid = (r: number, g: number, b: number, a = 255, w = W, h = H) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { width: w, height: h, data };
};
/** A grey mask: white on the left half, black on the right. */
const halfMask = (w: number, h: number) => {
  const m = solid(0, 0, 0, 255, w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w / 2; x++) m.data.set([255, 255, 255, 255], (y * w + x) * 4);
  return m;
};
const text = (name: string, left: number, top: number, words: string) => ({
  name,
  left,
  top,
  imageData: solid(0, 0, 0, 255, 20, 6),
  text: { text: words, style: { font: { name: "ArialMT" }, fontSize: 12 } },
});

/** Like the user's cover.psd: 4 text layers, an empty masked layer, 2 pixel layers. */
function coverPsd(opts: { versionInfo?: boolean; real?: boolean } = {}) {
  const background = solid(255, 255, 255);
  return new Uint8Array(
    writePsdBuffer(
      {
        width: W,
        height: H,
        // Photoshop's stand-in when "Maximize compatibility" is off: just the background.
        imageData: opts.real ? solid(1, 2, 3) : background,
        ...(opts.versionInfo !== false && {
          imageResources: {
            versionInfo: {
              hasRealMergedData: opts.real ?? false,
              writerName: "Adobe Photoshop",
              readerName: "Adobe Photoshop CC",
              fileVersion: 1,
            },
          },
        }),
        children: [
          { name: "Sfondo", left: 0, top: 0, imageData: background },
          { name: "Livello 1", left: 10, top: 20, imageData: solid(255, 0, 0, 255, 30, 30) },
          {
            name: "Rettangolo 1",
            mask: {
              left: 5,
              top: 5,
              right: 25,
              bottom: 25,
              defaultColor: 0,
              imageData: halfMask(20, 20),
            },
          },
          text("Titolo", 2, 60, "Il titolo"),
          text("Autore", 2, 70, "Nome"),
          text("Editore", 30, 80, "Casa"),
          { ...text("Nascosto", 30, 2, "x"), hidden: true },
        ],
      } as never,
      { noBackground: true } as never,
    ),
  );
}

const px = (img: Rgba, x: number, y: number) => [
  ...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

describe("PSD flat picture", () => {
  it("draws the layers when the stored composite is only a stand-in", () => {
    const r = psdToOra(coverPsd(), "cover");
    const png = rgbaOf(r.files["cover.png"] as Uint8Array);
    expect([png.width, png.height]).toEqual([W, H]);
    expect(px(png, 0, 0)).toEqual([255, 255, 255, 255]); // background
    expect(px(png, 20, 30)).toEqual([255, 0, 0, 255]); // Livello 1
    expect(px(png, 5, 62)).toEqual([0, 0, 0, 255]); // a text layer
    expect(px(png, 35, 4)).toEqual([255, 255, 255, 255]); // the hidden one is not drawn
    // The ORA's merged image is the same picture, and its layers are all there.
    const ora = unzipSync(r.files["cover.ora"] as Uint8Array);
    expect(rgbaOf(ora["mergedimage.png"] as Uint8Array).data).toEqual(png.data);
    const stack = strFromU8(ora["stack.xml"] as Uint8Array);
    expect(stack.indexOf("Titolo")).toBeLessThan(stack.indexOf("Livello 1"));
    expect(stack).toContain('visibility="hidden"');
    expect(r.losses.some((l) => /Maximize compatibility/.test(l))).toBe(true);
  });

  it("recognises the stand-in even without the version record", () => {
    const png = rgbaOf(
      psdToOra(coverPsd({ versionInfo: false }), "c").files["c.png"] as Uint8Array,
    );
    expect(px(png, 20, 30)).toEqual([255, 0, 0, 255]);
  });

  it("uses the stored composite when Photoshop says it is real", () => {
    const png = rgbaOf(psdToOra(coverPsd({ real: true }), "c").files["c.png"] as Uint8Array);
    expect(px(png, 20, 30)).toEqual([1, 2, 3, 255]);
  });

  it("applies masks, clipping, opacity, groups and blend modes", () => {
    const psd = writePsdBuffer(
      {
        width: 20,
        height: 10,
        imageData: solid(9, 9, 9, 255, 20, 10),
        imageResources: {
          versionInfo: {
            hasRealMergedData: false,
            writerName: "Adobe Photoshop",
            readerName: "Adobe Photoshop CC",
            fileVersion: 1,
          },
        },
        children: [
          { name: "Grey", left: 0, top: 0, imageData: solid(128, 128, 128, 255, 20, 10) },
          // Masked: shows only on its left half (x < 5).
          {
            name: "Masked",
            left: 0,
            top: 0,
            imageData: solid(0, 0, 255, 255, 10, 10),
            mask: {
              left: 0,
              top: 0,
              right: 10,
              bottom: 10,
              defaultColor: 0,
              imageData: halfMask(10, 10),
            },
          },
          // Clipped to "Masked": green only where it shows.
          {
            name: "Clipped",
            left: 0,
            top: 0,
            imageData: solid(0, 255, 0, 255, 20, 10),
            clipping: true,
          },
          {
            name: "Group",
            opacity: 0.5,
            children: [
              {
                name: "Black multiply",
                left: 12,
                top: 0,
                imageData: solid(0, 0, 0, 255, 4, 10),
                blendMode: "multiply",
              },
            ],
          },
          {
            name: "Screen",
            left: 17,
            top: 0,
            imageData: solid(128, 0, 0, 255, 3, 10),
            blendMode: "screen",
          },
        ],
      } as never,
      { noBackground: true } as never,
    );
    const r = psdToOra(new Uint8Array(psd), "t");
    const png = rgbaOf(r.files["t.png"] as Uint8Array);
    expect(px(png, 2, 5)).toEqual([0, 255, 0, 255]); // clipped onto the visible half
    expect(px(png, 7, 5)).toEqual([128, 128, 128, 255]); // masked out: grey
    expect(px(png, 11, 5)).toEqual([128, 128, 128, 255]); // clipping stops where the base ends
    expect(px(png, 13, 5)).toEqual([64, 64, 64, 255]); // multiply black at 50%
    expect(px(png, 18, 5)).toEqual([192, 128, 128, 255]); // screen
    // In the ORA the mask is baked into the layer's pixels; clipping is named as a loss.
    const ora = unzipSync(r.files["t.ora"] as Uint8Array);
    const stack = strFromU8(ora["stack.xml"] as Uint8Array);
    const src = stack.match(/name="Masked"[^>]*src="([^"]+)"/)?.[1] as string;
    const layer = rgbaOf(ora[src] as Uint8Array);
    expect(px(layer, 2, 2)[3]).toBe(255);
    expect(px(layer, 7, 2)[3]).toBe(0);
    expect(r.losses.some((l) => l.startsWith("clipping masks drawn only"))).toBe(true);
  });

  it("blends over a transparent backdrop as the source alone", () => {
    const dst = { width: 1, height: 1, data: new Uint8Array(4) };
    blendOver(dst, { width: 1, height: 1, data: new Uint8Array([200, 100, 50, 255]) }, 0, 0, {
      mode: "multiply",
    });
    expect([...dst.data]).toEqual([200, 100, 50, 255]);
  });
});
