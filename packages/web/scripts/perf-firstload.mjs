// First load on a cold cache with a slow network (G37.9, 3.5.11): time to the page's shell, to a
// conversation, and to an open sheet editor, with the bytes that crossed the network.
// Usage: node perf-firstload.mjs <url> <token> <out.json> [runs]
// CHROME: the Chromium to use (the Playwright image has one).
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
// Chrome DevTools' presets (throughput in bytes per second, latency in ms).
const PROFILES = {
  "fast-3g": {
    latency: 562.5,
    downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8,
    uploadThroughput: (750 * 1024 * 0.9) / 8,
  },
  "4g": {
    latency: 165,
    downloadThroughput: (9 * 1024 * 1024 * 0.9) / 8,
    uploadThroughput: (1.5 * 1024 * 1024 * 0.9) / 8,
  },
};

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const results = [];
for (const [name, net] of Object.entries(PROFILES)) {
  for (let i = 0; i < runs; i++) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "it-IT",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...net });
    let bytes = 0;
    let requests = 0;
    cdp.on("Network.loadingFinished", (e) => {
      bytes += e.encodedDataLength;
      requests++;
    });
    await page.addInitScript(() => {
      localStorage.setItem("rg.remoteNotice", "hidden");
    });
    const t0 = Date.now();
    await page.goto(`${url}/#token=${token}`, { waitUntil: "commit" });
    await page.waitForSelector(".bar", { timeout: 180_000 });
    const shell = Date.now() - t0;
    const shellBytes = bytes;
    await page.waitForLoadState("networkidle", { timeout: 180_000 }).catch(() => {});
    const idle = Date.now() - t0;
    const idleBytes = bytes;
    const news = page.locator(".whats-new button.primary");
    if (await news.count()) await news.first().click();
    // A conversation: the first chat view.
    const c0 = Date.now();
    await page.locator(".bar-item", { hasText: "Demo" }).click();
    await page.locator(".session-row .open", { hasText: "Give me a quick tour" }).click();
    await page.waitForSelector(".bubble.assistant", { timeout: 180_000 });
    const chat = Date.now() - c0;
    // A file in the canvas (the text editor) on the same page.
    const f0 = Date.now();
    const b0 = bytes;
    await page.locator('button[aria-label="File del progetto e terminale"]').click();
    await page.waitForSelector(".explorer .tree-row");
    await page.locator(".tree-row", { hasText: "src" }).click();
    await page.locator(".tree-row", { hasText: "app.py" }).click();
    await page.waitForSelector(".canvas .cm-content", { timeout: 180_000 });
    const editor = Date.now() - f0;
    const editorBytes = bytes - b0;
    const r = {
      profile: name,
      run: i + 1,
      shell,
      shellBytes,
      idle,
      idleBytes,
      chat,
      editor,
      editorBytes,
      requests,
    };
    console.log(JSON.stringify(r));
    results.push(r);
    await context.close();
  }
}
await browser.close();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = Object.keys(PROFILES).map((profile) => {
  const rs = results.filter((r) => r.profile === profile);
  const m = (k) => median(rs.map((r) => r[k]));
  return {
    profile,
    shell: m("shell"),
    shellBytes: m("shellBytes"),
    idle: m("idle"),
    idleBytes: m("idleBytes"),
    chat: m("chat"),
    editor: m("editor"),
    editorBytes: m("editorBytes"),
  };
});
console.log(JSON.stringify(summary, null, 1));
await writeFile(out, JSON.stringify({ results, summary }, null, 2));
