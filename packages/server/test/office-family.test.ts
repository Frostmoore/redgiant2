// The document family (G37.4) without LibreOffice: the outline read from ODF, the agent's
// operations turned into actions, each action's inverse, the places that conflict and how an
// action moves over another (tables), the catalog and the structure the agent reads.
import type { OfficeAction, OfficeOutline } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { copyOfOriginal, originalOfCopy } from "../src/editor/office-family.js";
import {
  actionsConflict,
  actionsFromAgent,
  applyAction,
  invertAction,
  mapAction,
  outlineHunks,
  outlineText,
  resolveStyle,
} from "../src/editor/office-ops.js";
import { readOutline } from "../src/editor/office-outline.js";
import { sampleOdp, sampleOdt } from "./fixtures/office-samples.js";

const none = () => undefined;
const odt = () => readOutline(sampleOdt());
const odp = () => readOutline(sampleOdp());
const agent = (o: OfficeOutline, ops: unknown[]) => {
  const r = actionsFromAgent(o, ops, none);
  if ("error" in r) throw new Error(r.error);
  return r.actions;
};
const run = (o: OfficeOutline, list: readonly OfficeAction[]) =>
  list.reduce((m, a) => applyAction(m, a, none), o);

describe("the outline", () => {
  it("reads a text's body as LibreOffice enumerates it", () => {
    const o = odt();
    if (o.app !== "writer") throw new Error("writer");
    expect(o.items.map((i) => (i.k === "p" ? `${i.style}|${i.text}` : `T|${i.name}`))).toEqual([
      "Title|Verbale di sopralluogo",
      "Heading 1|1. Stato dei luoghi",
      // The automatic style P1 derives from Text body; text:s and the line break kept.
      "Text body|Il prospetto  nord ha fessure.\nDa monitorare.",
      "Text body|Punto A1",
      "Text body|Punto B2",
      "T|Misure",
      "Text body|Nota nella sezione.",
      "Standard|",
      "Text body|Firmato: ing. Rossi.",
    ]);
    expect(o.items[1]).toMatchObject({ level: 1 });
    expect(o.items[3]).toMatchObject({ list: true });
    expect(o.items[5]).toMatchObject({
      rows: 2,
      cols: 2,
      cells: [
        ["Punto", "mm"],
        ["A1", "0,4"],
      ],
    });
    expect(o.items[7]).toMatchObject({ pics: 1 });
    expect(o.styles).toEqual(expect.arrayContaining(["Text body", "Heading 1", "Title"]));
  });

  it("reads slides and their shapes in order", () => {
    const o = odp();
    if (o.app !== "impress") throw new Error("impress");
    expect(
      o.slides.map((s) => [s.name, s.layout, s.shapes.map((x) => `${x.kind}:${x.text}`)]),
    ).toEqual([
      ["Copertina", 0, ["title:Piano cantieri 2027", "subtitle:Riunione di direzione"]],
      ["Obiettivi", 1, ["title:Obiettivi", "outline:Ridurre i tempi del 10%\nZero infortuni"]],
      ["Cantiere Nord", 19, ["title:Cantiere Nord", "picture:", "text:Consegna a marzo"]],
    ]);
    expect(o.slides[0]?.shapes[0]).toMatchObject({ x: 2000, y: 6000, w: 21000, h: 4000 });
  });

  it("refuses what is not a text or a presentation", () => {
    expect(() => readOutline(new TextEncoder().encode("hello"))).toThrow(/not a zip/);
  });
});

