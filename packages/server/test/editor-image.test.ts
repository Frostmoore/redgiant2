// The layered picture family (G37.5): OpenRaster read and written back with its groups, masks,
// unknown attributes and entries; PNG and JPEG as one layer (flattened on save, their layers in
// an .ora copy beside); the agent's operations drawn on the server and undone exactly (the
// pixels come back byte for byte); conflicts on the same layer's pixels; the filters of the
// catalog; text from Liberation Sans; the PSD copy and export; the family in the editor's host
// (PGlite) and from end to end with a scripted model (FakeProvider).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import {
  DEFAULT_EDITOR_SETTINGS,
  type DocFile,
  type DocOp,
  IMAGE_FILTERS,
  type ImageAction,
  imageTilesOf,
  PERSON,
  runImageFilter,
  type ServerMessage,
} from "@redgiant/protocol";
import { strToU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageZip, pngOf, psdToOra, rgbaOf } from "../src/convert-js.js";
import { EditorHost } from "../src/editor/host.js";
import { imageFromAgent } from "../src/editor/image/agent.js";
import {
  blank,
  ImageBlobs,
  type ImageModel,
  type Rgba,
  readImage,
  readOra,
  writeJpeg,
  writeOra,
} from "../src/editor/image/model.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  invertAction,
} from "../src/editor/image/ops.js";
import {
  fillPolys,
  fontNamed,
  parseColor,
  rectPoly,
  textPolys,
} from "../src/editor/image/raster.js";
import { imageStructure } from "../src/editor/image/structure.js";
import {
  findKrita,
  ImageFamily,
  layersCopyOf,
  oraCopyOfOriginal,
  originalOfOraCopy,
} from "../src/editor/image-family.js";
import { imageToPsd } from "../src/editor/image-routes.js";
import { startServer, TOKEN, wsClient } from "./helpers.js";
import { memoryDb } from "./pglite.js";

let dir: string;
let blobs: ImageBlobs;

