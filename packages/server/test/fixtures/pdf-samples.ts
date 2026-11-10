// PDFs for the editor's tests (G37.8), made with pdf-lib: pages of text, a form (text, dropdown,
// checkbox, radio), a picture, a vector drawing, an alt text; with classic cross-references or
// with object and cross-reference streams.
import { encode as encodePng } from "fast-png";
import { PDFDocument, PDFName, rgb, StandardFonts } from "pdf-lib";

/** A 4×4 red PNG. */
export const RED_PNG = encodePng({
  width: 4,
  height: 4,
  data: new Uint8Array(4 * 4 * 3).map((_, i) => (i % 3 === 0 ? 255 : 0)),
  channels: 3,
});

export async function samplePdf(
  o: { streams?: boolean; form?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Prova");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const texts = [
    [
      "Contratto di prova",
      "Il cliente Mario Rossi abita a Roma in via Garibaldi 12.",
      "Codice fiscale RSSMRA80A01H501U, telefono 333 1234567.",
    ],
    [
      "Seconda pagina",
      "Qui il testo continua con altre parole.",
      "Una riga ancora per la ricerca.",
    ],
    ["Terza pagina", "Ultime parole del documento.", ""],
  ];
  for (const [i, t] of texts.entries()) {
    const page = doc.addPage([595, 842]);
    page.drawText(t[0] as string, { x: 72, y: 760, size: 20, font: bold });
    page.drawText(t[1] as string, { x: 72, y: 720, size: 12, font });
    page.drawText(t[2] as string, { x: 72, y: 700, size: 12, font });
    if (i === 0) {
      const png = await doc.embedPng(RED_PNG);
      page.drawImage(png, { x: 400, y: 600, width: 80, height: 80 });
      // A small drawing (a drawn signature) and a frame around the page.
      page.drawLine({
        start: { x: 80, y: 560 },
        end: { x: 160, y: 575 },
        thickness: 2,
        color: rgb(0, 0, 0.6),
      });
      page.drawRectangle({
        x: 20,
        y: 20,
        width: 555,
        height: 802,
        borderWidth: 1,
        borderColor: rgb(0.5, 0.5, 0.5),
      });
    }
  }
  if (o.form !== false) {
    const form = doc.getForm();
    const page = doc.getPage(0);
    const nome = form.createTextField("nome");
    nome.addToPage(page, { x: 72, y: 470, width: 200, height: 22, font });
    const citta = form.createDropdown("citta");
    citta.addOptions(["Roma", "Milano", "Napoli"]);
    citta.addToPage(page, { x: 72, y: 430, width: 200, height: 22, font });
    const consenso = form.createCheckBox("consenso");
    consenso.addToPage(page, { x: 72, y: 390, width: 16, height: 16 });
    const piano = form.createRadioGroup("piano");
    piano.addOptionToPage("base", page, { x: 72, y: 350, width: 16, height: 16 });
    piano.addOptionToPage("pro", page, { x: 120, y: 350, width: 16, height: 16 });
    form.updateFieldAppearances(font);
  }
  doc.catalog.set(PDFName.of("Lang"), doc.context.obj("it") as never);
  return doc.save({ useObjectStreams: o.streams === true });
}

/** Helvetica's widths for the characters of the tricky page (space to «z»). */
const HELV: Record<string, number> = {
  " ": 278,
  "-": 333,
  ".": 278,
  ...Object.fromEntries([..."0123456789"].map((c) => [c, 556])),
  ...Object.fromEntries(
    [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c, i) => [
      c,
      [
        667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
        667, 611, 722, 667, 944, 667, 667, 611,
      ][i] as number,
    ]),
  ),
  ...Object.fromEntries(
    [..."abcdefghijklmnopqrstuvwxyz"].map((c, i) => [
      c,
      [
        556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333,
        500, 278, 556, 500, 722, 500, 500, 500,
      ][i] as number,
    ]),
  ),
};

/**
 * A page written the ways other programs write text (p3.5.4, the 3.5.3 test's PDF came from
 * LibreOffice and PyMuPDF): a secret after narrow letters in one Tj (its place in the run is not
 * its share of the characters), the same in a TJ with kerning, character and word spacing and
 * horizontal scaling, and in a Type0 font with two-byte codes (Identity-H) and a ToUnicode map.
 * Each line keeps «ZEBRA-77» and words around it.
 */
export async function trickyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([595, 842]);
  const hex = (s: string, two = false) =>
    `<${[...s]
      .map((c) => {
        const code = c === "è" ? 0xe8 : (c.codePointAt(0) as number);
        return code.toString(16).padStart(two ? 4 : 2, "0");
      })
      .join("")}>`;
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "1 beginbfrange",
    "<0020> <007E> <0020>",
    "endbfrange",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const widths: number[] = [];
  for (let c = 32; c <= 126; c++) widths.push(HELV[String.fromCharCode(c)] ?? 500);
  const cid = ctx.obj({
    Type: "Font",
    Subtype: "CIDFontType2",
    BaseFont: "Helvetica",
    CIDSystemInfo: { Registry: ctx.obj("Adobe"), Ordering: ctx.obj("Identity"), Supplement: 0 },
    DW: 500,
    W: [32, widths],
    FontDescriptor: ctx.register(
      ctx.obj({
        Type: "FontDescriptor",
        FontName: "Helvetica",
        Flags: 32,
        FontBBox: [-166, -225, 1000, 931],
        ItalicAngle: 0,
        Ascent: 718,
        Descent: -207,
        CapHeight: 718,
        StemV: 88,
      }),
    ),
  });
  const type0 = ctx.obj({
    Type: "Font",
    Subtype: "Type0",
    BaseFont: "Helvetica",
    Encoding: "Identity-H",
    DescendantFonts: [ctx.register(cid)],
    ToUnicode: ctx.register(ctx.flateStream(cmap)),
  });
  const helv = ctx.obj({
    Type: "Font",
    Subtype: "Type1",
    BaseFont: "Helvetica",
    Encoding: "WinAnsiEncoding",
  });
  page.node.set(
    PDFName.of("Resources"),
    ctx.obj({ Font: { F1: ctx.register(helv), F2: ctx.register(type0) } }),
  );
  const content = [
    "BT /F1 12 Tf 72 720 Td",
    `${hex("Il codice riservato è ZEBRA-77 e basta.")} Tj`,
    "ET",
    "BT /F1 12 Tf 0.4 Tc 1.5 Tw 92 Tz 1 0 0 1 72 690 Tm",
    `[${hex("Il codice ")} -250 ${hex("riservato ")} 120 ${hex("è Z")} -80 ${hex("EBRA-77")} 40 ${hex(" fine.")}] TJ`,
    "ET",
    "BT /F2 12 Tf 72 660 Td",
    `[${hex("Codice ", true)} -120 ${hex("ZEBRA-77", true)} ${hex(" qui.", true)}] TJ`,
    "ET",
  ].join("\n");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
  return doc.save({ useObjectStreams: false });
}
