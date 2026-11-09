// The vector family (G37.6): the file's own XML read and written back byte for byte, the agent's
// plain operations as actions on it (each undone exactly), Inkscape's attributes, metadata,
// unknown elements and the spaces in texts kept through edits, elements without an id named
// first, conflicts on the same element, scripts and outside links refused, and the family in the
// editor's host (PGlite) and from end to end with a scripted model (FakeProvider).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import {
  DEFAULT_EDITOR_SETTINGS,
  type DocFile,
  type DocOp,
  PERSON,
  type ServerMessage,
  type SvgAction,
} from "@redgiant/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorHost } from "../src/editor/host.js";
import { svgFromAgent } from "../src/editor/svg/agent.js";
import { elementBox, parseTransform, pathPoints } from "../src/editor/svg/geometry.js";
import {
  actionsConflict,
  applyAction,
  checkAction,
  find,
  invertAction,
  mapAction,
  virtualIds,
} from "../src/editor/svg/ops.js";
import { svgStructure } from "../src/editor/svg/structure.js";
import { parseXml, writeXml, type XDoc } from "../src/editor/svg/xml.js";
import {
  findInkscape,
  originalOfSvgCopy,
  svgCopyOfOriginal,
  svgFamily,
} from "../src/editor/svg-family.js";
import { inkscapeCli, svgToPdf } from "../src/editor/svg-routes.js";
import { startServer, wsClient } from "./helpers.js";
import { memoryDb } from "./pglite.js";

const POSTER = join(import.meta.dirname, "fixtures", "svg", "poster-inkscape.svg");
const poster = async () => readFile(POSTER, "utf8");

function agent(doc: XDoc, ops: unknown[]): SvgAction[] {
  const r = svgFromAgent(doc, ops);
  if ("error" in r) throw new Error(`${r.index}: ${r.error}`);
  return r.actions;
}
const run = (doc: XDoc, list: readonly SvgAction[]) =>
  list.reduce((d, a) => applyAction(d, a), doc);
/** Applies, inverts, and checks the inverse brings back the very same bytes. */
function roundTrip(doc: XDoc, list: SvgAction[]): XDoc {
  const batch: SvgAction =
    list.length === 1 ? (list[0] as SvgAction) : { t: "batch", ops: list as never };
  expect(checkAction(doc, batch)).toBeUndefined();
  const inv = invertAction(doc, batch);
  const after = applyAction(doc, batch);
  // The inverse survives the log (JSON) and gives back the file byte for byte.
  const back = applyAction(after, JSON.parse(JSON.stringify(inv)));
  expect(writeXml(back)).toBe(writeXml(doc));
  return after;
}

describe("the file's own XML", () => {
  it("reads and writes an Inkscape file byte for byte", async () => {
    const text = await poster();
    expect(writeXml(parseXml(text))).toBe(text);
  });

  it.each([
    ['\ufeff<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>\r\n'],
    [
      '<?xml version="1.0"?>\n<!DOCTYPE svg [\n <!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n<svg xmlns="&ns_svg;" a = \'x\' ><![CDATA[ <raw> ]]><!-- c --><?pi x?><text>a &amp; b &#233;</text></svg>',
    ],
    ['<svg>\n\t<g\n   id="a"   >  </g  >\n</svg>'],
  ])("keeps %j", (text) => {
    const d = parseXml(text);
    expect(writeXml(d)).toBe(text);
  });

  it("resolves the DOCTYPE's entities (Illustrator) and refuses what is not well formed", () => {
    const d = parseXml(
      '<!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg xmlns="&ns_svg;"/>',
    );
    expect(d.root.attrs[0]?.value).toBe("http://www.w3.org/2000/svg");
    expect(() => parseXml("<svg><g></svg>")).toThrow(/closes <g>/);
    expect(() => parseXml('<svg a="1" a="2"/>')).toThrow(/twice/);
    expect(() => parseXml("<svg/><svg/>")).toThrow(/second root/);
  });
});

