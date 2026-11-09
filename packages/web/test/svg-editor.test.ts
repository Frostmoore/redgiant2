// @vitest-environment jsdom
// The drawing editor's page side (G37.6), without svgcanvas: virtual ids the same as the server's
// on an Inkscape file, others' actions applied to the page's DOM, the person's commands turned
// into the host's actions (elements named first), the queue, the panel's words, and our changes
// to svgcanvas applied to its real files (each exactly where expected).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DocSummary, SvgAction } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { virtualIds } from "../../server/src/editor/svg/ops.js";
import { parseXml } from "../../server/src/editor/svg/xml.js";
import { svgFamily } from "../../server/src/editor/svg-family.js";
import { lang } from "../src/i18n.js";
import {
  actionsOf,
  applyToDom,
  assignVirtualIds,
  type Caught,
  markupOf,
  type Namer,
  namespacesOf,
  SvgCollab,
  type SvgOutgoing,
  setInStyle,
  touchedIds,
} from "../src/viewers/svg-ops.js";
import { svgChangeText } from "../src/viewers/svg-words.js";
import { patchSvgcanvas, SVGCANVAS_PATCHES } from "../svgcanvas-patch.js";

const POSTER = readFileSync(
  join(import.meta.dirname, "..", "..", "server", "test", "fixtures", "svg", "poster-inkscape.svg"),
  "utf8",
);
const parse = (text: string) => new DOMParser().parseFromString(text, "image/svg+xml");

describe("virtual ids", () => {
  it("are the same in the page and on the server, for every element without an id", () => {
    const doc = parse(POSTER);
    const page = assignVirtualIds(doc.documentElement);
    const server = virtualIds(parseXml(POSTER)).byRef;
    expect([...page.keys()].sort()).toEqual([...server.keys()].sort());
    expect(page.size).toBe(9);
    // The badge's rectangle: the same element both sides (by its place in the tree).
    const rect = doc.querySelector('[id="gruppo1"] > rect');
    const ref = rect?.getAttribute("id") as string;
    expect(server.get(ref)).toBeTruthy();
  });

  it("tell apart two elements alike by their order", () => {
    const text =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/><rect width="1"/><rect width="2"/></svg>';
    const ids = [...assignVirtualIds(parse(text).documentElement).keys()];
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(`${ids[0]}-1`);
    expect([...virtualIds(parseXml(text)).byRef.keys()]).toEqual(ids);
  });
});

function target(text: string) {
  const doc = parse(text);
  const root = doc.documentElement;
  assignVirtualIds(root);
  return {
    doc,
    t: {
      root,
      byId: (id: string) => root.querySelector(`[id="${id}"]`),
      ns: namespacesOf(root),
    },
  };
}

