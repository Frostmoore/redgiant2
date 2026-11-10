// The PDF family's actions on the outline (G37.8): pure functions, tested as tables. The host checks
// and applies them on the outline (pages, annotations, fields); the bytes are written later by
// pdf-write.ts. Pages are named by their index (0-based here, 1-based for the agent); an action
// made on an older revision is moved across pages taken out, put back or moved since. Two actions
// on the same annotation, the same field or the same page conflict: never merged in silence.
import type {
  PdfAction,
  PdfAnnot,
  PdfAnnotInfo,
  PdfChangeWords,
  PdfField,
  PdfFieldValue,
  PdfOutline,
  PdfPageInfo,
  PdfPlainAction,
  PdfRect,
  PdfSource,
} from "@redgiant/protocol";
import { newPid } from "./pdf-outline.js";

export const flat = (a: PdfAction): PdfPlainAction[] => (a.t === "batch" ? a.ops : [a]);

const sameValue = (a: PdfFieldValue, b: PdfFieldValue) => JSON.stringify(a) === JSON.stringify(b);
const norm = (deg: number) => (((Math.round(deg / 90) * 90) % 360) + 360) % 360;

export const infoOf = (a: PdfAnnot): PdfAnnotInfo => ({
  id: a.id,
  kind: a.kind,
  rect: a.rect,
  ...(a.text !== undefined && { text: a.text }),
  ...(a.color && { color: a.color }),
  ...(a.author && { author: a.author }),
  data: a,
});

export const intersects = (a: PdfRect, b: PdfRect) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function pageAt(o: PdfOutline, i: number): PdfPageInfo {
  const p = o.pages[i];
  if (!p) throw new Error(`there is no page ${i + 1} (the file has ${o.pages.length})`);
  return p;
}

function findAnnot(o: PdfOutline, id: string): { page: number; index: number } | undefined {
  for (const [page, p] of o.pages.entries()) {
    const index = p.annots.findIndex((a) => a.id === id);
    if (index >= 0) return { page, index };
  }
  return undefined;
}

function withPage(o: PdfOutline, i: number, p: PdfPageInfo): PdfOutline {
  const pages = o.pages.slice();
  pages[i] = p;
  return { ...o, pages };
}

function fieldValueError(f: PdfField, v: PdfFieldValue): string | undefined {
  if (f.readOnly) return `the field «${f.name}» is read-only`;
  switch (f.type) {
    case "text":
      return typeof v === "string" ? undefined : `«${f.name}» takes text`;
    case "checkbox":
      return typeof v === "boolean" ? undefined : `«${f.name}» is a checkbox: true or false`;
    case "radio":
    case "dropdown":
      if (typeof v !== "string") return `«${f.name}» takes one of its choices`;
      return v === "" || !f.options?.length || f.options.includes(v)
        ? undefined
        : `«${v}» is not a choice of «${f.name}» (${(f.options ?? []).join(", ")})`;
    case "list":
      if (!Array.isArray(v)) return `«${f.name}» takes a list of its choices`;
      return v.every((x) => f.options?.includes(x))
        ? undefined
        : `not every value is a choice of «${f.name}» (${(f.options ?? []).join(", ")})`;
    default:
      return `the field «${f.name}» (${f.type}) cannot be filled here`;
  }
}