describe("geometry", () => {
  it("reads transforms and boxes", () => {
    expect(parseTransform("translate(10,20) scale(2)")).toEqual([2, 0, 0, 2, 10, 20]);
    expect(parseTransform("bogus(1)")).toBeUndefined();
    expect(pathPoints("m 10,10 h 5 v 5 z")).toEqual([
      [10, 10],
      [15, 10],
      [15, 15],
    ]);
    const d = parseXml(
      '<svg><rect x="1" y="2" width="3" height="4" transform="translate(10,0)"/></svg>',
    );
    expect(elementBox(d.root.children[0] as never, {})).toEqual({ x: 11, y: 2, w: 3, h: 4 });
  });
});

describe("the agent's operations", () => {
  it("adds shapes and texts on the last layer, with ids, undone exactly", async () => {
    const doc = parseXml(await poster());
    const list = agent(doc, [
      {
        op: "add_shape",
        kind: "rect",
        x: 150,
        y: 80,
        w: 40,
        h: 20,
        rx: 2,
        style: { fill: "#ff0000", stroke_width: 0.5 },
      },
      { op: "add_shape", kind: "ellipse", x: 10, y: 10, w: 20, h: 10, id: "ovale" },
      {
        op: "add_text",
        x: 20,
        y: 140,
        text: "Via  Roma 1",
        style: { font_size: 5, anchor: "middle", bold: true },
      },
      {
        op: "add_shape",
        kind: "polygon",
        points: [
          [0, 0],
          [10, 0],
          [5, 8],
        ],
      },
      { op: "add_shape", kind: "line", x1: 0, y1: 0, x2: 5, y2: 5 },
      { op: "add_shape", kind: "path", d: "M 0,0 L 10,10" },
    ]);
    expect(list.map((a) => a.t)).toEqual([
      "insert",
      "insert",
      "insert",
      "insert",
      "insert",
      "insert",
    ]);
    const after = roundTrip(doc, list);
    const out = writeXml(after);
    expect(out).toContain(
      '<rect id="rect1" x="150" y="80" width="40" height="20" rx="2" fill="#ff0000" stroke-width="0.5" />',
    );
    expect(out).toContain('<ellipse id="ovale" cx="20" cy="15" rx="10" ry="5" />');
    // Two spaces in a row: written with xml:space so they stay.
    expect(out).toContain(
      'xml:space="preserve" font-size="5" text-anchor="middle" font-weight="bold">Via  Roma 1</text>',
    );
    // On the last layer («Testi»), indented as its siblings, after the unknown element.
    expect(out).toMatch(/<\/acme:extra>\n {4}<rect id="rect1"/);
    expect(out).toContain('<polygon id="polygon1" points="0,0 10,0 5,8" />');
    expect(out).toContain('<line id="line1" x1="0" y1="0" x2="5" y2="5" stroke="#000000" />');
  });

  it("writes a style where the element keeps it (its style attribute), then undoes it to the byte", async () => {
    const doc = parseXml(await poster());
    const list = agent(doc, [
      { op: "set_style", ids: ["sfondo", "sole"], fill: "#123456", opacity: 0.5 },
    ]);
    expect(list).toEqual([
      { t: "props", id: "sfondo", set: { fill: "#123456", opacity: "0.5" } },
      { t: "props", id: "sole", set: { fill: "#123456", opacity: "0.5" } },
    ]);
    const after = roundTrip(doc, list);
    const out = writeXml(after);
    expect(out).toContain('style="fill:#123456;fill-opacity:1;stroke:none;stroke-width:0.264583"');
    // Not in the style: an attribute, on its own line as Inkscape writes them.
    expect(out).toContain('acme:locked="yes"\n       opacity="0.5" />');
  });

  it("changes a text inside its tspan, keeping two spaces and xml:space", async () => {
    const doc = parseXml(await poster());
    const list = agent(doc, [{ op: "set_text", id: "titolo", text: "Officina   2027 " }]);
    expect(list).toEqual([{ t: "inner", id: "tspan1", xml: "Officina   2027 " }]);
    const out = writeXml(roundTrip(doc, list));
    expect(out).toContain('y="40.25">Officina   2027 </tspan></text>');
    expect(out).toContain('xml:space="preserve"');
    // The mixed text with a bold word keeps its spaces when nobody touches it.
    expect(out).toContain('id="sottotitolo">Laboratorio <tspan');
    expect(out).toContain("</tspan> a tutti</text>");
  });

  it("names an element without an id first (its virtual id), and the inverse takes the name back", async () => {
    const doc = parseXml(await poster());
    const v = virtualIds(doc);
    // The badge's rect and text, and the unknown element, have no id.
    expect(v.byRef.size).toBe(9);
    const rectRef = [...v.byRef.entries()].find(
      ([, p]) => p.join(".") === find(doc, "gruppo1")?.concat(1).join("."),
    )?.[0] as string;
    expect(rectRef).toMatch(/^rgv-[0-9a-f]{8}$/);
    const list = agent(doc, [{ op: "set_style", id: rectRef, fill: "#00ff00" }]);
    expect(list[0]).toEqual({ t: "name", ref: rectRef, id: "rect1" });
    const out = writeXml(roundTrip(doc, list));
    expect(out).toContain('id="rect1"');
    expect(out).toContain("fill:#00ff00;stroke:#1f4e79");
  });

  it("moves, rotates, scales in the transform; merges a translate", async () => {
    const doc = parseXml(await poster());
    const list = agent(doc, [
      { op: "move", id: "gruppo1", dx: 5, dy: -2 },
      { op: "move", id: "sfondo", dx: 1, dy: 1 },
      { op: "rotate", id: "sole", angle: 30 },
      { op: "scale", id: "onda", sx: 2 },
    ]);
    const out = writeXml(roundTrip(doc, list));
    expect(out).toContain('transform="translate(19.5,78)"');
    expect(out).toContain('transform="translate(1,1)"');
    expect(out).toContain('transform="rotate(30,160.5,38.25)"');
    expect(out).toMatch(
      /transform="translate\(60\.25,128\.\d+\) scale\(2,2\) translate\(-60\.25,-128\.\d+\)"/,
    );
  });

  it("groups, ungroups (the group's transform passed on), reorders, deletes", async () => {
    const doc = parseXml(await poster());
    const g = agent(doc, [{ op: "group", ids: ["uso2", "uso1"], id: "stelle" }]);
    const grouped = roundTrip(doc, g);
    expect(writeXml(grouped)).toMatch(
      /<g id="stelle">\s*<use[\s\S]*id="uso1"[\s\S]*id="uso2"[\s\S]*<\/g>/,
    );
    const u = agent(doc, [{ op: "ungroup", id: "gruppo1" }]);
    const ungrouped = writeXml(roundTrip(doc, u));
    expect(ungrouped).not.toContain('id="gruppo1"');
    // The children, named, carry the group's transform; the indentation they had stays.
    expect(ungrouped).toContain(
      'rx="3"\n         id="rect1"\n         transform="translate(14.5,80)" />',
    );
    expect(ungrouped).toContain(
      'id="text1"\n         transform="translate(14.5,80)">12 novembre</text>',
    );
    const r = agent(doc, [
      { op: "reorder", id: "titolo", to: "front" },
      { op: "reorder", id: "sole", to: "back" },
    ]);
    const reordered = writeXml(roundTrip(doc, r));
    expect(reordered.indexOf('id="sole"')).toBeLessThan(reordered.indexOf('id="sfondo"'));
    expect(reordered.indexOf('id="titolo"')).toBeGreaterThan(reordered.indexOf("acme:extra"));
    const del = agent(doc, [{ op: "delete", ids: ["uso1", "onda"] }]);
    const deleted = writeXml(roundTrip(doc, del));
    expect(deleted).not.toContain('id="uso1"');
    expect(deleted).not.toContain('id="onda"');
  });

  it("aligns and distributes on the measured boxes", async () => {
    const doc = parseXml(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a" x="0" y="0" width="10" height="10"/><rect id="b" x="30" y="5" width="10" height="20"/><g transform="translate(100,0)"><rect id="c" x="0" y="50" width="10" height="10"/></g></svg>',
    );
    const out = writeXml(run(doc, agent(doc, [{ op: "align", ids: ["a", "b", "c"], to: "left" }])));
    expect(out).toContain(
      'id="b" x="30" y="5" width="10" height="20" transform="translate(-30,0)"',
    );
    // In its group's coordinates: the group is at 100.
    expect(out).toContain(
      'id="c" x="0" y="50" width="10" height="10" transform="translate(-100,0)"',
    );
    const dist = writeXml(
      run(doc, agent(doc, [{ op: "distribute", ids: ["a", "b", "c"], axis: "x" }])),
    );
    expect(dist).toContain(
      'id="b" x="30" y="5" width="10" height="20" transform="translate(20,0)"',
    );
    expect(agent(doc, [{ op: "align", ids: ["a", "b"], to: "middle" }])).toHaveLength(2);
  });

  it("adds a layer as Inkscape does, and markup with ids for every element", async () => {
    const doc = parseXml(await poster());
    const out = writeXml(
      run(
        doc,
        agent(doc, [
          { op: "add_layer", name: "Note" },
          {
            op: "add_element",
            xml: '<g inkscape:label="logo"><circle r="2"/><rect width="1" height="1"/></g>',
            parent: "layer3",
          },
        ]),
      ),
    );
    expect(out).toContain('<g id="layer3" inkscape:groupmode="layer" inkscape:label="Note">');
    expect(out).toContain(
      '<g id="g1" inkscape:label="logo"><circle id="circle1" r="2"/><rect id="rect1" width="1" height="1"/></g>',
    );
  });

  it("refuses scripts, event handlers, outside links and undeclared prefixes", async () => {
    const doc = parseXml(await poster());
    const err = (ops: unknown[]) => {
      const r = svgFromAgent(doc, ops);
      return "error" in r ? r.error : "";
    };
    expect(err([{ op: "add_element", xml: "<script>alert(1)</script>" }])).toMatch(/not allowed/);
    expect(err([{ op: "add_element", xml: '<rect onload="x()"/>' }])).toMatch(/event handlers/);
    expect(
      err([
        { op: "set_attr", id: "uso1", name: "xlink:href", value: "https://evil.example/x.svg#a" },
      ]),
    ).toMatch(/outside/);
    expect(err([{ op: "set_style", id: "sole", fill: "url(http://evil.example/p)" }])).toMatch(
      /outside/,
    );
    expect(err([{ op: "add_element", xml: '<foo:bar id="z"/>' }])).toMatch(/prefix «foo:»/);
    expect(err([{ op: "delete", id: "nope" }])).toMatch(/no element «nope»/);
    expect(err([{ op: "group", ids: ["sole", "titolo"] }])).toMatch(/same parent/);
    expect(err([{ op: "frobnicate" }])).toMatch(/unknown operation/);
  });

  it("keeps Inkscape's attributes, metadata, unknown elements and decimals through many edits", async () => {
    const text = await poster();
    let doc = parseXml(text);
    doc = run(
      doc,
      agent(doc, [
        { op: "set_style", id: "titolo", fill: "#ff0000" },
        { op: "move", ids: ["sole", "uso1"], dx: 3, dy: 3 },
        { op: "add_shape", kind: "rect", x: 1, y: 1, w: 2, h: 2 },
        { op: "delete", id: "uso2" },
        { op: "set_text", id: "titolo", text: "Officina  2026" },
      ]),
    );
    const out = writeXml(doc);
    for (const kept of [
      'inkscape:version="1.3.2 (091e20e, 2023-11-25)"',
      'sodipodi:docname="poster-officina.svg"',
      "<sodipodi:namedview",
      'inkscape:current-layer="layer2"',
      "<dc:title>Poster di prova</dc:title>",
      'acme:locked="yes"',
      '<acme:extra\n       acme:note="non toccare">elemento sconosciuto</acme:extra>',
      'sodipodi:nodetypes="ccccccccccc"',
      "m 0,-10.123456 2.938926,5.954915",
      "stroke-width:0.264583",
      'data-role="background"',
      'inkscape:groupmode="layer"',
      'xml:space="preserve"',
      ">Officina  2026</tspan>",
      "Laboratorio <tspan",
      "<!-- Created with Inkscape (http://www.inkscape.org/) -->",
    ])
      expect(out).toContain(kept);
    // Every line nobody touched is the same line.
    const before = text.split("\n");
    const lines = new Set(out.split("\n"));
    const lost = before.filter((l) => !lines.has(l));
    expect(lost.length).toBeLessThan(12);
  });
});

