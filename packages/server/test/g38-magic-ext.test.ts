// Magic integrations and extensions (G38.3): a scripted God builds a small connector to a fake
// HTTP API; its parts are tested by the extension builder, the credential goes into the keychain
// from the package's page and reaches the API only through the (fake) egress proxy; «Approve and
// install» stays off while something is missing; uninstalling takes everything back.

import { lstat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";
import { type MagicExtension, type MagicManifest, magicChecks } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import type { VaultRoute } from "../src/vault.js";
import { startServer } from "./helpers.js";

type S = Awaited<ReturnType<typeof startServer>>;
let s: S | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await s?.close();
  s = undefined;
  for (const x of servers.splice(0)) await new Promise((ok) => x.close(ok));
});

const SECRET = "ntk_live_Q7mX2pV9sR4tW8yZ3bC6";
const HOST = "api.notes.test";

const lastUser = (req: CompletionRequest) => {
  const m = [...req.messages].reverse().find((x) => x.role === "user");
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};

const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
};

const listen = (srv: Server) =>
  new Promise<number>((ok) => {
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => ok((srv.address() as AddressInfo).port));
  });

/** The service: its notes, only with the right key. */
async function fakeApi() {
  const seen: { path: string; auth: string | undefined }[] = [];
  const port = await listen(
    createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${SECRET}`)
        return void res.writeHead(401).end('{"error":"unauthorized"}');
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ title: "Spesa" }, { title: `Chiave ${SECRET}` }]));
    }),
  );
  return { port, seen };
}

/**
 * The egress proxy as the tools see it: `/vault/<cap>/<host>/<path>`, only to the credential's
 * hosts, the key put on the way and hidden in the answer (the real one is tested in sandbox).
 */
async function fakeEgress(apiPort: number) {
  let routes: VaultRoute[] = [];
  const port = await listen(
    createServer((req: IncomingMessage, res) => {
      const [, , cap = "", host = "", ...rest] = (req.url ?? "").split("/");
      const route = routes.find((r) => r.cap === cap);
      if (!route) return void res.writeHead(404).end("unknown credential");
      if (!route.hosts.includes(host)) return void res.writeHead(403).end("not its host");
      const headers = {
        [route.inject.header.toLowerCase()]: route.inject.format.replace("{value}", route.value),
      };
      fetch(`http://127.0.0.1:${apiPort}/${rest.join("/")}`, { headers })
        .then(async (r) => {
          const text = (await r.text()).split(route.value).join("[vault]");
          res.writeHead(r.status, { "content-type": "application/json" }).end(text);
        })
        .catch(() => res.writeHead(502).end());
    }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    publish: async (r: VaultRoute[]) => {
      routes = r;
    },
  };
}

const LIST_MJS = `import { readFileSync } from "node:fs";
JSON.parse(readFileSync(process.argv.at(-1), "utf8"));
const base = process.env.REDGIANT_VAULT_NOTES_API;
const vaultEnv = Object.entries(process.env).filter(([k]) => /VAULT|SECRET|TOKEN|NOTES/i.test(k));
console.log("ENV " + JSON.stringify(vaultEnv));
if (!base) { console.error("notes_api is not given to this tool"); process.exit(2); }
const r = await fetch(base + "/${HOST}/v1/notes");
if (!r.ok) { console.error("HTTP " + r.status); process.exit(1); }
for (const n of await r.json()) console.log(n.title);
`;

const MANIFEST: MagicManifest = {
  name: "notes",
  title: "Le mie note",
  summary: "Legge le tue note dal servizio Notes.",
  hosts: [HOST],
  credentials: [
    {
      name: "notes_api",
      service: "Notes",
      hosts: [],
      header: "Authorization",
      format: "Bearer {value}",
      why: "to read your notes",
    },
  ],
  tools: [
    {
      name: "notes-list",
      description: "Lists the person's notes from the Notes service.",
      input_schema: { type: "object", properties: {} },
      command: "node list.mjs",
      files: { "list.mjs": LIST_MJS },
      tests: [{ input: {}, expectExitCode: 0, expectStdoutContains: "Spesa" }],
    },
  ],
  skills: [],
};