/** One action on the outline; throws with the reason when it does not fit. */
function applyPlain(o: PdfOutline, a: PdfPlainAction): PdfOutline {
  if (o.encrypted) throw new Error("the PDF is encrypted: it is shown, never written");
  switch (a.t) {
    case "annotate": {
      const p = pageAt(o, a.a.page);
      if (findAnnot(o, a.a.id)) throw new Error(`an annotation «${a.a.id}» is already there`);
      return withPage(o, a.a.page, { ...p, annots: [...p.annots, infoOf(a.a)] });
    }
    case "remove_annotation": {
      const p = pageAt(o, a.page);
      const i = p.annots.findIndex((x) => x.id === a.id);
      if (i < 0) throw new Error(`there is no annotation «${a.id}» on page ${a.page + 1}`);
      return withPage(o, a.page, { ...p, annots: p.annots.filter((_, k) => k !== i) });
    }
    case "restore_annotation": {
      const p = pageAt(o, a.page);
      if (findAnnot(o, a.id)) throw new Error(`the annotation «${a.id}» is already there`);
      return withPage(o, a.page, { ...p, annots: [...p.annots, a.info] });
    }
    case "fill_field": {
      const i = o.fields.findIndex((f) => f.name === a.name);
      const f = o.fields[i];
      if (!f) throw new Error(`there is no field «${a.name}»`);
      const bad = fieldValueError(f, a.value);
      if (bad) throw new Error(bad);
      if (!sameValue(f.value, a.before))
        throw new Error(
          `the field «${a.name}» changed meanwhile (it is ${JSON.stringify(f.value)})`,
        );
      const fields = o.fields.slice();
      fields[i] = { ...f, value: a.value };
      return { ...o, fields };
    }
    case "rotate_page": {
      const p = pageAt(o, a.page);
      if (norm(p.rotate) !== norm(a.before))
        throw new Error(`page ${a.page + 1} is turned ${p.rotate}° now, not ${a.before}°`);
      return withPage(o, a.page, { ...p, rotate: norm(a.to) });
    }
    case "delete_page": {
      const p = pageAt(o, a.page);
      if (o.pages.length < 2) throw new Error("the last page of a PDF cannot be taken out");
      if (Math.abs(p.w - a.info.w) > 1 || Math.abs(p.h - a.info.h) > 1)
        throw new Error(`page ${a.page + 1} is not the one expected`);
      return { ...o, pages: o.pages.filter((_, i) => i !== a.page) };
    }
    case "restore_page": {
      if (a.at > o.pages.length) throw new Error(`a page cannot go to ${a.at + 1}`);
      const pages = o.pages.slice();
      const info = o.pages.some((p) => p.pid === a.info.pid)
        ? { ...a.info, pid: newPid() }
        : a.info;
      pages.splice(a.at, 0, info);
      return { ...o, pages };
    }
    case "move_page": {
      pageAt(o, a.from);
      if (a.to >= o.pages.length) throw new Error(`there is no page ${a.to + 1} to move to`);
      if (a.from === a.to) throw new Error("the page is already there");
      const pages = o.pages.slice();
      const [p] = pages.splice(a.from, 1);
      pages.splice(a.to, 0, p as PdfPageInfo);
      return { ...o, pages };
    }
    case "redact": {
      const p = pageAt(o, a.page);
      if (o.signed) throw new Error("the PDF is signed: redacting would break its signature");
      return withPage(o, a.page, {
        ...p,
        annots: p.annots.filter((x) => !a.rects.some((r) => intersects(x.rect, r))),
        redacted: (p.redacted ?? 0) + a.rects.length,
      });
    }
    case "unredact": {
      pageAt(o, a.page);
      return withPage(o, a.page, a.info);
    }
  }
}

export function applyAction(o: PdfOutline, a: PdfAction): PdfOutline {
  let out = o;
  for (const x of flat(a)) out = applyPlain(out, x);
  return out;
}

