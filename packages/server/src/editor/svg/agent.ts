// An agent's drawing operations in plain words (G37.6, canvas_edit): add a shape or a text, set an
// attribute or a style, change a text, move, rotate, scale, delete, group, ungroup, reorder,
// align, distribute, add a layer. Each becomes the family's actions (svg/ops.ts), applied one
// after the other on the server's tree, so the next sees what the one before made. An element
// without an id is named first (Inkscape's way: `rect12`), so the change can be undone later.
import { isSvgVirtual, type SvgPlainAction } from "@redgiant/protocol";
import {
  apply,
  type Box,
  elementBox,
  fmt,
  IDENTITY,
  invert,
  local,
  type Matrix,
  multiply,
  numbers,
  parseTransform,
  propOf,
} from "./geometry.js";
import { applyAction, at, checkAction, find, ids, oneElement, refOf } from "./ops.js";
import {
  attrOf,
  escapeAttr,
  escapeText,
  parseFragment,
  writeNode,
  type XDoc,
  type XEl,
} from "./xml.js";

export const SVG_CATALOG = `Drawings (svg; an .ai or .eps is edited on its SVG copy): canvas_edit "ops", applied in order. Elements are named by "id": canvas_look view "structure" lists them with their kind, text and box (x y w h in the drawing's units, its viewBox). An element without an id shows a ref like "rgv-1a2b3c4d": use it the same way (it gets a real id when changed). "parent" is a group's or a layer's id (by default the last layer, or the drawing); "before" is the id of the element it goes before (by default on top of the others). Everything not touched stays in the file as it was (Inkscape's attributes, metadata, unknown elements).
- {"op":"add_shape","kind":"rect","x":10,"y":10,"w":120,"h":60,"rx":8,"style":{"fill":"#ffcc00","stroke":"#333","stroke_width":2},"id":"box1"}: kinds rect, ellipse, circle (x y w h, the box it fills), line ("x1","y1","x2","y2"), polygon and polyline ("points":[[x,y],…]), path ("d").
- {"op":"add_text","x":20,"y":40,"text":"Officina 2026","style":{"font_size":24,"font_family":"sans-serif","fill":"#222","anchor":"start|middle|end","bold":true,"italic":false}}: spaces in the text are kept.
- {"op":"add_element","xml":"<g id=\\"logo\\">…</g>"}: any SVG markup (no scripts, no links outside the drawing; prefixes must be declared in the drawing).
- {"op":"set_attr","id":"box1","name":"rx","value":"4"}: one attribute as written (value null removes it).
- {"op":"set_style","id":"box1","fill":"#ff0000","stroke":"none","stroke_width":1.5,"opacity":0.8}: style properties ("ids":[…] for several); written where the element keeps them (its style="" or its attributes); null removes one.
- {"op":"set_text","id":"title","text":"Nuovo titolo"}: a text's content (a single tspan inside is kept and written).
- {"op":"move","ids":["box1"],"dx":10,"dy":-5} / {"op":"rotate","id":"box1","angle":30,"cx":0,"cy":0} (degrees, around its centre without cx/cy) / {"op":"scale","id":"box1","sx":2,"sy":1.5} (around its centre): written in "transform".
- {"op":"delete","ids":["box1","t2"]}.
- {"op":"group","ids":["a","b"],"id":"g1"} (they must share a parent) / {"op":"ungroup","id":"g1"}.
- {"op":"reorder","id":"box1","to":"front|back|up|down"} or {"op":"reorder","id":"box1","parent":"layer2","before":"x"} (into another group or layer, coordinates as they are).
- {"op":"align","ids":["a","b"],"to":"left|center|right|top|middle|bottom"} / {"op":"distribute","ids":["a","b","c"],"axis":"x|y"} (centres at equal steps, the first and last stay).
- {"op":"add_layer","name":"Testi","id":"layer3"}: a new layer on top (an Inkscape layer when the drawing uses them).`;

type Plain = Record<string, unknown>;

class Bad extends Error {}
const bad = (why: string): never => {
  throw new Bad(why);
};

const str = (v: unknown, what: string): string => {
  if (typeof v === "string" && v.length) return v;
  if (typeof v === "number" && Number.isFinite(v)) return fmt(v);
  return bad(`give ${what}`);
};
const num = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return bad(`"${what}" must be a number`);
  return n;
};
const optNum = (v: unknown, what: string) =>
  v === undefined || v === null ? undefined : num(v, what);

