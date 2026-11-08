// The extension's background (a service worker on Chromium, an event page on Firefox): the only
// part that talks to RedGiant and holds the device token. Which page asks is read from the
// browser's `sender` (the page's real address, top frame only), never from the message: a page can
// never ask for another site's password. Values are fetched at the moment of filling or copying
// and handed over at once; nothing keeps them, except a password just typed in a form, for two
// minutes in session memory, until the person saves it or says no.

import type { BrowserExtCheck, BrowserExtSite } from "@redgiant/protocol";
import { clearClipboardHere } from "./clipboard.js";
import { ext } from "./ext.js";
import { browserKind, forgetLink, loadLink, saveLink, serverOrigin } from "./link.js";
import type { Failure, PageMessage, Request, SaveOffer, Status } from "./messages.js";

const PENDING_MS = 2 * 60_000;
const CLEAR_ALARM = "clear-clipboard";

const fail = (code: string, error = code): Failure => ({ error, code });

/** A request to RedGiant with the device token; a 401 means the link was revoked. */
async function call<T>(path: string, body?: unknown): Promise<T | Failure> {
  const link = await loadLink();
  if (!link) return fail("unlinked");
  let r: Response;
  try {
    r = await fetch(`${link.server}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${link.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    return fail("offline");
  }
  const json = (await r.json().catch(() => ({}))) as T & Partial<Failure>;
  if (r.status === 401) {
    await forgetLink();
    return fail("unlinked");
  }
  if (!r.ok) return fail(json.code ?? `http_${r.status}`, json.error ?? `HTTP ${r.status}`);
  return json;
}

const isFailure = (x: unknown): x is Failure =>
  typeof x === "object" && x !== null && "error" in x && "code" in x;

/** A message from the extension's own pages (the popup), not from a web page's content script. */
const fromExtension = (sender: chrome.runtime.MessageSender) =>
  sender.url?.startsWith(ext.runtime.getURL("")) === true;

/** The page a message speaks for: the sender's own page, or the tab the popup names. */
async function pageOf(
  sender: chrome.runtime.MessageSender,
  tabId: number | undefined,
): Promise<{ url: string; tabId: number } | null> {
  // The popup (an extension page, also when opened in a tab): the tab it names.
  if (sender.url?.startsWith(ext.runtime.getURL(""))) {
    if (tabId === undefined) return null;
    const tab = await ext.tabs.get(tabId).catch(() => null);
    return tab?.url ? { url: tab.url, tabId } : null;
  }
  // A content script: its top frame's real address, as the browser reports it.
  if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.url) return null;
  return { url: sender.url, tabId: sender.tab.id };
}

/** Sends to a tab's top frame, putting the content script there first if it is missing. */
async function toTab(tabId: number, m: PageMessage): Promise<{ ok: boolean; code?: string }> {
  const send = () => ext.tabs.sendMessage<{ ok: boolean; code?: string }>(tabId, m, { frameId: 0 });
  try {
    return await send();
  } catch {
    try {
      await ext.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return await send();
    } catch {
      return { ok: false, code: "no_form" };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The clipboard: emptied 30 seconds after a copy (an alarm survives the worker going to sleep).

async function clearClipboard(): Promise<void> {
  if (ext.offscreen) {
    await ext.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["CLIPBOARD"],
        justification: "Empty the clipboard 30 seconds after a password was copied",
      })
      .catch(() => {});
    await ext.runtime.sendMessage({ type: "offscreen-clear" }).catch(() => {});
    await ext.offscreen.closeDocument().catch(() => {});
  } else clearClipboardHere(document);
}

ext.alarms.onAlarm.addListener((a) => {
  if (a.name === CLEAR_ALARM) void clearClipboard();
});

// ---------------------------------------------------------------------------------------------
// A password just sent in a form, waiting for «Save» (session memory only, two minutes).

interface Pending {
  url: string;
  username: string;
  password: string;
  check: BrowserExtCheck;
  host: string;
  at: number;
}
const pendingKey = (tabId: number) => `pending:${tabId}`;

async function getPending(tabId: number): Promise<Pending | null> {
  const area = ext.storage.session;
  if (!area) return memoryPending.get(tabId) ?? null;
  const p = (await area.get(pendingKey(tabId)))[pendingKey(tabId)] as Pending | undefined;
  if (!p) return null;
  if (Date.now() - p.at > PENDING_MS) {
    await area.remove(pendingKey(tabId));
    return null;
  }
  return p;
}
const memoryPending = new Map<number, Pending>();
async function setPending(tabId: number, p: Pending | null): Promise<void> {
  const area = ext.storage.session;
  if (!area) {
    if (p) memoryPending.set(tabId, p);
    else memoryPending.delete(tabId);
    return;
  }
  if (p) await area.set({ [pendingKey(tabId)]: p });
  else await area.remove(pendingKey(tabId));
}
/** A check still on its way, per tab: the next page waits for it before asking. */
const checking = new Map<number, Promise<unknown>>();
const offerOf = (p: Pending): SaveOffer => ({ check: p.check, host: p.host, username: p.username });

// ---------------------------------------------------------------------------------------------

async function status(): Promise<Status> {
  const link = await loadLink();
  if (!link) return { linked: false };
  const s = await call<{ name: string; ready: boolean }>("/api/browser-ext/status");
  if (isFailure(s)) {
    if (s.code === "unlinked") return { linked: false };
    return { linked: true, server: link.server, name: link.name, reachable: false };
  }
  return { linked: true, server: link.server, name: s.name, reachable: true, ready: s.ready };
}

async function pair(m: Extract<Request, { type: "pair" }>): Promise<{ ok: true } | Failure> {
  const s = serverOrigin(m.server);
  if (!s.ok) return fail(s.why === "insecure" ? "insecure" : "bad_server");
  const health = await fetch(`${s.origin}/api/health`, { credentials: "omit", cache: "no-store" })
    .then((r) => r.json() as Promise<{ ok?: boolean }>)
    .catch(() => null);
  if (!health?.ok) return fail("no_server");
  let r: Response;
  try {
    r = await fetch(`${s.origin}/api/browser-ext/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: m.code, name: m.name, browser: browserKind() }),
      credentials: "omit",
      redirect: "error",
    });
  } catch {
    return fail("no_server");
  }
  const j = (await r.json().catch(() => ({}))) as {
    token?: string;
    name?: string;
  } & Partial<Failure>;
  if (!r.ok || !j.token) return fail(j.code ?? "bad_code", j.error ?? `HTTP ${r.status}`);
  await saveLink({ server: s.origin, token: j.token, name: j.name ?? m.name }, m.remember);
  return { ok: true };
}

