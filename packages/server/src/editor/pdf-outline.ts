// A PDF read for the editor (G37.8): its pages (size, rotation, annotations), its form fields with
// their values, whether it is encrypted or signed. pdf-lib (MIT) reads it; the same library writes
// the actions back (pdf-write.ts), so what the host checks the actions on is what it writes.

import type {
  PdfAnnotInfo,
  PdfField,
  PdfFieldValue,
  PdfOutline,
  PdfPageInfo,
  PdfRect,
} from "@redgiant/protocol";
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
} from "pdf-lib";

/** The biggest PDF the editor opens. */
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** A PDF as pdf-lib reads it, without touching its metadata. */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

/** How pdf.js names an object ("12R", "12R3" when its generation is not 0). */
export const refName = (r: PDFRef): string =>
  r.generationNumber ? `${r.objectNumber}R${r.generationNumber}` : `${r.objectNumber}R`;

export function parseRefName(s: string): PDFRef | undefined {
  const m = s.match(/^(\d+)R(\d+)?$/);
  return m ? PDFRef.of(Number(m[1]), Number(m[2] ?? 0)) : undefined;
}

/** A text string of the file (literal or hex, PDFDocEncoding or UTF-16). */
export function textOf(v: unknown): string | undefined {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  if (v instanceof PDFName) return v.decodeText();
  return undefined;
}

const num = (v: unknown): number | undefined => (v instanceof PDFNumber ? v.asNumber() : undefined);

export function rectOf(v: unknown): PdfRect | undefined {
  if (!(v instanceof PDFArray) || v.size() < 4) return undefined;
  const n = [0, 1, 2, 3].map((i) => num(v.get(i)));
  if (n.some((x) => x === undefined || !Number.isFinite(x))) return undefined;
  const [a, b, c, d] = n as [number, number, number, number];
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

function colorOf(v: unknown): [number, number, number] | undefined {
  if (!(v instanceof PDFArray)) return undefined;
  const n = v.asArray().map(num);
  if (n.some((x) => x === undefined)) return undefined;
  const c = n as number[];
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (c.length === 3) return [clamp(c[0] as number), clamp(c[1] as number), clamp(c[2] as number)];
  if (c.length === 1) return [clamp(c[0] as number), clamp(c[0] as number), clamp(c[0] as number)];
  if (c.length === 4) {
    const [C, M, Y, K] = c as [number, number, number, number];
    return [clamp((1 - C) * (1 - K)), clamp((1 - M) * (1 - K)), clamp((1 - Y) * (1 - K))];
  }
  return undefined;
}

/** Our annotation kinds as the file names them, and back. */
export const SUBTYPE_OF: Record<string, string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
  freetext: "FreeText",
  ink: "Ink",
  note: "Text",
  square: "Square",
  stamp: "Stamp",
  signature: "Stamp",
};
const KIND_OF: Record<string, string> = {
  Highlight: "highlight",
  Underline: "underline",
  StrikeOut: "strikeout",
  FreeText: "freetext",
  Ink: "ink",
  Text: "note",
  Square: "square",
  Stamp: "stamp",
};

/** Annotations the outline leaves out: form widgets (the fields say them) and popups. */
const HIDDEN = new Set(["Widget", "Popup"]);

let pids = 0;
/** A page id unique in this process (pages move and come back by it). */
export const newPid = () => `pg${(++pids).toString(36)}`;

/** The annotations of a page as the outline knows them. */
export function pageAnnots(doc: PDFDocument, pageIndex: number): PdfAnnotInfo[] {
  const page = doc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) return [];
  const out: PdfAnnotInfo[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = doc.context.lookupMaybe(raw, PDFDict);
    if (!dict) continue;
    const subtype = dict.get(PDFName.of("Subtype"));
    const st = subtype instanceof PDFName ? subtype.decodeText() : "Unknown";
    if (HIDDEN.has(st)) continue;
    const ref = raw instanceof PDFRef ? refName(raw) : undefined;
    const nm = textOf(dict.get(PDFName.of("NM")));
    // Our own signatures are stamps named so.
    const isSign = st === "Stamp" && textOf(dict.get(PDFName.of("Name"))) === "RGSignature";
    let id = nm && !seen.has(nm) ? nm : (ref ?? `${pageIndex}:${i}`);
    if (seen.has(id)) id = `${id}#${i}`;
    seen.add(id);
    const rect = rectOf(dict.get(PDFName.of("Rect")));
    if (!rect) continue;
    const text = textOf(dict.get(PDFName.of("Contents")));
    // A text box's colour is its text's (in /DA); /C would be its background.
    const da = st === "FreeText" ? textOf(dict.get(PDFName.of("DA"))) : undefined;
    const daColor = da?.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
    const color = daColor
      ? ([Number(daColor[1]), Number(daColor[2]), Number(daColor[3])] as [number, number, number])
      : colorOf(dict.get(PDFName.of("C")));
    const author = textOf(dict.get(PDFName.of("T")));
    out.push({
      id,
      ...(ref && { ref }),
      kind: isSign ? "signature" : (KIND_OF[st] ?? st.toLowerCase()),
      rect,
      ...(text && { text: text.slice(0, 20_000) }),
      ...(color && { color }),
      ...(author && { author: author.slice(0, 200) }),
    });
  }
  return out;
}

