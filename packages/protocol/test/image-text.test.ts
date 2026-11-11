// Text layers' pure part (p3.5.8): the TrueType reader, the lines (point text, paragraph text
// wrapped in its box, alignment, CSS's half leading), the pixels the page and the server share
// (the same text gives the same bytes; turned, coloured; nothing for blanks), the box's offset
// from the layer, scaling, and the OpenRaster attributes read back.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT,
  type Font,
  ImageLayerInfo,
  type ImageText,
  layoutText,
  readTrueType,
  renderText,
  scaledText,
  TEXT_FONT_FILES,
  TEXT_FONTS,
  textAttrs,
  textFontFile,
  textIndexAt,
  textLayer,
  textOfAttrs,
  textOrigin,
  textPointIn,
} from "../src/index.js";

// pdf.js carries Liberation Sans for the server; the page gets the same files from it.
const fontsDir = join(
  dirname(
    createRequire(new URL("../../server/package.json", import.meta.url)).resolve(
      "pdfjs-dist/package.json",
    ),
  ),
  "standard_fonts",
);
// The others are the server's own (packages/server/fonts).
const ownDir = fileURLToPath(new URL("../../server/fonts/", import.meta.url));
const fonts = new Map<string, Font>();
const bytesOf = (file: string) =>
  new Uint8Array(
    readFileSync(existsSync(join(ownDir, file)) ? join(ownDir, file) : join(fontsDir, file)),
  );
const fontOf = (t: Pick<ImageText, "font" | "bold" | "italic">) => {
  const file = textFontFile(t.font, t.bold, t.italic);
  let f = fonts.get(file);
  if (!f) {
    f = readTrueType(bytesOf(file));
    fonts.set(file, f);
  }
  return f;
};
const spec = (o: Partial<ImageText> = {}): ImageText => ({
  ...DEFAULT_TEXT,
  text: "Ab",
  size: 20,
  ox: 0,
  oy: 0,
  ...o,
});

describe("the fonts", () => {
  it("every family has its four real files, read as TrueType: bold wider, italic slanted", () => {
    expect(TEXT_FONTS.map((f) => f.name)).toEqual([
      "Liberation Sans",
      "Liberation Serif",
      "Liberation Mono",
      "Inter",
      "Roboto",
      "Noto Sans",
      "Noto Serif",
      "Open Sans",
      "Lato",
      "Montserrat",
    ]);
    expect(TEXT_FONT_FILES).toHaveLength(40);
    expect(new Set(TEXT_FONT_FILES).size).toBe(40);
    for (const f of TEXT_FONTS) {
      const w = (bold: boolean, italic: boolean) =>
        layoutText(
          fontOf({ font: f.id, bold, italic }),
          spec({ font: f.id, bold, italic, text: "Hamburgefonts" }),
        ).w;
      if (f.kind === "monospace") {
        // A monospace's bold keeps its advances: its outlines are heavier.
        const ink = (bold: boolean) =>
          renderText(
            fontOf({ font: f.id, bold, italic: false }),
            spec({ font: f.id, bold, text: "mmmm" }),
            0,
            0,
          ).px.data.reduce((a, v, i) => (i % 4 === 3 ? a + v : a), 0);
        expect(ink(true), f.name).toBeGreaterThan(ink(false) * 1.15);
      } else expect(w(true, false), f.name).toBeGreaterThan(w(false, false));
      // The italic is its own file: other outlines than the regular.
      const a = fontOf({ font: f.id, bold: false, italic: false }).glyphOf(97).contours;
      const b = fontOf({ font: f.id, bold: false, italic: true }).glyphOf(97).contours;
      expect(JSON.stringify(a), f.name).not.toBe(JSON.stringify(b));
      // Latin with Italian and Latin Extended-A letters.
      for (const ch of "àèéìòù€ŁŒ")
        expect(
          fontOf({ font: f.id, bold: false, italic: false }).glyphOf(ch.codePointAt(0) as number)
            .contours.length,
          `${f.name} ${ch}`,
        ).toBeGreaterThan(0);
    }
    expect(textFontFile("sans", true, true)).toBe("LiberationSans-BoldItalic.ttf");
    expect(textFontFile("nope", false, false)).toBe("LiberationSans-Regular.ttf");
    const f = fontOf(spec());
    expect(f.unitsPerEm).toBe(2048);
    expect(f.glyphOf("A".codePointAt(0) as number).contours.length).toBeGreaterThan(0);
    // Bold is wider than regular.
    const w = (b: boolean) =>
      layoutText(fontOf(spec({ bold: b })), spec({ bold: b, text: "mmmm" })).w;
    expect(w(true)).toBeGreaterThan(w(false));
  });
});

