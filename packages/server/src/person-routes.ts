// The person's settings for commands (G36.16) and requests (G36.17), for the web page:
//   GET  /api/settings/commands        → { settings, defaults, serverMaxTurns }
//   PUT  /api/settings/commands        → PlatformChange (history, undoable; 400 on a bad value)
//   GET  /api/settings/requests        → { settings, defaults, defaultModel, critical }
//   PUT  /api/settings/requests        → PlatformChange
//   GET  /api/unattended               → UnattendedDecision[] (decided without the person)
//   GET  /api/settings/editor          → { settings } (G37.1: the agents' edits, at once or proposed)
//   PUT  /api/settings/editor          → PlatformChange
//   POST /api/editor/diff              → { before, after, from, to } (G37.2: a change, a turn or a
//                                        proposal, before and after, for the difference view)

import {
  CRITICAL_IDS,
  DEFAULT_COMMAND_SETTINGS,
  DEFAULT_REQUEST_SETTINGS,
  DocFile,
} from "@redgiant/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
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
      {
        settings: core.commandSettings.get(owner(c)),
        // The steps of a turn the person did not start (automations, tasks) default to the
        // server's (REDGIANT_MAX_TURNS, else 200); the person's own turns have none (3.5.6).
        defaults: DEFAULT_COMMAND_SETTINGS,
        serverMaxTurns: core.serverMaxTurns,
      },
      200,
    ),
  );
  app.put("/api/settings/commands", put("commands"));
  app.get("/api/settings/requests", (c) => {
    const ownerId = owner(c);
    return c.json(
      {
        settings: core.requestSettings.get(ownerId),
        defaults: DEFAULT_REQUEST_SETTINGS,
        defaultModel: core.memoryModel ?? null,
        // The truly dangerous requests (G36.17b): they reach the person everywhere, in both
        // modes, and the classifier never decides them. The page shows them in plain words.
        critical: [...CRITICAL_IDS],
      },
      200,
    );
  });
  app.put("/api/settings/requests", put("requests"));
  // The rule for the agents' edits (G37.1): at once, or as proposals, for an agent or a file.
  app.get("/api/settings/editor", (c) =>
    c.json({ settings: core.editorSettings.get(owner(c)) }, 200),
  );
  app.put("/api/settings/editor", async (c) => {
    const r = await put("editor")(c);
    if (r.status === 200) core.editor.modeChanged(owner(c));
    return r;
  });
  // The difference view (G37.2): the file before and after a change, a turn or a proposal.
  app.post("/api/editor/diff", async (c) => {
    const body = DiffAsk.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Say the file and which change" }, 400);
    const { file, ...what } = body.data;
    try {
      return c.json(await core.editor.diffOf(owner(c), file, what), 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.get("/api/unattended", async (c) =>
    c.json(
      await core.person.list(owner(c), {
        limit: Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100) || 100)),
      }),
      200,
    ),
  );
}

const DiffAsk = z
  .object({
    file: DocFile,
    revision: z.number().int().positive().optional(),
    groupId: z.string().min(1).max(200).optional(),
    proposalId: z.string().min(1).max(80).optional(),
  })
  .strict();
