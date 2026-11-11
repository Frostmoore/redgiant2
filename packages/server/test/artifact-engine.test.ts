// Artifacts and widgets (3.5.9): the frame's headers, the libraries served offline, JSX compiled on
// the server, the errors that reach the agent, widgets served from the log, «Tienilo».
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactErrors,
  artifactHeaders,
  compileJsx,
  importMap,
  keptWidget,
  missingImports,
  serveLib,
} from "../src/artifact-engine.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const resultOf = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};

const APP = `<!-- redgiant-artifact {"name":"Conti","version":1,"libs":["react"]} -->
<!doctype html><html><head><title>Conti</title></head><body><div id="root"></div>
<script type="text/babel">
import { useState } from "react";
import { createRoot } from "react-dom/client";
function App() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }
createRoot(document.getElementById("root")).render(<App />);
</script></body></html>`;

describe("the artifacts' frame (3.5.9)", () => {
  it("allows scripts and forms only, and no network at all", () => {
    const h = artifactHeaders(["http://rg:8080", "https://rg:8080"], "/preview/T");
    expect(h["Content-Security-Policy"]?.split("; ")).toEqual([
      "sandbox allow-scripts allow-forms",
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval' http://rg:8080/preview/T/lib/ https://rg:8080/preview/T/lib/",
      "style-src 'unsafe-inline' http://rg:8080/preview/T/lib/ https://rg:8080/preview/T/lib/",
      "img-src data: blob:",
      "font-src data: http://rg:8080/preview/T/lib/ https://rg:8080/preview/T/lib/",
      "media-src data: blob:",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "manifest-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "webrtc 'block'",
      "frame-ancestors http://rg:8080 https://rg:8080",
    ]);
    expect(h["X-DNS-Prefetch-Control"]).toBe("off");
  });

  it("maps the libraries to fixed, versioned names; mermaid only when asked", () => {
    const map = importMap("/preview/T");
    expect(map.react).toMatch(/^\/preview\/T\/lib\/react-19\.[\d.]+\/react\.js$/);
    expect(map["react-dom/client"]).toMatch(/react-[\d.]+\/react-dom-client\.js$/);
    expect(map["three/addons/"]).toMatch(/three-0\.[\d.]+\/raw\/$/);
    expect(map["chart.js/auto"]).toMatch(/chartjs-[\d.]+\/auto\.js$/);
    expect(map.xlsx).toMatch(/sheetjs-0\.20\.3\/xlsx\.js$/);
    expect(map.mermaid).toBeUndefined();
    expect(importMap("/p", ["mermaid"]).mermaid).toMatch(
      /mermaid-11\.[\d.]+\/raw\/mermaid\.esm\.min\.mjs$/,
    );
    expect(
      missingImports('import x from "lodash"; import { a } from "react"; import("./b.js")', map),
    ).toEqual(["lodash"]);
    expect(
      missingImports('import { OrbitControls } from "three/addons/controls/OrbitControls.js"', map),
    ).toEqual([]);
  });

  it("serves the libraries offline, bundled once, React shared by its entries", async () => {
    const v = /react-([\d.]+)\//.exec(importMap("/p").react as string)?.[1];
    const react = await serveLib(`react-${v}/react.js`);
    expect(react?.type).toMatch(/javascript/);
    const client = await serveLib(`react-${v}/react-dom-client.js`);
    const text = new TextDecoder().decode(client?.body as Uint8Array);
    expect(text).toContain("createRoot");
    // The shared chunk, imported relatively: one React for react and react-dom.
    expect(text).toMatch(/from"\.\/chunk-[\w]+\.js"/);
    expect(await serveLib(`react-0.0.1/react.js`)).toBeUndefined();
    expect(await serveLib(`react-${v}/../../package.json`)).toBeUndefined();
    const three = /three-([\d.]+)\//.exec(importMap("/p")["three/addons/"] as string)?.[1];
    expect((await serveLib(`three-${three}/raw/controls/OrbitControls.js`))?.type).toMatch(
      /javascript/,
    );
    expect(await serveLib(`three-${three}/raw/../../package.json`)).toBeUndefined();
  }, 60_000);

  it("compiles JSX on the server, once per text, and says where it does not compile", async () => {
    const ok = await compileJsx("const a = <b x={1}>c</b>;", "react");
    expect(ok.code).toContain('from "react/jsx-runtime"');
    expect(await compileJsx("const a = <b x={1}>c</b>;", "react")).toBe(ok);
    expect((await compileJsx("const a = <b x={1}>c</b>;", "preact")).code).toContain(
      "preact/jsx-runtime",
    );
    const bad = await compileJsx("const a = <b>;", "react");
    expect(bad.code).toBeUndefined();
    expect(bad.error).toMatch(/line 1/);
  });

  it("makes a kept widget a whole page with its header", () => {
    const k = keptWidget("<p>Umidità</p>", "Umidità dopo il ricambio", "agent_1");
    expect(k.file).toBe("artefatti/umidita-dopo-il-ricambio.html");
    expect(k.text.split("\n")[0]).toBe(
      '<!-- redgiant-artifact {"name":"Umidità dopo il ricambio","version":1,"libs":[],"wants":[],"from":"agent_1"} -->',
    );
    expect(k.text).toContain("<body>\n<p>Umidità</p>");
  });

  it("keeps errors deduplicated, at most 20, and gives each conversation its lines once", () => {
    const e = new ArtifactErrors();
    const key = ArtifactErrors.fileKey("me", "platform", "artefatti/a.html");
    e.shown(key, "s1");
    const err = { kind: "error" as const, message: "x is not defined", where: "line 3" };
    expect(e.report(key, "artefatti/a.html", [err, err], e.sessionsOf(key))).toBe(1);
    expect(e.report(key, "artefatti/a.html", [err], e.sessionsOf(key))).toBe(0);
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: "console" as const,
      message: `m${i}`,
    }));
    e.report(key, "artefatti/a.html", many, ["s1"]);
    expect(e.text(key)).toMatch(/^It met 20 errors/);
    const lines = e.take("s1");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("artefatti/a.html [error] x is not defined (line 3)");
    expect(e.take("s1")).toEqual([]);
  });
});

