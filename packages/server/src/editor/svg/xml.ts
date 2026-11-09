// A small XML reader and writer that keeps the file's own bytes (G37.6). Every node remembers the
// text it came from: writing the tree back gives the same file byte for byte, and an element whose
// attributes changed rewrites only its start tag (the untouched attributes as they were, with
// their spaces and quotes). Namespaces are not resolved: names are kept as written (`inkscape:label`),
// so attributes and elements of any program survive. Entities: the five of XML, character
// references and the ones a DOCTYPE declares (Illustrator's `&ns_svg;`). Our own code (MIT): no
// parser library is carried.

export interface XAttr {
  name: string;
  /** The value, entities resolved. */
  value: string;
  /** As written, with the spaces before it: ` name="v"`. Absent once changed. */
  raw?: string;
}

export interface XEl {
  k: "el";
  name: string;
  attrs: readonly XAttr[];
  children: readonly XNode[];
  /** Written `<x/>`. */
  empty: boolean;
  /** The start tag as written (absent once the attributes changed), and its tail (`\n  /`). */
  open?: string;
  tail: string;
  /** The end tag as written (`</x >`). */
  close?: string;
}

export type XNode =
  | XEl
  | { k: "text"; raw: string }
  | { k: "cdata"; raw: string }
  /** A comment, a processing instruction, a DOCTYPE: kept as they are. */
  | { k: "other"; raw: string };

export interface XDoc {
  bom: boolean;
  /** Before the root element (the XML declaration, comments, DOCTYPE, spaces). */
  head: readonly XNode[];
  root: XEl;
  tail: readonly XNode[];
  /** Entities the DOCTYPE declares. */
  entities: Readonly<Record<string, string>>;
}

export class XmlError extends Error {}

const NAME = /[A-Za-z_:À-￿][\w.:\-·À-￿]*/y;
const SPACE = /[ \t\r\n]*/y;
const BASIC: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Text with its entities resolved. */
export function decode(raw: string, entities: Readonly<Record<string, string>> = {}): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return BASIC[e] ?? (entities[e] !== undefined ? decode(entities[e], {}) : m);
  });
}

export const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");

