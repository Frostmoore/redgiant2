// The page's side of the drawing editor (G37.6), with no svgcanvas in it (tested alone): the
// virtual ids of elements without one (the same as the server's: `svgVirtualId`), others'
// actions applied to the page's DOM, and the person's svgcanvas commands (caught when each is
// made) turned into the same actions the agents send. The server owns the file: the page never
// writes it from its DOM.
import {
  isSvgVirtual,
  type SvgAction,
  type SvgPlainAction,
  svgFingerprint,
  svgVirtualId,
} from "@redgiant/protocol";

export const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
export const SVG_ENGINE_VERSION = "1";

/** Presentation properties: the server writes them in the element's style when it is there. */
export const PRESENTATION = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "display",
  "visibility",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "text-decoration",
  "letter-spacing",
  "word-spacing",
  "marker-start",
  "marker-mid",
  "marker-end",
  "filter",
  "clip-path",
  "mask",
]);

const ownText = (el: Element) => {
  let s = "";
  for (const c of Array.from(el.childNodes))
    if (c.nodeType === 3 || c.nodeType === 4) s += c.nodeValue ?? "";
  return s;
};

/**
 * Gives every element without an id (but the root) its virtual id, as the server computes it on
 * the same file; returns them with the fingerprint's hash they share (to tell duplicates apart).
 */
export function assignVirtualIds(root: Element): Map<string, Element> {
  const out = new Map<string, Element>();
  const seen = new Map<string, number>();
  const all = Array.from(root.getElementsByTagName("*"));
  for (const el of all) {
    if (el.hasAttribute("id")) continue;
    const fp = svgFingerprint(
      el.nodeName,
      Array.from(el.attributes).map((a) => [a.name, a.value] as const),
      ownText(el),
    );
    const k = seen.get(fp) ?? 0;
    seen.set(fp, k + 1);
    const id = svgVirtualId(fp, k);
    el.setAttribute("id", id);
    out.set(id, el);
  }
  return out;
}

/** The prefixes the file's root declares, and its default namespace. */
export function namespacesOf(root: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(root.attributes))
    if (a.name === "xmlns") out[""] = a.value;
    else if (a.name.startsWith("xmlns:")) out[a.name.slice(6)] = a.value;
  return out;
}

/** A style attribute with properties set (null removes), the others as written. */
export function setInStyle(style: string, set: Readonly<Record<string, string | null>>): string {
  const left = new Map(Object.entries(set));
  const parts = style.split(";").flatMap((part) => {
    const c = part.indexOf(":");
    if (c < 0) return part.trim() ? [part] : [];
    const name = part.slice(0, c).trim();
    if (!left.has(name)) return [part];
    const v = left.get(name);
    left.delete(name);
    return v === null || v === undefined ? [] : [`${part.slice(0, c + 1)}${v}`];
  });
  return parts.join(";");
}

const styleHas = (style: string | null, name: string) =>
  !!style &&
  style.split(";").some((p) => p.indexOf(":") > 0 && p.slice(0, p.indexOf(":")).trim() === name);

/** Where the page applies others' actions: its DOM, and how it names things. */
export interface DomTarget {
  /** The drawing's root in the page (svgcanvas's own `svgcontent`). */
  root: Element;
  /** By id, real or virtual (null: none). */
  byId(id: string): Element | null;
  /** The file root's namespaces (to read markup that uses its prefixes). */
  ns: Record<string, string>;
  /** Where a new element of the root goes when the page wraps the root's children (svgcanvas' layer). */
  rootParent?(): Element;
  /** An element lost its id (a name taken back): the page gives it its virtual id again. */
  unnamed?(el: Element, id: string): void;
}

function setAttr(el: Element, name: string, value: string | null, ns: Record<string, string>) {
  const at = name.indexOf(":");
  const prefix = at > 0 ? name.slice(0, at) : "";
  const uri =
    prefix === "xlink"
      ? XLINK_NS
      : prefix === "xml"
        ? XML_NS
        : prefix
          ? (ns[prefix] ?? null)
          : null;
  if (value === null) {
    if (uri) el.removeAttributeNS(uri, name.slice(at + 1));
    el.removeAttribute(name);
  } else if (uri) el.setAttributeNS(uri, name, value);
  else el.setAttribute(name, value);
}