describe("lines", () => {
  it("point text: one line per line, as wide as the widest, CSS's half leading", () => {
    const f = fontOf(spec());
    const l = layoutText(f, spec({ text: "Ab\nlonger line", size: 20, lineHeight: 1.5 }));
    expect(l.lines.map((x) => x.text)).toEqual(["Ab", "longer line"]);
    expect(l.step).toBe(30);
    expect(l.h).toBe(60);
    expect(l.w).toBeCloseTo(l.lines[1]?.w as number);
    // The baseline: half the leading above, then the font's ascender.
    const k = 20 / f.unitsPerEm;
    expect(l.ascent).toBeCloseTo((30 - (f.ascender - f.descender) * k) / 2 + f.ascender * k);
    const c = layoutText(f, spec({ text: "Ab\nlonger line", align: "center" }));
    expect(c.lines[0]?.x).toBeCloseTo((c.w - (c.lines[0]?.w as number)) / 2);
    const r = layoutText(f, spec({ text: "Ab\nlonger line", align: "right" }));
    expect((r.lines[0]?.x as number) + (r.lines[0]?.w as number)).toBeCloseTo(r.w);
  });

  it("paragraph text wraps at its box's width (inside a word only when it must), cut at its height", () => {
    const f = fontOf(spec());
    const t = spec({ text: "uno due tre quattro cinque", size: 20, box: { w: 90, h: 200 } });
    const l = layoutText(f, t);
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.lines.every((x) => x.w <= 90 + 1e-6)).toBe(true);
    expect(l.lines.map((x) => x.text.trim()).join(" ")).toBe("uno due tre quattro cinque");
    expect([l.w, l.h]).toEqual([90, 200]);
    const long = layoutText(f, spec({ text: "supercalifragilistico", box: { w: 50, h: 500 } }));
    expect(long.lines.length).toBeGreaterThan(2);
    expect(long.lines.map((x) => x.text).join("")).toBe("supercalifragilistico");
    const short = layoutText(f, spec({ text: "a\nb\nc\nd", box: { w: 50, h: 50 } }));
    expect(short.lines.map((x) => x.text)).toEqual(["a", "b"]);
  });
});

describe("the caret and the overflow", () => {
  it("lines know where they start; a point gives the character there", () => {
    const f = fontOf(spec());
    const t = spec({ text: "Ciao\r\nmondo bello", size: 20, lineHeight: 1 });
    const l = layoutText(f, t);
    expect(l.lines.map((x) => [x.text, x.start])).toEqual([
      ["Ciao", 0],
      ["mondo bello", 6],
    ]);
    expect(textIndexAt(f, t, -5, 5)).toBe(0);
    expect(textIndexAt(f, t, 1000, 5)).toBe(4);
    // On the second line, just right of «m»'s middle: after it.
    const m = (f.glyphOf(109).advance * 20) / f.unitsPerEm;
    expect(textIndexAt(f, t, m * 0.6, 25)).toBe(7);
    expect(textIndexAt(f, t, m * 0.4, 25)).toBe(6);
    // Below the last line: its end.
    expect(textIndexAt(f, t, 1000, 500)).toBe(t.text.length);
    // Wrapped lines: the starts follow the text; the caret goes before a break's space.
    const p = spec({ text: "uno due tre", size: 20, box: { w: 50, h: 100 } });
    const pl = layoutText(f, p);
    expect(pl.lines.map((x) => p.text.slice(x.start, x.start + x.text.length))).toEqual(
      pl.lines.map((x) => x.text),
    );
    expect(textIndexAt(f, p, 1000, 5)).toBe(3);
    // Turned a quarter: the point is turned back into the box.
    const [x, y] = textPointIn(spec({ rotate: 90 }), { w: 100, h: 20 }, 0, 0, 50, 60);
    expect([Math.round(x), Math.round(y)]).toEqual([100, 10]);
  });

  it("paragraph text counts the lines that do not fit its box", () => {
    const f = fontOf(spec());
    expect(
      layoutText(f, spec({ text: "a\nb\nc\nd", size: 20, lineHeight: 1, box: { w: 50, h: 40 } }))
        .hidden,
    ).toBe(2);
    expect(
      layoutText(f, spec({ text: "a\nb", size: 20, lineHeight: 1, box: { w: 50, h: 40 } })).hidden,
    ).toBe(0);
    expect(layoutText(f, spec({ text: "a\nb\nc" })).hidden).toBe(0);
  });
});

