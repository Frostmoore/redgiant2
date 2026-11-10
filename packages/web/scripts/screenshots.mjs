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
  // God's question, waiting for the human.
  await page.locator(".session-row .open", { hasText: "Plan the export" }).click();
  await page.waitForSelector(".question-card .option");
  await page.locator(".question-card .option", { hasText: "Both" }).click();
  await page.locator(".question-card .option", { hasText: "Filters by date" }).click();
  await page.waitForTimeout(300);
  await shot("02c-question");
  await page
    .locator(".top .limits")
    .screenshot({ path: `${out}/${scheme}-02d-limits-subscription.png` });
  // 3.5.6: a turn that reached the step limit, «Continua» under its summary.
  await page.locator(".session-row .open", { hasText: "Rinomina le colonne" }).click();
  await page.waitForSelector(".step-continue");
  await page.waitForTimeout(300);
  await shot("02e-step-limit");
  await page.locator(".session-row .open", { hasText: "Give me a quick tour" }).click();

  // The project's files on the right, a file and a terminal next to the chat.
  await page.locator('button[aria-label="File del progetto e terminale"]').click();
  await page.waitForSelector(".explorer .tree-row");
  await page.locator(".tree-row", { hasText: "src" }).click();
  await page.locator(".tree-row", { hasText: "app.py" }).click();
  // Files open in the Canvas (p3.5.1), the editor on the common model.
  await page.waitForSelector(".canvas .cm-content");
  await page.waitForTimeout(300);
  await shot("03-files-editor");
  await page.locator('.explorer button[title="Terminale"]').click();
  await page.waitForSelector(".xterm");
  await page.waitForTimeout(800);
  await shot("04-terminal");
  // Previews: a picture and a PDF.
  await page.locator(".tree-row", { hasText: "docs" }).click();
  await page.locator(".tree-row", { hasText: "report.pdf" }).click();
  await page.waitForSelector(".canvas .vw-pdf-pages canvas");
  await page.waitForTimeout(500);
  await shot("04b-pdf");
  await page.locator(".tree-row", { hasText: "diagram.svg" }).click();
  await page.waitForSelector(".canvas .vw-image img");
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
  await page.locator(".bar-settings").click();
  await page.waitForSelector(".settings");
  await shot("10-settings-general");
  for (const [section, name] of [
    ["Agenti", "11-settings-agents"],
    ["Automazioni", "12-settings-automations"],
    ["Estensioni", "13-settings-extensions"],
    ["Storico delle modifiche", "14-settings-history"],
    ["Budget", "19-settings-budget"],
    ["Configurazione", "15-settings-setup"],
    ["Modelli e abbonamenti", "16-settings-models"],
    ["Dove sta il codice", "17-settings-code"],
    ["Accesso da fuori", "18-settings-remote"],
    ["Comandi", "20-settings-commands"],
  ]) {
    await page.locator(".settings-nav button", { hasText: section }).click();
    await page.waitForTimeout(500);
    await shot(name);
    // No one types JSON (G24.10): a visible, writable field holding JSON is a failure.
    const json = await page.evaluate(() =>
      [...document.querySelectorAll(".settings input, .settings textarea")]
        .filter((el) => el.offsetParent !== null && !el.readOnly && !el.disabled)
        .map((el) => el.value.trim())
        .filter((v) => /^[[{][\s\S]*[\]}]$/.test(v)),
    );
    if (json.length > 0) {
      console.error(`JSON to type by hand in ${section}:`, json);
      process.exitCode = 1;
    }
  }
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
await phone.locator(".composer textarea").click();
await phone.waitForTimeout(300);
await phone.locator(".composer").screenshot({ path: `${out}/phone-04-composer.png` });

await browser.close();
console.log("done");
