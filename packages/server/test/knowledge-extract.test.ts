import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkDocument } from "../src/knowledge/chunk.js";
import {
  decodeText,
  docKindOf,
  extractFile,
  extractHtml,
  extractOfficeXml,
  extractText,
} from "../src/knowledge/extract.js";
import type { Extracted } from "../src/knowledge/types.js";

const fixtures = new URL("./fixtures/knowledge/", import.meta.url);
// fileURLToPath, not .pathname: on Windows the URL's path is "/D:/a/..." (CI: "D:\\D:\\a\\...").
const fixture = (name: string) => fileURLToPath(new URL(name, fixtures));

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rg-kextract-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const file = async (name: string, data: string | Uint8Array) => {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
};

/** The text of the lines a part claims, from the original. */
const linesOf = (text: string, a?: number, b?: number) =>
  text
    .split("\n")
    .slice((a ?? 1) - 1, b)
    .join("\n");

describe("docKindOf", () => {
  it.each([
    ["notes.md", "markdown"],
    ["a.TS", "code"],
    ["Dockerfile", "code"],
    ["README", "text"],
    ["data.csv", "text"],
    ["x.pdf", "pdf"],
    ["r.docx", "office"],
    ["old.doc", "office"],
    ["page.html", "html"],
    ["photo.JPG", "image"],
    ["blob.xyz", undefined],
  ])("%s → %s", (name, kind) => {
    expect(docKindOf(name)).toBe(kind);
  });
});