export function checkAction(o: PdfOutline, a: PdfAction): string | undefined {
  try {
    applyAction(o, a);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * What brings an action back, on the outline before it. Taking a page out and redacting keep the
 * file they started from (`source`: the bytes and the actions before), from which the page comes
 * back.
 */
export function invertAction(
  o: PdfOutline,
  a: PdfAction,
  source: (before: PdfPlainAction[]) => PdfSource,
): PdfAction {
  const list = flat(a);
  const inv: PdfPlainAction[] = [];
  let cur = o;
  for (const [k, x] of list.entries()) {
    inv.unshift(invertPlain(cur, x, () => source(list.slice(0, k))));
    cur = applyPlain(cur, x);
  }
  return inv.length === 1 ? (inv[0] as PdfPlainAction) : { t: "batch", ops: inv };
}

function invertPlain(o: PdfOutline, a: PdfPlainAction, source: () => PdfSource): PdfPlainAction {
  switch (a.t) {
    case "annotate":
      return { t: "remove_annotation", page: a.a.page, id: a.a.id, info: infoOf(a.a) };
    case "remove_annotation": {
      if (a.info.data) return { t: "annotate", a: { ...a.info.data, page: a.page } };
      if (a.info.ref) return { t: "restore_annotation", page: a.page, id: a.id, info: a.info };
      throw new Error(`the annotation «${a.id}» could not be brought back`);
    }
    case "restore_annotation":
      return { t: "remove_annotation", page: a.page, id: a.id, info: a.info };
    case "fill_field":
      return { t: "fill_field", name: a.name, value: a.before, before: a.value };
    case "rotate_page":
      return { t: "rotate_page", page: a.page, to: a.before, before: a.to };
    case "delete_page":
      return {
        t: "restore_page",
        at: a.page,
        info: pageAt(o, a.page),
        source: source(),
        index: a.page,
      };
    case "restore_page":
      return { t: "delete_page", page: a.at, info: a.info };
    case "move_page":
      return { t: "move_page", from: a.to, to: a.from };
    case "redact":
      return {
        t: "unredact",
        page: a.page,
        rects: a.rects,
        info: pageAt(o, a.page),
        source: source(),
        index: a.page,
      };
    case "unredact":
      return { t: "redact", page: a.page, rects: a.rects, info: pageAt(o, a.page) };
  }
}

export function composeActions(list: readonly PdfAction[]): PdfAction | undefined {
  const ops = list.flatMap(flat);
  if (!ops.length) return undefined;
  return ops.length === 1 ? ops[0] : { t: "batch", ops };
}

// ---- conflicts and rebasing --------------------------------------------------------------------

/** Whether an action changes the pages' order or number. */
const structural = (a: PdfPlainAction) =>
  a.t === "delete_page" || a.t === "restore_page" || a.t === "move_page";

interface Touch {
  annots: Set<string>;
  fields: Set<string>;
  /** Pages changed as a whole (turned, taken out, redacted…). */
  pages: Set<number>;
  /** Pages an annotation was put on or taken from. */
  on: Set<number>;
  structure: boolean;
}

function touchOf(list: PdfPlainAction[]): Touch {
  const t: Touch = {
    annots: new Set(),
    fields: new Set(),
    pages: new Set(),
    on: new Set(),
    structure: false,
  };
  for (const a of list) {
    if (structural(a)) t.structure = true;
    switch (a.t) {
      case "annotate":
        t.annots.add(a.a.id);
        t.on.add(a.a.page);
        break;
      case "remove_annotation":
      case "restore_annotation":
        t.annots.add(a.id);
        t.on.add(a.page);
        break;
      case "fill_field":
        t.fields.add(a.name);
        break;
      case "rotate_page":
      case "delete_page":
      case "redact":
      case "unredact":
        t.pages.add(a.page);
        break;
      case "restore_page":
        t.pages.add(a.at);
        break;
      case "move_page":
        t.pages.add(a.from);
        t.pages.add(a.to);
        break;
    }
  }
  return t;
}

const meets = <T>(a: Set<T>, b: Set<T>) => [...a].some((x) => b.has(x));

/** Whether `a` and `b`, made on the same outline, touch the same annotation, field or page. */
export function actionsConflict(a: PdfAction, b: PdfAction): boolean {
  const x = touchOf(flat(a));
  const y = touchOf(flat(b));
  if (meets(x.annots, y.annots) || meets(x.fields, y.fields)) return true;
  if (meets(x.pages, y.pages) || meets(x.pages, y.on) || meets(x.on, y.pages)) return true;
  // Two changes of the pages' order are never merged.
  return x.structure && y.structure;
}

/** A page index of the outline before `b`, in the outline after it (undefined: the page went). */
export function mapIndex(i: number, b: PdfAction): number | undefined {
  let at: number | undefined = i;
  for (const x of flat(b)) {
    if (at === undefined) return undefined;
    if (x.t === "delete_page") at = at === x.page ? undefined : at > x.page ? at - 1 : at;
    else if (x.t === "restore_page") at = at >= x.at ? at + 1 : at;
    else if (x.t === "move_page") {
      if (at === x.from) at = x.to;
      else if (x.from < x.to && at > x.from && at <= x.to) at -= 1;
      else if (x.from > x.to && at >= x.to && at < x.from) at += 1;
    }
  }
  return at;
}

/** `a`, made on the same outline as `b`, moved to apply after it. */
export function mapAction(a: PdfAction, b: PdfAction): PdfAction {
  const m = (i: number) => {
    const j = mapIndex(i, b);
    if (j === undefined) throw new Error(`page ${i + 1} is not there anymore`);
    return j;
  };
  const one = (x: PdfPlainAction): PdfPlainAction => {
    switch (x.t) {
      case "annotate":
        return { ...x, a: { ...x.a, page: m(x.a.page) } };
      case "remove_annotation":
      case "restore_annotation":
      case "rotate_page":
      case "delete_page":
      case "redact":
      case "unredact":
        return { ...x, page: m(x.page) };
      case "restore_page":
        // It goes back after the page that was before it.
        return x.at === 0 ? x : { ...x, at: m(x.at - 1) + 1 };
      case "move_page":
        return { ...x, from: m(x.from), to: m(x.to) };
      case "fill_field":
        return x;
    }
  };
  const list = flat(a).map(one);
  return list.length === 1 ? (list[0] as PdfPlainAction) : { t: "batch", ops: list };
}

// ---- words -------------------------------------------------------------------------------------

const KIND_WORDS: Record<string, string> = {
  highlight: "Highlighted text",
  underline: "Underlined text",
  strikeout: "Struck out text",
  freetext: "Wrote a text box",
  ink: "Drew",
  note: "Added a note",
  square: "Drew a box",
  stamp: "Put a picture",
  signature: "Signed",
};

/** What a batch does, in English for the agent and the log, and in parts for the page's words. */
export function describeActions(
  _o: PdfOutline,
  list: readonly PdfAction[],
): { text: string; kind: "insert" | "delete" | "replace" | "edit"; words: PdfChangeWords } {
  const ops = list.flatMap(flat);
  const first = ops[0];
  if (!first) return { text: "nothing", kind: "edit", words: { action: "other" } };
  if (ops.length > 1 && !ops.every((x) => x.t === first.t))
    return {
      text: `${ops.length} changes`,
      kind: "edit",
      words: { action: "other", n: ops.length },
    };
  const n = ops.length;
  switch (first.t) {
    case "annotate": {
      const k = first.a.kind;
      const all = ops.every((x) => x.t === "annotate" && x.a.kind === k);
      const page = first.a.page + 1;
      return {
        text:
          n > 1
            ? `Added ${n} annotations${all ? ` (${k})` : ""} from page ${page}`
            : `${KIND_WORDS[k] ?? "Annotated"} on page ${page}`,
        kind: "insert",
        words: { action: "annotate", page, ...(all && { kind: k }), ...(n > 1 && { n }) },
      };
    }
    case "remove_annotation":
    case "restore_annotation": {
      const page = first.page + 1;
      const back = first.t === "restore_annotation";
      return {
        text: back
          ? `Put back ${n > 1 ? `${n} annotations` : "an annotation"} on page ${page}`
          : `Removed ${n > 1 ? `${n} annotations` : `the ${first.info.kind} annotation`} on page ${page}`,
        kind: back ? "insert" : "delete",
        words: {
          action: back ? "annotate" : "remove_annotation",
          page,
          kind: first.info.kind,
          ...(n > 1 && { n }),
        },
      };
    }
    case "fill_field": {
      const shown = (v: PdfFieldValue) =>
        typeof v === "boolean" ? (v ? "checked" : "unchecked") : JSON.stringify(v).slice(0, 80);
      return {
        text:
          n > 1
            ? `Filled ${n} fields`
            : `Filled the field «${first.name.slice(0, 80)}» with ${shown(first.value)}`,
        kind: "replace",
        words: { action: "fill_field", field: first.name.slice(0, 200), ...(n > 1 && { n }) },
      };
    }
    case "rotate_page":
      return {
        text: n > 1 ? `Turned ${n} pages` : `Turned page ${first.page + 1} to ${norm(first.to)}°`,
        kind: "edit",
        words: {
          action: "rotate_page",
          page: first.page + 1,
          to: norm(first.to),
          ...(n > 1 && { n }),
        },
      };
    case "delete_page":
      return {
        text:
          n > 1
            ? `Took out ${n} pages (the file is written anew, the version before is kept)`
            : `Took out page ${first.page + 1} (the file is written anew, the version before is kept)`,
        kind: "delete",
        words: { action: "delete_page", page: first.page + 1, ...(n > 1 && { n }) },
      };
    case "restore_page":
      return {
        text: n > 1 ? `Put back ${n} pages` : `Put back page ${first.at + 1}`,
        kind: "insert",
        words: { action: "restore_page", page: first.at + 1, ...(n > 1 && { n }) },
      };
    case "move_page":
      return {
        text:
          n > 1 ? `Moved ${n} pages` : `Moved page ${first.from + 1} to position ${first.to + 1}`,
        kind: "edit",
        words: { action: "move_page", page: first.from + 1, to: first.to + 1, ...(n > 1 && { n }) },
      };
    case "redact": {
      const areas = ops.reduce((s, x) => s + (x.t === "redact" ? x.rects.length : 0), 0);
      return {
        text: `Redacted ${areas} area${areas === 1 ? "" : "s"} on page ${first.page + 1}: what was under them is gone from the file`,
        kind: "delete",
        words: { action: "redact", page: first.page + 1, n: areas },
      };
    }
    case "unredact":
      return {
        text: `Brought back page ${first.page + 1} as it was before the redaction`,
        kind: "insert",
        words: { action: "unredact", page: first.page + 1 },
      };
  }
}

// ---- the agent's words -------------------------------------------------------------------------

export const PDF_CATALOG = `PDF operations (canvas_edit "ops"). Pages count from 1. Coordinates are PDF points from the page's bottom left corner, before the page's rotation; canvas_look with view "structure" gives the pages' sizes, the text lines with their boxes, the annotations (with ids) and the form fields with their values.
- {"op":"annotate","page":2,"kind":"highlight","find":"words on the page"} — highlight, underline or strikeout: the words are found on the page (every match; "match":2 for one), or give "rect":[x1,y1,x2,y2].
- {"op":"annotate","page":1,"kind":"freetext","rect":[x1,y1,x2,y2],"text":"…","size":12,"color":"#d00000"} — a text box ("at":[x,y] instead of rect sizes it to the text).
- {"op":"annotate","page":1,"kind":"note","at":[x,y],"text":"…"} — a sticky note.
- {"op":"annotate","page":1,"kind":"ink","paths":[[x,y,x,y,…],…],"color":"blue","size":2} — a drawing; "square" with "rect" draws a box.
- {"op":"remove_annotation","id":"…"} — any annotation of the structure.
- {"op":"fill_field","name":"…","value":"…"} — text fields take text, checkboxes true/false, radio buttons and dropdowns one of their choices, lists an array of choices.
- {"op":"rotate_page","page":3,"by":90} — 90, 180 or 270 (clockwise); or "to":0.
- {"op":"delete_page","page":3} and {"op":"move_page","page":3,"to":1} — the file is written anew (no incremental update); the version before is kept and the panel «Modifiche» can undo it.
- {"op":"sign","page":1,"rect":[x1,y1,x2,y2],"image":"path/firma.png"} — a signature picture (PNG or JPEG of the workspace); {"op":"stamp",…} the same for any picture. Not a digital signature.
- {"op":"redact","page":1,"find":"words"} or "rects":[[x1,y1,x2,y2],…] — removes for good the text, pictures and drawings under the areas, then blacks them. The person is always asked first. Refused when it cannot be checked that nothing is left under the areas.
Colors: yellow, green, blue, pink, red, orange, purple, black, or "#rrggbb". Annotations are written as an incremental update (the original bytes stay at the head of the file).`;

const COLORS: Record<string, [number, number, number]> = {
  yellow: [1, 0.92, 0.23],
  green: [0.33, 0.85, 0.45],
  blue: [0.2, 0.45, 0.95],
  pink: [1, 0.6, 0.8],
  red: [0.86, 0.1, 0.1],
  orange: [1, 0.6, 0.1],
  purple: [0.6, 0.3, 0.85],
  black: [0, 0, 0],
};

export function colorFrom(
  v: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (typeof v !== "string") return fallback;
  const named = COLORS[v.toLowerCase()];
  if (named) return named;
  const m = v.match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`«${v}» is not a colour (a name or #rrggbb)`);
  const n = Number.parseInt(m[1] as string, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const isRect = (v: unknown): v is PdfRect =>
  Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number" && Number.isFinite(x));
export const normRect = (r: PdfRect): PdfRect => [
  Math.min(r[0], r[2]),
  Math.min(r[1], r[3]),
  Math.max(r[0], r[2]),
  Math.max(r[1], r[3]),
];

/** What the agent's operations need from the file itself. */
export interface AgentHelp {
  /** The words on a page (0-based): one box per line of each match, as quads and rects. */
  find(
    page: number,
    words: string,
    o?: { exact?: boolean },
  ): Promise<{ quads: number[]; rects: PdfRect[] }[]>;
  /** An id for a new annotation. */
  newId(): string;
  /** The agent's name, written as the annotation's author. */
  author?: string;
}

const quadOf = (r: PdfRect) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]];

/** The agent's plain operations as actions, applied one after the other on the outline. */
export async function actionsFromAgent(
  o: PdfOutline,
  raw: readonly unknown[],
  help: AgentHelp,
): Promise<{ actions: PdfPlainAction[] } | { error: string; index: number }> {
  const out: PdfPlainAction[] = [];
  let cur = o;
  for (const [index, r] of raw.entries()) {
    try {
      const made = await oneFromAgent(cur, r as Record<string, unknown>, help);
      for (const a of made) {
        cur = applyPlain(cur, a);
        out.push(a);
      }
    } catch (err) {
      return { error: (err as Error).message, index };
    }
  }
  return { actions: out };
}

function pageIndex(o: PdfOutline, v: unknown, what = "page"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > o.pages.length)
    throw new Error(`give "${what}" from 1 to ${o.pages.length}`);
  return n - 1;
}