/** The pages of the file, in order. */
export function readPages(doc: PDFDocument): PdfPageInfo[] {
  return doc.getPages().map((p, i) => {
    const box = p.getCropBox();
    return {
      pid: newPid(),
      w: Math.round(box.width * 100) / 100,
      h: Math.round(box.height * 100) / 100,
      rotate: ((p.getRotation().angle % 360) + 360) % 360,
      annots: pageAnnots(doc, i),
    };
  });
}

/** The form's fields with their values (none when the file has no form). */
export function readFields(doc: PDFDocument, pages: PdfPageInfo[]): PdfField[] {
  if (!doc.catalog.has(PDFName.of("AcroForm"))) return [];
  let form: ReturnType<PDFDocument["getForm"]>;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  // The page of each widget, by its object.
  const pageOfRef = new Map<string, number>();
  doc.getPages().forEach((p, i) => {
    const a = p.node.Annots();
    if (!a) return;
    for (const r of a.asArray()) if (r instanceof PDFRef) pageOfRef.set(r.toString(), i);
  });
  const out: PdfField[] = [];
  for (const f of form.getFields()) {
    let type: PdfField["type"] = "other";
    let value: PdfFieldValue = "";
    let options: string[] | undefined;
    let multiline: boolean | undefined;
    try {
      if (f instanceof PDFTextField) {
        type = "text";
        value = f.getText() ?? "";
        multiline = f.isMultiline() || undefined;
      } else if (f instanceof PDFCheckBox) {
        type = "checkbox";
        value = f.isChecked();
      } else if (f instanceof PDFRadioGroup) {
        type = "radio";
        value = f.getSelected() ?? "";
        options = f.getOptions();
      } else if (f instanceof PDFDropdown) {
        type = "dropdown";
        value = f.getSelected()[0] ?? "";
        options = f.getOptions();
      } else if (f instanceof PDFOptionList) {
        type = "list";
        value = f.getSelected();
        options = f.getOptions();
      } else if (f instanceof PDFButton) type = "button";
      else if (f instanceof PDFSignature) type = "signature";
    } catch {
      // A field pdf-lib cannot read: listed, never written.
      type = "other";
    }
    let pid: string | undefined;
    for (const w of f.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(w.dict);
      const at = ref ? pageOfRef.get(ref.toString()) : undefined;
      if (at !== undefined) {
        pid = pages[at]?.pid;
        break;
      }
    }
    out.push({
      name: f.getName().slice(0, 1000),
      type,
      value,
      ...(options && { options: options.slice(0, 2000) }),
      ...(pid && { pid }),
      ...(f.isReadOnly() && { readOnly: true }),
      ...(multiline && { multiline }),
    });
  }
  return out;
}

/** Whether a signature field holds a signature (changing the file breaks it). */
function isSigned(doc: PDFDocument): boolean {
  const af = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const fields = af?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) return false;
  const walk = (arr: PDFArray, depth: number): boolean => {
    if (depth > 20) return false;
    for (const r of arr.asArray()) {
      const d = doc.context.lookupMaybe(r, PDFDict);
      if (!d) continue;
      const ft = d.get(PDFName.of("FT"));
      if (ft instanceof PDFName && ft.decodeText() === "Sig" && d.has(PDFName.of("V"))) return true;
      const kids = d.lookupMaybe(PDFName.of("Kids"), PDFArray);
      if (kids && walk(kids, depth + 1)) return true;
    }
    return false;
  };
  return walk(fields, 0);
}

/** The outline of a PDF read with pdf-lib. */
export function outlineOf(doc: PDFDocument): PdfOutline {
  const encrypted = doc.isEncrypted;
  const pages = readPages(doc);
  const fields = encrypted ? [] : readFields(doc, pages);
  return {
    pages,
    fields,
    ...(encrypted && { encrypted: true }),
    ...(!encrypted && isSigned(doc) && { signed: true }),
  };
}

export async function readPdfOutline(bytes: Uint8Array): Promise<PdfOutline> {
  return outlineOf(await loadPdf(bytes));
}
