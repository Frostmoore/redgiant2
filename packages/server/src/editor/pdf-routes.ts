// The PDF editor's routes (G37.8).
//   GET  /api/editor/pdf/file?scope&path        the bytes of the head revision (the page shows them)
//   GET  /api/editor/pdf/outline?scope&path     its pages, annotations and fields, and the revision
//   POST /api/editor/pdf/blob                    a picture the person puts (a stamp, a signature)
//   POST /api/editor/pdf/redact                  the person's redaction: checked on the written
//                                                result first, then applied as their revision
//   GET  /api/editor/pdf/versions?scope&path     the versions kept before the file was written anew
//   GET  /api/editor/pdf/version?scope&path&name one of them, to download
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type DocFile, PdfRect, PERSON } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { BadRequestError, NotFoundError, type RedGiantCore } from "../core.js";
import type { PdfModel } from "./pdf-family.js";

const fileOf = (scope: string | undefined, path: string | undefined): DocFile => {
  if (!scope || !path) throw new BadRequestError("Give scope and path");
  return { scope, path };
};

const RedactBody = z.object({
  scope: z.string().min(1),
  path: z.string().min(1),
  /** 0-based. */
  page: z.number().int().nonnegative(),
  rects: z.array(PdfRect).min(1).max(200),
});

/** The biggest picture the person puts on a page. */
const MAX_PICTURE = 15 * 1024 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function pdfRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  const pdfOf = async (o: string, file: DocFile) => {
    const read = await core.editor.read(o, file);
    if (read.family.id !== "pdf") throw new BadRequestError("Not a PDF");
    return read;
  };

  app.get("/api/editor/pdf/file", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const read = await pdfOf(o, file);
    const bytes = await core.pdf.bytesOf(read.model as PdfModel);
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "cache-control": "no-store",
        "x-revision": String(read.revision),
      },
    });
  });

  app.get("/api/editor/pdf/outline", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const read = await pdfOf(o, file);
    return c.json({ revision: read.revision, outline: (read.model as PdfModel).outline }, 200);
  });

  app.post("/api/editor/pdf/blob", async (c) => {
    const o = owner(c);
    await core.docAbs(o, fileOf(c.req.query("scope"), c.req.query("path")));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_PICTURE)
      throw new BadRequestError("The picture is empty or too big (15 MB at most)");
    const mime =
      bytes[0] === 0x89 && bytes[1] === 0x50
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8
          ? "image/jpeg"
          : undefined;
    if (!mime) throw new BadRequestError("Only PNG and JPEG pictures go on a PDF page");
    return c.json({ blob: await core.editor.putBlob(bytes), mime }, 200);
  });

  app.post("/api/editor/pdf/redact", async (c) => {
    const o = owner(c);
    const b = RedactBody.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) throw new BadRequestError("Give scope, path, page and rects");
    const file = fileOf(b.data.scope, b.data.path);
    // An archived project's files are read only (2026-11-09).
    core.assertWritable(o, file.scope);
    const read = await pdfOf(o, file);
    // The same check as an agent's: the written file must have nothing under the areas.
    const made = await read.family.fromAgent(read.model, [
      { op: "redact", page: b.data.page + 1, rects: b.data.rects },
    ]);
    if ("error" in made) return c.json({ error: made.error }, 409);
    const out = await core.editor.apply(o, file, {
      author: { id: PERSON },
      baseRevision: read.revision,
      ops: made.ops,
      groupId: `g-${randomUUID().slice(0, 8)}`,
    });
    if (!out.ok) return c.json({ error: out.reason }, 409);
    return c.json({ revision: out.revision, summary: out.summary }, 200);
  });

  app.get("/api/editor/pdf/versions", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    await core.docAbs(o, file);
    const dir = core.pdf.versionsOf(o, file);
    const names = (await readdir(dir).catch(() => [] as string[])).sort().reverse();
    const versions = [];
    for (const name of names) {
      const st = await stat(join(dir, name)).catch(() => undefined);
      if (st?.isFile()) versions.push({ name, size: st.size, at: st.mtime.toISOString() });
    }
    return c.json({ versions }, 200);
  });

  app.get("/api/editor/pdf/version", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const name = c.req.query("name") ?? "";
    await core.docAbs(o, file);
    if (!/^[^/\\]+\.pdf$/i.test(name) || name.startsWith("."))
      throw new BadRequestError("Not a version");
    const bytes = await readFile(join(core.pdf.versionsOf(o, file), name)).catch(() => undefined);
    if (!bytes) throw new NotFoundError("That version is not kept anymore");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      },
    });
  });
}