describe("conflicts and moving over another's", () => {
  it("the same element conflicts; others do not; a name made by the other is followed", async () => {
    const doc = parseXml(await poster());
    const a: SvgAction = { t: "props", id: "sole", set: { fill: "red" } };
    const b: SvgAction = { t: "attrs", id: "sole", set: { r: "3" } };
    const c: SvgAction = { t: "props", id: "sfondo", set: { fill: "red" } };
    expect(actionsConflict(a, b)).toBe(true);
    expect(actionsConflict(a, c)).toBe(false);
    expect(actionsConflict({ t: "doc", text: "<svg/>" }, c)).toBe(true);
    const ref = [...virtualIds(doc).byRef.keys()][0] as string;
    const named: SvgAction = { t: "name", ref, id: "x1" };
    const mine: SvgAction = {
      t: "batch",
      ops: [
        { t: "name", ref, id: "y1" },
        { t: "props", id: "y1", set: { fill: "blue" } },
      ],
    };
    expect(mapAction(mine, named)).toEqual({
      t: "batch",
      ops: [{ t: "props", id: "x1", set: { fill: "blue" } }],
    });
    expect(mapAction(c, { t: "doc", text: "<svg/>" })).toBeUndefined();
  });
});

describe("structure, copies, Inkscape", () => {
  it("lists elements with ids, kinds, boxes, texts and paint", async () => {
    const doc = parseXml(await poster());
    const s = svgStructure(doc, 3, {});
    expect(s).toMatch(/^SVG drawing, revision 3: \d+ elements/);
    expect(s).toContain('svg #svg1  width="210mm" height="148mm" viewBox="0 0 210 148"');
    expect(s).toContain("sodipodi:namedview #namedview1 (kept as it is)");
    expect(s).toContain("defs #defs1: 4 definitions (linearGradient#linearGradient3");
    expect(s).toContain("g #layer1 [0 0 210 148]  layer «Sfondo»");
    expect(s).toContain("text #titolo [14.5 26.7 ");
    expect(s).toContain('"Officina 2026"');
    expect(s).toMatch(/rect #rgv-[0-9a-f]{8} \[14\.5 80 58 18\] {2}fill=#ffcc00/);
    expect(svgStructure(doc, 3, { fromLine: 2, toLine: 3 }).split("\n")).toHaveLength(3);
  });

  it("knows the SVG copy of an AI/EPS file and finds Inkscape", () => {
    expect(svgCopyOfOriginal("art/logo.ai")).toBe("art/logo.ai.open/logo.svg");
    expect(svgCopyOfOriginal("art/x.eps")).toBe("art/x.eps.open/x.svg");
    expect(svgCopyOfOriginal("art/x.svg")).toBeUndefined();
    expect(originalOfSvgCopy("art/logo.ai.open/logo.svg")).toBe("art/logo.ai");
    expect(originalOfSvgCopy("art/logo.svg")).toBeUndefined();
    const has = (p: string) =>
      p === "/usr/bin/inkscape" || p === "C:\\Program Files\\Inkscape\\bin\\inkscape.exe";
    expect(findInkscape("linux", { PATH: "/bin:/usr/bin" }, has, () => [])).toBe(
      "/usr/bin/inkscape",
    );
    expect(findInkscape("win32", { ProgramFiles: "C:\\Program Files" }, has, () => [])).toBe(
      "C:\\Program Files\\Inkscape\\bin\\inkscape.exe",
    );
    expect(
      findInkscape(
        "linux",
        { PATH: "/nowhere" },
        () => false,
        () => [],
      ),
    ).toBeUndefined();
    expect(
      findInkscape(
        "darwin",
        {},
        (p) => p === "/Applications/Inkscape.app",
        () => [],
      ),
    ).toBe("/Applications/Inkscape.app");
  });

  it("makes a PDF with Inkscape when it is there, with LibreOffice Draw otherwise", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const run = async (file: string, args: string[]) => {
      calls.push({ file, args });
      const out = args.find((a) => a.startsWith("--export-filename="))?.slice(18);
      if (out) await writeFile(out, "%PDF-ink");
      const dir = args[args.indexOf("--outdir") + 1];
      if (args.includes("--outdir") && dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "drawing.pdf"), "%PDF-lo");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const tmp = await mkdtemp(join(tmpdir(), "rg-svgpdf-"));
    const bytes = new TextEncoder().encode("<svg/>");
    const ink = await svgToPdf(bytes, {
      inkscape: "/usr/bin/inkscape",
      soffice: "/lo/soffice",
      tmpDir: tmp,
      profileDir: tmp,
      run,
    });
    expect(ink.by).toBe("inkscape");
    expect(new TextDecoder().decode(ink.bytes)).toBe("%PDF-ink");
    expect(calls[0]?.args.slice(0, 1)).toEqual(["--export-type=pdf"]);
    const lo = await svgToPdf(bytes, { soffice: "/lo/soffice", tmpDir: tmp, profileDir: tmp, run });
    expect(lo.by).toBe("libreoffice");
    expect(calls[1]?.args).toContain("pdf:draw_pdf_Export");
    await expect(svgToPdf(bytes, { tmpDir: tmp, profileDir: tmp, run })).rejects.toThrow(
      /Inkscape or LibreOffice/,
    );
    expect(inkscapeCli("/Applications/Inkscape.app", "darwin")).toBe(
      "/Applications/Inkscape.app/Contents/MacOS/inkscape",
    );
    await rm(tmp, { recursive: true, force: true });
  });

  it("refuses what is not an SVG it can keep", () => {
    expect(() => svgFamily.load(new TextEncoder().encode("<html/>"))).toThrow(/not <svg>/);
    expect(() => svgFamily.load(new Uint8Array([0x1f, 0x8b, 0]))).toThrow(/svgz/);
    expect(() => svgFamily.load(new Uint8Array([0xff, 0xfe, 0x3c, 0]))).toThrow(/UTF-8/);
  });
});