async function oneFromAgent(
  o: PdfOutline,
  x: Record<string, unknown>,
  help: AgentHelp,
): Promise<PdfPlainAction[]> {
  const name = String(x?.op ?? x?.action ?? x?.type ?? "").toLowerCase();
  const author = help.author ? { author: help.author } : {};
  switch (name) {
    case "annotate":
    case "highlight":
    case "underline":
    case "strikeout":
    case "note":
    case "freetext":
    case "ink":
    case "square": {
      const kind = String(name === "annotate" ? (x.kind ?? "") : name).toLowerCase();
      const page = pageIndex(o, x.page);
      const text = typeof x.text === "string" ? x.text.slice(0, 20_000) : undefined;
      const size = typeof x.size === "number" ? Math.max(0.5, Math.min(144, x.size)) : undefined;
      if (kind === "highlight" || kind === "underline" || kind === "strikeout") {
        const color = colorFrom(x.color, kind === "highlight" ? [1, 0.92, 0.23] : [0.86, 0.1, 0.1]);
        let found: { quads: number[]; rects: PdfRect[] }[];
        if (typeof x.find === "string" && x.find.trim()) {
          found = await help.find(page, x.find);
          if (!found.length) throw new Error(`«${x.find}» is not on page ${page + 1}`);
          if (x.match !== undefined) {
            const m = found[Number(x.match) - 1];
            if (!m) throw new Error(`there are ${found.length} matches of «${x.find}»`);
            found = [m];
          }
        } else if (isRect(x.rect)) {
          const r = normRect(x.rect);
          found = [{ quads: quadOf(r), rects: [r] }];
        } else throw new Error(`give "find" (words on the page) or "rect" for ${kind}`);
        return found.map((f) => ({
          t: "annotate" as const,
          a: {
            id: help.newId(),
            page,
            kind: kind as "highlight",
            rect: bounds(f.rects),
            quads: f.quads,
            color,
            ...(text && { text }),
            ...author,
          },
        }));
      }
      if (kind === "freetext") {
        if (!text) throw new Error('give the "text" of the text box');
        const fs = size ?? 12;
        let rect: PdfRect;
        if (isRect(x.rect)) rect = normRect(x.rect);
        else if (Array.isArray(x.at) && x.at.length === 2) {
          const [ax, ay] = x.at as [number, number];
          const lines = text.split("\n");
          const w = Math.max(...lines.map((l) => l.length)) * fs * 0.55 + 6;
          rect = [ax, ay - lines.length * fs * 1.2 - 4, ax + w, ay];
        } else throw new Error('give "rect" or "at" for the text box');
        return [
          {
            t: "annotate",
            a: {
              id: help.newId(),
              page,
              kind: "freetext",
              rect,
              text,
              size: fs,
              color: colorFrom(x.color, [0, 0, 0]),
              ...author,
            },
          },
        ];
      }
      if (kind === "note") {
        let at: [number, number];
        if (Array.isArray(x.at) && x.at.length === 2) at = x.at as [number, number];
        else if (isRect(x.rect)) at = [x.rect[0], x.rect[3]];
        else throw new Error('give "at":[x,y] for the note');
        return [
          {
            t: "annotate",
            a: {
              id: help.newId(),
              page,
              kind: "note",
              rect: [at[0], at[1] - 20, at[0] + 20, at[1]],
              text: text ?? "",
              color: colorFrom(x.color, [1, 0.85, 0.2]),
              ...author,
            },
          },
        ];
      }
      if (kind === "ink") {
        const paths = Array.isArray(x.paths) ? (x.paths as unknown[]) : [];
        const clean = paths
          .filter((p): p is number[] => Array.isArray(p) && p.length >= 4 && p.length % 2 === 0)
          .map((p) => p.map(Number))
          .filter((p) => p.every(Number.isFinite));
        if (!clean.length) throw new Error('give "paths": [[x,y,x,y,…], …]');
        const w = size ?? 2;
        return [
          {
            t: "annotate",
            a: {
              id: help.newId(),
              page,
              kind: "ink",
              rect: pathBounds(clean, w),
              paths: clean,
              size: w,
              color: colorFrom(x.color, [0.2, 0.45, 0.95]),
              ...author,
            },
          },
        ];
      }
      if (kind === "square") {
        if (!isRect(x.rect)) throw new Error('give "rect" for the box');
        return [
          {
            t: "annotate",
            a: {
              id: help.newId(),
              page,
              kind: "square",
              rect: normRect(x.rect),
              size: size ?? 1.5,
              color: colorFrom(x.color, [0.86, 0.1, 0.1]),
              ...(text && { text }),
              ...author,
            },
          },
        ];
      }
      throw new Error(
        `«${kind}» is not an annotation kind (highlight, underline, strikeout, freetext, note, ink, square)`,
      );
    }
    case "remove_annotation":
    case "delete_annotation": {
      const id = String(x.id ?? "");
      const at = findAnnot(o, id);
      if (!at)
        throw new Error(`there is no annotation «${id}» (canvas_look view "structure" lists them)`);
      const info = o.pages[at.page]?.annots[at.index] as PdfAnnotInfo;
      if (!info.ref && !info.data) throw new Error(`the annotation «${id}» cannot be removed here`);
      return [{ t: "remove_annotation", page: at.page, id, info }];
    }
    case "fill_field":
    case "fill": {
      const f = o.fields.find((y) => y.name === x.name);
      if (!f) throw new Error(`there is no field «${String(x.name)}»`);
      let value = x.value as PdfFieldValue;
      if (f.type === "checkbox" && typeof value === "string")
        value = !/^(false|no|off|0|)$/i.test(value);
      if (f.type === "text" && typeof value === "number") value = String(value);
      if (value === undefined) throw new Error('give the "value"');
      return [{ t: "fill_field", name: f.name, value, before: f.value }];
    }
    case "rotate_page":
    case "rotate": {
      const page = pageIndex(o, x.page);
      const before = o.pages[page]?.rotate ?? 0;
      let to: number;
      if (x.to !== undefined) to = Number(x.to);
      else to = before + Number(x.by ?? x.angle ?? 90);
      if (!Number.isFinite(to) || Math.round(to) % 90 !== 0)
        throw new Error("a page turns by 90, 180 or 270 degrees");
      return [{ t: "rotate_page", page, to: norm(to), before }];
    }
    case "delete_page": {
      const page = pageIndex(o, x.page);
      return [{ t: "delete_page", page, info: o.pages[page] as PdfPageInfo }];
    }
    case "move_page": {
      const from = pageIndex(o, x.page ?? x.from);
      const to = pageIndex(o, x.to, "to");
      return [{ t: "move_page", from, to }];
    }
    case "sign":
    case "stamp": {
      const page = pageIndex(o, x.page);
      if (!isRect(x.rect)) throw new Error('give "rect":[x1,y1,x2,y2] where it goes');
      const img = x.picture as { blob?: string; mime?: string } | undefined;
      if (!img?.blob) throw new Error('give "image": the path of a PNG or JPEG in your workspace');
      return [
        {
          t: "annotate",
          a: {
            id: help.newId(),
            page,
            kind: name === "sign" ? "signature" : "stamp",
            rect: normRect(x.rect),
            image: { blob: img.blob, mime: img.mime === "image/jpeg" ? "image/jpeg" : "image/png" },
            ...author,
          },
        },
      ];
    }
    case "redact": {
      const page = pageIndex(o, x.page);
      let rects: PdfRect[] = [];
      if (typeof x.find === "string" && x.find.trim()) {
        // Their glyphs' own boxes, never a place guessed (p3.5.4).
        const found = await help.find(page, x.find, { exact: true });
        if (!found.length) throw new Error(`«${x.find}» is not on page ${page + 1}`);
        rects = found.flatMap((f) => f.rects).map((r) => pad(r, 0.5));
      }
      if (isRect(x.rect)) rects.push(normRect(x.rect));
      if (Array.isArray(x.rects)) for (const r of x.rects) if (isRect(r)) rects.push(normRect(r));
      if (!rects.length) throw new Error('give "find" (words) or "rects" for the areas to redact');
      return [{ t: "redact", page, rects, info: o.pages[page] as PdfPageInfo }];
    }
    default:
      throw new Error(
        `«${name}» is not a PDF operation (annotate, remove_annotation, fill_field, rotate_page, delete_page, move_page, sign, stamp, redact): call with "help": true`,
      );
  }
}