/** A w × h picture of one colour (RGBA). */
const solid = (w: number, h: number, rgba: number[]): Rgba => {
  const img = blank(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
  return img;
};
const at = (img: Rgba, x: number, y: number) => [
  ...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
];

/** An OpenRaster file with a group, a hidden layer, a mask, Krita's attributes and an entry of its own. */
function sampleOra(): Uint8Array {
  const stack = `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.5" w="64" h="48" xres="300" yres="300">
 <stack>
  <stack name="Gruppo" opacity="0.8" visibility="visible" composite-op="svg:src-over" isolation="isolate">
   <layer name="Sole" src="data/sun.png" x="10" y="8" opacity="1" visibility="visible" composite-op="svg:screen" selected="true"/>
  </stack>
  <layer name="Nascosto" src="data/hidden.png" x="0" y="0" opacity="0.5" visibility="hidden" composite-op="svg:src-over"/>
  <layer name="Sfondo" src="data/bg.png" x="0" y="0" opacity="1" visibility="visible" composite-op="svg:src-over" edit-locked="true"/>
 </stack>
</image>
`;
  return packageZip("image/openraster", {
    "stack.xml": strToU8(stack),
    "data/sun.png": pngOf(solid(16, 16, [255, 200, 0, 255])),
    "data/hidden.png": pngOf(solid(64, 48, [0, 0, 255, 255])),
    "data/bg.png": pngOf(solid(64, 48, [20, 40, 80, 255])),
    "mergedimage.png": pngOf(solid(64, 48, [0, 0, 0, 255])),
    "documentinfo.xml": strToU8("<document-info/>"),
  });
}

function agent(m: ImageModel, ops: unknown[]): ImageAction[] {
  const r = imageFromAgent(m, ops, { blobs });
  if ("error" in r) throw new Error(`${r.index}: ${r.error}`);
  return r.actions;
}
const pixelsOf = (m: ImageModel) =>
  m.layers.map((l) => ({
    id: l.id,
    name: l.name,
    x: l.x,
    y: l.y,
    w: l.px.width,
    h: l.px.height,
    opacity: l.opacity,
    visible: l.visible,
    blend: l.blend,
    data: Buffer.from(l.px.data).toString("base64"),
    mask: l.mask && { ...l.mask, img: Buffer.from(l.mask.img.data).toString("base64") },
  }));
/** Applies, inverts (through JSON, as the log keeps it) and checks the very same pixels come back. */
function roundTrip(m: ImageModel, list: ImageAction[]): ImageModel {
  let after = m;
  const inverses: ImageAction[] = [];
  for (const a of list) {
    expect(checkAction(after, a, blobs)).toBeUndefined();
    inverses.unshift(JSON.parse(JSON.stringify(invertAction(after, a, blobs))));
    after = applyAction(after, a, blobs);
  }
  let back = after;
  for (const inv of inverses) {
    expect(checkAction(back, inv, blobs)).toBeUndefined();
    back = applyAction(back, inv, blobs);
  }
  expect(pixelsOf(back)).toEqual(pixelsOf(m));
  expect([back.width, back.height]).toEqual([m.width, m.height]);
  return after;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-image-"));
  blobs = new ImageBlobs(join(dir, "data"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("files", () => {
  it("reads an OpenRaster file and writes it back with its groups, attributes and entries", () => {
    const m = readOra(sampleOra());
    expect(m.width).toBe(64);
    expect(m.layers.map((l) => [l.id, l.name, l.visible, l.locked ?? false])).toEqual([
      ["bg", "Sfondo", true, true],
      ["hidden", "Nascosto", false, false],
      ["sun", "Sole", true, false],
    ]);
    expect(m.layers[2]?.groups.map((g) => [g.name, g.opacity, g.isolate])).toEqual([
      ["Gruppo", 0.8, true],
    ]);
    expect(m.layers[2]?.extra).toEqual({ selected: "true" });
    const again = readOra(writeOra(m, blobs));
    expect(pixelsOf(again)).toEqual(pixelsOf(m));
    expect(again.layers[2]?.groups[0]?.name).toBe("Gruppo");
    expect(again.attrs).toMatchObject({ xres: "300", yres: "300" });
    const z = unzipSync(writeOra(m, blobs));
    expect(Object.keys(z)[0]).toBe("mimetype");
    expect(new TextDecoder().decode(z["documentinfo.xml"])).toBe("<document-info/>");
    expect(new TextDecoder().decode(z["stack.xml"])).toContain('selected="true"');
    // The merged picture: the background, the sun screened at 80% inside the group.
    const merged = rgbaOf(z["mergedimage.png"] as Uint8Array);
    expect(at(merged, 0, 0)).toEqual([20, 40, 80, 255]);
    expect(at(merged, 12, 10)[0]).toBeGreaterThan(200);
  });

  it("opens a PNG and a JPEG as one layer; the family writes them flattened, layers in a copy", async () => {
    const png = pngOf(solid(8, 6, [10, 20, 30, 255]));
    const m = readImage(png);
    expect(m).toMatchObject({ format: "png", width: 8, height: 6 });
    expect(m.layers).toHaveLength(1);
    const jpg = writeJpeg(solid(8, 6, [200, 100, 50, 255]));
    const j = readImage(jpg);
    expect(j.format).toBe("jpeg");
    expect(Math.abs((at(j.layers[0]?.px as Rgba, 3, 3)[0] as number) - 200)).toBeLessThan(6);
    const fam = new ImageFamily({ dataDir: join(dir, "data") });
    expect(() => fam.load(png, "a.ora")).toThrow(/not an OpenRaster/);
    expect(() => fam.load(sampleOra(), "a.png")).toThrow(/zip/);
    expect(fam.accepts("x.PNG") && fam.accepts("y.jpeg") && fam.accepts("z.ora")).toBe(true);
    expect(fam.accepts("x.psd")).toBe(false);
    expect(layersCopyOf("img/a.png")).toBe("img/a.png.open/a.ora");
    expect(oraCopyOfOriginal("art/p.psd")).toBe("art/p.psd.open/p.ora");
    expect(originalOfOraCopy("art/p.psd.open/p.ora")).toBe("art/p.psd");
    expect(originalOfOraCopy("img/a.png.open/a.ora")).toBe("img/a.png");
    expect(originalOfOraCopy("x/other.ora")).toBeUndefined();
  });

  it("a PSD's copy opens with its layers, and the picture exports back to a PSD", () => {
    const m = readOra(sampleOra());
    const psd = imageToPsd(m);
    const ora = psdToOra(psd, "p").files["p.ora"] as Uint8Array;
    const back = readImage(ora);
    expect(back.layers.map((l) => l.name)).toEqual(["Sfondo", "Nascosto", "Sole"]);
    expect(back.layers[2]?.groups[0]?.name).toBe("Gruppo");
    expect(at(back.layers[0]?.px as Rgba, 5, 5)).toEqual([20, 40, 80, 255]);
  });
});

describe("the agent's operations", () => {
  const base = () => readOra(sampleOra());

  it("adds a generated picture as a layer (fit), duplicates, moves, sets, merges down: undone exactly", () => {
    const m = base();
    const pic = blobs.put(pngOf(solid(32, 16, [0, 255, 0, 255])));
    const a1 = agent(m, [
      {
        op: "add_layer",
        name: "Generata",
        image: "out/gen.png",
        picture: { blob: pic },
        fit: "contain",
      },
      { op: "set_layer", layer: "Generata", opacity: 60, blend: "multiply" },
    ]);
    const m1 = roundTrip(m, a1);
    const g = m1.layers.at(-1);
    expect(g).toMatchObject({ name: "Generata", opacity: 0.6, blend: "svg:multiply", x: 0, y: 8 });
    expect([g?.px.width, g?.px.height]).toEqual([64, 32]);
    const m2 = roundTrip(
      m1,
      agent(m1, [
        { op: "duplicate_layer", layer: "Generata" },
        { op: "move_layer", layer: "Generata", to: "bottom" },
      ]),
    );
    expect(m2.layers[0]?.name).toBe("Generata");
    expect(m2.layers.at(-1)?.name).toBe("Generata copy");
    const m3 = roundTrip(m2, agent(m2, [{ op: "merge_down", layer: "Sole" }]));
    expect(m3.layers.some((l) => l.name === "Sole")).toBe(false);
    expect(() => agent(m, [{ op: "set_layer", layer: "nessuno", opacity: 1 }])).toThrow(
      /no layer «nessuno»/,
    );
  });

  it("draws shapes and strokes, fills and clears areas: only the changed tiles travel", () => {
    let m = base();
    m = roundTrip(m, agent(m, [{ op: "add_layer", name: "Disegno" }]));
    const acts = agent(m, [
      {
        op: "draw",
        layer: "Disegno",
        shape: "rect",
        x: 4,
        y: 4,
        w: 20,
        h: 10,
        fill: "#ff0000",
        stroke: "#000",
        stroke_width: 2,
      },
      {
        op: "draw",
        layer: "Disegno",
        shape: "ellipse",
        x: 30,
        y: 10,
        w: 20,
        h: 20,
        fill: "rgba(0,0,255,0.5)",
      },
      {
        op: "stroke",
        layer: "Disegno",
        points: [
          [2, 40],
          [60, 44],
        ],
        color: "#00ff00",
        size: 3,
      },
      { op: "fill", layer: "Disegno", area: { rect: [50, 0, 10, 10] }, color: "yellow" },
      { op: "clear", layer: "Disegno", area: { ellipse: [8, 6, 6, 6] } },
    ]);
    const after = roundTrip(m, acts);
    const px = after.layers.at(-1)?.px as Rgba;
    expect(at(px, 20, 8)).toEqual([255, 0, 0, 255]);
    expect(at(px, 40, 20).slice(0, 3)).toEqual([0, 0, 255]);
    expect(at(px, 11, 9)[3]).toBe(0);
    expect(at(px, 55, 5)).toEqual([255, 255, 0, 255]);
    const batch = acts[0] as Extract<ImageAction, { t: "batch" }>;
    expect(batch.t).toBe("batch");
    for (const a of batch.ops)
      if (a.t === "tiles") for (const t of a.tiles) expect(t.w).toBeLessThanOrEqual(256);
    // A layer of the base is locked.
    expect(() => agent(m, [{ op: "fill", layer: "Sfondo", color: "#fff" }])).toThrow(/locked/);
  });

  // p3.5.6: the page's Move with a selection moves only the selected pixels; the agent too.
  it("moves only an area's pixels, the layer staying where it is (grown to hold them)", () => {
    const m = base();
    const acts = agent(m, [
      { op: "transform", layer: "Sole", area: { rect: [10, 8, 8, 8] }, dx: 20, dy: 0 },
    ]);
    expect(acts[0]).toMatchObject({ t: "pixels", layer: "sun", x: 10, y: 8, w: 28, h: 16 });
    const after = roundTrip(m, acts);
    const sun = after.layers.find((l) => l.id === "sun") as (typeof after.layers)[number];
    const pick = (x: number, y: number) => at(sun.px, x - sun.x, y - sun.y);
    expect(pick(32, 10)).toEqual([255, 200, 0, 255]);
    expect(pick(12, 10)[3]).toBe(0);
    expect(pick(20, 10)).toEqual([255, 200, 0, 255]);
    expect(pick(12, 20)).toEqual([255, 200, 0, 255]);
    // Inside the layer: only the tiles that changed.
    const inPlace = agent(m, [
      { op: "transform", layer: "Sole", area: { rect: [10, 8, 4, 4] }, dx: 4, dy: 4 },
    ]);
    expect(inPlace[0]).toMatchObject({ t: "tiles", layer: "sun" });
    expect(() =>
      agent(m, [{ op: "transform", layer: "Sole", area: { rect: [0, 0, 4, 4] }, scale: 2 }]),
    ).toThrow(/only moves/);
    expect(() =>
      agent(m, [{ op: "transform", layer: "Sole", area: { rect: [0, 0, 4, 4] }, dx: 3 }]),
    ).toThrow(/outside the layer/);
  });

  it("grows a layer when a drawing goes beyond it", () => {
    const m = base();
    const acts = agent(m, [
      { op: "draw", layer: "Sole", shape: "rect", x: 0, y: 0, w: 4, h: 4, fill: "#fff" },
    ]);
    expect(acts[0]).toMatchObject({ t: "pixels", layer: "sun", x: 0, y: 0, w: 26, h: 24 });
    roundTrip(m, acts);
  });

  it("applies every filter of the catalog (in an area too), transforms, crops and resizes", () => {
    const m = base();
    // A gradient, so that every filter changes something.
    const grad = blank(64, 48);
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++)
        grad.data.set([x * 4, y * 5, (x * y) % 256, 255], (y * 64 + x) * 4);
    const g = { ...m, layers: m.layers.map((l) => (l.id === "hidden" ? { ...l, px: grad } : l)) };
    for (const f of IMAGE_FILTERS)
      roundTrip(
        g,
        agent(g, [
          {
            op: "filter",
            layer: "Nascosto",
            name: f.id,
            area: { rect: [0, 0, 30, 30] },
            brightness: 20,
            contrast: 15,
            hue: 40,
            saturation: 30,
          },
        ]),
      );
    const inv = roundTrip(m, agent(m, [{ op: "filter", layer: "Nascosto", name: "invert" }]));
    expect(at(inv.layers[1]?.px as Rgba, 40, 40)).toEqual([255, 255, 0, 255]);
    const t = roundTrip(m, agent(m, [{ op: "transform", layer: "Sole", rotate: 45, scale: 2 }]));
    expect(t.layers[2]?.px.width).toBeGreaterThan(40);
    const moved = roundTrip(m, agent(m, [{ op: "transform", layer: "Sole", dx: 5, dy: -3 }]));
    expect([moved.layers[2]?.x, moved.layers[2]?.y]).toEqual([15, 5]);
    const flipped = roundTrip(
      m,
      agent(m, [{ op: "transform", layer: "Sole", flip: "horizontal" }]),
    );
    expect(flipped.layers[2]?.px.width).toBe(16);
    const c = roundTrip(m, agent(m, [{ op: "crop", x: 8, y: 4, w: 32, h: 20 }]));
    expect([c.width, c.height, c.layers[2]?.x, c.layers[2]?.y]).toEqual([32, 20, 2, 4]);
    const cv = roundTrip(
      m,
      agent(m, [{ op: "resize_canvas", width: 100, height: 48, anchor: "right" }]),
    );
    expect(cv.layers[0]?.x).toBe(36);
    // Every layer scaled: one locked is refused.
    expect(() => agent(m, [{ op: "resize_image", width: 32 }])).toThrow(/locked/);
    const unlocked = applyAction(
      m,
      agent(m, [{ op: "set_layer", layer: "Sfondo", locked: false }])[0] as ImageAction,
      blobs,
    );
    const r = roundTrip(unlocked, agent(unlocked, [{ op: "resize_image", width: 32 }]));
    expect([r.width, r.height, r.layers[0]?.px.width]).toEqual([32, 24, 32]);
  });

  it("writes text with Liberation Sans as a new layer, and masks a layer", () => {
    const m = base();
    const t = roundTrip(
      m,
      agent(m, [
        {
          op: "add_text",
          text: "Ab\nc",
          x: 4,
          y: 4,
          size: 14,
          color: "#ffffff",
          font: "sans-bold",
        },
      ]),
    );
    const tl = t.layers.at(-1);
    expect(tl?.name).toBe("Ab");
    expect(tl?.px.width).toBeGreaterThan(12);
    expect([...(tl?.px.data ?? [])].some((v, i) => i % 4 === 3 && v === 255)).toBe(true);
    const mk = roundTrip(
      m,
      agent(m, [{ op: "add_mask", layer: "Nascosto", area: { ellipse: [0, 0, 64, 48] } }]),
    );
    const mask = mk.layers[1]?.mask;
    expect(mask?.img.data[(24 * 64 + 32) * 4]).toBe(255);
    expect(mask?.img.data[0]).toBe(0);
    const painted = roundTrip(
      mk,
      agent(mk, [{ op: "fill", layer: "Nascosto", target: "mask", area: { rect: [0, 0, 4, 4] } }]),
    );
    expect(painted.layers[1]?.mask?.img.data[0]).toBe(255);
    const baked = roundTrip(mk, agent(mk, [{ op: "apply_mask", layer: "Nascosto" }]));
    expect(baked.layers[1]?.mask).toBeUndefined();
    expect(at(baked.layers[1]?.px as Rgba, 0, 0)[3]).toBe(0);
    roundTrip(mk, agent(mk, [{ op: "delete_mask", layer: "Nascosto" }]));
  });

  it("refuses what it cannot do, with the reason", () => {
    const m = base();
    const r = imageFromAgent(m, [{ op: "filter", layer: "Sole", name: "glow" }], { blobs });
    expect(r).toMatchObject({ index: 0, error: expect.stringMatching(/no filter «glow»/) });
    expect(imageFromAgent(m, [{ op: "nope" }], { blobs })).toMatchObject({
      error: expect.stringMatching(/no operation/),
    });
    expect(
      imageFromAgent(m, [{ op: "draw", layer: "Sole", shape: "rect", x: 0, y: 0, w: 2, h: 2 }], {
        blobs,
      }),
    ).toMatchObject({ error: expect.stringMatching(/fill.*stroke/) });
    expect(
      checkAction(
        m,
        { t: "tiles", layer: "sun", tiles: [{ x: 10, y: 10, w: 10, h: 10, png: "0".repeat(64) }] },
        blobs,
      ),
    ).toMatch(/goes beyond/);
    expect(checkAction(m, { t: "remove", layer: "x" }, blobs)).toMatch(/no layer/);
  });

  it("lists the layers for the agent", () => {
    const s = imageStructure(readOra(sampleOra()), {});
    expect(s.split("\n")[0]).toBe("OpenRaster picture 64×48 px, 3 layers (top first).");
    expect(s).toContain(
      '1. layer "sun" «Sole», at 10,8 size 16×16, opacity 100%, blend screen, visible, in group «Gruppo», pixels in [10 8 16 16], average colour #ffc800',
    );
    expect(s).toContain("hidden");
    expect(s).toContain("locked");
  });
});

describe("conflicts, filters, drawing", () => {
  it("the same layer's same tiles conflict; other tiles, other layers and other properties do not", () => {
    const tile = (x: number) => ({
      t: "tiles" as const,
      layer: "a",
      tiles: [{ x, y: 0, w: 10, h: 10, png: "0".repeat(64) }],
    });
    expect(actionsConflict(tile(0), tile(5))).toBe(true);
    expect(actionsConflict(tile(0), tile(20))).toBe(false);
    expect(actionsConflict(tile(0), { ...tile(0), layer: "b" })).toBe(false);
    expect(
      actionsConflict(
        { t: "props", layer: "a", set: { opacity: 1 } },
        { t: "props", layer: "a", set: { name: "x" } },
      ),
    ).toBe(false);
    expect(
      actionsConflict(
        { t: "props", layer: "a", set: { x: 1 } },
        { t: "props", layer: "a", set: { y: 2 } },
      ),
    ).toBe(true);
    expect(actionsConflict({ t: "remove", layer: "a" }, tile(0))).toBe(true);
    expect(
      actionsConflict(
        { t: "canvas", width: 1, height: 1, dx: 0, dy: 0 },
        { t: "props", layer: "z", set: { name: "q" } },
      ),
    ).toBe(true);
    expect(imageTilesOf(250, 0, 20, 300)).toEqual([
      { x: 250, y: 0, w: 6, h: 256 },
      { x: 256, y: 0, w: 14, h: 256 },
      { x: 250, y: 256, w: 6, h: 44 },
      { x: 256, y: 256, w: 14, h: 44 },
    ]);
  });

  it("filters keep the size and transparency, and give the same pixels twice", () => {
    const img = solid(9, 7, [120, 60, 30, 200]);
    for (const f of IMAGE_FILTERS) {
      const a = runImageFilter(f.id, img.data, 9, 7, {});
      expect(a.length).toBe(img.data.length);
      expect(runImageFilter(f.id, img.data, 9, 7, {})).toEqual(a);
    }
    const inv = runImageFilter("invert", img.data, 9, 7);
    expect([...inv.subarray(0, 4)]).toEqual([135, 195, 225, 200]);
    expect([...runImageFilter("grayscale", img.data, 9, 7).subarray(0, 4)]).toEqual([
      71, 71, 71, 200,
    ]);
    expect(() => runImageFilter("x", img.data, 9, 7)).toThrow(/no filter/);
  });

  it("fills polygons with anti-aliased edges, reads colours and a TrueType font", () => {
    const c = fillPolys([rectPoly(1.5, 1, 3, 2)], { x: 0, y: 0, w: 10, h: 10 });
    expect(c?.a[0 * (c?.w ?? 0) + 0]).toBeCloseTo(0.5);
    expect(c?.a[1]).toBe(1);
    expect(parseColor("#f80")).toEqual([255, 136, 0, 255]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
    expect(parseColor("teal")).toEqual([0, 128, 128, 255]);
    expect(parseColor("nope")).toBeUndefined();
    const f = fontNamed("sans");
    expect(f.unitsPerEm).toBe(2048);
    const t = textPolys(f, "Àb", 20, 0, 0);
    expect(t.polys.length).toBeGreaterThan(3);
    expect(t.w).toBeGreaterThan(15);
  });

  it("finds Krita where it is installed", () => {
    const has = (list: string[]) => (p: string) => list.includes(p);
    expect(findKrita("darwin", {}, has(["/Applications/krita.app"]))).toBe(
      "/Applications/krita.app",
    );
    expect(
      findKrita(
        "win32",
        { ProgramFiles: "C:\\Program Files" },
        has(["C:\\Program Files\\Krita (x64)\\bin\\krita.exe"]),
      ),
    ).toBe("C:\\Program Files\\Krita (x64)\\bin\\krita.exe");
    expect(findKrita("linux", { PATH: "/usr/bin:/opt/x" }, has(["/opt/x/krita"]))).toBe(
      "/opt/x/krita",
    );
    expect(
      findKrita("linux", { PATH: "/usr/bin", HOME: "/h" }, has([]), (d) =>
        d === "/var/lib/flatpak/exports/bin" ? ["org.kde.krita"] : [],
      ),
    ).toBe("/var/lib/flatpak/exports/bin/org.kde.krita");
    expect(findKrita("linux", { PATH: "/usr/bin" }, has([]), () => [])).toBeUndefined();
  });
});

// ---- in the host ----------------------------------------------------------------------------

describe("a picture in the editor's host", () => {
  let store: EventStore;
  let hosts: EditorHost[] = [];
  let fam: ImageFamily;
  const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };
  const BOB = { id: "bob", name: "Bob", sessionId: "s-bob" };
  beforeEach(async () => {
    await mkdir(join(dir, "ws"), { recursive: true });
    const { db } = await memoryDb();
    await migrate(db);
    store = new EventStore(db);
    fam = new ImageFamily({ dataDir: join(dir, "data") });
  });
  afterEach(async () => {
    for (const h of hosts) await h.close();
    hosts = [];
  });
  const host = () => {
    const h = new EditorHost({
      store,
      dataDir: join(dir, "data"),
      resolve: async (_o, f) => join(dir, "ws", f.path),
      settings: () => DEFAULT_EDITOR_SETTINGS,
      families: [fam],
      saveDelayMs: 60_000,
      watchMs: 0,
    });
    hosts.push(h);
    return h;
  };
  const opsOf = (m: ImageModel, list: unknown[]): DocOp[] => {
    const r = fam.fromAgent(m, list);
    if ("error" in r) throw new Error(r.error);
    return r.ops;
  };

  it("the agent and the person on a PNG: tiles, a conflict refused, undone, saved flattened with an .ora copy, rebuilt", async () => {
    const file: DocFile = { scope: "platform", path: "foto.png" };
    const png = pngOf(solid(300, 40, [200, 200, 200, 255]));
    await writeFile(join(dir, "ws", "foto.png"), png);
    const h = host();
    const read = await h.read("me", file);
    const m0 = read.model as ImageModel;
    // The person paints a tile, as the page sends it (a blob first).
    const tile = await h.putBlob(pngOf(solid(10, 10, [255, 0, 0, 255])));
    const r1 = await h.apply("me", file, {
      author: { id: PERSON },
      baseRevision: 0,
      ops: [
        {
          family: "image",
          engine: "redgiant-raster",
          engineVersion: "1",
          op: {
            t: "tiles",
            layer: "image",
            tiles: [{ x: 0, y: 0, w: 10, h: 10, png: tile }],
            what: "paint",
          },
        },
      ],
      groupId: "g1",
    });
    expect(r1).toMatchObject({
      ok: true,
      revision: 1,
      summary: { image: { action: "paint", n: 1, layer: "Background" } },
    });
    // Ada, on revision 0, on the same pixels: refused; on others: moved over.
    const r2 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: opsOf(m0, [{ op: "fill", layer: "image", area: { rect: [0, 0, 4, 4] }, color: "#000" }]),
      groupId: "t1",
    });
    expect(r2).toMatchObject({ ok: false, code: "conflict" });
    const r3 = await h.apply("me", file, {
      author: BOB,
      baseRevision: 0,
      ops: opsOf(m0, [
        { op: "fill", layer: "image", area: { rect: [280, 0, 10, 10] }, color: "#00f" },
      ]),
      groupId: "t2",
    });
    expect(r3).toMatchObject({
      ok: true,
      revision: 2,
      rebased: true,
      summary: { image: { action: "fill" } },
    });
    // A layer added: the PNG gets an .ora copy with the layers.
    const m2 = (await h.read("me", file)).model as ImageModel;
    const r4 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 2,
      ops: opsOf(m2, [{ op: "add_text", text: "Ciao", x: 100, y: 5, size: 20, color: "#000" }]),
      groupId: "t3",
    });
    expect(r4).toMatchObject({ ok: true, revision: 3, summary: { image: { action: "text" } } });
    await h.flush();
    const flat = rgbaOf(new Uint8Array(await readFile(join(dir, "ws", "foto.png"))));
    expect([flat.width, flat.height]).toEqual([300, 40]);
    expect(at(flat, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(at(flat, 285, 5)).toEqual([0, 0, 255, 255]);
    const copy = readOra(
      new Uint8Array(await readFile(join(dir, "ws", "foto.png.open", "foto.ora"))),
    );
    expect(copy.layers.map((l) => l.name)).toEqual(["Background", "Ciao"]);
    // «Annulla questa modifica» on the person's tile, not the last.
    const u = await h.undo("me", file, { revision: 1 }, { id: PERSON });
    expect(u).toMatchObject({ ok: true, revision: 4 });
    await h.undo("me", file, { revision: 3 }, { id: PERSON });
    await h.undo("me", file, { revision: 2 }, { id: PERSON });
    await h.flush();
    const back = rgbaOf(new Uint8Array(await readFile(join(dir, "ws", "foto.png"))));
    expect(
      Buffer.from(back.data).equals(Buffer.from(solid(300, 40, [200, 200, 200, 255]).data)),
    ).toBe(true);
    // A new host rebuilds from the log and the disk.
    const again = await host().read("me", file);
    expect(again.revision).toBe(6);
  });

  it("the person undoes the agent's layer, text, blur and mask one by one, the latest first and not (p3.5.6)", async () => {
    const file: DocFile = { scope: "platform", path: "quadro.png" };
    await writeFile(join(dir, "ws", "quadro.png"), pngOf(solid(64, 48, [200, 200, 200, 255])));
    const h = host();
    const step = async (list: unknown[]) => {
      const r = await h.read("me", file);
      const out = await h.apply("me", file, {
        author: ADA,
        baseRevision: r.revision,
        ops: opsOf(r.model as ImageModel, list),
        groupId: "t-ada",
      });
      expect(out).toMatchObject({ ok: true });
      return out.revision;
    };
    const layer = await step([{ op: "add_layer", name: "Sopra" }]);
    const text = await step([
      { op: "add_text", layer: "Sopra", text: "Ciao", x: 4, y: 4, size: 16, color: "#000" },
    ]);
    const blur = await step([{ op: "filter", layer: "Sopra", name: "blur", radius: 2 }]);
    const mask = await step([
      { op: "add_mask", layer: "Sopra", area: { ellipse: [0, 0, 32, 24] } },
    ]);
    // The blur first (not the last), then the rest from the latest.
    expect(await h.undo("me", file, { revision: blur }, { id: PERSON })).toMatchObject({
      ok: true,
    });
    expect(await h.undo("me", file, { revision: mask }, { id: PERSON })).toMatchObject({
      ok: true,
    });
    expect(await h.undo("me", file, { revision: text }, { id: PERSON })).toMatchObject({
      ok: true,
    });
    expect(await h.undo("me", file, { revision: layer }, { id: PERSON })).toMatchObject({
      ok: true,
    });
    const end = (await h.read("me", file)).model as ImageModel;
    expect(imageStructure(end, {})).not.toContain("Sopra");
  });

  it("an OpenRaster file keeps its layers on disk, and a change from outside can be undone", async () => {
    const file: DocFile = { scope: "platform", path: "art/p.ora" };
    await mkdir(join(dir, "ws", "art"), { recursive: true });
    await writeFile(join(dir, "ws", "art", "p.ora"), sampleOra());
    const h = host();
    const m = (await h.read("me", file)).model as ImageModel;
    await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: opsOf(m, [{ op: "set_layer", layer: "Sole", name: "Sun", visible: false }]),
      groupId: "t",
    });
    await h.flush();
    const disk = readOra(new Uint8Array(await readFile(join(dir, "ws", "art", "p.ora"))));
    expect(disk.layers[2]).toMatchObject({ name: "Sun", visible: false });
    // Another program changes a layer's pixels: kept as its difference.
    const other = {
      ...disk,
      layers: disk.layers.map((l, i) =>
        i === 1 ? { ...l, px: solid(64, 48, [1, 2, 3, 255]) } : l,
      ),
    };
    await writeFile(join(dir, "ws", "art", "p.ora"), writeOra(other, blobs));
    const read = await h.read("me", file);
    expect(read.revision).toBe(2);
    const u = await h.undo("me", file, { revision: 2 }, { id: PERSON });
    expect(u).toMatchObject({ ok: true });
    await h.flush();
    const after = readOra(new Uint8Array(await readFile(join(dir, "ws", "art", "p.ora"))));
    expect(at(after.layers[1]?.px as Rgba, 0, 0)).toEqual([0, 0, 255, 255]);
  });
});

