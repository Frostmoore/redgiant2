// Goes through the setup wizard of a fresh install like a person would, with screenshots.
// Usage: ANTHROPIC_KEY=… node wizard-e2e.mjs <url> <token> <outdir>
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "it-IT" });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const step = (title) =>
  page.waitForSelector(`.wz-body h2:has-text("${title}")`, { timeout: 120_000 });
const button = (text) => page.locator(".wz-body button", { hasText: text }).first();

await page.goto(`${url}/#token=${token}`);
await page.waitForSelector(".setup");
await shot("wz-1-welcome");
await button("Inizia").click();

await step("Modelli");
await page.fill('input[placeholder="sk-ant-…"]', process.env.ANTHROPIC_KEY ?? "");
await page.fill('input[list="wz-models"]', "anthropic/claude-sonnet-5-5");
await page.locator(".wz-body select").first().selectOption("low");
await shot("wz-2-models");
await button("Salva e continua").click();

await step("Modello locale");
await page.fill(".wz-body form.row input", "gemma-3-270m-it");
await button("Cerca").click();
await page.waitForSelector('.wz-body option[value="unsloth/gemma-3-270m-it-GGUF"]', {
  state: "attached",
});
await page.locator(".wz-body select").first().selectOption("unsloth/gemma-3-270m-it-GGUF");
await page.waitForSelector(".wz-best");
await shot("wz-3-local-files");
await page.locator(".wz-best button").click();
await page.waitForSelector(".wz-body .row:has-text('✓')", { timeout: 600_000 });
await page.locator(".wz-body button", { hasText: "Avvia" }).first().click();
await page.waitForSelector(".wz-body .notice.ok", { timeout: 300_000 });
await shot("wz-4-local-engine");
await button("Avanti").click();

await step("Nomi");
const names = page.locator(".wz-body input");
await names.nth(0).fill("Zeus");
await names.nth(1).fill("Hermes");
await button("Salva e continua").click();

await step("Telegram");
await shot("wz-5-telegram");
await button("Salta").click();

await step("Sicurezza e costi");
const numbers = page.locator('.wz-body input[type="number"]');
await numbers.nth(0).fill("10");
await numbers.nth(1).fill("365");
await page.locator('.wz-body input[type="checkbox"]').last().check();
await shot("wz-6-safety");
await button("Salva e continua").click();

await step("Fine");
await shot("wz-7-done");
await button("Inizia a usare RedGiant").click();
await page.waitForSelector(".sidebar");
await page.waitForTimeout(500);
await shot("wz-8-app");
await browser.close();
console.log("wizard done");