export const pad = (r: PdfRect, d: number): PdfRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

export function bounds(rects: PdfRect[]): PdfRect {
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ];
}

export function pathBounds(paths: number[][], w: number): PdfRect {
  let x1 = Number.POSITIVE_INFINITY;
  let y1 = Number.POSITIVE_INFINITY;
  let x2 = Number.NEGATIVE_INFINITY;
  let y2 = Number.NEGATIVE_INFINITY;
  for (const p of paths)
    for (let i = 0; i + 1 < p.length; i += 2) {
      x1 = Math.min(x1, p[i] as number);
      x2 = Math.max(x2, p[i] as number);
      y1 = Math.min(y1, p[i + 1] as number);
      y2 = Math.max(y2, p[i + 1] as number);
    }
  return [x1 - w, y1 - w, x2 + w, y2 + w];
}

// ---- the agent's view --------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
const rectText = (r: PdfRect) => `[${r.map(r1).join(" ")}]`;
const valueText = (v: PdfFieldValue) => (typeof v === "boolean" ? String(v) : JSON.stringify(v));

/** The outline as the agent reads it, with the text lines of some pages. */
export function outlineText(
  o: PdfOutline,
  lines: Map<number, { text: string; rect: PdfRect }[]>,
): string {
  const out: string[] = [];
  out.push(
    `PDF, ${o.pages.length} page${o.pages.length === 1 ? "" : "s"}${o.encrypted ? " (encrypted: shown, never written)" : ""}${o.signed ? " (digitally signed: any change breaks the signature)" : ""}.`,
  );
  for (const [i, p] of o.pages.entries()) {
    out.push(
      `Page ${i + 1}: ${r1(p.w)} × ${r1(p.h)} pt${p.rotate ? `, turned ${p.rotate}°` : ""}${p.annots.length ? `, ${p.annots.length} annotation${p.annots.length === 1 ? "" : "s"}` : ""}${p.redacted ? `, ${p.redacted} redacted area${p.redacted === 1 ? "" : "s"}` : ""}`,
    );
    for (const a of p.annots.slice(0, 200))
      out.push(
        `  - ${a.id}: ${a.kind} ${rectText(a.rect)}${a.text ? ` «${a.text.slice(0, 120).replace(/\n/g, " ")}»` : ""}${a.author ? ` by ${a.author}` : ""}`,
      );
    const ls = lines.get(i);
    if (ls) {
      out.push(`  Text lines (box, text):`);
      for (const l of ls.slice(0, 400)) out.push(`    ${rectText(l.rect)} ${l.text.slice(0, 200)}`);
      if (ls.length > 400) out.push(`    … ${ls.length - 400} more lines`);
    }
  }
  if (o.fields.length) {
    out.push(`Form fields (${o.fields.length}):`);
    const pageOf = new Map(o.pages.map((p, i) => [p.pid, i + 1]));
    for (const f of o.fields.slice(0, 500)) {
      const pg = f.pid ? pageOf.get(f.pid) : undefined;
      out.push(
        `  - «${f.name}» ${f.type}${f.options?.length ? ` (${f.options.slice(0, 30).join(" | ")})` : ""}${pg ? `, page ${pg}` : ""}${f.readOnly ? ", read-only" : ""} = ${valueText(f.value)}`,
      );
    }
  }
  if (lines.size === 0)
    out.push(
      'The text lines of pages: canvas_look view "structure" with from_line/to_line as page numbers.',
    );
  return out.join("\n");
}
