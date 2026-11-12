// The person's artifacts (3.5.9), for Settings › Artifacts and the file explorer:
//   GET  /api/artifacts                               → ArtifactInfo[] (every place, newest first)
//   GET  /api/artifacts/state?scope=&path=            → {pendingRun} (the Canvas: source + «Run»?)
//   POST /api/artifacts/run {scope, path}             → {pendingRun: false} («Run» on an import)
//   GET  /api/artifacts/export?scope=&path=&as=zip|html&data=1 → the `.rgartifact` (with its data
//                                                       when data=1), or the bare HTML
//   POST /api/artifacts/import?scope=&data=0 (zip)    → {path, name, header, dataIgnored, dataImported}
//   POST /api/artifacts/grant {scope, path, capability, capUsd?} → the grants (3.6, the person's)
//   POST /api/artifacts/revoke {scope, path, capability}         → the grants
// Deleting goes through the file explorer's own path (`POST /api/files/op` delete): same trash,
// same permissions, same log.

import type { Context, Hono } from "hono";
import { z } from "zod";
import { BridgeFailure } from "./artifact-bridge.js";
import { ArtifactService, MAX_ARTIFACT_ZIP } from "./artifacts.js";
import { BadRequestError, NotFoundError, type RedGiantCore } from "./core.js";

const Target = z.object({ scope: z.string().min(1), path: z.string().min(1) });

const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function artifactRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): ArtifactService {
  const artifacts = new ArtifactService(core);
  const target = (c: Context<E>) => {
    const r = Target.safeParse({ scope: c.req.query("scope"), path: c.req.query("path") });
    if (!r.success) throw new BadRequestError("scope and path are required");
    return r.data;
  };
  app.get("/api/artifacts", async (c) => c.json(await artifacts.list(owner(c)), 200));
  app.get("/api/artifacts/state", async (c) => {
    const t = target(c);
    return c.json({ pendingRun: await artifacts.isPendingRun(owner(c), t.scope, t.path) }, 200);
  });
  app.post("/api/artifacts/run", async (c) => {
    const r = Target.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) throw new BadRequestError("scope and path are required");
    return c.json(await artifacts.markRun(owner(c), r.data.scope, r.data.path), 200);
  });
  app.get("/api/artifacts/export", async (c) => {
    const t = target(c);
    if (c.req.query("as") === "html") {
      const { text, name } = await artifacts.exportHtml(owner(c), t.scope, t.path);
      return new Response(text, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": attachment(name),
        },
      });
    }
    const { bytes, name } = await artifacts.exportZip(owner(c), t.scope, t.path, {
      data: c.req.query("data") === "1",
    });
    return new Response(bytes, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.byteLength),
        "content-disposition": attachment(name),
      },
    });
  });
  app.post("/api/artifacts/import", async (c) => {
    const scope = c.req.query("scope") ?? "";
    if (!scope) throw new BadRequestError("scope is required");
    // The declared size first: a huge body is refused before it is read.
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_ARTIFACT_ZIP)
      throw new BadRequestError(
        `The file is larger than ${MAX_ARTIFACT_ZIP / 1024 / 1024} MB: not an artifact`,
      );
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(
      await artifacts.importZip(owner(c), scope, bytes, { withData: c.req.query("data") !== "0" }),
      200,
    );
  });
  // The person's own grants and revocations (Settings › Artifacts, 3.6): never the file's.
  const Grant = Target.extend({
    capability: z.string().min(1).max(220),
    capUsd: z.number().positive().max(1000).optional(),
  });
  const bridgeCall = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BridgeFailure)
        throw err.code === "not_found"
          ? new NotFoundError(err.message)
          : new BadRequestError(err.message);
      throw err;
    }
  };
  app.post("/api/artifacts/grant", async (c) => {
    const r = Grant.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) throw new BadRequestError("scope, path and capability are required");
    const g = r.data;
    return c.json(
      await bridgeCall(() =>
        core.artifactBridge.grant(owner(c), g.scope, g.path, g.capability, g.capUsd),
      ),
      200,
    );
  });
  app.post("/api/artifacts/revoke", async (c) => {
    const r = Grant.safeParse(await c.req.json().catch(() => undefined));
    if (!r.success) throw new BadRequestError("scope, path and capability are required");
    const g = r.data;
    return c.json(
      await bridgeCall(() => core.artifactBridge.revoke(owner(c), g.scope, g.path, g.capability)),
      200,
    );
  });
  return artifacts;
}
