// The document family's actions (G37.4), pure: what each does to the outline, its inverse, the
// places it touches (the same paragraph, table, slide or shape is a conflict), how an action
// moves over another, and the agent's plain operations (canvas_edit) turned into actions. The
// engines apply the same actions to the real file with UNO (office-engine.ts here, the page's
// ZetaOffice there); the outline is what the host checks them on and the agent reads.
import type {
  OfficeAction,
  OfficeHunk,
  OfficeItem,
  OfficeOutline,
  OfficePicture,
  OfficePlainAction,
  OfficeShape,
  OfficeSlide,
  OfficeSlideSnap,
} from "@redgiant/protocol";
import { layoutOf } from "./office-outline.js";

type Writer = Extract<OfficeOutline, { app: "writer" }>;
type Impress = Extract<OfficeOutline, { app: "impress" }>;

/** Reads a saved page's file (a blob) as an outline: the family keeps them. */
export type OutlineOf = (blob: string) => OfficeOutline | undefined;

export const LAYOUTS: Record<string, number> = {
  title: 0,
  title_content: 1,
  two_content: 3,
  title_only: 19,
  blank: 20,
};
const LAYOUT_NAMES = Object.fromEntries(Object.entries(LAYOUTS).map(([k, v]) => [v, k]));

/** The text an action expects for an item: a paragraph's text, a table's name. */
export const itemKey = (it: OfficeItem | undefined): string | null =>
  it === undefined ? null : it.k === "p" ? it.text : it.name;

/** A slide's title, or its name without one. */
export const slideKey = (s: OfficeSlide | OfficeSlideSnap | undefined): string =>
  s?.shapes.find((x) => x.kind === "title")?.text || (s?.name ?? "");

const headingLevel = (style: string): number | undefined => {
  const m = style.match(/^Heading (\d{1,2})$/);
  return m ? Math.min(10, Number(m[1])) : undefined;
};

/** The placeholders LibreOffice puts on a new slide with a layout. */
export function placeholders(layout: number, title?: string, body?: string): OfficeShape[] {
  const t = (kind: OfficeShape["kind"], text = ""): OfficeShape => ({ kind, text });
  switch (layout) {
    case 0:
      return [t("title", title), t("subtitle", body)];
    case 1:
      return [t("title", title), t("outline", body)];
    case 3:
      return [t("title", title), t("outline", body), t("outline")];
    case 19:
      return [t("title", title)];
    default:
      return [];
  }
}

/** A slide as a snapshot (what brings it back after a deletion). */
export const snapOf = (s: OfficeSlide): OfficeSlideSnap => ({
  name: s.name,
  layout: s.layout ?? layoutOf(s.shapes),
  shapes: s.shapes.map((x) => ({ ...x })),
});

