// @vitest-environment jsdom
// The canvas's viewers (G34.2): the choice by name and bytes, the pure readers (CSV, ODF, PPTX,
// archives, trees) and the main components in a page.
import { fireEvent, render, waitFor } from "@testing-library/preact";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasKind, fileName } from "../src/components/Canvas.js";
import { readArchive } from "../src/components/viewers/ArchiveView.js";
import { FileViewer, UnknownView, VIEWERS } from "../src/components/viewers/FileViewer.js";
import { zoomStep } from "../src/components/viewers/ImageView.js";
import { clock } from "../src/components/viewers/MediaView.js";
import {
  filterRows,
  Grid,
  guessSeparator,
  parseDelimited,
  sortRows,
} from "../src/components/viewers/TableView.js";
import { lang } from "../src/i18n.js";
import { closeSide, openCanvas, sideAside, sideViews } from "../src/state.js";
import { isTar, tarFile, tarList, zipFile, zipList } from "../src/viewers/archive.js";
import { extensionOf, looksText, playable, viewerFor } from "../src/viewers/kind.js";
import { odfToElements, odpSlides, parseXml, pptxSlides, safeHref } from "../src/viewers/office.js";
import { countNodes, parseTree } from "../src/viewers/tree.js";

beforeEach(() => {
  lang.value = "it";
});
afterEach(() => vi.unstubAllGlobals());

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("which viewer (G34.2)", () => {
  const BY_NAME: [string, string, string][] = [
    ["clip.MP4", "video", "mp4"],
    ["film.mkv", "video", "mkv"],
    ["voice.opus", "audio", "opus"],
    ["photo.jpeg", "image", "jpeg"],
    ["logo.svg", "image", "svg"],
    ["report.pdf", "pdf", "pdf"],
    ["README.md", "markdown", "md"],
    ["main.ts", "code", "ts"],
    ["Dockerfile", "code", "dockerfile"],
    ["notes.txt", "text", "txt"],
    ["data.csv", "table", "csv"],
    ["data.tsv", "table", "tsv"],
    ["budget.xlsx", "sheet", "xlsx"],
    ["budget.ods", "sheet", "ods"],
    ["letter.docx", "document", "docx"],
    ["letter.odt", "document", "odt"],
    ["deck.pptx", "slides", "pptx"],
    ["deck.odp", "slides", "odp"],
    ["chair.glb", "model", "glb"],
    ["scan.ply", "model", "ply"],
    ["rig.fbx", "model", "fbx"],
    ["part.stl", "model", "stl"],
    ["bundle.zip", "archive", "zip"],
    ["backup.tar.gz", "archive", "tgz"],
    ["Inter.woff2", "font", "woff2"],
    ["config.yaml", "tree", "yaml"],
    ["feed.xml", "tree", "xml"],
    ["package.json", "tree", "json"],
    ["index.html", "site", "html"],
    ["thing.xyz", "unknown", "xyz"],
  ];
  for (const [name, kind, format] of BY_NAME)
    it(`${name} → ${kind}`, () => expect(viewerFor(name)).toEqual({ kind, format }));

  it("the bytes decide when the name says nothing or lies", () => {
    expect(viewerFor("report", text("%PDF-1.7\n"))).toEqual({ kind: "pdf", format: "pdf" });
    expect(viewerFor("photo.png", bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      kind: "image",
      format: "jpg",
    });
    expect(viewerFor("data.dat", bytes(0x50, 0x4b, 0x03, 0x04, 0))).toEqual({
      kind: "archive",
      format: "zip",
    });
    // An Office file is a ZIP: its name says which.
    expect(viewerFor("letter.docx", bytes(0x50, 0x4b, 0x03, 0x04, 0))).toEqual({
      kind: "document",
      format: "docx",
    });
    expect(viewerFor("notes.txt", text("%PDF-1.4\n%\u00e2\u00e3"))).toEqual({
      kind: "pdf",
      format: "pdf",
    });
    expect(viewerFor("model", text("glTF\u0002\u0000\u0000\u0000"))).toEqual({
      kind: "model",
      format: "glb",
    });
    expect(viewerFor("song", text("ID3\u0004"))).toEqual({ kind: "audio", format: "mp3" });
    expect(viewerFor("font", text("wOF2xxxx"))).toEqual({ kind: "font", format: "woff2" });
    expect(viewerFor("x", bytes(0, 0, 0, 0x18, ...text("ftypisom")))).toEqual({
      kind: "video",
      format: "mp4",
    });
    // Text with no known name reads as text, or as what it starts with.
    expect(viewerFor("LOG", text("started\nstopped\n"))).toEqual({ kind: "text", format: "txt" });
    expect(
      viewerFor("drawing", text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">')),
    ).toEqual({
      kind: "image",
      format: "svg",
    });
    expect(viewerFor("data", text('{"a": 1}'))).toEqual({ kind: "tree", format: "json" });
    // A "text" file of binary bytes is not text.
    expect(viewerFor("main.ts", bytes(1, 2, 0, 4)).kind).toBe("unknown");
    expect(viewerFor("blob.bin", bytes(1, 2, 0, 4))).toEqual({ kind: "unknown", format: "bin" });
  });

  it("knows names and text", () => {
    expect(extensionOf("a/b/Backup.TAR.GZ")).toBe("tgz");
    expect(extensionOf("Makefile")).toBe("");
    expect(looksText(text("ciao\tmondo\n"))).toBe(true);
    expect(looksText(bytes(0x41, 0))).toBe(false);
    expect(fileName("/home/me/out/clip.mp4")).toBe("clip.mp4");
    expect(fileName("C:\\Users\\me\\a.pdf")).toBe("a.pdf");
    expect(canvasKind({ kind: "file", scope: "p", path: "scan.ply" })).toBe("model");
  });

  it("says before trying which media no browser plays", () => {
    expect(playable("avi")).toBe("no");
    expect(playable("wmv", () => "maybe")).toBe("no");
    expect(playable("mp4", () => "")).toBe("no");
    expect(playable("mp4", () => "probably")).toBe("maybe");
    expect(playable("mkv", () => "")).toBe("maybe");
  });

  it("has a viewer for every kind, each loaded on its own", async () => {
    for (const load of Object.values(VIEWERS)) expect(typeof (await load())).toBe("function");
  });

  it("small helpers: time, zoom", () => {
    expect(clock(75)).toBe("1:15");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(Number.NaN)).toBe("0:00");
    expect(zoomStep(1, true)).toBe(1.5);
    expect(zoomStep(1, false)).toBe(0.75);
    expect(zoomStep(8, true)).toBe(8);
  });
});

