// The README's screenshots (G36.11), in English, against the demo server.
// Usage: node readme-shots.mjs <url> <token> <outdir> [main|knowledge]
// "main" needs the demo started with DEMO_SUBAGENTS=1 DEMO_KEYS=1 DEMO_NVIDIA=1
// REDGIANT_HOST_GPUS="NVIDIA GeForce RTX 4070:12"; "knowledge" with DEMO_KNOWLEDGE=1.
// Needs a Chromium: the Playwright image has one. Shrink the files afterwards (pngquant).
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out, mode = "main"] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();

async function open(scheme, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport, colorScheme: scheme, locale: "en-US" });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(`${url}/#token=${token}`);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("rg.lang", "en");
    localStorage.setItem("rg.newsSeen", "3.4.0");
    localStorage.setItem("rg.remoteNotice", "hidden");
  });
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await page.waitForTimeout(600);
  return page;
}

async function settings(page, section) {
  await page.locator(".bar-settings").click();
  await page.locator(".settings-nav button", { hasText: section }).click();
  await page.waitForTimeout(800);
}

if (mode === "knowledge") {
  const page = await open("dark");
  await settings(page, "Knowledge");
  await page.locator(".settings-body").screenshot({ path: `${out}/knowledge.png` });
  await page.close();
} else {
  // A team at work: God split a release among sub-agents, one asks for your yes (a lower
  // window, so the README's opening fits in one screen).
  let page = await open("dark", { width: 1440, height: 780 });
  await page.locator(".session-row .open", { hasText: "Start the test server" }).click();
  await page.waitForSelector(".bubble.assistant");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/team.png` });
  await page.close();

  // The Canvas beside the chat, light theme: a 3D model to turn.
  page = await open("light");
  await page.locator(".session-row .open", { hasText: "Show me what you made" }).click();
  await page.waitForTimeout(800);
  await page.getByText("Cube", { exact: true }).last().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/canvas.png` });
  await page.close();

  page = await open("dark");
  await settings(page, "Keychain");
  await page.locator(".settings-body").screenshot({ path: `${out}/keychain.png` });
  await settings(page, "Automations");
  await page.getByText("Magic automation", { exact: true }).first().click({ force: true });
  await page.waitForSelector(".ui-modal-back");
  await page.waitForTimeout(800);
  await page
    .locator(".ui-modal-back")
    .locator("textarea")
    .first()
    .fill(
      "Every Monday at 9, read my work mailbox and send me on Telegram the invoices that came in",
    );
  await page.locator(".ui-modal").screenshot({ path: `${out}/magic-automation.png` });
  await page.close();

  // A local model: the card, SSD stream on, and the models with their speed on this computer.
  page = await open("dark");
  await settings(page, "Models and subscriptions");
  await page
    .locator("button", { has: page.getByText("A model on this computer", { exact: true }) })
    .last()
    .click({ force: true });
  await page.waitForTimeout(1500);
  const ssd = page.locator('[role="switch"][aria-label="SSD stream"]');
  if ((await ssd.getAttribute("aria-checked")) !== "true") await ssd.click();
  await page.waitForTimeout(1200);
  await page.locator(".settings-body").screenshot({ path: `${out}/local-models.png` });
  await page.close();

  page = await open("light");
  await settings(page, "Tools");
  await page.locator(".settings-body").screenshot({ path: `${out}/tools.png` });
  await page.close();

  page = await open("dark", { width: 390, height: 844 });
  await page.locator('button[aria-label="Menu"]').click();
  await page.waitForTimeout(400);
  await page.locator(".session-row .open", { hasText: "Start the test server" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/phone.png` });
  await page.close();
}

await browser.close();
console.log("done");