describe("text and code", () => {
  it("cuts TypeScript by symbol with exact lines and the comments above", () => {
    const src = [
      'import { x } from "y";', // 1
      "", // 2
      "/** Adds. */", // 3
      "export function add(a: number, b: number): number {", // 4
      "  return a + b;", // 5
      "}", // 6
      "", // 7
      "export class Box {", // 8
      "  value = 1;", // 9
      "}", // 10
      "", // 11
      "const helper = () => 2;", // 12
    ].join("\n");
    const doc = extractText("math.ts", src);
    expect(doc.kind).toBe("code");
    expect(doc.parts.map((p) => [p.heading, p.lineStart, p.lineEnd])).toEqual([
      [undefined, 1, 1],
      ["export function add(a: number, b: number): number", 3, 6],
      ["export class Box", 8, 10],
      ["const helper = () => 2;", 12, 12],
    ]);
    for (const p of doc.parts) expect(p.text).toBe(linesOf(src, p.lineStart, p.lineEnd));
  });

  it("looks into a long class for its methods", () => {
    const body = (n: string) => [
      `  ${n}(x: number): number {`,
      ...Array(70).fill(`    x = x * 2 + 1; // ${n}`),
      "    return x;",
      "  }",
      "",
    ];
    const src = [
      "export class Engine {",
      "  private n = 0;",
      "",
      ...body("start"),
      ...body("stop"),
      "}",
    ].join("\n");
    const doc = extractText("engine.ts", src);
    const headings = doc.parts.map((p) => p.heading);
    expect(headings).toContain("export class Engine › start(x: number): number");
    expect(headings).toContain("export class Engine › stop(x: number): number");
    const stop = doc.parts.find((p) => p.heading?.endsWith("stop(x: number): number"));
    expect(linesOf(src, stop?.lineStart, stop?.lineStart)).toBe("  stop(x: number): number {");
  });

  it("knows Python, Go, Rust and SQL symbols", () => {
    const py = extractText(
      "a.py",
      "import os\n\n@cache\ndef load(p):\n    return p\n\nclass A:\n    pass\n",
    );
    expect(py.parts.map((p) => p.heading)).toEqual([undefined, "def load(p)", "class A"]);
    expect(py.parts[1]?.lineStart).toBe(3);
    const go = extractText(
      "m.go",
      "package m\n\nfunc Run() error {\n\treturn nil\n}\n\ntype T struct{}\n",
    );
    expect(go.parts.map((p) => p.heading)).toEqual([
      undefined,
      "func Run() error",
      "type T struct{}",
    ]);
    const rs = extractText("l.rs", "use std::io;\n\npub fn main() {\n}\n\nimpl Foo {\n}\n");
    expect(rs.parts.map((p) => p.heading)).toEqual([undefined, "pub fn main()", "impl Foo"]);
    const sql = extractText("s.sql", "CREATE TABLE t (id int);\n\nINSERT INTO t VALUES (1);\n");
    expect(sql.parts).toHaveLength(2);
  });

  it("cuts plain text by paragraphs with lines", () => {
    const doc = extractText("n.txt", "first para\nstill first\n\n\nsecond\n");
    expect(doc.parts.map((p) => [p.text, p.lineStart, p.lineEnd])).toEqual([
      ["first para\nstill first", 1, 2],
      ["second", 5, 5],
    ]);
  });

  it("decodes UTF-8 with BOM, UTF-16 and Windows-1252", async () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0xc3, 0xa0]))).toBe("cà");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x63, 0, 0xe0, 0]))).toBe("cà");
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x63, 0, 0xe0]))).toBe("cà");
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe8, 0x80]))).toBe("cafè€");
    const p = await file("latin.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe8, 0x0a]));
    const r = await extractFile(p);
    expect(r.ok && r.doc.parts[0]?.text).toBe("cafè");
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("perché\nsì\n", "utf16le")]);
    const r16 = await extractFile(await file("u16.txt", u16));
    expect(r16.ok && r16.doc.parts[0]?.text).toBe("perché\nsì");
  });

  it("skips binaries, empty and too big files, and images (OCR comes later)", async () => {
    expect(await extractFile(await file("x.bin", new Uint8Array([1, 2, 0, 4])))).toMatchObject({
      skipped: "binary",
    });
    expect(
      await extractFile(await file("blob.dat", new Uint8Array([0x41, 0, 0x42]))),
    ).toMatchObject({
      skipped: "binary",
    });
    expect(await extractFile(await file("e.txt", ""))).toMatchObject({ skipped: "empty" });
    expect(await extractFile(await file("blank.md", "  \n\n"))).toMatchObject({ skipped: "empty" });
    expect(
      await extractFile(await file("big.txt", "x".repeat(2000)), { maxBytes: 1000 }),
    ).toMatchObject({
      skipped: "too_big",
    });
    expect(await extractFile(await file("p.png", new Uint8Array([0x89, 0x50])))).toMatchObject({
      skipped: "needs_ocr",
    });
  });
});

describe("markdown", () => {
  it("cuts by section with the heading path, ignoring # inside code fences", () => {
    const src = [
      "---", // 1
      'title: "The guide"', // 2
      "---", // 3
      "Intro line.", // 4
      "", // 5
      "# Install", // 6
      "Get it.", // 7
      "## Windows", // 8
      "```sh", // 9
      "# not a heading", // 10
      "```", // 11
      "Setup", // 12
      "-----", // 13
      "Run it.", // 14
    ].join("\n");
    const doc = extractText("guide.md", src);
    expect(doc.title).toBe("The guide");
    expect(doc.parts.map((p) => [p.heading, p.lineStart, p.lineEnd])).toEqual([
      [undefined, 4, 4],
      ["Install", 6, 7],
      ["Install › Windows", 8, 11],
      ["Install › Setup", 12, 14],
    ]);
  });

  it("takes the first H1 as title when there is no front matter", () => {
    expect(extractText("x.md", "# Hello *world*\ntext").title).toBe("Hello world");
    expect(extractText("x.md", "# `codebase_reference` and **bold** _it_\n").title).toBe(
      "codebase_reference and bold it",
    );
  });
});

