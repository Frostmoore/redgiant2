// RedGiant's frame for LibreOffice in the browser (G37.4). It runs alone in its isolated frame
// (Document-Isolation-Policy: SharedArrayBuffer for LibreOffice's threads) and talks to the canvas
// over a BroadcastChannel named in its address. It checks what the engine needs (an isolated,
// secure page and WebGL in workers), keeps the engine's files in the Cache Storage the first time
// (telling how much came), starts LibreOffice with our thread script (office-thread.js), and
// passes the canvas's requests to it: open, apply actions, export, close. Files go through the
// engine's own file system (/tmp/rg). Macros never run.

(() => {
  const VERSION = "zeta-24-2-2025-05-13";
  /** The engine's files the frame keeps, with their size once decompressed. */
  const FILES = [
    ["soffice.wasm", 161667499, "application/wasm"],
    ["soffice.data", 99520604, "application/octet-stream"],
    ["soffice.data.js.metadata", 215180, "application/octet-stream"],
  ];
  const channel = new BroadcastChannel(`rg-office-${location.hash.slice(1)}`);
  const post = (m) => channel.postMessage({ ...m, from: "frame" });
  const canvas = document.getElementById("qtcanvas");
  let port;
  let started;
  let opens = 0;
  const waiting = new Map();
  let nextId = 1;

  function toThread(cmd, extra) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      port.postMessage({ ...extra, cmd, id });
    });
  }

  function webglInWorker() {
    return new Promise((resolve) => {
      const src =
        "let ok=false;try{ok=!!new OffscreenCanvas(4,4).getContext('webgl')}catch(e){};postMessage(ok)";
      try {
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        w.onmessage = (e) => {
          resolve(e.data === true);
          w.terminate();
        };
        w.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
      } catch {
        resolve(false);
      }
    });
  }

  /** The engine's big files, from the Cache Storage or the server (with the progress). */
  async function prefetch() {
    const urls = {};
    const cache =
      "caches" in self ? await caches.open(`rg-zeta-${VERSION}`).catch(() => null) : null;
    const total = FILES.reduce((n, f) => n + f[1], 0);
    let done = 0;
    let told = 0;
    for (const [name, size, type] of FILES) {
      const url = new URL(`lowa/${name}`, location.href).href;
      const hit = cache ? await cache.match(url) : undefined;
      if (hit) {
        done += size;
        urls[name] = URL.createObjectURL(await hit.blob());
        post({ t: "progress", done, total, cached: true });
        continue;
      }
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const parts = [];
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        parts.push(r.value);
        done += r.value.length;
        if (done - told > 1_000_000) {
          told = done;
          post({ t: "progress", done, total });
        }
      }
      const blob = new Blob(parts, { type });
      if (cache)
        await cache
          .put(url, new Response(blob, { headers: { "content-type": type } }))
          .catch(() => {});
      urls[name] = URL.createObjectURL(blob);
      post({ t: "progress", done, total });
    }
    if ("caches" in self)
      for (const k of await caches.keys().catch(() => []))
        if (k.startsWith("rg-zeta-") && k !== `rg-zeta-${VERSION}`)
          await caches.delete(k).catch(() => {});
    return urls;
  }

  function boot(urls) {
    return new Promise((resolve, reject) => {
      const base = new URL("lowa/", location.href).href;
      window.Module = {
        canvas,
        uno_scripts: [
          new URL("zeta.js", location.href).href,
          new URL("office-thread.js", location.href).href,
        ],
        locateFile: (p, prefix) => urls[p] || (prefix || base) + p,
        mainScriptUrlOrBlob: new Blob([`importScripts('${base}soffice.js');`], {
          type: "text/javascript",
        }),
      };
      const s = document.createElement("script");
      s.src = `${base}soffice.js`;
      s.onerror = () => reject(new Error("soffice.js did not load"));
      s.onload = () =>
        window.Module.uno_main.then((p) => {
          port = p;
          port.onmessage = (e) => {
            const d = e.data;
            if (d.cmd === "running") return resolve();
            if (d.cmd === "modified") return post({ t: "modified" });
            const w = waiting.get(d.id);
            if (!w) return;
            waiting.delete(d.id);
            if (d.cmd === "error") w.reject(new Error(d.message));
            else w.resolve(d);
          };
        }, reject);
      document.body.appendChild(s);
    });
  }

  const fsDir = () => {
    try {
      window.FS.mkdir("/tmp/rg");
    } catch {}
  };

  // Ctrl+S or Cmd+S (not with Alt or Shift) while the person types in the document: the page
  // saves now (its shortcut, which never reaches it from inside this frame). LibreOffice's own
  // Save never runs: it would only write the engine's private copy.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (String(e.key).toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) post({ t: "save-key" });
    },
    true,
  );

  let lastTyping = 0;
  canvas.addEventListener("keydown", () => {
    const now = Date.now();
    if (now - lastTyping > 1000) {
      lastTyping = now;
      post({ t: "typing" });
    }
  });
  window.addEventListener("error", (e) =>
    post({ t: "log", message: String(e.message).slice(0, 300) }),
  );

  channel.onmessage = async (e) => {
    const m = e.data;
    if (!m || m.from === "frame") return;
    try {
      if (m.t === "check") {
        post({
          t: "check",
          req: m.req,
          isolated: self.crossOriginIsolated === true,
          secure: self.isSecureContext === true,
          webgl: await webglInWorker(),
          memory: navigator.deviceMemory ?? null,
        });
      } else if (m.t === "start") {
        // Started once; asked again (another tab of the page), it answers when ready.
        started ??= prefetch().then(boot);
        await started;
        post({ t: "ready", req: m.req });
      } else if (m.t === "open") {
        fsDir();
        // A new name each time: LibreOffice hands back a document already open at the same path.
        opens += 1;
        const path = `/tmp/rg/doc-${opens}.${m.app === "impress" ? "odp" : "odt"}`;
        window.FS.writeFile(path, new Uint8Array(m.bytes));
        for (const [hash, b] of Object.entries(m.pictures ?? {}))
          window.FS.writeFile(`/tmp/rg/pic-${hash}`, new Uint8Array(b));
        const r = await toThread("load", { path, app: m.app, pending: m.pending ?? [] });
        setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
        post({ t: "opened", req: m.req, skipped: r.skipped });
      } else if (m.t === "apply") {
        fsDir();
        for (const [hash, b] of Object.entries(m.pictures ?? {}))
          window.FS.writeFile(`/tmp/rg/pic-${hash}`, new Uint8Array(b));
        const r = await toThread("apply", {
          actions: m.actions,
          title: m.title,
          revision: m.revision,
        });
        post({ t: "applied", req: m.req, revision: m.revision, skipped: r.skipped });
      } else if (m.t === "export") {
        const r = await toThread("export", {});
        const bytes = window.FS.readFile(r.path);
        post({
          t: "exported",
          req: m.req,
          bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        });
      }
    } catch (err) {
      post({
        t: "error",
        req: m.req,
        during: m.t,
        message: String((err && err.message) || err).slice(0, 500),
      });
    }
  };
  post({ t: "hello" });
})();
