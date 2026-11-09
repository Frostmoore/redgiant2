// The drawing editor's routes (G37.6).
//   GET  /api/editor/svg/info?scope&path   {inkscape, pdf: inkscape|libreoffice|download|missing,
//                                          original?} (an AI/EPS copy says where it came from)
//   POST /api/editor/svg/export            «Esporta come PDF»: by Inkscape when installed (exact),
//                                          by LibreOffice otherwise (simple drawings)
//   POST /api/editor/svg/inkscape          «Apri in Inkscape»: the file, as last saved, opened in the
//                                          Inkscape installed on this computer (never downloaded)
// SVG and PNG are made in the page (the file itself, and the browser's picture of it).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocFile } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { execRunner, openInApp, type Runner } from "../convert-programs.js";
import { BadRequestError, NotFoundError, type RedGiantCore } from "../core.js";
import { findInkscape, svgOriginalName } from "./svg-family.js";

/** The program that runs Inkscape's command line (the app bundle's on macOS). */
export const inkscapeCli = (app: string, platform = process.platform) =>
  platform === "darwin" && app.endsWith(".app")
    ? posix.join(app, "Contents", "MacOS", "inkscape")
    : app;

/** A drawing as PDF: Inkscape's exact export, or LibreOffice Draw's import of simple drawings. */
export async function svgToPdf(
  bytes: Uint8Array,
  o: {
    inkscape?: string | undefined;
    soffice?: string | undefined;
    tmpDir: string;
    profileDir: string;
    run?: Runner;
  },
): Promise<{ bytes: Uint8Array; by: "inkscape" | "libreoffice" }> {
  const run = o.run ?? execRunner;
  const work = join(o.tmpDir, randomUUID());
  await mkdir(work, { recursive: true });
  try {
    const input = join(work, "drawing.svg");
    await writeFile(input, bytes);
    if (o.inkscape) {
      const out = join(work, "drawing.pdf");
      const r = await run(
        inkscapeCli(o.inkscape),
        ["--export-type=pdf", `--export-filename=${out}`, input],
        {
          cwd: work,
          timeoutMs: 120_000,
        },
      );
      const pdf = await readFile(out).catch(() => undefined);
      if (pdf) return { bytes: new Uint8Array(pdf), by: "inkscape" };
      if (!o.soffice)
        throw new Error(
          `Inkscape did not write the PDF: ${r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`}`,
        );
    }
    if (!o.soffice) throw new Error("making a PDF needs Inkscape or LibreOffice");
    const r = await run(
      o.soffice,
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        `-env:UserInstallation=${pathToFileURL(o.profileDir).href}`,
        "--convert-to",
        "pdf:draw_pdf_Export",
        "--outdir",
        join(work, "out"),
        input,
      ],
      { cwd: work, timeoutMs: 180_000 },
    );
    const pdf = await readFile(join(work, "out", "drawing.pdf")).catch(() => undefined);
    if (!pdf)
      throw new Error(
        `LibreOffice did not write the PDF: ${r.stderr.trim().split("\n").pop() || `exit ${r.exitCode}`}`,
      );
    return { bytes: new Uint8Array(pdf), by: "libreoffice" };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function svgRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  workDir: string = join(tmpdir(), "redgiant-svg"),
): void {
  const fileOf = (scope: unknown, path: unknown): DocFile => {
    if (typeof scope !== "string" || typeof path !== "string" || !scope || !path)
      throw new BadRequestError("Give scope and path");
    if (extname(path).toLowerCase() !== ".svg") throw new BadRequestError("Not an SVG drawing");
    return { scope, path };
  };
  const pdfWay = () =>
    findInkscape()
      ? ("inkscape" as const)
      : core.programs.find("libreoffice")
        ? ("libreoffice" as const)
        : core.programs.canDownload("libreoffice")
          ? ("download" as const)
          : ("missing" as const);

  app.get("/api/editor/svg/info", async (c) => {
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const original = svgOriginalName(file.path);
    return c.json(
      { inkscape: !!findInkscape(), pdf: pdfWay(), ...(original && { original }) },
      200,
    );
  });

  app.post("/api/editor/svg/export", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string; to?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    if (b.to !== "pdf")
      throw new BadRequestError(
        "A drawing is exported here as pdf (SVG and PNG are made in the page)",
      );
    const way = pdfWay();
    if (way === "missing")
      throw new NotFoundError("Making a PDF needs Inkscape or LibreOffice, and neither is here");
    if (way === "download") {
      void core.programs.ensure(o, "libreoffice").catch(() => {});
      return c.json(
        {
          error: "LibreOffice is coming down now (the first time only): try again in a while",
          waitsFor: "libreoffice",
        },
        409,
      );
    }
    // What the editor holds, written first.
    await core.editor.flush();
    const abs = await core.docAbs(o, file);
    const bytes = new Uint8Array(await readFile(abs));
    const out = await svgToPdf(bytes, {
      inkscape: way === "inkscape" ? findInkscape() : undefined,
      soffice: core.programs.find("libreoffice"),
      tmpDir: join(workDir, "export"),
      // A profile of its own: the other LibreOffice runs keep theirs locked.
      profileDir: join(workDir, "libreoffice-profile"),
    });
    const name = `${basename(file.path, extname(file.path))}.pdf`;
    return new Response(Buffer.from(out.bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-made-by": out.by,
      },
    });
  });

  app.post("/api/editor/svg/inkscape", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    const exe = findInkscape();
    if (!exe) throw new NotFoundError("Inkscape is not installed on this computer");
    await core.editor.flush();
    openInApp(exe, await core.docAbs(o, file));
    return c.json({ opened: true }, 200);
  });
}
