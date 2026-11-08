// Documents and presentations in the editor (G37.4): the `document` family. LibreOffice is the
// engine everywhere (ZetaOffice in the person's page, LibreOffice headless on the server), so an
// operation is a small JSON action that both apply with UNO: change a run of text, insert or
// remove a paragraph or a table, set a paragraph's style or a cell, add or remove a slide, put a
// picture. Items are counted as LibreOffice enumerates a text's body (paragraphs and tables, the
// ones in lists and sections included), slides and their shapes in their order. Every action that
// names an item carries the text it expects there: an engine that finds something else looks
// nearby, then refuses (nothing lands on the wrong paragraph). Only ODF is edited (ODT, ODP): a
// DOCX or PPTX is edited on its open copy beside it.
import { z } from "zod";

const Str = z.string().max(200_000);
const Short = z.string().max(400);
const Index = z.number().int().nonnegative();
/** A size or a position in hundredths of a millimetre (LibreOffice's unit). */
const Mm100 = z.number().int().min(-1_000_000).max(1_000_000);

/** A picture an action puts in the document: kept apart (a blob), cited by its sha256. */
export const OfficePicture = z.object({
  blob: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().max(80),
  /** Its size in the document. */
  w: Mm100,
  h: Mm100,
});
export type OfficePicture = z.infer<typeof OfficePicture>;

/** A shape of a slide as the outline and a slide's snapshot keep it. */
export const OfficeShape = z.object({
  kind: z.enum([
    "title",
    "subtitle",
    "outline",
    "text",
    "picture",
    "chart",
    "table",
    "shape",
    "other",
  ]),
  name: Short.optional(),
  text: Str,
  x: Mm100.optional(),
  y: Mm100.optional(),
  w: Mm100.optional(),
  h: Mm100.optional(),
  picture: OfficePicture.optional(),
});
export type OfficeShape = z.infer<typeof OfficeShape>;

/** What a slide was, enough to bring it back (texts, simple shapes, pictures put by an action). */
export const OfficeSlideSnap = z.object({
  name: Short.optional(),
  /** LibreOffice's AutoLayout number (0 title, 1 title and content, 3 two contents, 19 title only, 20 blank). */
  layout: z.number().int().min(0).max(40),
  shapes: z.array(OfficeShape).max(500),
});
export type OfficeSlideSnap = z.infer<typeof OfficeSlideSnap>;

/** A body item of a text document. */
export const OfficeItem = z.discriminatedUnion("k", [
  z.object({
    k: z.literal("p"),
    text: Str,
    style: Short,
    /** A heading's outline level (1-10). */
    level: z.number().int().min(1).max(10).optional(),
    list: z.boolean().optional(),
    /** Pictures anchored in it. */
    pics: z.number().int().nonnegative().optional(),
  }),
  z.object({
    k: z.literal("table"),
    name: Short,
    rows: z.number().int().nonnegative(),
    cols: z.number().int().nonnegative(),
    cells: z.array(z.array(z.string().max(20_000))).max(5000),
  }),
]);
export type OfficeItem = z.infer<typeof OfficeItem>;

export const OfficeSlide = z.object({
  name: Short,
  layout: z.number().int().min(0).max(40).optional(),
  shapes: z.array(OfficeShape).max(2000),
});
export type OfficeSlide = z.infer<typeof OfficeSlide>;

/** The document as the agent reads it and the host checks the actions on. */
export const OfficeOutline = z.discriminatedUnion("app", [
  z.object({
    app: z.literal("writer"),
    items: z.array(OfficeItem).max(200_000),
    /** The paragraph styles it has (their API names: «Heading 1», «Text body»…). */
    styles: z.array(Short).max(5000),
  }),
  z.object({ app: z.literal("impress"), slides: z.array(OfficeSlide).max(5000) }),
]);
export type OfficeOutline = z.infer<typeof OfficeOutline>;

/** A run of items changed by the person's own edits (an item diff: `del` became `ins` at `at`). */
export const OfficeHunk = z.object({ at: Index, del: Index, ins: Index });
export type OfficeHunk = z.infer<typeof OfficeHunk>;

/** Where a text action writes: a paragraph (Writer) or a shape of a slide (Impress). */
const TextWhere = z.union([z.object({ item: Index }), z.object({ slide: Index, shape: Index })]);