const cellIndex = (cell: string): [number, number] => {
  const m = cell.match(/^([A-Z]{1,3})(\d+)$/) as RegExpMatchArray;
  let c = 0;
  for (const ch of m[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, c - 1];
};
export const cellName = (r: number, c: number): string => {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${r + 1}`;
};

// ---- applying ---------------------------------------------------------------------------------

function itemOfInsert(a: Extract<OfficeAction, { t: "insert_item" | "delete_item" }>): OfficeItem {
  if (a.kind === "table") {
    const rows = a.rows ?? a.cells?.length ?? 1;
    const cols = a.cols ?? Math.max(1, ...(a.cells ?? [[]]).map((r) => r.length));
    const cells = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => a.cells?.[r]?.[c] ?? ""),
    );
    return { k: "table", name: a.name ?? "Table", rows, cols, cells };
  }
  const style = a.style ?? "Standard";
  const level = headingLevel(style);
  return {
    k: "p",
    text: a.text ?? "",
    style,
    ...(level && { level }),
    ...(a.picture && { pics: 1 }),
  };
}

/** Why an action cannot apply to this outline (undefined: it can). */
export function checkAction(
  o: OfficeOutline,
  a: OfficeAction,
  outlineOf: OutlineOf,
): string | undefined {
  try {
    applyAction(o, a, outlineOf, true);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function fail(s: string): never {
  throw new Error(s);
}

function writerOf(o: OfficeOutline, what: string): Writer {
  if (o.app !== "writer") fail(`${what} is for text documents, this is a presentation`);
  return o as Writer;
}
function impressOf(o: OfficeOutline, what: string): Impress {
  if (o.app !== "impress") fail(`${what} is for presentations, this is a text document`);
  return o as Impress;
}

/** The outline after an action (checked: throws with the reason when it does not fit). */
export function applyAction(
  o: OfficeOutline,
  a: OfficeAction,
  outlineOf: OutlineOf,
  strict = true,
): OfficeOutline {
  switch (a.t) {
    case "text": {
      const replace = (cur: string) => {
        if (strict && cur !== a.expect) fail("the text there changed: look again");
        if (cur.slice(a.off, a.off + a.del.length) !== a.del || a.off > cur.length)
          fail("the text to change is not where it was: look again");
        return cur.slice(0, a.off) + a.ins + cur.slice(a.off + a.del.length);
      };
      if ("item" in a.at) {
        const w = writerOf(o, "this change");
        const it = w.items[a.at.item];
        if (!it || it.k !== "p") fail(`item ${a.at.item + 1} is not a paragraph`);
        const p = it as Extract<OfficeItem, { k: "p" }>;
        const items = [...w.items];
        items[a.at.item] = { ...p, text: replace(p.text) };
        return { ...w, items };
      }
      const im = impressOf(o, "this change");
      const { slide, shape } = a.at;
      const s = im.slides[slide] ?? fail(`there is no slide ${slide + 1}`);
      const sh = s.shapes[shape] ?? fail(`slide ${slide + 1} has no shape ${shape + 1}`);
      const shapes = [...s.shapes];
      shapes[shape] = { ...sh, text: replace(sh.text) };
      const slides = [...im.slides];
      slides[slide] = { ...s, shapes };
      return { ...im, slides };
    }
    case "insert_item": {
      const w = writerOf(o, "a paragraph or a table");
      if (a.at > w.items.length) fail(`there is no item ${a.at} to put it after`);
      if (strict && a.at > 0 && itemKey(w.items[a.at - 1]) !== a.prev)
        fail(`item ${a.at} changed: look again`);
      const items = [...w.items];
      items.splice(a.at, 0, itemOfInsert(a));
      return { ...w, items };
    }
    case "delete_item": {
      const w = writerOf(o, "deleting a paragraph or a table");
      const it = w.items[a.at] ?? fail(`there is no item ${a.at + 1}`);
      if (it.k !== a.kind)
        fail(`item ${a.at + 1} is not a ${a.kind === "p" ? "paragraph" : "table"}`);
      if (strict && itemKey(it) !== a.expect) fail(`item ${a.at + 1} changed: look again`);
      const items = [...w.items];
      items.splice(a.at, 1);
      return { ...w, items };
    }
    case "para_style": {
      const w = writerOf(o, "a paragraph style");
      const it = w.items[a.item];
      if (!it || it.k !== "p") fail(`item ${a.item + 1} is not a paragraph`);
      const p = it as Extract<OfficeItem, { k: "p" }>;
      if (strict && p.text !== a.expect) fail(`paragraph ${a.item + 1} changed: look again`);
      const items = [...w.items];
      const level = headingLevel(a.style);
      const { level: _old, ...rest } = p;
      items[a.item] = { ...rest, style: a.style, ...(level && { level }) };
      return { ...w, items };
    }
    case "cell": {
      const w = writerOf(o, "a table cell");
      const it = w.items[a.item];
      if (!it || it.k !== "table") fail(`item ${a.item + 1} is not a table`);
      const t = it as Extract<OfficeItem, { k: "table" }>;
      if (strict && t.name !== a.expect) fail(`table ${a.item + 1} changed: look again`);
      const [r, c] = cellIndex(a.cell);
      if (r >= t.rows || c >= t.cols)
        fail(`the table has ${t.rows} rows and ${t.cols} columns: there is no ${a.cell}`);
      const cells = t.cells.map((row) => [...row]);
      while (cells.length <= r) cells.push([]);
      const row = cells[r] as string[];
      while (row.length <= c) row.push("");
      row[c] = a.text;
      const items = [...w.items];
      items[a.item] = { ...t, cells };
      return { ...w, items };
    }
    case "add_slide": {
      const im = impressOf(o, "a slide");
      if (a.at > im.slides.length) fail(`there is no slide ${a.at} to put it after`);
      const slide: OfficeSlide = a.snap
        ? {
            name: a.snap.name ?? "",
            layout: a.snap.layout,
            shapes: a.snap.shapes.map((x) => ({ ...x })),
          }
        : { name: "", layout: a.layout, shapes: placeholders(a.layout, a.title, a.body) };
      const slides = [...im.slides];
      slides.splice(a.at, 0, slide);
      return { ...im, slides };
    }
    case "delete_slide": {
      const im = impressOf(o, "deleting a slide");
      const s = im.slides[a.at] ?? fail(`there is no slide ${a.at + 1}`);
      if (strict && slideKey(s) !== a.expect) fail(`slide ${a.at + 1} changed: look again`);
      if (im.slides.length === 1) fail("a presentation keeps at least one slide");
      const slides = [...im.slides];
      slides.splice(a.at, 1);
      return { ...im, slides };
    }
    case "add_shape": {
      const im = impressOf(o, "a picture on a slide");
      const s = im.slides[a.slide] ?? fail(`there is no slide ${a.slide + 1}`);
      if (strict && slideKey(s) !== a.expect) fail(`slide ${a.slide + 1} changed: look again`);
      const slides = [...im.slides];
      slides[a.slide] = {
        ...s,
        shapes: [
          ...s.shapes,
          {
            kind: "picture",
            text: "",
            picture: a.picture,
            x: a.x,
            y: a.y,
            w: a.picture.w,
            h: a.picture.h,
          },
        ],
      };
      return { ...im, slides };
    }
    case "delete_shape": {
      const im = impressOf(o, "deleting a shape");
      const s = im.slides[a.slide] ?? fail(`there is no slide ${a.slide + 1}`);
      const sh = s.shapes[a.shape] ?? fail(`slide ${a.slide + 1} has no shape ${a.shape + 1}`);
      if (strict && (sh.name ?? sh.kind) !== a.expect && sh.kind !== a.expect)
        fail(`shape ${a.shape + 1} of slide ${a.slide + 1} changed: look again`);
      const shapes = [...s.shapes];
      shapes.splice(a.shape, 1);
      const slides = [...im.slides];
      slides[a.slide] = { ...s, shapes };
      return { ...im, slides };
    }
    case "batch": {
      let m = o;
      for (const [i, x] of a.ops.entries()) {
        try {
          m = applyAction(m, x, outlineOf, strict);
        } catch (err) {
          fail(
            a.ops.length > 1
              ? `change ${i + 1}: ${(err as Error).message}`
              : (err as Error).message,
          );
        }
      }
      return m;
    }
    case "file": {
      const base = outlineOf(a.blob) ?? fail("the page's saved file is not here: open it again");
      if (base.app !== o.app) fail("the page saved another kind of document");
      let m = base;
      // The later actions made again after the person's file: one that no longer fits is left
      // out (the person's edit came first there).
      for (const x of a.replay ?? []) {
        try {
          m = applyAction(m, x, outlineOf, strict);
        } catch {}
      }
      return m;
    }
    case "restore":
      return fail(
        "the person's own edits in the document are taken back with Ctrl+Z there, not from here",
      );
  }
}

// ---- inverses -------------------------------------------------------------------------------

/** The action that undoes `a`, on the outline after it (`o` is the one before). */
export function invertAction(
  o: OfficeOutline,
  a: OfficeAction,
  outlineOf: OutlineOf,
): OfficeAction {
  switch (a.t) {
    case "text": {
      const after = applyAction(o, a, outlineOf, false);
      const cur =
        "item" in a.at
          ? ((after as Writer).items[a.at.item] as Extract<OfficeItem, { k: "p" }>).text
          : (((after as Impress).slides[a.at.slide] as OfficeSlide).shapes[a.at.shape]?.text ?? "");
      return { t: "text", at: a.at, expect: cur, off: a.off, del: a.ins, ins: a.del };
    }
    case "insert_item": {
      const it = itemOfInsert(a);
      return {
        t: "delete_item",
        at: a.at,
        expect: itemKey(it) ?? "",
        kind: a.kind,
        ...snapshotFields(it),
        ...(a.picture && { picture: a.picture }),
      };
    }
    case "delete_item": {
      const w = o as Writer;
      const it = w.items[a.at] as OfficeItem;
      return {
        t: "insert_item",
        at: a.at,
        prev: itemKey(w.items[a.at - 1]),
        kind: a.kind,
        ...snapshotFields(it),
        ...(a.picture && { picture: a.picture }),
      };
    }
    case "para_style":
      return { ...a, style: a.before, before: a.style };
    case "cell":
      return { ...a, text: a.before, before: a.text };
    case "add_slide": {
      const after = applyAction(o, a, outlineOf, false) as Impress;
      const s = after.slides[a.at] as OfficeSlide;
      return { t: "delete_slide", at: a.at, expect: slideKey(s), snap: snapOf(s) };
    }
    case "delete_slide": {
      const s = (o as Impress).slides[a.at] as OfficeSlide;
      const snap = snapOf(s);
      return { t: "add_slide", at: a.at, layout: snap.layout, snap };
    }
    case "add_shape": {
      const s = (o as Impress).slides[a.slide] as OfficeSlide;
      return {
        t: "delete_shape",
        slide: a.slide,
        shape: s.shapes.length,
        expect: "picture",
        picture: a.picture,
        x: a.x,
        y: a.y,
      };
    }
    case "delete_shape":
      if (a.picture)
        return {
          t: "add_shape",
          slide: a.slide,
          expect: slideKey((o as Impress).slides[a.slide]),
          picture: a.picture,
          x: a.x ?? 0,
          y: a.y ?? 0,
        };
      return { t: "restore", outline: o };
    case "batch": {
      const inv: OfficePlainAction[] = [];
      let m = o;
      for (const x of a.ops) {
        const i = invertAction(m, x, outlineOf);
        if (i.t === "restore" || i.t === "batch" || i.t === "file")
          return { t: "restore", outline: o };
        inv.unshift(i);
        m = applyAction(m, x, outlineOf, false);
      }
      return { t: "batch", ops: inv };
    }
    case "file":
    case "restore":
      return { t: "restore", outline: o };
  }
}

/** The fields that bring an item back. */
function snapshotFields(it: OfficeItem) {
  return it.k === "p"
    ? { text: it.text, style: it.style }
    : {
        name: it.name,
        rows: Math.max(1, it.rows),
        cols: Math.max(1, it.cols),
        cells: it.cells.slice(0, 200),
      };
}

/** Several actions as one (undefined when one of them cannot be moved: a page's own edits taken back). */
export function composeActions(list: readonly OfficeAction[]): OfficeAction | undefined {
  const flat: OfficePlainAction[] = [];
  if (list.length === 1) return list[0]?.t === "restore" ? undefined : list[0];
  for (const a of list) {
    if (a.t === "batch") flat.push(...a.ops);
    else if (a.t === "file" || a.t === "restore") return undefined;
    else flat.push(a);
  }
  return flat.length ? { t: "batch", ops: flat } : undefined;
}

// ---- places, conflicts, moving over -----------------------------------------------------------

/**
 * The places an action touches, on a doubled axis: item i is 2i+1, the gap before it 2i. Slides
 * the same with an «s», a slide's shapes after it («s5:3»); «*» is everything.
 */
export function placesOf(a: OfficeAction): Set<string> {
  const out = new Set<string>();
  const range = (p: string, from: number, to: number) => {
    for (let k = from; k <= to; k++) out.add(`${p}${k}`);
  };
  switch (a.t) {
    case "text":
      if ("item" in a.at) out.add(`i${2 * a.at.item + 1}`);
      else out.add(`s${2 * a.at.slide + 1}:${2 * a.at.shape + 1}`);
      break;
    case "insert_item":
      range("i", Math.max(0, 2 * a.at - 1), 2 * a.at);
      break;
    case "delete_item":
      range("i", 2 * a.at, 2 * a.at + 2);
      break;
    case "para_style":
    case "cell":
      out.add(`i${2 * a.item + 1}`);
      break;
    case "add_slide":
      out.add(`s${2 * a.at}`);
      break;
    case "delete_slide":
      range("s", 2 * a.at, 2 * a.at + 2);
      break;
    case "add_shape":
      out.add(`s${2 * a.slide + 1}:+`);
      break;
    case "delete_shape":
      out.add(`s${2 * a.slide + 1}:${2 * a.shape + 1}`);
      break;
    case "batch":
      for (const x of a.ops) for (const p of placesOf(x)) out.add(p);
      break;
    case "file":
      for (const h of a.hunks) range("x", 2 * h.at, 2 * (h.at + h.del));
      break;
    case "restore":
      out.add("*");
      break;
  }
  return out;
}

/** Whether two actions made on the same outline touch the same place. */
export function actionsConflict(
  a: OfficeAction,
  b: OfficeAction,
  app?: "writer" | "impress",
): boolean {
  const norm = (s: Set<string>) => {
    // A page's hunks count items in a text, slides in a presentation.
    const out = new Set<string>();
    for (const p of s) {
      if (p.startsWith("x")) {
        if (app !== "impress") out.add(`i${p.slice(1)}`);
        if (app !== "writer") out.add(`s${p.slice(1)}`);
      } else out.add(p);
    }
    return out;
  };
  const A = norm(placesOf(a));
  const B = norm(placesOf(b));
  if (A.has("*") || B.has("*")) return true;
  const slideOf = (p: string) => (p.startsWith("s") ? p.split(":")[0] : undefined);
  for (const p of A) {
    if (B.has(p) && !p.endsWith(":+")) return true;
    const s = slideOf(p);
    // A slide as a whole against one of its shapes.
    if (s && !p.includes(":") && [...B].some((q) => q.startsWith(`${s}:`))) return true;
    if (s && p.includes(":") && B.has(s)) return true;
  }
  return false;
}

/** How `b` moves item and slide numbers (and a slide's shapes). */
interface Shift {
  item(i: number, gap: boolean): number;
  slide(i: number, gap: boolean): number;
  shape(slide: number, i: number): number;
}

function shiftOf(b: OfficeAction, app: "writer" | "impress" | undefined): Shift {
  const id: Shift = { item: (i) => i, slide: (i) => i, shape: (_s, i) => i };
  const insert = (k: number) => (i: number, gap: boolean) => (i >= k ? i + 1 : i) + (gap ? 0 : 0);
  const remove = (k: number) => (i: number, gap: boolean) => (i > k || (gap && i > k) ? i - 1 : i);
  const hunks = (hs: readonly OfficeHunk[]) => (i: number, gap: boolean) => {
    let d = 0;
    for (const h of [...hs].sort((x, y) => x.at - y.at)) {
      if (i >= h.at + h.del && !(gap && i === h.at + h.del && h.del === 0 && i === h.at))
        d += h.ins - h.del;
      else if (i > h.at) return h.at + d;
    }
    return i + d;
  };
  switch (b.t) {
    case "insert_item":
      return { ...id, item: insert(b.at) };
    case "delete_item":
      return { ...id, item: remove(b.at) };
    case "add_slide":
      return { ...id, slide: insert(b.at) };
    case "delete_slide":
      return { ...id, slide: remove(b.at) };
    case "delete_shape":
      return { ...id, shape: (s, i) => (s === b.slide && i > b.shape ? i - 1 : i) };
    case "file":
      return app === "impress" ? { ...id, slide: hunks(b.hunks) } : { ...id, item: hunks(b.hunks) };
    case "batch": {
      const parts = b.ops.map((x) => shiftOf(x, app));
      return {
        item: (i, g) => parts.reduce((v, p) => p.item(v, g), i),
        slide: (i, g) => parts.reduce((v, p) => p.slide(v, g), i),
        shape: (s, i) => parts.reduce((v, p) => p.shape(s, v), i),
      };
    }
    default:
      return id;
  }
}

/** `a`, made on the same outline as `b`, moved to apply after `b`. */
export function mapAction(
  a: OfficeAction,
  b: OfficeAction,
  app?: "writer" | "impress",
): OfficeAction {
  if (a.t === "file") {
    // The person's file came first: `b` is made again after it, unless it touched what they changed.
    if (b.t === "file" || b.t === "restore") return a;
    const later = b.t === "batch" ? b.ops : [b];
    const replay = [...(a.replay ?? [])];
    for (const x of later)
      if (!actionsConflict(x, a, app)) replay.push(mapAction(x, a, app) as OfficePlainAction);
    const sh = shiftOf(b, app);
    const move = (i: number) => (app === "impress" ? sh.slide(i, true) : sh.item(i, true));
    return { ...a, hunks: a.hunks.map((h) => ({ ...h, at: move(h.at) })), replay };
  }
  const sh = shiftOf(b, app);
  switch (a.t) {
    case "text":
      return "item" in a.at
        ? { ...a, at: { item: sh.item(a.at.item, false) } }
        : (() => {
            const slide = sh.slide(a.at.slide, false);
            return { ...a, at: { slide, shape: sh.shape(a.at.slide, a.at.shape) } };
          })();
    case "insert_item":
      return { ...a, at: sh.item(a.at, true) };
    case "delete_item":
      return { ...a, at: sh.item(a.at, false) };
    case "para_style":
    case "cell":
      return { ...a, item: sh.item(a.item, false) };
    case "add_slide":
      return { ...a, at: sh.slide(a.at, true) };
    case "delete_slide":
      return { ...a, at: sh.slide(a.at, false) };
    case "add_shape":
      return { ...a, slide: sh.slide(a.slide, false) };
    case "delete_shape":
      return { ...a, slide: sh.slide(a.slide, false), shape: sh.shape(a.slide, a.shape) };
    case "batch": {
      // Each one over `b`, then over the batch's own earlier actions moved the same way.
      return { ...a, ops: a.ops.map((x) => mapAction(x, b, app) as OfficePlainAction) };
    }
    case "restore":
      return a;
  }
}

// ---- the person's own edits ----------------------------------------------------------------

/** The items (or slides) a page's saved file changed, as runs: a small diff on their texts. */
export function outlineHunks(before: OfficeOutline, after: OfficeOutline): OfficeHunk[] {
  const keyOf = (o: OfficeOutline): string[] =>
    o.app === "writer"
      ? o.items.map((it) =>
          it.k === "p" ? `p|${it.style}|${it.text}` : `t|${JSON.stringify(it.cells)}`,
        )
      : o.slides.map((s) =>
          JSON.stringify(s.shapes.map((x) => [x.kind, x.text, x.x, x.y, x.w, x.h])),
        );
  const a = keyOf(before);
  const b = after.app === before.app ? keyOf(after) : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const del = a.length - pre - suf;
  const ins = b.length - pre - suf;
  return del === 0 && ins === 0 ? [] : [{ at: pre, del, ins }];
}

// ---- the agent's plain operations ------------------------------------------------------------

const num = (v: unknown, what: string, min = 1): number => {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min)
    fail(`"${what}" must be a whole number${min > 0 ? ` from ${min}` : ""}`);
  return n as number;
};
const str = (v: unknown, what: string, empty = true): string => {
  if (typeof v !== "string") fail(`"${what}" must be text`);
  if (!empty && !(v as string)) fail(`"${what}" is empty`);
  return v as string;
};

const STYLE_ALIASES: Record<string, string[]> = {
  title: ["Title"],
  subtitle: ["Subtitle"],
  body: ["Text body", "Body Text", "Standard"],
  text: ["Text body", "Body Text", "Standard"],
  normal: ["Standard", "Text body"],
  default: ["Standard"],
  quote: ["Quotations"],
  list: ["List Bullet", "List"],
};

/** A paragraph style the document has, from the agent's words («heading 2», «Titolo 1»…). */
export function resolveStyle(o: Writer, wanted: string): string {
  const w = wanted.trim();
  const has = (s: string) => o.styles.find((x) => x.toLowerCase() === s.toLowerCase());
  const direct = has(w);
  if (direct) return direct;
  const h = w.match(/^(?:heading|titolo|h)\s*(\d{1,2})$/i);
  if (h) {
    const s = has(`Heading ${h[1]}`);
    // A built-in heading exists in every Writer document even when unused.
    return s ?? `Heading ${h[1]}`;
  }
  for (const c of STYLE_ALIASES[w.toLowerCase()] ?? []) {
    const s = has(c);
    if (s) return s;
  }
  if (["Title", "Subtitle", "Text body", "Standard", "Quotations", "List"].includes(w)) return w;
  return fail(
    `the document has no paragraph style «${w}»; some it has: ${o.styles.slice(0, 15).join(", ")}`,
  );
}

const opName = (x: Record<string, unknown>) =>
  String(x.op ?? x.action ?? x.type ?? x.name ?? "").toLowerCase();

/** Item numbers as the agent reads them (1-based) to an index, checked. */
const itemAt = (w: Writer, v: unknown, what: string): number => {
  const n = num(v, what);
  if (n > w.items.length) fail(`there are ${w.items.length} items: no ${n}`);
  return n - 1;
};

/** A writer paragraph's default style after an item. */
function styleAfter(w: Writer, at: number): string {
  const prev = w.items[at - 1];
  const body = w.styles.find((s) => s === "Text body" || s === "Body Text") ?? "Standard";
  if (!prev || prev.k !== "p" || prev.level || /^(Title|Subtitle)$/.test(prev.style)) return body;
  return prev.style;
}

/** One agent operation on the outline: its actions, applied one after the other. */
function fromAgentOne(
  o: OfficeOutline,
  x: Record<string, unknown>,
  outlineOf: OutlineOf,
): OfficePlainAction[] {
  const name = opName(x);
  const out: OfficePlainAction[] = [];
  let m = o;
  const push = (a: OfficePlainAction) => {
    m = applyAction(m, a, outlineOf);
    out.push(a);
  };
  const replaceAll = () => {
    const find = str(x.find, "find", false);
    const text = str(x.text ?? x.with ?? x.replace ?? "", "text");
    const all = x.all === true || x.all === "true";
    type Hit = {
      where: { item: number } | { slide: number; shape: number } | { cell: [number, string] };
      off: number;
    };
    const hits: Hit[] = [];
    const scan = (s: string, where: Hit["where"]) => {
      for (let i = s.indexOf(find); i >= 0; i = s.indexOf(find, i + find.length))
        hits.push({ where, off: i });
    };
    if (m.app === "writer")
      for (const [i, it] of m.items.entries()) {
        if (it.k === "p") scan(it.text, { item: i });
        else
          for (const [r, row] of it.cells.entries())
            for (const [cc, c] of row.entries()) scan(c, { cell: [i, cellName(r, cc)] });
      }
    else
      for (const [si, sl] of m.slides.entries())
        for (const [k, sh] of sl.shapes.entries()) scan(sh.text, { slide: si, shape: k });
    if (hits.length === 0) fail(`«${find}» is not in the document`);
    if (hits.length > 1 && !all)
      fail(
        `«${find}» appears ${hits.length} times: give more of the text around it, or "all": true`,
      );
    // From the last to the first, so the earlier offsets stay true.
    const cells = new Map<string, { item: number; cell: string }>();
    for (const h of [...hits].reverse()) {
      if ("cell" in h.where) {
        cells.set(`${h.where.cell[0]}|${h.where.cell[1]}`, {
          item: h.where.cell[0],
          cell: h.where.cell[1],
        });
        continue;
      }
      const cur =
        "item" in h.where
          ? ((m as Writer).items[h.where.item] as Extract<OfficeItem, { k: "p" }>).text
          : (((m as Impress).slides[h.where.slide] as OfficeSlide).shapes[h.where.shape]?.text ??
            "");
      push({ t: "text", at: h.where, expect: cur, off: h.off, del: find, ins: text });
    }
    for (const c of cells.values()) {
      const t = (m as Writer).items[c.item] as Extract<OfficeItem, { k: "table" }>;
      const [r, cc] = cellIndex(c.cell);
      const before = t.cells[r]?.[cc] ?? "";
      push({
        t: "cell",
        item: c.item,
        expect: t.name,
        cell: c.cell,
        text: before.split(find).join(text),
        before,
      });
    }
  };
  switch (name) {
    case "replace_text":
    case "replace":
      replaceAll();
      break;
    case "insert_paragraph":
    case "add_paragraph": {
      const w = writerOf(m, name);
      const after = x.after === undefined ? w.items.length : num(x.after, "after", 0);
      if (after > w.items.length)
        fail(`there are ${w.items.length} items: no ${after} to put it after`);
      const style =
        x.style !== undefined
          ? resolveStyle(w, str(x.style, "style", false))
          : styleAfter(w, after);
      const lines = str(x.text ?? "", "text").split(/\r?\n/);
      lines.forEach((line, i) => {
        const at = after + i;
        push({
          t: "insert_item",
          at,
          prev: itemKey((m as Writer).items[at - 1]),
          kind: "p",
          text: line,
          style,
        });
      });
      break;
    }
    case "set_paragraph":
    case "set_text": {
      const w = writerOf(m, name);
      const at = itemAt(w, x.paragraph ?? x.item, "paragraph");
      const it = w.items[at] as OfficeItem;
      if (it.k !== "p") fail(`item ${at + 1} is a table: use set_cell`);
      const p = it as Extract<OfficeItem, { k: "p" }>;
      push({
        t: "text",
        at: { item: at },
        expect: p.text,
        off: 0,
        del: p.text,
        ins: str(x.text, "text"),
      });
      break;
    }
    case "delete_paragraph": {
      const w = writerOf(m, name);
      const at = itemAt(w, x.paragraph ?? x.item, "paragraph");
      const it = w.items[at] as OfficeItem;
      if (it.k !== "p") fail(`item ${at + 1} is a table: use delete_table`);
      if (it.pics) fail(`paragraph ${at + 1} holds a picture: it is not deleted from here`);
      push({ t: "delete_item", at, expect: it.text, kind: "p", text: it.text, style: it.style });
      break;
    }
    case "set_style": {
      const w = writerOf(m, name);
      const at = itemAt(w, x.paragraph ?? x.item, "paragraph");
      const it = w.items[at] as OfficeItem;
      if (it.k !== "p") fail(`item ${at + 1} is a table`);
      const style = resolveStyle(w, str(x.style, "style", false));
      push({ t: "para_style", item: at, expect: it.text, style, before: it.style });
      break;
    }
    case "insert_table":
    case "add_table": {
      const w = writerOf(m, name);
      const after = x.after === undefined ? w.items.length : num(x.after, "after", 0);
      if (after > w.items.length) fail(`there are ${w.items.length} items: no ${after}`);
      const cells = Array.isArray(x.cells)
        ? (x.cells as unknown[]).map((r) =>
            Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")],
          )
        : undefined;
      const rows = x.rows !== undefined ? num(x.rows, "rows") : (cells?.length ?? 2);
      const cols =
        x.cols !== undefined || x.columns !== undefined
          ? num(x.cols ?? x.columns, "cols")
          : Math.max(1, ...(cells ?? [[""]]).map((r) => r.length), 2);
      if (rows > 200 || cols > 50) fail("a table here has at most 200 rows and 50 columns");
      const names = new Set(
        w.items.filter((i) => i.k === "table").map((i) => (i as { name: string }).name),
      );
      let n = names.size + 1;
      while (names.has(`Table${n}`)) n++;
      push({
        t: "insert_item",
        at: after,
        prev: itemKey(w.items[after - 1]),
        kind: "table",
        rows,
        cols,
        name: `Table${n}`,
        ...(cells && { cells: cells.slice(0, rows).map((r) => r.slice(0, cols)) }),
      });
      break;
    }
    case "set_cell": {
      const w = writerOf(m, name);
      const at = itemAt(w, x.table ?? x.item, "table");
      const it = w.items[at] as OfficeItem;
      if (it.k !== "table") fail(`item ${at + 1} is not a table`);
      const cell = str(x.cell, "cell", false).toUpperCase().trim();
      if (!/^[A-Z]{1,3}[1-9]\d{0,4}$/.test(cell)) fail(`"cell" is like "B2", not «${cell}»`);
      const [r, c] = cellIndex(cell);
      push({
        t: "cell",
        item: at,
        expect: it.name,
        cell,
        text: str(x.text, "text"),
        before: it.cells[r]?.[c] ?? "",
      });
      break;
    }
    case "delete_table": {
      const w = writerOf(m, name);
      const at = itemAt(w, x.table ?? x.item, "table");
      const it = w.items[at] as OfficeItem;
      if (it.k !== "table") fail(`item ${at + 1} is not a table`);
      push({
        t: "delete_item",
        at,
        expect: it.name,
        kind: "table",
        name: it.name,
        rows: Math.max(1, it.rows),
        cols: Math.max(1, it.cols),
        cells: it.cells.slice(0, 200),
      });
      break;
    }
    case "insert_image":
    case "add_image": {
      const picture = x.picture as OfficePicture | undefined;
      if (!picture) fail('give the picture\'s "path" (an image file in your workspace)');
      const pic = picture as OfficePicture;
      if (m.app === "writer") {
        const w = m;
        const after = x.after === undefined ? w.items.length : num(x.after, "after", 0);
        if (after > w.items.length) fail(`there are ${w.items.length} items: no ${after}`);
        push({
          t: "insert_item",
          at: after,
          prev: itemKey(w.items[after - 1]),
          kind: "p",
          text: "",
          style: "Standard",
          picture: pic,
        });
      } else {
        const im = m;
        const s = num(x.slide, "slide");
        const slide = im.slides[s - 1] ?? fail(`there are ${im.slides.length} slides: no ${s}`);
        const mm = (v: unknown, d: number) => (v === undefined ? d : Math.round(Number(v) * 100));
        push({
          t: "add_shape",
          slide: s - 1,
          expect: slideKey(slide),
          picture: pic,
          x: mm(x.x_mm, 2000),
          y: mm(x.y_mm, 4000),
        });
      }
      break;
    }
    case "add_slide":
    case "insert_slide": {
      const im = impressOf(m, name);
      const after = x.after === undefined ? im.slides.length : num(x.after, "after", 0);
      if (after > im.slides.length) fail(`there are ${im.slides.length} slides: no ${after}`);
      const lname = String(
        x.layout ?? (x.text !== undefined ? "title_content" : "title_only"),
      ).toLowerCase();
      const layout =
        LAYOUTS[lname] ?? fail(`"layout" is one of: ${Object.keys(LAYOUTS).join(", ")}`);
      const title = x.title !== undefined ? str(x.title, "title") : undefined;
      const body = x.text !== undefined ? str(x.text, "text") : undefined;
      if (layout === 20 && (title || body))
        fail('a "blank" slide has no title or text: choose another layout');
      if (layout === 19 && body) fail('a "title_only" slide has no text: use "title_content"');
      push({ t: "add_slide", at: after, layout, ...(title && { title }), ...(body && { body }) });
      break;
    }
    case "set_slide_text": {
      const im = impressOf(m, name);
      const s = num(x.slide, "slide");
      const slide = im.slides[s - 1] ?? fail(`there are ${im.slides.length} slides: no ${s}`);
      const which = x.shape ?? "body";
      let k: number;
      if (typeof which === "string" && !/^\d+$/.test(which)) {
        const want = which.toLowerCase();
        const kinds: OfficeShape["kind"][] =
          want === "title"
            ? ["title"]
            : want === "subtitle"
              ? ["subtitle"]
              : ["outline", "subtitle", "text"];
        k = slide.shapes.findIndex((sh) => kinds.includes(sh.kind));
        if (k < 0)
          fail(
            `slide ${s} has no ${want} (its shapes: ${slide.shapes.map((sh, i) => `${i + 1} ${sh.kind}`).join(", ") || "none"})`,
          );
      } else {
        k = num(which, "shape") - 1;
        if (!slide.shapes[k]) fail(`slide ${s} has ${slide.shapes.length} shapes: no ${k + 1}`);
      }
      const sh = slide.shapes[k] as OfficeShape;
      if (["picture", "chart", "table", "other"].includes(sh.kind))
        fail(`shape ${k + 1} of slide ${s} is a ${sh.kind}: it has no text to set`);
      push({
        t: "text",
        at: { slide: s - 1, shape: k },
        expect: sh.text,
        off: 0,
        del: sh.text,
        ins: str(x.text, "text"),
      });
      break;
    }
    case "delete_slide": {
      const im = impressOf(m, name);
      const s = num(x.slide, "slide");
      const slide = im.slides[s - 1] ?? fail(`there are ${im.slides.length} slides: no ${s}`);
      push({ t: "delete_slide", at: s - 1, expect: slideKey(slide), snap: snapOf(slide) });
      break;
    }
    default:
      fail(`unknown operation «${name || "?"}» (call canvas_edit with "help": true)`);
  }
  return out;
}

/** The agent's operations (canvas_edit) as actions, each on the outline the one before left. */
export function actionsFromAgent(
  o: OfficeOutline,
  ops: readonly unknown[],
  outlineOf: OutlineOf,
): { actions: OfficePlainAction[] } | { error: string; index: number } {
  let m = o;
  const actions: OfficePlainAction[] = [];
  for (const [index, raw] of ops.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { error: 'each operation is an object like {"op": "replace_text", …}', index };
    try {
      const made = fromAgentOne(m, raw as Record<string, unknown>, outlineOf);
      for (const a of made) m = applyAction(m, a, outlineOf);
      actions.push(...made);
    } catch (err) {
      return { error: (err as Error).message, index };
    }
  }
  if (!actions.length) return { error: "nothing to do", index: 0 };
  return { actions };
}

// ---- words ---------------------------------------------------------------------------------

const quote = (s: string, n = 40) => `«${s.length > n ? `${s.slice(0, n)}…` : s}»`;

/** What a list of actions does, in English, with the page's fields. */
export function describeActions(
  o: OfficeOutline,
  list: readonly OfficeAction[],
): {
  text: string;
  line?: number;
  lines?: number;
  added?: number;
  removed?: number;
  unit: "paragraph" | "slide";
  kind: "insert" | "delete" | "replace" | "edit";
} {
  const flat = list.flatMap((a) => (a.t === "batch" ? a.ops : [a]));
  const unit = o.app === "impress" ? "slide" : "paragraph";
  const where = (a: OfficeAction): number | undefined => {
    switch (a.t) {
      case "text":
        return "item" in a.at ? a.at.item : a.at.slide;
      case "insert_item":
      case "delete_item":
      case "add_slide":
      case "delete_slide":
        return a.at;
      case "para_style":
      case "cell":
        return a.item;
      case "add_shape":
      case "delete_shape":
        return a.slide;
      case "file":
        return a.hunks[0]?.at;
      default:
        return undefined;
    }
  };
  const one = (a: OfficeAction): string => {
    switch (a.t) {
      case "text": {
        const at =
          "item" in a.at
            ? `paragraph ${a.at.item + 1}`
            : `slide ${a.at.slide + 1}, shape ${a.at.shape + 1}`;
        if (a.del === a.expect && a.off === 0) return `set the text of ${at} to ${quote(a.ins)}`;
        if (!a.del) return `wrote ${quote(a.ins)} in ${at}`;
        if (!a.ins) return `deleted ${quote(a.del)} in ${at}`;
        return `replaced ${quote(a.del)} with ${quote(a.ins)} in ${at}`;
      }
      case "insert_item":
        return a.kind === "table"
          ? `inserted a ${a.rows ?? 1}×${a.cols ?? 1} table as item ${a.at + 1}`
          : a.picture
            ? `inserted a picture as item ${a.at + 1}`
            : `inserted paragraph ${a.at + 1}${a.text ? ` ${quote(a.text)}` : ""}${a.style ? ` (${a.style})` : ""}`;
      case "delete_item":
        return a.kind === "table"
          ? `deleted table ${a.at + 1}`
          : `deleted paragraph ${a.at + 1} ${quote(a.expect)}`;
      case "para_style":
        return `set paragraph ${a.item + 1} to the style «${a.style}»`;
      case "cell":
        return `set cell ${a.cell} of table ${a.item + 1} to ${quote(a.text)}`;
      case "add_slide":
        return a.snap
          ? `brought back slide ${a.at + 1}`
          : `added slide ${a.at + 1}${a.title ? ` ${quote(a.title)}` : ""} (${LAYOUT_NAMES[a.layout] ?? a.layout})`;
      case "delete_slide": {
        const lost = a.snap.shapes.filter(
          (s) => ["picture", "chart", "table", "other"].includes(s.kind) && !s.picture,
        ).length;
        return `deleted slide ${a.at + 1}${a.expect ? ` ${quote(a.expect)}` : ""}${lost ? ` (undoing it brings back its texts, not its ${lost} pictures, charts or tables)` : ""}`;
      }
      case "add_shape":
        return `put a picture on slide ${a.slide + 1}`;
      case "delete_shape":
        return `removed shape ${a.shape + 1} of slide ${a.slide + 1}`;
      case "file": {
        const h = a.hunks[0];
        if (!h) return "saved the document (no text changed)";
        const span = Math.max(h.del, h.ins);
        return `edited ${unit === "slide" ? "slides" : "paragraphs"} ${h.at + 1}${span > 1 ? `-${h.at + span}` : ""} in the document`;
      }
      case "batch":
        return `${a.ops.length} changes`;
      case "restore":
        return "went back";
    }
  };
  const at = flat.map(where).filter((v): v is number => v !== undefined);
  const first = at.length ? Math.min(...at) : undefined;
  const last = at.length ? Math.max(...at) : undefined;
  const added = flat.reduce((n, a) => n + (a.t === "text" ? a.ins.length : 0), 0);
  const removed = flat.reduce((n, a) => n + (a.t === "text" ? a.del.length : 0), 0);
  const kindOf = (a: OfficeAction): "insert" | "delete" | "replace" | "edit" =>
    a.t === "insert_item" || a.t === "add_slide" || a.t === "add_shape"
      ? "insert"
      : a.t === "delete_item" || a.t === "delete_slide" || a.t === "delete_shape"
        ? "delete"
        : a.t === "text"
          ? !a.del
            ? "insert"
            : !a.ins
              ? "delete"
              : "replace"
          : "edit";
  const kinds = new Set(flat.map(kindOf));
  const text =
    flat.length === 1
      ? one(flat[0] as OfficeAction)
      : `${flat.length} changes: ${flat.slice(0, 3).map(one).join("; ")}${flat.length > 3 ? "; …" : ""}`;
  const fileSpan =
    flat.length === 1 && flat[0]?.t === "file" && flat[0].hunks[0]
      ? Math.max(1, flat[0].hunks[0].del, flat[0].hunks[0].ins)
      : undefined;
  return {
    text: text.slice(0, 480),
    ...(first !== undefined && {
      line: first + 1,
      lines: fileSpan ?? (last as number) - first + 1,
    }),
    ...(added && { added }),
    ...(removed && { removed }),
    unit,
    kind: kinds.size === 1 ? ([...kinds][0] as "insert") : "edit",
  };
}

/** The outline as the agent reads it (canvas_look view "structure"). */
export function outlineText(
  o: OfficeOutline,
  ask: { fromLine?: number | undefined; toLine?: number | undefined },
): string {
  const cut = (s: string, n = 300) =>
    (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\n/g, " / ");
  const lines: string[] = [];
  let size = 0;
  const add = (l: string) => {
    size += l.length + 1;
    if (size < 60_000) lines.push(l);
  };
  if (o.app === "writer") {
    const from = Math.max(1, ask.fromLine ?? 1);
    const to = Math.min(o.items.length, ask.toLine ?? from + 199);
    add(
      `A text document (LibreOffice Writer): ${o.items.length} items, paragraphs (¶) and tables (T), numbered as canvas_edit uses them${from > 1 || to < o.items.length ? `; items ${from}-${to} here (from_line/to_line for others)` : ""}:`,
    );
    for (let i = from - 1; i < to; i++) {
      const it = o.items[i] as OfficeItem;
      if (it.k === "p")
        add(
          `¶${i + 1} [${it.style}${it.list ? ", list" : ""}]${it.pics ? ` (${it.pics} picture${it.pics > 1 ? "s" : ""})` : ""} ${cut(it.text) || "(empty)"}`,
        );
      else {
        add(`T${i + 1} table «${it.name}» ${it.rows}×${it.cols}:`);
        for (const [r, row] of it.cells.slice(0, 8).entries())
          add(
            `   row ${r + 1}: ${row.map((c, k) => `${cellName(r, k)}=${cut(c, 40)}`).join(" | ")}`,
          );
        if (it.rows > 8) add(`   … ${it.rows - 8} more rows`);
      }
    }
  } else {
    const from = Math.max(1, ask.fromLine ?? 1);
    const to = Math.min(o.slides.length, ask.toLine ?? from + 59);
    add(
      `A presentation (LibreOffice Impress): ${o.slides.length} slides, shapes numbered on each${from > 1 || to < o.slides.length ? `; slides ${from}-${to} here` : ""}:`,
    );
    for (let i = from - 1; i < to; i++) {
      const s = o.slides[i] as OfficeSlide;
      add(
        `Slide ${i + 1}${slideKey(s) ? ` ${quote(slideKey(s), 60)}` : ""} (layout ${LAYOUT_NAMES[s.layout ?? 20] ?? s.layout}):`,
      );
      if (!s.shapes.length) add("   (no shapes)");
      for (const [k, sh] of s.shapes.entries())
        add(
          `   #${k + 1} ${sh.kind}${sh.name ? ` «${sh.name}»` : ""}: ${sh.kind === "picture" || sh.kind === "chart" || sh.kind === "table" ? "" : cut(sh.text) || "(empty)"}`,
        );
    }
  }
  return lines.join("\n");
}