describe("html", () => {
  it("keeps the content by headings and drops menus, scripts and forms", () => {
    const html = `<!doctype html><html><head><title>Fish &amp; chips</title><style>p{}</style></head>
      <body><nav><a href="/">Home</a> <a>Menu item</a></nav><header>Site banner</header>
      <h1>Recipe</h1><p>Fry the fish.</p><script>alert(1)</script>
      <h2>Sauce</h2><ul><li>Lemon</li><li>Salt &egrave; pepe</li></ul>
      <table><tr><td>a</td><td>b</td></tr></table>
      <form><input name=q><button>Search</button></form><footer>Copyright</footer></body></html>`;
    const doc = extractHtml(html);
    expect(doc.title).toBe("Fish & chips");
    expect(doc.kind).toBe("html");
    const all = doc.parts.map((p) => p.text).join("\n");
    expect(all).not.toMatch(/Menu item|Site banner|alert|Copyright|Search/);
    expect(doc.parts.map((p) => p.heading)).toEqual(["Recipe", "Recipe › Sauce"]);
    expect(doc.parts[1]?.text).toContain("- Salt è pepe");
    expect(doc.parts[1]?.text).toContain("a | b");
    expect(extractHtml("<p>x</p>", "https://e.org/").kind).toBe("web");
  });

  it("prefers <main> when the page marks it", () => {
    const filler = "Words of the article. ".repeat(20);
    const doc = extractHtml(
      `<body><div>Sidebar junk</div><main><h1>Title</h1><p>${filler}</p></main><div>More junk</div></body>`,
    );
    const all = doc.parts.map((p) => p.text).join("\n");
    expect(all).toContain("Words of the article");
    expect(all).not.toContain("junk");
  });
});

describe("pdf", () => {
  it("reads pages with their numbers and the title", async () => {
    const r = await extractFile(fixture("three-pages.pdf"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.kind).toBe("pdf");
    expect(r.doc.title).toBe("Three short chapters");
    expect(r.doc.pages).toBe(3);
    expect(r.doc.parts.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(r.doc.parts[1]?.text).toBe(
      "Chapter two: the engine\nA diesel engine needs clean fuel and fresh oil.\n\nChange the filter every season.",
    );
  });

  it("reads a PDF made by Ghostscript", async () => {
    const r = await extractFile(fixture("gs-two-pages.pdf"));
    expect(r.ok && r.doc.parts.map((p) => [p.page, p.text.split("\n")[0]])).toEqual([
      [1, "Ghostscript page one: invoices and receipts"],
      [2, "Ghostscript page two: the warranty"],
    ]);
  });

  it("says when a PDF is locked or has no text", async () => {
    expect(await extractFile(fixture("encrypted.pdf"))).toMatchObject({ skipped: "encrypted" });
    expect(await extractFile(fixture("empty-text.pdf"))).toMatchObject({ skipped: "needs_ocr" });
    expect(await extractFile(await file("broken.pdf", "%PDF-1.4 nonsense"))).toMatchObject({
      ok: false,
    });
  });
});

// ---- Office files written by hand (the parts the readers look at) ----

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string, extra = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${extra}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

function docx(body: string, title?: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
    "word/styles.xml": strToU8(
      `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Titolo1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Titolo2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    ),
    ...(title && {
      "docProps/core.xml": strToU8(
        `<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
      ),
    }),
  });
}

