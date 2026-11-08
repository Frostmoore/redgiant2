// The sheet family (G37.3) on its own and in the editor's host: CSV/TSV read and written back
// alike, an ODS read with its charts and pivot table as placeholders, the agent's plain operations
// as Univer's mutations (applied, undone, rebased, refused on the same cell), the agent's reading
// with computed formulas, and the «toppa» built from the changes (LibreOffice itself is a fake
// here; the real one runs in editor-sheet-lo.test.ts when REDGIANT_TEST_SOFFICE is set).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, migrate } from "@redgiant/events";
import { DEFAULT_EDITOR_SETTINGS, type DocFile, type DocOp, PERSON } from "@redgiant/protocol";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorHost } from "../src/editor/host.js";
import { excelToCalc, odfToExcel, parseArea } from "../src/editor/sheet/a1.js";
import { parseRows, readDelimited, writeDelimited } from "../src/editor/sheet/csv.js";
import { dropEngines } from "../src/editor/sheet/engine.js";
import type { SheetModel } from "../src/editor/sheet/model.js";
import { readOds } from "../src/editor/sheet/ods.js";
import { sheetConflicts, sheetMap } from "../src/editor/sheet/ops.js";
import { buildPatch, pythonFor } from "../src/editor/sheet/toppa.js";
import { sheetFamily } from "../src/editor/sheet-family.js";
import { memoryDb } from "./pglite.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "sheets", "vendite.ods");
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const fam = sheetFamily({ libreoffice: () => undefined, profileDir: "/nowhere", tmpDir: tmpdir() });

async function agent(model: SheetModel, ops: unknown[]): Promise<DocOp[]> {
  const out = await fam.fromAgent(model, ops);
  if ("error" in out) throw new Error(out.error);
  return out.ops;
}
const applyAll = (m: SheetModel, ops: DocOp[]) => ops.reduce((x, op) => fam.apply(x, op), m);
const cell = (m: SheetModel, sheet: string, r: number, c: number) =>
  m.wb.sheets[sheet]?.cellData[r]?.[c];

afterAll(() => dropEngines());

describe("addresses and formulas", () => {
  it.each([
    ["of:=[.D4]*[.E4]", "=D4*E4"],
    ["of:=SUM([.F4:.F15])", "=SUM(F4:F15)"],
    ["of:=MAX([$Vendite.F4:.F16])", "=MAX(Vendite!F4:F16)"],
    [
      'of:=SUMIF([$Vendite.B4:.B15];"Nord";[$Vendite.F4:.F15])',
      '=SUMIF(Vendite!B4:B15,"Nord",Vendite!F4:F15)',
    ],
    ["of:=[$'Le spese'.A1]&\"a;b\"", "='Le spese'!A1&\"a;b\""],
  ])("ODS %s reads as %s", (odf, excel) => expect(odfToExcel(odf)).toBe(excel));

  it.each([
    ["=SUM(B2:B5)", "=SUM(B2:B5)"],
    ["=IF(A1>1,1,2)", "=IF(A1>1;1;2)"],
    ["=SUM(Vendite!F4:F15)", "=SUM($Vendite.F4:F15)"],
    ["='Le spese'!A1*2", "=$'Le spese'.A1*2"],
    ['=CONCAT(A1,"x,y")', '=CONCAT(A1;"x,y")'],
    ["=Città!B2", "=$Città.B2"],
  ])("Excel %s writes as %s for LibreOffice", (excel, calc) =>
    expect(excelToCalc(excel)).toBe(calc),
  );

  it("reads ranges with sheets, whole rows and columns", () => {
    expect(parseArea("B2:C4")?.area).toEqual({ r0: 1, c0: 1, r1: 3, c1: 2 });
    expect(parseArea("'Le spese'!A1")).toEqual({
      sheet: "Le spese",
      area: { r0: 0, c0: 0, r1: 0, c1: 0 },
    });
    expect(parseArea("B:C", 100, 10)?.area).toEqual({ r0: 0, c0: 1, r1: 99, c1: 2 });
    expect(parseArea("2:3", 100, 10)?.area).toEqual({ r0: 1, c0: 0, r1: 2, c1: 9 });
    expect(parseArea("nope")).toBeUndefined();
  });
});

