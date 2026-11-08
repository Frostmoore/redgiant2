// The extension in a real Chromium (G36.21): link it with a code, fill a sign-in form from the
// field's menu, refuse another site, propose and save an update and a new password, the popup.
// Needs a running RedGiant (the demo server) and Playwright's Chromium (the Playwright image).
//
//   node scripts/e2e.mjs <redgiant url> <person's token> <screenshots dir>
//   BROWSER_PATH=/path/to/opera node scripts/e2e.mjs …     the same in another Chromium (Opera)
//
// Two test sites are served here: http://127.0.0.1:7706 (the credential's) and :7707 (another
// origin on the same host: nothing may be offered there). The overlay's shadow root is closed, so
// the page cannot reach it; the test reaches it through DevTools (DOM with `pierce`) and clicks
// with real mouse events (the overlay ignores clicks a page script makes).

import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE ?? join(here, "../../web/node_modules/playwright-core/index.mjs")
);
const [server = "http://127.0.0.1:7705", token = "demo-token-0123456789", out = "/tmp/rg-ext"] =
  process.argv.slice(2);
const extension = join(here, "..", "dist", "chromium");
const SITE = "http://127.0.0.1:7706";
const OTHER = "http://127.0.0.1:7707";
const problems = [];
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) problems.push(what);
};

// ---------------------------------------------------------------------------------------------
// Test sites

const css =
  "body{font:16px system-ui;margin:0;background:#f4f1ee;color:#222}main{max-width:380px;margin:60px auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 6px 24px #0002}label{display:block;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px;font:inherit;border:1px solid #ccc;border-radius:8px}button{margin-top:18px;width:100%;padding:11px;font:inherit;border:0;border-radius:8px;background:#2d5bd8;color:#fff}";
const html = (title, body) =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
const pages = {
  "/login": html(
    "Accedi",
    `<h1>Officina di prova</h1><form method="post" action="/welcome"><label for="email">Email</label><input id="email" type="email" name="email" autocomplete="username"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password"><button type="submit">Accedi</button></form>`,
  ),
  "/change": html(
    "Cambia password",
    `<h1>Cambia la password</h1><form method="post" action="/changed"><label for="u">Email</label><input id="u" name="email" autocomplete="username" value="ada@example.com"><label for="cur">Password attuale</label><input id="cur" type="password" name="current_password" autocomplete="current-password"><label for="n1">Nuova password</label><input id="n1" type="password" name="new_password" autocomplete="new-password"><label for="n2">Conferma</label><input id="n2" type="password" name="confirm_password" autocomplete="new-password"><button type="submit">Cambia password</button></form>`,
  ),
};
const site = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.method === "POST")
    return req
      .on("data", () => {})
      .on("end", () => res.end(html("Fatto", "<h1>Fatto</h1><p>Benvenuta.</p>")));
  res.end(pages[path] ?? html("Officina", "<h1>Officina</h1>"));
});
await new Promise((r) => site.listen(7706, "127.0.0.1", r));
const other = createServer(site.listeners("request")[0]);
await new Promise((r) => other.listen(7707, "127.0.0.1", r));

// ---------------------------------------------------------------------------------------------
// RedGiant