/** A style key as SVG writes it (stroke_width → stroke-width; anchor → text-anchor). */
const ALIASES: Record<string, string> = {
  anchor: "text-anchor",
  size: "font-size",
  font: "font-family",
};
const propName = (k: string) => ALIASES[k] ?? k.replace(/_/g, "-");

function styleSet(o: Plain, skip: Set<string>): Record<string, string | null> {
  const set: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k)) continue;
    if (k === "bold") {
      set["font-weight"] = v === null ? null : v ? "bold" : "normal";
      continue;
    }
    if (k === "italic") {
      set["font-style"] = v === null ? null : v ? "italic" : "normal";
      continue;
    }
    const name = propName(k);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) bad(`«${k}» is not a style property`);
    set[name] = v === null ? null : typeof v === "number" ? fmt(v) : String(v);
  }
  return set;
}

class Builder {
  out: SvgPlainAction[] = [];
  constructor(public doc: XDoc) {}

  push(a: SvgPlainAction) {
    const why = checkAction(this.doc, a);
    if (why) bad(why);
    this.doc = applyAction(this.doc, a);
    this.out.push(a);
  }

  freshId(prefix: string): string {
    const have = ids(this.doc);
    const base = prefix.replace(/[^A-Za-z0-9_-]/g, "") || "el";
    let n = 1;
    while (have.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /** The element's id, named first when it has none. */
  named(ref: unknown): string {
    if (typeof ref !== "string" || ref === "") return bad('give the element\'s "id"');
    const p = find(this.doc, ref);
    if (!p) return bad(`there is no element «${ref}» (canvas_look view "structure" lists them)`);
    if (!p.length) return bad("the drawing's root cannot be changed this way");
    if (!isSvgVirtual(ref)) return ref;
    const id = this.freshId(local(at(this.doc, p).name));
    this.push({ t: "name", ref, id });
    return id;
  }

  idsOf(o: Plain): string[] {
    const list = Array.isArray(o.ids)
      ? o.ids
      : o.id !== undefined
        ? [o.id]
        : bad('give "id" or "ids"');
    if (!list.length) bad('"ids" is empty');
    return list.map((x) => this.named(x));
  }

  /** The parent and the place for something new. */
  place(o: Plain): { parent: string; before: string | null } {
    let parent: string;
    if (o.parent !== undefined && o.parent !== null && o.parent !== "") {
      const p = find(this.doc, String(o.parent));
      if (!p) bad(`there is no parent «${o.parent}»`);
      parent = String(o.parent);
    } else parent = this.defaultLayer();
    const before =
      o.before === undefined || o.before === null || o.before === "" ? null : String(o.before);
    return { parent, before };
  }

  /** The last Inkscape layer (or top-level group marked as a layer), else the root. */
  defaultLayer(): string {
    const root = this.doc.root;
    for (let i = root.children.length - 1; i >= 0; i--) {
      const c = root.children[i];
      if (
        c?.k === "el" &&
        local(c.name) === "g" &&
        (attrOf(c, "inkscape:groupmode") === "layer" || /\blayer\b/.test(attrOf(c, "class") ?? ""))
      )
        return refOf(this.doc, [i]);
    }
    return "";
  }

  /** The indentation-free markup of a new element. */
  insert(tag: string, attrs: Record<string, string>, o: Plain, content = "") {
    const id = o.id !== undefined ? str(o.id, '"id"') : this.freshId(tag);
    const a = Object.entries({ id, ...attrs })
      .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
      .join("");
    const xml = content ? `<${tag}${a}>${content}</${tag}>` : `<${tag}${a} />`;
    this.push({ t: "insert", ...this.place(o), xml });
    return id;
  }

  /** The matrix from an element's parent to the drawing (the ancestors' transforms). */
  parentCtm(path: readonly number[]): Matrix {
    let m: Matrix = IDENTITY;
    let el = this.doc.root;
    for (const i of path.slice(0, -1)) {
      el = el.children[i] as XEl;
      m = multiply(m, parseTransform(attrOf(el, "transform")) ?? IDENTITY);
    }
    return m;
  }

  fontSizeAt(path: readonly number[]): number {
    let fs = 16;
    let el = this.doc.root;
    for (const i of path.slice(0, -1)) {
      el = el.children[i] as XEl;
      const v = Number.parseFloat(propOf(el, "font-size") ?? "");
      if (Number.isFinite(v)) fs = v;
    }
    return fs;
  }

  /** The element's box in the drawing's coordinates. */
  box(id: string): Box {
    const p = find(this.doc, id) as number[];
    const b = elementBox(at(this.doc, p), this.doc.entities, this.fontSizeAt(p));
    if (!b) return bad(`«${id}» has no size that can be measured here`);
    const m = this.parentCtm(p);
    const pts = [
      apply(m, b.x, b.y),
      apply(m, b.x + b.w, b.y),
      apply(m, b.x, b.y + b.h),
      apply(m, b.x + b.w, b.y + b.h),
    ];
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** A transform put before the element's own (in its parent's coordinates). */
  transform(id: string, pre: string, merge?: { dx: number; dy: number }) {
    const el = at(this.doc, find(this.doc, id) as number[]);
    const old = attrOf(el, "transform")?.trim() ?? "";
    let next: string;
    const lead = old.match(/^translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)\s*/);
    if (merge && lead) {
      const x = Number(lead[1]) + merge.dx;
      const y = Number(lead[2] ?? 0) + merge.dy;
      const rest = old.slice(lead[0].length);
      next = `translate(${fmt(x)},${fmt(y)})${rest ? ` ${rest}` : ""}`;
    } else next = old ? `${pre} ${old}` : pre;
    this.push({ t: "attrs", id, set: { transform: next } });
  }

  /** A shift in the drawing's coordinates, as a translate in the element's parent's. */
  shift(id: string, dx: number, dy: number) {
    if (!dx && !dy) return;
    const m = this.parentCtm(find(this.doc, id) as number[]);
    const inv = invert([m[0], m[1], m[2], m[3], 0, 0]) ?? IDENTITY;
    const [x, y] = apply(inv, dx, dy);
    this.transform(id, `translate(${fmt(x)},${fmt(y)})`, { dx: x, dy: y });
  }

  /** The centre of the element in its parent's coordinates. */
  centre(id: string): [number, number] {
    const p = find(this.doc, id) as number[];
    const b = elementBox(at(this.doc, p), this.doc.entities, this.fontSizeAt(p));
    if (!b) return bad(`«${id}» has no size that can be measured here: give "cx" and "cy"`);
    return [b.x + b.w / 2, b.y + b.h / 2];
  }
}

function shape(b: Builder, o: Plain) {
  const kind = String(o.kind ?? "");
  const style = o.style && typeof o.style === "object" ? styleSet(o.style as Plain, new Set()) : {};
  const st = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== null)) as Record<
    string,
    string
  >;
  const box = () => ({
    x: num(o.x, "x"),
    y: num(o.y, "y"),
    w: num(o.w ?? o.width, "w"),
    h: num(o.h ?? o.height, "h"),
  });
  switch (kind) {
    case "rect": {
      const r = box();
      const rx = optNum(o.rx, "rx");
      const ry = optNum(o.ry, "ry");
      return b.insert(
        "rect",
        {
          x: fmt(r.x),
          y: fmt(r.y),
          width: fmt(r.w),
          height: fmt(r.h),
          ...(rx !== undefined && { rx: fmt(rx) }),
          ...(ry !== undefined && { ry: fmt(ry) }),
          ...st,
        },
        o,
      );
    }
    case "ellipse": {
      const r = box();
      return b.insert(
        "ellipse",
        {
          cx: fmt(r.x + r.w / 2),
          cy: fmt(r.y + r.h / 2),
          rx: fmt(r.w / 2),
          ry: fmt(r.h / 2),
          ...st,
        },
        o,
      );
    }
    case "circle": {
      if (o.cx !== undefined)
        return b.insert(
          "circle",
          { cx: fmt(num(o.cx, "cx")), cy: fmt(num(o.cy, "cy")), r: fmt(num(o.r, "r")), ...st },
          o,
        );
      const r = box();
      return b.insert(
        "circle",
        { cx: fmt(r.x + r.w / 2), cy: fmt(r.y + r.h / 2), r: fmt(Math.min(r.w, r.h) / 2), ...st },
        o,
      );
    }
    case "line":
      return b.insert(
        "line",
        {
          x1: fmt(num(o.x1, "x1")),
          y1: fmt(num(o.y1, "y1")),
          x2: fmt(num(o.x2, "x2")),
          y2: fmt(num(o.y2, "y2")),
          ...(st.stroke ? {} : { stroke: "#000000" }),
          ...st,
        },
        o,
      );
    case "polygon":
    case "polyline": {
      let pts: string;
      if (Array.isArray(o.points))
        pts = o.points
          .map((p) => {
            if (!Array.isArray(p) || p.length !== 2) bad('"points" is a list of [x, y]');
            return `${fmt(num(p[0], "x"))},${fmt(num(p[1], "y"))}`;
          })
          .join(" ");
      else if (typeof o.points === "string" && numbers(o.points).length >= 4) pts = o.points;
      else return bad('give "points": [[x, y], …]');
      return b.insert(kind, { points: pts, ...st }, o);
    }
    case "path": {
      const d = str(o.d, 'the path\'s "d"');
      if (!/^\s*[Mm]/.test(d)) bad('a path\'s "d" starts with M');
      return b.insert("path", { d, ...st }, o);
    }
    default:
      return bad('"kind" is rect, ellipse, circle, line, polygon, polyline or path');
  }
}

