// The «toppa» with a real LibreOffice (G37.3). Skipped unless REDGIANT_TEST_SOFFICE names a
// soffice (LibreOffice's own Python beside it is used); never in CI, where there is none.
//   REDGIANT_TEST_SOFFICE=/…/program/soffice pnpm exec vitest run packages/server/test/editor-sheet-lo.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocOp } from "@redgiant/protocol";
import { unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { dropEngines } from "../src/editor/sheet/engine.js";
import type { SheetModel } from "../src/editor/sheet/model.js";
import { readOds } from "../src/editor/sheet/ods.js";
import { sheetFamily } from "../src/editor/sheet-family.js";

const SOFFICE = process.env.REDGIANT_TEST_SOFFICE;
const FIXTURE = join(import.meta.dirname, "fixtures", "sheets", "vendite.ods");

describe.skipIf(!SOFFICE)("the toppa with a real LibreOffice", () => {
  afterAll(() => dropEngines());

  it("applies only the changes: charts, pivot table and formats stay, their ranges follow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-toppa-"));
    try {
      const fam = sheetFamily({
        libreoffice: () => SOFFICE,
        profileDir: join(dir, "profile"),
        tmpDir: join(dir, "tmp"),
      });
      const bytes = new Uint8Array(await readFile(FIXTURE));
      const { model, format } = fam.load(bytes, "vendite.ods");
      const made = await fam.fromAgent(model, [
        { op: "set", cell: "D5", value: 99 },
        { op: "insert_rows", before: 10 },
        { op: "set_range", range: "A10", values: [["mar", "Nord", "Gamma", 40, 24.5, "=D10*E10"]] },
        { op: "set", sheet: "Riepilogo", cell: "A4", value: "Massimo" },
        { op: "set", sheet: "Riepilogo", cell: "B4", formula: "=MAX(Vendite!F4:F16)" },
        { op: "format", range: "A17:F17", bold: true, background: "#ddebf7" },
        { op: "add_sheet", name: "Note" },
        { op: "set", sheet: "Note", cell: "A1", value: "scritto da RedGiant" },
      ]);
      if ("error" in made) throw new Error(made.error);
      let after: SheetModel = model;
      for (const op of made.ops as DocOp[]) after = fam.apply(after, op);
      const t0 = Date.now();
      const out = await fam.saveTo?.({
        ownerId: "me",
        file: { scope: "platform", path: "vendite.ods" },
        abs: join(dir, "vendite.ods"),
        model: after,
        format,
        before: model,
        ops: made.ops,
        bytes,
      });
      const ms = Date.now() - t0;
      expect(out).toBeDefined();
      const back = readOds(out as Uint8Array);
      const m = back.model;
      const v = m.wb.sheetOrder[0] as string;
      const cell = (sheet: string, r: number, c: number) => m.wb.sheets[sheet]?.cellData[r]?.[c];
      expect(cell(v, 4, 3)?.v).toBe(99);
      expect(cell(v, 9, 2)?.v).toBe("Gamma");
      expect(cell(v, 9, 5)).toMatchObject({ f: "=D10*E10", v: 980 });
      // The row went in: the totals' formulas, the chart and the pivot's source moved by themselves.
      expect(m.placeholders.find((p) => p.kind === "chart")?.source).toContain("Vendite!F4:F16");
      expect(m.placeholders.find((p) => p.kind === "pivot")?.source).toBe("Vendite!A3:F16");
      const names = m.wb.sheetOrder.map((id) => m.wb.sheets[id]?.name);
      expect(names).toEqual(["Vendite", "Pivot", "Riepilogo", "Note"]);
      // The sheets' ids kept in the file: the next load names them the same.
      const note = m.wb.sheetOrder[3] as string;
      expect(note).toBe(after.wb.sheetOrder[3]);
      expect(cell(note, 0, 0)?.v).toBe("scritto da RedGiant");
      const riep = m.wb.sheetOrder[2] as string;
      expect(cell(riep, 3, 1)?.f).toBe("=MAX(Vendite!F4:F16)");
      const total = cell(v, 16, 0);
      expect(m.wb.styles[total?.s as string]).toMatchObject({ bl: 1, bg: { rgb: "#ddebf7" } });
      expect(m.kept).toEqual(expect.arrayContaining(["conditional formats", "print ranges"]));
      // The chart object itself is still in the package.
      const files = unzipSync(out as Uint8Array);
      expect(Object.keys(files).some((k) => k.startsWith("GraficoTotali/"))).toBe(true);
      console.log(`toppa: ${ms} ms, ${bytes.length} → ${(out as Uint8Array).length} bytes`);

      // «Esporta come…»: an XLSX made from the saved ODS.
      const xlsx = await fam.exportAs(after, out as Uint8Array, "xlsx");
      expect(Object.keys(unzipSync(xlsx))).toContain("xl/workbook.xml");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