describe("CSV and TSV", () => {
  it("keeps separator, quotes, line ends and the byte order mark", () => {
    const text = '\ufeffVoce;Importo;Nota\r\nLuce;60;"a; b"\r\nGas;45,5;"dice ""ciao"""\r\n';
    const { model, format } = readDelimited(enc(text), false);
    expect(format).toMatchObject({ sep: ";", eol: "\r\n", finalEol: true });
    expect(cell(model, "sheet1", 1, 1)).toMatchObject({ v: 60, t: 2 });
    // «45,5» is not a number here: kept as text, as it was.
    expect(cell(model, "sheet1", 2, 1)).toMatchObject({ v: "45,5", t: 1 });
    // The decoder drops the mark: the bytes below show it is there.
    expect(dec(writeDelimited(model, format))).toBe(text.slice(1));
    expect(writeDelimited(model, format).subarray(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
  });

  it("reads a TSV and a quoted line break", () => {
    expect(parseRows('a\t"b\nc"\td', "\t")).toEqual([["a", "b\nc", "d"]]);
    const { model, format } = readDelimited(enc("a\tb\n1\t2\n"), true);
    expect(format.sep).toBe("\t");
    expect(model.kind).toBe("tsv");
  });

  it("edits with the agent's words and writes formulas as text", async () => {
    const { model, format } = readDelimited(enc("Voce,Importo\nLuce,60\nGas,45\n"), false);
    const ops = await agent(model, [
      { op: "set", cell: "B3", value: 50 },
      { op: "set", cell: "B4", formula: "=SUM(B2:B3)" },
      { op: "insert_rows", before: 2 },
      { op: "set_range", range: "A2", values: [["Acqua", 30]] },
    ]);
    const after = applyAll(model, ops);
    const csv = dec(writeDelimited(after, format));
    expect(csv).toBe("Voce,Importo\nAcqua,30\nLuce,60\nGas,50\n,=SUM(B3:B4)\n");
    // A CSV keeps no merges or other sheets.
    const no = await fam.fromAgent(model, [{ op: "merge", range: "A1:B1" }]);
    expect("error" in no && no.error).toMatch(/one sheet of values/);
  });
});

describe("ODS read for the editor", () => {
  it("brings values, formulas, styles, merges and the placeholders", async () => {
    const { model, format } = readOds(new Uint8Array(await readFile(FIXTURE)));
    const names = model.wb.sheetOrder.map((id) => model.wb.sheets[id]?.name);
    expect(names).toEqual(["Vendite", "Pivot", "Riepilogo"]);
    const v = model.wb.sheetOrder[0] as string;
    expect(format.ids.Vendite).toBe(v);
    expect(cell(model, v, 0, 0)?.v).toBe("Vendite primo semestre 2026");
    expect(model.wb.sheets[v]?.mergeData).toContainEqual({
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 5,
    });
    expect(cell(model, v, 3, 5)).toMatchObject({ f: "=D4*E4", v: 497.5 });
    const title = cell(model, v, 0, 0);
    expect(model.wb.styles[title?.s as string]).toMatchObject({ bl: 1, fs: 16, ht: 2 });
    const kinds = model.placeholders.map((p) => p.kind).sort();
    expect(kinds).toEqual(["chart", "pivot"]);
    const pivot = model.placeholders.find((p) => p.kind === "pivot");
    expect(pivot).toMatchObject({
      name: "PivotRegioni",
      r0: 2,
      c0: 0,
      r1: 8,
      c1: 3,
      source: "Vendite!A3:F15",
    });
    expect(model.placeholders.find((p) => p.kind === "chart")?.source).toContain("Vendite!F4:F15");
    expect(model.kept).toEqual(expect.arrayContaining(["conditional formats", "print ranges"]));
  });

  it("refuses to write into a pivot table's output", async () => {
    const { model } = fam.load(new Uint8Array(await readFile(FIXTURE)), "vendite.ods");
    const out = await fam.fromAgent(model, [{ op: "set", sheet: "Pivot", cell: "B5", value: 1 }]);
    expect("error" in out && out.error).toMatch(/pivot table «PivotRegioni» at A3:D9/);
  });

  it("reads the sheet as the agent does, formulas with their values", async () => {
    const { model } = fam.load(new Uint8Array(await readFile(FIXTURE)), "vendite.ods");
    const ops = await agent(model, [{ op: "set", cell: "D4", value: 30 }]);
    const after = applyAll(model, ops);
    const text = await fam.structure(after, { fromLine: 1, toLine: 6 });
    expect(text).toContain("Sheets: «Vendite» A1:F16, «Pivot»");
    expect(text).toContain("chart");
    expect(text).toContain("pivot table «PivotRegioni» on «Pivot» A3:D9 (data Vendite!A3:F15)");
    expect(text).toMatch(
      /4\| A "gen" \| B "Nord" \| C "Alfa" \| D 30 \| E 19\.9 \[format [^\]]*\] \| F =D4\*E4 → 597/,
    );
  });
});

describe("operations", () => {
  it("say what they did in plain words", async () => {
    const { model } = readDelimited(enc("a,b\n1,2\n3,4\n"), false);
    const ops = await agent(model, [
      { op: "set_range", range: "B1:B3", values: [["x"], [20], [40]] },
    ]);
    expect(fam.summarize(model, ops).text).toBe("changed 3 cells in B1:B3");
    expect(fam.summarize(model, ops).sheet).toMatchObject({
      action: "cells",
      n: 3,
      range: "B1:B3",
    });
    const rows = await agent(model, [{ op: "insert_rows", before: 2, count: 2 }]);
    expect(fam.summarize(model, rows).sheet).toMatchObject({ action: "insert_rows", n: 2, at: 2 });
  });

  it("undo with Univer's own mutations", async () => {
    const { model } = readDelimited(enc("a,b\n1,2\n3,4\n"), false);
    const ops = await agent(model, [
      { op: "insert_rows", before: 2 },
      { op: "set", cell: "A2", value: "nuovo" },
      { op: "delete_cols", from: "B" },
    ]);
    let m = applyAll(model, ops);
    expect(cell(m, "sheet1", 1, 0)?.v).toBe("nuovo");
    for (const op of [...ops].reverse()) m = fam.apply(m, fam.invert(m, op));
    expect(dec(fam.save(m, fam.load(enc("a,b\n"), "x.csv").format))).toBe("a,b\n1,2\n3,4\n");
  });

  it("the same cell is a conflict; other cells move over inserted rows", async () => {
    const { model } = readDelimited(enc("a,b\n1,2\n3,4\n"), false);
    const [mine] = await agent(model, [{ op: "set", cell: "B3", value: 9 }]);
    const [theirs] = await agent(model, [{ op: "set", cell: "B3", value: 7 }]);
    const [other] = await agent(model, [{ op: "set", cell: "A1", value: "z" }]);
    const [rows] = await agent(model, [{ op: "insert_rows", before: 2 }]);
    expect(sheetConflicts(mine as never, theirs as never)).toBe(true);
    expect(sheetConflicts(mine as never, other as never)).toBe(false);
    // B3 made before a row went in above it lands on B4.
    const moved = sheetMap(mine as never, rows as never);
    const m = fam.apply(fam.apply(model, rows as DocOp), moved as DocOp);
    expect(cell(m, "sheet1", 3, 1)?.v).toBe(9);
    // A row taken out where the cell was: it cannot move.
    const [del] = await agent(model, [{ op: "delete_rows", from: 3 }]);
    expect(sheetMap(mine as never, del as never)).toBeUndefined();
  });
});

describe("the toppa", () => {
  it("turns the changes into a short patch, only what changed", async () => {
    const { model } = fam.load(new Uint8Array(await readFile(FIXTURE)), "vendite.ods");
    const ops = await agent(model, [
      { op: "set", cell: "D5", value: 99 },
      { op: "insert_rows", before: 10 },
      { op: "set_range", range: "A10", values: [["mar", "Nord", "Gamma", 40, 24.5, "=D10*E10"]] },
      { op: "set", sheet: "Riepilogo", cell: "A4", value: "Massimo" },
      { op: "set", sheet: "Riepilogo", cell: "B4", formula: "=MAX(Vendite!F4:F16)" },
      { op: "format", range: "A17:F17", bold: true, background: "#ddebf7" },
      { op: "add_sheet", name: "Note" },
    ]);
    const patch = buildPatch(model, ops);
    expect(patch.ops[0]).toEqual({
      op: "cells",
      sheet: "Vendite",
      cells: [{ r: 4, c: 3, set: { v: 99 } }],
    });
    expect(patch.ops[1]).toEqual({ op: "insert_rows", sheet: "Vendite", at: 9, count: 1 });
    const row = patch.ops.find(
      (o) => o.op === "cells" && o.cells.some((c) => c.r === 9 && c.c === 5),
    );
    expect(row && row.op === "cells" && row.cells.find((c) => c.c === 5)?.set).toEqual({
      f: "=D10*E10",
    });
    const max = patch.ops.find(
      (o) => o.op === "cells" && o.sheet === "Riepilogo" && o.cells.some((c) => c.c === 1),
    );
    expect(max && max.op === "cells" && max.cells[0]?.set).toEqual({ f: "=MAX($Vendite.F4:F16)" });
    const fmt = patch.ops.filter((o) => o.op === "cells" && o.cells.some((c) => c.style));
    expect(fmt.at(-1)).toMatchObject({
      op: "cells",
      sheet: "Vendite",
      cells: expect.arrayContaining([{ r: 16, c: 0, style: { bg: { rgb: "#ddebf7" } } }]),
    });
    expect(patch.ops.at(-1)).toEqual({ op: "add_sheet", name: "Note", at: 3 });
    expect(Object.keys(patch.ids)).toEqual(["Vendite", "Pivot", "Riepilogo", "Note"]);
  });

  it("finds LibreOffice's own Python beside soffice", () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(pythonFor("/lo/program/soffice", has(["/lo/program/python"]))).toBe(
      "/lo/program/python",
    );
    expect(pythonFor("C:/LO/program/soffice.exe", has(["C:/LO/program/python.exe"]))).toBe(
      "C:/LO/program/python.exe",
    );
  });
});