describe("the agent's operations", () => {
  it("replaces a piece of text once, refuses an ambiguous one, does all when asked", () => {
    const o = odt();
    const [a] = agent(o, [{ op: "replace_text", find: "nord", text: "settentrionale" }]);
    expect(a).toMatchObject({
      t: "text",
      at: { item: 2 },
      off: 14,
      del: "nord",
      ins: "settentrionale",
    });
    expect(
      actionsFromAgent(o, [{ op: "replace_text", find: "Punto", text: "P" }], none),
    ).toMatchObject({
      error: expect.stringMatching(/appears 3 times/),
    });
    const all = agent(o, [{ op: "replace_text", find: "Punto", text: "P", all: true }]);
    // Two paragraphs and a table cell.
    expect(all.map((x) => x.t)).toEqual(["text", "text", "cell"]);
    const after = run(o, all);
    expect(outlineText(after, {})).toContain("A1=P | B1=mm");
    expect(outlineText(after, {})).toContain("¶4 [Text body, list] P A1");
  });

  it("inserts paragraphs with a style the document has, after any item", () => {
    const o = odt() as Extract<OfficeOutline, { app: "writer" }>;
    expect(resolveStyle(o, "heading 2")).toBe("Heading 2");
    expect(resolveStyle(o, "Titolo 1")).toBe("Heading 1");
    expect(resolveStyle(o, "body")).toBe("Text body");
    expect(() => resolveStyle(o, "Fancy")).toThrow(/no paragraph style «Fancy»/);
    const list = agent(o, [
      { op: "insert_paragraph", after: 6, text: "2. Osservazioni", style: "Heading 1" },
      { op: "insert_paragraph", after: 7, text: "Prima riga\nSeconda riga" },
    ]);
    expect(list).toMatchObject([
      { t: "insert_item", at: 6, prev: "Misure", style: "Heading 1" },
      { t: "insert_item", at: 7, prev: "2. Osservazioni", text: "Prima riga", style: "Text body" },
      { t: "insert_item", at: 8, prev: "Prima riga", text: "Seconda riga" },
    ]);
    const after = run(o, list) as typeof o;
    expect(after.items[6]).toMatchObject({ k: "p", level: 1 });
    expect(after.items).toHaveLength(12);
  });

  it("tables, cells, styles and deletions", () => {
    const o = odt();
    const list = agent(o, [
      {
        op: "insert_table",
        after: 1,
        cells: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
      { op: "set_cell", table: 2, cell: "b2", text: "3" },
      { op: "set_style", paragraph: 4, style: "Heading 2" },
      { op: "delete_paragraph", paragraph: 10 },
    ]);
    const after = run(o, list);
    expect(outlineText(after, {})).toContain("T2 table «Table2» 2×2:");
    expect(outlineText(after, {})).toContain("B2=3");
    expect(outlineText(after, {})).toContain("¶4 [Heading 2]");
    expect(outlineText(after, {})).not.toContain("Firmato");
    // A paragraph holding a picture is not deleted (its picture could not come back).
    expect(actionsFromAgent(o, [{ op: "delete_paragraph", paragraph: 8 }], none)).toMatchObject({
      error: expect.stringMatching(/holds a picture/),
    });
  });

  it("slides: add, set a text, delete", () => {
    const o = odp();
    const list = agent(o, [
      { op: "add_slide", after: 2, layout: "title_content", title: "Tempi", text: "Marzo\nAprile" },
      { op: "set_slide_text", slide: 1, shape: "title", text: "Piano 2027" },
      { op: "delete_slide", slide: 4 },
    ]);
    const after = run(o, list);
    expect(outlineText(after, {})).toContain("Slide 3 «Tempi» (layout title_content):");
    expect(outlineText(after, {})).toContain("#2 outline: Marzo / Aprile");
    expect(outlineText(after, {})).toContain("Slide 1 «Piano 2027»");
    expect(outlineText(after, {})).not.toContain("Cantiere Nord");
    expect(actionsFromAgent(o, [{ op: "add_slide", layout: "fancy" }], none)).toMatchObject({
      error: expect.stringMatching(/layout/),
    });
    expect(actionsFromAgent(o, [{ op: "insert_paragraph", text: "x" }], none)).toMatchObject({
      error: expect.stringMatching(/for text documents/),
    });
  });

  it("says which operation failed and why", () => {
    expect(
      actionsFromAgent(
        odt(),
        [{ op: "set_style", paragraph: 2, style: "Title" }, { op: "explode" }],
        none,
      ),
    ).toEqual({
      error: 'unknown operation «explode» (call canvas_edit with "help": true)',
      index: 1,
    });
  });
});

describe("inverses", () => {
  const cases: [string, () => OfficeOutline, unknown[]][] = [
    ["replace", odt, [{ op: "replace_text", find: "fessure", text: "crepe" }]],
    ["insert", odt, [{ op: "insert_paragraph", after: 0, text: "In cima" }]],
    ["delete", odt, [{ op: "delete_paragraph", paragraph: 9 }]],
    ["style", odt, [{ op: "set_style", paragraph: 3, style: "Heading 2" }]],
    ["table", odt, [{ op: "insert_table", after: 9, rows: 2, cols: 3 }]],
    ["cell", odt, [{ op: "set_cell", table: 6, cell: "A2", text: "Z9" }]],
    ["delete table", odt, [{ op: "delete_table", table: 6 }]],
    ["slide", odp, [{ op: "add_slide", after: 0, title: "Prima" }]],
    ["slide text", odp, [{ op: "set_slide_text", slide: 2, text: "Uno\nDue" }]],
    ["delete slide", odp, [{ op: "delete_slide", slide: 2 }]],
  ];
  for (const [name, make, ops] of cases)
    it(`brings back the outline: ${name}`, () => {
      const o = make();
      let m = o;
      const inv: OfficeAction[] = [];
      for (const a of agent(o, ops)) {
        inv.unshift(invertAction(m, a, none));
        m = applyAction(m, a, none);
      }
      expect(run(m, inv)).toEqual(o);
    });
});

describe("conflicts and moving over (table)", () => {
  const o = odt();
  const one = (ops: unknown[]) => agent(o, ops)[0] as OfficeAction;
  const editP3 = one([{ op: "replace_text", find: "nord", text: "N" }]);
  const editP9 = one([{ op: "replace_text", find: "Firmato", text: "Visto" }]);
  const insertTop = one([{ op: "insert_paragraph", after: 0, text: "x" }]);
  const insertAfter2 = one([{ op: "insert_paragraph", after: 2, text: "y" }]);
  const insertAfter3 = one([{ op: "insert_paragraph", after: 3, text: "z" }]);
  const delete9 = one([{ op: "delete_paragraph", paragraph: 9 }]);
  const style3 = one([{ op: "set_style", paragraph: 3, style: "Heading 2" }]);
  const cases: [string, OfficeAction, OfficeAction, boolean][] = [
    ["the same paragraph", editP3, style3, true],
    ["two paragraphs", editP3, editP9, false],
    ["an insert before an edit", insertTop, editP3, false],
    ["two inserts at the same place", insertAfter2, insertAfter2, true],
    ["an insert after an edited paragraph", insertAfter3, editP3, true],
    ["a deletion and an edit of the same", delete9, editP9, true],
    ["a deletion and an edit far off", delete9, editP3, false],
  ];
  for (const [name, a, b, c] of cases)
    it(`${name}: ${c ? "conflict" : "no conflict"}`, () => {
      expect(actionsConflict(a, b)).toBe(c);
      expect(actionsConflict(b, a)).toBe(c);
    });

  it("an edit moves over an insert above it and lands on the same paragraph", () => {
    const moved = mapAction(editP9, insertTop);
    const after = applyAction(o, insertTop, none);
    expect(moved).toMatchObject({ at: { item: 9 } });
    expect(() => applyAction(after, moved, none)).not.toThrow();
    const back = mapAction(editP9, delete9);
    expect(back).toMatchObject({ at: { item: 8 } });
  });

  it("slides: the same shape conflicts, a slide deleted conflicts with its shapes", () => {
    const p = odp();
    const one2 = (ops: unknown[]) => agent(p, ops)[0] as OfficeAction;
    const title2 = one2([{ op: "set_slide_text", slide: 2, shape: "title", text: "A" }]);
    const body2 = one2([{ op: "set_slide_text", slide: 2, text: "B" }]);
    const del2 = one2([{ op: "delete_slide", slide: 2 }]);
    const add1 = one2([{ op: "add_slide", after: 1, title: "N" }]);
    expect(actionsConflict(title2, title2)).toBe(true);
    expect(actionsConflict(title2, body2)).toBe(false);
    expect(actionsConflict(del2, body2)).toBe(true);
    expect(actionsConflict(add1, body2)).toBe(false);
    expect(mapAction(body2, add1)).toMatchObject({ at: { slide: 2 } });
  });

  it("the person's saved file: its items found, others moved over it or left out", () => {
    const after = run(o, [insertTop, mapAction(editP3, insertTop)]);
    const hunks = outlineHunks(o, after);
    expect(hunks).toEqual([{ at: 0, del: 3, ins: 4 }]);
    const file: OfficeAction = { t: "file", blob: "a".repeat(64), size: 1, hunks };
    expect(actionsConflict(editP3, file)).toBe(true);
    expect(actionsConflict(editP9, file)).toBe(false);
    expect(mapAction(editP9, file)).toMatchObject({ at: { item: 9 } });
    // An agent's later edit made again after the person's file; a conflicting one left out.
    const f2 = mapAction(mapAction(file, editP9), style3);
    expect(f2).toMatchObject({ t: "file", replay: [{ t: "text", at: { item: 9 } }] });
  });
});

describe("open copies", () => {
  it("knows the copy of a closed document and the original of a copy", () => {
    expect(copyOfOriginal("docs/relazione.docx")).toBe("docs/relazione.docx.open/relazione.odt");
    expect(copyOfOriginal("piano.PPTX")).toBe("piano.PPTX.open/piano.odp");
    expect(copyOfOriginal("a.odt")).toBeUndefined();
    expect(originalOfCopy("docs/relazione.docx.open/relazione.odt")).toBe("docs/relazione.docx");
    expect(originalOfCopy("docs/relazione.odt")).toBeUndefined();
    expect(originalOfCopy("x.psd.open/x.ora")).toBeUndefined();
  });
});
