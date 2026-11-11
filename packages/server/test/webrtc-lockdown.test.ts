// WebRTC off in agent-made pages (3.5.10): the server's half. The lockdown is the first script of
// artifacts, widgets, HTML files and boards (never of a project's program on a port), srcdoc
// attributes written in the page are kept quiet, and SVG or XML files opened as pages run nothing.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactPage, widgetPage } from "../src/artifact-engine.js";
import { rewrite } from "../src/canvas.js";
import {
  lockedPage,
  quietFrames,
  topOf,
  WEBRTC_LOCKDOWN,
  WEBRTC_LOCKDOWN_TAG,
} from "../src/webrtc-lockdown.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const cut = (x: string, a: number, b: number) => x.slice(a, b);
/** The first `<script` of a page is ours, and nothing of the page's own comes before it. */
const firstIsOurs = (html: string) => html.indexOf("<script") === html.indexOf(WEBRTC_LOCKDOWN_TAG);

describe("quietFrames: srcdoc and src of <iframe> and <frame> tags, as the HTML tokenizer reads them", () => {
  it.each([
    ['<iframe srcdoc="<b>">', '<iframe data-rg-srcdoc="<b>">'],
    ["<IFRAME SrcDoc='x'>", "<IFRAME data-rg-SrcDoc='x'>"],
    ["<iframe/srcdoc=x>", "<iframe/data-rg-srcdoc=x>"],
    ['<iframe a="b"srcdoc=c>', '<iframe a="b"data-rg-srcdoc=c>'],
    ['<iframe title=">" srcdoc=x>', '<iframe title=">" data-rg-srcdoc=x>'],
    ["<iframe\nsrcdoc\n=\nx>", "<iframe\ndata-rg-srcdoc\n=\nx>"],
    ["<iframe srcdoc>", "<iframe data-rg-srcdoc>"],
    ["<iframe srcdoc", "<iframe data-rg-srcdoc"],
    ["<iframe a=srcdoc srcdoc=1 srcdoc=2>", "<iframe a=srcdoc data-rg-srcdoc=1 data-rg-srcdoc=2>"],
    ['<iframe src="javascript:x()">', '<iframe data-rg-src="javascript:x()">'],
    ["<frame SRC=x.html>", "<frame data-rg-SRC=x.html>"],
    [
      '<iframe srcdoc="a" src="b.html" id=c>',
      '<iframe data-rg-srcdoc="a" data-rg-src="b.html" id=c>',
    ],
    // Not attributes of a frame: left alone.
    ['<div srcdoc="x">', '<div srcdoc="x">'],
    [
      '<img src="a.png"><script src="b.js"></script>',
      '<img src="a.png"><script src="b.js"></script>',
    ],
    ["<frameset rows=50%><framex src=1>", "<frameset rows=50%><framex src=1>"],
    ["<iframex srcdoc=1>", "<iframex srcdoc=1>"],
    ["<iframe srcdocs=1 xsrcdoc=2 srcs=3>", "<iframe srcdocs=1 xsrcdoc=2 srcs=3>"],
    ['<iframe title="srcdoc=1">', '<iframe title="srcdoc=1">'],
    ["the srcdoc attribute", "the srcdoc attribute"],
  ])("%s", (input, out) => {
    expect(quietFrames(input, cut)).toBe(out);
  });
});

describe("topOf: where nothing of the page comes first", () => {
  it.each([
    ["<p>x", 0],
    ["\uFEFF  <!doctype html><p>", 18],
    ['<!-- redgiant-artifact {"name":"a"} -->\n<!DOCTYPE html>\n<html>', 56],
    ["<!--><script>evil()</script>", 5],
    ["<!---><script>evil()</script>", 6],
    ["<!-- a --!><script>", 11],
    ["<!-- <!-- x --><p>", 15],
    ["<!-- never closed <script>", 0],
    ["<!doctype html", 0],
    ["<!doctypes><p>", 0],
  ])("%j → %i", (html, at) => {
    expect(topOf(html)).toBe(at);
  });

  it("puts the lockdown before the page's tricks, after its doctype", () => {
    for (const html of [
      "<!--><script>evil()</script><head></head>",
      "<!--<head>--><script>evil()</script>",
      "<script>evil()</script><!doctype html>",
      "\uFEFF<!doctype html><html><head><script>evil()</script>",
    ]) {
      const page = lockedPage(html);
      expect(firstIsOurs(page)).toBe(true);
      expect(page.indexOf(WEBRTC_LOCKDOWN_TAG)).toBeLessThan(page.indexOf("evil()"));
    }
    expect(lockedPage("<!doctype html><p>").startsWith("<!doctype html><script>")).toBe(true);
  });

  it("is a classic script with nothing the HTML parser would read as a tag or a comment", () => {
    expect(WEBRTC_LOCKDOWN).not.toMatch(/<\/script|<!--|<script/i);
    expect(() => new Function(WEBRTC_LOCKDOWN)).not.toThrow();
    expect(WEBRTC_LOCKDOWN_TAG.startsWith("<script>")).toBe(true);
    expect(WEBRTC_LOCKDOWN_TAG).not.toContain("type=");
  });
});

