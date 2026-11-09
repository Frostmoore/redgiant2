// PDFs in the editor (G37.8): the `pdf` family. A PDF is an open format (ISO 32000): it is edited
// in place. Annotations, form fields and page rotations are written as an incremental update (the
// original bytes stay untouched at the head of the file, a section is added at its end); taking
// pages out, moving them and redacting write the file anew, and the version before is kept. The
// person draws with pdf.js's editor in the page; the server writes every action itself (pdf-lib,
// no interface), so an agent edits a PDF nobody has open. Coordinates are PDF points in the
// page's own space (origin at the bottom left, before the page's rotation), as pdf.js gives them.
import { z } from "zod";

const Num = z.number().finite().min(-1e6).max(1e6);
/** [x1, y1, x2, y2] in points. */
export const PdfRect = z.tuple([Num, Num, Num, Num]);
export type PdfRect = z.infer<typeof PdfRect>;
/** An RGB colour, each part 0-1. */
const Color = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
const PageIndex = z.number().int().nonnegative().max(100_000);
const Text = z.string().max(20_000);
const Id = z.string().min(1).max(200);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

export const PDF_ANNOT_KINDS = [
  "highlight",
  "underline",
  "strikeout",
  "freetext",
  "ink",
  "note",
  "square",
  "stamp",
  "signature",
] as const;
export const PdfAnnotKind = z.enum(PDF_ANNOT_KINDS);
export type PdfAnnotKind = z.infer<typeof PdfAnnotKind>;

/** A picture an action puts on a page (a stamp, a signature): kept apart, cited by its sha256. */
export const PdfImage = z.object({
  blob: Hash,
  mime: z.enum(["image/png", "image/jpeg"]),
});
export type PdfImage = z.infer<typeof PdfImage>;

/** An annotation the editor writes: everything needed to make it again. */
export const PdfAnnot = z.object({
  /** Its stable id, written as the annotation's name (/NM). */
  id: Id,
  page: PageIndex,
  kind: PdfAnnotKind,
  rect: PdfRect,
  /** Highlight, underline, strike-out: 8 numbers per quadrilateral, as /QuadPoints. */
  quads: z
    .array(Num)
    .max(8 * 2000)
    .optional(),
  /** Drawing and drawn signatures: each stroke as x, y, x, y… */
  paths: z.array(z.array(Num).max(20_000)).max(500).optional(),
  text: Text.optional(),
  color: Color.optional(),
  /** The line's width (drawing, box) or the text's size (free text), in points. */
  size: z.number().min(0.1).max(200).optional(),
  opacity: z.number().min(0).max(1).optional(),
  image: PdfImage.optional(),
  /** Who wrote it (/T): the person or the agent's name. */
  author: z.string().max(200).optional(),
});
export type PdfAnnot = z.infer<typeof PdfAnnot>;

/** An annotation as the outline knows it: written by us, or found in the file. */
export const PdfAnnotInfo = z.object({
  id: Id,
  /** Its object in the file ("12R", as pdf.js names it), once it is written there. */
  ref: z.string().max(40).optional(),
  /** Ours, or the file's own subtype in lower case ("link", "widget", "popup"…). */
  kind: z.string().max(40),
  rect: PdfRect,
  text: Text.optional(),
  color: Color.optional(),
  author: z.string().max(200).optional(),
  /** Written by an action not yet in the file: what makes it again. */
  data: PdfAnnot.optional(),
});
export type PdfAnnotInfo = z.infer<typeof PdfAnnotInfo>;

export const PdfPageInfo = z.object({
  /** Stable while the file is open (pages move and come back by it). */
  pid: z.string().max(40),
  /** Size in points (the crop box), before the rotation. */
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
  rotate: z.number().int(),
  annots: z.array(PdfAnnotInfo).max(5000),
  /** Areas redacted since the file was opened. */
  redacted: z.number().int().nonnegative().optional(),
});
export type PdfPageInfo = z.infer<typeof PdfPageInfo>;

export const PdfFieldValue = z.union([
  z.string().max(20_000),
  z.boolean(),
  z.array(z.string().max(2000)).max(500),
]);
export type PdfFieldValue = z.infer<typeof PdfFieldValue>;

export const PdfField = z.object({
  /** The fully qualified name. */
  name: z.string().min(1).max(1000),
  type: z.enum(["text", "checkbox", "radio", "dropdown", "list", "button", "signature", "other"]),
  value: PdfFieldValue,
  /** The choices (dropdown, list) or the buttons' values (radio). */
  options: z.array(z.string().max(2000)).max(2000).optional(),
  /** The page of its first widget (`pid`). */
  pid: z.string().max(40).optional(),
  readOnly: z.boolean().optional(),
  multiline: z.boolean().optional(),
});
export type PdfField = z.infer<typeof PdfField>;

/** The PDF as the agent reads it and the host checks the actions on. */
export const PdfOutline = z.object({
  pages: z.array(PdfPageInfo).max(100_000),
  fields: z.array(PdfField).max(20_000),
  /** Encrypted (a password or restrictions): shown, never written. */
  encrypted: z.boolean().optional(),
  /** Signed digitally: any change breaks the signature (the editor says so). */
  signed: z.boolean().optional(),
});
export type PdfOutline = z.infer<typeof PdfOutline>;