describe("pixels", () => {
  it("the same text gives the same pixels; its colour, its box's offset from the layer", () => {
    const t = spec({ text: "Hello\nworld", color: "#ff8800" });
    const a = renderText(fontOf(t), t, 10.5, 20);
    const b = renderText(fontOf(t), t, 10.5, 20);
    expect(Buffer.from(a.px.data).equals(Buffer.from(b.px.data))).toBe(true);
    expect([a.x, a.y]).toEqual([b.x, b.y]);
    expect(a.px.width).toBeGreaterThan(40);
    let full = 0;
    for (let i = 0; i < a.px.data.length; i += 4)
      if (a.px.data[i + 3] === 255) {
        full++;
        expect([a.px.data[i], a.px.data[i + 1], a.px.data[i + 2]]).toEqual([255, 136, 0]);
      }
    expect(full).toBeGreaterThan(50);
    // Anti-aliased edges.
    expect([...a.px.data].some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
    const l = textLayer(fontOf(t), t, 10.5, 20);
    expect(textOrigin({ x: l.x, y: l.y, text: l.text })).toEqual([10.5, 20]);
    // Turned a quarter: taller than wide.
    const r = renderText(fontOf(t), { ...t, text: "Hello", rotate: 90 }, 0, 0);
    expect(r.px.height).toBeGreaterThan(r.px.width);
    // Blanks draw nothing.
    expect(renderText(fontOf(t), { ...t, text: "   " }, 3, 4).px.width).toBe(0);
  });

  it("scaling changes the size and a paragraph's box; turns add up", () => {
    const t = spec({ size: 20, box: { w: 100, h: 50 }, rotate: 350 });
    expect(scaledText(t, 2, 2, 20)).toMatchObject({
      size: 40,
      box: { w: 200, h: 100 },
      rotate: 10,
    });
    expect(scaledText(spec({ rotate: 30 }), 1, 1, -30).rotate).toBeUndefined();
    expect(scaledText(spec(), 2, 0.5).size).toBe(20);
  });
});

describe("OpenRaster attributes", () => {
  it("read back what they wrote; not a text without its text; bad values refused", () => {
    const t = spec({
      text: 'Riga 1\nRiga "2" & <3>',
      bold: true,
      italic: true,
      align: "right",
      lineHeight: 1.4,
      box: { w: 120.5, h: 60 },
      ox: 1.25,
      oy: -2,
      rotate: 15,
      color: "#11223344",
    });
    expect(textOfAttrs(textAttrs(t))).toEqual(t);
    const point = spec();
    expect(textAttrs(point)["redgiant-text-box"]).toBeUndefined();
    expect(textOfAttrs(textAttrs(point))).toEqual(point);
    expect(textOfAttrs({ name: "x" })).toBeUndefined();
    expect(textOfAttrs({ ...textAttrs(point), "redgiant-text-color": "red" })).toBeUndefined();
    // A layer's info carries it.
    expect(
      ImageLayerInfo.safeParse({
        id: "a",
        name: "a",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        opacity: 1,
        visible: true,
        blend: "svg:src-over",
        text: t,
      }).success,
    ).toBe(true);
  });
});
