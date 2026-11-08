// The outline of an ODT or ODP (G37.4), read from its content.xml in JavaScript: the body's
// paragraphs and tables in the order LibreOffice enumerates them (lists, sections and indexes are
// gone through; frames, notes and tracked deletions are not body text), the slides with their
// shapes in order. The engines (ZetaOffice in the page, LibreOffice headless here) count the same
// way; every action also carries the text it expects, so a small difference in counting finds
// its paragraph nearby or refuses. No LibreOffice needed: the agent reads a document without it.
import type { OfficeItem, OfficeOutline, OfficeShape, OfficeSlide } from "@redgiant/protocol";
import { strFromU8 } from "fflate";
import { parseXml, unzip, type XmlNode } from "../convert-js.js";

export const WRITER_MIME = "application/vnd.oasis.opendocument.text";
export const IMPRESS_MIME = "application/vnd.oasis.opendocument.presentation";

/** An ODF name as LibreOffice's API knows it: «Heading_20_1» is «Heading 1». */
export const odfStyleName = (s: string) =>
  s.replace(/_([0-9a-f]{2})_/gi, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

const isEl = (n: XmlNode | string): n is XmlNode => typeof n !== "string";
const kids = (n: XmlNode) => n.children.filter(isEl);

function find(n: XmlNode, name: string): XmlNode | undefined {
  for (const c of kids(n)) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}

/** A paragraph's text as LibreOffice's getString gives it (frames and notes left out). */
export function paragraphText(p: XmlNode): string {
  let out = "";
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (typeof c === "string") {
        out += c.replace(/[\t\n\r ]+/g, " ");
        continue;
      }
      switch (c.name) {
        case "text:s":
          out += " ".repeat(Math.max(1, Number(c.attrs["text:c"] ?? 1) || 1));
          break;
        case "text:tab":
          out += "\t";
          break;
        case "text:line-break":
          out += "\n";
          break;
        case "draw:frame":
        case "draw:a":
        case "text:note":
        case "office:annotation":
        case "office:annotation-end":
        case "text:bookmark":
        case "text:bookmark-start":
        case "text:bookmark-end":
        case "text:soft-page-break":
        case "text:change":
        case "text:change-start":
        case "text:change-end":
        case "text:ruby-text":
        case "draw:custom-shape":
        case "draw:rect":
        case "draw:line":
        case "draw:g":
          break;
        default:
          walk(c);
      }
    }
  };
  walk(p);
  return out;
}

/** Pictures anchored in a paragraph (frames with an image). */
const picturesIn = (p: XmlNode): number => {
  let n = 0;
  const walk = (x: XmlNode) => {
    for (const c of kids(x)) {
      if (c.name === "draw:frame" && kids(c).some((k) => k.name === "draw:image")) n++;
      else if (c.name !== "text:note") walk(c);
    }
  };
  walk(p);
  return n;
};

/** Automatic paragraph styles (P1, P2…) point to the named style they derive from. */
function styleResolver(content: XmlNode): (name: string | undefined) => string {
  const auto = new Map<string, string>();
  const autos = find(content, "office:automatic-styles");
  for (const s of autos ? kids(autos) : [])
    if (s.name === "style:style" && s.attrs["style:family"] === "paragraph") {
      const parent = s.attrs["style:parent-style-name"];
      if (s.attrs["style:name"] && parent) auto.set(s.attrs["style:name"], parent);
    }
  return (name) => {
    if (!name) return "Standard";
    return odfStyleName(auto.get(name) ?? name);
  };
}

const cellText = (cell: XmlNode) =>
  kids(cell)
    .filter((c) => c.name === "text:p" || c.name === "text:h")
    .map(paragraphText)
    .join("\n");

