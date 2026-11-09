// The sheet editor's page side (G37.3): the queue of the person's commands, others' revisions
// applied or resynchronised, the cells as numbers (the same as the server's), the panel's words.
import type { DocOp, SheetMutation } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { lang } from "../src/i18n.js";
import {
  cellPos,
  independent,
  posCell,
  SheetCollab,
  type SheetOutgoing,
  sheetKey,
  wroteAreas,
} from "../src/viewers/sheet-collab.js";
import { sheetChangeText } from "../src/viewers/sheet-words.js";

const values = (sheet: string, r: number, c: number, v: unknown): SheetMutation => ({
  id: "sheet.mutation.set-range-values",
  params: { unitId: "rg-sheet", subUnitId: sheet, cellValue: { [r]: { [c]: { v } } } },
});
const op = (...redo: SheetMutation[]): DocOp => ({
  family: "sheet",
  engine: "univer",
  engineVersion: "1.4.0",
  op: { redo, undo: [] },
});

describe("the sheet's queue", () => {
  it("one batch in flight, the rest waits and goes after the ack", () => {
    const sent: SheetOutgoing[] = [];
    const c = new SheetCollab((o) => sent.push(o));
    c.reset(4);
    c.local({ redo: [values("s1", 0, 0, 1)], undo: [values("s1", 0, 0, null)] });
    c.flush();
    c.local({ redo: [values("s1", 1, 0, 2)], undo: [] });
    c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.baseRevision).toBe(4);
    expect(c.ack(sent[0]?.clientId as string, 5)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.baseRevision).toBe(5);
  });

  it("others' cells apply; the same cell or rows going in reload from the host", () => {
    const c = new SheetCollab(() => {});
    c.reset(1);
    c.local({ redo: [values("s1", 2, 2, "mio")], undo: [] });
    c.flush();
    expect(c.remote(2, [op(values("s1", 5, 5, "altro"))])).toBe("apply");
    expect(c.remote(3, [op(values("s1", 2, 2, "stesso"))])).toBe("resync");
    const rows: SheetMutation = {
      id: "sheet.mutation.insert-row",
      params: { subUnitId: "s1", range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 9 } },
    };
    expect(independent([values("s1", 9, 9, 1)], [rows])).toBe(false);
    // Not the next revision: reload.
    expect(c.remote(9, [op(values("s1", 7, 7, 1))])).toBe("resync");
  });

  it("names a cell as one number, as the server does", () => {
    const pos = cellPos("s1", 41, 3);
    expect(posCell(pos)).toEqual({ key: sheetKey("s1"), r: 41, c: 3 });
    expect(wroteAreas([[cellPos("s1", 1, 1), cellPos("s1", 3, 1)]], ["s0", "s1"])).toEqual([
      { sheet: "s1", r0: 1, c0: 1, r1: 3, c1: 1 },
    ]);
  });
});

describe("the panel's words for a sheet", () => {
  it("says it in the person's language", () => {
    const was = lang.value;
    lang.value = "it";
    const s = (sheet: object) => ({ text: "x", kind: "edit" as const, sheet: sheet as never });
    expect(sheetChangeText(s({ action: "cells", n: 3, range: "B2:B4" }))).toBe(
      "Cambiate 3 celle in B2:B4",
    );
    expect(sheetChangeText(s({ action: "cells", n: 1, range: "B2" }))).toBe("Cambiata la cella B2");
    expect(sheetChangeText(s({ action: "insert_rows", n: 2, at: 5, name: "Spese" }))).toBe(
      "Inserite 2 righe alla riga 5 in «Spese»",
    );
    expect(sheetChangeText(s({ action: "delete_cols", n: 1, at: 3 }))).toBe(
      "Eliminata la colonna C",
    );
    expect(sheetChangeText(s({ action: "add_sheet", name: "Note" }))).toBe(
      "Aggiunto il foglio «Note»",
    );
    lang.value = "en";
    expect(sheetChangeText(s({ action: "sort", range: "A2:F15" }))).toBe(
      "Sorted the rows of A2:F15",
    );
    lang.value = was;
  });
});
