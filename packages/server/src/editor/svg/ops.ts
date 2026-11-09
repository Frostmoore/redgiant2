// The drawing's actions on the server's tree (G37.6): applied without a browser on the file's own
// XML (svg/xml.ts), so what nobody touched is written back as it was. Each action's inverse is
// computed on the tree before it; the host refuses two authors on the same element (its id) and
// moves an action over another by renaming what the other named. Elements are found by id, by
// virtual id (an element without one, `svgVirtualId`) or "" (the root).
import {
  isSvgVirtual,
  type SvgAction,
  type SvgChange,
  type SvgPlainAction,
  svgFingerprint,
  svgVirtualId,
} from "@redgiant/protocol";
import { local } from "./geometry.js";
import {
  attrOf,
  nodeText,
  ownText,
  parseFragment,
  parseXml,
  withAttrs,
  withChildren,
  writeXml,
  type XDoc,
  type XEl,
  type XNode,
} from "./xml.js";

export interface SvgModel {
  doc: XDoc;
}

type Path = readonly number[];

// ---- finding elements ----------------------------------------------------------------------

/** Every element in document order, with its path of child indices from the root. */
export function* walk(el: XEl, path: number[] = []): Generator<[XEl, Path]> {
  yield [el, path];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i] as XNode;
    if (c.k === "el") yield* walk(c, [...path, i]);
  }
}

export const at = (doc: XDoc, path: Path): XEl => {
  let el = doc.root;
  for (const i of path) el = el.children[i] as XEl;
  return el;
};

/** The virtual id of every element without an id, by path (`a.b.c`) and back. */
export function virtualIds(doc: XDoc): { byRef: Map<string, Path>; byPath: Map<string, string> } {
  const byRef = new Map<string, Path>();
  const byPath = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const [el, path] of walk(doc.root)) {
    if (path.length === 0 || attrOf(el, "id") !== undefined) continue;
    const fp = svgFingerprint(
      el.name,
      el.attrs.map((a) => [a.name, a.value] as const),
      ownText(el, doc.entities),
    );
    const k = seen.get(fp) ?? 0;
    seen.set(fp, k + 1);
    const ref = svgVirtualId(fp, k);
    byRef.set(ref, path);
    byPath.set(path.join("."), ref);
  }
  return { byRef, byPath };
}

export function find(doc: XDoc, ref: string): Path | undefined {
  if (ref === "") return [];
  if (isSvgVirtual(ref)) return virtualIds(doc).byRef.get(ref);
  for (const [el, path] of walk(doc.root)) if (attrOf(el, "id") === ref) return path;
  return undefined;
}

export function ids(doc: XDoc): Set<string> {
  const out = new Set<string>();
  for (const [el] of walk(doc.root)) {
    const id = attrOf(el, "id");
    if (id !== undefined) out.add(id);
  }
  return out;
}

/** How an element is named in an action: its id, its virtual id, or "" for the root. */
export function refOf(doc: XDoc, path: Path, virtual?: Map<string, string>): string {
  if (path.length === 0) return "";
  const id = attrOf(at(doc, path), "id");
  if (id !== undefined) return id;
  return (virtual ?? virtualIds(doc).byPath).get(path.join(".")) ?? "";
}

/** The doc with the element at `path` replaced by `fn`'s (the others shared, never changed). */
function replaceAt(doc: XDoc, path: Path, fn: (el: XEl) => XEl): XDoc {
  const go = (el: XEl, depth: number): XEl => {
    if (depth === path.length) return fn(el);
    const i = path[depth] as number;
    const kids = el.children.slice();
    kids[i] = go(kids[i] as XEl, depth + 1);
    return withChildren(el, kids);
  };
  return { ...doc, root: go(doc.root, 0) };
}

// ---- what may come in ----------------------------------------------------------------------

const FORBIDDEN_TAGS = /^(script|iframe|object|embed|frame|frameset|base|meta|link)$/i;
/** A link that leaves the drawing: another site, a script. */
export const outsideLink = (v: string) =>
  /^\s*(javascript|vbscript|data:text\/html)/i.test(v) || /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(v);