/** A table's cells (repeated rows and columns spread, at most 200 × 50). */
function tableCells(t: XmlNode): string[][] {
  const rows: string[][] = [];
  const addRow = (r: XmlNode) => {
    const row: string[] = [];
    for (const c of kids(r))
      if (c.name === "table:table-cell" || c.name === "table:covered-table-cell") {
        const rep = Math.min(50, Number(c.attrs["table:number-columns-repeated"] ?? 1) || 1);
        for (let i = 0; i < rep && row.length < 50; i++)
          row.push(c.name === "table:covered-table-cell" ? "" : cellText(c));
      }
    const rep = Math.min(200, Number(r.attrs["table:number-rows-repeated"] ?? 1) || 1);
    for (let i = 0; i < rep && rows.length < 200; i++) rows.push([...row]);
  };
  const walk = (n: XmlNode) => {
    for (const c of kids(n)) {
      if (c.name === "table:table-row") addRow(c);
      else if (
        c.name === "table:table-header-rows" ||
        c.name === "table:table-rows" ||
        c.name === "table:table-row-group"
      )
        walk(c);
    }
  };
  walk(t);
  return rows;
}

/** The body items of an office:text, in LibreOffice's order. */
function writerItems(body: XmlNode, style: (n: string | undefined) => string): OfficeItem[] {
  const items: OfficeItem[] = [];
  const walk = (n: XmlNode, list: boolean) => {
    for (const c of kids(n)) {
      switch (c.name) {
        case "text:p":
        case "text:h": {
          const level = c.name === "text:h" ? Number(c.attrs["text:outline-level"] ?? 1) : 0;
          const pics = picturesIn(c);
          items.push({
            k: "p",
            text: paragraphText(c),
            style: style(c.attrs["text:style-name"]),
            ...(level > 0 && { level: Math.min(10, level) }),
            ...(list && { list: true }),
            ...(pics > 0 && { pics }),
          });
          break;
        }
        case "table:table": {
          const cells = tableCells(c);
          items.push({
            k: "table",
            name: c.attrs["table:name"] ?? `Table${items.length + 1}`,
            rows: cells.length,
            cols: Math.max(0, ...cells.map((r) => r.length)),
            cells,
          });
          break;
        }
        case "text:list":
        case "text:list-item":
        case "text:list-header":
        case "text:numbered-paragraph":
          walk(c, true);
          break;
        case "text:section":
        case "text:index-body":
        case "text:index-title":
        case "text:table-of-content":
        case "text:illustration-index":
        case "text:table-index":
        case "text:object-index":
        case "text:user-index":
        case "text:alphabetical-index":
        case "text:bibliography":
          walk(c, list);
          break;
        default:
          // Declarations, page-anchored frames, forms, tracked changes: not body text.
          break;
      }
    }
  };
  walk(body, false);
  return items;
}