describe("tables", () => {
  it("reads CSV, finds its separator, sorts and filters", () => {
    expect(parseDelimited('name,note\r\n"Rossi, M.","said ""hi"""\nB,2', ",")).toEqual([
      ["name", "note"],
      ["Rossi, M.", 'said "hi"'],
      ["B", "2"],
    ]);
    expect(guessSeparator("a;b;c\n1;2;3", "csv")).toBe(";");
    expect(guessSeparator("a,b\n", "csv")).toBe(",");
    expect(guessSeparator("a,b\n", "tsv")).toBe("\t");
    const rows = [
      ["Zoe", "10"],
      ["anna", "9"],
      ["Bruno", ""],
      ["carla", "1.234,5"],
    ];
    expect(sortRows(rows, { col: 1, dir: "asc" }).map((r) => r[0])).toEqual([
      "anna",
      "Zoe",
      "carla",
      "Bruno",
    ]);
    expect(sortRows(rows, { col: 1, dir: "desc" }).map((r) => r[0])).toEqual([
      "carla",
      "Zoe",
      "anna",
      "Bruno",
    ]);
    expect(sortRows(rows, { col: 0, dir: "asc" }).map((r) => r[0])).toEqual([
      "anna",
      "Bruno",
      "carla",
      "Zoe",
    ]);
    expect(sortRows(rows, null)).toBe(rows);
    expect(filterRows(rows, "ANN")).toEqual([["anna", "9"]]);
    expect(filterRows(rows, "  ")).toBe(rows);
  });

  it("a grid sorts on its header and filters as one types", () => {
    const r = render(
      <Grid
        rows={[
          ["Città", "Abitanti"],
          ["Roma", "2700000"],
          ["Milano", "1350000"],
          ["Torino", "850000"],
        ]}
      />,
    );
    const first = () =>
      [...r.container.querySelectorAll("tbody tr")].map((tr) => tr.children[1]?.textContent);
    expect(first()).toEqual(["Roma", "Milano", "Torino"]);
    fireEvent.click(r.getByText("Abitanti"));
    expect(first()).toEqual(["Torino", "Milano", "Roma"]);
    fireEvent.click(r.getByText("Abitanti"));
    expect(first()).toEqual(["Roma", "Milano", "Torino"]);
    fireEvent.input(r.getByLabelText("Filtra"), { target: { value: "mil" } });
    expect(first()).toEqual(["Milano"]);
    expect(r.getByText("1 righe su 3")).toBeTruthy();
  });
});