function text(b: Builder, o: Plain) {
  if (typeof o.text !== "string") bad('give the "text"');
  const style = o.style && typeof o.style === "object" ? styleSet(o.style as Plain, new Set()) : {};
  const st = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== null)) as Record<
    string,
    string
  >;
  const t = String(o.text);
  // Several spaces in a row, or at the ends, are kept only with xml:space.
  const keep: Record<string, string> = /\s{2}|^\s|\s$/.test(t) ? { "xml:space": "preserve" } : {};
  return b.insert(
    "text",
    { x: fmt(num(o.x, "x")), y: fmt(num(o.y, "y")), ...keep, ...st },
    o,
    escapeText(t),
  );
}

/** The element whose text is written: a text with one tspan inside writes the tspan. */
function textTarget(b: Builder, id: string): string {
  let p = find(b.doc, id) as number[];
  for (;;) {
    const el = at(b.doc, p);
    const kids = el.children.filter((c) => c.k === "el");
    const loose = el.children.some((c) => (c.k === "text" || c.k === "cdata") && c.raw.trim());
    const only = kids[0];
    if (
      kids.length !== 1 ||
      loose ||
      !only ||
      only.k !== "el" ||
      !["tspan", "textPath"].includes(local(only.name))
    )
      break;
    p = [...p, el.children.indexOf(only)];
  }
  const ref = refOf(b.doc, p);
  return b.named(ref);
}

