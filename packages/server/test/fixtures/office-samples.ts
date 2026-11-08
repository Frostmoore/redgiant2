// OpenDocument files built in the test (G37.4): a text with a title, headings, a list, a section,
// a table and a picture; a presentation with three slides. Small, valid ODF that LibreOffice
// opens too (the engine's own test uses them). `odfOfOutline` writes an outline back as a file:
// the fake engine of the host's tests.
import type { OfficeItem, OfficeOutline, OfficeSlide } from "@redgiant/protocol";
import { strToU8 } from "fflate";
import { escapeXml, packageZip } from "../../src/convert-js.js";
import { IMPRESS_MIME, WRITER_MIME } from "../../src/editor/office-outline.js";

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3"';

const manifest = (mime: string, pictures: string[] = []) =>
  `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>${pictures.map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="image/png"/>`).join("")}</manifest:manifest>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:styles><style:style style:name="Standard" style:family="paragraph"/><style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard"/><style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard"/><style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard"/><style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Standard"/><style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard"/></office:styles></office:document-styles>`;

/** A 1×1 transparent PNG. */
export const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** The sample text: 1 title, 2 heading, 3 body (with spaces and a break), 4-5 a list, 6 a table, 7 in a section, 8 a picture's paragraph, 9 body. */
export function sampleOdt(): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:automatic-styles><style:style style:name="P1" style:family="paragraph" style:parent-style-name="Text_20_body"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text><text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Illustration"/></text:sequence-decls><text:p text:style-name="Title">Verbale di sopralluogo</text:p><text:h text:style-name="Heading_20_1" text:outline-level="1">1. Stato dei luoghi</text:h><text:p text:style-name="P1">Il prospetto<text:s text:c="2"/>nord ha fessure.<text:line-break/>Da monitorare.</text:p><text:list><text:list-item><text:p text:style-name="Text_20_body">Punto A1</text:p></text:list-item><text:list-item><text:p text:style-name="Text_20_body">Punto B2</text:p></text:list-item></text:list><table:table table:name="Misure"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">Punto</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">mm</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">A1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p text:style-name="Table_20_Contents">0,4</text:p></table:table-cell></table:table-row></table:table><text:section text:name="Note"><text:p text:style-name="Text_20_body">Nota nella sezione.</text:p></text:section><text:p text:style-name="Standard"><draw:frame draw:name="Foto" text:anchor-type="as-char" svg:width="2cm" svg:height="2cm"><draw:image xlink:href="Pictures/foto.png" xlink:type="simple"/></draw:frame></text:p><text:p text:style-name="Text_20_body">Firmato: ing. Rossi.</text:p></office:text></office:body></office:document-content>`;
  return packageZip(WRITER_MIME, {
    "META-INF/manifest.xml": strToU8(manifest(WRITER_MIME, ["Pictures/foto.png"])),
    "content.xml": strToU8(content),
    "styles.xml": strToU8(STYLES),
    "Pictures/foto.png": PNG,
  });
}

const frame = (
  cls: string | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  paras: string[],
) =>
  `<draw:frame${cls ? ` presentation:class="${cls}" draw:layer="layout" presentation:user-transformed="true"` : ""} svg:x="${x}cm" svg:y="${y}cm" svg:width="${w}cm" svg:height="${h}cm"><draw:text-box>${paras.map((p) => `<text:p>${escapeXml(p)}</text:p>`).join("")}</draw:text-box></draw:frame>`;

/** The sample presentation: 1 title slide, 2 title and bullets, 3 title, a picture and a text box. */
export function sampleOdp(): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body><office:presentation><draw:page draw:name="Copertina" draw:master-page-name="Default">${frame("title", 2, 6, 21, 4, ["Piano cantieri 2027"])}${frame("subtitle", 4, 11, 17, 4, ["Riunione di direzione"])}</draw:page><draw:page draw:name="Obiettivi" draw:master-page-name="Default">${frame("title", 1, 1, 23, 3, ["Obiettivi"])}${frame("outline", 1, 4, 23, 12, ["Ridurre i tempi del 10%", "Zero infortuni"])}</draw:page><draw:page draw:name="Cantiere Nord" draw:master-page-name="Default">${frame("title", 1, 1, 23, 3, ["Cantiere Nord"])}<draw:frame svg:x="2cm" svg:y="5cm" svg:width="6cm" svg:height="4cm"><draw:image xlink:href="Pictures/foto.png" xlink:type="simple"/></draw:frame>${frame(undefined, 10, 5, 10, 3, ["Consegna a marzo"])}</draw:page></office:presentation></office:body></office:document-content>`;
  return packageZip(IMPRESS_MIME, {
    "META-INF/manifest.xml": strToU8(manifest(IMPRESS_MIME, ["Pictures/foto.png"])),
    "content.xml": strToU8(content),
    "styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:master-styles><style:master-page style:name="Default"/></office:master-styles></office:document-styles>`,
    ),
    "Pictures/foto.png": PNG,
  });
}

const styleName = (s: string) => s.replace(/ /g, "_20_");

function itemXml(it: OfficeItem): string {
  if (it.k === "p") {
    const body = escapeXml(it.text)
      .replace(/\n/g, "<text:line-break/>")
      .replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
    const pic = it.pics
      ? `<draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/foto.png"/></draw:frame>`
      : "";
    const el = it.level ? "text:h" : "text:p";
    return `<${el} text:style-name="${styleName(it.style)}"${it.level ? ` text:outline-level="${it.level}"` : ""}>${pic}${body}</${el}>`;
  }
  return `<table:table table:name="${escapeXml(it.name)}"><table:table-column table:number-columns-repeated="${Math.max(1, it.cols)}"/>${it.cells.map((row) => `<table:table-row>${row.map((c) => `<table:table-cell office:value-type="string"><text:p>${escapeXml(c)}</text:p></table:table-cell>`).join("")}</table:table-row>`).join("")}</table:table>`;
}

function slideXml(s: OfficeSlide): string {
  const shape = (sh: OfficeSlide["shapes"][number]) => {
    const cls = ["title", "subtitle", "outline"].includes(sh.kind) ? sh.kind : undefined;
    if (sh.kind === "picture")
      return `<draw:frame svg:x="2cm" svg:y="5cm" svg:width="6cm" svg:height="4cm"><draw:image xlink:href="Pictures/foto.png"/></draw:frame>`;
    return frame(cls, 1, 1, 10, 3, sh.text ? sh.text.split("\n") : []);
  };
  return `<draw:page draw:name="${escapeXml(s.name)}">${s.shapes.map(shape).join("")}</draw:page>`;
}

/** An outline written as an ODF file (the fake engine: what LibreOffice would have saved). */
export function odfOfOutline(o: OfficeOutline): Uint8Array {
  const mime = o.app === "writer" ? WRITER_MIME : IMPRESS_MIME;
  const body =
    o.app === "writer"
      ? `<office:text>${o.items.map(itemXml).join("")}</office:text>`
      : `<office:presentation>${o.slides.map(slideXml).join("")}</office:presentation>`;
  return packageZip(mime, {
    "META-INF/manifest.xml": strToU8(manifest(mime, ["Pictures/foto.png"])),
    "content.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body>${body}</office:body></office:document-content>`,
    ),
    "styles.xml": strToU8(STYLES),
    "Pictures/foto.png": PNG,
  });
}
