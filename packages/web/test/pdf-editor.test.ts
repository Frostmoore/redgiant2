// @vitest-environment jsdom
// The PDF editor's page side (G37.8): pdf.js's serialized editors become the family's actions, and
// a PDF's change is told in the person's words (it/en), in the panel «Modifiche» too.
import type { DocSummary, PdfOutline } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { changeText } from "../src/components/viewers/DocEditor.js";
import { editorActions, isPdfFile } from "../src/components/viewers/PdfEditor.js";
import { lang } from "../src/i18n.js";
import { pdfChangeText } from "../src/viewers/pdf-words.js";

const outline: PdfOutline = {
  pages: [
    {
      pid: "a",
      w: 595,
      h: 842,
      rotate: 0,
      annots: [{ id: "12R", ref: "12R", kind: "freetext", rect: [10, 10, 50, 30], text: "old" }],
    },
  ],
  fields: [],
};
let n = 0;
const id = () => `p-${++n}`;

describe("pdf.js's editors as the family's actions", () => {
  it("a highlight with its quadrilaterals and colour (0-255 → 0-1)", () => {
    n = 0;
    const out = editorActions(
      {
        annotationType: 9,
        pageIndex: 0,
        rect: [49, 784, 324, 809],
        color: [255, 255, 152],
        quadPoints: { 0: 50, 1: 808, 2: 323, 3: 808, 4: 50, 5: 785, 6: 323, 7: 785 },
        id: null,
      },
      outline,
      id,
    );
    expect(out).toEqual([
      {
        t: "annotate",
        a: {
          id: "p-1",
          page: 0,
          kind: "highlight",
          rect: [49, 784, 324, 809],
          quads: [50, 808, 323, 808, 50, 785, 323, 785],
          color: [1, 1, 152 / 255],
        },
      },
    ]);
  });

  it("a text box, a drawing from its points; an empty text box is nothing", () => {
    const text = editorActions(
      {
        annotationType: 3,
        pageIndex: 0,
        rect: [300, 284, 390, 304],
        value: "Nota",
        fontSize: 10,
        color: [0, 0, 0],
      },
      outline,
      id,
    );
    expect(text[0]).toMatchObject({
      t: "annotate",
      a: { kind: "freetext", text: "Nota", size: 10 },
    });
    const ink = editorActions(
      {
        annotationType: 15,
        pageIndex: 0,
        rect: [92, 363, 261, 429],
        thickness: 2,
        color: [0, 0, 255],
        paths: { points: [new Float32Array([95.5, 396.6, 99.6, 391.6]), { 0: 1, 1: 2 }] },
      },
      outline,
      id,
    );
    expect(ink[0]).toMatchObject({
      t: "annotate",
      a: {
        kind: "ink",
        paths: [
          [95.5, 396.6, 99.6, 391.6],
          [1, 2],
        ],
        size: 2,
        color: [0, 0, 1],
      },
    });
    expect(
      editorActions(
        { annotationType: 3, pageIndex: 0, rect: [0, 0, 1, 1], value: " " },
        outline,
        id,
      ),
    ).toEqual([]);
  });

  it("an annotation of the file changed in pdf.js goes and comes back new; deleted, it only goes", () => {
    const moved = editorActions(
      { annotationType: 3, pageIndex: 0, id: "12R", rect: [20, 20, 60, 40], value: "new" },
      outline,
      id,
    );
    expect(moved.map((a) => a.t)).toEqual(["remove_annotation", "annotate"]);
    expect(moved[0]).toMatchObject({ page: 0, id: "12R" });
    const gone = editorActions(
      { annotationType: 3, pageIndex: 0, id: "12R", deleted: true },
      outline,
      id,
    );
    expect(gone).toEqual([
      { t: "remove_annotation", page: 0, id: "12R", info: outline.pages[0]?.annots[0] },
    ]);
    // A page that is not there.
    expect(
      editorActions({ annotationType: 9, pageIndex: 5, rect: [0, 0, 1, 1] }, outline, id),
    ).toEqual([]);
  });

  it("only .pdf files", () => {
    expect(isPdfFile("docs/Contratto.PDF")).toBe(true);
    expect(isPdfFile("docs/contratto.pdf.txt")).toBe(false);
  });
});

describe("a PDF's change in words", () => {
  const s = (pdf: DocSummary["pdf"], kind: DocSummary["kind"] = "edit"): DocSummary => ({
    text: "x",
    kind,
    pdf,
  });
  it.each([
    [
      { action: "annotate", page: 2, kind: "highlight" },
      "Evidenziato del testo a pagina 2",
      "Highlighted text on page 2",
    ],
    [
      { action: "annotate", page: 1, n: 3 },
      "3 annotazioni da pagina 1",
      "3 annotations from page 1",
    ],
    [
      { action: "remove_annotation", page: 4 },
      "Tolta un'annotazione a pagina 4",
      "Removed an annotation on page 4",
    ],
    [
      { action: "fill_field", field: "nome" },
      "Compilato il campo «nome»",
      "Filled the field «nome»",
    ],
    [{ action: "fill_field", n: 3 }, "Compilati 3 campi", "Filled 3 fields"],
    [
      { action: "rotate_page", page: 3, to: 90 },
      "Ruotata la pagina 3 a 90°",
      "Turned page 3 to 90°",
    ],
    [{ action: "delete_page", page: 2 }, "Tolta la pagina 2", "Took out page 2"],
    [
      { action: "move_page", page: 2, to: 1 },
      "Spostata la pagina 2 al posto 1",
      "Moved page 2 to position 1",
    ],
    [
      { action: "redact", page: 1, n: 1 },
      "Oscurata un'area a pagina 1",
      "Redacted an area on page 1",
    ],
    [
      { action: "redact", page: 1, n: 2 },
      "Oscurate 2 aree a pagina 1",
      "Redacted 2 areas on page 1",
    ],
    [{ action: "annotate", page: 1, kind: "signature" }, "Firma a pagina 1", "Signature on page 1"],
  ] as const)("%j", (pdf, it_, en) => {
    const was = lang.value;
    lang.value = "it";
    expect(pdfChangeText(s(pdf))).toBe(it_);
    // The panel's words are these too.
    expect(changeText(s(pdf))).toBe(it_);
    lang.value = "en";
    expect(pdfChangeText(s(pdf))).toBe(en);
    lang.value = was;
  });
  it("an undo keeps the shell's own words", () => {
    const was = lang.value;
    lang.value = "it";
    expect(changeText(s({ action: "annotate", page: 1 }, "undo"))).not.toContain("pagina");
    lang.value = was;
  });
});