describe("artifacts in RedGiant (3.5.9)", () => {
  it("serves an artifact through its signed link, with the runtime, the import map and JSX compiled", async () => {
    let step = 0;
    s = await startServer(() => {
      step++;
      if (step === 1)
        return {
          toolCalls: [
            { name: "write_file", input: { path: "artefatti/conti.html", content: APP } },
          ],
        };
      if (step === 2)
        return { toolCalls: [{ name: "show", input: { path: "artefatti/conti.html" } }] };
      return { text: "Fatto." };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    await (await s.core.send("me", body.sessionId, "Fammi un'app per i conti")).done;
    const events = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body;
    const shownResult = events.find(
      (e) => e.type === "tool.result" && JSON.stringify(e.payload).includes("Shown in the canvas"),
    );
    expect(JSON.stringify(shownResult?.payload)).toContain("It runs as an artifact");
    const link = await s.api<{ url: string; artifact?: boolean }>("POST", "/api/canvas/link", {
      kind: "file",
      scope: "platform",
      path: "artefatti/conti.html",
    });
    expect(link.body.artifact).toBe(true);
    expect(link.body.url).toMatch(/\/conti\.html$/);
    const page = await fetch(`${s.url}${link.body.url}`, {
      headers: { "sec-fetch-dest": "iframe" },
    });
    expect(page.status).toBe(200);
    const prefix = link.body.url.replace(/\/conti\.html$/, "");
    const host = new URL(s.url).host;
    expect(page.headers.get("content-security-policy")).toBe(
      artifactHeaders([`http://${host}`, `https://${host}`], prefix)["Content-Security-Policy"],
    );
    const html = await page.text();
    // Ours first: the runtime, then the import map, before anything of the page.
    expect(html.indexOf('<script>(()=>{"use strict"')).toBeLessThan(
      html.indexOf('<script type="importmap">'),
    );
    expect(html.indexOf('<script type="importmap">')).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain(`"react":"${prefix}/lib/react-`);
    expect(html).not.toContain("text/babel");
    expect(html).toMatch(/<script type="module">[^<]*jsx-runtime/);
    // Nothing beside the page and lib/: not the file's folder.
    expect((await fetch(`${s.url}${prefix}/other.html`)).status).toBe(403);
    // Opened on its own in a tab: framed by RedGiant with the artifact's sandbox.
    const top = await fetch(`${s.url}${link.body.url}`, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(await top.text()).toContain('sandbox="allow-scripts allow-forms"');
  }, 60_000);

  it("brings the page's errors to the agent with its next tool result, and to canvas_look", async () => {
    let seen = "";
    let step = 0;
    let sessionId = "";
    s = await startServer((req) => {
      const r = resultOf(req);
      step++;
      if (step === 1)
        return {
          toolCalls: [
            { name: "write_file", input: { path: "artefatti/x.html", content: "<p>x</p>" } },
          ],
        };
      if (step === 2)
        return { toolCalls: [{ name: "show_file", input: { path: "artefatti/x.html" } }] };
      if (step === 3) return { text: "Aperto." };
      if (step === 4) {
        // The page reports while the agent works: the next tool result carries it.
        s?.core.artifactErrors.report(
          ArtifactErrors.fileKey("me", "platform", "artefatti/x.html"),
          "artefatti/x.html",
          [{ kind: "rejection", message: "boom while working" }],
          [sessionId],
        );
        return { toolCalls: [{ name: "read_file", input: { path: "artefatti/x.html" } }] };
      }
      seen = r ?? "";
      return { text: "Corretto." };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    sessionId = body.sessionId;
    await (await s.core.send("me", body.sessionId, "Fai x")).done;
    const show = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body.find(
      (e) => e.type === "tool.result" && JSON.stringify(e.payload).includes("artifact"),
    );
    expect(show).toBeDefined();
    const ref = { kind: "file", scope: "platform", path: "artefatti/x.html" };
    const errors = [
      { kind: "error", message: "Uncaught ReferenceError: y is not defined", where: "line 4" },
      { kind: "error", message: "Uncaught ReferenceError: y is not defined", where: "line 4" },
    ];
    const r = await s.api<{ added: number }>("POST", "/api/artifacts/errors", { ref, errors });
    expect(r.body.added).toBe(1);
    expect(
      s.core.artifactErrors.text(ArtifactErrors.fileKey("me", "platform", "artefatti/x.html")),
    ).toContain("y is not defined");
    // Reported while the agent was away: they ride with the next message, as RedGiant's notes.
    await (await s.core.send("me", body.sessionId, "Funziona?")).done;
    const asked = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body
      .filter((e) => e.type === "message.user")
      .at(-1);
    expect(JSON.stringify(asked?.payload)).toContain("y is not defined");
    expect(seen).toContain("boom while working");
    expect(seen).toContain("artefatti/x.html");
    // A widget of another person's answer, or of none: refused.
    expect(
      (
        await s.api("POST", "/api/artifacts/errors", {
          ref: { kind: "widget", sessionId: body.sessionId, seq: 0, index: 0 },
          errors,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("serves a widget of an answer from the log, keeps it as an artifact, and marks messages sent through it", async () => {
    const answer =
      "Ecco il calcolatore:\n\n```widget Umidità\n<label>T <input id=t></label><button onclick=\"redgiant.sendMessage('Analizza')\">Analizza</button>\n```\n\nProva.";
    s = await startServer((req) => {
      const last = req.messages.at(-1);
      const text = last?.role === "user" ? last.parts.find((p) => p.type === "text") : undefined;
      return { text: text?.type === "text" && text.text === "Analizza" ? "Analizzo." : answer };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    await (await s.core.send("me", body.sessionId, "Umidità?")).done;
    const msg = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body.find(
      (e) => e.type === "message.assistant",
    ) as Event;
    const link = await s.api<{ url: string }>(
      "GET",
      `/api/sessions/${body.sessionId}/widgets/${msg.seq}/0/link`,
    );
    expect(link.body.url).toMatch(/\/widget\.html$/);
    const page = await fetch(`${s.url}${link.body.url}`);
    expect(page.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts allow-forms; default-src 'none'/,
    );
    const html = await page.text();
    expect(html).toContain(
      "<button onclick=\"redgiant.sendMessage('Analizza')\">Analizza</button>",
    );
    expect(html).toContain("background:transparent");
    expect(
      (await s.api("GET", `/api/sessions/${body.sessionId}/widgets/${msg.seq}/1/link`)).status,
    ).toBe(404);
    // «Tienilo»: a file in artefatti/ with a header, opened as an artifact.
    const kept = await s.api<{ scope: string; path: string }>(
      "POST",
      `/api/sessions/${body.sessionId}/widgets/${msg.seq}/0/keep`,
    );
    expect(kept.body).toEqual({ scope: "platform", path: "artefatti/umidita.html" });
    const again = await s.api<{ path: string }>(
      "POST",
      `/api/sessions/${body.sessionId}/widgets/${msg.seq}/0/keep`,
    );
    expect(again.body.path).toBe("artefatti/umidita-2.html");
    const file = await readFile(join(s.core.platformPath("me"), "artefatti/umidita.html"), "utf8");
    expect(file).toMatch(/^<!-- redgiant-artifact \{"name":"Umidità"/);
    // «Fanne un progetto»: the same page as index.html of a folder, without the header.
    const project = await s.api<{ path: string }>("POST", "/api/artifacts/project", {
      scope: "platform",
      path: "artefatti/umidita.html",
      sessionId: body.sessionId,
    });
    expect(project.body.path).toBe("umidita/index.html");
    expect(
      await readFile(join(s.core.platformPath("me"), "umidita/index.html"), "utf8"),
    ).not.toContain("redgiant-artifact");
    // A message sent through the widget's button: the person's, marked.
    await (await s.core.send("me", body.sessionId, "Analizza", { watch: true, via: "artifact" }))
      .done;
    const user = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body
      .filter((e) => e.type === "message.user")
      .at(-1);
    expect(user?.payload).toMatchObject({ text: "Analizza", via: "artifact" });
  }, 60_000);
});