function lineOf(s: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at && i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/** The entities a DOCTYPE's internal subset declares (`<!ENTITY name "value">`). */
function entitiesOf(doctype: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of doctype.matchAll(/<!ENTITY\s+([A-Za-z_][\w.-]*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g))
    out[m[1] as string] = m[2] ?? m[3] ?? "";
  return out;
}

class Reader {
  i = 0;
  entities: Record<string, string> = {};
  constructor(readonly s: string) {}

  fail(why: string): never {
    throw new XmlError(`not well-formed XML at line ${lineOf(this.s, this.i)}: ${why}`);
  }

  name(): string {
    NAME.lastIndex = this.i;
    const m = NAME.exec(this.s);
    if (!m) this.fail("a name was expected");
    this.i += m[0].length;
    return m[0];
  }

  space(): string {
    SPACE.lastIndex = this.i;
    const m = SPACE.exec(this.s) as RegExpExecArray;
    this.i += m[0].length;
    return m[0];
  }

  until(end: string, what: string): number {
    const j = this.s.indexOf(end, this.i);
    if (j < 0) this.fail(`${what} is not closed`);
    return j;
  }

  /** A comment, PI, CDATA or DOCTYPE at `<`, or undefined. */
  special(): XNode | undefined {
    const s = this.s;
    const start = this.i;
    if (s.startsWith("<!--", start)) {
      const j = this.until("-->", "a comment");
      this.i = j + 3;
      return { k: "other", raw: s.slice(start, this.i) };
    }
    if (s.startsWith("<![CDATA[", start)) {
      const j = this.until("]]>", "a CDATA section");
      this.i = j + 3;
      return { k: "cdata", raw: s.slice(start, this.i) };
    }
    if (s.startsWith("<?", start)) {
      const j = this.until("?>", "a processing instruction");
      this.i = j + 2;
      return { k: "other", raw: s.slice(start, this.i) };
    }
    if (s.startsWith("<!DOCTYPE", start) || s.startsWith("<!doctype", start)) {
      // Up to the `>` outside the internal subset and outside quotes.
      let depth = 0;
      let q = "";
      let j = start + 9;
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) {
          if (c === q) q = "";
        } else if (c === '"' || c === "'") q = c;
        else if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= s.length) this.fail("the DOCTYPE is not closed");
      this.i = j + 1;
      const raw = s.slice(start, this.i);
      Object.assign(this.entities, entitiesOf(raw));
      return { k: "other", raw };
    }
    return undefined;
  }

  attrs(): { attrs: XAttr[]; tail: string } {
    const attrs: XAttr[] = [];
    const seen = new Set<string>();
    for (;;) {
      const ws = this.space();
      const c = this.s[this.i];
      if (c === ">" || c === "/" || c === undefined) return { attrs, tail: ws };
      if (!ws) this.fail("attributes must be separated by spaces");
      const start = this.i - ws.length;
      const name = this.name();
      this.space();
      if (this.s[this.i] !== "=") this.fail(`the attribute ${name} has no value`);
      this.i++;
      this.space();
      const q = this.s[this.i];
      if (q !== '"' && q !== "'") this.fail(`the value of ${name} is not quoted`);
      const j = this.s.indexOf(q, this.i + 1);
      if (j < 0) this.fail(`the value of ${name} is not closed`);
      const rawValue = this.s.slice(this.i + 1, j);
      if (rawValue.includes("<")) this.fail(`the value of ${name} holds a <`);
      this.i = j + 1;
      if (seen.has(name)) this.fail(`the attribute ${name} is written twice`);
      seen.add(name);
      attrs.push({
        name,
        // Attribute value normalization: line ends and tabs read as spaces, as a browser does.
        value: decode(rawValue.replace(/[\r\n\t]/g, " "), this.entities),
        raw: this.s.slice(start, this.i),
      });
    }
  }

  element(): XEl {
    const start = this.i;
    this.i++; // <
    const name = this.name();
    const { attrs, tail } = this.attrs();
    if (this.s.startsWith("/>", this.i)) {
      this.i += 2;
      return {
        k: "el",
        name,
        attrs,
        children: [],
        empty: true,
        open: this.s.slice(start, this.i),
        tail: `${tail}/`,
      };
    }
    if (this.s[this.i] !== ">") this.fail(`the tag <${name}> is not closed`);
    this.i++;
    const open = this.s.slice(start, this.i);
    const children = this.content(name);
    const closeStart = this.i;
    this.i += 2; // </
    const end = this.name();
    if (end !== name) this.fail(`</${end}> closes <${name}>`);
    this.space();
    if (this.s[this.i] !== ">") this.fail(`</${end}> is not closed`);
    this.i++;
    return {
      k: "el",
      name,
      attrs,
      children,
      empty: false,
      open,
      tail,
      close: this.s.slice(closeStart, this.i),
    };
  }

  /** Nodes up to `</parent` (or the end, for a fragment). */
  content(parent: string | undefined): XNode[] {
    const out: XNode[] = [];
    const s = this.s;
    while (this.i < s.length) {
      if (s[this.i] !== "<") {
        const j = s.indexOf("<", this.i);
        const end = j < 0 ? s.length : j;
        out.push({ k: "text", raw: s.slice(this.i, end) });
        this.i = end;
        continue;
      }
      if (s.startsWith("</", this.i)) {
        if (parent === undefined) this.fail("an end tag without its start");
        return out;
      }
      const sp = this.special();
      if (sp) {
        if (sp.k === "other" && /^<!doctype/i.test(sp.raw))
          this.fail("a DOCTYPE inside an element");
        out.push(sp);
        continue;
      }
      out.push(this.element());
    }
    if (parent !== undefined) this.fail(`<${parent}> is not closed`);
    return out;
  }
}

/** Reads a whole document. */
export function parseXml(text: string): XDoc {
  const bom = text.charCodeAt(0) === 0xfeff;
  const r = new Reader(bom ? text.slice(1) : text);
  const head: XNode[] = [];
  let root: XEl | undefined;
  const tail: XNode[] = [];
  const s = r.s;
  while (r.i < s.length) {
    const ws = r.space();
    if (ws) (root ? tail : head).push({ k: "text", raw: ws });
    if (r.i >= s.length) break;
    if (s[r.i] !== "<") r.fail("text outside the root element");
    const sp = r.special();
    if (sp) {
      if (sp.k === "cdata") r.fail("CDATA outside the root element");
      (root ? tail : head).push(sp);
      continue;
    }
    if (root) r.fail("a second root element");
    root = r.element();
  }
  if (!root) throw new XmlError("not XML: there is no root element");
  return { bom, head, root, tail, entities: r.entities };
}