/** Markup read as the file would read it (its prefixes declared around it). */
export function parseMarkup(xml: string, ns: Record<string, string>, doc: Document): Node[] {
  const decl = Object.entries({ "": SVG_NS, xlink: XLINK_NS, ...ns })
    .map(([p, u]) => ` ${p ? `xmlns:${p}` : "xmlns"}="${u.replace(/"/g, "&quot;")}"`)
    .join("");
  const parsed = new DOMParser().parseFromString(`<svg${decl}>${xml}</svg>`, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length) throw new Error("markup not readable");
  return Array.from(parsed.documentElement.childNodes).map((n) => doc.importNode(n, true));
}

const plainOf = (a: SvgAction): SvgPlainAction[] => (a.t === "batch" ? a.ops : [a]);

/**
 * Applies others' actions to the page; "reload" when the page cannot follow (the whole file
 * replaced, an element it does not have): it loads the file again from the host.
 */
export function applyToDom(t: DomTarget, list: readonly SvgAction[]): "ok" | "reload" {
  const doc = t.root.ownerDocument;
  const find = (ref: string) => (ref === "" ? t.root : t.byId(ref));
  for (const a of list.flatMap(plainOf)) {
    switch (a.t) {
      case "doc":
        return "reload";
      case "name": {
        const el = t.byId(a.ref);
        if (!el) return "reload";
        el.setAttribute("id", a.id);
        break;
      }
      case "attrs": {
        const el = t.byId(a.id);
        if (!el) return "reload";
        for (const [k, v] of Object.entries(a.set)) {
          if (k === "id" && v === null) {
            t.unnamed?.(el, a.id);
            continue;
          }
          setAttr(el, k, v, t.ns);
        }
        break;
      }
      case "props": {
        const el = t.byId(a.id);
        if (!el) return "reload";
        const style = el.getAttribute("style");
        const inStyle: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(a.set)) {
          if (k === "#href") {
            const xl = el.hasAttributeNS(XLINK_NS, "href") && !el.hasAttribute("href");
            setAttr(el, xl ? "xlink:href" : "href", v, t.ns);
          } else if (styleHas(style, k)) inStyle[k] = v;
          else setAttr(el, k, v, t.ns);
        }
        if (Object.keys(inStyle).length && style !== null) {
          const next = setInStyle(style, inStyle);
          if (next.trim()) el.setAttribute("style", next);
          else el.removeAttribute("style");
        }
        break;
      }
      case "inner": {
        const el = t.byId(a.id);
        if (!el || !doc) return "reload";
        const kids = parseMarkup(a.xml, t.ns, doc);
        el.replaceChildren(...kids);
        break;
      }
      case "insert": {
        const parent = find(a.parent);
        if (!parent || !doc) return "reload";
        const before = a.before === null ? null : t.byId(a.before);
        if (a.before !== null && !before) return "reload";
        const [el] = parseMarkup(a.xml, t.ns, doc).filter((n) => n.nodeType === 1);
        if (!el) return "reload";
        if (before) before.parentNode?.insertBefore(el, before);
        else (a.parent === "" && t.rootParent ? t.rootParent() : parent).appendChild(el);
        break;
      }
      case "remove": {
        const el = t.byId(a.id);
        if (!el) return "reload";
        el.remove();
        break;
      }
      case "move": {
        const el = t.byId(a.id);
        const parent = find(a.parent);
        if (!el || !parent) return "reload";
        const before = a.before === null ? null : t.byId(a.before);
        if (a.before !== null && !before) return "reload";
        if (before) before.parentNode?.insertBefore(el, before);
        else (a.parent === "" && t.rootParent ? t.rootParent() : parent).appendChild(el);
        break;
      }
    }
  }
  return "ok";
}

/** The ids an action names (the page compares them with what it has not seen confirmed). */
export function touchedIds(list: readonly SvgAction[]): Set<string> {
  const out = new Set<string>();
  for (const a of list.flatMap(plainOf))
    switch (a.t) {
      case "doc":
        out.add("*");
        break;
      case "name":
        out.add(a.ref);
        out.add(a.id);
        break;
      case "insert": {
        const id = a.xml.match(/^\s*<[^\s>/]+[^>]*?\sid\s*=\s*["']([^"']*)["']/)?.[1];
        if (id) out.add(id);
        break;
      }
      default:
        out.add(a.id);
    }
  return out;
}

// ---- the person's commands -----------------------------------------------------------------

/** What a svgcanvas command was when it was made (its DOM moves on afterwards). */
export type Caught =
  | { k: "insert"; el: Element; parent: string; before: string | null; xml: string }
  | { k: "remove"; el: Element; id: string }
  | { k: "move"; el: Element; id: string; parent: string; before: string | null }
  | { k: "change"; el: Element; id: string; values: Record<string, string | null> };

