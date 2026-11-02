import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { PREVIEW_HEADERS, Previews, rewrite, serveFile } from "../src/canvas.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
let site: HttpServer | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  await new Promise((r) => (site ? site.close(r) : r(undefined)));
  site = undefined;
});

const resultOf = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};

describe("the canvas (G25.1)", () => {
  it("signs links that cannot be changed and end", () => {
    let now = 1_000_000;
    const p = new Previews(undefined, () => now);
    const token = p.sign("me", { kind: "dir", root: "/data/site" }, 60);
    expect(p.verify(token)).toEqual({ ownerId: "me", target: { kind: "dir", root: "/data/site" } });
    // Another folder in the same link: refused.
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      Buffer.from(body as string, "base64url")
        .toString()
        .replace("/data/site", "/etc"),
    ).toString("base64url");
    expect(p.verify(`${forged}.${mac}`)).toBeUndefined();
    expect(new Previews().verify(token)).toBeUndefined();
    now += 61_000;
    expect(p.verify(token)).toBeUndefined();
  });

  it("moves the site's absolute paths under the preview, and only those", () => {
    const html = rewrite(
      '<html><head><title>x</title></head><body><img src="/logo.png"><a href="//cdn.example/x">c</a><a href="page.html">p</a><link href="/css/s.css"></body></html>',
      "text/html; charset=utf-8",
      "/preview/T",
    );
    expect(html).toContain('src="/preview/T/logo.png"');
    expect(html).toContain('href="/preview/T/css/s.css"');
    expect(html).toContain('href="//cdn.example/x"');
    expect(html).toContain('href="page.html"');
    // Scripts' requests too: a small script right at the start of <head>.
    expect(html).toMatch(/<head><script>.*window\.fetch=/);
    expect(
      rewrite("a{background:url('/i.png')} b{background:url(x.png)}", "text/css", "/preview/T"),
    ).toBe("a{background:url('/preview/T/i.png')} b{background:url(x.png)}");
    expect(
      rewrite('import a from "/src/a.js"; import("/b.js")', "text/javascript", "/preview/T"),
    ).toBe('import a from "/preview/T/src/a.js"; import("/preview/T/b.js")');
  });

  it("serves files only from inside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rg-canvas-"));
    await mkdir(join(dir, "site"));
    await writeFile(join(dir, "site", "index.html"), "<h1>hi</h1>");
    await writeFile(join(dir, "secret.txt"), "no");
    expect((await serveFile(join(dir, "site"), "", "/p")).status).toBe(200);
    expect((await serveFile(join(dir, "site"), "../secret.txt", "/p")).status).toBe(403);
    expect((await serveFile(join(dir, "site"), "%2e%2e/secret.txt", "/p")).status).toBe(403);
    expect((await serveFile(join(dir, "site"), "missing.css", "/p")).status).toBe(404);
  });

  it("lets an agent show a site it made, opened isolated through a signed link", async () => {
    s = await startServer((req) => {
      const r = resultOf(req);
      if (r === undefined)
        return {
          toolCalls: [
            {
              name: "write_file",
              input: {
                path: "site/index.html",
                content: '<link href="/style.css"><h1>Buon giorno</h1>',
              },
            },
          ],
        };
      if (!r.startsWith("Shown"))
        return { toolCalls: [{ name: "show", input: { path: "site", title: "Il sito" } }] };
      return { text: "Look at the canvas." };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    await (await s.core.send("me", body.sessionId, "Make a site")).done;
    const shown = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body.find(
      (e) => e.type === "canvas.show",
    );
    expect(shown?.payload).toEqual({
      title: "Il sito",
      target: { kind: "file", scope: "platform", path: "site" },
    });
    const link = await s.api<{ url: string }>("POST", "/api/canvas/link", {
      kind: "file",
      scope: "platform",
      path: "site",
    });
    expect(link.body.url).toMatch(/^\/preview\/[\w-]+\.[\w-]+\/$/);
    const page = await fetch(`${s.url}${link.body.url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(
      PREVIEW_HEADERS["Content-Security-Policy"],
    );
    const html = await page.text();
    expect(html).toContain("<h1>Buon giorno</h1>");
    expect(html).toContain(`href="${link.body.url}style.css"`);
    // Without a valid link nothing is served, and no bearer token opens it either.
    expect((await fetch(`${s.url}/preview/nope.nope/`)).status).toBe(403);
    // Another person's scope is not theirs to link.
    expect(
      (await s.api("POST", "/api/canvas/link", { kind: "file", scope: "platform", path: "../.." }))
        .status,
    ).toBe(400);
    expect(
      (await s.api<{ version: number }>("GET", "/api/canvas/version?scope=platform&path=site")).body
        .version,
    ).toBeGreaterThan(0);
  });

  it("bridges to a program serving in the agent's computer", async () => {
    site = createServer((req, res) => {
      if (req.url === "/old") {
        res.writeHead(302, { location: "/new" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "a=b" });
      res.end(`<html><head></head><body><script src="/app.js"></script>${req.url}</body></html>`);
    });
    await new Promise<void>((r) => site?.listen(0, "127.0.0.1", r));
    const port = (site.address() as AddressInfo).port;
    s = await startServer((req) =>
      resultOf(req) === undefined
        ? { toolCalls: [{ name: "show", input: { port, url_path: "/app" } }] }
        : { text: "ok" },
    );
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    await (await s.core.send("me", body.sessionId, "Serve it")).done;
    const link = await s.api<{ url: string }>("POST", "/api/canvas/link", {
      kind: "port",
      agentId: god.body.id,
      port,
      path: "/app",
    });
    const prefix = link.body.url.replace(/\/app$/, "");
    const page = await fetch(`${s.url}${link.body.url}?x=1`);
    const html = await page.text();
    expect(html).toContain("/app?x=1");
    expect(html).toContain(`src="${prefix}/app.js"`);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    const moved = await fetch(`${s.url}${prefix}/old`, { redirect: "manual" });
    expect(moved.headers.get("location")).toBe(`${prefix}/new`);
  });
});
