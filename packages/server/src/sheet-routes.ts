// The sheet editor's routes for the page (G37.3).
//   GET  /api/files/sheet-export?scope=…&path=…&to=xlsx|xls|csv|pdf|ods → the file in that format
//        (made by LibreOffice from the file as last saved; «Esporta come…», a download)
//   GET  /api/files/sheet-info?scope=…&path=… → {libreoffice: here?, canDownload, original?}
//        (what saving needs, and the closed original an open copy came from)
import { readFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { DocFile } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { BadRequestError, type RedGiantCore } from "./core.js";
import { SaveWaits } from "./editor/family.js";

const TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function sheetRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  const fileOf = (c: Context<E>): DocFile => {
    const scope = c.req.query("scope");
    const path = c.req.query("path");
    if (!scope || !path) throw new BadRequestError("Give scope and path");
    return { scope, path };
  };

  app.get("/api/files/sheet-info", async (c) => {
    const o = owner(c);
    const file = fileOf(c);
    const abs = await core.docAbs(o, file);
    const dir = dirname(abs);
    const original = dir.endsWith(".open") ? basename(dir.slice(0, -".open".length)) : undefined;
    return c.json(
      {
        libreoffice: core.programs.find("libreoffice") !== undefined,
        canDownload: core.programs.canDownload("libreoffice"),
        ...(original && /\.(xlsx|xls)$/i.test(original) && { original }),
        ...(original && /\.(xlsm|numbers)$/i.test(original) && { original, noReexport: true }),
      },
      200,
    );
  });

  app.get("/api/files/sheet-export", async (c) => {
    const o = owner(c);
    const file = fileOf(c);
    const to = c.req.query("to") ?? "";
    if (!TYPES[to]) throw new BadRequestError("to is xlsx, xls, csv, pdf or ods");
    const fam = core.sheets;
    if (!fam.accepts(file.path)) throw new BadRequestError("Not a sheet the editor knows");
    // What the editor still holds is written first.
    await core.editor.flush();
    const abs = await core.docAbs(o, file);
    const bytes = new Uint8Array(await readFile(abs));
    const { model } = fam.load(bytes, file.path);
    let out: Uint8Array;
    try {
      out = await fam.exportAs(model, bytes, to as "xlsx");
    } catch (err) {
      if (err instanceof SaveWaits) {
        void core.programs.ensure(o, "libreoffice").catch(() => {});
        return c.json({ error: err.message, waitsFor: err.waitsFor }, 409);
      }
      throw err;
    }
    const name = `${basename(abs, extname(abs))}.${to}`;
    return new Response(Buffer.from(out), {
      headers: {
        "content-type": TYPES[to] as string,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  });
}