/** How the page names its elements for the server. */
export interface Namer {
  /** The element's ref: its id; "" for the root or the page's own wrapping layer. */
  ref(el: Element | null): string | undefined;
  /** Whether the element is the page's own (a layer's title, svgcanvas' layer): never sent. */
  pageOnly(el: Element): boolean;
  /** Whether the server has it (it was loaded or confirmed). */
  known(id: string): boolean;
  /** A new id for an element (or a tag) without a real one. */
  fresh(el: Element | string): string;
  /** The file root's default namespace and prefixes. */
  ns: Record<string, string>;
  /** A text whose one tspan the server keeps (its words go there). */
  tspanOf?(textId: string): string | undefined;
}

/** The next sibling the server has (skipping the page's own), as a ref; null at the end. */
export function beforeOf(el: Element, n: Namer): string | null {
  for (let s = el.nextElementSibling; s; s = s.nextElementSibling) {
    if (n.pageOnly(s)) continue;
    const r = n.ref(s);
    if (r && n.known(r)) return r;
  }
  return null;
}

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A new element's markup for the file: no page noise, namespaces the file declares left out. */
export function markupOf(el: Element, n: Namer): string {
  const clone = el.cloneNode(true) as Element;
  for (const x of [clone, ...Array.from(clone.getElementsByTagName("*"))]) {
    if (x.getAttribute("style") === "pointer-events:inherit") x.removeAttribute("style");
    for (const a of Array.from(x.attributes))
      if (a.name.startsWith("se:")) x.removeAttribute(a.name);
  }
  let xml = new XMLSerializer().serializeToString(clone);
  // The root declares these already.
  xml = xml.replace(/^(<[^\s>]+)([^>]*)>/, (_m, tag: string, attrs: string) => {
    const kept = attrs.replace(
      /\s(xmlns(?::([\w.-]+))?)="([^"]*)"/g,
      (all, _n, p: string | undefined, uri: string) =>
        (
          p === undefined
            ? (n.ns[""] ?? SVG_NS) === uri
            : n.ns[p] === uri || (p === "xlink" && uri === XLINK_NS)
        )
          ? ""
          : all,
    );
    return `${tag}${kept}>`;
  });
  return xml.replace(/^(<[^\s>]+[^>]*?)\s*\/>$/, "$1 />");
}

/**
 * The person's commands as actions, in the order they were made. An element without a real id
 * that is changed, moved or removed is named first; `named` tells the page to rename it.
 */
export function actionsOf(
  caught: readonly Caught[],
  n: Namer,
  named: (el: Element | null, id: string, ref: string) => void,
): SvgPlainAction[] {
  const out: SvgPlainAction[] = [];
  // Names given in this gesture: places caught before them go by the new id.
  const renamed = new Map<string, string>();
  const r = (ref: string) => renamed.get(ref) ?? ref;
  const nameOf = (el: Element, id: string): string => {
    if (!isSvgVirtual(id)) return id;
    const real = n.fresh(el);
    renamed.set(id, real);
    out.push({ t: "name", ref: id, id: real });
    el.setAttribute("id", real);
    named(el, real, id);
    return real;
  };
  for (const c of caught) {
    if (c.k === "insert") {
      const id = c.el.getAttribute("id");
      if (!id) continue;
      out.push({
        t: "insert",
        parent: r(c.parent),
        before: c.before === null ? null : r(c.before),
        xml: c.xml,
      });
      continue;
    }
    // Its id now (named by an earlier action of the same gesture).
    const cid = c.el.getAttribute("id") ?? c.id;
    if (!n.known(cid) && !n.known(c.id)) continue;
    if (c.k === "remove") out.push({ t: "remove", id: nameOf(c.el, cid) });
    else if (c.k === "move")
      out.push({
        t: "move",
        id: nameOf(c.el, cid),
        parent: r(c.parent),
        before: c.before === null ? null : r(c.before),
      });
    else {
      const attrs: Record<string, string | null> = {};
      const props: Record<string, string | null> = {};
      let text: string | undefined;
      for (const [k, v] of Object.entries(c.values)) {
        const val = v === "" || v === undefined ? null : v;
        if (k === "#text") text = v ?? "";
        else if (k === "#href" || PRESENTATION.has(k)) props[k] = val;
        else attrs[k] = val;
      }
      if (text !== undefined) {
        // An Inkscape text keeps its words in its one tspan (gone from the page's DOM by now).
        let tspan = n.tspanOf?.(cid) ?? n.tspanOf?.(c.id);
        if (tspan && isSvgVirtual(tspan)) {
          const real = n.fresh("tspan");
          out.push({ t: "name", ref: tspan, id: real });
          named(null, real, tspan);
          tspan = real;
        }
        out.push({ t: "inner", id: tspan ?? nameOf(c.el, cid), xml: escapeText(text) });
      }
      if (Object.keys(attrs).length)
        out.push({ t: "attrs", id: nameOf(c.el, c.el.getAttribute("id") ?? cid), set: attrs });
      if (Object.keys(props).length)
        out.push({ t: "props", id: nameOf(c.el, c.el.getAttribute("id") ?? cid), set: props });
    }
  }
  // Several changes of the same element in a row become one.
  const merged: SvgPlainAction[] = [];
  for (const a of out) {
    const last = merged.at(-1);
    if (last && (a.t === "attrs" || a.t === "props") && last.t === a.t && last.id === a.id)
      merged[merged.length - 1] = { ...last, set: { ...last.set, ...a.set } };
    else if (last && a.t === "inner" && last.t === "inner" && last.id === a.id)
      merged[merged.length - 1] = a;
    else merged.push(a);
  }
  return merged;
}

