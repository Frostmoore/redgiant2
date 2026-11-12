// Hands-free voice (G38.4), a whole turn in a real Chromium: the microphone is a WAV file
// (--use-file-for-fake-audio-capture) that says the wake word, then a question, then nothing.
// The demo server runs with DEMO_VOICE=1 (a transcription stand-in on 127.0.0.1) and DEMO_VOSK
// (the wake word's models already prepared), so the wake word is heard by Vosk in the page for
// real, the end of speech by the VAD, and the answer comes from the scripted model.
//
// Usage: node voice-e2e.mjs <url> <token> <outdir> <wav> [chromium]
// The WAV was made with espeak-ng (GPL, never shipped: only for this test), «ehi red giant»,
// a pause, «che ore sono a Roma adesso», silence.
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const [url, token, out, wav, exe] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  ...(exe && { executablePath: exe }),
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

async function home(page) {
  await page.goto(`${url}/#token=${token}`);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("rg.remoteNotice", "hidden");
  });
  await page.goto(`${url}/#token=${token}`);
  await page.waitForSelector(".bar");
  await page.waitForTimeout(800);
  const news = page.locator(".whats-new button.primary");
  if (await news.count()) await news.first().click();
}

async function openVoiceSettings(page) {
  const menu = page.locator('button[aria-label="Menu"]');
  if (await menu.isVisible().catch(() => false)) await menu.click();
  await page.locator(".bar-settings").click();
  await page.waitForSelector(".settings");
  await page.waitForTimeout(300);
  // On a phone the sections are in a sheet from below.
  const pick = page.locator(".st-pick");
  if (await pick.isVisible().catch(() => false)) {
    await pick.click();
    await page.locator(".st-sheet-list .st-nav-item", { hasText: "Voce" }).first().click();
  } else await page.locator(".settings-nav .st-nav-item", { hasText: "Voce" }).first().click();
  await page.waitForSelector("text=Voce a mani libere su questo dispositivo");
}

// ---- A whole turn on a computer ----
{
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    locale: "it-IT",
    colorScheme: "light",
  });
  await context.grantPermissions(["microphone"], { origin: url });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("console:", m.text().slice(0, 300));
  });
  await home(page);
  // The conversation the words go to: God's, open in front.
  await page.locator('.bar-god button[title="Nuova conversazione"]').click();
  await page.waitForTimeout(800);
  await openVoiceSettings(page);
  await page.screenshot({ path: `${out}/desk-light-settings-off.png` });
  await page.getByRole("switch", { name: "Voce a mani libere su questo dispositivo" }).click();
  // The model comes to the page with its bar (the server has it already in this demo).
  const bar = page.locator(".vc-model [role=progressbar]");
  if (await bar.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/desk-light-settings-model-download.png` });
  }
  await page.waitForSelector("text=La parola di attivazione è pronta", { timeout: 120_000 });
  check(true, "the wake word's model came to the page and started");
  await page.screenshot({ path: `${out}/desk-light-settings-on.png` });
  // Back to the conversation: it is the one in front now.
  await page.locator(".tab:not(:has-text('Impostazioni')) .tab-label").first().click();
  await page.waitForTimeout(300);

  // The indicator's words, as they change.
  const seen = [];
  const watch = setInterval(async () => {
    const l = await page
      .locator(".voice-ind")
      .getAttribute("aria-label")
      .catch(() => null);
    if (l && seen.at(-1) !== l) seen.push(l);
  }, 100);
  await page.screenshot({ path: `${out}/desk-light-waiting.png` });
  await page.waitForSelector(".voice-ind.hot", { timeout: 60_000 });
  await page.screenshot({ path: `${out}/desk-light-listening.png` });
  await page.waitForSelector(".from.via-voice", { timeout: 60_000 });
  check(true, "the request reached the conversation, marked «detto a voce»");
  const bubble = page.locator(".bubble.user").last();
  const said = (await bubble.textContent()) ?? "";
  check(
    said.includes("che ore sono a Roma") && !said.includes("voice-mode"),
    `the person's words without the note: «${said.trim()}»`,
  );
  await page.waitForSelector("text=15:30", { timeout: 30_000 });
  await page.waitForSelector(".voice-ind.busy", { timeout: 10_000 }).catch(() => {});
  await page.screenshot({ path: `${out}/desk-light-speaking.png` });
  await page.locator(".voice-ind").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/desk-light-panel.png` });
  await page.locator(".voice-ind").click();
  await page.waitForFunction(
    () =>
      /senza parola|Ti ascolto|Sta ascoltando/.test(
        document.querySelector(".voice-ind")?.getAttribute("aria-label") ?? "",
      ),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
  clearInterval(watch);
  console.log("indicator:", seen.join(" → "));
  // Transcribing and thinking too, with the local stand-ins: they may pass between two looks.
  const order = ["Sta ascoltando", "Ti ascolto", "Sto parlando"];
  let at = -1;
  const inOrder = order.every((w) => {
    const i = seen.findIndex((l, k) => k > at && l.includes(w));
    if (i < 0) return false;
    at = i;
    return true;
  });
  check(inOrder, "the indicator went: waiting → listening → (transcribing, thinking) → speaking");
  check(
    seen.some((l) => l.includes("senza parola")) ||
      seen.some((l, i) => i > at && l.includes("Ti ascolto")),
    "after the answer it kept listening without the wake word",
  );
  // «Ferma» and «Spegni»: the microphone closes, the indicator goes.
  await page.locator(".voice-ind").click();
  await page.getByRole("button", { name: "Spegni" }).click();
  await page.waitForTimeout(300);
  check(
    (await page.locator(".voice-ind").count()) === 0,
    "switched off: no indicator, nothing listens",
  );
  await context.close();
}

// ---- Settings and the indicator on a phone, light and dark; the desk in dark ----
for (const scheme of ["light", "dark"]) {
  for (const [kind, size] of [
    ["phone", { width: 390, height: 844 }],
    ["desk", { width: 1366, height: 820 }],
  ]) {
    if (kind === "desk" && scheme === "light") continue;
    const context = await browser.newContext({
      viewport: size,
      locale: "it-IT",
      colorScheme: scheme,
      ...(kind === "phone" && { hasTouch: true, isMobile: true }),
    });
    await context.grantPermissions(["microphone"], { origin: url });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    await home(page);
    await openVoiceSettings(page);
    await page.getByRole("switch", { name: "Voce a mani libere su questo dispositivo" }).click();
    await page.waitForSelector("text=La parola di attivazione è pronta", { timeout: 120_000 });
    await page.screenshot({ path: `${out}/${kind}-${scheme}-settings.png`, fullPage: false });
    await page.locator(".vc-limits").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/${kind}-${scheme}-settings-limits.png` });
    await page.locator(".voice-ind").click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/${kind}-${scheme}-panel.png` });
    await context.close();
  }
}

await browser.close();
if (failures.length) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
console.log("all good");
