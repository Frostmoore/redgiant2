// p3.5.6: the layered picture editor's Move with a selection, in a real browser (the page has no
// canvas under jsdom). Alt moves the outline only; a drag cuts the selected pixels, carries them
// and drops them as one change; one undo puts them back. Exits 1 on a failure.
// Usage: DEMO_CANVAS=1 node demo-server.mjs 4791, then
//        [CHROMIUM=/path/to/chrome] node image-move-e2e.mjs <url> <token> <outdir>
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 900 },
    locale: "it-IT",
    colorScheme: scheme,
  });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(`${url}/#token=${token}`);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("rg.remoteNotice", "hidden");
  });
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await page.waitForTimeout(1200);
  const news = page.locator(".whats-new button.primary");
  if (await news.count()) await news.first().click();
  await page.locator("button", { hasText: "Mostra il file canvas/poster.ora" }).first().click();
  await page.waitForTimeout(1500);
  await page.locator(".canvas-line").first().click();
  await page.waitForSelector(".img-over");
  await page.waitForTimeout(2500);
  const over = page.locator(".img-view");
  const box = await over.boundingBox();
  // Pixels of the composite at picture coordinates (the view canvas is the picture's size).
  const px = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const v = document.querySelector(".img-view");
        return [...v.getContext("2d").getImageData(x, y, 1, 1).data];
      },
      [x, y],
    );
  const size = await page.evaluate(() => {
    const v = document.querySelector(".img-view");
    return [v.width, v.height];
  });
  const k = box.width / size[0];
  const P = (x, y) => [box.x + x * k, box.y + y * k];
  const drag = async (a, b, alt = false) => {
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(...P(...a));
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(...P(a[0] + ((b[0] - a[0]) * i) / 8, a[1] + ((b[1] - a[1]) * i) / 8));
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    await page.waitForTimeout(800);
  };
  // The current layer: the topmost unlocked one in the panel.
  // The sun's layer, a selection around the sun.
  await page
    .locator(".img-layers *, .svg-body *", { hasText: /^Sole$/ })
    .last()
    .click();
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="Selezione rettangolare (R)"]').click();
  const sun = [629, 169];
  await drag([520, 60], [740, 280]);
  await page.locator('button[aria-label="Sposta il livello, o i pixel selezionati (M)"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${scheme}-1-selection.png` });
  const sunColour = await px(...sun);
  const there = [sun[0] - 400, sun[1]];
  const thereBefore = await px(...there);
  const selText = () =>
    page
      .locator(".img-help", { hasText: / a \d+, \d+|Nessuna/ })
      .first()
      .innerText()
      .catch(() => "?");
  console.log("selection:", await selText());
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  // Alt: the outline alone, the pixels stay.
  await drag([600, 150], [600, 230], true);
  check(same(await px(...sun), sunColour), `${scheme}: Alt moves the outline only`);
  await page.screenshot({ path: `${out}/${scheme}-2-outline-moved.png` });
  console.log("after Alt down:", await selText());
  await drag([600, 230], [600, 150], true);
  console.log("after Alt back:", await selText());
  // The pixels: cut, dragged, dropped.
  await drag([600, 150], [200, 150]);
  await page.waitForTimeout(1500);
  console.log("after the drop:", await selText());
  await page.screenshot({ path: `${out}/${scheme}-3-pixels-moved.png` });
  check(
    same(await px(...there), sunColour),
    `${scheme}: the sun lands 400 px left (${sunColour} at ${there}: ${await px(...there)})`,
  );
  check(
    !same(await px(...sun), sunColour),
    `${scheme}: where it was, the sun is gone (${await px(...sun)})`,
  );
  // The background layers stayed where they were (only the sun's pixels moved).
  // Undo: one change, the picture as it was.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(2000);
  check(same(await px(...there), thereBefore), `${scheme}: one undo takes the sun away from there`);
  check(same(await px(...sun), sunColour), `${scheme}: and puts it back`);
  await page.screenshot({ path: `${out}/${scheme}-4-undone.png` });
  await page.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