// ---- in flight -----------------------------------------------------------------------------

export interface SvgOutgoing {
  clientId: string;
  baseRevision: number;
  actions: SvgAction[];
}

let counter = 0;
const newId = () => `v${Date.now().toString(36)}${(counter++).toString(36)}`;

/** The person's actions to the host, one batch in flight, on the revision they were made on. */
export class SvgCollab {
  revision = 0;
  private inflight: { id: string; actions: SvgAction[] } | undefined;
  private buffer: SvgPlainAction[] = [];

  constructor(private readonly send: (o: SvgOutgoing) => void) {}

  reset(revision: number): void {
    this.revision = revision;
    this.inflight = undefined;
    this.buffer = [];
  }

  get pending(): boolean {
    return !!this.inflight || this.buffer.length > 0;
  }

  local(actions: readonly SvgPlainAction[]): void {
    for (const a of actions) {
      // Typing: the text's last words are enough.
      const last = this.buffer.at(-1);
      if (last && a.t === "inner" && last.t === "inner" && last.id === a.id)
        this.buffer[this.buffer.length - 1] = a;
      // Dragging a colour or a slider: the last value of each property.
      else if (last && (a.t === "props" || a.t === "attrs") && last.t === a.t && last.id === a.id)
        this.buffer[this.buffer.length - 1] = { ...last, set: { ...last.set, ...a.set } };
      else this.buffer.push(a);
    }
  }

  flush(): void {
    if (this.inflight || !this.buffer.length) return;
    const ops = this.buffer;
    this.buffer = [];
    const one: SvgAction = ops.length === 1 ? (ops[0] as SvgPlainAction) : { t: "batch", ops };
    this.inflight = { id: newId(), actions: [one] };
    this.send({ clientId: this.inflight.id, baseRevision: this.revision, actions: [one] });
  }

  ack(clientId: string, revision: number): boolean {
    if (!this.inflight || this.inflight.id !== clientId) return false;
    this.revision = revision;
    this.inflight = undefined;
    this.flush();
    return true;
  }

  /** Others' revision: "apply" on the page, or "reload" (not the next one, or it meets mine). */
  remote(revision: number, actions: readonly SvgAction[]): "apply" | "reload" {
    if (revision !== this.revision + 1) return "reload";
    const mine = [...(this.inflight?.actions ?? []), ...this.buffer];
    if (mine.length) {
      const a = touchedIds(mine);
      for (const x of touchedIds(actions)) if (x === "*" || a.has(x)) return "reload";
    }
    this.revision = revision;
    return "apply";
  }

  rejected(clientId: string): boolean {
    return this.inflight?.id === clientId;
  }
}

/** The actions of a host's message (others' revisions). */
export const svgActionsOf = (ops: readonly { family: string; op?: unknown }[]): SvgAction[] =>
  ops.flatMap((o) => (o.family === "svg" ? [o.op as SvgAction] : []));

export const svgDocOp = (op: SvgAction) => ({
  family: "svg" as const,
  engine: "svg-dom" as const,
  engineVersion: SVG_ENGINE_VERSION,
  op,
});

/** Where a viewBox starts ("-20 -10 400 300" → -20, -10); 0, 0 when it has none or is wrong. */
export function viewBoxOrigin(viewBox: string | null): { x: number; y: number } {
  const v = (viewBox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) return { x: 0, y: 0 };
  return { x: v[0] as number, y: v[1] as number };
}