/** A length of ODF («2.5cm», «1in», «72pt», «10mm») in hundredths of a millimetre. */
export function mm100(v: string | undefined): number | undefined {
  const m = v?.match(/^(-?[\d.]+)(cm|mm|in|pt|pc|px)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const per: Record<string, number> = {
    cm: 1000,
    mm: 100,
    in: 2540,
    pt: 2540 / 72,
    pc: 2540 / 6,
    px: 2540 / 96,
  };
  return Math.round(n * (per[m[2] ?? "cm"] ?? 1000));
}

const SHAPES = new Set([
  "draw:frame",
  "draw:custom-shape",
  "draw:rect",
  "draw:ellipse",
  "draw:circle",
  "draw:line",
  "draw:path",
  "draw:polygon",
  "draw:polyline",
  "draw:regular-polygon",
  "draw:connector",
  "draw:caption",
  "draw:measure",
  "draw:control",
  "draw:g",
  "dr3d:scene",
]);

/** A shape's text: its paragraphs, one per line (lists gone through). */
function shapeText(n: XmlNode): string {
  const lines: string[] = [];
  const walk = (x: XmlNode) => {
    for (const c of kids(x)) {
      if (c.name === "text:p" || c.name === "text:h") lines.push(paragraphText(c));
      else if (c.name === "table:table") {
        // A table's text is its own (not a shape's string).
      } else walk(c);
    }
  };
  walk(n);
  return lines.join("\n");
}

function shapeOf(n: XmlNode): OfficeShape {
  const cls = n.attrs["presentation:class"];
  const has = (name: string) => kids(n).some((k) => k.name === name);
  const kind: OfficeShape["kind"] =
    cls === "title"
      ? "title"
      : cls === "subtitle"
        ? "subtitle"
        : cls === "outline"
          ? "outline"
          : n.name === "draw:frame"
            ? has("draw:object") || has("draw:object-ole")
              ? "chart"
              : has("table:table")
                ? "table"
                : has("draw:image") && !has("draw:text-box")
                  ? "picture"
                  : has("draw:text-box")
                    ? "text"
                    : "other"
            : n.name === "draw:g" || n.name === "dr3d:scene" || n.name === "draw:control"
              ? "other"
              : "shape";
  const geo = {
    x: mm100(n.attrs["svg:x"]),
    y: mm100(n.attrs["svg:y"]),
    w: mm100(n.attrs["svg:width"]),
    h: mm100(n.attrs["svg:height"]),
  };
  return {
    kind,
    ...(n.attrs["draw:name"] && { name: n.attrs["draw:name"] }),
    text: kind === "table" ? "" : shapeText(n),
    ...Object.fromEntries(Object.entries(geo).filter(([, v]) => v !== undefined)),
  };
}

/** LibreOffice's AutoLayout from the placeholders a slide has (a good guess for snapshots). */
export function layoutOf(shapes: readonly OfficeShape[]): number {
  const title = shapes.some((s) => s.kind === "title");
  const sub = shapes.some((s) => s.kind === "subtitle");
  const outlines = shapes.filter((s) => s.kind === "outline").length;
  if (title && sub) return 0;
  if (title && outlines >= 2) return 3;
  if (title && outlines === 1) return 1;
  if (title) return 19;
  return 20;
}

function impressSlides(pres: XmlNode): OfficeSlide[] {
  return kids(pres)
    .filter((p) => p.name === "draw:page")
    .map((p, i) => {
      const shapes = kids(p)
        .filter((c) => SHAPES.has(c.name))
        .map(shapeOf);
      return { name: p.attrs["draw:name"] ?? `page${i + 1}`, layout: layoutOf(shapes), shapes };
    });
}

/** The paragraph styles a document offers (named ones, as the API knows them). */
function stylesOf(styles: XmlNode | undefined, content: XmlNode): string[] {
  const out = new Set<string>(["Standard"]);
  for (const root of [styles, content]) {
    const s = root && find(root, "office:styles");
    for (const x of s ? kids(s) : [])
      if (
        x.name === "style:style" &&
        x.attrs["style:family"] === "paragraph" &&
        x.attrs["style:name"]
      )
        out.add(odfStyleName(x.attrs["style:name"]));
  }
  return [...out].slice(0, 5000);
}

/** The outline of an ODT or ODP; throws with a reason for anything else. */
export function readOutline(bytes: Uint8Array): OfficeOutline {
  const files = unzip(bytes);
  if (!files) throw new Error("it is not an OpenDocument file (not a zip)");
  const mime = files.mimetype ? strFromU8(files.mimetype).trim() : "";
  const contentBytes = files["content.xml"];
  if (!contentBytes) throw new Error("it has no content.xml");
  const content = parseXml(strFromU8(contentBytes));
  if (mime === WRITER_MIME) {
    const body = find(content, "office:text");
    if (!body) throw new Error("it has no text body");
    const styles = files["styles.xml"] ? parseXml(strFromU8(files["styles.xml"])) : undefined;
    return {
      app: "writer",
      items: writerItems(body, styleResolver(content)),
      styles: stylesOf(styles, content),
    };
  }
  if (mime === IMPRESS_MIME) {
    const pres = find(content, "office:presentation");
    if (!pres) throw new Error("it has no slides");
    return { app: "impress", slides: impressSlides(pres) };
  }
  throw new Error(
    mime ? `it is ${mime}, not a text document or a presentation` : "it has no mimetype",
  );
}

/** What can be compared between an engine's text and the outline's (letters and digits only). */
export const sameText = (a: string, b: string) => {
  const k = (s: string) =>
    s
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .slice(0, 120);
  return k(a) === k(b);
};
