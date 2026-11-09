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