// ---- from end to end ----------------------------------------------------------------------

type Req = { messages: { role: string; parts: { type: string; content?: string }[] }[] };
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

describe("a picture from end to end (FakeProvider)", () => {
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("help, structure, a generated picture put in as a layer, the page told, the file written", async () => {
    const seen: string[] = [];
    const file = { scope: "platform", path: "art/poster.ora" };
    s = await startServer(
      calls(
        [
          { name: "canvas_edit", input: { path: file.path, help: true } },
          { name: "canvas_look", input: { path: file.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              ops: [
                {
                  op: "add_layer",
                  name: "Generata",
                  image: "art/gen.png",
                  fit: "cover",
                  blend: "multiply",
                },
                { op: "filter", layer: "Generata", name: "grayscale" },
              ],
            },
          },
          {
            name: "canvas_edit",
            input: { path: file.path, ops: [{ op: "delete_layer", layer: "nope" }] },
          },
        ],
        seen,
      ) as never,
      { contextWindow: 65_536 },
      { editor: { saveDelayMs: 0, watchMs: 0 } },
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sessionId = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), sampleOra());
    await writeFile(join(root, "art", "gen.png"), pngOf(solid(20, 10, [255, 0, 0, 255])));
    const page = await wsClient(s.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({
      family: "image",
      revision: 0,
      snapshot: { family: "image", format: "ora", width: 64, height: 48 },
    });
    await (await s.core.send("me", sessionId, "Metti l'immagine generata come livello")).done;
    expect(seen[0]).toMatch(/^Layered pictures \(image/);
    expect(seen[0]).toContain('"op":"add_layer"');
    expect(seen[1]).toContain("OpenRaster picture 64×48 px, 3 layers");
    expect(seen[2]).toMatch(/^Applied as revision 1: /);
    expect(seen[3]).toMatch(/Nothing applied: operation 1: there is no layer «nope»/);
    const changed = page.messages.filter(
      (m): m is Extract<ServerMessage, { type: "doc.changed" }> => m.type === "doc.changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change.summary.image).toMatchObject({ n: 1, layer: "Generata" });
    await s.core.editor.flush();
    const disk = readOra(new Uint8Array(await readFile(join(root, file.path))));
    const top = disk.layers.at(-1);
    expect(top).toMatchObject({ name: "Generata", blend: "svg:multiply" });
    expect([top?.px.width, top?.px.height]).toEqual([96, 48]);
    expect(at(top?.px as Rgba, 10, 10)).toEqual([54, 54, 54, 255]);
    // The routes: info and the exports.
    const q = `scope=platform&path=${encodeURIComponent(file.path)}`;
    const info = await s.api<{ krita: boolean }>("GET", `/api/editor/image/info?${q}`);
    expect(info.status).toBe(200);
    expect(typeof info.body.krita).toBe("boolean");
    const psd = await fetch(`${s.url}/api/editor/image/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...file, to: "psd" }),
    });
    expect(psd.status).toBe(200);
    const layers = readImage(
      psdToOra(new Uint8Array(await psd.arrayBuffer()), "p").files["p.ora"] as Uint8Array,
    ).layers;
    expect(layers.map((l) => l.name)).toEqual(["Sfondo", "Nascosto", "Sole", "Generata"]);
    expect((await stat(join(root, file.path))).size).toBeGreaterThan(100);
    page.close();
  });
  // p3.5.6, the 3.5.5 test: God put a project's picture in as a layer and got «outside your
  // workspace». A picture it only reads follows the reading rules (God reads every project); a
  // file in no workspace at all stays refused.
  it("reads a layer's picture from a project God may read, never from outside every workspace", async () => {
    const seen: string[] = [];
    const file = { scope: "platform", path: "art/poster.ora" };
    const paths = { flower: "", stray: "" };
    const layer = (image: string) => ({
      name: "canvas_edit",
      input: { path: file.path, ops: [{ op: "add_layer", name: "Fiore", image }] },
    });
    const flowerCall = layer("");
    const strayCall = layer("");
    s = await startServer(
      calls([flowerCall, strayCall], seen) as never,
      { contextWindow: 65_536 },
      { editor: { saveDelayMs: 0, watchMs: 0 } },
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "Collaudo 3.5.5" });
    const project = await s.core.projects.get("me", "collaudo-3-5-5");
    if (!project) throw new Error("no project");
    paths.flower = join(project.path, "fiore.png");
    await writeFile(paths.flower, pngOf(solid(8, 8, [0, 200, 0, 255])));
    const stray = await mkdtemp(join(tmpdir(), "rg-stray-"));
    paths.stray = join(stray, "altro.png");
    await writeFile(paths.stray, pngOf(solid(8, 8, [0, 0, 200, 255])));
    (flowerCall.input.ops[0] as { image: string }).image = paths.flower;
    (strayCall.input.ops[0] as { image: string }).image = paths.stray;
    const sessionId = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), sampleOra());
    // The system's scratch folder is free for the guardian: the stray picture is read, not asked.
    s.core.approvals.on("request", (owner, info) =>
      s?.core.approvals.decide(owner, info.requestId, "allow"),
    );
    await (await s.core.send("me", sessionId, "Metti il fiore come livello")).done;
    expect(seen[0]).toMatch(/^Applied as revision 1: /);
    expect(seen[1]).toMatch(/Nothing applied: .* is outside your workspace and in no project/);
    await s.core.editor.flush();
    const disk = readOra(new Uint8Array(await readFile(join(root, file.path))));
    expect(disk.layers.at(-1)?.name).toBe("Fiore");
    await rm(stray, { recursive: true, force: true });
  });
});
