// LibreOffice headless applying the document family's actions (G37.4): what it writes, read back,
// is the outline the host computed (the JavaScript and LibreOffice count paragraphs, tables,
// slides and shapes alike); the inverses bring the file back; an action that does not fit is
// skipped and said. Needs LibreOffice with its Python (`uno`): skipped where they are missing
// (the CI), run with REDGIANT_LIBREOFFICE pointing at soffice. On Severino: docker run g37-lo-node:trixie
// (from g37-lo-full:trixie + node:24-trixie-slim + git; screenshots with mcr.microsoft.com/playwright:v1.64.1-noble).
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeAction, OfficeOutline, OfficePlainAction } from "@redgiant/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findLibreOffice } from "../src/convert-programs.js";
import { LibreOfficeEngine, pythonCandidates } from "../src/editor/office-engine.js";
import { actionsFromAgent, applyAction, invertAction } from "../src/editor/office-ops.js";
import { readOutline } from "../src/editor/office-outline.js";
import { PNG, sampleOdp, sampleOdt } from "./fixtures/office-samples.js";

const soffice = findLibreOffice("/nonexistent");
const hasUno =
  !!soffice &&
  pythonCandidates(soffice).some((py) => {
    try {
      execFileSync(py, ["-c", "import uno"], { stdio: "ignore", timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  });

const none = () => undefined;
let data: string;
let engine: LibreOfficeEngine;
const blob = "c".repeat(64);

beforeAll(async () => {
  data = await mkdtemp(join(tmpdir(), "rg-office-engine-"));
  await mkdir(join(data, "editor", "blobs"), { recursive: true });
  await writeFile(join(data, "editor", "blobs", blob), PNG);
  engine = new LibreOfficeEngine({
    programs: {
      find: () => soffice,
      ensure: async () => soffice as string,
      canDownload: () => false,
    },
    dataDir: data,
  });
});
afterAll(async () => {
  if (data) await rm(data, { recursive: true, force: true });
});

/** What both sides must agree on: kinds, texts and styles of items; slides' shape kinds and texts. */
const shape = (o: OfficeOutline) =>
  o.app === "writer"
    ? o.items.map((i) =>
        i.k === "p"
          ? `p|${i.style}|${i.text}|${i.pics ?? 0}`
          : `t|${i.rows}x${i.cols}|${JSON.stringify(i.cells)}`,
      )
    : o.slides.map((s) => s.shapes.map((x) => `${x.kind}|${x.text}`).join(" ; "));

function plan(o: OfficeOutline, ops: unknown[]) {
  const r = actionsFromAgent(o, ops, none);
  if ("error" in r) throw new Error(r.error);
  let m = o;
  const inverse: OfficeAction[] = [];
  for (const a of r.actions) {
    inverse.unshift(invertAction(m, a, none));
    m = applyAction(m, a, none);
  }
  return { actions: r.actions, after: m, inverse: inverse as OfficePlainAction[] };
}

const picture = { blob, mime: "image/png", w: 2000, h: 2000 };

describe.skipIf(!hasUno)("LibreOffice applies the actions", () => {
  it("a text document: what it writes is the outline the host computed, and the inverses bring it back", async () => {
    const bytes = (await engine.apply("me", sampleOdt(), [], "writer")).bytes;
    const o = readOutline(bytes);
    const p = plan(o, [
      { op: "replace_text", find: "nord", text: "settentrionale 😀" },
      { op: "insert_paragraph", after: 0, text: "Bozza", style: "Heading 2" },
      { op: "insert_paragraph", after: 7, text: "Dopo la tabella" },
      {
        op: "insert_table",
        after: 2,
        cells: [
          ["a", "b"],
          ["1", "2"],
        ],
      },
      { op: "insert_table", after: 8, rows: 1, cols: 2 },
      { op: "set_cell", table: 3, cell: "B2", text: "0,5" },
      { op: "set_style", paragraph: 5, style: "Heading 1" },
      { op: "delete_paragraph", paragraph: 13 },
      { op: "insert_image", after: 12, picture },
      { op: "insert_paragraph", text: "Fine" },
    ]);
    const r = await engine.apply("me", bytes, p.actions, "writer");
    expect(r.skipped).toEqual([]);
    const got = readOutline(r.bytes);
    expect(shape(got)).toEqual(shape(p.after));
    const back = await engine.apply("me", r.bytes, p.inverse, "writer");
    expect(back.skipped).toEqual([]);
    // The picture's paragraph comes back without it was deleted; everything else as it was.
    expect(shape(readOutline(back.bytes))).toEqual(shape(o));
  }, 120_000);

  it("a presentation: slides added (also before the first), texts set, deleted, a picture put", async () => {
    // Slides with LibreOffice's own placeholders, made by the engine (the sample's frames are not).
    const lo = readOutline((await engine.apply("me", sampleOdp(), [], "impress")).bytes);
    const seed = plan(lo, [
      {
        op: "add_slide",
        after: 3,
        layout: "title",
        title: "Piano cantieri 2027",
        text: "Riunione",
      },
      {
        op: "add_slide",
        after: 4,
        layout: "title_content",
        title: "Obiettivi",
        text: "Ridurre i tempi\nZero infortuni",
      },
      { op: "delete_slide", slide: 1 },
      { op: "delete_slide", slide: 1 },
    ]);
    const bytes = (await engine.apply("me", sampleOdp(), seed.actions, "impress")).bytes;
    const o = readOutline(bytes);
    expect(shape(o)).toEqual(shape(seed.after));
    const p = plan(o, [
      { op: "add_slide", after: 0, layout: "title", title: "Indice", text: "Sommario" },
      { op: "add_slide", after: 2, layout: "title_content", title: "Tempi", text: "Marzo\nAprile" },
      { op: "set_slide_text", slide: 4, shape: "subtitle", text: "Direzione, 12 novembre" },
      { op: "replace_text", find: "infortuni", text: "incidenti" },
      { op: "insert_image", slide: 3, picture, x_mm: 30, y_mm: 60 },
      { op: "delete_slide", slide: 2 },
    ]);
    const r = await engine.apply("me", bytes, p.actions, "impress");
    expect(r.skipped).toEqual([]);
    expect(shape(readOutline(r.bytes))).toEqual(shape(p.after));
    const back = await engine.apply("me", r.bytes, p.inverse, "impress");
    expect(back.skipped).toEqual([]);
    // The deleted slide comes back with its texts and shapes, not with a picture it had (said in
    // the summary of the deletion and in the catalog).
    expect(shape(readOutline(back.bytes))).toEqual(
      shape(o).map((x) => x.replace(" ; picture|", "")),
    );
  }, 120_000);

  it("an action that does not fit is skipped and said; the rest applies", async () => {
    const bytes = sampleOdt();
    const bad: OfficePlainAction = {
      t: "text",
      at: { item: 1 },
      expect: "Non c'è",
      off: 0,
      del: "x",
      ins: "y",
    };
    const good = plan(readOutline(bytes), [
      { op: "replace_text", find: "Firmato", text: "Visto" },
    ]).actions;
    const r = await engine.apply("me", bytes, [bad, ...good], "writer");
    expect(r.skipped).toEqual([{ index: 0, error: expect.stringMatching(/not what it was/) }]);
    expect(shape(readOutline(r.bytes)).at(-1)).toBe("p|Text body|Visto: ing. Rossi.|0");
  }, 120_000);

  it("writes a copy in a closed format and a PDF", async () => {
    const docx = await engine.convert("me", sampleOdt(), "odt", "docx");
    expect([...docx.subarray(0, 2)]).toEqual([0x50, 0x4b]);
    const pdf = await engine.convert("me", sampleOdp(), "odp", "pdf");
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
  }, 120_000);
});
