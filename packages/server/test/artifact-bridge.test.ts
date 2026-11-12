// The artifacts' bridge (3.6, G38.7): capabilities declared by the header and granted by the person
// only (first use through their channels, or Settings › Artifacts), never carried by an import;
// `ask` answered by the agent that made the artifact in a conversation of its own with no tools,
// within the artifact's cap and a rate limit, rebuilt from the log; `storage` per artifact, text
// only, 5 MB, exported only on request; `files` read only inside the granted folder of the
// project, never a secret, a hidden file, a link that leaves or a path that climbs out.
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARTIFACT_ASK_PER_MINUTE,
  ARTIFACT_GRANT_TOOL,
  BridgeCall,
  type PermissionRequestInfo,
  requestSentence,
  withArtifactHeader,
} from "@redgiant/protocol";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactBridge,
  artifactId,
  askSessionId,
  BridgeFailure,
  normalRel,
} from "../src/artifact-bridge.js";
import { startServer, TOKEN, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const PAGE = "<!doctype html><html><body><h1>Cruscotto</h1></body></html>\n";
const art = (name: string, wants: string[], from?: string) =>
  withArtifactHeader(PAGE, { name, version: 1, libs: [], wants, ...(from && { from }) });

/** A server with a project, God, an agent in the project and its artifacts and data. */
async function setup() {
  const srv = await startServer((req) => {
    const last = req.messages.at(-1);
    const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
    return { text: `Risposta a: ${text}`, usage: { inputTokens: 100, outputTokens: 20 } };
  });
  s = srv;
  const god = await srv.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  await srv.api("POST", "/api/projects", { name: "Shop" });
  const agent = await srv.core.registry.create(
    { type: "human", ownerId: "me" },
    { kind: "orchestrator", parentId: god.body.id, projectId: "shop", name: "Analista" },
  );
  const put = (scope: string, path: string, content: string) =>
    srv.api("PUT", "/api/files/content", { scope, path, content });
  await put(
    "project:shop",
    "artefatti/cruscotto.html",
    art("Cruscotto", ["ask", "storage", "files:dati/"], agent.id),
  );
  await put(
    "project:shop",
    "artefatti/altro.html",
    art("Altro", ["ask", "storage", "files:dati/"], agent.id),
  );
  await put("project:shop", "artefatti/nulla.html", art("Nulla", []));
  await put("project:shop", "artefatti/orfano.html", art("Orfano", ["ask"], "agent_gone"));
  await put(
    "project:shop",
    "artefatti/tutto.html",
    art("Tutto", ["files:artefatti/", "files:src/"], agent.id),
  );
  await put("project:shop", "dati/vendite.csv", "mese,euro\ngennaio,10\n");
  await put("project:shop", "dati/sub/a.csv", "x\n1\n");
  await put("project:shop", "dati/.env", "API_KEY=sk-ant-api03-abcdefghij1234567890ABCDEFGHIJ\n");
  await put("project:shop", "dati/secrets.json", '{"token":"x"}');
  await put("project:shop", "dati/server.pem", "-----BEGIN PRIVATE KEY-----\n");
  await put("project:shop", "src/segreto.txt", "fuori dalla cartella");
  await put("platform", "artefatti/god.html", art("Di God", ["files:dati/", "storage"]));
  const root = await srv.core.scopeFolder("me", "project:shop");
  await writeFile(join(root, "dati", "foto.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  // Links: one that leaves the folder, one that leaves the project, one that stays.
  await symlink(join(root, "src"), join(root, "dati", "fuori"));
  await symlink("/etc/hostname", join(root, "dati", "host.txt"));
  await symlink(join(root, "dati", "vendite.csv"), join(root, "dati", "copia.csv"));
  // A clock that moves 100 ms a call, below the rate limit (its own test sets another).
  let now = 1_000_000;
  srv.core.artifactBridge.now = () => {
    now += 100;
    return now;
  };
  return { srv, agentId: agent.id, godId: god.body.id, root };
}

const ref = (path: string, scope = "project:shop") => ({ kind: "file" as const, scope, path });

/** Answers every request of the person as they would: yes or no, with the cap they picked. */
function person(srv: Server, how: "allow" | "deny", cap?: number) {
  const seen: PermissionRequestInfo[] = [];
  srv.core.approvals.on("request", (_o, info) => {
    seen.push(info);
    setTimeout(() => {
      if (cap !== undefined) srv.core.artifactBridge.chooseCap(info.requestId, cap);
      srv.core.approvals.decide("me", info.requestId, how, undefined, "web");
    }, 5);
  });
  return seen;
}

async function failsWith(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(BridgeFailure);
  expect((err as BridgeFailure).code).toBe(code);
  return err as BridgeFailure;
}

describe("the artifacts' bridge", () => {
  it("refuses what the header does not declare, and widgets", async () => {
    const { srv } = await setup();
    const b = srv.core.artifactBridge;
    await failsWith(
      b.handle("me", ref("artefatti/nulla.html"), { op: "ask", prompt: "x" }),
      "not_declared",
    );
    await failsWith(
      b.handle("me", ref("artefatti/nulla.html"), { op: "storage.get", key: "a" }),
      "not_declared",
    );
    await failsWith(
      b.handle("me", ref("artefatti/nulla.html"), {
        op: "files.read",
        path: "dati/vendite.csv",
        as: "text",
      }),
      "not_declared",
    );
    await failsWith(
      b.handle(
        "me",
        { kind: "widget", sessionId: "sess_x", seq: 1, index: 0 },
        { op: "storage.get", key: "a" },
      ),
      "unavailable",
    );
    // Not an artifact, or another person's.
    await failsWith(
      b.handle("me", ref("src/segreto.txt"), { op: "storage.get", key: "a" }),
      "unavailable",
    );
    await failsWith(
      b.handle("someone-else", ref("artefatti/cruscotto.html"), { op: "storage.get", key: "a" }),
      "not_found",
    );
  });

  it("asks the person the first time, in words; their yes is logged and asked once", async () => {
    const { srv } = await setup();
    const seen = person(srv, "allow");
    const b = srv.core.artifactBridge;
    await b.handle("me", ref("artefatti/cruscotto.html"), {
      op: "storage.set",
      key: "k",
      value: "v",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe(ARTIFACT_GRANT_TOOL);
    expect(seen[0]?.danger).toEqual([]);
    expect(requestSentence("it", seen[0]?.tool ?? "", seen[0]?.input)).toBe(
      "L'artefatto «Cruscotto» chiede di tenere dati suoi su RedGiant (solo testo, fino a 5 MB)",
    );
    expect(
      await b.handle("me", ref("artefatti/cruscotto.html"), { op: "storage.get", key: "k" }),
    ).toEqual({ value: "v" });
    expect(seen).toHaveLength(1);
    const granted = await srv.core.store.list({ types: ["artifact.granted"] });
    expect(granted.map((e) => e.payload)).toEqual([
      {
        scope: "project:shop",
        path: "artefatti/cruscotto.html",
        capability: "storage",
        by: "human",
      },
    ]);
    // Only one card even when the artifact calls many times at once.
    const many = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        b.handle("me", ref("artefatti/altro.html"), { op: "storage.get", key: "k" }),
      ),
    );
    expect(many.every((r) => r.status === "fulfilled")).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("a no stays a no for a while; requests switched off grant nothing (Settings still can)", async () => {
    const { srv } = await setup();
    const seen = person(srv, "deny");
    const b = srv.core.artifactBridge;
    await failsWith(
      b.handle("me", ref("artefatti/cruscotto.html"), { op: "storage.get", key: "k" }),
      "denied",
    );
    for (let i = 0; i < 5; i++)
      await failsWith(
        b.handle("me", ref("artefatti/cruscotto.html"), { op: "storage.get", key: "k" }),
        "denied",
      );
    expect(seen).toHaveLength(1);
    // «Don't ask me anything»: no card, no classifier, a no.
    srv.core.requestSettings.set("me", {
      ...srv.core.requestSettings.get("me"),
      mode: "classifier",
    });
    await failsWith(
      b.handle("me", ref("artefatti/altro.html"), { op: "storage.get", key: "k" }),
      "denied",
    );
    expect(seen).toHaveLength(1);
    // The person grants it in Settings › Artifacts.
    const r = await srv.api<{ capability: string }[]>("POST", "/api/artifacts/grant", {
      scope: "project:shop",
      path: "artefatti/altro.html",
      capability: "storage",
    });
    expect(r.status).toBe(200);
    expect(r.body.map((g) => g.capability)).toEqual(["storage"]);
    expect(
      await b.handle("me", ref("artefatti/altro.html"), { op: "storage.get", key: "k" }),
    ).toEqual({ value: null });
    // Never a capability the header does not declare.
    const bad = await srv.api("POST", "/api/artifacts/grant", {
      scope: "project:shop",
      path: "artefatti/nulla.html",
      capability: "files:dati/",
    });
    expect(bad.status).toBe(400);
    // Taken back: the next use asks again.
    await srv.api("POST", "/api/artifacts/revoke", {
      scope: "project:shop",
      path: "artefatti/altro.html",
      capability: "storage",
    });
    await failsWith(
      b.handle("me", ref("artefatti/altro.html"), { op: "storage.get", key: "k" }),
      "denied",
    );
  });

  it("a grant belongs to one artifact: another one (same project, same wants) is asked again", async () => {
    const { srv } = await setup();
    const seen = person(srv, "allow");
    const b = srv.core.artifactBridge;
    await b.handle("me", ref("artefatti/cruscotto.html"), { op: "files.list", dir: "dati/" });
    await b.handle("me", ref("artefatti/altro.html"), { op: "files.list", dir: "dati/" });
    expect(seen.map((r) => (r.input as { path: string }).path)).toEqual([
      "artefatti/cruscotto.html",
      "artefatti/altro.html",
    ]);
  });

  it("reads only inside the granted folder: no traversal, links out, hidden files or secrets", async () => {
    const { srv } = await setup();
    person(srv, "allow");
    const b = srv.core.artifactBridge;
    const r = ref("artefatti/cruscotto.html");
    const read = (path: string, as: "text" | "binary" = "text") =>
      b.handle("me", r, { op: "files.read", path, as });
    expect(await read("dati/vendite.csv")).toEqual({
      path: "dati/vendite.csv",
      size: 21,
      text: "mese,euro\ngennaio,10\n",
    });
    expect(await read("./dati//sub/a.csv")).toMatchObject({
      path: "dati/sub/a.csv",
      text: "x\n1\n",
    });
    // A link that stays in the folder is read where it points.
    expect(await read("dati/copia.csv")).toMatchObject({ path: "dati/vendite.csv" });
    const png = (await read("dati/foto.png", "binary")) as { base64: string; mime: string };
    expect(png.mime).toBe("image/png");
    expect([...Buffer.from(png.base64, "base64")]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    const list = (await b.handle("me", r, { op: "files.list", dir: "dati" })) as {
      entries: { name: string; dir: boolean }[];
    };
    expect(list.entries.map((e) => e.name)).toEqual([
      "sub",
      "copia.csv",
      "foto.png",
      "vendite.csv",
    ]);
    // Never.
    for (const p of [
      "dati/../src/segreto.txt",
      "../../../../etc/passwd",
      "/etc/passwd",
      "dati\\..\\src\\segreto.txt",
      "src/segreto.txt",
      "dati/fuori/segreto.txt",
      "dati/host.txt",
      "dati/.env",
      "dati/secrets.json",
      "dati/server.pem",
      "file:///etc/passwd",
      "dati/%2e%2e/src/segreto.txt",
      "dati/vendite.csv\u0000.png",
    ])
      await failsWith(read(p), /%2e/.test(p) ? "not_found" : "forbidden");
    await failsWith(read("dati/nessuno.csv"), "not_found");
    await failsWith(b.handle("me", r, { op: "files.list", dir: "dati/fuori" }), "forbidden");
    await failsWith(b.handle("me", r, { op: "files.list", dir: ".." }), "forbidden");
    // Too big.
    const root = await srv.core.scopeFolder("me", "project:shop");
    await writeFile(join(root, "dati", "enorme.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    await failsWith(read("dati/enorme.bin", "binary"), "too_big");
    // The artifacts' own storage and a repository's settings stay out even with their folder.
    await b.handle("me", r, { op: "storage.set", key: "k", value: "segreto della persona" });
    const t = ref("artefatti/tutto.html");
    await failsWith(
      b.handle("me", t, { op: "files.read", path: "artefatti/.dati/cruscotto.json", as: "text" }),
      "forbidden",
    );
    expect(
      (
        (await b.handle("me", t, { op: "files.list", dir: "artefatti" })) as {
          entries: { name: string }[];
        }
      ).entries.map((e) => e.name),
    ).not.toContain(".dati");
    // Only an artifact in a project reads files.
    await failsWith(
      b.handle("me", ref("artefatti/god.html", "platform"), {
        op: "files.read",
        path: "dati/x.csv",
        as: "text",
      }),
      "unavailable",
    );
  });

  it("reads through the same rules as an agent's read: the person's deny rule wins", async () => {
    const { srv } = await setup();
    person(srv, "allow");
    const policy = srv.core.policies.get("me");
    await srv.core.config.setPolicy("me", "human", {
      ...policy,
      rules: [...policy.rules, { tool: "read_file", match: "vendite", decision: "deny" }],
    });
    await failsWith(
      srv.core.artifactBridge.handle("me", ref("artefatti/cruscotto.html"), {
        op: "files.read",
        path: "dati/vendite.csv",
        as: "text",
      }),
      "denied",
    );
  });

  it("storage: per artifact, text only, at most 5 MB, next to the artifact and out of git", async () => {
    const { srv, root } = await setup();
    person(srv, "allow");
    const b = srv.core.artifactBridge;
    const r = ref("artefatti/cruscotto.html");
    await b.handle("me", r, { op: "storage.set", key: "scores", value: '[{"n":"Ada","p":9}]' });
    await b.handle("me", r, { op: "storage.set", key: "scores-old", value: "[]" });
    await b.handle("me", r, { op: "storage.set", key: "tema", value: "scuro" });
    expect(await b.handle("me", r, { op: "storage.list", prefix: "scores" })).toEqual({
      keys: ["scores", "scores-old"],
    });
    await b.handle("me", r, { op: "storage.delete", key: "scores-old" });
    expect(await b.handle("me", r, { op: "storage.list" })).toEqual({ keys: ["scores", "tema"] });
    // Another artifact has its own.
    expect(
      await b.handle("me", ref("artefatti/altro.html"), { op: "storage.get", key: "tema" }),
    ).toEqual({ value: null });
    const file = JSON.parse(await readFile(join(root, "artefatti/.dati/cruscotto.json"), "utf8"));
    expect(file).toEqual({
      format: "rgartifact-data-1",
      items: { scores: '[{"n":"Ada","p":9}]', tema: "scuro" },
    });
    expect(await readFile(join(root, "artefatti/.dati/.gitignore"), "utf8")).toBe("*\n");
    // Text only: the wire refuses anything else.
    expect(BridgeCall.safeParse({ op: "storage.set", key: "a", value: 5 }).success).toBe(false);
    expect(BridgeCall.safeParse({ op: "storage.set", key: "", value: "x" }).success).toBe(false);
    // 5 MB in all.
    const big = "x".repeat(3 * 1024 * 1024);
    await b.handle("me", r, { op: "storage.set", key: "a", value: big });
    await failsWith(b.handle("me", r, { op: "storage.set", key: "b", value: big }), "too_big");
    expect(await b.handle("me", r, { op: "storage.list" })).toEqual({
      keys: ["a", "scores", "tema"],
    });
    // Many writes at once: none lost.
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        b.handle("me", r, { op: "storage.set", key: `n${i}`, value: String(i) }),
      ),
    );
    expect(
      ((await b.handle("me", r, { op: "storage.list", prefix: "n" })) as { keys: string[] }).keys,
    ).toHaveLength(15);
    // A storage folder that is a link out is refused, never followed.
    const other = ref("artefatti/god.html", "platform");
    const proot = await srv.core.scopeFolder("me", "platform");
    await mkdir(join(proot, "artefatti"), { recursive: true });
    await symlink("/tmp", join(proot, "artefatti", ".dati"));
    await srv.api("POST", "/api/artifacts/grant", {
      scope: "platform",
      path: "artefatti/god.html",
      capability: "storage",
    });
    await failsWith(
      b.handle("me", other, { op: "storage.set", key: "a", value: "b" }),
      "forbidden",
    );
  });

  it("rate limits: calls per second and questions per minute", async () => {
    const { srv } = await setup();
    person(srv, "allow", 2);
    const b = srv.core.artifactBridge;
    let now = 1_000_000;
    b.now = () => now;
    const r = ref("artefatti/cruscotto.html");
    await b.handle("me", r, { op: "storage.get", key: "a" });
    const flood = await Promise.allSettled(
      Array.from({ length: 40 }, () => b.handle("me", r, { op: "storage.get", key: "a" })),
    );
    const limited = flood.filter(
      (x) => x.status === "rejected" && (x.reason as BridgeFailure).code === "rate_limited",
    );
    expect(limited.length).toBeGreaterThan(15);
    now += 2000;
    for (let i = 0; i < ARTIFACT_ASK_PER_MINUTE; i++) {
      now += 10;
      await b.handle("me", r, { op: "ask", prompt: `domanda ${i}` });
    }
    await failsWith(b.handle("me", r, { op: "ask", prompt: "una di troppo" }), "rate_limited");
    now += 61_000;
    await b.handle("me", r, { op: "ask", prompt: "dopo un minuto" });
  });

  it("ask: the maker answers in a conversation of its own, no tools, within the artifact's cap", async () => {
    const { srv, agentId } = await setup();
    const seen = person(srv, "allow", 2);
    // The person's own conversation with the agent: the artifact's questions never see it.
    const own = await srv.api<{ sessionId: string }>("POST", "/api/sessions", { agentId });
    await srv.core
      .send("me", own.body.sessionId, "Il mio conto in banca è 1234")
      .then((r) => r.done);
    const b = srv.core.artifactBridge;
    const r = ref("artefatti/cruscotto.html");
    const before = srv.provider.requests.length;
    expect(await b.handle("me", r, { op: "ask", prompt: "Riassumi: vendite ok" })).toEqual({
      text: "Risposta a: Riassumi: vendite ok",
    });
    expect(seen).toHaveLength(1);
    expect(requestSentence("it", ARTIFACT_GRANT_TOOL, seen[0]?.input)).toContain(
      "fare domande a «Analista»",
    );
    const req = srv.provider.requests.at(-1);
    expect(srv.provider.requests.length).toBe(before + 1);
    expect(req?.tools).toEqual([]);
    expect(req?.system).toContain("Cruscotto");
    expect(JSON.stringify(req)).not.toContain("1234");
    // Logged in the artifact's own conversation, under the maker.
    const id = artifactId("me", "project:shop", "artefatti/cruscotto.html");
    const log = await srv.core.store.list({ sessionId: askSessionId(id) });
    expect(log.map((e) => e.type)).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
    ]);
    expect(log.every((e) => e.agentId === agentId && e.projectId === "shop")).toBe(true);
    // Never a conversation in the person's list.
    const list = await srv.api<{ id: string }[]>("GET", "/api/sessions");
    expect(list.body.map((x) => x.id)).not.toContain(askSessionId(id));
    // The cap the person chose, and the spending counted against it.
    const grants = await b.grantsOf("me", "project:shop", "artefatti/cruscotto.html");
    expect(grants.find((g) => g.capability === "ask")).toMatchObject({ agentId, capUsd: 2 });
    expect((await srv.core.budget.used({ scope: "artifact", id })).tokens).toBe(120);
    // Used up: the next question is refused before any model call.
    await srv.core.budget.record(
      [{ scope: "artifact", id }],
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 },
      2,
      {
        ownerId: "me",
        projectId: "shop",
        agentId,
      },
    );
    const n = srv.provider.requests.length;
    const err = await failsWith(b.handle("me", r, { op: "ask", prompt: "ancora" }), "budget");
    expect(err.message).toMatch(/spending cap/);
    expect(srv.provider.requests.length).toBe(n);
    // Raised in Settings: it answers again.
    await srv.api("POST", "/api/artifacts/grant", {
      scope: "project:shop",
      path: "artefatti/cruscotto.html",
      capability: "ask",
      capUsd: 5,
    });
    expect(await b.handle("me", r, { op: "ask", prompt: "ancora" })).toEqual({
      text: "Risposta a: ancora",
    });
  });

  it("ask: a clear error when the maker is gone; another maker in the header asks again", async () => {
    const { srv, godId } = await setup();
    const seen = person(srv, "allow");
    const b = srv.core.artifactBridge;
    const e = await failsWith(
      b.handle("me", ref("artefatti/orfano.html"), { op: "ask", prompt: "x" }),
      "no_agent",
    );
    expect(e.message).toMatch(/no longer exists/);
    await b.handle("me", ref("artefatti/cruscotto.html"), { op: "ask", prompt: "x" });
    expect(seen).toHaveLength(1);
    // The file now says God made it: the grant was for the other agent.
    await srv.api("PUT", "/api/files/content", {
      scope: "project:shop",
      path: "artefatti/cruscotto.html",
      content: art("Cruscotto", ["ask", "storage", "files:dati/"], godId),
    });
    await b.handle("me", ref("artefatti/cruscotto.html"), { op: "ask", prompt: "y" });
    expect(seen).toHaveLength(2);
  });

  it("resume: grants and the ask conversation are rebuilt from the log", async () => {
    const { srv } = await setup();
    person(srv, "allow");
    const b = srv.core.artifactBridge;
    const r = ref("artefatti/cruscotto.html");
    await b.handle("me", r, { op: "ask", prompt: "prima domanda" });
    await b.handle("me", r, { op: "storage.set", key: "k", value: "v" });
    // A new bridge (a restart): the same grants, and the conversation goes on from its log.
    const again = new ArtifactBridge(srv.core);
    expect(
      (await again.grantsOf("me", "project:shop", "artefatti/cruscotto.html"))
        .map((g) => g.capability)
        .sort(),
    ).toEqual(["ask", "storage"]);
    b.forgetSessions();
    await b.handle("me", r, { op: "ask", prompt: "seconda domanda" });
    const req = srv.provider.requests.at(-1);
    const said = JSON.stringify(req?.messages);
    expect(said).toContain("prima domanda");
    expect(said).toContain("Risposta a: prima domanda");
    expect(said).toContain("seconda domanda");
  });

  it("export carries the data only when asked; an import starts with nothing granted", async () => {
    const { srv } = await setup();
    const seen = person(srv, "allow");
    const b = srv.core.artifactBridge;
    const r = ref("artefatti/cruscotto.html");
    await b.handle("me", r, { op: "storage.set", key: "scores", value: "[1,2,3]" });
    const exp = async (data: boolean) => {
      const res = await fetch(
        `${srv.url}/api/artifacts/export?scope=project:shop&path=artefatti/cruscotto.html&as=zip${data ? "&data=1" : ""}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      );
      return new Uint8Array(await res.arrayBuffer());
    };
    const plain = unzipSync(await exp(false));
    expect(Object.keys(plain).sort()).toEqual(["artifact.html", "manifest.json"]);
    expect(JSON.parse(strFromU8(plain["manifest.json"] as Uint8Array)).hasData).toBe(false);
    const zip = await exp(true);
    const withData = unzipSync(zip);
    expect(JSON.parse(strFromU8(withData["manifest.json"] as Uint8Array)).hasData).toBe(true);
    expect(JSON.parse(strFromU8(withData["data.json"] as Uint8Array))).toEqual({
      format: "rgartifact-data-1",
      items: { scores: "[1,2,3]" },
    });
    const imp = async (q = "") => {
      const res = await fetch(`${srv.url}/api/artifacts/import?scope=project:shop${q}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        body: zip,
      });
      return (await res.json()) as { path: string; dataImported: boolean; dataIgnored: boolean };
    };
    const one = await imp();
    expect(one).toMatchObject({ dataImported: true, dataIgnored: false });
    expect(one.path).not.toBe("artefatti/cruscotto.html");
    expect(await b.grantsOf("me", "project:shop", one.path)).toEqual([]);
    // Not run yet: nothing works; run, it asks the person again, and finds its data.
    await failsWith(
      b.handle("me", ref(one.path), { op: "storage.get", key: "scores" }),
      "unavailable",
    );
    await srv.api("POST", "/api/artifacts/run", { scope: "project:shop", path: one.path });
    const asked = seen.length;
    expect(await b.handle("me", ref(one.path), { op: "storage.get", key: "scores" })).toEqual({
      value: "[1,2,3]",
    });
    expect(seen.length).toBe(asked + 1);
    // Without its data, when the person says so.
    const two = await imp("&data=0");
    expect(two).toMatchObject({ dataImported: false, dataIgnored: true });
    const root = await srv.core.scopeFolder("me", "project:shop");
    const name = two.path
      .split("/")
      .pop()
      ?.replace(/\.html$/, "");
    await expect(stat(join(root, "artefatti/.dati", `${name}.json`))).rejects.toThrow();
  });

  it("over the WebSocket: the result or the error, to the page that asked", async () => {
    const { srv } = await setup();
    person(srv, "allow");
    const ws = await wsClient(srv.url);
    ws.send({
      type: "artifact.bridge",
      requestId: "b1",
      ref: ref("artefatti/cruscotto.html"),
      call: { op: "files.read", path: "dati/vendite.csv", as: "text" },
    });
    const ok = await ws.waitFor("artifact.bridge.result", (m) => m.requestId === "b1");
    expect(ok.result).toMatchObject({ text: "mese,euro\ngennaio,10\n" });
    ws.send({
      type: "artifact.bridge",
      requestId: "b2",
      ref: ref("artefatti/cruscotto.html"),
      call: { op: "files.read", path: "dati/.env", as: "text" },
    });
    const no = await ws.waitFor("artifact.bridge.result", (m) => m.requestId === "b2");
    expect(no.error?.code).toBe("forbidden");
    expect(JSON.stringify(no)).not.toContain("sk-ant");
    ws.close();
  });
});

describe("paths an artifact may name", () => {
  it.each([
    ["dati/vendite.csv", "dati/vendite.csv"],
    ["./dati//a.csv", "dati/a.csv"],
    ["dati/", "dati"],
    ["../x", undefined],
    ["dati/../../x", undefined],
    ["/etc/passwd", undefined],
    ["C:/Windows", undefined],
    ["dati\\a.csv", undefined],
    ["dati/.env", undefined],
    [".git/config", undefined],
    ["", undefined],
    ["dati/\u0000", undefined],
  ])("%s", (input, expected) => {
    expect(normalRel(input)).toBe(expected);
  });
});
