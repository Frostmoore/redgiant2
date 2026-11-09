// The document editor's routes (G37.4).
//   GET  /zeta/<file>                    the isolated frame and ZetaOffice's files (no login: free software)
//   GET  /api/editor/office              is the full editor here (OfficeEngineState)
//   POST /api/editor/office/prepare      its download, as a job with the bar
//   GET  /api/editor/office/file?scope&path&hash   the bytes a page loads (the file or a saved page's blob)
//   GET  /api/editor/blobs/:hash         a picture an action puts
//   POST /api/editor/office/upload?scope&path&base the file the page's editor saved: kept, read,
//                                        its changed items against revision `base`
//   POST /api/editor/office/replace      the person's find and replace (the editor without ZetaOffice)
//   POST /api/editor/office/copy         the open copy of a DOCX/PPTX… (made with its bar if missing)
//   POST /api/editor/office/export       «Esporta come…»: the document in another format, to download
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { type DocFile, PERSON } from "@redgiant/protocol";
import { LocalWorkspace } from "@redgiant/tools";
import type { Context, Hono } from "hono";
import { BadRequestError, NotFoundError, type RedGiantCore } from "../core.js";
import { parseScope } from "../files.js";
import { exportFilter } from "./office-engine.js";
import { copyOfOriginal, MAX_OFFICE_BYTES, type OfficeModel } from "./office-family.js";
import { outlineHunks } from "./office-ops.js";
import { readOutline } from "./office-outline.js";
import { serveFrameFile } from "./zeta.js";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const fileOf = (scope: string | undefined, path: string | undefined): DocFile => {
  if (!scope || !path) throw new BadRequestError("Give scope and path");
  return { scope, path };
};

/** The formats a document can be exported to, by its own. */
export const EXPORTS: Record<string, string[]> = {
  odt: ["docx", "doc", "rtf", "pdf", "odt"],
  odp: ["pptx", "ppt", "pdf", "odp"],
};

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function officeRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  webDir?: string,
): void {
  const office = core.office;
  const serverEngine = () =>
    core.programs.find("libreoffice")
      ? ("here" as const)
      : core.programs.canDownload("libreoffice")
        ? ("download" as const)
        : ("missing" as const);

  app.get("/zeta/lowa/:name", async (c) => {
    const r = await office.zeta.serve(c.req.param("name"), c.req.header("accept-encoding") ?? "");
    return r ?? c.text("Not found", 404);
  });
  app.get(
    "/zeta/LICENSES.txt",
    async (c) => (await office.zeta.serve("LICENSES.txt", "")) ?? c.text("", 404),
  );
  app.get("/zeta/:name", async (c) => {
    const r = webDir ? await serveFrameFile(webDir, c.req.param("name")) : undefined;
    return r ?? c.text("Not found", 404);
  });

  app.get("/api/editor/office", async (c) => c.json(await office.zeta.state(serverEngine()), 200));

  app.post("/api/editor/office/prepare", async (c) => {
    const job = await office.zeta.prepare(owner(c));
    return c.json({ ready: job === undefined, ...(job && { job }) }, 200);
  });

  app.get("/api/editor/office/file", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const hash = c.req.query("hash") ?? "";
    const abs = await core.docAbs(o, file);
    let bytes = await core.editor.blob(hash);
    if (!bytes) {
      const disk = await readFile(abs).catch(() => undefined);
      if (disk && sha256(disk) === hash) bytes = new Uint8Array(disk);
    }
    if (!bytes) return c.json({ error: "The file changed: open it again" }, 409);
    return new Response(bytes, {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
  });

  app.get("/api/editor/blobs/:hash", async (c) => {
    const b = await core.editor.blob(c.req.param("hash"));
    if (!b) throw new NotFoundError("No such picture");
    return new Response(b, { headers: { "content-type": "application/octet-stream" } });
  });

  app.post("/api/editor/office/upload", async (c) => {
    const o = owner(c);
    const file = fileOf(c.req.query("scope"), c.req.query("path"));
    const base = Number(c.req.query("base"));
    if (!Number.isInteger(base) || base < 0) throw new BadRequestError("Give the base revision");
    await core.docAbs(o, file);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_OFFICE_BYTES)
      throw new BadRequestError("The saved file is empty or too big");
    let outline: ReturnType<typeof readOutline>;
    try {
      outline = readOutline(bytes);
    } catch (err) {
      throw new BadRequestError(
        `The page saved a file that cannot be read: ${(err as Error).message}`,
      );
    }
    const read = await core.editor.read(o, file);
    if (read.family.id !== "document") throw new BadRequestError("Not a document");
    const before = read.modelAt(base) as OfficeModel | undefined;
    if (!before)
      return c.json({ error: "That revision cannot be read back: open the file again" }, 409);
    const blob = await core.editor.putBlob(bytes);
    office.family.remember(blob, outline);
    return c.json({ blob, size: bytes.length, hunks: outlineHunks(before.outline, outline) }, 200);
  });

  app.post("/api/editor/office/replace", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string; find?: string; text?: string; all?: boolean }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    if (!b.find) throw new BadRequestError("Give the words to find");
    const read = await core.editor.read(o, file);
    const made = await read.family.fromAgent(read.model, [
      { op: "replace_text", find: b.find, text: b.text ?? "", all: b.all === true },
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

  app.post("/api/editor/office/copy", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    const copy = copyOfOriginal(file.path);
    if (!copy)
      throw new BadRequestError(`${basename(file.path)} is not a document with an open copy`);
    const root = await rootOf(core, o, file.scope);
    const ws = new LocalWorkspace(root);
    const here = await stat(await ws.resolve(copy)).catch(() => undefined);
    if (here?.isFile()) return c.json({ path: copy }, 200);
    const to = extname(copy).slice(1);
    const job = core.jobs.start(
      o,
      "convert_file",
      ["tool_download", "tool_unpack", "convert"],
      async (h) => {
        if (!core.programs.find("libreoffice")) await core.programs.ensure(o, "libreoffice", h);
        h.skip("tool_download");
        h.skip("tool_unpack");
        h.step("convert");
        return core.converter.convert(root, file.path, { owner: o, to: [to], signal: h.signal });
      },
      { name: basename(file.path) },
    );
    return c.json({ path: copy, job: job.id }, 202);
  });

  app.post("/api/editor/office/export", async (c) => {
    const o = owner(c);
    const b = await c.req
      .json<{ scope?: string; path?: string; to?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const file = fileOf(b.scope, b.path);
    const from = extname(file.path).slice(1).toLowerCase();
    const to = String(b.to ?? "").toLowerCase();
    if (!EXPORTS[from]?.includes(to) || !exportFilter(from, to))
      throw new BadRequestError(
        `A .${from} is exported as ${EXPORTS[from]?.join(", ") ?? "nothing"}`,
      );
    // What the editor has, written first.
    await core.editor.flush();
    const abs = await core.docAbs(o, file);
    const bytes = new Uint8Array(await readFile(abs));
    const out = to === from ? bytes : await office.engine.convert(o, bytes, from, to);
    const name = `${basename(file.path, extname(file.path))}.${to}`;
    return new Response(out, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  });
}

/** The folder of a scope, as the file explorer has it. */
async function rootOf(core: RedGiantCore, ownerId: string, scopeText: string): Promise<string> {
  const scope = parseScope(scopeText);
  if (scope.kind === "project") {
    const p = await core.projects.get(ownerId, scope.projectId);
    if (!p) throw new NotFoundError(`Project "${scope.projectId}" not found`);
    return p.path;
  }
  return scope.kind === "platform" ? core.platformPath(ownerId) : core.assistantsPath(ownerId);
}