describe("others' actions on the page", () => {
  it("attributes, styles where they are, texts, inserts, moves, removals, names", () => {
    const { doc, t } = target(POSTER);
    const list: SvgAction[] = [
      { t: "props", id: "sole", set: { fill: "#123456", opacity: "0.5" } },
      { t: "attrs", id: "uso1", set: { transform: "translate(1,2)", "inkscape:label": "stella" } },
      { t: "inner", id: "tspan1", xml: "Officina  2027" },
      {
        t: "insert",
        parent: "layer2",
        before: "onda",
        xml: '<rect id="nuovo" width="3" height="4" inkscape:label="x" />',
      },
      { t: "move", id: "uso2", parent: "layer1", before: null },
      { t: "remove", id: "sottotitolo" },
    ];
    expect(applyToDom(t, list)).toBe("ok");
    const sole = doc.getElementById("sole");
    expect(sole?.getAttribute("style")).toBe(
      "fill:#123456;stroke:#f2a516;stroke-width:0.529167;stroke-opacity:1",
    );
    expect(sole?.getAttribute("opacity")).toBe("0.5");
    expect(
      doc
        .getElementById("uso1")
        ?.getAttributeNS("http://www.inkscape.org/namespaces/inkscape", "label"),
    ).toBe("stella");
    expect(doc.getElementById("titolo")?.textContent).toBe("Officina  2027");
    expect(doc.getElementById("nuovo")?.nextElementSibling?.id).toBe("onda");
    expect(doc.getElementById("uso2")?.parentElement?.id).toBe("layer1");
    expect(doc.getElementById("sottotitolo")).toBeNull();
    // An element that is not here: the page loads the file again.
    expect(applyToDom(t, [{ t: "remove", id: "nope" }])).toBe("reload");
    expect(applyToDom(t, [{ t: "doc", text: "<svg/>" }])).toBe("reload");
    const ref = doc.querySelector('[id="gruppo1"] > rect')?.getAttribute("id") as string;
    expect(applyToDom(t, [{ t: "name", ref, id: "rect9" }])).toBe("ok");
    expect(doc.getElementById("rect9")?.tagName).toBe("rect");
  });

  it("names the ids actions touch", () => {
    expect([
      ...touchedIds([
        {
          t: "batch",
          ops: [
            { t: "name", ref: "rgv-1", id: "a" },
            { t: "props", id: "a", set: {} },
          ],
        },
      ]),
    ]).toEqual(["rgv-1", "a"]);
    expect([
      ...touchedIds([{ t: "insert", parent: "", before: null, xml: '<g id="z"/>' }]),
    ]).toEqual(["z"]);
  });

  it("keeps a style's other properties as written", () => {
    expect(
      setInStyle("fill:red; stroke : blue;opacity:1", { stroke: "green", opacity: null }),
    ).toBe("fill:red; stroke :green");
  });
});

function namer(doc: Document, known: Set<string>): Namer {
  let n = 0;
  return {
    ref: (el) => (el === doc.documentElement ? "" : (el?.getAttribute("id") ?? undefined)),
    pageOnly: (el) => el.hasAttribute("data-rg-page"),
    known: (id) => known.has(id),
    fresh: () => `svg_${++n}`,
    ns: namespacesOf(doc.documentElement),
    tspanOf: (id) => (id === "titolo" ? "tspan1" : undefined),
  };
}

describe("the person's commands", () => {
  it("become actions, an element without an id named first, places followed by the new name", () => {
    const { doc } = target(POSTER);
    const known = new Set(
      Array.from(doc.getElementsByTagName("*")).map((e) => e.getAttribute("id") ?? ""),
    );
    const nm = namer(doc, known);
    const rect = doc.querySelector('[id="gruppo1"] > rect') as Element;
    const ref = rect.getAttribute("id") as string;
    const g = doc.getElementById("gruppo1") as Element;
    const renamed: string[] = [];
    const caught: Caught[] = [
      { k: "change", el: rect, id: ref, values: { fill: "#00ff00", x: "5", "#href": null } },
      { k: "move", el: rect, id: ref, parent: "layer2", before: "onda" },
      {
        k: "change",
        el: doc.getElementById("titolo") as Element,
        id: "titolo",
        values: { "#text": "Ciao  <mondo>" },
      },
      { k: "remove", el: g, id: "gruppo1" },
    ];
    const out = actionsOf(caught, nm, (_el, id) => renamed.push(id));
    expect(out).toEqual([
      { t: "name", ref, id: "svg_1" },
      { t: "attrs", id: "svg_1", set: { x: "5" } },
      { t: "props", id: "svg_1", set: { fill: "#00ff00", "#href": null } },
      { t: "move", id: "svg_1", parent: "layer2", before: "onda" },
      // An Inkscape text's words go to its tspan.
      { t: "inner", id: "tspan1", xml: "Ciao  &lt;mondo&gt;" },
      { t: "remove", id: "gruppo1" },
    ]);
    expect(renamed).toEqual(["svg_1"]);
    expect(rect.getAttribute("id")).toBe("svg_1");
    // What the server makes of them, on its own copy of the file.
    let model = svgFamily.load(new TextEncoder().encode(POSTER)).model;
    for (const a of out) {
      const op = { family: "svg" as const, engine: "svg-dom" as const, engineVersion: "1", op: a };
      expect(svgFamily.check(model, op)).toBeUndefined();
      model = svgFamily.apply(model, op);
    }
  });

  it("writes new markup without the page's noise or the root's namespaces", () => {
    const { doc } = target(POSTER);
    const el = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("id", "svg_3");
    el.setAttribute("width", "4");
    el.setAttribute("style", "pointer-events:inherit");
    el.setAttributeNS("http://svg-edit.googlecode.com", "se:nonce", "1");
    expect(markupOf(el, namer(doc, new Set()))).toBe('<rect id="svg_3" width="4" />');
  });
});

