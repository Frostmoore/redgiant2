// Small sample files for the conversion tests (G34.3), made here so the tests need nothing from
// outside. `writeSamples(dir)` also writes them to a folder to look at by hand.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writePsdBuffer } from "ag-psd";
import { encode as encodePng } from "fast-png";
import { strToU8, zipSync } from "fflate";
import { idmlSample } from "./idml-sample.js";

const W = 8;
const H = 6;
const solid = (r: number, g: number, b: number, a = 255, w = W, h = H) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { width: w, height: h, data } as never;
};

/** A Photoshop file: a white background, a group with a red multiply layer, a text layer. */
export function psdSample(): Uint8Array {
  return new Uint8Array(
    writePsdBuffer({
      width: W,
      height: H,
      imageData: solid(250, 250, 250),
      children: [
        { name: "Background", imageData: solid(255, 255, 255), left: 0, top: 0 },
        {
          name: "Group",
          children: [
            {
              name: "Red",
              imageData: solid(255, 0, 0, 255, 4, 3),
              left: 2,
              top: 1,
              blendMode: "multiply",
              opacity: 0.5,
            },
          ],
        },
        {
          name: "Title",
          imageData: solid(0, 0, 0, 255, 3, 2),
          left: 1,
          top: 1,
          text: { text: "Hello", style: { font: { name: "ArialMT" }, fontSize: 12 } },
          effects: { dropShadow: [{ enabled: true }] },
        },
      ],
    } as never),
  );
}

export const pngSample = (r = 0, g = 128, b = 255, w = 2, h = 2) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, 255], i * 4);
  return encodePng({ width: w, height: h, data, channels: 4, depth: 8 });
};

/** A structurally whole JPEG (markers only; nobody decodes it here). */
export function jpegSample(): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...strToU8("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0];
  const scan = new Array(400).fill(0x55);
  return new Uint8Array([0xff, 0xd8, ...app0, ...sos, ...scan, 0xff, 0xd9]);
}