function group(b: Builder, o: Plain) {
  const list = b.idsOf(o);
  const paths = list.map((id) => find(b.doc, id) as number[]);
  const parentKey = (p: number[]) => p.slice(0, -1).join(".");
  if (new Set(paths.map(parentKey)).size !== 1)
    bad("the elements to group must share the same parent");
  // In the order of the drawing; the group takes the place of the first.
  const order = list
    .map((id, i) => ({ id, i: paths[i]?.at(-1) as number }))
    .sort((x, y) => x.i - y.i);
  const first = order[0]?.id as string;
  const parent = refOf(b.doc, (paths[0] as number[]).slice(0, -1));
  const gid = o.id !== undefined ? str(o.id, '"id"') : b.freshId("g");
  b.push({ t: "insert", parent, before: first, xml: `<g id="${escapeAttr(gid)}" />` });
  for (const x of order) b.push({ t: "move", id: x.id, parent: gid, before: null });
  return gid;
}

const KEEP_ON_GROUP = /^(id|transform|class|style|inkscape:.*|sodipodi:.*|data-.*|xml:.*|xmlns.*)$/;

function ungroup(b: Builder, o: Plain) {
  const gid = b.named(o.id);
  const p = find(b.doc, gid) as number[];
  const g = at(b.doc, p);
  if (local(g.name) !== "g") bad(`«${gid}» is not a group`);
  const gt = attrOf(g, "transform")?.trim();
  const gStyle = attrOf(g, "style")?.trim();
  const inherited = g.attrs.filter((a) => !KEEP_ON_GROUP.test(a.name));
  const parent = refOf(b.doc, p.slice(0, -1));
  const kids = g.children.filter((c): c is XEl => c.k === "el");
  const kidRefs = kids.map((c) => refOf(b.doc, [...p, g.children.indexOf(c)]));
  for (const ref of kidRefs) {
    const id = b.named(ref);
    const el = at(b.doc, find(b.doc, id) as number[]);
    const set: Record<string, string | null> = {};
    if (gt) {
      const own = attrOf(el, "transform")?.trim();
      set.transform = own ? `${gt} ${own}` : gt;
    }
    if (gStyle) {
      const own = attrOf(el, "style")?.trim();
      set.style = own ? `${gStyle.replace(/;?\s*$/, ";")}${own}` : gStyle;
    }
    for (const a of inherited) if (attrOf(el, a.name) === undefined) set[a.name] = a.value;
    if (Object.keys(set).length) b.push({ t: "attrs", id, set });
    b.push({ t: "move", id, parent, before: gid });
  }
  b.push({ t: "remove", id: gid });
}

