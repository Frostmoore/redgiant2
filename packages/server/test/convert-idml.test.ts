// IDML → ODG keeps the layout (G34.3): every page with its size, every frame at its place, the
// texts with their formatting, threaded frames, master items, layers and pictures; checked
// against the positions worked out by hand in the sample.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  apply,
  colourTable,
  idmlLinks,
  idmlToOdg,
  linkName,
  multiply,
  pictureInfo,
  place,
  relinkIdml,
} from "../src/convert-idml.js";
import { parseXml, walk, type XmlNode } from "../src/convert-js.js";
import { xmlProblem } from "../src/convert-tools.js";
import { A4, beachPng, IDML_EXPECTED, idmlSample } from "./fixtures/idml-sample.js";

const PT = 72 / 25.4;
const toPt = (v: string | undefined) => Number.parseFloat(v ?? "NaN") * PT;
const entriesOf = () => unzipSync(idmlSample());
const LINK = "file:/Users/designer/Jobs/Spring/Links/beach.png";

function convert(pictures: Record<string, Uint8Array> = { [LINK]: beachPng() }) {
  const r = idmlToOdg(entriesOf(), "spring", pictures);
  const odg = unzipSync(r.files["spring.odg"] as Uint8Array);
  const content = strFromU8(odg["content.xml"] as Uint8Array);
  const styles = strFromU8(odg["styles.xml"] as Uint8Array);
  const doc = parseXml(content);
  const pages = [...walk(doc)].filter((e) => e.name === "draw:page");
  const shape = (id: string) => {
    for (const [i, p] of pages.entries())
      for (const e of walk(p))
        if ((e.attrs["draw:name"] ?? "").split(" ")[1]?.replace(/,$/, "") === id)
          return { page: i, e };
    throw new Error(`no shape ${id}`);
  };
  const box = (e: XmlNode) => {
    const t = e.attrs["draw:transform"];
    const m = t?.match(/rotate \(([-\d.e]+)\) translate \(([-\d.]+)mm ([-\d.]+)mm\)/);
    return {
      x: m ? Number(m[2]) * PT : toPt(e.attrs["svg:x"]),
      y: m ? Number(m[3]) * PT : toPt(e.attrs["svg:y"]),
      w: toPt(e.attrs["svg:width"]),
      h: toPt(e.attrs["svg:height"]),
      angle: m ? (Number(m[1]) * 180) / Math.PI : 0,
    };
  };
  return { r, odg, content, styles, doc, pages, shape, box };
}

const near = (got: number, want: number, margin = 0.05) =>
  expect(Math.abs(got - want), `${got} vs ${want}`).toBeLessThan(margin);

describe("IDML geometry", () => {
  it("composes transforms and places boxes the way InDesign does", () => {
    const rot = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return [Math.cos(r), -Math.sin(r), Math.sin(r), Math.cos(r), 0, 0] as const;
    };
    const m = multiply([1, 0, 0, 1, 10, 20], [...rot(30)] as never);
    const p = place(m, 0, 0, 100, 50);
    near(p.angle, 30, 1e-9);
    near(p.x, 10);
    near(p.y, 20);
    near(p.w, 100);
    near(p.h, 50);
    expect(apply([2, 0, 0, 3, 1, 1], 1, 1)).toEqual([3, 4]);
    // A vertical mirror keeps the same region.
    const f = place([1, 0, 0, -1, 0, 100], 0, 0, 10, 10);
    expect([f.x, f.y, f.w, f.h, f.flipped]).toEqual([0, 90, 10, 10, true]);
  });

  it("reads colours in CMYK, RGB and tints, and pictures' natural sizes", () => {
    const c = colourTable(
      parseXml(
        '<G><Color Self="Color/Red" Space="CMYK" ColorValue="0 100 100 0"/><Color Self="Color/Sea" Space="RGB" ColorValue="0 105 148"/><Tint Self="Tint/Sea 50" BaseColor="Color/Sea" TintValue="50"/><Color Self="Color/L" Space="LAB" ColorValue="100 0 0"/></G>',
      ),
    );
    expect(c.get("Color/Red")).toBe("#ff0000");
    expect(c.get("Color/Sea")).toBe("#006994");
    expect(c.get("Tint/Sea 50")).toBe("#80b4ca");
    expect(c.get("Color/L")).toBe("#ffffff");
    expect(c.get("Swatch/None")).toBeNull();
    expect(c.get("Color/Black")).toBe("#000000");
    expect(pictureInfo(beachPng())).toMatchObject({ ext: "png", w: 400, h: 300 });
  });
});