describe("office without LibreOffice", () => {
  it("reads Word by headings (localised style ids) with estimated pages", async () => {
    const body =
      para("Introduzione", "Titolo1") +
      para("Il motore &amp; la barca.") +
      para("Dettagli", "Titolo2") +
      para("Primo dettaglio.") +
      `<w:p><w:r><w:lastRenderedPageBreak/><w:t>Seconda pagina.</w:t></w:r></w:p>` +
      `<w:tbl><w:tr><w:tc>${para("a1")}</w:tc><w:tc>${para("b1")}</w:tc></w:tr></w:tbl>`;
    const r = await extractFile(await file("rel.docx", docx(body, "Relazione")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.title).toBe("Relazione");
    expect(r.doc.kind).toBe("office");
    expect(r.doc.note).toMatch(/estimated/);
    expect(r.doc.parts.map((p) => [p.heading, p.page, p.text])).toEqual([
      ["Introduzione", 1, "Introduzione\nIl motore & la barca."],
      ["Introduzione › Dettagli", 1, "Dettagli\nPrimo dettaglio."],
      ["Introduzione › Dettagli", 2, "Seconda pagina.\na1 | b1"],
    ]);
  });

  it("reads PowerPoint one slide per page in the presentation's order, with notes", () => {
    const slide = (title: string, text: string) =>
      strToU8(
        `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      );
    const buf = zipSync({
      "ppt/presentation.xml": strToU8(
        '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
      ),
      "ppt/_rels/presentation.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      ),
      "ppt/slides/slide1.xml": slide("Second", "comes later"),
      "ppt/slides/slide2.xml": slide("First", "opens"),
      "ppt/slides/_rels/slide2.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
      ),
      "ppt/notesSlides/notesSlide1.xml": strToU8(
        "<p:notes><p:sp><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:txBody></p:sp></p:notes>",
      ),
    });
    const r = extractOfficeXml(buf, "deck.pptx");
    expect(r.ok && r.doc.parts.map((p) => [p.page, p.heading, p.text])).toEqual([
      [1, "First", "First\nopens\n\nNotes: Say hello"],
      [2, "Second", "Second\ncomes later"],
    ]);
  });

  it("reads Excel sheets as rows with their row numbers", () => {
    const buf = zipSync({
      "xl/workbook.xml": strToU8(
        '<workbook><sheets><sheet name="Costi" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/sharedStrings.xml": strToU8(
        "<sst><si><t>Voce</t></si><si><r><t>Gaso</t></r><r><t>lio</t></r></si></sst>",
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2"><v>12.5</v></c></row><row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4" t="inlineStr"><is><t>litri</t></is></c></row></sheetData></worksheet>',
      ),
    });
    const r = extractOfficeXml(buf, "conti.xlsx");
    expect(r.ok && r.doc.parts).toEqual([
      { text: "Voce\t\t12.5\n\nGasolio\tlitri", heading: "Costi", lineStart: 2, lineEnd: 4 },
    ]);
  });

  it("reads OpenDocument text, presentations and spreadsheets", () => {
    const odt = zipSync({
      "content.xml": strToU8(
        '<office:document-content><office:body><office:text><text:h text:outline-level="1">Capitolo</text:h><text:p>Uno<text:s text:c="2"/>due</text:p><text:soft-page-break/><text:p>Dopo</text:p></office:text></office:body></office:document-content>',
      ),
      "meta.xml": strToU8("<office:meta><dc:title>Libro</dc:title></office:meta>"),
    });
    const t = extractOfficeXml(odt, "libro.odt");
    expect(t.ok && t.doc.title).toBe("Libro");
    expect(t.ok && t.doc.parts.map((p) => [p.heading, p.page, p.text])).toEqual([
      ["Capitolo", 1, "Capitolo\nUno  due"],
      ["Capitolo", 2, "Dopo"],
    ]);
    const odp = zipSync({
      "content.xml": strToU8(
        '<office:presentation><draw:page draw:name="p1"><draw:frame presentation:class="title"><draw:text-box><text:p>Benvenuti</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:p>Ordine del giorno</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
      ),
    });
    const p = extractOfficeXml(odp, "s.odp");
    expect(p.ok && p.doc.parts).toEqual([
      { text: "Benvenuti\nOrdine del giorno", page: 1, heading: "Benvenuti" },
    ]);
    const ods = zipSync({
      "content.xml": strToU8(
        '<office:spreadsheet><table:table table:name="Foglio1"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>d</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="3"><table:table-cell/></table:table-row><table:table-row><table:table-cell><text:p>z</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
      ),
    });
    const s = extractOfficeXml(ods, "f.ods");
    expect(s.ok && s.doc.parts).toEqual([
      { text: "a\t\t\td\n\n\n\nz", heading: "Foglio1", lineStart: 1, lineEnd: 5 },
    ]);
  });

  it("needs LibreOffice for old formats, and uses its PDF when there", async () => {
    const doc = await file("old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]));
    expect(await extractFile(doc)).toMatchObject({ skipped: "needs_libreoffice" });
    const pdf = join(dir, "old.pdf");
    await copyFile(fixture("three-pages.pdf"), pdf);
    const r = await extractFile(doc, { officePdf: async () => pdf });
    expect(r.ok && [r.doc.kind, r.doc.pages]).toEqual(["office", 3]);
    // A Word file goes through the PDF too (pages as the Canvas shows them), keeping its title.
    const w = await file("w.docx", docx(para("x"), "Titolo vero"));
    const rw = await extractFile(w, { officePdf: async () => pdf });
    expect(rw.ok && [rw.doc.title, rw.doc.parts.length]).toEqual(["Titolo vero", 3]);
    // LibreOffice failing: back to the XML.
    const rx = await extractFile(w, { officePdf: async () => undefined });
    expect(rx.ok && rx.doc.parts[0]?.text).toBe("x");
  });
});

describe("chunkDocument", () => {
  it("joins small neighbours on the same page and keeps pages apart", () => {
    const doc: Extracted = {
      kind: "pdf",
      title: "t",
      parts: [
        { text: "a", page: 1 },
        { text: "b", page: 1 },
        { text: "c", page: 2 },
      ],
    };
    const chunks = chunkDocument(doc);
    expect(chunks.map((c) => [c.ord, c.text, c.page])).toEqual([
      [0, "a\n\nb", 1],
      [1, "c", 2],
    ]);
    expect(chunks[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("splits long parts under max with overlap and exact lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the long text here`);
    const text = lines.join("\n");
    const doc: Extracted = {
      kind: "text",
      title: "t",
      parts: [{ text, lineStart: 1, lineEnd: 200 }],
    };
    const chunks = chunkDocument(doc, { target: 500, max: 700, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(700);
      expect(c.text).toBe(linesOf(text, c.lineStart, c.lineEnd));
    }
    // Each piece starts a little before the previous one ended.
    for (let i = 1; i < chunks.length; i++)
      expect(chunks[i]?.lineStart).toBeLessThanOrEqual(chunks[i - 1]?.lineEnd as number);
    expect(chunks.at(-1)?.lineEnd).toBe(200);
  });

  it("cuts one huge line at sentences, never above max", () => {
    const text = "This is a sentence of words. ".repeat(300);
    const chunks = chunkDocument({
      kind: "text",
      title: "t",
      parts: [{ text, lineStart: 1, lineEnd: 1 }],
    });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1800);
      expect(c.lineStart).toBe(1);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not join code across different top sections, but joins under the same one", () => {
    const doc: Extracted = {
      kind: "markdown",
      title: "t",
      parts: [
        { text: "# A", heading: "A", lineStart: 1, lineEnd: 1 },
        { text: "## A1\nx", heading: "A › A1", lineStart: 2, lineEnd: 3 },
        { text: "# B\ny", heading: "B", lineStart: 4, lineEnd: 5 },
      ],
    };
    expect(chunkDocument(doc).map((c) => [c.heading, c.lineStart, c.lineEnd])).toEqual([
      ["A", 1, 3],
      ["B", 4, 5],
    ]);
  });

  it("works end to end on a real file", async () => {
    const r = await extractFile(fixture("three-pages.pdf"));
    expect(r.ok && chunkDocument(r.doc).map((c) => c.page)).toEqual([1, 2, 3]);
  });
});