async function handle(m: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (m.type) {
    case "status":
      return status();
    case "pair":
      return pair(m);
    case "unpair": {
      await call("/api/browser-ext/unpair", {});
      await forgetLink();
      return { ok: true };
    }
    case "site": {
      const page = await pageOf(sender, m.tabId);
      if (!page) return fail("not_web");
      return call<BrowserExtSite>("/api/browser-ext/site", { url: page.url, q: m.q ?? "" });
    }
    case "fill": {
      const page = await pageOf(sender, m.tabId);
      if (!page) return fail("not_web");
      const v = await call<{ value: string; username: string }>("/api/browser-ext/value", {
        id: m.id,
        url: page.url,
        purpose: "fill",
      });
      if (isFailure(v)) return v;
      // The page's own menu: the answer goes back to that very frame.
      if (!fromExtension(sender)) return v;
      return toTab(page.tabId, {
        type: "do-fill",
        origin: new URL(page.url).origin,
        username: v.username,
        value: v.value,
      });
    }
    case "copy": {
      const page = await pageOf(sender, m.tabId);
      if (!page || !fromExtension(sender)) return fail("not_web");
      return call<{ value: string; username: string }>("/api/browser-ext/value", {
        id: m.id,
        url: page.url,
        purpose: "copy",
      });
    }
    case "copied":
      await ext.alarms.create(CLEAR_ALARM, { delayInMinutes: 0.5 });
      return { ok: true };
    case "fill-new": {
      const page = await pageOf(sender, m.tabId);
      if (!page || !fromExtension(sender)) return fail("not_web");
      return toTab(page.tabId, {
        type: "do-fill-new",
        origin: new URL(page.url).origin,
        value: m.value,
      });
    }
    case "sent": {
      const page = fromExtension(sender) ? null : await pageOf(sender, undefined);
      if (!page || typeof m.password !== "string" || !m.password) return { offer: null };
      const asked = call<BrowserExtCheck>("/api/browser-ext/check", {
        url: page.url,
        username: String(m.username ?? "").slice(0, 200),
        password: m.password,
      });
      checking.set(page.tabId, asked);
      const check = await asked.finally(() => {
        if (checking.get(page.tabId) === asked) checking.delete(page.tabId);
      });
      if (isFailure(check) || (check.state !== "new" && check.state !== "changed"))
        return { offer: null };
      const p: Pending = {
        url: page.url,
        username: String(m.username ?? ""),
        password: m.password,
        check,
        host: new URL(page.url).hostname,
        at: Date.now(),
      };
      await setPending(page.tabId, p);
      return { offer: offerOf(p) };
    }
    case "pending": {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0) return { offer: null };
      await checking.get(tabId)?.catch(() => {});
      const p = await getPending(tabId);
      return { offer: p ? offerOf(p) : null };
    }
    case "save": {
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0) return fail("not_web");
      const p = await getPending(tabId);
      if (!p) return fail("expired");
      const r = await call<{ entryId: string; state: string }>("/api/browser-ext/save", {
        url: p.url,
        username: String(m.username ?? p.username).slice(0, 200),
        password: p.password,
        service: String(m.service ?? "").slice(0, 80),
        hosts: Array.isArray(m.hosts) ? m.hosts.map(String).slice(0, 20) : [],
        ...(p.check.state === "changed" && p.check.entryId && { entryId: p.check.entryId }),
      });
      await setPending(tabId, null);
      return r;
    }
    case "dismiss": {
      if (sender.tab?.id !== undefined) await setPending(sender.tab.id, null);
      return { ok: true };
    }
    default:
      return fail("unknown");
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as Request & { type?: string };
  // Only the extension's own pages and content scripts reach here; the offscreen page's
  // messages are for it alone.
  if (sender.id !== ext.runtime.id || typeof m?.type !== "string" || m.type.startsWith("offscreen"))
    return undefined;
  handle(m, sender).then(sendResponse, (err: unknown) =>
    sendResponse(fail("failed", (err as Error).message)),
  );
  return true;
});