describe("the lockdown comes first in every agent-made page", () => {
  it("artifacts and widgets, whatever their shape", async () => {
    for (const html of [
      '<!-- redgiant-artifact {"name":"a","version":1} -->\n<!doctype html><html><head><title>t</title></head><body><script>x()</script></body></html>',
      "<html><body><script>x()</script></body></html>",
      "<script>x()</script>",
      "<!--><script>x()</script><head></head>",
    ]) {
      const page = await artifactPage(html, "/preview/T");
      expect(firstIsOurs(page)).toBe(true);
      const widget = await widgetPage(html, "/preview/T");
      expect(firstIsOurs(widget)).toBe(true);
    }
    // Their own srcdoc attributes are kept quiet (the lockdown gives them back, guarded).
    const page = await artifactPage('<iframe srcdoc="<script>x()</script>"></iframe>', "/p");
    expect(page).toContain('<iframe data-rg-srcdoc="');
  });

  it("HTML files and boards, not a project's program", () => {
    const page = rewrite(
      '<!doctype html><head></head><iframe srcdoc="x">',
      "text/html",
      "/p",
      true,
    );
    expect(page.startsWith(`<!doctype html>${WEBRTC_LOCKDOWN_TAG}`)).toBe(true);
    expect(page).toContain("data-rg-srcdoc");
    const program = rewrite('<head></head><iframe srcdoc="x">', "text/html", "/p");
    expect(program).not.toContain("RTCPeerConnection");
    expect(program).toContain('<iframe srcdoc="x">');
  });

  it("served: a file shown on its own, a folder, a board; SVG and XML run no scripts", async () => {
    s = await startServer(() => ({ text: "ok" }));
    const dir = await mkdtemp(join(tmpdir(), "rg-webrtc-"));
    await writeFile(join(dir, "page.html"), "<!doctype html><p>hi</p>");
    await writeFile(
      join(dir, "pic.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
    );
    await writeFile(join(dir, "feed.xml"), "<x/>");
    const board = s.core.boardDir("0123456789ab");
    await mkdir(board, { recursive: true });
    await writeFile(join(board, "index.html"), "<html><head></head><body>variant</body></html>");
    const get = (token: string, path: string) =>
      fetch(`${s?.url}/preview/${token}/${path}`, { headers: { "sec-fetch-dest": "iframe" } });
    const file = s.core.previews.sign("me", { kind: "file", path: join(dir, "page.html") });
    const folder = s.core.previews.sign("me", { kind: "dir", root: dir });
    const boardToken = s.core.previews.sign("me", { kind: "dir", root: board });
    for (const [token, path] of [
      [file, "page.html"],
      [folder, "page.html"],
      [boardToken, ""],
    ] as const) {
      const html = await (await get(token, path)).text();
      expect(firstIsOurs(html)).toBe(true);
      expect(html).toContain("RTCPeerConnection");
    }
    for (const path of ["pic.svg", "feed.xml"]) {
      const csp = (await get(folder, path)).headers.get("content-security-policy") ?? "";
      expect(csp).toContain("script-src 'none'");
      expect(csp).toMatch(/^sandbox allow-forms/);
      expect(csp).not.toContain("allow-scripts");
    }
    const html = (await get(folder, "page.html")).headers.get("content-security-policy") ?? "";
    expect(html).toContain("allow-scripts");
    expect(html).not.toMatch(/frame-src[^;]*(blob:|data:)/);
  });
});
