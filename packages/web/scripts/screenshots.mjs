// Screenshots of the web UI against a running (demo) server, light and dark, desktop and phone.
// Usage: node screenshots.mjs <url> <token> <outdir>   (needs a Chromium: the Playwright image has one)
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();

for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
    locale: "it-IT",
  });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  const shot = (name) => page.screenshot({ path: `${out}/${scheme}-${name}.png` });
  await page.goto(`${url}/#token=${token}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await shot("01-home");

  // A project's conversation with its orchestrator.
  await page.locator(".bar-item", { hasText: "Demo" }).click();
  await page.locator(".session-row .open", { hasText: "Give me a quick tour" }).click();
  await page.waitForSelector(".bubble.assistant");
  await page.waitForTimeout(400);
  await shot("02-conversation");
  // The composer's model menu.
  await page.locator(".composer button.model").click();
  await page.waitForSelector(".model-menu .menu [role=menuitem]");
  await shot("02b-model-menu");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 300);
  // God's question, waiting for the human.
  await page.locator(".session-row .open", { hasText: "Plan the export" }).click();
  await page.waitForSelector(".question-card .option");
  await page.locator(".question-card .option", { hasText: "Both" }).click();
  await page.locator(".question-card .option", { hasText: "Filters by date" }).click();
  await page.waitForTimeout(300);
  await shot("02c-question");
  await page.locator(".session-row .open", { hasText: "Give me a quick tour" }).click();

  // The project's files on the right, a file and a terminal next to the chat.
  await page.locator('button[aria-label="File del progetto e terminale"]').click();
  await page.waitForSelector(".explorer .tree-row");
  await page.locator(".tree-row", { hasText: "src" }).click();
  await page.locator(".tree-row", { hasText: "app.py" }).click();
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(300);
  await shot("03-files-editor");
  await page.locator('.explorer button[title="Terminale"]').click();
  await page.waitForSelector(".xterm");
  await page.waitForTimeout(800);
  await shot("04-terminal");
  // Previews: a picture and a PDF.
  await page.locator(".tree-row", { hasText: "docs" }).click();
  await page.locator(".tree-row", { hasText: "report.pdf" }).click();
  await page.waitForSelector(".pdf-pages canvas");
  await page.waitForTimeout(500);
  await shot("04b-pdf");
  await page.locator(".tree-row", { hasText: "diagram.svg" }).click();
  await page.waitForSelector(".preview img");
  await page.waitForTimeout(300);
  await shot("04c-image");
  await page.locator('.explorer button[title="Chiudi"]').click();
  while (await page.locator(".side-tab .icon-button").count())
    await page.locator(".side-tab .icon-button").first().click();

  await page.locator('button[aria-label="Da approvare"]').click();
  await page.waitForSelector(".panel");
  await shot("05-bell");
  await page.locator('.panel button[title="Chiudi"]').click();

  await page.locator('button[aria-label="Cerca nelle conversazioni"]').click();
  await page.fill(".search input", "project");
  await page.locator(".search button[type=submit]").click();
  await page.waitForTimeout(600);
  await shot("06-search");
  await page.locator('.search button[title="Chiudi"]').click();

  // The daily chat and a project's inspector.
  await page.locator(".bar-item", { hasText: "Chat" }).click();
  await page.locator(".sessions .session-row .open", { hasText: "moka" }).click();
  await page.waitForSelector(".dailychat .bubble.user");
  await shot("07-daily-chat");
  await page.locator(".bar-row", { hasText: "Demo" }).hover();
  await page.locator('.project-actions button[title="Inspector"]').click();
  await page.waitForTimeout(400);
  await page.locator(".dailychat select").last().selectOption({ index: 1 });
  await page.waitForTimeout(600);
  await shot("08-inspector");
  await page.locator('.project-actions button[title="Bacheca"]').click();
  await page.waitForSelector(".thread-item");
  await shot("09-board");

  // Settings: every section.
  await page.locator('button[title="Impostazioni"]').first().click();
  await page.waitForSelector(".settings");
  await shot("10-settings-general");
  for (const [section, name] of [
    ["Agenti", "11-settings-agents"],
    ["Automazioni", "12-settings-automations"],
    ["Estensioni", "13-settings-extensions"],
    ["Piattaforma", "14-settings-platform"],
    ["Configurazione", "15-settings-setup"],
    ["Notifiche", "16-settings-notifications"],
    ["Dispositivi", "17-settings-devices"],
  ]) {
    await page.locator(".settings-nav button", { hasText: section }).click();
    await page.waitForTimeout(500);
    await shot(name);
  }
  await page.locator(".settings button", { hasText: "Abbina un dispositivo" }).click();
  await page.waitForSelector(".qr svg");
  await shot("18-pairing");
  await page.close();
}

const phone = await browser.newPage({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  locale: "it-IT",
});
await phone.goto(`${url}/#token=${token}`);
await phone.waitForSelector(".top");
await phone.waitForTimeout(500);
await phone.screenshot({ path: `${out}/phone-01.png` });
await phone.locator('button[aria-label="Menu"]').click();
await phone.waitForTimeout(400);
await phone.screenshot({ path: `${out}/phone-02-menu.png` });
await phone.locator(".bar-item", { hasText: "Demo" }).click();
await phone.locator(".session-row .open", { hasText: "Give me a quick tour" }).click();
await phone.waitForTimeout(600);
await phone.screenshot({ path: `${out}/phone-03-conversation.png` });

await browser.close();
console.log("done");
