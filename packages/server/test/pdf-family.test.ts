// The PDF family (G37.8) without the server: the outline read with pdf-lib; annotations, fields and
// rotations written as an incremental update (the original's bytes stay at the head, with classic
// cross-references and with streams); every action and its inverse, on the outline and in the
// file; pages taken out and moved (the file written anew, the version before kept, a page coming
// back from it); conflicts and rebasing as tables; a redaction that really takes the text and the
// picture out (checked by pdf.js), and refuses when it cannot; the licences of what it carries.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocOp, PdfAction, PdfOutline, PdfPlainAction, PdfSource } from "@redgiant/protocol";
import { PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { PdfFamily, type PdfModel, wrapPdf } from "../src/editor/pdf-family.js";
import {
  actionsConflict,
  actionsFromAgent,
  applyAction,
  mapAction,
  mapIndex,
} from "../src/editor/pdf-ops.js";
import { loadPdf, readPdfOutline } from "../src/editor/pdf-outline.js";
import { parseContent, verifyRedaction } from "../src/editor/pdf-redact.js";
import { findWords, pageLines } from "../src/editor/pdf-text.js";
import { writePdf } from "../src/editor/pdf-write.js";
import { RED_PNG, samplePdf } from "./fixtures/pdf-samples.js";

const noBlob = async () => undefined;
const latin = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const eofs = (b: Uint8Array) => latin(b).split("%%EOF").length - 1;
/** An outline without what changes on every reading (page ids). */
const plain = (o: PdfOutline) => ({
  ...o,
  pages: o.pages.map(({ pid: _p, ...p }) => ({
    ...p,
    annots: p.annots.map(({ ref: _r, data: _d, ...a }) => a),
  })),
  fields: o.fields.map(({ pid: _p, ...f }) => f),
});

async function agent(bytes: Uint8Array, o: PdfOutline, raw: unknown[], prefix = "rg") {
  let n = 0;
  const r = await actionsFromAgent(o, raw, {
    find: (p, w) => findWords(bytes, p, w),
    newId: () => `${prefix}-${++n}`,
  });
  if ("error" in r) throw new Error(r.error);
  return r.actions;
}

const EDITS = [
  { op: "annotate", page: 1, kind: "highlight", find: "Mario Rossi" },
  { op: "annotate", page: 1, kind: "underline", find: "Garibaldi 12" },
  {
    op: "annotate",
    page: 1,
    kind: "freetext",
    at: [300, 300],
    text: "Nota dell'agente\nseconda riga",
  },
  { op: "annotate", page: 1, kind: "note", at: [500, 500], text: "una nota" },
  { op: "annotate", page: 2, kind: "ink", paths: [[100, 100, 150, 150, 200, 120]] },
  { op: "annotate", page: 2, kind: "square", rect: [60, 60, 120, 90] },
  { op: "fill_field", name: "nome", value: "Mario Rossi" },
  { op: "fill_field", name: "citta", value: "Milano" },
  { op: "fill_field", name: "consenso", value: true },
  { op: "fill_field", name: "piano", value: "pro" },
  { op: "rotate_page", page: 2, by: 90 },
];

describe("reading a PDF", () => {
  it("pages, the form's fields with their values, no annotations yet", async () => {
    const o = await readPdfOutline(await samplePdf());
    expect(o.pages.map((p) => [p.w, p.h, p.rotate, p.annots.length])).toEqual([
      [595, 842, 0, 0],
      [595, 842, 0, 0],
      [595, 842, 0, 0],
    ]);
    expect(o.fields.map((f) => [f.name, f.type, f.value, f.options ?? null])).toEqual([
      ["nome", "text", "", null],
      ["citta", "dropdown", "", ["Roma", "Milano", "Napoli"]],
      ["consenso", "checkbox", false, null],
      ["piano", "radio", "", ["base", "pro"]],
    ]);
    expect(o.fields.every((f) => f.pid === o.pages[0]?.pid)).toBe(true);
  });

  it("the lines of a page and where words are", async () => {
    const b = await samplePdf();
    const lines = (await pageLines(b, [0])).get(0) ?? [];
    expect(lines.map((l) => l.text)).toContain(
      "Il cliente Mario Rossi abita a Roma in via Garibaldi 12.",
    );
    const found = await findWords(b, 0, "mario  ROSSI");
    expect(found).toHaveLength(1);
    expect(found[0]?.rects[0]?.[1]).toBeLessThan(720);
    expect(found[0]?.rects[0]?.[3]).toBeGreaterThan(720);
    expect(await findWords(b, 0, "Topolino")).toEqual([]);
  });
});

describe("an incremental update", () => {
  it.each([false, true])(
    "annotations, fields, a rotation: the original stays at the head (cross-reference streams: %s)",
    async (streams) => {
      const b = await samplePdf({ streams });
      const o = await readPdfOutline(b);
      const actions = await agent(b, o, EDITS);
      const w = await writePdf(b, actions, noBlob);
      expect(w.rewrote).toBe(false);
      // The first bytes are the original's, unchanged; one more end of file.
      expect(Buffer.from(w.bytes.subarray(0, b.length)).equals(Buffer.from(b))).toBe(true);
      expect(eofs(w.bytes)).toBe(eofs(b) + 1);
      expect(latin(w.bytes.subarray(b.length))).toMatch(streams ? /\/Type \/XRef/ : /\nxref\n/);
      const after = await readPdfOutline(w.bytes);
      expect(after.pages.map((p) => p.rotate)).toEqual([0, 90, 0]);
      expect(after.pages[0]?.annots.map((a) => [a.id, a.kind])).toEqual([
        ["rg-1", "highlight"],
        ["rg-2", "underline"],
        ["rg-3", "freetext"],
        ["rg-4", "note"],
      ]);
      expect(after.pages[1]?.annots.map((a) => a.kind)).toEqual(["ink", "square"]);
      expect(after.fields.map((f) => f.value)).toEqual(["Mario Rossi", "Milano", true, "pro"]);
      // What the model said before writing is what the file says after.
      expect(plain(after)).toEqual(plain(applyAction(o, { t: "batch", ops: actions })));
      // Another reader sees it: pdf.js.
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({ data: w.bytes.slice(), verbosity: 0 });
      const d = await task.promise;
      const an = await (await d.getPage(1)).getAnnotations();
      expect(an.map((a) => a.subtype)).toEqual(
        expect.arrayContaining(["Highlight", "Underline", "FreeText", "Text", "Widget"]),
      );
      expect(an.find((a) => a.fieldName === "nome")?.fieldValue).toBe("Mario Rossi");
      expect((await d.getPage(2)).rotate).toBe(90);
      await task.destroy();
      // A second save adds another section after the first, the original still at the head.
      const o2 = await readPdfOutline(w.bytes);
      const more = await agent(
        w.bytes,
        o2,
        [{ op: "annotate", page: 3, kind: "note", at: [50, 50], text: "x" }],
        "more",
      );
      const w2 = await writePdf(w.bytes, more, noBlob);
      expect(Buffer.from(w2.bytes.subarray(0, w.bytes.length)).equals(Buffer.from(w.bytes))).toBe(
        true,
      );
      expect(eofs(w2.bytes)).toBe(eofs(b) + 2);
    },
  );

  it("a stamp and a signature: a picture (a blob) and drawn strokes", async () => {
    const b = await samplePdf();
    const blobs = new Map([["a".repeat(64), RED_PNG]]);
    const w = await writePdf(
      b,
      [
        {
          t: "annotate",
          a: {
            id: "s1",
            page: 0,
            kind: "stamp",
            rect: [100, 100, 200, 150],
            image: { blob: "a".repeat(64), mime: "image/png" },
          },
        },
        {
          t: "annotate",
          a: {
            id: "s2",
            page: 0,
            kind: "signature",
            rect: [300, 100, 400, 140],
            paths: [[300, 110, 350, 130, 390, 112]],
          },
        },
      ],
      async (h) => blobs.get(h),
    );
    const o = await readPdfOutline(w.bytes);
    expect(o.pages[0]?.annots.map((a) => [a.id, a.kind])).toEqual([
      ["s1", "stamp"],
      ["s2", "signature"],
    ]);
    // A picture that is not kept anymore is said, not skipped.
    await expect(
      writePdf(
        b,
        [
          {
            t: "annotate",
            a: {
              id: "s3",
              page: 0,
              kind: "stamp",
              rect: [0, 0, 9, 9],
              image: { blob: "b".repeat(64), mime: "image/png" },
            },
          },
        ],
        noBlob,
      ),
    ).rejects.toThrow(/not here anymore/);
  });
});

/** The family with its blobs and versions in a folder of its own. */
async function family() {
  const dataDir = await mkdtemp(join(tmpdir(), "rg-pdf-"));
  const f = new PdfFamily({ dataDir });
  return { f, dataDir };
}
const file = { scope: "platform", path: "docs/contratto.pdf" };

describe("actions and their inverses", () => {
  it("every action, then its inverse: the outline and the file come back", async () => {
    const { f } = await family();
    const b = await samplePdf();
    const start = (await f.loadAsync(b)).model;
    const o = start.outline;
    const cases: unknown[][] = [
      [EDITS[0]],
      [EDITS[2], EDITS[4]],
      [{ op: "fill_field", name: "citta", value: "Roma" }],
      [{ op: "fill_field", name: "consenso", value: "yes" }],
      [{ op: "rotate_page", page: 1, by: 270 }],
      [{ op: "delete_page", page: 2 }],
      [{ op: "move_page", page: 3, to: 1 }],
    ];
    for (const raw of cases) {
      const made = await f.fromAgent(start, raw);
      if ("error" in made) throw new Error(made.error);
      let m: PdfModel = start;
      const inv: DocOp[] = [];
      for (const op of made.ops) {
        inv.unshift(f.invert(m, op));
        m = f.apply(m, op);
      }
      for (const op of inv) {
        expect(f.check(m, op)).toBeUndefined();
        m = f.apply(m, op);
      }
      expect(plain(m.outline)).toEqual(plain(o));
      // The file written with the action and its inverse reads back as the start.
      const back = await readPdfOutline(await f.bytesOf(m));
      expect(plain(back)).toEqual(plain(o));
    }
  });

  it("a page taken out comes back with its text, from the version kept", async () => {
    const { f, dataDir } = await family();
    const b = await samplePdf();
    const m0 = (await f.loadAsync(b)).model;
    const made = await f.fromAgent(m0, [{ op: "delete_page", page: 2 }]);
    if ("error" in made) throw new Error(made.error);
    const op = made.ops[0] as DocOp;
    const inv = f.invert(m0, op);
    const m1 = f.apply(m0, op);
    expect(m1.outline.pages).toHaveLength(2);
    // Written: anew (no incremental update), the version before kept with the editor's state.
    const r = await f.render(m1, {}, { ownerId: "me", file, abs: "/x", blob: f.blob });
    expect(eofs(r.bytes)).toBe(1);
    expect(r.model.outline.pages).toHaveLength(2);
    const vdir = f.versionsOf("me", file);
    const kept = await readdir(vdir);
    expect(kept).toHaveLength(1);
    expect(Buffer.from(await readFile(join(vdir, kept[0] as string))).equals(Buffer.from(b))).toBe(
      true,
    );
    expect(vdir.startsWith(dataDir)).toBe(true);
    // Undone after the save: the page comes back from the blob of the bytes before.
    const m2 = f.apply(r.model, inv);
    const lines = (await pageLines(await f.bytesOf(m2), [1])).get(1) ?? [];
    expect(lines.map((l) => l.text)).toContain("Qui il testo continua con altre parole.");
    expect(m2.outline.pages).toHaveLength(3);
  });

  it("only the last five versions are kept", async () => {
    const { f } = await family();
    let m = (await f.loadAsync(await samplePdf())).model;
    for (let i = 0; i < 7; i++) {
      const made = await f.fromAgent(m, [{ op: "move_page", page: 1, to: 2 }]);
      if ("error" in made) throw new Error(made.error);
      m = f.apply(m, made.ops[0] as DocOp);
      m = (await f.render(m, {}, { ownerId: "me", file, abs: "/x", blob: f.blob })).model;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await readdir(f.versionsOf("me", file))).toHaveLength(5);
  });

  it("what the agent cannot do is refused with the reason", async () => {
    const { f } = await family();
    const m = (await f.loadAsync(await samplePdf())).model;
    const err = async (raw: unknown) => {
      const r = await f.fromAgent(m, [raw]);
      return "error" in r ? r.error : "";
    };
    expect(await err({ op: "fill_field", name: "citta", value: "Parigi" })).toMatch(/not a choice/);
    expect(await err({ op: "fill_field", name: "nessuno", value: "x" })).toMatch(/no field/);
    expect(await err({ op: "annotate", page: 9, kind: "note", at: [1, 1] })).toMatch(/from 1 to 3/);
    expect(await err({ op: "annotate", page: 1, kind: "highlight", find: "Topolino" })).toMatch(
      /is not on page 1/,
    );
    expect(await err({ op: "rotate_page", page: 1, by: 45 })).toMatch(/90, 180 or 270/);
    expect(await err({ op: "remove_annotation", id: "nope" })).toMatch(/no annotation/);
    expect(await err({ op: "fly" })).toMatch(/not a PDF operation/);
    const one = (await f.loadAsync(await samplePdf({ form: false }))).model;
    let mm = one;
    for (const p of [3, 2]) {
      const made = await f.fromAgent(mm, [{ op: "delete_page", page: p }]);
      if ("error" in made) throw new Error(made.error);
      mm = f.apply(mm, made.ops[0] as DocOp);
    }
    const last = await f.fromAgent(mm, [{ op: "delete_page", page: 1 }]);
    expect("error" in last && last.error).toMatch(/last page/);
  });

  it("the catalog and the structure the agent reads", async () => {
    const { f } = await family();
    const m = (await f.loadAsync(await samplePdf())).model;
    expect(f.catalog()).toContain('{"op":"fill_field","name":"…","value":"…"}');
    expect(f.catalog()).toContain("redact");
    const s = await f.structure(m, {});
    expect(s).toContain("PDF, 3 pages.");
    expect(s).toContain('«citta» dropdown (Roma | Milano | Napoli), page 1 = ""');
    expect(s).toContain("Il cliente Mario Rossi abita a Roma in via Garibaldi 12.");
    expect(await f.structure(m, { fromLine: 3, toLine: 3 })).toContain(
      "Ultime parole del documento.",
    );
  });
});

describe("conflicts and rebasing (tables)", () => {
  const ann = (id: string, page: number): PdfPlainAction => ({
    t: "annotate",
    a: { id, page, kind: "note", rect: [0, 0, 20, 20] },
  });
  const info = { pid: "x", w: 595, h: 842, rotate: 0, annots: [] };
  const fill = (name: string): PdfPlainAction => ({
    t: "fill_field",
    name,
    value: "a",
    before: "",
  });
  const rot = (page: number): PdfPlainAction => ({ t: "rotate_page", page, to: 90, before: 0 });
  const del = (page: number): PdfPlainAction => ({ t: "delete_page", page, info });
  const move = (from: number, to: number): PdfPlainAction => ({ t: "move_page", from, to });
  const redact = (page: number): PdfPlainAction => ({
    t: "redact",
    page,
    rects: [[0, 0, 9, 9]],
    info,
  });
  it.each([
    ["two notes on the same page", ann("a", 0), ann("b", 0), false],
    [
      "the same annotation",
      ann("a", 0),
      {
        t: "remove_annotation",
        page: 0,
        id: "a",
        info: { id: "a", kind: "note", rect: [0, 0, 1, 1] },
      },
      true,
    ],
    ["the same field", fill("nome"), fill("nome"), true],
    ["two fields", fill("nome"), fill("citta"), false],
    ["the same page turned twice", rot(1), rot(1), true],
    ["two pages turned", rot(1), rot(2), false],
    ["a note on a page taken out", ann("a", 2), del(2), true],
    ["a note on another page than the one taken out", ann("a", 0), del(2), false],
    ["a redaction and a note on its page", redact(0), ann("a", 0), true],
    ["two moves of pages", move(0, 2), move(1, 0), true],
    ["a field and a page taken out", fill("nome"), del(0), false],
  ] as const)("%s → %s", (_l, a, b, want) => {
    expect(actionsConflict(a as PdfAction, b as PdfAction)).toBe(want);
    expect(actionsConflict(b as PdfAction, a as PdfAction)).toBe(want);
  });

  it.each([
    // [index, the action before, where the index is after it]
    [3, del(1), 2],
    [1, del(1), undefined],
    [0, del(1), 0],
    [0, move(0, 2), 2],
    [1, move(0, 2), 0],
    [2, move(0, 2), 1],
    [3, move(0, 2), 3],
    [0, move(2, 0), 1],
    [2, move(2, 0), 0],
    [
      1,
      {
        t: "restore_page",
        at: 1,
        info,
        source: { base: "a".repeat(64), ops: [] } as PdfSource,
        index: 1,
      },
      2,
    ],
  ] as const)("page %s after %j → %s", (i, b, want) => {
    expect(mapIndex(i, b as PdfAction)).toBe(want);
  });

  it("an annotation made before a page went is moved onto the page's new number", () => {
    expect(mapAction(ann("a", 3), del(1))).toMatchObject({ a: { page: 2 } });
    expect(() => mapAction(ann("a", 1), del(1))).toThrow(/not there anymore/);
    expect(mapAction(fill("nome"), del(0))).toEqual(fill("nome"));
  });

  it("the family's host side: the same, wrapped", async () => {
    const { f } = await family();
    expect(f.conflicts(wrapPdf(fill("nome")), wrapPdf(fill("nome")))).toBe(true);
    expect(f.map(wrapPdf(ann("a", 1)), wrapPdf(del(1)))).toBeUndefined();
    expect(f.map(wrapPdf(ann("a", 2)), wrapPdf(del(1)))).toMatchObject({ op: { a: { page: 1 } } });
  });
});

describe("redaction", () => {
  /** Every image object the file still holds. */
  async function images(bytes: Uint8Array): Promise<number> {
    const d = await loadPdf(bytes);
    let n = 0;
    for (const [, o] of d.context.enumerateIndirectObjects())
      if (o instanceof PDFRawStream) {
        const st = o.dict.get(PDFName.of("Subtype"));
        if (st instanceof PDFName && st.decodeText() === "Image") n++;
      }
    return n;
  }

  it.each([false, true])(
    "the words and the picture under the areas leave the file (streams: %s)",
    async (streams) => {
      const b = await samplePdf({ streams });
      const o = await readPdfOutline(b);
      expect(await images(b)).toBe(1);
      const actions = await agent(b, o, [
        { op: "redact", page: 1, find: "Mario Rossi" },
        { op: "redact", page: 1, rects: [[390, 590, 490, 690]] },
      ]);
      const w = await writePdf(b, actions, noBlob);
      expect(w.rewrote).toBe(true);
      // Written anew: one end of file, nothing of the original's sections.
      expect(eofs(w.bytes)).toBe(1);
      for (const a of actions)
        if (a.t === "redact")
          expect(await verifyRedaction(w.bytes, a.page, a.rects)).toBeUndefined();
      const lines = ((await pageLines(w.bytes, [0])).get(0) ?? []).map((l) => l.text);
      expect(lines).toContain("Il cliente abita a Roma in via Garibaldi 12.");
      expect(lines.join(" ")).not.toMatch(/Mario|Rossi/);
      // The picture is gone from the file, not only from the page's drawing.
      expect(await images(w.bytes)).toBe(0);
      // The rest of the file is as it was: other pages, the form.
      const after = await readPdfOutline(w.bytes);
      expect(after.fields.map((f) => f.name)).toEqual(["nome", "citta", "consenso", "piano"]);
      expect(((await pageLines(w.bytes, [1])).get(1) ?? []).map((l) => l.text)).toContain(
        "Qui il testo continua con altre parole.",
      );
      // The page's content says the black boxes.
      const page = (await loadPdf(w.bytes)).getPage(0);
      const contents = page.node.Contents();
      expect(contents).toBeDefined();
    },
  );

  it("covering is not redacting: the same areas on the original still have the words", async () => {
    const b = await samplePdf();
    const [m] = await findWords(b, 0, "Mario Rossi");
    expect(await verifyRedaction(b, 0, m?.rects ?? [])).toMatch(/text «.*Mario Rossi/);
    expect(await verifyRedaction(b, 0, [[390, 590, 490, 690]])).toBe("a picture");
  });

  it("a form field under the area is refused, and the agent is told before anything changes", async () => {
    const { f } = await family();
    const m = (await f.loadAsync(await samplePdf())).model;
    const r = await f.fromAgent(m, [{ op: "redact", page: 1, rects: [[60, 460, 300, 500]] }]);
    expect("error" in r && r.error).toMatch(/form field is under the area/);
    const ok = await f.fromAgent(m, [{ op: "redact", page: 1, find: "333 1234567" }]);
    expect("ops" in ok && ok.ops).toHaveLength(1);
  });

  it("marked content and the content's syntax are read", () => {
    const ops = parseContent(
      "q 1 0 0 1 10 10 cm BT /F1 12 Tf (a\\)b) Tj [<0041> -200 (c)] TJ ET /Span <</ActualText (x)>> BDC EMC BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI Q",
    );
    expect(ops.map((o) => o.op)).toEqual([
      "q",
      "cm",
      "BT",
      "Tf",
      "Tj",
      "TJ",
      "ET",
      "BDC",
      "EMC",
      "BI",
      "Q",
    ]);
    expect(ops[4]?.args[0]).toMatchObject({ k: "str", b: [97, 41, 98] });
  });
});

describe("licences of the PDF editor's server side (G37.8)", () => {
  const ALLOWED = new Set([
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Zlib",
  ]);
  /** Every licence named (with AND or OR) is one of them: stricter than the web's test. */
  const fine = (l: string) =>
    l
      .replace(/[()]/g, " ")
      .split(/\s+(?:AND|OR)\s+|\s+/)
      .filter(Boolean)
      .every((x) => ALLOWED.has(x));
  function walk(name: string, from: string, seen: Map<string, string>) {
    let d = from;
    let pj: string | undefined;
    for (;;) {
      const c = join(d, "node_modules", name, "package.json");
      if (existsSync(c)) {
        pj = realpathSync(c);
        break;
      }
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    if (!pj) return;
    const p = JSON.parse(readFileSync(pj, "utf8")) as {
      name: string;
      version: string;
      license?: string;
      dependencies?: Record<string, string>;
    };
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return;
    seen.set(key, String(p.license));
    for (const n of Object.keys(p.dependencies ?? {})) walk(n, dirname(pj), seen);
  }
  it("pdf-lib (MIT) and pdf.js (Apache-2.0) with everything they need", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const seen = new Map<string, string>();
    for (const n of ["pdf-lib", "@pdf-lib/standard-fonts", "pdfjs-dist"])
      walk(n, join(here, ".."), seen);
    expect([...seen.keys()].some((k) => k.startsWith("pdf-lib@1.17"))).toBe(true);
    expect([...seen.keys()].some((k) => k.startsWith("pdfjs-dist@6."))).toBe(true);
    const bad = [...seen].filter(([, l]) => !fine(l));
    expect(bad).toEqual([]);
    // pdf.js's own decoders (JBIG2, OpenJPEG, colour, QuickJS) carry their licences beside them.
    const wasm = join(
      dirname(realpathSync(join(here, "..", "node_modules", "pdfjs-dist", "package.json"))),
      "wasm",
    );
    expect(readdirSync(wasm).filter((f) => f.startsWith("LICENSE")).length).toBeGreaterThan(0);
  });
});
