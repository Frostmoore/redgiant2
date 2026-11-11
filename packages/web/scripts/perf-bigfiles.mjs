// Big files in the canvas (G37.9, 3.5.11): time to open, frames while scrolling (the wheel) and
// while typing, the page's memory once open. Same build and demo as perf-memory.mjs; the files
// must be in DEMO_CANVAS's folder (platform: canvas/…).
//   CHROME=<chromium> node perf-bigfiles.mjs <url> <token> <dir> <out.json> [only,these]
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [url, token, dist, out, onlyArg] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
const stateFile = `/${Object.values(manifest).find((c) => /^assets\/state-[^/]+\.js$/.test(c.file)).file}`;

const FILES = [
  { name: "text-5MB", path: "canvas/testo-5mb.txt", ready: ".cm-content", type: true },
  { name: "csv-100k", path: "canvas/righe-100k.csv", ready: ".canvas canvas", type: true },
  { name: "pdf-300", path: "canvas/pagine-300.pdf", ready: ".canvas .page canvas" },
  { name: "ora-4000x3000x10", path: "canvas/livelli-4000x3000.ora", ready: ".canvas canvas" },
  { name: "glb-50MB", path: "canvas/terreno-50mb.glb", ready: ".canvas canvas" },
].filter((f) => !onlyArg || onlyArg.split(",").includes(f.name));

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
});
const results = [];
for (const f of FILES) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, locale: "it-IT" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.addInitScript(() => {
    localStorage.setItem("rg.remoteNotice", "hidden");
    // Frames and long tasks, read after each step.
    const w = window;
    w.__frames = [];
    w.__long = [];
    let last = performance.now();
    const tick = (t) => {
      w.__frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(e.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await page.waitForTimeout(1500);
  const news = page.locator(".whats-new button.primary");
  if (await news.count()) await news.first().click();
  const heap0 = (await cdp.send("Performance.getMetrics")).metrics.find(
    (m) => m.name === "JSHeapUsedSize",
  ).value;
  const reset = () =>
    page.evaluate(() => {
      window.__frames = [];
      window.__long = [];
    });
  const frames = async () => {
    const { fr, lt } = await page.evaluate(() => ({ fr: window.__frames, lt: window.__long }));
    const s = [...fr].sort((a, b) => a - b);
    return {
      frames: fr.length,
      p95ms: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(1),
      worstMs: +(s.at(-1) ?? 0).toFixed(0),
      over50: fr.filter((x) => x > 50).length,
      longTasks: lt.length,
      longestTaskMs: +Math.max(0, ...lt).toFixed(0),
    };
  };
  await reset();
  const t0 = Date.now();
  await page.evaluate(
    async ([s, path]) =>
      (await import(s)).openCanvas(path.split("/").pop(), {
        kind: "file",
        scope: "platform",
        path,
      }),
    [stateFile, f.path],
  );
  const shown = await page
    .locator(f.ready)
    .first()
    .waitFor({ timeout: 180_000 })
    .then(() => true)
    .catch(() => false);
  const openMs = Date.now() - t0;
  const opening = await frames();
  await page.waitForTimeout(2000);
  // Scrolling: the wheel over the middle of the canvas, 30 steps.
  const box = await page.locator(".canvas").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await reset();
  const s0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
  const scroll = { ...(await frames()), ms: Date.now() - s0 };
  let typing;
  if (f.type) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await reset();
    const k0 = Date.now();
    await page.keyboard.type("prova di scrittura ", { delay: 30 });
    await page.waitForTimeout(500);
    typing = { ...(await frames()), ms: Date.now() - k0 };
  }
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Performance.getMetrics")).metrics.find(
    (m) => m.name === "JSHeapUsedSize",
  ).value;
  const r = {
    file: f.name,
    shown,
    openMs,
    opening,
    scroll,
    ...(typing && { typing }),
    heapMB: +((heap - heap0) / 1048576).toFixed(1),
    errors: [...new Set(errors)].slice(0, 3),
  };
  console.log(JSON.stringify(r));
  results.push(r);
  await page.screenshot({ path: out.replace(/\.json$/, `-${f.name}.png`) });
  await page.close();
}
await browser.close();
await writeFile(out, JSON.stringify(results, null, 2));
