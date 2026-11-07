// The person's settings for commands (G36.16) and requests (G36.17), for the web page:
//   GET  /api/settings/commands        → { settings, defaults }
//   PUT  /api/settings/commands        → PlatformChange (history, undoable; 400 on a bad value)
//   GET  /api/settings/requests        → { settings, defaults, defaultModel, humanOnly }
//   PUT  /api/settings/requests        → PlatformChange
//   GET  /api/unattended?review=1      → UnattendedDecision[] (decided without the person)
//   POST /api/unattended/:id/reviewed  → { ok } (a blocked request leaves the review list)

import { DEFAULT_POLICY, OUTSIDE_PROJECT } from "@redgiant/hierarchy";
import { DEFAULT_COMMAND_SETTINGS, DEFAULT_REQUEST_SETTINGS } from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import type { RedGiantCore } from "./core.js";
import { ConfigError, type PersonSettingsKey } from "./platform.js";

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function personRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  core: RedGiantCore,
  owner: (c: Context<E>) => string,
): void {
  const put = (key: PersonSettingsKey) => async (c: Context<E>) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "A JSON object is needed" }, 400);
    try {
      return c.json(await core.config.setPersonSettings(owner(c), "human", key, body), 200);
    } catch (err) {
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      throw err;
    }
  };
  app.get("/api/settings/commands", (c) =>
    c.json(
      { settings: core.commandSettings.get(owner(c)), defaults: DEFAULT_COMMAND_SETTINGS },
      200,
    ),
  );
  app.put("/api/settings/commands", put("commands"));
  app.get("/api/settings/requests", (c) => {
    const ownerId = owner(c);
    const policy = core.policies.get(ownerId);
    return c.json(
      {
        settings: core.requestSettings.get(ownerId),
        defaults: DEFAULT_REQUEST_SETTINGS,
        defaultModel: core.memoryModel ?? null,
        // What the classifier never approves: the dangers only the person approves, and the keychain.
        humanOnly: [
          ...new Set([OUTSIDE_PROJECT, ...(policy.humanOnly ?? DEFAULT_POLICY.humanOnly)]),
        ],
      },
      200,
    );
  });
  app.put("/api/settings/requests", put("requests"));
  app.get("/api/unattended", async (c) =>
    c.json(
      await core.person.list(owner(c), {
        review: c.req.query("review") === "1",
        limit: Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100) || 100)),
      }),
      200,
    ),
  );
  app.post("/api/unattended/:id/reviewed", async (c) => {
    const ok = await core.person.reviewed(owner(c), c.req.param("id"));
    return ok ? c.json({ ok }, 200) : c.json({ error: "Not found" }, 404);
  });
}
