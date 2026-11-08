// The browser extension's routes (G36.21).
//
// For the person's page (the usual sign-in):
//   GET    /api/vault-browsers            → VaultBrowser[]
//   POST   /api/vault-browsers/code       → VaultBrowserCode (ten minutes, one browser)
//   DELETE /api/vault-browsers/:id        → { ok } (the browser's token stops working)
//
// For the extension (its device token only: the person's sign-in does not open them, and the
// device token opens nothing else):
//   POST /api/browser-ext/pair     { code, name, browser }           → { token, id, name } (no token)
//   GET  /api/browser-ext/status                                     → { id, name, ready }
//   POST /api/browser-ext/site     { url, q? }                       → BrowserExtSite
//   POST /api/browser-ext/value    { id, url, purpose }              → { value, username }
//   POST /api/browser-ext/check    { url, username, password }       → BrowserExtCheck
//   POST /api/browser-ext/save     { url, username, password, service, hosts, entryId? }
//   POST /api/browser-ext/unpair                                     → { ok }
// Errors: { error, code } with 400, 401, 403 (not this page), 404, 423 (keychain closed), 429.

import type { Context, Hono } from "hono";
import { z } from "zod";
import { bearer } from "./auth.js";
import { BrowserLinkError, type BrowserLinks, type LinkedBrowser } from "./browser-links.js";

const Url = z.string().min(1).max(4000);

// biome-ignore lint/suspicious/noExplicitAny: the app's own Env, kept private in app.ts
export function browserRoutes<E extends { Variables: any }>(
  app: Hono<E>,
  links: BrowserLinks,
  owner: (c: Context<E>) => string,
  addressOf: (c: Context<E>) => string,
): void {
  const failed = (c: Context<E>, err: unknown) => {
    if (err instanceof BrowserLinkError)
      return c.json({ error: err.message, code: err.code }, err.status);
    if (err instanceof z.ZodError)
      return c.json({ error: "A field is missing or wrong", code: "bad_request" }, 400);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("vault_"))
      return c.json({ error: (err as Error).message, code }, 400);
    throw err;
  };
  const body = async <T extends z.ZodTypeAny>(c: Context<E>, schema: T) =>
    schema.parse(await c.req.json().catch(() => ({}))) as z.output<T>;

  // The person's page.
  app.get("/api/vault-browsers", (c) => c.json(links.list(owner(c)), 200));
  app.post("/api/vault-browsers/code", (c) => {
    c.header("cache-control", "no-store");
    return c.json(links.newCode(owner(c)), 200);
  });
  app.delete("/api/vault-browsers/:id", async (c) => {
    try {
      await links.revoke(owner(c), c.req.param("id"));
      return c.json({ ok: true }, 200);
    } catch (err) {
      return failed(c, err);
    }
  });

  // The extension. Linking needs the code, the rest the browser's token.
  app.post("/api/browser-ext/pair", async (c) => {
    try {
      const b = await body(
        c,
        z.object({
          code: z.string().min(4).max(40),
          name: z.string().max(60).default(""),
          browser: z.string().max(20).default("other"),
        }),
      );
      c.header("cache-control", "no-store");
      return c.json(await links.pair(b.code, b.name, b.browser, addressOf(c)), 200);
    } catch (err) {
      return failed(c, err);
    }
  });

  const device = new WeakMap<Context<E>, LinkedBrowser>();
  app.use("/api/browser-ext/*", async (c, next) => {
    if (c.req.path === "/api/browser-ext/pair") return next();
    const dev = links.authenticate(bearer(c.req.header("authorization")));
    if (!dev) return c.json({ error: "This browser is not linked", code: "unlinked" }, 401);
    device.set(c, dev);
    c.header("cache-control", "no-store");
    return next();
  });
  const dev = (c: Context<E>) => device.get(c) as LinkedBrowser;

  app.get("/api/browser-ext/status", (c) =>
    c.json({ id: dev(c).id, name: dev(c).name, ready: links.ready }, 200),
  );
  app.post("/api/browser-ext/site", async (c) => {
    try {
      const b = await body(c, z.object({ url: Url, q: z.string().max(100).default("") }));
      return c.json(links.site(dev(c), b.url, b.q), 200);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.post("/api/browser-ext/value", async (c) => {
    try {
      const b = await body(
        c,
        z.object({ id: z.string().min(1).max(60), url: Url, purpose: z.enum(["fill", "copy"]) }),
      );
      return c.json(await links.value(dev(c), b.id, b.url, b.purpose), 200);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.post("/api/browser-ext/check", async (c) => {
    try {
      const b = await body(
        c,
        z.object({
          url: Url,
          username: z.string().max(200).default(""),
          password: z.string().min(1).max(20_000),
        }),
      );
      return c.json(links.check(dev(c), b.url, b.username, b.password), 200);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.post("/api/browser-ext/save", async (c) => {
    try {
      const b = await body(
        c,
        z.object({
          url: Url,
          username: z.string().max(200).default(""),
          password: z.string().min(1).max(20_000),
          service: z.string().max(80).default(""),
          hosts: z.array(z.string().max(200)).max(20).default([]),
          entryId: z.string().max(60).optional(),
        }),
      );
      return c.json(await links.save(dev(c), b), 200);
    } catch (err) {
      return failed(c, err);
    }
  });
  app.post("/api/browser-ext/unpair", async (c) => {
    try {
      await links.revoke(dev(c).ownerId, dev(c).id);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return failed(c, err);
    }
  });
}