/** God: proposes once per message of the person, then answers in words. */
function god(manifest: unknown = MANIFEST) {
  const proposed = new Set<string>();
  return (req: CompletionRequest) => {
    const key = lastUser(req);
    const last = req.messages.at(-1);
    if (last?.role === "user" && last.parts.some((p) => p.type === "tool_result"))
      return { text: "Ecco il pacchetto: guardalo nella pagina." };
    if (!key.startsWith("Magic ") || proposed.has(key)) return { text: "Cosa cambio?" };
    proposed.add(key);
    return { toolCalls: [{ name: "propose_magic_extension", input: manifest as object }] };
  };
}

async function setup(manifest?: unknown) {
  const api = await fakeApi();
  const egress = await fakeEgress(api.port);
  s = await startServer(god(manifest), {}, { vault: { egress } });
  await s.api("POST", "/api/agents", { kind: "god", parentId: null, name: "God" });
  return api;
}

async function startMagic(kind: "integration" | "extension" = "integration") {
  const created = await s?.api<MagicExtension>("POST", "/api/magic-ext", {
    kind,
    request: "Collegami alle mie note sul servizio Notes",
  });
  expect(created?.status).toBe(201);
  const id = created?.body.id ?? "";
  let m: MagicExtension | undefined;
  await until(async () => {
    m = (await s?.api<MagicExtension>("GET", `/api/magic-ext/${id}`))?.body;
    return m?.status === "ready";
  });
  return m as MagicExtension;
}