const plain = {
  /** `del` at `off` (UTF-16 units) becomes `ins`. */
  text: z.object({
    t: z.literal("text"),
    at: TextWhere,
    /** The whole text expected there before. */
    expect: Str,
    off: Index,
    del: Str,
    ins: Str,
  }),
  /** A paragraph or a table that becomes item `at`; `prev` is the text of the item before it. */
  insert_item: z.object({
    t: z.literal("insert_item"),
    at: Index,
    prev: Str.nullable(),
    kind: z.enum(["p", "table"]),
    text: Str.optional(),
    style: Short.optional(),
    rows: z.number().int().min(1).max(200).optional(),
    cols: z.number().int().min(1).max(50).optional(),
    cells: z
      .array(z.array(z.string().max(20_000)))
      .max(200)
      .optional(),
    name: Short.optional(),
    picture: OfficePicture.optional(),
  }),
  /** Item `at` removed (its text and style kept, so it can come back). */
  delete_item: z.object({
    t: z.literal("delete_item"),
    at: Index,
    expect: Str,
    kind: z.enum(["p", "table"]),
    text: Str.optional(),
    style: Short.optional(),
    rows: z.number().int().min(1).max(200).optional(),
    cols: z.number().int().min(1).max(50).optional(),
    cells: z
      .array(z.array(z.string().max(20_000)))
      .max(200)
      .optional(),
    name: Short.optional(),
    picture: OfficePicture.optional(),
  }),
  para_style: z.object({
    t: z.literal("para_style"),
    item: Index,
    expect: Str,
    style: Short,
    before: Short,
  }),
  cell: z.object({
    t: z.literal("cell"),
    item: Index,
    /** The table's name. */
    expect: Short,
    cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,4}$/),
    text: z.string().max(20_000),
    before: z.string().max(20_000),
  }),
  /** A slide that becomes slide `at`, with its layout's placeholders (or a snapshot brought back). */
  add_slide: z.object({
    t: z.literal("add_slide"),
    at: Index,
    layout: z.number().int().min(0).max(40),
    title: Str.optional(),
    body: Str.optional(),
    snap: OfficeSlideSnap.optional(),
  }),
  delete_slide: z.object({
    t: z.literal("delete_slide"),
    at: Index,
    /** The slide's title (or its name, without one). */
    expect: Str,
    snap: OfficeSlideSnap,
  }),
  /** A picture appended to a slide's shapes. */
  add_shape: z.object({
    t: z.literal("add_shape"),
    slide: Index,
    expect: Str,
    picture: OfficePicture,
    x: Mm100,
    y: Mm100,
  }),
  delete_shape: z.object({
    t: z.literal("delete_shape"),
    slide: Index,
    shape: Index,
    expect: Str,
    /** What brings it back (a picture an action put). */
    picture: OfficePicture.optional(),
    x: Mm100.optional(),
    y: Mm100.optional(),
  }),
};

export const OfficePlainAction = z.discriminatedUnion("t", [
  plain.text,
  plain.insert_item,
  plain.delete_item,
  plain.para_style,
  plain.cell,
  plain.add_slide,
  plain.delete_slide,
  plain.add_shape,
  plain.delete_shape,
]);
export type OfficePlainAction = z.infer<typeof OfficePlainAction>;

export const OfficeAction = z.discriminatedUnion("t", [
  plain.text,
  plain.insert_item,
  plain.delete_item,
  plain.para_style,
  plain.cell,
  plain.add_slide,
  plain.delete_slide,
  plain.add_shape,
  plain.delete_shape,
  /** Several actions as one (a batch rebased onto later revisions). */
  z.object({ t: z.literal("batch"), ops: z.array(OfficePlainAction).min(1).max(5000) }),
  /**
   * The person's own edits in LibreOffice: the file the page saved (a blob), the items it changed
   * (to move others' actions over it) and the actions of later revisions made again after it.
   */
  z.object({
    t: z.literal("file"),
    blob: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
    hunks: z.array(OfficeHunk).max(10_000),
    replay: z.array(OfficePlainAction).max(5000).optional(),
  }),
  /** The inverse of the person's own edits: only for reading an older revision, never applied. */
  z.object({ t: z.literal("restore"), outline: OfficeOutline }),
]);
export type OfficeAction = z.infer<typeof OfficeAction>;

/** A document or presentation operation (G37.4). */
export const OfficeDocOp = z.object({
  family: z.literal("document"),
  engine: z.literal("libreoffice-uno"),
  engineVersion: z.string().max(40),
  op: OfficeAction,
});
export type OfficeDocOp = z.infer<typeof OfficeDocOp>;

/** The document as the page opens it: the bytes to load (the file, or a blob) and what follows. */
export const OfficeSnapshot = z.object({
  family: z.literal("document"),
  app: z.enum(["writer", "impress"]),
  /** sha256 of the bytes to load: the file on disk or a saved page's blob. */
  base: z.string().regex(/^[0-9a-f]{64}$/),
  /** Actions accepted after those bytes, in order. */
  pending: z.array(OfficeDocOp).max(5000),
  /** Paragraphs and tables, or slides. */
  count: z.number().int().nonnegative(),
});
export type OfficeSnapshot = z.infer<typeof OfficeSnapshot>;

/** Where the person can reach the full editor (the page asks before loading it). */
export const OfficeEngineState = z.object({
  /** The engine's files are here (downloaded once, checked). */
  ready: z.boolean(),
  version: z.string(),
  /** What the browser downloads the first time (compressed), in bytes. */
  size: z.number().int().nonnegative(),
  /** The download running now. */
  job: z.string().optional(),
  /** Why it cannot come (no network, a file that does not match its hash). */
  error: z.string().optional(),
  /** LibreOffice on the server applies the edits when the full editor is not open. */
  serverEngine: z.enum(["here", "download", "missing"]),
});
export type OfficeEngineState = z.infer<typeof OfficeEngineState>;
