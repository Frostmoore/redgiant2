// RedGiant's service worker: it makes the web UI installable as an app. It caches nothing on
// purpose: the UI talks to the server live, and a stale copy would be worse than none.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