const ODT = `<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink">
 <office:automatic-styles>
  <style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
 </office:automatic-styles>
 <office:body><office:text>
  <text:h text:outline-level="2">Titolo</text:h>
  <text:p>Uno <text:span text:style-name="T1">forte</text:span> e <text:span text:style-name="T2">corsivo</text:span><text:s text:c="2"/>fine</text:p>
  <text:list><text:list-item><text:p>Primo</text:p></text:list-item></text:list>
  <text:p><text:a xlink:href="javascript:alert(1)">cattivo</text:a> <text:a xlink:href="https://example.org">buono</text:a></text:p>
  <table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>A</text:p></table:table-cell></table:table-row></table:table>
  <text:p><draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>
 </office:text></office:body>
</office:document-content>`;

describe("documents and slides", () => {
  it("turns an ODT into elements: headings, styles, lists, tables, safe links, pictures", () => {
    const host = document.createElement("div");
    host.appendChild(
      odfToElements(parseXml(ODT), undefined, new Map([["Pictures/a.png", "blob:x"]])),
    );
    expect(host.querySelector("h2")?.textContent).toBe("Titolo");
    const spans = host.querySelectorAll("p span");
    expect((spans[0] as HTMLElement).style.fontWeight).toBe("bold");
    expect((spans[1] as HTMLElement).style.fontStyle).toBe("italic");
    expect(host.querySelector("p")?.textContent).toBe("Uno forte e corsivo  fine");
    expect(host.querySelector("ul li")?.textContent).toBe("Primo");
    const links = host.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.org");
    expect((host.querySelector("td") as HTMLTableCellElement).colSpan).toBe(2);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:x");
    expect(host.querySelector("script")).toBeNull();
    expect(safeHref("JavaScript:x")).toBeUndefined();
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
  });

  it("reads a PPTX's slides in order, with titles, text and pictures", () => {
    const rel = (id: string, target: string, type = "slide") =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const ns = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    const slide = (title: string, body: string, pic = "") =>
      `<p:sld ${ns}><p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>sotto</a:t></a:r></a:p></p:txBody></p:sp>
        ${pic && `<p:pic><p:blipFill><a:blip r:embed="${pic}"/></p:blipFill></p:pic>`}
      </p:spTree></p:cSld></p:sld>`;
    const files = {
      "ppt/presentation.xml": text(
        `<p:presentation ${ns}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      ),
      "ppt/_rels/presentation.xml.rels": text(
        `<Relationships>${rel("rId2", "slides/slide1.xml")}${rel("rId3", "slides/slide2.xml")}</Relationships>`,
      ),
      "ppt/slides/slide1.xml": text(slide("Secondo", "b")),
      "ppt/slides/slide2.xml": text(slide("Primo", "a", "rId1")),
      "ppt/slides/_rels/slide2.xml.rels": text(
        `<Relationships>${rel("rId1", "../media/image1.png", "image")}</Relationships>`,
      ),
      "ppt/media/image1.png": bytes(0x89, 0x50),
    };
    expect(pptxSlides(files)).toEqual([
      {
        title: "Primo",
        lines: [
          { text: "a", level: 0 },
          { text: "sotto", level: 1 },
        ],
        pictures: ["ppt/media/image1.png"],
      },
      {
        title: "Secondo",
        lines: [
          { text: "b", level: 0 },
          { text: "sotto", level: 1 },
        ],
        pictures: [],
      },
    ]);
  });

  it("reads an ODP's pages", () => {
    const xml = `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:presentation>
      <draw:page draw:name="p1"><draw:frame presentation:class="title"><draw:text-box><text:p>Benvenuti</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:list><text:list-item><text:p>Punto</text:p></text:list-item></text:list></draw:text-box></draw:frame></draw:page>
      <draw:page draw:name="p2"><draw:frame><draw:image xlink:href="Pictures/x.png"/></draw:frame></draw:page>
    </office:presentation></office:body></office:document-content>`;
    expect(odpSlides(parseXml(xml))).toEqual([
      { title: "Benvenuti", lines: [{ text: "Punto", level: 0 }], pictures: [] },
      { title: "p2", lines: [], pictures: ["Pictures/x.png"] },
    ]);
  });
});

/** A TAR made here: one header and the data, padded to 512 bytes. */
function tar(entries: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, body] of entries) {
    const h = new Uint8Array(512);
    h.set(text(name), 0);
    h.set(text("0000644\0"), 100);
    h.set(text(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
    h[156] = 48;
    h.set(text("ustar\u000000"), 257);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(text(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    parts.push(h);
    const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
    data.set(text(body));
    parts.push(data);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("archives", () => {
  it("lists a ZIP without unpacking it, and takes one file out", () => {
    const zip = zipSync({
      "docs/a.txt": strToU8("ciao"),
      "b.csv": strToU8("x,y\n1,2"),
      "empty/": new Uint8Array(),
    });
    const list = zipList(zip);
    expect(list.map((e) => [e.path, e.size, e.folder])).toEqual([
      ["docs/a.txt", 4, false],
      ["b.csv", 7, false],
      ["empty/", 0, true],
    ]);
    expect(new TextDecoder().decode(zipFile(zip, "docs/a.txt"))).toBe("ciao");
    expect(readArchive("x.zip", "zip", zip).kind).toBe("list");
    expect(readArchive("x.zip", "zip", bytes(1, 2, 3)).kind).toBe("error");
  });

  it("lists a TAR and takes a file out", () => {
    const t = tar([
      ["a.txt", "uno"],
      ["dir/b.md", "# due"],
    ]);
    expect(isTar(t)).toBe(true);
    expect(tarList(t).map((e) => [e.path, e.size])).toEqual([
      ["a.txt", 3],
      ["dir/b.md", 5],
    ]);
    expect(new TextDecoder().decode(tarFile(t, "dir/b.md"))).toBe("# due");
  });
});

describe("trees", () => {
  it("reads JSON (also with comments), YAML and XML", async () => {
    const j = await parseTree('{"a": [1, true, null], "b": {"c": "x"}}', "json");
    expect(j.children?.map((c) => c.label)).toEqual(["a", "b"]);
    expect(j.children?.[0]?.children?.map((c) => [c.type, c.value])).toEqual([
      ["number", "1"],
      ["boolean", "true"],
      ["null", "null"],
    ]);
    const loose = await parseTree('{\n // note\n "a": 1,\n}', "jsonc");
    expect(loose.children?.[0]).toMatchObject({ label: "a", value: "1" });
    const y = await parseTree("name: RedGiant\nlist:\n  - uno\n  - due\n", "yaml");
    expect(y.children?.[1]?.children?.map((c) => c.value)).toEqual(["uno", "due"]);
    const x = await parseTree('<root id="1"><item>uno</item><item>due</item></root>', "xml");
    expect(x.label).toBe("root");
    expect(x.children?.map((c) => [c.label, c.value])).toEqual([
      ["@id", "1"],
      ["item", "uno"],
      ["item", "due"],
    ]);
    expect(countNodes(x)).toBe(4);
    await expect(parseTree("<a>", "xml")).rejects.toThrow();
  });
});

describe("the canvas in the page", () => {
  it("a file nobody can show has its card with the download", () => {
    const r = render(
      <UnknownView
        src={{ kind: "unknown", format: "xyz", name: "thing.xyz", url: "blob:x", size: 2048 }}
      />,
    );
    expect(r.getByText("thing.xyz")).toBeTruthy();
    expect(r.getByText("2 KB")).toBeTruthy();
    expect(r.getByText("XYZ")).toBeTruthy();
    expect(r.getByText("Scarica")).toBeTruthy();
  });

  it("chooses from the first bytes and loads that viewer only", async () => {
    const csv = "nome,anni\nAda,36\nBo,7\n";
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      return new Response(csv, {
        status: range ? 206 : 200,
        headers: range ? { "Content-Range": `bytes 0-${csv.length - 1}/${csv.length}` } : {},
      });
    });
    vi.stubGlobal("fetch", fetcher);
    let chosen = "";
    const r = render(
      <FileViewer
        name="persone.csv"
        url="/preview/t/persone.csv"
        onKind={(s) => (chosen = `${s.kind}:${s.size}`)}
      />,
    );
    await waitFor(() => expect(r.container.querySelector("tbody")).toBeTruthy());
    expect(chosen).toBe(`table:${csv.length}`);
    expect(r.getByText("Ada")).toBeTruthy();
    expect(r.getByText("2 righe")).toBeTruthy();
  });

  it("opens a file inside a ZIP and goes back to the list", async () => {
    const zip = zipSync({ "dentro/nota.md": strToU8("# Ciao"), "dati.json": strToU8('{"x": 1}') });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("blob:")
          ? new Response("# Ciao", { status: 200 })
          : new Response(zip as BodyInit, {
              status: 200,
              headers: { "Content-Length": String(zip.length) },
            }),
      ),
    );
    if (!URL.createObjectURL)
      Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} });
    const made = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const r = render(<FileViewer name="pacco.zip" url="/preview/t/pacco.zip" />);
    await waitFor(() => expect(r.getByText("nota.md")).toBeTruthy());
    expect(r.getByText("2 file, 14 B")).toBeTruthy();
    fireEvent.click(r.getByText("nota.md"));
    await waitFor(() => expect(r.getByText("Torna all'archivio")).toBeTruthy());
    expect(made).toHaveBeenCalled();
    fireEvent.click(r.getByText("Torna all'archivio"));
    await waitFor(() => expect(r.getByText("dati.json")).toBeTruthy());
  });

  it("what the canvas shows is kept for the next visit, and closing forgets it", () => {
    sideViews.value = [];
    openCanvas("clip.mp4", { kind: "file", scope: "project:demo", path: "out/clip.mp4" });
    expect(sideAside.value).toBe(false);
    const saved = JSON.parse(localStorage.getItem("rg.canvas") ?? "{}");
    expect(saved.views.map((v: { id: string }) => v.id)).toEqual([
      "canvas:project:demo:out/clip.mp4",
    ]);
    expect(saved.active).toBe("canvas:project:demo:out/clip.mp4");
    closeSide("canvas:project:demo:out/clip.mp4");
    expect(JSON.parse(localStorage.getItem("rg.canvas") ?? "{}").views).toEqual([]);
  });
});
