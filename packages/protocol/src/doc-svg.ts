// Vector drawings in the editor (G37.6): the `svg` family. The server keeps the file's own XML
// (every byte it did not touch is written back as it was: Inkscape's and Sodipodi's attributes,
// metadata, unknown elements, spaces in texts) and applies small JSON actions to it; the page
// edits with @svgedit/svgcanvas and sends the same actions. Elements are named by their id. An
// element without one has a "virtual" id the server and the page compute alike from its tag, its
// attributes and its own text (`svgVirtualId`): actions that change an element give it a real id
// first (`name`), so their inverses still find it after a reload; places (a parent, the element
// to go before) may stay virtual.
import { z } from "zod";

const Id = z.string().min(1).max(300);
/** An id, a virtual id (`rgv-…`), or "" for the drawing's root element. */
const Ref = z.string().max(300);
const Xml = z.string().max(5_000_000);
const Values = z.record(z.string().min(1).max(200), z.string().max(2_000_000).nullable());

const plain = {
  /** The element `ref` (virtual) gets the real id `id`. */
  name: z.object({ t: z.literal("name"), ref: Ref, id: Id }),
  /** Attributes written exactly as given (null removes one). */
  attrs: z.object({ t: z.literal("attrs"), id: Id, set: Values }),
  /**
   * Presentation properties (fill, stroke, opacity…): written inside the element's `style` when it
   * has that property there, as attributes otherwise ("#href" is its link, href or xlink:href).
   */
  props: z.object({ t: z.literal("props"), id: Id, set: Values }),
  /** The element's content (text, or markup) replaced. */
  inner: z.object({ t: z.literal("inner"), id: Id, xml: Xml }),
  /** An element (with an id) put in `parent` before `before` (at the end when null). */
  insert: z.object({
    t: z.literal("insert"),
    parent: Ref,
    before: Ref.nullable(),
    xml: Xml,
    /** The spaces before it (the file's indentation). */
    ws: z.string().max(400).optional(),
  }),
  remove: z.object({ t: z.literal("remove"), id: Id }),
  move: z.object({ t: z.literal("move"), id: Id, parent: Ref, before: Ref.nullable() }),
  /** The whole file (a change from outside, kept to be undone). */
  doc: z.object({ t: z.literal("doc"), text: Xml }),
};

export const SvgPlainAction = z.discriminatedUnion("t", [
  plain.name,
  plain.attrs,
  plain.props,
  plain.inner,
  plain.insert,
  plain.remove,
  plain.move,
  plain.doc,
]);
export type SvgPlainAction = z.infer<typeof SvgPlainAction>;

export const SvgAction = z.discriminatedUnion("t", [
  ...SvgPlainAction.options,
  z.object({ t: z.literal("batch"), ops: z.array(SvgPlainAction).max(5000) }),
]);
export type SvgAction = z.infer<typeof SvgAction>;

export const SvgDocOp = z.object({
  family: z.literal("svg"),
  engine: z.literal("svg-dom"),
  engineVersion: z.string().max(40),
  op: SvgAction,
});
export type SvgDocOp = z.infer<typeof SvgDocOp>;

export const SvgSnapshot = z.object({
  family: z.literal("svg"),
  /** The file as the host has it now. */
  text: z.string(),
});
export type SvgSnapshot = z.infer<typeof SvgSnapshot>;

/** What a drawing's change was, for the panel's words (`DocSummary.svg`). */
export const SvgChange = z.object({
  action: z.enum([
    "add",
    "delete",
    "style",
    "shape",
    "transform",
    "text",
    "order",
    "group",
    "ungroup",
    "change",
    "replace",
    "edit",
  ]),
  /** Elements touched. */
  n: z.number().int().nonnegative(),
  /** Their tag, when they are all of one kind (rect, ellipse, text…). */
  tag: z.string().max(60).optional(),
  /** The one element's id. */
  id: z.string().max(300).optional(),
});
export type SvgChange = z.infer<typeof SvgChange>;

// -------------------------------------------------------------------------------------------
// Virtual ids: the same on the server (its own XML tree) and in the page (the DOM).

/** The part of an element its virtual id is made of: tag, attributes but the id, own text. */
export function svgFingerprint(
  tag: string,
  attrs: readonly (readonly [string, string])[],
  ownText: string,
): string {
  const a = attrs
    .filter(([n]) => n !== "id")
    .map(([n, v]) => `${n}=${v}`)
    .sort()
    .join("\u0002");
  return `${tag}\u0001${a}\u0001${ownText.replace(/\s+/g, " ").trim()}`;
}

/** FNV-1a, 32 bits, as 8 hex digits. */
export function svgHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export const SVG_VIRTUAL = "rgv-";

/** The virtual id of the `k`-th element without an id with this fingerprint (in document order). */
export const svgVirtualId = (fingerprint: string, k: number): string =>
  `${SVG_VIRTUAL}${svgHash(fingerprint)}${k ? `-${k}` : ""}`;

export const isSvgVirtual = (ref: string): boolean => ref.startsWith(SVG_VIRTUAL);