/** A tiny one-page PDF (what a modern Illustrator file is). */
export function pdfSample(producer = "Adobe Illustrator"): Uint8Array {
  return strToU8(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n4 0 obj<</Producer(${producer})>>endobj\ntrailer<</Root 1 0 R/Info 4 0 R>>\n%%EOF\n`,
  );
}

export const epsSample = () =>
  strToU8(
    "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nnewpath 0 0 moveto 10 10 lineto stroke\n%%EOF\n",
  );

/** A realistic IDML (pages, frames, styles, threaded text, pictures): see idml-sample.ts. */
export { idmlSample };

/** An INDD: InDesign's GUID, some bytes, and an XMP packet with a JPEG thumbnail. */
export function inddSample(): Uint8Array {
  const guid = [
    0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d,
  ];
  const b64 = Buffer.from(jpegSample()).toString("base64");
  const wrapped = b64.replace(/(.{60})/g, "$1&#xA;");
  const xmp = strToU8(
    `<x:xmpmeta><rdf:RDF><xmp:Thumbnails><rdf:li><xmpGImg:format>JPEG</xmpGImg:format><xmpGImg:image>${wrapped}</xmpGImg:image></rdf:li></xmp:Thumbnails></rdf:RDF></x:xmpmeta>`,
  );
  return new Uint8Array([...guid, ...new Array(64).fill(0), ...xmp, ...new Array(32).fill(0)]);
}

/** An Affinity file: its magic, some bytes, and a PNG preview inside. */
export function affinitySample(): Uint8Array {
  return new Uint8Array([
    0x00,
    0xff,
    0x4b,
    0x41,
    ...new Array(40).fill(7),
    ...pngSample(10, 20, 30, 3, 3),
    1,
    2,
    3,
  ]);
}

/**
 * A Sketch file: a zip with the document, one page with an artboard (at 100, 50 on the canvas)
 * holding a text, a rounded rectangle, a rotated oval, a triangle with a curve and a group;
 * a symbol on its own page used once; a bitmap; a preview.
 */
export function sketchSample(): Uint8Array {
  const rgba = (red: number, green: number, blue: number, alpha = 1) => ({
    _class: "color",
    red,
    green,
    blue,
    alpha,
  });
  const fill = (c: ReturnType<typeof rgba>) => ({
    style: { fills: [{ _class: "fill", isEnabled: true, fillType: 0, color: c }] },
  });
  const pt = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    _class: "curvePoint",
    point: `{${x}, ${y}}`,
    curveFrom: `{${x}, ${y}}`,
    curveTo: `{${x}, ${y}}`,
    hasCurveFrom: false,
    hasCurveTo: false,
    ...extra,
  });
  const page = {
    _class: "page",
    do_objectID: "ABC",
    name: "Home",
    frame: { x: 0, y: 0, width: 0, height: 0 },
    layers: [
      {
        _class: "artboard",
        name: "Desktop",
        frame: { x: 100, y: 50, width: 1440, height: 900 },
        hasBackgroundColor: true,
        backgroundColor: rgba(0.95, 0.95, 0.95),
        layers: [
          {
            _class: "text",
            name: "Title",
            frame: { x: 40, y: 30, width: 400, height: 80 },
            attributedString: {
              string: "Welcome\nhome",
              attributes: [
                {
                  location: 0,
                  length: 12,
                  attributes: {
                    MSAttributedStringFontAttribute: {
                      attributes: { name: "Inter-Bold", size: 32 },
                    },
                    MSAttributedStringColorAttribute: rgba(0.1, 0.2, 0.3),
                    paragraphStyle: { alignment: 0, maximumLineHeight: 40 },
                  },
                },
              ],
            },
          },
          {
            _class: "rectangle",
            name: "Card",
            frame: { x: 40, y: 200, width: 300, height: 180 },
            fixedRadius: 12,
            style: {
              fills: [{ isEnabled: true, fillType: 0, color: rgba(1, 1, 1) }],
              borders: [{ isEnabled: true, color: rgba(0, 0, 0, 0.5), thickness: 2, position: 0 }],
              shadows: [{ isEnabled: true }],
            },
          },
          {
            _class: "oval",
            name: "Dot",
            frame: { x: 500, y: 200, width: 100, height: 50 },
            rotation: 45,
            ...fill(rgba(1, 0, 0)),
          },
          {
            _class: "shapePath",
            name: "Arrow",
            frame: { x: 700, y: 200, width: 120, height: 80 },
            isClosed: true,
            points: [
              pt(0, 1),
              pt(0.5, 0, {
                hasCurveFrom: true,
                hasCurveTo: true,
                curveTo: "{0.25, -0.25}",
                curveFrom: "{0.75, -0.25}",
              }),
              pt(1, 1),
            ],
            ...fill(rgba(0, 0.4, 0.6)),
          },
          {
            _class: "group",
            name: "Badges",
            frame: { x: 40, y: 500, width: 200, height: 50 },
            layers: [
              {
                _class: "rectangle",
                name: "B1",
                frame: { x: 0, y: 0, width: 50, height: 50 },
                ...fill(rgba(0, 1, 0)),
              },
              {
                _class: "rectangle",
                name: "B2",
                frame: { x: 70, y: 0, width: 50, height: 50 },
                ...fill(rgba(0, 0, 1)),
              },
              {
                _class: "rectangle",
                name: "Hidden",
                isVisible: false,
                frame: { x: 0, y: 0, width: 5, height: 5 },
              },
            ],
          },
          {
            _class: "symbolInstance",
            name: "Logo",
            symbolID: "SYM1",
            frame: { x: 1200, y: 30, width: 200, height: 100 },
          },
          {
            _class: "bitmap",
            name: "Photo",
            frame: { x: 1000, y: 400, width: 300, height: 200 },
            image: { _class: "MSJSONFileReference", _ref: "images/photo.png" },
          },
        ],
      },
    ],
  };
  const symbols = {
    _class: "page",
    do_objectID: "SYMS",
    name: "Symbols",
    layers: [
      {
        _class: "symbolMaster",
        symbolID: "SYM1",
        name: "Logo",
        frame: { x: 0, y: 0, width: 100, height: 50 },
        layers: [
          {
            _class: "oval",
            name: "Mark",
            frame: { x: 0, y: 0, width: 100, height: 50 },
            ...fill(rgba(1, 0.5, 0)),
          },
        ],
      },
    ],
  };
  return zipSync({
    "document.json": strToU8(
      JSON.stringify({ pages: [{ _ref: "pages/ABC" }, { _ref: "pages/SYMS" }] }),
    ),
    "meta.json": strToU8('{"app":"com.bohemiancoding.sketch3"}'),
    "pages/ABC.json": strToU8(JSON.stringify(page)),
    "pages/SYMS.json": strToU8(JSON.stringify(symbols)),
    "images/photo.png": pngSample(5, 6, 7, 3, 2),
    "previews/preview.png": pngSample(1, 2, 3, 4, 4),
  });
}

/** A Figma local copy: a zip with the canvas (opaque) and its thumbnail. */
export const figSample = () =>
  zipSync({
    "canvas.fig": strToU8("fig-kiwi\0\0\0"),
    "meta.json": strToU8("{}"),
    "thumbnail.png": pngSample(9, 9, 9, 5, 5),
  });

/** A Word file, as far as detection goes (LibreOffice is faked in the tests). */
export const docxSample = () =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8("<w:document/>"),
  });

/** An AVI header (ffmpeg is faked in the tests). */
export const aviSample = () =>
  new Uint8Array([
    ...strToU8("RIFF"),
    0,
    0,
    0,
    0,
    ...strToU8("AVI LIST"),
    ...new Array(32).fill(0),
  ]);

export const SAMPLES: Record<string, () => Uint8Array> = {
  "poster.psd": psdSample,
  "logo.ai": () => pdfSample(),
  "badge.eps": epsSample,
  "brochure.idml": idmlSample,
  "brochure.indd": inddSample,
  "card.afdesign": affinitySample,
  "site.sketch": sketchSample,
  "app.fig": figSample,
  "letter.docx": docxSample,
  "clip.avi": aviSample,
  "chair.fbx": () => strToU8("Kaydara FBX Binary  \0"),
};

/** Writes every sample into `dir` (to look at them by hand). */
export async function writeSamples(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  for (const [name, make] of Object.entries(SAMPLES)) await writeFile(join(dir, name), make());
  return Object.keys(SAMPLES);
}
