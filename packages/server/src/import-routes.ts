// Import from other agents (G36.7), for the web page:
//   POST /api/import/scan {home?, projects?, folder?}  → ImportPreview (the known folders, asked)
//   POST /api/import/upload                           → {id} (a batch of picked files)
//   PUT  /api/import/upload/:id?path=a/b.md           → {added} (one file, or a .zip opened)
//   POST /api/import/upload/:id/preview               → ImportPreview
//   POST /api/import/apply ImportApply                → Job ("import_apply", result ImportRecord)
//   GET  /api/import/history                          → ImportRecord[]
//   POST /api/import/:id/undo                         → ImportRecord
//   POST /api/import/:id/memories                     → ImportPreview (memories from its chats)

import { join } from "node:path";
import { ImportApply } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { BadRequestError, type RedGiantCore } from "./core.js";
import { Importer } from "./import.js";
import type { SetupService } from "./setup.js";

const Scan = z.object({
  home: z.boolean().optional(),
  projects: z.boolean().optional(),
  folder: z.string().max(1000).optional(),
});

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function importRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
  setup?: SetupService,
): Importer {
  const importer = new Importer(core, {
    dir: join(core.backupsDir, "..", "imports"),
    ...(setup && {
      instructions: {
        get: () => setup.instructionsText(),
        set: (text: string) => setup.saveInstructions(text),
      },
    }),
  });
  const body = async <T extends z.ZodType>(c: Context<E>, schema: T): Promise<z.infer<T>> => {
    const r = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) throw new BadRequestError(r.error.issues.map((i) => i.message).join("; "));
    return r.data;
  };
  app.post("/api/import/scan", async (c) =>
    c.json(await importer.scan(owner(c), await body(c, Scan)), 200),
  );
  app.post("/api/import/upload", async (c) => c.json({ id: await importer.newUpload() }, 200));
  app.put("/api/import/upload/:id", async (c) => {
    const path = c.req.query("path") ?? "";
    const data = new Uint8Array(await c.req.arrayBuffer());
    return c.json({ added: await importer.addFile(c.req.param("id"), path, data) }, 200);
  });
  app.post("/api/import/upload/:id/preview", async (c) =>
    c.json(await importer.previewUpload(owner(c), c.req.param("id")), 200),
  );
  app.post("/api/import/apply", async (c) =>
    c.json(importer.apply(owner(c), await body(c, ImportApply)), 202),
  );
  app.get("/api/import/history", async (c) => c.json(await importer.list(owner(c)), 200));
  app.post("/api/import/:id/undo", async (c) =>
    c.json(await importer.undo(owner(c), c.req.param("id")), 200),
  );
  app.post("/api/import/:id/memories", async (c) =>
    c.json(await importer.suggestMemories(owner(c), c.req.param("id")), 200),
  );
  return importer;
}
