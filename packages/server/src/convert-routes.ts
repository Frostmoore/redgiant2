// The conversions for the web page (G34.3): what a file is and what it can become, and a
// conversion started as a job (the page follows its bar on /api/jobs/:id; its result is the
// list of open files made and what was lost).
//   GET  /api/files/convert?scope=…&path=…  → FileReport
//   POST /api/files/convert {scope, path, to?} → Job ("convert_file")
//   GET  /api/files/formats → every known format and the outside programs (name, licence, size)
//   POST /api/files/preview {scope, path} → {ready: true} at once if cached, else 202
//        {ready: false, job} ("preview_file", LibreOffice's download included the first time)
//   GET  /api/files/preview?scope=…&path=… → the paged preview (application/pdf), 404 until ready

import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { LocalWorkspace } from "@redgiant/tools";
import type { Context, Hono } from "hono";
import { ConvertError } from "./convert.js";
import { knownFormats } from "./convert-formats.js";
import { findDesktopApp, openInApp, PROGRAMS, type ProgramId } from "./convert-programs.js";
import { BadRequestError, NotFoundError, type RedGiantCore } from "./core.js";
import { parseScope } from "./files.js";

/** The folder of a scope, as the file explorer has it. */
async function rootOf(core: RedGiantCore, ownerId: string, scopeText: string): Promise<string> {
  const scope = parseScope(scopeText);
  if (scope.kind === "project") {
    const p = await core.projects.get(ownerId, scope.projectId);
    if (!p) throw new NotFoundError(`Project "${scope.projectId}" not found`);
    return p.path;
  }
  const dir = scope.kind === "platform" ? core.platformPath(ownerId) : core.assistantsPath(ownerId);
  await mkdir(dir, { recursive: true });
  return dir;
}

const asBadRequest = (err: unknown) =>
  err instanceof ConvertError ? new BadRequestError(err.message) : err;

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function convertRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  app.get("/api/files/formats", (c) =>
    c.json(
      {
        formats: knownFormats(),
        programs: (Object.keys(PROGRAMS) as ProgramId[]).map((id) => ({
          id,
          ...PROGRAMS[id],
          here: core.programs.find(id) !== undefined,
          canDownload: core.programs.canDownload(id),
        })),
      },
      200,
    ),
  );

  app.get("/api/files/convert", async (c) => {
    const root = await rootOf(core, owner(c), c.req.query("scope") ?? "");
    const path = c.req.query("path");
    if (!path) throw new BadRequestError("Give path");
    try {
      return c.json(await core.converter.inspect(root, path), 200);
    } catch (err) {
      throw asBadRequest(err);
    }
  });

  // One preview job per file version: a second request follows the same one.
  const previewJobs = new Map<string, string>();
  app.post("/api/files/preview", async (c) => {
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as { scope?: string; path?: string });
    if (!b.path || !b.scope) throw new BadRequestError("Give scope and path");
    const o = owner(c);
    const root = await rootOf(core, o, b.scope);
    const path = b.path;
    const state = await core.converter.previewState(root, path).catch((err) => {
      throw asBadRequest(err);
    });
    if (state.ready) return c.json({ ready: true }, 200);
    const running = previewJobs.get(state.pdf);
    const same = running ? core.jobs.get(o, running) : undefined;
    if (same?.state === "running") return c.json({ ready: false, job: same }, 202);
    const job = core.jobs.start(
      o,
      "preview_file",
      ["tool_download", "tool_unpack", "convert"],
      async (h) => {
        if (!core.programs.find("libreoffice")) await core.programs.ensure(o, "libreoffice", h);
        h.skip("tool_download");
        h.skip("tool_unpack");
        h.step("convert");
        await core.converter.preview(root, path, { owner: o, signal: h.signal });
        return { ready: true };
      },
      { name: path.split("/").pop() ?? path },
    );
    previewJobs.set(state.pdf, job.id);
    return c.json({ ready: false, job }, 202);
  });

  app.get("/api/files/preview", async (c) => {
    const root = await rootOf(core, owner(c), c.req.query("scope") ?? "");
    const path = c.req.query("path");
    if (!path) throw new BadRequestError("Give path");
    const state = await core.converter.previewState(root, path).catch((err) => {
      throw asBadRequest(err);
    });
    if (!state.ready) return c.json({ ready: false }, 404);
    const size = (await stat(state.pdf)).size;
    return new Response(Readable.toWeb(createReadStream(state.pdf)) as ReadableStream, {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(size),
        "cache-control": "private, max-age=3600",
      },
    });
  });

  // «Open in Affinity / InDesign» (G34.3): a file no free program reads, opened in the closed
  // app installed on this computer, so the person can export an open format beside it.
  app.post("/api/files/open-with", async (c) => {
    const b = await c.req
      .json<{ scope?: string; path?: string }>()
      .catch(() => ({}) as { scope?: string; path?: string });
    if (!b.path || !b.scope) throw new BadRequestError("Give scope and path");
    const root = await rootOf(core, owner(c), b.scope);
    const report = await core.converter.inspect(root, b.path).catch((err) => {
      throw asBadRequest(err);
    });
    const app = report.needs?.app;
    if (app !== "affinity" && app !== "indesign")
      throw new BadRequestError(`${b.path} does not need a desktop app`);
    const exe = findDesktopApp(app);
    if (!exe)
      throw new NotFoundError(`${report.needs?.name ?? app} is not installed on this computer`);
    openInApp(exe, await new LocalWorkspace(root).resolve(b.path));
    return c.json({ opened: true, app }, 200);
  });

  app.post("/api/files/convert", async (c) => {
    const b = await c.req
      .json<{ scope?: string; path?: string; to?: string[] | string }>()
      .catch(() => ({}) as { scope?: string; path?: string; to?: string[] | string });
    if (!b.path || !b.scope) throw new BadRequestError("Give scope and path");
    const o = owner(c);
    // An archived project's files are read only (2026-11-09).
    core.assertWritable(o, b.scope);
    const root = await rootOf(core, o, b.scope);
    const to = b.to === undefined ? undefined : Array.isArray(b.to) ? b.to : [b.to];
    const path = b.path;
    // Checked now, so a wrong path is a 400 and not a failed job.
    const report = await core.converter.inspect(root, path).catch((err) => {
      throw asBadRequest(err);
    });
    if (report.targets.length === 0)
      throw new BadRequestError(`${path} is in an open format: there is nothing to convert`);
    const job = core.jobs.start(
      o,
      "convert_file",
      ["tool_download", "tool_unpack", "convert"],
      async (h) => {
        // The programs first, inside this job: one bar for the person, download included.
        for (const id of await core.converter.programsFor(root, path, to)) {
          if (core.programs.find(id)) continue;
          await core.programs.ensure(o, id, h);
        }
        h.skip("tool_download");
        h.skip("tool_unpack");
        h.step("convert");
        const r = await core.converter.convert(root, path, { owner: o, to, signal: h.signal });
        await core.store.append({
          ownerId: o,
          projectId: b.scope?.startsWith("project:") ? b.scope.slice(8) : null,
          body: {
            type: "workspace.changed",
            payload: { scope: b.scope as string, action: "write", path: r.dir, by: "human" },
          },
        });
        return r;
      },
      { name: path.split("/").pop() ?? path },
    );
    return c.json(job, 202);
  });
}