/** Reads a piece of markup (an element's content, an element to insert). */
export function parseFragment(
  xml: string,
  entities: Readonly<Record<string, string>> = {},
): XNode[] {
  const r = new Reader(xml);
  r.entities = { ...entities };
  return r.content(undefined);
}

// ---- writing -------------------------------------------------------------------------------

export function startTag(el: XEl): string {
  if (el.open !== undefined) return el.open;
  let s = `<${el.name}`;
  for (const a of el.attrs) s += a.raw ?? ` ${a.name}="${escapeAttr(a.value)}"`;
  return `${s}${el.tail}>`;
}

export function writeNode(n: XNode, out: string[] = []): string[] {
  if (n.k !== "el") {
    out.push(n.raw);
    return out;
  }
  out.push(startTag(n));
  if (n.empty) return out;
  for (const c of n.children) writeNode(c, out);
  out.push(n.close ?? `</${n.name}>`);
  return out;
}

export const nodeText = (n: XNode): string => writeNode(n).join("");

export function writeXml(d: XDoc): string {
  const out: string[] = [];
  for (const n of d.head) writeNode(n, out);
  writeNode(d.root, out);
  for (const n of d.tail) writeNode(n, out);
  return (d.bom ? "﻿" : "") + out.join("");
}

// ---- reading values ------------------------------------------------------------------------

export const attrOf = (el: XEl, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;

/** The element's own text (its text and CDATA children, not its elements'). */
export function ownText(el: XEl, entities: Readonly<Record<string, string>>): string {
  let s = "";
  for (const c of el.children)
    if (c.k === "text") s += decode(c.raw, entities);
    else if (c.k === "cdata") s += c.raw.slice(9, -3);
  return s;
}

/** All the text inside, as a browser's textContent. */
export function textContent(el: XEl, entities: Readonly<Record<string, string>>): string {
  let s = "";
  for (const c of el.children)
    if (c.k === "text") s += decode(c.raw, entities);
    else if (c.k === "cdata") s += c.raw.slice(9, -3);
    else if (c.k === "el") s += textContent(c, entities);
  return s;
}

// ---- changing (a new element; the old one is never touched) --------------------------------

/** The element with attributes set (null removes); untouched attributes keep their bytes. */
export function withAttrs(el: XEl, set: Readonly<Record<string, string | null>>): XEl {
  const attrs: XAttr[] = [];
  const done = new Set<string>();
  for (const a of el.attrs) {
    if (!(a.name in set)) {
      attrs.push(a);
      continue;
    }
    done.add(a.name);
    const v = set[a.name];
    if (v === null || v === undefined) continue;
    if (v === a.value) attrs.push(a);
    else {
      // Its place and its spaces stay; the value is written again.
      const lead = a.raw?.match(/^\s*/)?.[0] || " ";
      attrs.push({ name: a.name, value: v, raw: `${lead}${a.name}="${escapeAttr(v)}"` });
    }
  }
  // New ones at the end, with the spaces the last attribute had (one per line in Inkscape).
  const lead =
    attrs.at(-1)?.raw?.match(/^\s*/)?.[0] || el.attrs.at(-1)?.raw?.match(/^\s*/)?.[0] || " ";
  for (const [name, v] of Object.entries(set))
    if (!done.has(name) && v !== null && v !== undefined)
      attrs.push({ name, value: v, raw: `${lead}${name}="${escapeAttr(v)}"` });
  const same = attrs.length === el.attrs.length && attrs.every((a, i) => a === el.attrs[i]);
  if (same) return el;
  const { open: _o, ...rest } = el;
  return { ...rest, attrs };
}

export function withChildren(el: XEl, children: readonly XNode[]): XEl {
  if (!el.empty) return { ...el, children };
  // `<x/>` with content becomes `<x>…</x>`.
  const { open: _o, ...rest } = el;
  return { ...rest, empty: false, tail: el.tail.replace(/\s*\/$/, ""), children };
}