/** The file a page or an area comes back from: bytes (a blob) and the actions after them. */
export interface PdfSource {
  base: string;
  ops: PdfPlainAction[];
}
const PdfSource: z.ZodType<PdfSource> = z.lazy(() =>
  z.object({ base: Hash, ops: z.array(PdfPlainAction).max(5000) }),
);

const plain = {
  annotate: z.object({ t: z.literal("annotate"), a: PdfAnnot }),
  /** An annotation taken out; `info` brings it back. */
  remove_annotation: z.object({
    t: z.literal("remove_annotation"),
    page: PageIndex,
    id: Id,
    info: PdfAnnotInfo,
  }),
  /** An annotation of the file put back on its page (the inverse of taking it out). */
  restore_annotation: z.object({
    t: z.literal("restore_annotation"),
    page: PageIndex,
    id: Id,
    info: PdfAnnotInfo,
  }),
  fill_field: z.object({
    t: z.literal("fill_field"),
    name: z.string().min(1).max(1000),
    value: PdfFieldValue,
    before: PdfFieldValue,
  }),
  /** The page's rotation becomes `to` (0, 90, 180, 270). */
  rotate_page: z.object({
    t: z.literal("rotate_page"),
    page: PageIndex,
    to: z.number().int(),
    before: z.number().int(),
  }),
  delete_page: z.object({ t: z.literal("delete_page"), page: PageIndex, info: PdfPageInfo }),
  /** Page `index` of `source` becomes page `at` (the inverse of taking a page out). */
  restore_page: z.object({
    t: z.literal("restore_page"),
    at: PageIndex,
    info: PdfPageInfo,
    source: z.lazy(() => PdfSource),
    index: PageIndex,
  }),
  move_page: z.object({ t: z.literal("move_page"), from: PageIndex, to: PageIndex }),
  /** Text, pictures and drawings under the areas removed from the file for good, then blacked. */
  redact: z.object({
    t: z.literal("redact"),
    page: PageIndex,
    rects: z.array(PdfRect).min(1).max(500),
    info: PdfPageInfo,
  }),
  /** The page as it was before a redaction (its inverse): page `index` of `source`. */
  unredact: z.object({
    t: z.literal("unredact"),
    page: PageIndex,
    rects: z.array(PdfRect).min(1).max(500),
    info: PdfPageInfo,
    source: z.lazy(() => PdfSource),
    index: PageIndex,
  }),
};

export type PdfPlainAction =
  | z.infer<typeof plain.annotate>
  | z.infer<typeof plain.remove_annotation>
  | z.infer<typeof plain.restore_annotation>
  | z.infer<typeof plain.fill_field>
  | z.infer<typeof plain.rotate_page>
  | z.infer<typeof plain.delete_page>
  | {
      t: "restore_page";
      at: number;
      info: PdfPageInfo;
      source: PdfSource;
      index: number;
    }
  | z.infer<typeof plain.move_page>
  | z.infer<typeof plain.redact>
  | {
      t: "unredact";
      page: number;
      rects: PdfRect[];
      info: PdfPageInfo;
      source: PdfSource;
      index: number;
    };

export const PdfPlainAction: z.ZodType<PdfPlainAction> = z.lazy(() =>
  z.discriminatedUnion("t", [
    plain.annotate,
    plain.remove_annotation,
    plain.restore_annotation,
    plain.fill_field,
    plain.rotate_page,
    plain.delete_page,
    plain.restore_page,
    plain.move_page,
    plain.redact,
    plain.unredact,
  ]),
) as z.ZodType<PdfPlainAction>;

export type PdfAction = PdfPlainAction | { t: "batch"; ops: PdfPlainAction[] };
export const PdfAction: z.ZodType<PdfAction> = z.union([
  PdfPlainAction,
  z.object({ t: z.literal("batch"), ops: z.array(PdfPlainAction).min(1).max(5000) }),
]);

/** A PDF operation (G37.8). */
export const PdfDocOp = z.object({
  family: z.literal("pdf"),
  engine: z.literal("redgiant-pdf"),
  engineVersion: z.string().max(40),
  op: PdfAction,
});
export type PdfDocOp = z.infer<typeof PdfDocOp>;

/** The PDF as the page opens it: the outline, and the bytes to fetch for this revision. */
export const PdfSnapshot = z.object({
  family: z.literal("pdf"),
  outline: PdfOutline,
  /** sha256 of the bytes on disk and how many actions follow them (the page fetches the head). */
  base: Hash,
  pending: z.number().int().nonnegative(),
});
export type PdfSnapshot = z.infer<typeof PdfSnapshot>;

/** What a PDF's change is, for the panel's words (DocSummary.pdf). */
export const PdfChangeWords = z.object({
  action: z.enum([
    "annotate",
    "remove_annotation",
    "fill_field",
    "rotate_page",
    "delete_page",
    "restore_page",
    "move_page",
    "redact",
    "unredact",
    "other",
  ]),
  /** 1-based. */
  page: z.number().int().positive().optional(),
  to: z.number().int().optional(),
  kind: z.string().max(40).optional(),
  field: z.string().max(200).optional(),
  n: z.number().int().nonnegative().optional(),
});
export type PdfChangeWords = z.infer<typeof PdfChangeWords>;