describe("the queue", () => {
  it("one batch in flight; typing and dragging keep the last value; others' meeting mine reload", () => {
    const sent: SvgOutgoing[] = [];
    const c = new SvgCollab((o) => sent.push(o));
    c.reset(3);
    c.local([{ t: "inner", id: "t", xml: "C" }]);
    c.local([{ t: "inner", id: "t", xml: "Ci" }]);
    c.local([{ t: "props", id: "r", set: { fill: "#111111" } }]);
    c.local([{ t: "props", id: "r", set: { fill: "#222222", opacity: "1" } }]);
    c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.actions).toEqual([
      {
        t: "batch",
        ops: [
          { t: "inner", id: "t", xml: "Ci" },
          { t: "props", id: "r", set: { fill: "#222222", opacity: "1" } },
        ],
      },
    ]);
    // Someone else on another element: applied; on mine: reload.
    expect(c.remote(4, [{ t: "props", id: "x", set: {} }])).toBe("apply");
    expect(c.remote(5, [{ t: "attrs", id: "r", set: {} }])).toBe("reload");
    expect(c.ack(sent[0]?.clientId as string, 5)).toBe(true);
    expect(c.remote(7, [])).toBe("reload");
  });
});

describe("the panel's words", () => {
  const s = (svg: DocSummary["svg"]): DocSummary => ({
    text: "x",
    kind: "edit",
    ...(svg && { svg }),
  });
  it.each([
    ["it", { action: "add", n: 1, tag: "rect", id: "promo" }, "Aggiunto: rettangolo «promo»"],
    ["it", { action: "add", n: 3 }, "Aggiunti 3 elementi"],
    [
      "it",
      { action: "style", n: 1, tag: "circle", id: "rgv-12345678" },
      "Cambiato lo stile: cerchio",
    ],
    ["it", { action: "group", n: 2 }, "Raggruppati 2 elementi"],
    ["en", { action: "text", n: 1, tag: "text", id: "titolo" }, "Text changed: text «titolo»"],
    ["en", { action: "transform", n: 4 }, "4 elements moved or transformed"],
  ] as const)("%s %j", (l, svg, words) => {
    lang.value = l;
    expect(svgChangeText(s(svg as DocSummary["svg"]))).toBe(words);
    lang.value = "it";
  });
});

describe("our changes to svgcanvas", () => {
  it("apply to its real files, each where expected; a new svgcanvas stops the build", () => {
    const req = createRequire(join(import.meta.dirname, "..", "package.json"));
    const core = join(dirname(req.resolve("@svgedit/svgcanvas/package.json")), "core");
    for (const p of SVGCANVAS_PATCHES) {
      const name = p.file.source.match(/core\[\\\\\/\]([\w-]+)\\\.js/)?.[1] as string;
      const file = join(core, `${name}.js`);
      const out = patchSvgcanvas(file, readFileSync(file, "utf8"));
      expect(out, name).toBeDefined();
    }
    const sanitize = join(core, "sanitize.js");
    const patched = patchSvgcanvas(sanitize, readFileSync(sanitize, "utf8")) as string;
    expect(patched).toContain("a text's spaces are the person's");
    expect(patched).not.toContain("node.nodeValue = node.nodeValue.trim()");
    const history = join(core, "history.js");
    const h = patchSvgcanvas(history, readFileSync(history, "utf8")) as string;
    expect(h.match(/globalThis\.__rgSvgCommand/g)).toHaveLength(4);
    expect(h).toContain("static rgName = 'ChangeElementCommand'");
    expect(patchSvgcanvas("/x/other.js", "x")).toBeUndefined();
    expect(() => patchSvgcanvas(sanitize, "nothing to patch")).toThrow(/found 0 times/);
  });
});