export const OFFICE_CATALOG = `Documents and presentations (.odt, .odp; a .docx, .doc or .rtf is edited on its open copy .odt beside it, a .pptx or .ppt on its .odp: the original stays as it is). LibreOffice applies the operations, in the person's open editor or on the server; ops is a list like [{"op": "replace_text", "find": "…", "text": "…"}]. Numbers are those of canvas_look view "structure" (from 1).
Text documents (items are paragraphs ¶ and tables T):
- replace_text {find, text, all?}: changes a piece of text (also in table cells), keeping its formatting; "find" must appear once unless "all": true.
- insert_paragraph {after: N (0 = at the top; default: at the end), text, style?}: new paragraphs (one per line of text); style like "Heading 1", "Heading 2", "Title", "Text body" (default: the one around).
- set_paragraph {paragraph: N, text}: the whole text of a paragraph.
- delete_paragraph {paragraph: N}
- set_style {paragraph: N, style}
- insert_table {after: N, rows?, cols?, cells?: [["a","b"],["1","2"]]}
- set_cell {table: N, cell: "B2", text}
- delete_table {table: N}
- insert_image {after: N, path: an image of your workspace, width_mm?}
Presentations (slides from 1; shapes as structure numbers them on each slide):
- add_slide {after?: N (0 = before the first; default: at the end), layout?: title | title_content | two_content | title_only | blank, title?, text? (bullets: one per line)}
- set_slide_text {slide: N, shape?: "title" | "body" | "subtitle" | M, text}
- delete_slide {slide: N}
- replace_text {find, text, all?}
- insert_image {slide: N, path, x_mm?, y_mm?, width_mm?}
The person sees each change at once and can undo it; while they type in the document your edits wait a few seconds. Macros never run.`;
