// Small sample files for the conversion tests (G34.3), made here so the tests need nothing from
// outside. `writeSamples(dir)` also writes them to a folder to look at by hand.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writePsdBuffer } from "ag-psd";
import { encode as encodePng } from "fast-png";
import { strToU8, zipSync } from "fflate";

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

/** An IDML: one story with a heading and a body paragraph, a placed image on the spread. */
export function idmlSample(): Uint8Array {
  const story = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u1">
<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Heading 1"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>Spring &amp; Summer</Content><Br/></CharacterStyleRange></ParagraphStyleRange>
<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body" Justification="CenterAlign"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Emphasis" FontStyle="Bold" PointSize="11"><Content>New colours</Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content> for everyone.</Content></CharacterStyleRange></ParagraphStyleRange>
</Story></idPkg:Story>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><RootParagraphStyleGroup>
<ParagraphStyle Self="ParagraphStyle/Heading 1" Name="Heading 1" PointSize="24" FontStyle="Bold"><Properties><AppliedFont type="string">Minion Pro</AppliedFont></Properties></ParagraphStyle>
<ParagraphStyle Self="ParagraphStyle/Body" Name="Body" PointSize="10"/>
</RootParagraphStyleGroup><RootCharacterStyleGroup><CharacterStyle Self="CharacterStyle/Emphasis" Name="Emphasis" FontStyle="Italic"/></RootCharacterStyleGroup></idPkg:Styles>`;
  const design = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Spread src="Spreads/Spread_a.xml"/><idPkg:Story src="Stories/Story_u1.xml"/></Document>`;
  const spread = `<?xml version="1.0" encoding="UTF-8"?><idPkg:Spread xmlns:idPkg="x"><Spread><Rectangle><Image><Link LinkResourceURI="file:/photos/beach.jpg"/></Image></Rectangle></Spread></idPkg:Spread>`;
  return zipSync({
    mimetype: [strToU8("application/vnd.adobe.indesign-idml-package"), { level: 0 }],
    "designmap.xml": strToU8(design),
    "Resources/Styles.xml": strToU8(styles),
    "Spreads/Spread_a.xml": strToU8(spread),
    "Stories/Story_u1.xml": strToU8(story),
  });
}

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

/** A Sketch file: a zip with the document, one page with an artboard and a text, a preview. */
export function sketchSample(): Uint8Array {
  const page = {
    _class: "page",
    name: "Home",
    layers: [
      {
        _class: "artboard",
        name: "Desktop",
        frame: { width: 1440, height: 900 },
        layers: [
          { _class: "text", name: "Title", attributedString: { string: "Welcome\nhome" } },
          { _class: "rectangle", name: "Card" },
        ],
      },
    ],
  };
  return zipSync({
    "document.json": strToU8("{}"),
    "meta.json": strToU8('{"app":"com.bohemiancoding.sketch3"}'),
    "pages/ABC.json": strToU8(JSON.stringify(page)),
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
};

/** Writes every sample into `dir` (to look at them by hand). */
export async function writeSamples(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  for (const [name, make] of Object.entries(SAMPLES)) await writeFile(join(dir, name), make());
  return Object.keys(SAMPLES);
}