// ---- in the host ---------------------------------------------------------------------------

let dir: string;
let store: EventStore;
let hosts: EditorHost[] = [];
const ADA = { id: "ada", name: "Ada", sessionId: "s-ada" };

function host(families = [fam]) {
  const h = new EditorHost({
    store,
    dataDir: join(dir, "data"),
    resolve: async (_o, f) => join(dir, "ws", f.path),
    settings: () => DEFAULT_EDITOR_SETTINGS,
    families,
    saveDelayMs: 60_000,
    watchMs: 0,
  });
  hosts.push(h);
  return h;
}

describe("a sheet in the editor's host", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rg-sheet-"));
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
  it("a CSV: the agent's edit, the person's on another cell, undo, saved in place", async () => {
    const file: DocFile = { scope: "platform", path: "spese.csv" };
    await writeFile(join(dir, "ws", "spese.csv"), "Voce,Importo\nLuce,60\nGas,45\n");
    const h = host();
    const read = await h.read("me", file);
    const a = await agent(read.model as SheetModel, [{ op: "set", cell: "B2", value: 70 }]);
    const r1 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: a,
      groupId: "turn:1",
    });
    expect(r1).toMatchObject({ ok: true, revision: 1 });
    // The person, on revision 0 still, changes another cell: rebased, no conflict.
    const p = await agent(read.model as SheetModel, [{ op: "set", cell: "B3", value: 50 }]);
    const r2 = await h.apply("me", file, {
      author: { id: PERSON },
      baseRevision: 0,
      ops: p,
      groupId: "g1",
    });
    expect(r2).toMatchObject({ ok: true, revision: 2, rebased: true });
    // The agent on revision 0 again, on the cell the person changed: refused.
    const again = await agent(read.model as SheetModel, [{ op: "set", cell: "B3", value: 1 }]);
    const r3 = await h.apply("me", file, {
      author: ADA,
      baseRevision: 0,
      ops: again,
      groupId: "turn:1",
    });
    expect(r3).toMatchObject({ ok: false, code: "conflict" });
    // «Annulla questa modifica» on the agent's.
    const u = await h.undo("me", file, { revision: 1 }, { id: PERSON });
    expect(u).toMatchObject({ ok: true, revision: 3 });
    await h.flush();
    expect(await readFile(join(dir, "ws", "spese.csv"), "utf8")).toBe(
      "Voce,Importo\nLuce,60\nGas,50\n",
    );
  });

  it("an ODS waits for LibreOffice to save, and says so", async () => {
    const file: DocFile = { scope: "platform", path: "vendite.ods" };
    const bytes = await readFile(FIXTURE);
    await writeFile(join(dir, "ws", "vendite.ods"), bytes);
    let asked = 0;
    const waiting = sheetFamily({
      libreoffice: () => undefined,
      fetchLibreOffice: () => asked++,
      profileDir: join(dir, "p"),
      tmpDir: join(dir, "t"),
    });
    const h = host([waiting]);
    const said: unknown[] = [];
    await h.subscribe("me", file, { id: "page", send: (m) => said.push(m) });
    const read = await h.read("me", file);
    const ops = await agent(read.model as SheetModel, [{ op: "set", cell: "D5", value: 99 }]);
    await h.apply("me", file, { author: ADA, baseRevision: 0, ops, groupId: "turn:1" });
    await h.flush();
    expect(asked).toBe(1);
    expect(said.find((m) => (m as { type: string }).type === "doc.saved")).toMatchObject({
      waitsFor: "libreoffice",
      revision: 0,
    });
    // The file is untouched, the change is in the log.
    expect(Buffer.compare(await readFile(join(dir, "ws", "vendite.ods")), bytes)).toBe(0);
  });

  it("an ODS saved through the toppa (a fake LibreOffice that records the patch)", async () => {
    const file: DocFile = { scope: "platform", path: "vendite.ods" };
    const bytes = await readFile(FIXTURE);
    await writeFile(join(dir, "ws", "vendite.ods"), bytes);
    const specs: unknown[] = [];
    const fake = sheetFamily({
      libreoffice: () => "/lo/program/soffice",
      python: () => "/lo/program/python",
      profileDir: join(dir, "p"),
      tmpDir: join(dir, "t"),
      run: async (file, args) => {
        expect(file).toBe("/lo/program/python");
        specs.push(JSON.parse(await readFile(args[1] as string, "utf8")));
        return { stdout: '{"ok": true}\n', stderr: "" };
      },
    });
    const h = host([fake]);
    const said: unknown[] = [];
    await h.subscribe("me", file, { id: "page", send: (m) => said.push(m) });
    const read = await h.read("me", file);
    const ops = await agent(read.model as SheetModel, [{ op: "set", cell: "D5", value: 99 }]);
    await h.apply("me", file, { author: ADA, baseRevision: 0, ops, groupId: "turn:1" });
    await h.flush();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      ops: [{ op: "cells", sheet: "Vendite", cells: [{ r: 4, c: 3, set: { v: 99 } }] }],
      property: "RedGiantSheetIds",
    });
    expect(said.find((m) => (m as { type: string }).type === "doc.saved")).toEqual({
      type: "doc.saved",
      file,
      revision: 1,
    });
  });
});