const api = async (method, path, body) => {
  const r = await fetch(`${server}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return r.json();
};
const entry = await api("POST", "/api/vault", {
  name: "officina",
  service: "Officina di prova",
  category: "login",
  username: "ada@example.com",
  value: "Correct-Horse-7",
  url: `${SITE}/login`,
  hosts: [],
});
ok(entry.id, "credential for the test site saved in RedGiant");

// ---------------------------------------------------------------------------------------------
// Chromium with the extension

const exe = process.env.BROWSER_PATH;
const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), "rg-ext-")), {
  ...(exe ? { executablePath: exe } : { channel: "chromium" }),
  headless: !process.env.HEADED,
  locale: "it-IT",
  viewport: { width: 1100, height: 760 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--lang=it"],
});
const sw =
  ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker", { timeout: 20_000 }));
console.log(`browser: ${await (await ctx.newPage()).evaluate(() => navigator.userAgent)}`);
const id = new URL(sw.url()).host;
ok(/^[a-p]{32}$/.test(id), `extension loaded (${id})`);
const tabOf = (prefix) =>
  sw.evaluate(
    async (p) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(p))?.id,
    prefix,
  );

/** An element of the overlay's closed shadow root, through DevTools: its box, or null. */
async function overlay(page, selector) {
  const cdp = await ctx.newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (n) => {
      if (n.nodeName === "REDGIANT-KEYCHAIN") return n;
      for (const c of n.children ?? []) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    };
    const host = find(root);
    const shadow = host?.shadowRoots?.[0];
    if (!shadow) return null;
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: shadow.nodeId, selector });
    if (!nodeId) return null;
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId }).catch(() => ({}));
    const { outerHTML } = await cdp.send("DOM.getOuterHTML", { nodeId });
    if (!model) return { html: outerHTML };
    const [x1, y1, , , x3, y3] = model.border;
    return { x: (x1 + x3) / 2, y: (y1 + y3) / 2, html: outerHTML, mode: shadow.shadowRootType };
  } finally {
    await cdp.detach();
  }
}
const click = async (page, selector) => {
  const box = await overlay(page, selector);
  if (!box?.x) throw new Error(`not on the page: ${selector}`);
  await page.mouse.click(box.x, box.y);
};
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });

// 1. Linking from the popup.
let popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForSelector("#server");
await shot(popup, "01-popup-link");
const { code } = await api("POST", "/api/vault-browsers/code");
await popup.fill("#server", server);
await popup.fill("#code", code);
await popup.fill("#name", "Opera sul fisso");
await shot(popup, "02-popup-link-filled");
await popup.click("button[type=submit]");
await popup.waitForSelector(".foot", { timeout: 10_000 });
const linked = await api("GET", "/api/vault-browsers");
ok(
  linked.some((b) => b.name === "Opera sul fisso"),
  "linked: RedGiant lists the browser",
);

// 2. The sign-in page: the chip in the field, the menu, filling.
const login = await ctx.newPage();
await login.goto(`${SITE}/login`);
await login.waitForTimeout(800);
await login.click("#email");
await login.waitForTimeout(500);
ok((await overlay(login, ".chip"))?.x > 0, "the key shows in the focused field");
ok(
  await login.evaluate(() => {
    const host = document.querySelector("redgiant-keychain");
    return host !== null && host.shadowRoot === null;
  }),
  "the overlay's shadow root is closed to the page",
);
await click(login, ".chip");
await login.waitForTimeout(300);
const item = await overlay(login, ".item");
ok(
  item?.html.includes("Officina di prova") && item.html.includes("ada@example.com"),
  "the menu offers the site's credential",
);
ok((await overlay(login, ".item:nth-of-type(2)")) === null, "and only that one");
await shot(login, "03-page-menu");
// A click the page makes is ignored.
await login.evaluate(() =>
  document
    .querySelector("redgiant-keychain")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
);
await click(login, ".item");
await login.waitForTimeout(800);
ok(
  (await login.inputValue("#email")) === "ada@example.com" &&
    (await login.inputValue("#pw")) === "Correct-Horse-7",
  "filled on the person's click",
);
await shot(login, "04-page-filled");

// 3. The popup for that tab: search, the credential, the generator.
const tabId = await tabOf(`${SITE}/login`);
await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
await popup.waitForSelector(".entry", { timeout: 8000 });
ok((await popup.locator(".entry").count()) === 1, "the popup lists the site's credential");
await shot(popup, "05-popup-site");
await popup.emulateMedia({ colorScheme: "dark" });
await shot(popup, "05-popup-site-dark");
await popup.emulateMedia({ colorScheme: "light" });
await popup.locator(".gen summary").click();
await shot(popup, "06-popup-generator");
await popup.fill("input[type=search]", "nessuno");
await popup.waitForTimeout(600);
ok((await popup.locator(".entry").count()) === 0, "search narrows the list");
await popup.fill("input[type=search]", "");
await popup.waitForTimeout(600);
// «Copy password»: the value only now, the clipboard emptied 30 s later by an alarm.
await popup.locator(".entry .ico-btn").last().click();
await popup.waitForSelector(".notice.ok", { timeout: 5000 }).catch(() => null);
ok((await popup.locator(".notice.ok").count()) === 1, "«Copy password» copies");
ok(
  (await sw.evaluate(() => chrome.alarms.get("clear-clipboard"))) !== undefined,
  "the clipboard is set to be emptied",
);
// «Fill» from the popup into the tab.
await login.fill("#email", "");
await login.fill("#pw", "");
await popup.locator(".entry .ico-btn").first().click();
await login.waitForTimeout(800);
ok((await login.inputValue("#pw")) === "Correct-Horse-7", "«Fill» in the popup fills the tab");
// The popup closes itself after filling, as a real popup does.
ok(popup.isClosed(), "the popup closes after filling");
popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${id}/popup.html`);

// 4. Another origin (another port of the same host): nothing offered, nothing given.
const phish = await ctx.newPage();
await phish.goto(`${OTHER}/login`);
await phish.waitForTimeout(800);
await phish.click("#email");
await phish.waitForTimeout(500);
ok((await overlay(phish, ".chip")) === null, "another origin: no key in the field");
const phishTab = await tabOf(`${OTHER}/login`);
const refused = await popup.evaluate(
  ([entryId, tab]) => chrome.runtime.sendMessage({ type: "copy", id: entryId, tabId: tab }),
  [entry.id, phishTab],
);
ok(
  refused?.code === "refused" && !JSON.stringify(refused).includes("Correct-Horse"),
  "another origin: the value is refused",
);
await popup.goto(`chrome-extension://${id}/popup.html?tab=${phishTab}`);
await popup.waitForSelector(".empty", { timeout: 8000 });
await shot(popup, "07-popup-other-site");

// 5. Saving a new password on that other site (it is a different site: a new credential).
await phish.fill("#email", "bob@example.com");
await phish.fill("#pw", "Other-Pass-1");
await phish.click("button[type=submit]");
await phish.waitForLoadState();
await phish.waitForTimeout(1500);
const card = await overlay(phish, ".card");
ok(card?.html.includes("Salvare nel portachiavi"), "after sending: «Save in the keychain?»");
await shot(phish, "08-page-save-offer");
await click(phish, ".btn.primary");
await phish.waitForTimeout(1200);
const view1 = await api("GET", "/api/vault");
const saved = view1.entries.find((e) => e.username === "bob@example.com");
ok(saved?.url === OTHER && saved.hosts.join() === "127.0.0.1", "saved for that site only");
await shot(phish, "09-page-saved");

// 6. A change of password on the credential's site: «Update».
await login.goto(`${SITE}/change`);
await login.waitForTimeout(600);
await login.fill("#cur", "Correct-Horse-7");
await login.fill("#n1", "Brand-New-Pass-9");
await login.fill("#n2", "Brand-New-Pass-9");
await login.click("button[type=submit]");
await login.waitForLoadState();
await login.waitForTimeout(1500);
ok(
  (await overlay(login, ".card"))?.html.includes("Aggiornare la password"),
  "after a change: «Update the password?»",
);
await shot(login, "10-page-update-offer");
await click(login, ".btn.primary");
await login.waitForTimeout(1200);
const revealed = await api("POST", `/api/vault/${entry.id}/reveal`);
ok(revealed.value === "Brand-New-Pass-9", "updated in the keychain");

// 7. Every use in the keychain's record.
const uses = (await api("GET", "/api/vault")).uses.filter((u) => u.tool === "browser_extension");
const seen = new Set(uses.map((u) => `${u.method}:${u.outcome}`));
for (const k of ["FILL:used", "COPY:used", "COPY:refused", "SAVE:used", "UPDATE:used"])
  ok(seen.has(k), `recorded: ${k}`);

// 8. Unlinked from RedGiant: the extension knows at once.
const me = linked.find((b) => b.name === "Opera sul fisso");
await api("DELETE", `/api/vault-browsers/${me.id}`);
await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForSelector("#server", { timeout: 8000 });
ok(true, "unlinked: the popup asks for a code again");

await ctx.close();
site.close();
other.close();
console.log(problems.length ? `${problems.length} problems` : "all good");
process.exit(problems.length ? 1 : 0);
