// External ACP agents (G38.6), for Settings › External agents:
//   GET    /api/acp/workers        → { workers: AcpWorkerInfo[], presets }
//   POST   /api/acp/workers        → AcpWorkerInfo (201): { name, projectId, command, args, env }
//   PUT    /api/acp/workers/{id}   → AcpWorkerInfo: { command, args, env }
//   DELETE /api/acp/workers/{id}   → { ok } (the agent is stopped; its log stays)
//   POST   /api/acp/try            → { name, version?, loadSession, signIn }: the command started
//                                    in an empty folder of its own (never a project), then closed.

import { ACP_PRESETS, AcpWorkerConfig } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { AcpWorkerError } from "./acp-workers.js";
import type { RedGiantCore } from "./core.js";
import { BadRequestError } from "./core.js";

const NewWorker = AcpWorkerConfig.extend({
  name: z.string().trim().min(1).max(80),
  projectId: z.string().min(1),
});

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function acpRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  const bad = (c: Context<E>, err: unknown) => {
    if (err instanceof BadRequestError || err instanceof AcpWorkerError)
      return c.json({ error: err.message }, 400);
    throw err;
  };
  app.get("/api/acp/workers", (c) =>
    c.json({ workers: core.listAcpWorkers(owner(c)), presets: ACP_PRESETS }, 200),
  );
  app.post("/api/acp/workers", async (c) => {
    const body = NewWorker.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Give a name, a project and the command" }, 400);
    try {
      return c.json(await core.createAcpWorker(owner(c), body.data), 201);
    } catch (err) {
      return bad(c, err);
    }
  });
  app.put("/api/acp/workers/:id", async (c) => {
    try {
      return c.json(
        await core.updateAcpWorker(
          owner(c),
          c.req.param("id"),
          await c.req.json().catch(() => null),
        ),
        200,
      );
    } catch (err) {
      return bad(c, err);
    }
  });
  app.delete("/api/acp/workers/:id", async (c) => {
    await core.removeAcpWorker(owner(c), c.req.param("id"));
    return c.json({ ok: true }, 200);
  });
  app.post("/api/acp/try", async (c) => {
    const body = AcpWorkerConfig.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Give the command" }, 400);
    try {
      return c.json(await core.probeAcpWorker(body.data), 200);
    } catch (err) {
      return bad(c, err);
    }
  });
}
