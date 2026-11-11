// Memory of the canvas's editors (G37.9, 3.5.11): each editor opened and closed N times, then
// several tabs at once; after a forced garbage collection, the page's JS heap, its DOM nodes,
// listeners, documents and frames, and the PSS of every Chromium process (the browser's task
// manager). Drives the page's own modules, so it needs a build with export names kept:
//   REDGIANT_KEEP_EXPORTS=1 REDGIANT_WEB_OUT=<dir> vite build
//   DEMO_CANVAS=1 DEMO_WEB=<dir> node demo-server.mjs <port>
//   CHROME=<chromium> node perf-memory.mjs <url> <token> <dir> <out.json> [rounds] [only,these]
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [url, token, dist, out, roundsArg, onlyArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 10);
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
const stateFile = `/${Object.values(manifest).find((c) => /^assets\/state-[^/]+\.js$/.test(c.file)).file}`;

/** The editors and a file each (DEMO_CANVAS's folder), with what shows it is ready. */
const EDITORS = [
  { name: "text", path: "canvas/app.py", ready: ".cm-content" },
  { name: "markdown", path: "canvas/guida.md", ready: ".cm-content" },
  { name: "sheet-csv", path: "canvas/spese.csv", ready: ".canvas canvas" },
  { name: "sheet-xlsx", path: "canvas/bilancio.xlsx", ready: ".canvas canvas" },
  { name: "svg", path: "canvas/poster.svg", ready: ".canvas svg" },
  { name: "model-gltf", path: "canvas/stanza.gltf", ready: ".canvas canvas" },
  { name: "model-obj", path: "canvas/sedia.obj", ready: ".canvas canvas" },
  { name: "pdf", path: "canvas/modulo.pdf", ready: ".canvas canvas" },
  { name: "image-png", path: "canvas/fiore.png", ready: ".canvas canvas, .canvas img" },
  { name: "image-ora", path: "canvas/poster.ora", ready: ".canvas canvas" },
  { name: "docx", path: "canvas/relazione.docx", ready: ".canvas .vw-btn, .canvas iframe" },
].filter((e) => !onlyArg || onlyArg.split(",").includes(e.name));

const MARK = `--rg-perf-${process.pid}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info", MARK],
});

/** Every process of this browser (the one with our mark and its descendants). */
function processes() {
  const all = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  const parent = new Map();
  let root;
  for (const p of all) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      parent.set(p, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!root && readFileSync(`/proc/${p}/cmdline`, "utf8").includes(MARK)) root = p;
    } catch {}
  }
  const mine = new Set(root ? [root] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [p, pp] of parent)
      if (!mine.has(p) && mine.has(pp)) {
        mine.add(p);
        grew = true;
      }
  }
  return [...mine];
}
/** PSS of the browser's processes in MB (shared pages counted once, shared out fairly). */
function pss() {
  let kb = 0;
  for (const p of processes()) {
    try {
      const m = readFileSync(`/proc/${p}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)/m);
      kb += Number(m?.[1] ?? 0);
    } catch {}
  }
  return kb / 1024;
}

const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: "it-IT" });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await page.addInitScript(() => localStorage.setItem("rg.remoteNotice", "hidden"));
await page.goto(`${url}/#token=${token}`);
await page.waitForSelector(".bar");
await page.waitForTimeout(1500);
const news = page.locator(".whats-new button.primary");
if (await news.count()) await news.first().click();

async function measure() {
  for (let i = 0; i < 3; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(200);
  }
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return {
    heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: m.Nodes,
    listeners: m.JSEventListeners,
    documents: m.Documents,
    frames: m.Frames,
    pssMB: +pss().toFixed(0),
  };
}

const open = (e) =>
  page.evaluate(
    async ([f, path]) => {
      const s = await import(f);
      return s.openCanvas(path.split("/").pop(), { kind: "file", scope: "platform", path });
    },
    [stateFile, e.path],
  );
const close = (id) =>
  page.evaluate(
    async ([f, id]) => {
      const s = await import(f);
      s.closeSide(id);
    },
    [stateFile, id],
  );
async function ready(e) {
  const t0 = Date.now();
  // A locator, not waitForSelector: the handle it returns would keep the closed editor alive.
  await page
    .locator(e.ready)
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => {});
  const ms = Date.now() - t0;
  // Let it settle (workers, first paint of every part).
  await page.waitForTimeout(1500);
  return ms;
}

const results = [];
// Warm up: the code of each editor loaded once, so the rounds measure what stays alive.
for (const e of EDITORS) {
  const id = await open(e);
  e.firstMs = await ready(e);
  await close(id);
  await page.waitForTimeout(300);
}
const start = await measure();
console.log("start", JSON.stringify(start));
for (const e of EDITORS) {
  const before = await measure();
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const id = await open(e);
    times.push(await ready(e));
    await close(id);
    await page.waitForTimeout(300);
  }
  const after = await measure();
  const r = {
    editor: e.name,
    firstOpenMs: e.firstMs,
    openMs: times.sort((a, b) => a - b)[Math.floor(times.length / 2)],
    before,
    after,
    heapGrowthMB: +(after.heapMB - before.heapMB).toFixed(1),
    pssGrowthMB: after.pssMB - before.pssMB,
  };
  console.log(JSON.stringify(r));
  results.push(r);
}
// Several tabs at once: every editor open together, then all closed.
const together0 = await measure();
const ids = [];
for (const e of EDITORS) {
  ids.push(await open(e));
  await ready(e);
}
const together = await measure();
for (const id of ids) await close(id);
await page.waitForTimeout(1000);
const afterAll = await measure();
const summary = { start, together0, together, afterAll, end: afterAll };
console.log("all open", JSON.stringify(together), "all closed", JSON.stringify(afterAll));
await writeFile(out, JSON.stringify({ rounds, results, summary }, null, 2));
await browser.close();
