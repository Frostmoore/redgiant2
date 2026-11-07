// The knowledge's HTTP API (G36): what the «Knowledge» page (G36.5) and the CLI use. Every route
// acts for the signed-in person only; agents reach the knowledge through their tool (G36.5).

import {
  CLOUD_EMBEDDING_MODELS,
  EMBEDDING_PROVIDERS,
  KnowledgeSearchInput,
  LOCAL_EMBEDDING_MODELS,
  LOCAL_RERANK_MODELS,
  RERANK_PROVIDERS,
  TEXT_SEARCH_CONFIG_NAMES,
} from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { LocalEmbedServers } from "./local-embed.js";
import { KnowledgeError, type KnowledgeService } from "./service.js";

const failed = (c: Context, err: unknown) => {
  if (err instanceof KnowledgeError)
    return c.json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : 400);
  if (err instanceof z.ZodError)
    return c.json(
      { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      400,
    );
  throw err;
};

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function knowledgeRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  knowledge: () => KnowledgeService | undefined,
  owner: (c: Context<E>) => string,
): void {
  const body = async (c: Context<E>) => (await c.req.json().catch(() => ({}))) as unknown;
  const k = () => {
    const s = knowledge();
    if (!s) throw new KnowledgeError("no_vector", "The knowledge is not running");
    return s;
  };
  const route =
    (fn: (c: Context<E>, s: KnowledgeService) => Promise<Response>) => async (c: Context<E>) => {
      try {
        return await fn(c, k());
      } catch (err) {
        return failed(c as unknown as Context, err);
      }
    };

  app.get(
    "/api/knowledge",
    route(async (c, s) => c.json(await s.status(owner(c)), 200)),
  );
  /** The models the person can choose, and which local ones are already here. */
  app.get(
    "/api/knowledge/models",
    route(async (c, s) => {
      const here = async (role: "embed" | "rerank", id: string) =>
        s.deps.local.ready(role, id, false);
      return c.json(
        {
          providers: EMBEDDING_PROVIDERS,
          rerankProviders: RERANK_PROVIDERS,
          local: await Promise.all(
            LOCAL_EMBEDDING_MODELS.map(async (m) => ({ ...m, here: await here("embed", m.id) })),
          ),
          localRerank: await Promise.all(
            LOCAL_RERANK_MODELS.map(async (m) => ({ ...m, here: await here("rerank", m.id) })),
          ),
          cloud: CLOUD_EMBEDDING_MODELS,
          languages: TEXT_SEARCH_CONFIG_NAMES,
        },
        200,
      );
    }),
  );
  app.put(
    "/api/knowledge/settings",
    route(async (c, s) => {
      const b = z
        .object({
          embedding: z.unknown().optional(),
          rerank: z.unknown().optional(),
          threads: z.unknown().optional(),
        })
        .parse(await body(c));
      return c.json(await s.setSettings(owner(c), b, c.req.raw.signal), 200);
    }),
  );
  /** Downloads a local model now (its bar is a job), before choosing it. */
  app.post(
    "/api/knowledge/models/download",
    route(async (c, s) => {
      const b = z
        .object({
          role: z.enum(["embed", "rerank"]),
          id: z.string(),
          gpu: z.boolean().default(false),
        })
        .parse(await body(c));
      if (!LocalEmbedServers.model(b.role, b.id))
        throw new KnowledgeError("bad_choice", `Unknown local model "${b.id}"`);
      void s.deps.local.ensure(owner(c), b.role, b.id, b.gpu).catch(() => {});
      return c.json({ ok: true }, 202);
    }),
  );
  app.post(
    "/api/knowledge/rebuild",
    route(async (c, s) => {
      await s.rebuild(owner(c));
      return c.json({ ok: true }, 200);
    }),
  );
  app.post(
    "/api/knowledge/pause",
    route(async (c, s) => {
      const b = z.object({ paused: z.boolean() }).parse(await body(c));
      s.pause(owner(c), b.paused);
      return c.json({ ok: true }, 200);
    }),
  );

  app.get(
    "/api/knowledge/collections",
    route(async (c, s) => c.json({ collections: await s.collections(owner(c)) }, 200)),
  );
  app.post(
    "/api/knowledge/collections",
    route(async (c, s) => c.json(await s.createCollection(owner(c), await body(c)), 201)),
  );
  app.put(
    "/api/knowledge/collections/:id",
    route(async (c, s) =>
      c.json(await s.updateCollection(owner(c), c.req.param("id") as string, await body(c)), 200),
    ),
  );
  app.delete(
    "/api/knowledge/collections/:id",
    route(async (c, s) => {
      await s.removeCollection(owner(c), c.req.param("id") as string);
      return c.json({ ok: true }, 200);
    }),
  );
  app.get(
    "/api/knowledge/collections/:id/sources",
    route(async (c, s) =>
      c.json({ sources: await s.sources(owner(c), c.req.param("id") as string) }, 200),
    ),
  );
  app.post(
    "/api/knowledge/collections/:id/sources",
    route(async (c, s) =>
      c.json(await s.addSource(owner(c), c.req.param("id") as string, await body(c)), 201),
    ),
  );
  app.delete(
    "/api/knowledge/collections/:id/sources/:source",
    route(async (c, s) => {
      await s.removeSource(owner(c), c.req.param("id") as string, c.req.param("source") as string);
      return c.json({ ok: true }, 200);
    }),
  );
  app.post(
    "/api/knowledge/collections/:id/rescan",
    route(async (c, s) => {
      const b = z.object({ source: z.string().optional() }).parse(await body(c));
      await s.rescan(owner(c), c.req.param("id") as string, b.source);
      return c.json({ ok: true }, 200);
    }),
  );
  app.get(
    "/api/knowledge/collections/:id/documents",
    route(async (c, s) => {
      const q = z
        .object({
          state: z.enum(["pending", "indexed", "skipped", "failed"]).optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(c.req.query());
      return c.json(
        {
          documents: await s.documents(owner(c), c.req.param("id") as string, {
            ...(q.state && { state: q.state }),
            ...(q.limit && { limit: q.limit }),
            ...(q.offset && { offset: q.offset }),
          }),
        },
        200,
      );
    }),
  );
  app.post(
    "/api/knowledge/search",
    route(async (c, s) =>
      c.json(
        await s.search(
          owner(c),
          KnowledgeSearchInput.parse(await body(c)),
          { kind: "human" },
          c.req.raw.signal,
        ),
        200,
      ),
    ),
  );
  /** Where a citation opens: a Canvas target with its page or line, or a web address. */
  app.get(
    "/api/knowledge/open/:chunk",
    route(async (c, s) => c.json(await s.open(owner(c), c.req.param("chunk") as string), 200)),
  );
}