function reorder(b: Builder, o: Plain) {
  const id = b.named(o.id);
  if (o.parent !== undefined) {
    const { parent, before } = b.place(o);
    b.push({ t: "move", id, parent, before });
    return;
  }
  const p = find(b.doc, id) as number[];
  const parentPath = p.slice(0, -1);
  const parent = at(b.doc, parentPath);
  const i = p.at(-1) as number;
  const els = parent.children
    .map((c, j) => [c, j] as const)
    .filter(([c]) => c.k === "el")
    .map(([, j]) => j);
  const k = els.indexOf(i);
  const to = String(o.to ?? "");
  const ref = (j: number | undefined) =>
    j === undefined ? null : refOf(b.doc, [...parentPath, j]);
  let before: string | null;
  if (to === "front") {
    if (k === els.length - 1) return;
    before = null;
  } else if (to === "back") {
    if (k === 0) return;
    before = ref(els[0]);
  } else if (to === "up") {
    if (k === els.length - 1) return;
    before = ref(els[k + 2]);
  } else if (to === "down") {
    if (k === 0) return;
    before = ref(els[k - 1]);
  } else return bad('"to" is front, back, up or down (or give "parent")');
  b.push({ t: "move", id, parent: refOf(b.doc, parentPath), before });
}

function align(b: Builder, o: Plain) {
  const list = b.idsOf(o);
  const boxes = list.map((id) => b.box(id));
  const x0 = Math.min(...boxes.map((x) => x.x));
  const y0 = Math.min(...boxes.map((x) => x.y));
  const x1 = Math.max(...boxes.map((x) => x.x + x.w));
  const y1 = Math.max(...boxes.map((x) => x.y + x.h));
  const to = String(o.to ?? "");
  list.forEach((id, i) => {
    const x = boxes[i] as Box;
    const d =
      to === "left"
        ? [x0 - x.x, 0]
        : to === "right"
          ? [x1 - (x.x + x.w), 0]
          : to === "center"
            ? [(x0 + x1) / 2 - (x.x + x.w / 2), 0]
            : to === "top"
              ? [0, y0 - x.y]
              : to === "bottom"
                ? [0, y1 - (x.y + x.h)]
                : to === "middle"
                  ? [0, (y0 + y1) / 2 - (x.y + x.h / 2)]
                  : bad('"to" is left, center, right, top, middle or bottom');
    b.shift(id, d[0] as number, d[1] as number);
  });
}

function distribute(b: Builder, o: Plain) {
  const list = b.idsOf(o);
  if (list.length < 3) bad("distribute needs at least three elements");
  const axis =
    o.axis === "y" ? "y" : o.axis === "x" || o.axis === undefined ? "x" : bad('"axis" is x or y');
  const c = (x: Box) => (axis === "x" ? x.x + x.w / 2 : x.y + x.h / 2);
  const items = list.map((id) => ({ id, c: c(b.box(id)) })).sort((p, q) => p.c - q.c);
  const first = items[0]?.c as number;
  const step = ((items.at(-1)?.c as number) - first) / (items.length - 1);
  items.forEach((it, i) => {
    const d = first + step * i - it.c;
    b.shift(it.id, axis === "x" ? d : 0, axis === "y" ? d : 0);
  });
}

function addLayer(b: Builder, o: Plain) {
  const name = str(o.name, 'the layer\'s "name"');
  const id = o.id !== undefined ? str(o.id, '"id"') : b.freshId("layer");
  const inkscape = b.doc.root.attrs.some((a) => a.name === "xmlns:inkscape");
  const xml = inkscape
    ? `<g id="${escapeAttr(id)}" inkscape:groupmode="layer" inkscape:label="${escapeAttr(name)}" />`
    : `<g id="${escapeAttr(id)}" class="layer"><title>${escapeText(name)}</title></g>`;
  b.push({ t: "insert", parent: "", before: null, xml });
}