// ---- in the host ----------------------------------------------------------------------------

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };
const BOB = { id: "bob", name: "Bob", sessionId: "s-bob" };

function host() {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_o, f) => join(dir, "ws", f.path),
    settings: () => DEFAULT_EDITOR_SETTINGS,
    families: [svgFamily],
    saveDelayMs: 60_000,
    watchMs: 0,
  });
  hosts.push(h);
  return h;
}
const opsOf = (doc: XDoc, list: unknown[]): DocOp[] => {
  const r = svgFamily.fromAgent({ doc }, list);
  if ("error" in r) throw new Error(r.error);
  return r.ops;
};

describe("a drawing in the editor's host", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rg-svg-"));
    await mkdir(join(dir, "ws"), { recursive: true });
    const { db } = await memoryDb();
    await migrate(db);
    store = new EventStore(db);
  });
  afterEach(async () => {
    for (const h of hosts) await h.close();
    hosts = [];
    await rm(dir, { recursive: true, force: true });
  });

  it("agents and the person: applied, refused on the same element, rebased elsewhere, undone, saved, rebuilt", async () => {
    const file: DocFile = { scope: "platform", path: "poster.svg" };
    const text = await poster();
    await writeFile(join(dir, "ws", "poster.svg"), text);
    const h = host();
    const read = await h.read("me", file);
    const doc0 = (read.model as { doc: XDoc }).doc;
    const r1 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: opsOf(doc0, [{ op: "set_style", id: "sole", fill: "#ff0000" }]),
      groupId: "turn:1",
    });
    expect(r1).toMatchObject({
      ok: true,
      revision: 1,
      summary: { svg: { action: "style", n: 1, tag: "circle", id: "sole" } },
    });
    // Bob, on revision 0, on the same circle: refused.
    const r2 = await h.apply("me", file, {
      author: BOB,
      baseRevision: 0,
      ops: opsOf(doc0, [{ op: "move", id: "sole", dx: 1, dy: 0 }]),
      groupId: "turn:2",
    });
    expect(r2).toMatchObject({ ok: false, code: "conflict" });
    // Bob on another element: moved over Ada's.
    const r3 = await h.apply("me", file, {
      author: BOB,
      baseRevision: 0,
      ops: opsOf(doc0, [{ op: "add_shape", kind: "rect", x: 1, y: 1, w: 2, h: 2, id: "nuovo" }]),
      groupId: "turn:2",
    });
    expect(r3).toMatchObject({
      ok: true,
      revision: 2,
      rebased: true,
      summary: { svg: { action: "add", tag: "rect" } },
    });
    // The person names and changes an element without an id, as the page sends it.
    const ref = [...virtualIds(doc0).byRef.keys()][0] as string;
    const r4 = await h.apply("me", file, {
      author: { id: PERSON },
      baseRevision: 2,
      ops: [
        {
          family: "svg",
          engine: "svg-dom",
          engineVersion: "1",
          op: {
            t: "batch",
            ops: [
              { t: "name", ref, id: "svg_9" },
              { t: "props", id: "svg_9", set: { fill: "#00ff00" } },
            ],
          },
        },
      ],
      groupId: "g1",
    });
    expect(r4).toMatchObject({ ok: true, revision: 3 });
    // «Annulla questa modifica» on Ada's, not the last.
    const u = await h.undo("me", file, { revision: 1 }, { id: PERSON });
    expect(u).toMatchObject({ ok: true, revision: 4 });
    await h.flush();
    const disk = await readFile(join(dir, "ws", "poster.svg"), "utf8");
    expect(disk).toContain("fill:url(#radialSun)");
    expect(disk).toContain('<rect id="nuovo"');
    expect(disk).toContain('id="svg_9"');
    expect(disk).toContain("sodipodi:namedview");
    // Undo everything back: the very same bytes.
    await h.undo("me", file, { revision: 3 }, { id: PERSON });
    await h.undo("me", file, { revision: 2 }, { id: PERSON });
    await h.flush();
    expect(await readFile(join(dir, "ws", "poster.svg"), "utf8")).toBe(text);
    // A new host rebuilds from the log and the disk.
    const h2 = host();
    const again = await h2.read("me", file);
    expect(again.revision).toBe(6);
  });

  it("a change from outside is kept as its difference and can be undone", async () => {
    const file: DocFile = { scope: "platform", path: "a.svg" };
    const one = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r" width="1"/></svg>';
    await writeFile(join(dir, "ws", "a.svg"), one);
    const h = host();
    await h.read("me", file);
    await writeFile(join(dir, "ws", "a.svg"), one.replace('width="1"', 'width="2"'));
    const read = await h.read("me", file);
    expect(read.revision).toBe(1);
    const u = await h.undo("me", file, { revision: 1 }, { id: PERSON });
    expect(u).toMatchObject({ ok: true });
    await h.flush();
    expect(await readFile(join(dir, "ws", "a.svg"), "utf8")).toBe(one);
  });
});