describe("IDML → ODG", () => {
  it("keeps every page with its size, and every frame where it was", () => {
    const { r, pages, shape, box, styles } = convert();
    expect(pages).toHaveLength(IDML_EXPECTED.pages);
    expect(r.layout.pages.map((p) => [p.name, p.width, p.height])).toEqual([
      ["1", A4.w, A4.h],
      ["2", A4.w, A4.h],
      ["3", A4.w, A4.h],
    ]);
    const layout = parseXml(styles);
    const pl = [...walk(layout)].find((e) => e.name === "style:page-layout-properties") as XmlNode;
    near(toPt(pl.attrs["fo:page-width"]), A4.w);
    near(toPt(pl.attrs["fo:page-height"]), A4.h);
    for (const [id, want] of [
      ["tfTitle", IDML_EXPECTED.title],
      ["tfBody1", IDML_EXPECTED.body1],
      ["tfBody2", IDML_EXPECTED.body2],
      ["ov1", IDML_EXPECTED.oval],
      ["gA", IDML_EXPECTED.groupA],
      ["gB", IDML_EXPECTED.groupB],
      ["rImg", IDML_EXPECTED.image],
      ["rRot", IDML_EXPECTED.rotated],
    ] as const) {
      const s = shape(id);
      expect(s.page, id).toBe(want.page);
      const b = box(s.e);
      near(b.x, want.x);
      near(b.y, want.y);
      near(b.w, want.w);
      near(b.h, want.h);
      near(b.angle, "angle" in want ? want.angle : 0, 1e-3);
    }
    expect(shape("ov1").e.name).toBe("draw:ellipse");
    expect(shape("gA").e.name).toBe("draw:rect");
    expect(shape("pg1").e.name).toBe("draw:path");
    expect(shape("pg1").e.attrs["svg:d"]).toMatch(/^M \d+ \d+ C .* Z$/);
    expect(shape("gl1").e.attrs["svg:d"]).toBe("M 0 0 L 8583 3528");
    // The item on the pasteboard is said, not drawn.
    expect(() => shape("ovPaste")).toThrow();
    expect(r.losses.join("\n")).toMatch(/1 item\(s\) on the pasteboard/);
  });

  it("keeps the texts with their formatting, and splits a threaded story over its frames", () => {
    const { content, shape } = convert();
    expect(xmlProblem(content)).toBeUndefined();
    const title = shape("tfTitle").e;
    const all = (e: XmlNode) =>
      [...walk(e)].flatMap((x) => x.children.filter((c) => typeof c === "string")).join("");
    expect(all(title)).toContain("Spring & Summer");
    expect(title.attrs["draw:name"]).toBe("TextFrame tfTitle, story u10");
    // Heading 1: 28 pt bold in Ocean, inherited Minion Pro.
    expect(content).toMatch(
      /style:name="P\d+" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="6pt"\/><style:text-properties style:font-name="Minion Pro" fo:font-family="Minion Pro" fo:font-size="28pt" fo:font-weight="bold" fo:color="#006994"\/>/,
    );
    // Emphasis: red from the character style; the range's "Bold" replaces its "Italic", as in InDesign.
    expect(content).toMatch(
      /<style:text-properties fo:font-size="11pt" fo:font-weight="bold" fo:font-style="normal" fo:color="#ff0000"\/>/,
    );
    // Body: justified, 14 pt leading, first line indent.
    expect(content).toMatch(/fo:text-align="justify" fo:text-indent="12pt" fo:line-height="14pt"/);
    const one = all(shape("tfBody1").e);
    const two = all(shape("tfBody2").e);
    expect(shape("tfBody1").e.attrs["draw:name"]).toMatch(/story u20 part 1 of 2/);
    expect(one.length).toBeGreaterThan(500);
    expect(two).toContain("The end of the story, in the second frame.");
    expect(one).not.toContain("The end of the story");
    // Nothing lost or doubled at the cut.
    expect((one + two).replace(/\s+/g, " ")).toContain("Layout matters. This paragraph");
    expect((one + two).split("Layout matters.").length - 1).toBe(8);
    // The tinted fill of the title frame and its insets.
    expect(content).toMatch(
      /draw:fill-color="#80b4ca"[^>]*fo:padding-top="2\.117mm" fo:padding-left="2\.822mm"/,
    );
  });

  it("puts the master's items on every page, on the right side, with the page number", () => {
    const { pages, box, content } = convert();
    for (const [i, p] of pages.entries()) {
      const folio = [...walk(p)].find((e) => /^TextFrame uAf/.test(e.attrs["draw:name"] ?? ""));
      expect(folio, `page ${i + 1}`).toBeDefined();
      const b = box(folio as XmlNode);
      near(b.x, A4.w / 2 - 50);
      near(b.y, A4.h - 40);
      expect(folio?.attrs["draw:name"]).toContain("(master A-Master)");
      expect([...walk(p)].some((e) => /^GraphicLine uAr/.test(e.attrs["draw:name"] ?? ""))).toBe(
        true,
      );
    }
    expect(content).toContain("<text:page-number>2</text:page-number>");
  });

  it("keeps layers, opacity, strokes and the pictures, cropped by their frames", () => {
    const { odg, styles, content, shape, box, r } = convert();
    expect(styles).toContain('<draw:layer draw:name="Background"/><draw:layer draw:name="Text"/>');
    expect(shape("tfTitle").e.attrs["draw:layer"]).toBe("Text");
    expect(content).toMatch(
      /draw:fill-color="#ff0000" draw:stroke="solid" svg:stroke-color="#000000" svg:stroke-width="0\.706mm" draw:shadow="hidden" draw:opacity="80%"/,
    );
    expect(r.losses.join("\n")).toMatch(/effects \(drop shadows/);
    // The linked picture: inside the frame, its overflow cut with fo:clip (in its own points).
    const images = [...walk(parseXml(content))].filter((e) => e.name === "draw:image");
    expect(images.map((i) => i.attrs["xlink:href"]).sort()).toEqual([
      "Pictures/image1.png",
      "Pictures/image2.png",
    ]);
    expect(odg["Pictures/image1.png"]).toBeDefined();
    expect(content).toMatch(/fo:clip="rect\(5\.88mm, 11\.759mm, 11\.759mm, 11\.759mm\)"/);
    const frames = [...walk(parseXml(content))].filter(
      (e) => e.name === "draw:frame" && e.attrs["draw:name"] === "Rectangle rImg",
    );
    const pic = box(frames.at(-1) as XmlNode);
    near(pic.x, 60);
    near(pic.y, 450);
    near(pic.w, 200);
    near(pic.h, 150);
    // The embedded one fills its frame exactly.
    const emb = [...walk(parseXml(content))].filter(
      (e) => e.name === "draw:frame" && e.attrs["draw:name"] === "Rectangle rEmb",
    );
    const b = box(emb.at(-1) as XmlNode);
    near(b.x, IDML_EXPECTED.embedded.x);
    near(b.w, IDML_EXPECTED.embedded.w);
    const manifest = strFromU8(odg["META-INF/manifest.xml"] as Uint8Array);
    expect(manifest).toContain(
      'manifest:full-path="Pictures/image1.png" manifest:media-type="image/png"',
    );
    expect(strFromU8(odg.mimetype as Uint8Array)).toBe(
      "application/vnd.oasis.opendocument.graphics",
    );
  });

  it("draws a missing linked picture as a grey box and says so", () => {
    const { content, r } = convert({});
    expect(content).toContain("<svg:title>Missing image: beach.png</svg:title>");
    expect(r.losses.join("\n")).toMatch(/1 linked image\(s\) were not found.*beach\.png/);
  });

  it("finds and rewrites links for Scribus", () => {
    const e = entriesOf();
    expect(idmlLinks(e)).toEqual([LINK]);
    expect(linkName("file:/a/My%20Pic.jpg")).toBe("My Pic.jpg");
    expect(linkName("file:C:\\x\\b.tif")).toBe("b.tif");
    const out = relinkIdml(e, { [LINK]: "/work/p/Links/beach.png" });
    expect(strFromU8(out["Spreads/Spread_s1.xml"] as Uint8Array)).toContain(
      'LinkResourceURI="file:/work/p/Links/beach.png"',
    );
    expect(out["Spreads/Spread_s2.xml"]).toBe(e["Spreads/Spread_s2.xml"]);
  });
});

// A copy to look at (and for the real LibreOffice and Scribus check), when asked.
if (process.env.REDGIANT_IDML_SAMPLES) {
  it("writes the samples", async () => {
    const dir = process.env.REDGIANT_IDML_SAMPLES as string;
    await mkdir(join(dir, "Links"), { recursive: true });
    await writeFile(join(dir, "spring.idml"), idmlSample());
    await writeFile(join(dir, "Links", "beach.png"), beachPng());
    await writeFile(join(dir, "spring.odg"), convert().r.files["spring.odg"] as Uint8Array);
  });
}
