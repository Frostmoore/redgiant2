// Text layers' pure part (p3.5.8): the TrueType reader, the lines (point text, paragraph text
// wrapped in its box, alignment, CSS's half leading), the pixels the page and the server share
// (the same text gives the same bytes; turned, coloured; nothing for blanks), the box's offset
// from the layer, scaling, and the OpenRaster attributes read back.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  textAttrs,
  textFontFile,
  textLayer,
  textOfAttrs,
  textOrigin,
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
const fonts = new Map<string, Font>();
const fontOf = (t: Pick<ImageText, "font" | "bold" | "italic">) => {
  const file = textFontFile(t.font, t.bold, t.italic);
  let f = fonts.get(file);
  if (!f) {
    f = readTrueType(new Uint8Array(readFileSync(join(fontsDir, file))));
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
  it("are the four Liberation Sans files, read as TrueType", () => {
    expect(TEXT_FONT_FILES).toEqual([
      "LiberationSans-Regular.ttf",
      "LiberationSans-Bold.ttf",
      "LiberationSans-Italic.ttf",
      "LiberationSans-BoldItalic.ttf",
    ]);
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