/** Ids for every element of new markup that has none (so each can be changed later). */
function withIds(b: Builder, xml: string): string {
  const nodes = parseFragment(xml, b.doc.entities);
  const taken = ids(b.doc);
  const name = (el: XEl): XEl => {
    let id = attrOf(el, "id");
    const attrs = el.attrs.slice();
    if (id === undefined) {
      const base = local(el.name).replace(/[^A-Za-z0-9_-]/g, "") || "el";
      let n = 1;
      while (taken.has(`${base}${n}`)) n++;
      id = `${base}${n}`;
      attrs.unshift({ name: "id", value: id });
    }
    taken.add(id);
    const kids = el.children.map((c) => (c.k === "el" ? name(c) : c));
    const { open: _o, ...rest } = el;
    return { ...rest, attrs, children: kids };
  };
  return nodes.map((n) => writeNode(n.k === "el" ? name(n) : n).join("")).join("");
}

function one(b: Builder, o: Plain) {
  const name = String(o.op ?? o.action ?? o.type ?? "").toLowerCase();
  switch (name) {
    case "add_shape":
      return shape(b, o);
    case "add_text":
      return text(b, o);
    case "add_element": {
      const xml = withIds(b, str(o.xml, 'the "xml" to add'));
      const el = oneElement(xml, b.doc);
      if (typeof el === "string") bad(el);
      b.push({ t: "insert", ...b.place(o), xml: xml.trim() });
      return;
    }
    case "set_attr": {
      const id = b.named(o.id);
      const n = str(o.name, 'the attribute\'s "name"');
      b.push({
        t: "attrs",
        id,
        set: { [n]: o.value === null ? null : str(o.value, '"value" (null removes it)') },
      });
      return;
    }
    case "set_style": {
      const set = styleSet(o, new Set(["op", "action", "type", "id", "ids"]));
      if (!Object.keys(set).length) bad("give the style properties to set (fill, stroke…)");
      for (const id of b.idsOf(o)) b.push({ t: "props", id, set });
      return;
    }
    case "set_text": {
      if (typeof o.text !== "string") bad('give the "text"');
      const id = textTarget(b, b.named(o.id));
      b.push({ t: "inner", id, xml: escapeText(String(o.text)) });
      return;
    }
    case "move": {
      const dx = num(o.dx ?? 0, "dx");
      const dy = num(o.dy ?? 0, "dy");
      for (const id of b.idsOf(o)) b.shift(id, dx, dy);
      return;
    }
    case "rotate": {
      const angle = num(o.angle, "angle");
      for (const id of b.idsOf(o)) {
        const [cx, cy] = o.cx !== undefined ? [num(o.cx, "cx"), num(o.cy, "cy")] : b.centre(id);
        b.transform(id, `rotate(${fmt(angle)},${fmt(cx)},${fmt(cy)})`);
      }
      return;
    }
    case "scale": {
      const sx = num(o.sx, "sx");
      const sy = o.sy === undefined ? sx : num(o.sy, "sy");
      for (const id of b.idsOf(o)) {
        const [cx, cy] = o.cx !== undefined ? [num(o.cx, "cx"), num(o.cy, "cy")] : b.centre(id);
        b.transform(
          id,
          `translate(${fmt(cx)},${fmt(cy)}) scale(${fmt(sx)},${fmt(sy)}) translate(${fmt(-cx)},${fmt(-cy)})`,
        );
      }
      return;
    }
    case "delete":
    case "remove":
      for (const id of b.idsOf(o)) b.push({ t: "remove", id });
      return;
    case "group":
      return group(b, o);
    case "ungroup":
      return ungroup(b, o);
    case "reorder":
      return reorder(b, o);
    case "align":
      return align(b, o);
    case "distribute":
      return distribute(b, o);
    case "add_layer":
      return addLayer(b, o);
    default:
      return bad(`unknown operation «${name}» (call canvas_edit with "help": true)`);
  }
}

/** An agent's operations as the family's actions, or the first one that cannot be done. */
export function svgFromAgent(
  doc: XDoc,
  ops: readonly unknown[],
): { actions: SvgPlainAction[] } | { error: string; index: number } {
  const b = new Builder(doc);
  for (const [index, raw] of ops.entries()) {
    try {
      if (!raw || typeof raw !== "object") bad("an operation is an object");
      one(b, raw as Plain);
    } catch (err) {
      return { error: (err as Error).message, index };
    }
  }
  if (!b.out.length) return { error: "these operations change nothing", index: 0 };
  return { actions: b.out };
}
