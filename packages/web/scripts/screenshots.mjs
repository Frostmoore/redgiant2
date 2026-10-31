// Screenshots of the web UI against a running (demo) server.
// Usage: node screenshots.mjs <url> <token> <outdir>   (needs a Chromium: the Playwright image has one)
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "it-IT" });
page.on("pageerror", (e) => console.error("pageerror:", e.message));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

await page.goto(url);
await shot("01-login");
await page.fill("input[type=password]", token);
await page.click("button[type=submit]");
await page.waitForSelector(".sidebar");

await page.click("text=Demo orchestrator");
await page.waitForSelector("[data-testid=metrics]");
await page.waitForTimeout(500);
await shot("02-chat");

await page.locator(".project").getByText("File").click();
await page.waitForSelector(".tree-row");
await page.locator(".tree-row", { hasText: "src" }).click();
await page.locator(".tree-row", { hasText: "app.py" }).dblclick();
await page.waitForSelector(".cm-content");
await page.locator(".tab.active button[title='Dividi a destra']").click();
await page.waitForTimeout(400);
await shot("03-split-chat-files-editor");

await page.locator(".project").getByText("Terminale").click();
await page.waitForSelector(".xterm");
await page.waitForTimeout(800);
await page.keyboard.type("ls -la && python3 src/app.py\n");
await page.waitForTimeout(1200);
await shot("04-terminal");

await page.click("text=Gerarchia");
await page.waitForSelector(".node-row");
await shot("05-hierarchy");

await page.locator(".project").getByText("Bacheca").click();
await page.waitForSelector(".thread-item");
await page.locator(".thread-item", { hasText: "Output format" }).click();
await page.waitForSelector(".post");
await shot("06b-board");

await page.click("text=Budget");
await page.waitForSelector(".budgets");
await shot("06-budgets");

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await shot("07-mobile");
await page.click(".hamburger");
await page.waitForTimeout(300);
await shot("08-mobile-menu");

await browser.close();
console.log("done");
