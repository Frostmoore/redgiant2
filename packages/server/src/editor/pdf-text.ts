// The words of a PDF's pages for the agent (G37.8): the lines with their boxes (canvas_look
// "structure") and where some words are (an agent highlights or redacts by the words, not by
// coordinates). pdf.js reads the text, as in the page; a word's place inside a run of text is
// taken in proportion to its characters, enough for a highlight. A redaction found by words is
// checked afterwards on the written file (pdf-redact.ts).
import type { PdfRect } from "@redgiant/protocol";
import { pdfjs } from "./pdf-redact.js";

interface Item {
  str: string;
  /** The run's origin, its direction and its up vector, its width and height. */
  x: number;
  y: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  eol: boolean;
}

async function itemsOf(bytes: Uint8Array, pages: number[]): Promise<Map<number, Item[]>> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
  });
  const out = new Map<number, Item[]>();
  try {
    const doc = await task.promise;
    for (const p of pages) {
      if (p < 0 || p >= doc.numPages) continue;
      const page = await doc.getPage(p + 1);
      const tc = await page.getTextContent();
      const items: Item[] = [];
      for (const it of tc.items) {
        if (!("str" in it)) continue;
        const [a, b, c, d, e, f] = it.transform as number[] as [
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        const len = Math.hypot(a, b) || 1;
        const up = Math.hypot(c, d) || 1;
        items.push({
          str: it.str,
          x: e,
          y: f,
          ux: a / len,
          uy: b / len,
          vx: c / up,
          vy: d / up,
          w: it.width,
          h: it.height || up,
          eol: !!it.hasEOL,
        });
      }
      out.set(p, items);
      page.cleanup();
    }
  } finally {
    await task.destroy().catch(() => {});
  }
  return out;
}

/** The box of characters [from, to) of a run. */
function partBox(it: Item, from: number, to: number): { rect: PdfRect; quad: number[] } {
  const n = Math.max(1, it.str.length);
  const s0 = (it.w * from) / n;
  const s1 = (it.w * to) / n;
  const lo = -0.2 * it.h;
  const hi = 0.85 * it.h;
  const pt = (s: number, t: number): [number, number] => [
    it.x + it.ux * s + it.vx * t,
    it.y + it.uy * s + it.vy * t,
  ];
  const tl = pt(s0, hi);
  const tr = pt(s1, hi);
  const bl = pt(s0, lo);
  const br = pt(s1, lo);
  const xs = [tl[0], tr[0], bl[0], br[0]];
  const ys = [tl[1], tr[1], bl[1], br[1]];
  return {
    rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    quad: [...tl, ...tr, ...bl, ...br],
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The text lines of some pages (0-based), each with its box. */
export async function pageLines(
  bytes: Uint8Array,
  pages: number[],
): Promise<Map<number, { text: string; rect: PdfRect }[]>> {
  const all = await itemsOf(bytes, pages);
  const out = new Map<number, { text: string; rect: PdfRect }[]>();
  for (const [p, items] of all) {
    const lines: { text: string; rect: PdfRect }[] = [];
    let cur: { text: string; rect: PdfRect } | undefined;
    for (const it of items) {
      if (!it.str && !it.eol) continue;
      const b = it.str ? partBox(it, 0, it.str.length).rect : undefined;
      if (b) {
        if (cur && Math.abs((cur.rect[1] + cur.rect[3]) / 2 - (b[1] + b[3]) / 2) < it.h * 0.5) {
          cur.text += it.str;
          cur.rect = [
            Math.min(cur.rect[0], b[0]),
            Math.min(cur.rect[1], b[1]),
            Math.max(cur.rect[2], b[2]),
            Math.max(cur.rect[3], b[3]),
          ];
        } else {
          if (cur?.text.trim()) lines.push(cur);
          cur = { text: it.str, rect: b };
        }
      }
      if (it.eol && cur) {
        if (cur.text.trim()) lines.push(cur);
        cur = undefined;
      }
    }
    if (cur?.text.trim()) lines.push(cur);
    out.set(
      p,
      lines.map((l) => ({
        text: l.text.replace(/\s+/g, " ").trim(),
        rect: l.rect.map(r1) as PdfRect,
      })),
    );
  }
  return out;
}

/**
 * Where the words are on a page (0-based): every match, one quadrilateral and box per run of
 * text it covers. Case and runs of white space do not count.
 */
export async function findWords(
  bytes: Uint8Array,
  page: number,
  words: string,
): Promise<{ quads: number[]; rects: PdfRect[] }[]> {
  const items = (await itemsOf(bytes, [page])).get(page) ?? [];
  // The page's text, character by character, each with its run and place in it.
  const chars: { c: string; item: number; at: number }[] = [];
  items.forEach((it, k) => {
    for (let i = 0; i < it.str.length; i++) chars.push({ c: it.str[i] as string, item: k, at: i });
    chars.push({ c: " ", item: -1, at: 0 });
  });
  // White space collapsed on both sides.
  const kept: { c: string; item: number; at: number }[] = [];
  for (const ch of chars) {
    const space = /\s/.test(ch.c);
    if (space && (!kept.length || kept.at(-1)?.c === " ")) continue;
    kept.push(space ? { ...ch, c: " " } : ch);
  }
  const text = kept.map((k) => k.c.toLowerCase()).join("");
  const want = words.trim().replace(/\s+/g, " ").toLowerCase();
  if (!want) return [];
  const out: { quads: number[]; rects: PdfRect[] }[] = [];
  for (let i = text.indexOf(want); i >= 0 && out.length < 500; i = text.indexOf(want, i + 1)) {
    const span = kept.slice(i, i + want.length).filter((k) => k.item >= 0);
    const byItem = new Map<number, { from: number; to: number }>();
    for (const k of span) {
      const r = byItem.get(k.item);
      if (r) {
        r.from = Math.min(r.from, k.at);
        r.to = Math.max(r.to, k.at + 1);
      } else byItem.set(k.item, { from: k.at, to: k.at + 1 });
    }
    const quads: number[] = [];
    const rects: PdfRect[] = [];
    for (const [k, r] of byItem) {
      const b = partBox(items[k] as Item, r.from, r.to);
      quads.push(...b.quad.map(r1));
      rects.push(b.rect.map(r1) as PdfRect);
    }
    if (rects.length) out.push({ quads, rects });
  }
  return out;
}