describe("magic integrations (G38.3)", { timeout: 60_000 }, () => {
  it("builds, tests with the keychain, waits for the person, installs and uninstalls", async () => {
    const api = await setup();
    const m = await startMagic();
    // God's conversation knows its task and has the tool only there.
    const first = s?.provider.requests[0] as CompletionRequest;
    expect(first.system).toContain("This conversation builds an integration or an extension");
    expect(first.tools?.some((t) => t.name === "propose_magic_extension")).toBe(true);
    // Tested at once: no credential yet, so the test fails and the button stays off.
    expect(m.proposal?.parts.map((p) => [p.name, p.status])).toEqual([["notes-list", "failed"]]);
    expect(m.canApprove).toBe(false);
    expect(m.checks.filter((c) => !c.ok).map((c) => `${c.kind}:${c.what}`)).toEqual([
      "credential:notes_api",
      "test:notes-list",
    ]);
    const early = await s?.api<{ error: string }>("POST", `/api/magic-ext/${m.id}/approve`, {});
    expect(early?.status).toBe(400);
    expect(early?.body.error).toContain("Still missing: credential notes_api, test notes-list");

    // The person adds the key on the page: it goes into the keychain, used by this package.
    const added = await s?.api<MagicExtension>("POST", `/api/magic-ext/${m.id}/credential`, {
      name: "notes_api",
      value: SECRET,
    });
    expect(added?.status).toBe(200);
    expect(JSON.stringify(added?.body)).not.toContain(SECRET);
    await s?.core.magicExt.settled(m.id);
    const ready = (await s?.api<MagicExtension>("GET", `/api/magic-ext/${m.id}`))?.body;
    expect(ready?.status).toBe("ready");
    expect(ready?.proposal?.parts[0]?.status).toBe("pending");
    expect(ready?.checks.every((c) => c.ok)).toBe(true);
    expect(ready?.canApprove).toBe(true);
    // The key reached the API through the proxy only; the tool saw an address, never the value.
    expect(api.seen.at(-1)).toEqual({ path: "/v1/notes", auth: `Bearer ${SECRET}` });
    const detail = ready?.proposal?.parts[0]?.tests[0]?.detail ?? "";
    expect(detail).toContain("Spesa");
    expect(detail).toContain("Chiave [vault]");
    expect(detail).toMatch(/REDGIANT_VAULT_NOTES_API","http:\/\/127\.0\.0\.1:\d+\/vault\//);
    expect(detail).not.toContain(SECRET);
    const keychain = await s?.api<{ entries: { name: string; usedBy?: { key: string } }[] }>(
      "GET",
      "/api/vault",
    );
    const entry = keychain?.body.entries.find((e) => e.name === "notes_api");
    expect(entry?.usedBy?.key).toBe(`magic:${m.id}:notes_api`);
    expect(JSON.stringify(keychain?.body)).not.toContain(SECRET);

    const ok = await s?.api<MagicExtension>("POST", `/api/magic-ext/${m.id}/approve`, {});
    expect(ok?.status).toBe(200);
    expect(ok?.body).toMatchObject({ status: "done", installed: ["notes-list"] });
    const installed = await s?.api<{ name: string; kind: string }[]>(
      "GET",
      "/api/extensions/installed",
    );
    expect(installed?.body.some((x) => x.name === "notes-list" && x.kind === "tool")).toBe(true);
    // Approved twice: no.
    expect((await s?.api("POST", `/api/magic-ext/${m.id}/approve`, {}))?.status).toBe(400);

    // Never in an event, never in the conversation.
    const db = ((s as S).core as unknown as { o: { db: SqlClient } }).o.db;
    const rows = await db.query<Record<string, unknown>>("SELECT * FROM rg_events");
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(s?.provider.requests)).not.toContain(SECRET);

    // Uninstall: the tool, its binding and the key added for it go.
    const toolDir = join(s?.core.platformPath("me") ?? "", "tools", "notes-list");
    const there = () =>
      lstat(toolDir).then(
        () => true,
        () => false,
      );
    expect(await there()).toBe(true);
    expect((await s?.api("POST", `/api/magic-ext/${m.id}/uninstall`, {}))?.status).toBe(200);
    const after = await s?.api<{ name: string }[]>("GET", "/api/extensions/installed");
    expect(after?.body.some((x) => x.name === "notes-list")).toBe(false);
    expect(await there()).toBe(false);
    expect(s?.core.vault.has("me", "notes_api")).toBe(false);
    expect((await s?.api<MagicExtension[]>("GET", "/api/magic-ext"))?.body).toEqual([]);
  });

  it("an undeclared host, an undeclared credential and a failing test keep the button off", async () => {
    const tool = MANIFEST.tools[0] as NonNullable<MagicManifest["tools"][number]>;
    await setup({
      ...MANIFEST,
      tools: [
        {
          ...tool,
          files: {
            "list.mjs": `${LIST_MJS}\nconst later = "https://elsewhere.example.org/x";\nconsole.log(process.env.REDGIANT_VAULT_OTHER_KEY);\n`,
          },
        },
      ],
    });
    const m = await startMagic();
    expect(m.checks.filter((c) => !c.ok).map((c) => `${c.kind}:${c.what}`)).toEqual([
      "credential:notes_api",
      "test:notes-list",
      "host:elsewhere.example.org",
      "credential:other_key",
    ]);
    // A key already in the keychain is given to the tools only by the person's choice.
    await s?.api("POST", "/api/vault", {
      name: "notes_api",
      service: "Notes",
      value: SECRET,
      hosts: ["other.example.com"],
      // Its own rule for every use: here, never asked (the tests follow it as any run).
      ask: "never",
    });
    const pending = (await s?.api<MagicExtension>("GET", `/api/magic-ext/${m.id}`))?.body;
    expect(pending?.checks.find((c) => c.what === "notes_api")).toMatchObject({
      ok: false,
      exists: true,
      detail: "not-bound",
    });
    const twice = await s?.api<{ error: string }>("POST", `/api/magic-ext/${m.id}/credential`, {
      name: "notes_api",
      value: "x",
    });
    expect(twice?.status).toBe(400);
    await s?.api("POST", `/api/magic-ext/${m.id}/bind`, { name: "notes_api" });
    await s?.core.magicExt.settled(m.id);
    const bound = (await s?.api<MagicExtension>("GET", `/api/magic-ext/${m.id}`))?.body;
    expect(bound?.checks.find((c) => c.what === "notes_api")?.ok).toBe(true);
    // Still off: the host and the other key are God's to fix.
    expect(bound?.canApprove).toBe(false);
    expect((await s?.api("POST", `/api/magic-ext/${m.id}/approve`, {}))?.status).toBe(400);
    // The person's no goes back to God; nothing installed.
    const no = await s?.api<MagicExtension>("POST", `/api/magic-ext/${m.id}/reject`, {
      reason: "Solo le note di oggi.",
    });
    expect(no?.body).toMatchObject({ status: "building", proposal: null });
    await until(
      () =>
        s?.provider.requests.some(
          (r) => lastUser(r) === "I did not approve the proposal. Solo le note di oggi.",
        ) ?? false,
    );
    expect((await s?.api("DELETE", `/api/magic-ext/${m.id}`))?.status).toBe(200);
  });

  it("an extension proposal outside its conversation is refused", async () => {
    await setup();
    // An ordinary conversation of God has no such tool.
    const god = s?.core.registry.list({ ownerId: "me" }).find((a) => a.kind === "god");
    const sid = await s?.core.startSession("me", god?.id ?? "");
    const { done } = (await (s as S).core.send("me", sid ?? "", "ciao")) as {
      done: Promise<unknown>;
    };
    await done;
    const last = s?.provider.requests.at(-1) as CompletionRequest;
    expect(last.tools?.some((t) => t.name === "propose_magic_extension")).toBe(false);
    await expect(s?.core.magicExt.propose("me", sid ?? "", MANIFEST)).rejects.toThrow(
      "not a magic integration",
    );
  });
});

