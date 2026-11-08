// The link to RedGiant: its address and this browser's device token (G36.21).
//
// The token lives in `storage.session` (memory only, gone when the browser closes, not readable by
// content scripts). When the person chooses to stay linked, a copy goes in `storage.local` sealed
// with AES-GCM under a key the browser keeps in IndexedDB as non-extractable: the files on disk
// never hold the token in the clear. Passwords are never stored here at all.

import { ext } from "./ext.js";

export interface Link {
  server: string;
  token: string;
  name: string;
}

/** True for addresses that never leave home: this computer, the local network, `.local` names. */
export function homeHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) return h === "::1" || /^f[cd]/.test(h) || h.startsWith("fe80:");
  return (
    !h.includes(".") ||
    h === "localhost" ||
    /\.(local|lan|home|internal|home\.arpa|localhost|ts\.net)$/.test(h)
  );
}

export type ServerCheck = { ok: true; origin: string } | { ok: false; why: "bad" | "insecure" };

/**
 * RedGiant's address as the person writes it (`localhost:7650`, `redgiant.example.com`, a full
 * address with a path): its origin. http only at home; away from home https is required.
 */
export function serverOrigin(raw: string): ServerCheck {
  const text = raw.trim();
  if (!text) return { ok: false, why: "bad" };
  let u: URL;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
      ? text
      : `${homeHost(text.split(/[/:]/)[0] ?? "") ? "http" : "https"}://${text}`;
    u = new URL(withScheme);
  } catch {
    return { ok: false, why: "bad" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, why: "bad" };
  if (!u.hostname || u.username || u.password) return { ok: false, why: "bad" };
  if (u.protocol === "http:" && !homeHost(u.hostname)) return { ok: false, why: "insecure" };
  return { ok: true, origin: u.origin };
}

/** Which browser this is, for the name RedGiant shows (Opera, Edge, Brave, Chrome, Firefox). */
export function browserKind(nav: { userAgent: string; brave?: unknown } = navigator): string {
  const ua = nav.userAgent;
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "opera";
  if (/\bEdg\//.test(ua)) return "edge";
  if (nav.brave) return "brave";
  if (/\bFirefox\//.test(ua)) return "firefox";
  if (/\bChrome\//.test(ua)) return "chrome";
  return "other";
}

export const BROWSER_LABEL: Record<string, string> = {
  opera: "Opera",
  edge: "Edge",
  brave: "Brave",
  firefox: "Firefox",
  chrome: "Chrome",
  other: "Browser",
};

// ---------------------------------------------------------------------------------------------
// Storage

const SESSION_KEY = "link";
const SEALED_KEY = "linkSealed";
let memory: Link | null = null;

function openKeys(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open("redgiant-keychain", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

/** The sealing key: made once, non-extractable, kept by the browser in IndexedDB. */
async function sealingKey(): Promise<CryptoKey> {
  const db = await openKeys();
  const stored = await new Promise<CryptoKey | undefined>((ok, ko) => {
    const q = db.transaction("keys").objectStore("keys").get("link");
    q.onsuccess = () => ok(q.result as CryptoKey | undefined);
    q.onerror = () => ko(q.error);
  });
  if (stored) return stored;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await new Promise<void>((ok, ko) => {
    const tx = db.transaction("keys", "readwrite");
    tx.objectStore("keys").put(key, "link");
    tx.oncomplete = () => ok();
    tx.onerror = () => ko(tx.error);
  });
  return key;
}

const b64 = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function seal(link: Link): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sealingKey(),
    new TextEncoder().encode(JSON.stringify(link)),
  );
  return { iv: b64(iv), data: b64(data) };
}

async function unseal(s: { iv: string; data: string }): Promise<Link | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(s.iv) },
      await sealingKey(),
      unb64(s.data),
    );
    const l = JSON.parse(new TextDecoder().decode(plain)) as Link;
    return typeof l.token === "string" && typeof l.server === "string" ? l : null;
  } catch {
    return null;
  }
}

export async function loadLink(): Promise<Link | null> {
  if (memory) return memory;
  const session = ext.storage.session;
  if (session) {
    const got = (await session.get(SESSION_KEY))[SESSION_KEY] as Link | undefined;
    if (got?.token) {
      memory = got;
      return got;
    }
  }
  const sealed = (await ext.storage.local.get(SEALED_KEY))[SEALED_KEY] as
    | { iv: string; data: string }
    | undefined;
  if (!sealed) return null;
  const l = await unseal(sealed);
  if (!l) {
    await ext.storage.local.remove(SEALED_KEY);
    return null;
  }
  memory = l;
  await session?.set({ [SESSION_KEY]: l });
  return l;
}

export async function saveLink(link: Link, remember: boolean): Promise<void> {
  memory = link;
  await ext.storage.session?.set({ [SESSION_KEY]: link });
  if (remember) await ext.storage.local.set({ [SEALED_KEY]: await seal(link) });
  else await ext.storage.local.remove(SEALED_KEY);
}

export async function forgetLink(): Promise<void> {
  memory = null;
  await ext.storage.session?.remove(SESSION_KEY);
  await ext.storage.local.remove(SEALED_KEY);
}
