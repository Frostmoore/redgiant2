// The PDF family's writer (G37.8): the actions accepted since the bytes on disk, written into them.
// Annotations, form fields and rotations are an incremental update (ISO 32000 §7.5.6): the
// original bytes stay as they are at the head of the file and only the objects that changed are
// added at its end, with a cross-reference section that points to them and to the previous one.
// Taking pages out, moving them and redacting write the file anew (pdf-lib's own writer); the
// family keeps the version before. pdf-lib (MIT) reads and changes the objects; the incremental
// section is ours. Nothing here runs what a PDF holds (no JavaScript, no actions).

import type { PdfAnnot, PdfPlainAction, PdfRect, PdfSource } from "@redgiant/protocol";
import {
  degrees,
  PDFArray,
  PDFButton,
  PDFCheckBox,
  type PDFContext,
  PDFDict,
  type PDFDocument,
  PDFDropdown,
  type PDFFont,
  PDFHexString,
  type PDFImage,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";
import { loadPdf, parseRefName, SUBTYPE_OF, textOf } from "./pdf-outline.js";
import { redactPage } from "./pdf-redact.js";

export type BlobOf = (hash: string) => Promise<Uint8Array | undefined>;

/** Whether an action needs the file written anew (no incremental update). */
export const rewrites = (a: PdfPlainAction) =>
  a.t === "delete_page" ||
  a.t === "move_page" ||
  a.t === "restore_page" ||
  a.t === "redact" ||
  a.t === "unredact";

export interface Written {
  bytes: Uint8Array;
  /** Written anew (pages or a redaction): the bytes before are not inside it anymore. */
  rewrote: boolean;
  /** Redactions done, page by page (0-based), to check from outside. */
  redacted: { page: number; rects: PdfRect[] }[];
}

const enc = new TextEncoder();
const latin1 = (b: Uint8Array, from: number, to: number) => {
  let s = "";
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i] as number);
  return s;
};

