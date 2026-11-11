import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { Previews, previewHeaders, previewOrigins, rewrite, serveFile } from "../src/canvas.js";
import { boardAnswerText } from "../src/core.js";
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
      previewHeaders("files", previewOrigins(new Request(s.url)), link.body.url.slice(0, -1))[
        "Content-Security-Policy"
      ],
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
    // A project's program keeps its network and its popups; only RedGiant frames it (3.5.8).
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("allow-popups");
    expect(csp).toContain(`frame-ancestors http://${new URL(s.url).host}`);
    expect(csp).not.toContain("default-src");
    const moved = await fetch(`${s.url}${prefix}/old`, { redirect: "manual" });
    expect(moved.headers.get("location")).toBe(`${prefix}/new`);
  });

  it("publishes a board as Officina's, and the person's choices and comments go back (G25.4)", async () => {
    const heard: string[] = [];
    s = await startServer((req) => {
      const last = req.messages.at(-1);
      const said = last?.parts.find((p) => p.type === "text");
      const r = resultOf(req);
      if (said?.type === "text" && said.text.startsWith("[Board")) {
        heard.push(said.text);
        return { text: "Noted." };
      }
      if (r === undefined)
        return {
          toolCalls: [
            {
              name: "write_file",
              input: { path: "b.html", content: "<h1>B</h1><img src='/x.png'>" },
            },
          ],
        };
      if (r.startsWith("Created"))
        return {
          toolCalls: [
            {
              name: "publish_board",
              input: {
                title: "La home",
                description: "Due strade",
                variants: [
                  { title: "Scura", note: "Rosso su nero", html: "<h1>A</h1>" },
                  { title: "Chiara", file: "b.html" },
                ],
              },
            },
          ],
        };
      return { text: "Look at the board." };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    const sid = body.sessionId;
    await (await s.core.send("me", sid, "Show me options")).done;
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    const result = events.find(
      (e) => e.type === "tool.result" && String(e.payload?.output).startsWith("Board published"),
    );
    expect(String(result?.type === "tool.result" && result.payload?.output)).toContain(
      "2 variants: 1. Scura · 2. Chiara",
    );
    const proposed = events.find((e) => e.type === "variants.proposed");
    const p = proposed?.payload as { proposalId: string; variants: unknown[] };
    expect(p.proposalId).toMatch(/^[0-9a-f]{12}$/);
    expect(p.variants).toEqual([
      { title: "Scura", note: "Rosso su nero", bytes: 10 },
      { title: "Chiara", bytes: 28 },
    ]);
    // The pages were copied: changing the file later does not change the board.
    const link = await s.api<{ base: string }>(
      "GET",
      `/api/sessions/${sid}/variants/${p.proposalId}/link`,
    );
    const page = await fetch(`${s.url}${link.body.base}2.html`);
    // A board is an agent-made page: no internet (3.5.8).
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src http://${new URL(s.url).host}${link.body.base} `);
    expect(csp).not.toContain("allow-popups");
    expect(await page.text()).toContain("<h1>B</h1>");
    const answer = (b: unknown) => s?.api("POST", `/api/sessions/${sid}/variants`, b);
    expect(
      (await answer({ proposalId: p.proposalId, variant: 2, comment: "Più grande" }))?.status,
    ).toBe(200);
    expect(
      (await answer({ proposalId: p.proposalId, variant: 1, choice: true, comment: "Questa" }))
        ?.status,
    ).toBe(200);
    expect(
      (await answer({ proposalId: p.proposalId, variant: null, comment: "Il rosso della 1" }))
        ?.status,
    ).toBe(200);
    // As in Officina: an empty comment, choosing the whole board, a variant or a board not there.
    expect((await answer({ proposalId: p.proposalId, variant: 1 }))?.status).toBe(400);
    expect((await answer({ proposalId: p.proposalId, variant: null, choice: true }))?.status).toBe(
      400,
    );
    expect((await answer({ proposalId: p.proposalId, variant: 5, choice: true }))?.status).toBe(
      400,
    );
    expect((await answer({ proposalId: "0123456789ab", variant: 1, choice: true }))?.status).toBe(
      404,
    );
    for (let i = 0; i < 100 && heard.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual([
      "[Board «La home»] Comment on variant 2 («Chiara»): Più grande",
      "[Board «La home»] I chose variant 1 («Scura»).\nComment: Questa",
      "[Board «La home»] Comment on the board: Il rosso della 1",
    ]);
  });

  it("words the answers as Officina's, in Italian", () => {
    const b = { title: "La home", variants: [{ title: "Scura" }, { title: "Chiara" }] };
    expect(boardAnswerText("it", b, { variant: 2, choice: true, comment: "bella" })).toBe(
      "[Tavola «La home»] Ho scelto la variante 2 («Chiara»).\nCommento: bella",
    );
    expect(boardAnswerText("it", b, { variant: 1, choice: false, comment: "più rosso" })).toBe(
      "[Tavola «La home»] Commento su la variante 1 («Scura»): più rosso",
    );
    expect(boardAnswerText("it", b, { variant: null, choice: false, comment: "ok" })).toBe(
      "[Tavola «La home»] Commento sulla tavola: ok",
    );
  });
});

describe("agent-made pages reach no internet (3.5.8)", () => {
  it("keeps a page to its own preview: scripts, styles and data pictures, nothing outside", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const dir = await mkdtemp(join(tmpdir(), "rg-net-"));
    await writeFile(join(dir, "index.html"), "<head></head><a href='https://example.com'>x</a>");
    await writeFile(join(dir, "data.json"), "{}");
    const token = s.core.previews.sign("me", { kind: "dir", root: dir });
    const host = new URL(s.url).host;
    const own = `http://${host}/preview/${token}/ https://${host}/preview/${token}/`;
    const page = await fetch(`${s.url}/preview/${token}/`, {
      headers: { "sec-fetch-dest": "iframe" },
    });
    const csp = (page.headers.get("content-security-policy") ?? "").split("; ");
    expect(csp).toEqual([
      "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock",
      "default-src 'none'",
      `script-src ${own} 'unsafe-inline' 'unsafe-eval' blob:`,
      `style-src ${own} 'unsafe-inline' blob:`,
      `img-src ${own} data: blob:`,
      `font-src ${own} data: blob:`,
      `media-src ${own} data: blob:`,
      `connect-src ${own}`,
      `worker-src ${own} blob:`,
      `frame-src ${own} blob: data:`,
      `manifest-src ${own}`,
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      `frame-ancestors http://${host} https://${host}`,
    ]);
    expect(page.headers.get("x-dns-prefetch-control")).toBe("off");
    // Links that would go out are handed to the page around the frame.
    const html = await page.text();
    expect(html).toContain('redgiant:"open-link"');
    // Its own files are still served, under the same rules.
    const json = await fetch(`${s.url}/preview/${token}/data.json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("frames a page opened on its own in a tab, so it cannot leave its preview", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const dir = await mkdtemp(join(tmpdir(), "rg-net-"));
    await writeFile(join(dir, "index.html"), "<p>hi</p>");
    await writeFile(join(dir, "pic.svg"), "<svg/>");
    const token = s.core.previews.sign("me", { kind: "dir", root: dir });
    const top = await fetch(`${s.url}/preview/${token}/?a=1&b="2"`, {
      headers: { "sec-fetch-dest": "document", "accept-language": "it-IT,it;q=0.9" },
    });
    const csp = top.headers.get("content-security-policy") ?? "";
    const host = new URL(s.url).host;
    expect(csp).toContain(
      `frame-src http://${host}/preview/${token}/ https://${host}/preview/${token}/;`,
    );
    expect(csp).toMatch(/script-src 'nonce-[\w+/=]+';/);
    expect(csp).toContain("default-src 'none'");
    const html = await top.text();
    expect(html).toContain(
      `<iframe src="/preview/${token}/?a=1&amp;b=%222%22" sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock"`,
    );
    expect(html).toContain("La pagina vuole aprire");
    expect(html).not.toContain("<p>hi</p>");
    // Not a page: as it is.
    const pic = await fetch(`${s.url}/preview/${token}/pic.svg`, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(await pic.text()).toBe("<svg/>");
  });

  it("gives one file shown from outside the preview's script too", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const dir = await mkdtemp(join(tmpdir(), "rg-net-"));
    await writeFile(join(dir, "one.html"), "<head></head><p>one</p>");
    const token = s.core.previews.sign("me", { kind: "file", path: join(dir, "one.html") });
    const page = await fetch(`${s.url}/preview/${token}/one.html`);
    const html = await page.text();
    expect(html).toContain("<p>one</p>");
    expect(html).toContain('redgiant:"open-link"');
    // The length is the rewritten page's, not the file's.
    expect(Number(page.headers.get("content-length"))).toBe(Buffer.byteLength(html));
    expect(page.headers.get("content-security-policy")).toContain("connect-src");
  });

  it("writes only well-formed hosts into a policy", () => {
    const req = (fwd: string) =>
      new Request("http://192.168.1.5:7650/x", { headers: { "x-forwarded-host": fwd } });
    expect(previewOrigins(req("rg.example.org"))).toEqual([
      "http://192.168.1.5:7650",
      "https://192.168.1.5:7650",
      "http://rg.example.org",
      "https://rg.example.org",
    ]);
    expect(previewOrigins(req("evil; script-src *"))).toHaveLength(2);
    expect(previewOrigins(req("a.b/c"))).toHaveLength(2);
    expect(previewOrigins(req("[::1]:8080"))).toContain("https://[::1]:8080");
  });

  it("frames only its own origin on RedGiant's page", async () => {
    const web = await mkdtemp(join(tmpdir(), "rg-web-"));
    await mkdir(join(web, "assets"));
    await writeFile(join(web, "index.html"), "<div id=app></div>");
    await writeFile(join(web, "assets", "a.js"), "1");
    s = await startServer(() => ({ text: "ok" }), {}, {}, web);
    const page = await fetch(`${s.url}/`);
    expect(page.headers.get("content-security-policy")).toBe("frame-src 'self'");
    const deep = await fetch(`${s.url}/some/route`);
    expect(deep.headers.get("content-security-policy")).toBe("frame-src 'self'");
    const js = await fetch(`${s.url}/assets/a.js`);
    expect(js.headers.get("content-security-policy")).toBeNull();
  });

  it("adds the link script only to agent-made pages", () => {
    expect(rewrite("<head></head>", "text/html", "/preview/t", true)).toContain("open-link");
    expect(rewrite("<head></head>", "text/html", "/preview/t")).not.toContain("open-link");
  });
});
