// Every Settings section, whole (the scrolling body measured and the window grown to it), dark and
// light, on a computer and on a phone. Usage: node settings-shots.mjs <url> <token> <outdir>
// [section-filter, several with commas]   (needs a Chromium: the Playwright image has one)
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out, only] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const slug = (s) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Whatever window opened by itself (what's new…) closes first. */
async function closeWindows(page) {
  for (let i = 0; i < 4 && (await page.locator(".ui-modal-veil").count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if (await page.locator(".ui-modal-veil").count())
      await page.locator(".ui-modal-veil").first().click({ force: true });
    await page.waitForTimeout(200);
  }
}

const devices = [
  ["desk", 1440, 900],
  ["phone", 390, 844],
];
// SHOTS_WIDE=1: a wide screen too (the person's), where a page drawn off-centre shows.
if (process.env.SHOTS_WIDE) devices.push(["wide", 1920, 1080]);
// SHOTS_DEVICE / SHOTS_SCHEME: only one of them (desk, phone, wide; dark, light).
for (const [device, width, height] of devices) {
  if (process.env.SHOTS_DEVICE && process.env.SHOTS_DEVICE !== device) continue;
  for (const scheme of ["dark", "light"]) {
    if (process.env.SHOTS_SCHEME && process.env.SHOTS_SCHEME !== scheme) continue;
    const page = await browser.newPage({
      viewport: { width, height },
      colorScheme: scheme,
      locale: "it-IT",
    });
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    await page.goto(`${url}/#token=${token}`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${url}/#token=${token}`);
    await page.waitForSelector(".bar, .top");
    await page.waitForTimeout(800);
    await closeWindows(page);
    if (device === "phone") {
      await page.locator('button[aria-label="Menu"]').click();
      await page.waitForTimeout(300);
    }
    await page.locator(".bar-settings").click();
    await page.waitForSelector(".settings");
    const names = await page
      .locator(".settings-nav .st-nav-item .st-nav-name")
      .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    for (const [i, name] of names.entries()) {
      const file = `${out}/${device}-${scheme}-${String(i + 1).padStart(2, "0")}-${slug(name)}.png`;
      if (only && !only.split(",").some((o) => slug(name).includes(o))) continue;
      await closeWindows(page);
      if (device === "phone") {
        await page.locator(".st-pick").click();
        await page.locator(".st-sheet-list .st-nav-item").nth(i).click();
      } else await page.locator(".settings-nav .st-nav-item").nth(i).click();
      await page.waitForTimeout(900);
      // SHOTS_CLICK: buttons to press first, by their words (comma-separated): «Mostra le copie»…
      for (const words of (process.env.SHOTS_CLICK ?? "").split(",").filter(Boolean)) {
        const button = page.locator(".settings-body button", { hasText: words });
        if (await button.count()) {
          await button.first().click();
          await page.waitForTimeout(900);
        }
      }
      const full = await page.evaluate(() => {
        const b = document.querySelector(".settings-body");
        return b ? b.scrollHeight - b.clientHeight : 0;
      });
      await page.setViewportSize({ width, height: Math.min(height + full, 12000) });
      await page.waitForTimeout(250);
      await page.screenshot({ path: file });
      // The same page in pieces a person (or a model) can read at full size.
      const left = await page.evaluate(
        () => document.querySelector(".settings-body")?.getBoundingClientRect().left ?? 0,
      );
      const total = Math.min(height + full, 12000);
      const step = device === "phone" ? 1100 : 1000;
      await mkdir(`${out}/parts`, { recursive: true });
      for (let y = 0, n = 1; y < total; y += step, n++)
        await page.screenshot({
          path: file.replace(`${out}/`, `${out}/parts/`).replace(/\.png$/, `-${n}.png`),
          clip: { x: left, y, width: width - left, height: Math.min(step, total - y) },
        });
      await page.setViewportSize({ width, height });
    }
    await page.close();
  }
}
await browser.close();
console.log("done");