// ---- from end to end ----------------------------------------------------------------------

type Req = { messages: { role: string; parts: { type: string; content?: string }[] }[] };
const resultOf = (req: Req) =>
  (
    req.messages.at(-1)?.parts.find((p) => p.type === "tool_result") as
      | { content: string }
      | undefined
  )?.content;
function calls(list: { name: string; input: unknown }[], seen: string[]) {
  let i = 0;
  return (req: Req) => {
    const r = resultOf(req);
    if (r !== undefined) seen.push(r);
    const next = list[i++];
    return next ? { toolCalls: [next] } : { text: "Done." };
  };
}

describe("a drawing from end to end (FakeProvider)", () => {
  let s: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it("help, structure, an edit the page sees highlighted, the file written in place", async () => {
    const seen: string[] = [];
    const file = { scope: "platform", path: "art/poster.svg" };
    s = await startServer(
      calls(
        [
          { name: "canvas_edit", input: { path: file.path, help: true } },
          { name: "canvas_look", input: { path: file.path, view: "structure" } },
          {
            name: "canvas_edit",
            input: {
              path: file.path,
              ops: [
                {
                  op: "add_shape",
                  kind: "rect",
                  x: 150,
                  y: 90,
                  w: 40,
                  h: 16,
                  rx: 3,
                  style: { fill: "#ffcc00" },
                  id: "promo",
                },
                {
                  op: "add_text",
                  x: 170,
                  y: 100,
                  text: "Gratis",
                  style: { font_size: 6, anchor: "middle" },
                },
                { op: "set_text", id: "titolo", text: "Officina  2027" },
              ],
            },
          },
          { name: "canvas_edit", input: { path: file.path, ops: [{ op: "delete", id: "nope" }] } },
        ],
        seen,
      ) as never,
      { contextWindow: 65_536 },
      { editor: { saveDelayMs: 0, watchMs: 0 } },
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sessionId = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
    ).body.sessionId;
    const root = await s.core.scopeFolder("me", "platform");
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    const text = await poster();
    await writeFile(join(root, file.path), text);
    const page = await wsClient(s.url);
    await page.waitFor("welcome");
    page.send({ type: "doc.open", file });
    const opened = await page.waitFor("doc.opened");
    expect(opened).toMatchObject({ family: "svg", revision: 0, snapshot: { family: "svg", text } });
    await (await s.core.send("me", sessionId, "Aggiungi un'etichetta")).done;
    expect(seen[0]).toMatch(/^Drawings \(svg/);
    expect(seen[0]).toContain('"op":"add_shape"');
    expect(seen[1]).toContain("revision 0. SVG drawing:");
    expect(seen[1]).toContain("text #titolo");
    expect(seen[2]).toMatch(/^Applied as revision 1: edited 3 elements/);
    expect(seen[3]).toMatch(/Nothing applied: operation 1: there is no element «nope»/);
    const info = await s.api<{ inkscape: boolean; pdf: string }>(
      "GET",
      `/api/editor/svg/info?scope=platform&path=${encodeURIComponent(file.path)}`,
    );
    expect(info.status).toBe(200);
    expect(typeof info.body.inkscape).toBe("boolean");
    expect(["inkscape", "libreoffice", "download", "missing"]).toContain(info.body.pdf);
    const changed = page.messages.filter(
      (m): m is Extract<ServerMessage, { type: "doc.changed" }> => m.type === "doc.changed",
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.change.summary.svg).toMatchObject({ action: "edit", n: 3 });
    await s.core.editor.flush();
    const disk = await readFile(join(root, file.path), "utf8");
    expect(disk).toContain(
      '<rect id="promo" x="150" y="90" width="40" height="16" rx="3" fill="#ffcc00" />',
    );
    expect(disk).toContain(">Officina  2027</tspan>");
    expect(disk).toContain("sodipodi:namedview");
    page.close();
  });
});