describe("magicChecks (G38.3), as a table", () => {
  const part = (o: Partial<NonNullable<MagicExtension["proposal"]>["parts"][number]> = {}) => ({
    kind: "tool" as const,
    name: "notes-list",
    description: "d",
    files: { "a.mjs": `fetch(process.env.REDGIANT_VAULT_NOTES_API + "/${HOST}/x")` },
    proposalId: "p",
    status: "pending" as const,
    tests: [{ name: "test 1", passed: true, detail: "" }],
    ...o,
  });
  const cred = {
    name: "notes_api",
    service: "Notes",
    hosts: [HOST],
    header: "Authorization",
    format: "Bearer {value}",
    why: "",
  };
  const have = { exists: true, bound: true, hosts: [HOST] };
  const rows: [string, Parameters<typeof magicChecks>[0], typeof have, boolean, string[]][] = [
    ["all there", { hosts: [HOST], credentials: [cred], parts: [part()] }, have, true, []],
    ["no parts", { hosts: [HOST], credentials: [], parts: [] }, have, false, []],
    [
      "key missing",
      { hosts: [HOST], credentials: [cred], parts: [part()] },
      { exists: false, bound: false, hosts: [] },
      false,
      ["credential:notes_api"],
    ],
    [
      "key not given",
      { hosts: [HOST], credentials: [cred], parts: [part()] },
      { ...have, bound: false },
      false,
      ["credential:notes_api"],
    ],
    [
      "key elsewhere",
      { hosts: [HOST], credentials: [cred], parts: [part()] },
      { ...have, hosts: ["x.test"] },
      false,
      ["credential:notes_api"],
    ],
    [
      "test failed",
      {
        hosts: [HOST],
        credentials: [cred],
        parts: [part({ status: "failed", tests: [{ name: "test 1", passed: false, detail: "" }] })],
      },
      have,
      false,
      ["test:notes-list"],
    ],
    [
      "decided elsewhere",
      { hosts: [HOST], credentials: [cred], parts: [part({ status: "rejected" })] },
      have,
      false,
      ["test:notes-list"],
    ],
    [
      "host undeclared",
      {
        hosts: [],
        credentials: [],
        parts: [part({ files: { "a.py": "urlopen('https://api.other.test/v1')" } })],
      },
      have,
      false,
      ["host:api.other.test"],
    ],
    [
      "wildcard host",
      {
        hosts: ["*.other.test"],
        credentials: [],
        parts: [part({ files: { "a.py": "urlopen('https://api.other.test/v1')" } })],
      },
      have,
      true,
      [],
    ],
    [
      "credential host undeclared",
      { hosts: [HOST], credentials: [{ ...cred, hosts: ["evil.test"] }], parts: [part()] },
      { ...have, hosts: ["evil.test"] },
      false,
      ["host:evil.test"],
    ],
    [
      "credential undeclared",
      { hosts: [HOST], credentials: [], parts: [part()] },
      have,
      false,
      ["credential:notes_api"],
    ],
  ];
  for (const [name, p, state, can, missing] of rows)
    it(name, () => {
      const r = magicChecks(p, () => state);
      expect(r.canApprove).toBe(can);
      expect(r.checks.filter((c) => !c.ok).map((c) => `${c.kind}:${c.what}`)).toEqual(missing);
    });
});