/** The last `startxref` of a file: where its newest cross-reference section is. */
export function lastStartXref(b: Uint8Array): number | undefined {
  const tail = latin1(b, Math.max(0, b.length - 4096), b.length);
  const i = tail.lastIndexOf("startxref");
  if (i < 0) return undefined;
  const m = tail.slice(i + 9).match(/^\s*(\d+)/);
  const n = m ? Number(m[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 && n < b.length ? n : undefined;
}

/** The section at `off`: a table (`xref`) or a stream, and the /Size its trailer says. */
function sectionAt(b: Uint8Array, off: number): { stream: boolean; size?: number } | undefined {
  const head = latin1(b, off, off + 64);
  const stream = !/^\s*xref/.test(head);
  if (stream && !/^\s*\d+\s+\d+\s+obj/.test(head)) return undefined;
  let size: number | undefined;
  if (stream) {
    const m = latin1(b, off, off + 8192).match(/\/Size\s+(\d+)/);
    size = m ? Number(m[1]) : undefined;
  } else {
    const text = latin1(b, off, b.length);
    const t = text.indexOf("trailer");
    const m = t >= 0 ? text.slice(t, t + 8192).match(/\/Size\s+(\d+)/) : null;
    size = m ? Number(m[1]) : undefined;
  }
  return { stream, ...(size !== undefined && { size }) };
}

/** What every indirect object serializes to, to find the ones a change touched. */
function fingerprint(ctx: PDFContext): Map<string, { obj: PDFObject; s: string }> {
  const out = new Map<string, { obj: PDFObject; s: string }>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects())
    out.set(ref.toString(), { obj, s: printed(obj) });
  return out;
}

function printed(obj: PDFObject): string {
  if (obj instanceof PDFStream) {
    const c = (obj as unknown as { contents?: Uint8Array }).contents;
    return `${obj.dict.toString()}#${c ? c.length : "?"}`;
  }
  return obj.toString();
}

/** The objects that changed and the new ones, written after the original bytes. */
function incremental(
  base: Uint8Array,
  doc: PDFDocument,
  before: Map<string, { obj: PDFObject; s: string }>,
  prev: number,
  section: { stream: boolean; size?: number },
): Uint8Array {
  const ctx = doc.context;
  const changed: [PDFRef, PDFObject][] = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const b = before.get(ref.toString());
    if (!b || b.obj !== obj || b.s !== printed(obj)) changed.push([ref, obj]);
  }
  if (!changed.length) return base;
  changed.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  const parts: Uint8Array[] = [base];
  let pos = base.length;
  const push = (u: Uint8Array) => {
    parts.push(u);
    pos += u.length;
  };
  const last = base[base.length - 1];
  if (last !== 0x0a && last !== 0x0d) push(enc.encode("\n"));
  const offsets: { num: number; gen: number; off: number }[] = [];
  for (const [ref, obj] of changed) {
    offsets.push({ num: ref.objectNumber, gen: ref.generationNumber, off: pos });
    push(enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    const body = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(body, 0);
    push(body);
    push(enc.encode("\nendobj\n"));
  }
  const info = ctx.trailerInfo;
  const trailer = PDFDict.withContext(ctx);
  if (info.Root) trailer.set(PDFName.of("Root"), info.Root);
  if (info.Info) trailer.set(PDFName.of("Info"), info.Info);
  if (info.ID) trailer.set(PDFName.of("ID"), info.ID);
  trailer.set(PDFName.of("Prev"), PDFNumber.of(prev));
  const largest = Math.max(ctx.largestObjectNumber, ...offsets.map((o) => o.num));
  if (section.stream) {
    // The file's cross-references are a stream: the update's are one too.
    const xnum = largest + 1;
    const xoff = pos;
    offsets.push({ num: xnum, gen: 0, off: xoff });
    offsets.sort((a, b) => a.num - b.num);
    const runs = runsOf(offsets);
    const wide = xoff > 0xffffffff;
    const ow = wide ? 8 : 4;
    const data = new Uint8Array(offsets.length * (1 + ow + 2));
    let k = 0;
    for (const run of runs)
      for (const e of run) {
        data[k++] = 1;
        for (let i = ow - 1; i >= 0; i--) data[k++] = Math.floor(e.off / 256 ** i) % 256;
        data[k++] = (e.gen >> 8) & 255;
        data[k++] = e.gen & 255;
      }
    trailer.set(PDFName.of("Type"), PDFName.of("XRef"));
    trailer.set(PDFName.of("Size"), PDFNumber.of(Math.max(xnum + 1, section.size ?? 0)));
    trailer.set(
      PDFName.of("Index"),
      ctx.obj(runs.flatMap((r) => [(r[0] as { num: number }).num, r.length])),
    );
    trailer.set(PDFName.of("W"), ctx.obj([1, ow, 2]));
    trailer.set(PDFName.of("Length"), PDFNumber.of(data.length));
    push(enc.encode(`${xnum} 0 obj\n${trailer.toString()}\nstream\n`));
    push(data);
    push(enc.encode(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`));
  } else {
    const xoff = pos;
    let table = "xref\n";
    for (const run of runsOf(offsets)) {
      table += `${(run[0] as { num: number }).num} ${run.length}\n`;
      for (const e of run)
        table += `${String(e.off).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
    }
    trailer.set(PDFName.of("Size"), PDFNumber.of(Math.max(largest + 1, section.size ?? 0)));
    push(enc.encode(`${table}trailer\n${trailer.toString()}\nstartxref\n${xoff}\n%%EOF\n`));
  }
  const out = new Uint8Array(pos);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function runsOf<T extends { num: number }>(list: T[]): T[][] {
  const runs: T[][] = [];
  for (const e of list) {
    const run = runs.at(-1);
    const prev = run?.at(-1);
    if (run && prev && e.num === prev.num + 1) run.push(e);
    else runs.push([e]);
  }
  return runs;
}

// ---- annotations -------------------------------------------------------------------------------

const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();
const rgb = (c: readonly number[] | undefined, fb: [number, number, number]) =>
  (c ?? fb).map(f3).join(" ");

/** An appearance stream drawn in the page's coordinates (its box is the annotation's). */
function appearance(
  ctx: PDFContext,
  rect: PdfRect,
  content: string,
  resources?: Record<string, unknown>,
): PDFRef {
  const dict: Record<string, unknown> = {
    Type: "XObject",
    Subtype: "Form",
    BBox: [...rect],
  };
  if (resources) dict.Resources = resources;
  return ctx.register(ctx.stream(content, dict as never));
}

const pdfText = (s: string) => PDFHexString.fromText(s);

/** The picture as pdf-lib embeds it (PNG or JPEG). */
async function embedImage(doc: PDFDocument, bytes: Uint8Array, mime: string): Promise<PDFImage> {
  return mime === "image/jpeg" ? doc.embedJpg(bytes) : doc.embedPng(bytes);
}

/** A line of text in Helvetica's own encoding: what it cannot write becomes «?». */
function encodable(font: PDFFont, s: string): string {
  let out = "";
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

async function addAnnotation(
  doc: PDFDocument,
  a: PdfAnnot,
  fonts: () => PDFFont,
  blob: BlobOf,
): Promise<void> {
  const ctx = doc.context;
  const page = doc.getPage(a.page);
  const r = a.rect;
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const entries: Record<string, unknown> = {
    Type: "Annot",
    Subtype: SUBTYPE_OF[a.kind] ?? "Square",
    Rect: [...r],
    F: 4,
    P: page.ref,
  };
  const dict = ctx.obj(entries as never) as unknown as PDFDict;
  dict.set(PDFName.of("NM"), pdfText(a.id));
  if (a.author) dict.set(PDFName.of("T"), pdfText(a.author));
  if (a.text) dict.set(PDFName.of("Contents"), pdfText(a.text));
  if (a.color && a.kind !== "freetext") dict.set(PDFName.of("C"), ctx.obj([...a.color]));
  if (a.opacity !== undefined) dict.set(PDFName.of("CA"), PDFNumber.of(a.opacity));
  let ap: PDFRef | undefined;
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout": {
      const q = a.quads ?? [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]];
      dict.set(PDFName.of("QuadPoints"), ctx.obj(q));
      let s = "";
      for (let i = 0; i + 7 < q.length; i += 8) {
        const [x1, y1, x2, y2, x3, y3, x4, y4] = q.slice(i, i + 8) as number[] as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        if (a.kind === "highlight")
          s += `${f3(x1)} ${f3(y1)} m ${f3(x2)} ${f3(y2)} l ${f3(x4)} ${f3(y4)} l ${f3(x3)} ${f3(y3)} l h f\n`;
        else {
          const hh = Math.hypot(x1 - x3, y1 - y3);
          const t = a.kind === "underline" ? 0.1 : 0.45;
          const lw = Math.max(0.5, hh * 0.07);
          const ax = x3 + (x1 - x3) * t;
          const ay = y3 + (y1 - y3) * t;
          const bx = x4 + (x2 - x4) * t;
          const by = y4 + (y2 - y4) * t;
          s += `${f3(lw)} w ${f3(ax)} ${f3(ay)} m ${f3(bx)} ${f3(by)} l S\n`;
        }
      }
      const col = rgb(a.color, a.kind === "highlight" ? [1, 0.92, 0.23] : [0.86, 0.1, 0.1]);
      if (a.kind === "highlight")
        ap = appearance(ctx, r, `/GS0 gs ${col} rg\n${s}`, {
          ExtGState: { GS0: { Type: "ExtGState", BM: "Multiply", ca: a.opacity ?? 1, CA: 1 } },
        });
      else ap = appearance(ctx, r, `${col} RG\n${s}`);
      break;
    }
    case "square": {
      const lw = a.size ?? 1.5;
      dict.set(PDFName.of("BS"), ctx.obj({ W: lw }));
      ap = appearance(
        ctx,
        r,
        `${f3(lw)} w ${rgb(a.color, [0.86, 0.1, 0.1])} RG ${f3(r[0] + lw / 2)} ${f3(r[1] + lw / 2)} ${f3(w - lw)} ${f3(h - lw)} re S`,
      );
      break;
    }
    case "ink": {
      const lw = a.size ?? 2;
      const paths = a.paths ?? [];
      dict.set(PDFName.of("InkList"), ctx.obj(paths));
      dict.set(PDFName.of("BS"), ctx.obj({ W: lw }));
      ap = appearance(
        ctx,
        r,
        `${f3(lw)} w 1 J 1 j ${rgb(a.color, [0, 0, 0])} RG\n${strokes(paths)}`,
      );
      break;
    }
    case "freetext": {
      const font = fonts();
      const fs = a.size ?? 12;
      const col = rgb(a.color, [0, 0, 0]);
      dict.set(PDFName.of("DA"), pdfText(`/Helv ${f3(fs)} Tf ${col} rg`));
      dict.set(PDFName.of("BS"), ctx.obj({ W: 0 }));
      const lines = (a.text ?? "").split(/\r?\n/);
      let s = `BT /Helv ${f3(fs)} Tf ${col} rg ${f3(fs * 1.2)} TL ${f3(r[0] + 2)} ${f3(r[3] - fs - 1)} Td\n`;
      for (const [i, l] of lines.entries()) {
        const hex = font.encodeText(encodable(font, l)).toString();
        s += `${i ? "T* " : ""}${hex} Tj\n`;
      }
      s += "ET";
      ap = appearance(ctx, r, s, { Font: { Helv: font.ref } });
      break;
    }
    case "note": {
      dict.set(PDFName.of("Name"), PDFName.of("Comment"));
      dict.set(PDFName.of("Open"), ctx.obj(false));
      const col = rgb(a.color, [1, 0.85, 0.2]);
      const [x, y] = [r[0], r[1]];
      ap = appearance(
        ctx,
        r,
        `${col} rg 0.35 0.3 0.1 RG 1 w ${f3(x + 1)} ${f3(y + 1)} ${f3(w - 2)} ${f3(h - 2)} re B 0.35 0.3 0.1 RG 1 w ${[0.7, 0.5, 0.3].map((t) => `${f3(x + 4)} ${f3(y + h * t)} m ${f3(x + w - 4)} ${f3(y + h * t)} l S`).join(" ")}`,
      );
      break;
    }
    case "stamp":
    case "signature": {
      if (a.kind === "signature") {
        dict.set(PDFName.of("Name"), PDFName.of("RGSignature"));
        if (!a.text) dict.set(PDFName.of("Contents"), pdfText("Signature"));
      }
      if (a.image) {
        const bytes = await blob(a.image.blob);
        if (!bytes) throw new Error("the picture of the annotation is not here anymore");
        const img = await embedImage(doc, bytes, a.image.mime);
        // The picture fits the box, its proportions kept.
        const k = Math.min(w / img.width, h / img.height);
        const iw = img.width * k;
        const ih = img.height * k;
        const ix = r[0] + (w - iw) / 2;
        const iy = r[1] + (h - ih) / 2;
        ap = appearance(ctx, r, `q ${f3(iw)} 0 0 ${f3(ih)} ${f3(ix)} ${f3(iy)} cm /Im0 Do Q`, {
          XObject: { Im0: img.ref },
        });
      } else if (a.paths?.length) {
        const lw = a.size ?? 1.5;
        ap = appearance(
          ctx,
          r,
          `${f3(lw)} w 1 J 1 j ${rgb(a.color, [0.05, 0.1, 0.35])} RG\n${strokes(a.paths)}`,
        );
      } else throw new Error("a stamp or a signature needs a picture or strokes");
      break;
    }
  }
  if (ap) dict.set(PDFName.of("AP"), ctx.obj({ N: ap }));
  annotsOf(doc, a.page).push(ctx.register(dict));
}

function strokes(paths: readonly (readonly number[])[]): string {
  let s = "";
  for (const p of paths) {
    if (p.length < 2) continue;
    s += `${f3(p[0] as number)} ${f3(p[1] as number)} m`;
    if (p.length === 2) s += ` ${f3((p[0] as number) + 0.01)} ${f3(p[1] as number)} l`;
    for (let i = 2; i + 1 < p.length; i += 2)
      s += ` ${f3(p[i] as number)} ${f3(p[i + 1] as number)} l`;
    s += " S\n";
  }
  return s;
}

/**
 * A page's annotations, changed in place (pdf-lib's own `addAnnot` would normalize the page: wrap
 * its content and copy its resources, objects an incremental update would then carry for nothing).
 */
function annotsOf(doc: PDFDocument, pageIndex: number): PDFArray {
  const node = doc.getPage(pageIndex).node;
  const have = doc.context.lookupMaybe(node.get(PDFName.of("Annots")), PDFArray);
  if (have) return have;
  const made = doc.context.obj([]);
  node.set(PDFName.of("Annots"), made);
  return made;
}

/** Which entry of a page's annotations is the one named `id` (our /NM, or "12R"). */
function annotIndex(doc: PDFDocument, pageIndex: number, id: string): number {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return -1;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    if (raw instanceof PDFRef) {
      const name = raw.generationNumber
        ? `${raw.objectNumber}R${raw.generationNumber}`
        : `${raw.objectNumber}R`;
      if (name === id) return i;
    }
    const d = doc.context.lookupMaybe(raw, PDFDict);
    if (d && textOf(d.get(PDFName.of("NM"))) === id) return i;
  }
  return -1;
}

function removeAnnotation(doc: PDFDocument, pageIndex: number, id: string, ref?: string) {
  const annots = doc.getPage(pageIndex).node.Annots();
  let i = annotIndex(doc, pageIndex, id);
  if (i < 0 && ref) i = annotIndex(doc, pageIndex, ref);
  if (!annots || i < 0) throw new Error(`the annotation «${id}» is not on page ${pageIndex + 1}`);
  const d = doc.context.lookupMaybe(annots.get(i), PDFDict);
  annots.remove(i);
  // Its popup goes with it.
  const popup = d?.get(PDFName.of("Popup"));
  if (popup instanceof PDFRef)
    for (let k = annots.size() - 1; k >= 0; k--) {
      const x = annots.get(k);
      if (x instanceof PDFRef && x.toString() === popup.toString()) annots.remove(k);
    }
}

// ---- form fields -------------------------------------------------------------------------------

function fillField(doc: PDFDocument, name: string, value: unknown): void {
  const form = doc.getForm();
  const f = form.getField(name);
  if (f instanceof PDFTextField) f.setText(String(value) || undefined);
  else if (f instanceof PDFCheckBox) value ? f.check() : f.uncheck();
  else if (f instanceof PDFRadioGroup) value === "" ? f.clear() : f.select(String(value));
  else if (f instanceof PDFDropdown) value === "" ? f.clear() : f.select(String(value));
  else if (f instanceof PDFOptionList)
    Array.isArray(value) && value.length ? f.select(value.map(String)) : f.clear();
  else if (f instanceof PDFButton) throw new Error(`«${name}» is a button`);
  else throw new Error(`«${name}» cannot be filled`);
}

// ---- the whole --------------------------------------------------------------------------------

/** The bytes of a source (a page or an area comes back from it). */
export async function sourceBytes(src: PdfSource, blob: BlobOf, depth = 0): Promise<Uint8Array> {
  if (depth > 20) throw new Error("the version a page comes back from is too deep");
  const base = await blob(src.base);
  if (!base) throw new Error("the version a page comes back from is not kept anymore");
  if (!src.ops.length) return base;
  return (await writePdf(base, src.ops, blob, depth + 1)).bytes;
}

/**
 * The actions written into the bytes: an incremental update when they allow it, the file written
 * anew otherwise (pages, redaction).
 */
export async function writePdf(
  base: Uint8Array,
  ops: readonly PdfPlainAction[],
  blob: BlobOf,
  depth = 0,
): Promise<Written> {
  if (!ops.length) return { bytes: base, rewrote: false, redacted: [] };
  const doc = await loadPdf(base);
  if (doc.isEncrypted) throw new Error("the PDF is encrypted: it is shown, never written");
  const prev = lastStartXref(base);
  const section = prev !== undefined ? sectionAt(base, prev) : undefined;
  const rewrite = ops.some(rewrites) || prev === undefined || !section;
  if (section?.size && section.size - 1 > doc.context.largestObjectNumber)
    doc.context.largestObjectNumber = section.size - 1;
  const before = rewrite ? undefined : fingerprint(doc.context);
  let font: PDFFont | undefined;
  const fonts = () => {
    font ??= doc.embedStandardFont(StandardFonts.Helvetica);
    return font;
  };
  let filled = false;
  const redacted: { page: number; rects: PdfRect[] }[] = [];
  for (const a of ops) {
    switch (a.t) {
      case "annotate":
        await addAnnotation(doc, a.a, fonts, blob);
        break;
      case "remove_annotation":
        removeAnnotation(doc, a.page, a.id, a.info.ref);
        break;
      case "restore_annotation": {
        const ref = a.info.ref ? parseRefName(a.info.ref) : undefined;
        if (ref && doc.context.lookup(ref)) annotsOf(doc, a.page).push(ref);
        else if (a.info.data)
          await addAnnotation(doc, { ...a.info.data, page: a.page }, fonts, blob);
        else throw new Error(`the annotation «${a.id}» is not in the file anymore`);
        break;
      }
      case "fill_field":
        fillField(doc, a.name, a.value);
        filled = true;
        break;
      case "rotate_page":
        doc.getPage(a.page).setRotation(degrees(a.to));
        break;
      case "delete_page":
        doc.removePage(a.page);
        break;
      case "move_page": {
        const p = doc.getPage(a.from);
        doc.removePage(a.from);
        doc.insertPage(a.to, p);
        break;
      }
      case "restore_page":
      case "unredact": {
        const src = await loadPdf(await sourceBytes(a.source, blob, depth));
        const [p] = await doc.copyPages(src, [a.index]);
        if (!p) throw new Error("the page to bring back is not in its version");
        if (a.t === "unredact") {
          doc.removePage(a.page);
          doc.insertPage(a.page, p);
        } else doc.insertPage(a.at, p);
        break;
      }
      case "redact":
        await redactPage(doc, a.page, a.rects);
        redacted.push({ page: a.page, rects: a.rects });
        break;
    }
  }
  if (filled) {
    const form = doc.getForm();
    try {
      form.updateFieldAppearances(fonts());
    } catch {
      // A value Helvetica cannot draw: the readers draw the fields themselves.
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
    }
  }
  await doc.flush();
  if (rewrite) {
    if (redacted.length) pruneUnreachable(doc);
    const bytes = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    return { bytes, rewrote: true, redacted };
  }
  return {
    bytes: incremental(
      base,
      doc,
      before as Map<string, { obj: PDFObject; s: string }>,
      prev as number,
      section as { stream: boolean },
    ),
    rewrote: false,
    redacted,
  };
}

/** Objects nothing points to anymore are dropped (what a redaction took out must not stay). */
export function pruneUnreachable(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const info = ctx.trailerInfo;
  for (const v of [info.Root, info.Info, info.ID]) if (v) stack.push(v as PDFObject);
  while (stack.length) {
    const o = stack.pop() as PDFObject;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const t = ctx.lookup(o);
      if (t) stack.push(t);
    } else if (o instanceof PDFDict) for (const v of o.values()) stack.push(v);
    else if (o instanceof PDFArray) for (const v of o.asArray()) stack.push(v);
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects())
    if (!seen.has(ref.toString())) {
      ctx.delete(ref);
      n++;
    }
  return n;
}