const URL_IN_CSS = /url\(\s*['"]?\s*([^'")\s]*)/gi;

/** Why an attribute cannot be written (scripts, links outside the drawing). */
export function badAttr(name: string, value: string | null): string | undefined {
  if (/^on/i.test(local(name))) return `${name}: event handlers (scripts) are not allowed`;
  if (value === null) return undefined;
  if ((local(name) === "href" || name === "src") && outsideLink(value))
    return `${name}: links outside the drawing are not allowed (${value.slice(0, 80)})`;
  for (const m of value.matchAll(URL_IN_CSS))
    if (outsideLink(m[1] ?? "")) return `${name}: url() outside the drawing is not allowed`;
  if (/expression\s*\(|@import/i.test(value)) return `${name}: not allowed in a drawing`;
  return undefined;
}

/** Why a piece of markup cannot go in (undefined: it can). */
export function badMarkup(nodes: readonly XNode[], inStyle = false): string | undefined {
  for (const n of nodes) {
    if (n.k === "text" || n.k === "cdata") {
      if (
        inStyle &&
        (/@import|expression\s*\(/i.test(n.raw) ||
          [...n.raw.matchAll(URL_IN_CSS)].some((m) => outsideLink(m[1] ?? "")))
      )
        return "a style with links outside the drawing";
      continue;
    }
    if (n.k === "other") {
      if (/^<!doctype|^<!entity|^<\?/i.test(n.raw)) return "declarations are not allowed here";
      continue;
    }
    if (FORBIDDEN_TAGS.test(local(n.name))) return `<${n.name}> is not allowed in a drawing`;
    for (const a of n.attrs) {
      const bad = badAttr(a.name, a.value);
      if (bad) return bad;
    }
    const bad = badMarkup(n.children, local(n.name) === "style");
    if (bad) return bad;
  }
  return undefined;
}

/** The one element of an insert's markup (spaces around it allowed). */
export function oneElement(xml: string, doc: XDoc): XEl | string {
  let nodes: XNode[];
  try {
    nodes = parseFragment(xml, doc.entities);
  } catch (err) {
    return (err as Error).message;
  }
  const els = nodes.filter((n) => n.k === "el");
  if (els.length !== 1 || nodes.some((n) => n.k !== "el" && !(n.k === "text" && !n.raw.trim())))
    return "the markup must be one element";
  const bad = badMarkup(nodes);
  if (bad) return bad;
  return els[0] as XEl;
}

const prefixOf = (name: string) => (name.includes(":") ? name.slice(0, name.indexOf(":")) : "");

/** Prefixes the markup uses that nobody declares (the root, the markup itself). */
function undeclared(el: XEl, declared: Set<string>): string | undefined {
  const mine = new Set(declared);
  for (const a of el.attrs) if (a.name.startsWith("xmlns:")) mine.add(a.name.slice(6));
  for (const p of [prefixOf(el.name), ...el.attrs.map((a) => prefixOf(a.name))])
    if (p && p !== "xml" && p !== "xmlns" && !mine.has(p)) return p;
  for (const c of el.children)
    if (c.k === "el") {
      const p = undeclared(c, mine);
      if (p) return p;
    }
  return undefined;
}

function declaredOn(doc: XDoc, path: Path): Set<string> {
  const out = new Set<string>();
  let el = doc.root;
  const take = (e: XEl) => {
    for (const a of e.attrs) if (a.name.startsWith("xmlns:")) out.add(a.name.slice(6));
  };
  take(el);
  for (const i of path) {
    el = el.children[i] as XEl;
    take(el);
  }
  return out;
}

// ---- children: places with the file's spaces -------------------------------------------------

const blank = (n: XNode | undefined) => n?.k === "text" && !n.raw.trim();

/** Where an element goes in `kids` before `beforeIndex` (an element's index, or -1: at the end). */
function slot(kids: readonly XNode[], beforeIndex: number): number {
  if (beforeIndex >= 0) return blank(kids[beforeIndex - 1]) ? beforeIndex - 1 : beforeIndex;
  for (let i = kids.length - 1; i >= 0; i--) if (kids[i]?.k === "el") return i + 1;
  return blank(kids[0]) && kids.length === 1 ? 0 : kids.length;
}

/** The spaces an element at the end of `kids` would have (its siblings' indentation). */
function indentOf(kids: readonly XNode[]): string | undefined {
  for (let i = kids.length - 1; i > 0; i--)
    if (kids[i]?.k === "el" && blank(kids[i - 1])) return (kids[i - 1] as { raw: string }).raw;
  return undefined;
}

// ---- applying ------------------------------------------------------------------------------

export class SvgOpError extends Error {}
const fail = (why: string): never => {
  throw new SvgOpError(why);
};

const need = (doc: XDoc, ref: string, what = "element"): Path =>
  find(doc, ref) ?? fail(`there is no ${what} «${ref || "root"}»`);

/** A style attribute with properties set (null removes); the others as they were written. */
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

const styleProps = (style: string | undefined) =>
  new Set(
    (style ?? "")
      .split(";")
      .map((p) => p.slice(0, Math.max(0, p.indexOf(":"))).trim())
      .filter(Boolean),
  );

function applyProps(el: XEl, set: Readonly<Record<string, string | null>>): XEl {
  const style = attrOf(el, "style");
  const inStyle = styleProps(style);
  const toStyle: Record<string, string | null> = {};
  const toAttrs: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(set)) {
    if (k === "#href") {
      const xl = attrOf(el, "xlink:href") !== undefined && attrOf(el, "href") === undefined;
      toAttrs[xl ? "xlink:href" : "href"] = v;
      continue;
    }
    if (inStyle.has(k)) {
      toStyle[k] = v;
      // A property kept in the style wins; the attribute of the same name goes when removed.
      if (v === null && attrOf(el, k) !== undefined) toAttrs[k] = null;
    } else toAttrs[k] = v;
  }
  if (Object.keys(toStyle).length && style !== undefined) {
    const next = setInStyle(style, toStyle);
    toAttrs.style = next.trim() ? next : null;
  }
  return withAttrs(el, toAttrs);
}

function applyPlain(doc: XDoc, a: SvgPlainAction): XDoc {
  switch (a.t) {
    case "doc":
      return parseXml(a.text);
    case "name": {
      const p = need(doc, a.ref);
      return replaceAt(doc, p, (el) => withAttrs(el, { id: a.id }));
    }
    case "attrs":
      return replaceAt(doc, need(doc, a.id), (el) => withAttrs(el, a.set));
    case "props":
      return replaceAt(doc, need(doc, a.id), (el) => applyProps(el, a.set));
    case "inner": {
      const kids = parseFragment(a.xml, doc.entities);
      return replaceAt(doc, need(doc, a.id), (el) => withChildren(el, kids));
    }
    case "insert": {
      const el = oneElement(a.xml, doc);
      if (typeof el === "string") return fail(el);
      return insertAt(doc, a.parent, a.before, el, a.ws);
    }
    case "remove": {
      const p = need(doc, a.id);
      return removeAt(doc, p).doc;
    }
    case "move": {
      const p = need(doc, a.id);
      const r = removeAt(doc, p);
      return insertAt(r.doc, a.parent, a.before, r.el, r.ws);
    }
  }
}

function insertAt(doc: XDoc, parent: string, before: string | null, el: XEl, ws?: string): XDoc {
  const pp = need(doc, parent, "parent");
  let beforeIndex = -1;
  if (before !== null) {
    const bp = need(doc, before, "element to go before");
    if (bp.length !== pp.length + 1 || bp.slice(0, -1).some((v, i) => v !== pp[i]))
      fail(`«${before}» is not in «${parent || "root"}»`);
    beforeIndex = bp.at(-1) as number;
  }
  return replaceAt(doc, pp, (p) => {
    const kids = p.children.slice();
    const at = slot(kids, beforeIndex);
    const space = ws ?? indentOf(kids);
    kids.splice(at, 0, ...(space ? [{ k: "text" as const, raw: space }] : []), el);
    return withChildren(p, kids);
  });
}

function removeAt(doc: XDoc, path: Path): { doc: XDoc; el: XEl; ws?: string } {
  if (!path.length) fail("the drawing's root cannot be removed or moved");
  const i = path.at(-1) as number;
  const parent = at(doc, path.slice(0, -1));
  const el = parent.children[i] as XEl;
  const prev = parent.children[i - 1];
  const ws = blank(prev) ? (prev as { raw: string }).raw : undefined;
  const out = replaceAt(doc, path.slice(0, -1), (p) => {
    const kids = p.children.slice();
    kids.splice(ws !== undefined ? i - 1 : i, ws !== undefined ? 2 : 1);
    return withChildren(p, kids);
  });
  return { doc: out, el, ...(ws !== undefined && { ws }) };
}

const plainOf = (a: SvgAction): SvgPlainAction[] => (a.t === "batch" ? a.ops : [a]);

export function applyAction(doc: XDoc, a: SvgAction): XDoc {
  let d = doc;
  for (const p of plainOf(a)) d = applyPlain(d, p);
  return d;
}

// ---- checking ------------------------------------------------------------------------------

function checkPlain(doc: XDoc, a: SvgPlainAction): string | undefined {
  const exists = (ref: string) => find(doc, ref) !== undefined;
  switch (a.t) {
    case "doc":
      try {
        const d = parseXml(a.text);
        if (local(d.root.name) !== "svg") return "the file must be an <svg>";
        return badMarkup([d.root]);
      } catch (err) {
        return (err as Error).message;
      }
    case "name": {
      const p = find(doc, a.ref);
      if (!p) return `there is no element «${a.ref}» (look again: it may have changed)`;
      if (!p.length) return "the root is named with attrs";
      if (attrOf(at(doc, p), "id") !== undefined) return `«${a.ref}» has an id already`;
      if (exists(a.id)) return `the id «${a.id}» is taken`;
      return undefined;
    }
    case "attrs":
    case "props": {
      if (!exists(a.id)) return `there is no element «${a.id}»`;
      for (const [k, v] of Object.entries(a.set)) {
        const bad = badAttr(k === "#href" ? "href" : k, v);
        if (bad) return bad;
        if (!/^(#href|[A-Za-z_][\w.:-]*)$/.test(k)) return `«${k}» is not an attribute's name`;
      }
      if (a.t === "attrs" && "id" in a.set) {
        const id = a.set.id;
        if (id !== null && id !== undefined && id !== a.id && exists(id))
          return `the id «${id}» is taken`;
      }
      return undefined;
    }
    case "inner": {
      const p = find(doc, a.id);
      if (!p) return `there is no element «${a.id}»`;
      let nodes: XNode[];
      try {
        nodes = parseFragment(a.xml, doc.entities);
      } catch (err) {
        return (err as Error).message;
      }
      return badMarkup(nodes, local(at(doc, p).name) === "style") ?? dupIds(doc, nodes, p);
    }
    case "insert": {
      const el = oneElement(a.xml, doc);
      if (typeof el === "string") return el;
      if (attrOf(el, "id") === undefined) return "the element to insert needs an id";
      const pp = find(doc, a.parent);
      if (!pp) return `there is no parent «${a.parent}»`;
      if (a.before !== null) {
        const bp = find(doc, a.before);
        if (!bp) return `there is no element «${a.before}» to go before`;
        if (bp.length !== pp.length + 1 || bp.slice(0, -1).some((v, i) => v !== pp[i]))
          return `«${a.before}» is not in «${a.parent || "root"}»`;
      }
      const p = undeclared(el, declaredOn(doc, pp));
      if (p) return `the prefix «${p}:» is not declared in the drawing`;
      return dupIds(doc, [el]);
    }
    case "remove": {
      const p = find(doc, a.id);
      if (!p) return `there is no element «${a.id}»`;
      if (!p.length) return "the drawing's root cannot be removed";
      return undefined;
    }
    case "move": {
      const p = find(doc, a.id);
      if (!p) return `there is no element «${a.id}»`;
      if (!p.length) return "the drawing's root cannot be moved";
      const pp = find(doc, a.parent);
      if (!pp) return `there is no parent «${a.parent}»`;
      if (pp.length >= p.length && p.every((v, i) => pp[i] === v))
        return `«${a.id}» cannot go inside itself`;
      if (a.before !== null) {
        if (a.before === a.id) return `«${a.id}» cannot go before itself`;
        const bp = find(doc, a.before);
        if (!bp) return `there is no element «${a.before}» to go before`;
        if (bp.length !== pp.length + 1 || bp.slice(0, -1).some((v, i) => v !== pp[i]))
          return `«${a.before}» is not in «${a.parent || "root"}»`;
      }
      return undefined;
    }
  }
}

function dupIds(doc: XDoc, nodes: readonly XNode[], replacing?: Path): string | undefined {
  const have = ids(doc);
  // The content being replaced takes its ids away.
  if (replacing) {
    const old = at(doc, replacing);
    for (const c of old.children)
      if (c.k === "el")
        for (const [e] of walk(c)) {
          const id = attrOf(e, "id");
          if (id !== undefined) have.delete(id);
        }
  }
  const mine = new Set<string>();
  for (const n of nodes)
    if (n.k === "el")
      for (const [e] of walk(n)) {
        const id = attrOf(e, "id");
        if (id === undefined) continue;
        if (have.has(id) || mine.has(id)) return `the id «${id}» is taken`;
        mine.add(id);
      }
  return undefined;
}

/** Why the action cannot apply (undefined: it can). */
export function checkAction(doc: XDoc, a: SvgAction): string | undefined {
  let d = doc;
  for (const [i, p] of plainOf(a).entries()) {
    const bad = checkPlain(d, p);
    if (bad) return a.t === "batch" ? `step ${i + 1}: ${bad}` : bad;
    try {
      d = applyPlain(d, p);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return undefined;
}

// ---- inverses ------------------------------------------------------------------------------

function invertPlain(doc: XDoc, a: SvgPlainAction): SvgPlainAction {
  switch (a.t) {
    case "doc":
      return { t: "doc", text: writeXml(doc) };
    case "name":
      return { t: "attrs", id: a.id, set: { id: null } };
    case "attrs": {
      const el = at(doc, need(doc, a.id));
      const set: Record<string, string | null> = {};
      for (const k of Object.keys(a.set)) set[k] = attrOf(el, k) ?? null;
      // A changed id is found by its new one.
      const id = a.set.id !== undefined && a.set.id !== null ? a.set.id : a.id;
      return { t: "attrs", id, set };
    }
    case "props": {
      const el = at(doc, need(doc, a.id));
      const set: Record<string, string | null> = { style: attrOf(el, "style") ?? null };
      for (const k of Object.keys(a.set)) {
        if (k === "#href") {
          set.href = attrOf(el, "href") ?? null;
          set["xlink:href"] = attrOf(el, "xlink:href") ?? null;
        } else set[k] = attrOf(el, k) ?? null;
      }
      return { t: "attrs", id: a.id, set };
    }
    case "inner": {
      const el = at(doc, need(doc, a.id));
      return { t: "inner", id: a.id, xml: el.children.map(nodeText).join("") };
    }
    case "insert": {
      const el = oneElement(a.xml, doc) as XEl;
      return { t: "remove", id: attrOf(el, "id") as string };
    }
    case "remove": {
      const p = need(doc, a.id);
      const v = virtualIds(doc).byPath;
      const parent = at(doc, p.slice(0, -1));
      const i = p.at(-1) as number;
      const next = nextElement(parent, i);
      const prev = parent.children[i - 1];
      return {
        t: "insert",
        parent: refOf(doc, p.slice(0, -1), v),
        before: next === undefined ? null : refOf(doc, [...p.slice(0, -1), next], v),
        xml: nodeText(at(doc, p)),
        ...(blank(prev) && { ws: (prev as { raw: string }).raw }),
      };
    }
    case "move": {
      const p = need(doc, a.id);
      const v = virtualIds(doc).byPath;
      const parent = at(doc, p.slice(0, -1));
      const next = nextElement(parent, p.at(-1) as number);
      return {
        t: "move",
        id: a.id,
        parent: refOf(doc, p.slice(0, -1), v),
        before: next === undefined ? null : refOf(doc, [...p.slice(0, -1), next], v),
      };
    }
  }
}

function nextElement(parent: XEl, i: number): number | undefined {
  for (let j = i + 1; j < parent.children.length; j++) if (parent.children[j]?.k === "el") return j;
  return undefined;
}

/** The action that undoes `a`, on the tree after it (`doc` is the one before). */
export function invertAction(doc: XDoc, a: SvgAction): SvgAction {
  const list = plainOf(a);
  const out: SvgPlainAction[] = [];
  let d = doc;
  for (const p of list) {
    out.unshift(invertPlain(d, p));
    d = applyPlain(d, p);
  }
  return a.t === "batch" ? { t: "batch", ops: out } : (out[0] as SvgPlainAction);
}

// ---- conflicts and moving over another's ----------------------------------------------------

/** The elements an action changes, by the ids (and refs) it names. */
export function touched(a: SvgAction): Set<string> {
  const out = new Set<string>();
  for (const p of plainOf(a))
    switch (p.t) {
      case "doc":
        out.add("*");
        break;
      case "name":
        out.add(p.ref);
        out.add(p.id);
        break;
      case "insert": {
        const id = p.xml.match(/^\s*<[^\s>/]+[^>]*?\sid\s*=\s*["']([^"']*)["']/)?.[1];
        if (id) out.add(id);
        break;
      }
      default:
        out.add(p.id);
    }
  return out;
}

export function actionsConflict(a: SvgAction, b: SvgAction): boolean {
  const ta = touched(a);
  const tb = touched(b);
  if (ta.has("*") || tb.has("*")) return true;
  for (const x of ta) if (tb.has(x)) return true;
  return false;
}

/** `a`, made on the same tree as `b`, to apply after `b` (refs `b` named now go by their id). */
export function mapAction(a: SvgAction, b: SvgAction): SvgAction | undefined {
  const bs = plainOf(b);
  if (bs.some((p) => p.t === "doc")) return undefined;
  const renamed = new Map<string, string>();
  for (const p of bs) if (p.t === "name") renamed.set(p.ref, p.id);
  if (!renamed.size) return a;
  const r = (ref: string) => renamed.get(ref) ?? ref;
  const out: SvgPlainAction[] = [];
  for (const p of plainOf(a)) {
    if (p.t === "name") {
      const id = renamed.get(p.ref);
      // Named already by the other: this one's id becomes that one.
      if (id !== undefined) {
        renamed.set(p.id, id);
        continue;
      }
      out.push(p);
      continue;
    }
    if (p.t === "insert")
      out.push({ ...p, parent: r(p.parent), before: p.before === null ? null : r(p.before) });
    else if (p.t === "move")
      out.push({
        ...p,
        id: r(p.id),
        parent: r(p.parent),
        before: p.before === null ? null : r(p.before),
      });
    else if (p.t === "doc") out.push(p);
    else out.push({ ...p, id: r(p.id) });
  }
  if (!out.length) return undefined;
  return a.t === "batch" || out.length > 1 ? { t: "batch", ops: out } : (out[0] as SvgPlainAction);
}

export function composeActions(list: readonly SvgAction[]): SvgAction {
  const ops = list.flatMap(plainOf);
  return ops.length === 1 ? (ops[0] as SvgPlainAction) : { t: "batch", ops };
}

// ---- what a change was --------------------------------------------------------------------

const GEOMETRY = new Set([
  "x",
  "y",
  "width",
  "height",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "d",
]);

const tagOfXml = (xml: string) => xml.match(/^\s*<([^\s>/]+)/)?.[1];
const idOfXml = (xml: string) => xml.match(/^\s*<[^\s>/]+[^>]*?\sid\s*=\s*["']([^"']*)["']/)?.[1];

/** What a batch did, on the tree before it: the words for the agent and the panel. */
export function describe(
  doc: XDoc,
  list: readonly SvgAction[],
): { change: SvgChange; text: string } {
  const ops = list.flatMap(plainOf).filter((p) => p.t !== "name");
  const tagOf = (id: string) => {
    const p = find(doc, id);
    return p ? local(at(doc, p).name) : undefined;
  };
  const one = (action: SvgChange["action"], ids: string[], tags: (string | undefined)[]) => {
    const uniq = [...new Set(ids)];
    const t = [...new Set(tags)];
    const change: SvgChange = {
      action,
      n: uniq.length,
      ...(t.length === 1 && t[0] && { tag: local(t[0]) }),
      ...(uniq.length === 1 && uniq[0] && { id: uniq[0] }),
    };
    return change;
  };
  if (!ops.length) return { change: { action: "change", n: 0 }, text: "named an element" };
  if (ops.some((p) => p.t === "doc"))
    return { change: { action: "replace", n: 0 }, text: "replaced the whole drawing" };
  const kinds = new Set(ops.map((p) => p.t));
  const only = (...k: string[]) => [...kinds].every((x) => k.includes(x));
  let change: SvgChange;
  const inserts = ops.filter(
    (p): p is Extract<SvgPlainAction, { t: "insert" }> => p.t === "insert",
  );
  const moves = ops.filter((p): p is Extract<SvgPlainAction, { t: "move" }> => p.t === "move");
  const removes = ops.filter(
    (p): p is Extract<SvgPlainAction, { t: "remove" }> => p.t === "remove",
  );
  const groupIds = new Set(
    inserts.filter((p) => local(tagOfXml(p.xml) ?? "") === "g").map((p) => idOfXml(p.xml)),
  );
  if (
    inserts.length === 1 &&
    groupIds.size === 1 &&
    moves.length &&
    moves.every((m) => groupIds.has(m.parent)) &&
    only("insert", "move", "attrs")
  )
    change = one(
      "group",
      moves.map((m) => m.id),
      moves.map((m) => tagOf(m.id)),
    );
  else if (
    removes.length === 1 &&
    moves.length &&
    tagOf(removes[0]?.id ?? "") === "g" &&
    only("remove", "move", "attrs")
  )
    change = one("ungroup", [removes[0]?.id ?? ""], ["g"]);
  else if (only("insert"))
    change = one(
      "add",
      inserts.map((p) => idOfXml(p.xml) ?? ""),
      inserts.map((p) => tagOfXml(p.xml)),
    );
  else if (only("remove"))
    change = one(
      "delete",
      removes.map((p) => p.id),
      removes.map((p) => tagOf(p.id)),
    );
  else if (only("move"))
    change = one(
      "order",
      moves.map((p) => p.id),
      moves.map((p) => tagOf(p.id)),
    );
  else if (only("inner")) {
    const list2 = ops as Extract<SvgPlainAction, { t: "inner" }>[];
    change = one(
      "text",
      list2.map((p) => p.id),
      list2.map((p) => tagOf(p.id)),
    );
  } else if (only("props")) {
    const list2 = ops as Extract<SvgPlainAction, { t: "props" }>[];
    change = one(
      "style",
      list2.map((p) => p.id),
      list2.map((p) => tagOf(p.id)),
    );
  } else if (only("attrs", "props")) {
    const list2 = ops as Extract<SvgPlainAction, { t: "attrs" | "props" }>[];
    const names = new Set(list2.flatMap((p) => Object.keys(p.set)));
    const action: SvgChange["action"] = [...names].every((n) => n === "transform")
      ? "transform"
      : [...names].every((n) => n === "transform" || GEOMETRY.has(n))
        ? "shape"
        : [...names].every((n) => list2.some((p) => p.t === "props" && n in p.set) || n === "style")
          ? "style"
          : "change";
    change = one(
      action,
      list2.map((p) => p.id),
      list2.map((p) => tagOf(p.id)),
    );
  } else {
    const all = ops.map((p) =>
      p.t === "insert" ? (idOfXml(p.xml) ?? "") : p.t === "doc" ? "" : p.id,
    );
    change = one(
      "edit",
      all,
      all.map((id) => tagOf(id)),
    );
  }
  return { change, text: englishOf(change) };
}

export function englishOf(c: SvgChange): string {
  const what =
    c.n === 1
      ? `${c.tag ?? "element"}${c.id ? ` «${c.id}»` : ""}`
      : `${c.n} ${c.tag ? `${c.tag} elements` : "elements"}`;
  switch (c.action) {
    case "add":
      return `added ${what}`;
    case "delete":
      return `deleted ${what}`;
    case "style":
      return `changed the style of ${what}`;
    case "shape":
      return `changed the shape or place of ${what}`;
    case "transform":
      return `moved or transformed ${what}`;
    case "text":
      return `changed the text of ${what}`;
    case "order":
      return `moved ${what} in the order of the drawing`;
    case "group":
      return `grouped ${what}`;
    case "ungroup":
      return `ungrouped ${what}`;
    case "replace":
      return "replaced the whole drawing";
    case "edit":
      return `edited ${what}`;
    default:
      return `changed ${what}`;
  }
}

export const isPlainSvg = (a: SvgAction): a is SvgPlainAction => a.t !== "batch";
