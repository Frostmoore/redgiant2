// G36.20: every key RedGiant keeps is in the keychain. The secrets.json of before (and the private
// files of mailboxes and MCP sign-ins) move there at the first start, are read back, and only then
// destroyed; a keychain that cannot open keeps everything where it was. The pages set the keys as
// before; the keychain shows and edits them, and a backup sealed with the person's passphrase
// carries them.
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redactor } from "@redgiant/events";
import type { VaultEntry, VaultView } from "@redgiant/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mail, Mailbox } from "../src/email.js";
import { type SetupHooks, SetupService } from "../src/setup.js";
import type { MasterKeyStore } from "../src/vault.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let servers: Server[] = [];

afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

const ANTHROPIC = "sk-ant-api03-moved-into-the-keychain-0001";
const TELEGRAM = "123456:AAH-telegram-token-moved-0002";
const MATRIX = "syt_matrix_access_token_moved_0003";
const GITHUB = "ghp_moved0004moved0004moved0004moved00";
const BRAVE = "BSA-brave-search-key-moved-0005";
const OLD_FILE = {
  keys: { anthropic: ANTHROPIC },
  telegramToken: TELEGRAM,
  chats: { matrix: { homeserver: "https://matrix.example.org", accessToken: MATRIX } },
  githubToken: GITHUB,
  searchKeys: { brave: BRAVE },
};
const VALUES = [ANTHROPIC, TELEGRAM, MATRIX, GITHUB, BRAVE];

function hooks() {
  const calls: string[] = [];
  const h: SetupHooks = {
    async key(id, key) {
      calls.push(`key:${id}:${key ?? "off"}`);
      return ["m"];
    },
    async server() {
      return [];
    },
    async telegram(token) {
      calls.push(`telegram:${token ?? "off"}`);
      return token ? { username: "bot" } : null;
    },
    async chat(p, settings) {
      calls.push(`chat:${p}:${JSON.stringify(settings)}`);
    },
    async search() {},
    async engine() {},
  };
  return { h, calls };
}

/** A server whose data folder already has the files of a version before G36.20. */
async function start(
  o: {
    file?: string | null;
    keyStores?: MasterKeyStore[];
    before?: (dir: string) => Promise<void>;
    mailbox?: Mailbox;
  } = {},
) {
  const { h, calls } = hooks();
  let setup: SetupService | undefined;
  let dataDir = "";
  const redactor = new Redactor();
  const s = await startServer(
    { text: "OK" },
    {},
    {
      redactor,
      ...(o.keyStores && { vault: { keyStores: o.keyStores } }),
      ...(o.mailbox && { mailbox: o.mailbox }),
    },
    undefined,
    undefined,
    async (core, dir) => {
      dataDir = join(dir, "data");
      await mkdir(dataDir, { recursive: true });
      if (o.file !== null)
        await writeFile(join(dataDir, "secrets.json"), o.file ?? JSON.stringify(OLD_FILE), {
          mode: 0o600,
        });
      await o.before?.(dataDir);
      setup = new SetupService({ db: core.db, core, dataDir, ownerId: "me", hooks: h });
      await setup.applyAtStartup();
      return { setup };
    },
  );
  servers.push(s);
  return { s, calls, dataDir, setup: setup as SetupService, redactor };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("all the keys in the keychain (G36.20)", () => {
  it("moves secrets.json into the keychain, checks it, destroys the file and records the move", async () => {
    const { s, calls, dataDir, redactor } = await start();
    // Gone, with nothing left beside it.
    expect(await exists(join(dataDir, "secrets.json"))).toBe(false);
    expect((await readdir(dataDir)).filter((f) => f.startsWith("secrets"))).toEqual([]);
    // Each key is an entry, with the page that uses it and where it may go.
    const view = (await s.api<VaultView>("GET", "/api/vault")).body;
    const by = (k: string) => view.entries.find((e) => e.usedBy?.key === k) as VaultEntry;
    expect(by("setup:keys.anthropic")).toMatchObject({
      name: "anthropic-api-key",
      service: "Anthropic",
      hosts: ["api.anthropic.com"],
      usedBy: { section: "subscriptions", kind: "provider" },
      inject: { header: "x-api-key", format: "{value}" },
      // RedGiant uses it by itself; agents only if the person allows it.
      allow: { allAgents: false },
      ask: "always",
      length: ANTHROPIC.length,
    });
    expect(by("setup:telegramToken")).toMatchObject({
      hosts: ["api.telegram.org"],
      usedBy: { section: "telegram" },
    });
    expect(by("setup:chats.matrix.accessToken")).toMatchObject({ usedBy: { section: "chats" } });
    expect(by("setup:githubToken")).toMatchObject({
      hosts: ["api.github.com", "github.com"],
      usedBy: { section: "code" },
    });
    expect(by("setup:searchKeys.brave").hosts).toEqual(["api.search.brave.com"]);
    // The chat's plain field is not a key: it stays in the settings.
    expect(view.entries.some((e) => e.usedBy?.key.includes("homeserver"))).toBe(false);
    const state = (await s.api<{ config: { chatSettings?: unknown } }>("GET", "/api/setup")).body;
    expect(state.config.chatSettings).toEqual({
      matrix: { homeserver: "https://matrix.example.org" },
    });
    // The parts started with the keys, as before.
    expect(calls).toContain(`key:anthropic:${ANTHROPIC}`);
    expect(calls).toContain(`telegram:${TELEGRAM}`);
    expect(calls).toContain(
      `chat:matrix:${JSON.stringify({ homeserver: "https://matrix.example.org", accessToken: MATRIX })}`,
    );
    // The move is in the record of uses.
    const moved = view.uses.filter((u) => u.outcome === "moved");
    expect(moved).toHaveLength(5);
    expect(moved[0]).toMatchObject({ host: "secrets.json", agentId: null });
    // No value anywhere it could be read: the page, the API, the database, the file on disk, the log.
    const answers = JSON.stringify([view, state]);
    const sealed = await readFile(join(dataDir, "..", "keychain", "keychain.enc"), "utf8");
    const rows = JSON.stringify(
      await s.core.db.query("SELECT key, value FROM rg_settings WHERE owner_id = 'me'"),
    );
    const events = JSON.stringify(await s.core.db.query("SELECT * FROM rg_events"));
    const yaml = await readFile(join(dataDir, "redgiant.yaml"), "utf8");
    for (const v of VALUES) {
      expect(answers).not.toContain(v);
      expect(sealed).not.toContain(v);
      expect(rows).not.toContain(v);
      expect(events).not.toContain(v);
      expect(yaml).not.toContain(v);
      expect(redactor.redactText(`it is ${v}`).text).not.toContain(v);
    }
    expect(yaml).toMatch(/secrets are in the keychain/);
    // Agents see the names, never a value; they may not use these without the person's yes.
    expect(s.core.vault.names("me").map((n) => n.name)).toContain("anthropic-api-key");
    const used = await s.core.vault.authorize(
      {
        ownerId: "me",
        agentId: "a1",
        agentName: "A",
        sessionId: "s1",
        tool: "use_credential",
      },
      "anthropic-api-key",
      "api.anthropic.com",
      "GET",
    );
    expect(used).toMatch(/this agent may not use it/);
    // The criticals' check recognises them leaving (G36.17b).
    expect(s.core.vault.values("me")).toEqual(expect.arrayContaining(VALUES));
  });

  it("is idempotent: a second start finds nothing to move and changes nothing", async () => {
    const first = await start();
    const before = first.s.core.vault.systemValues("me", "setup:");
    const again = new SetupService({
      db: first.s.core.db,
      core: first.s.core,
      dataDir: first.dataDir,
      ownerId: "me",
      hooks: hooks().h,
    });
    await again.applyAtStartup();
    expect(first.s.core.vault.systemValues("me", "setup:")).toEqual(before);
    const view = await first.s.core.vault.view("me");
    expect(view.uses.filter((u) => u.outcome === "moved")).toHaveLength(5);
    expect(view.entries.filter((e) => e.usedBy)).toHaveLength(5);
    again.stop();
  });

  it("keeps the file when the keys do not read back, and finishes the move at the next start", async () => {
    const { s, dataDir, calls } = await start();
    // The first run moved it already: put a file back and make the check fail once.
    await writeFile(
      join(dataDir, "secrets.json"),
      JSON.stringify({ ...OLD_FILE, keys: { anthropic: `${ANTHROPIC}-new` } }),
    );
    const check = vi.spyOn(s.core.vault, "verifySystem").mockResolvedValueOnce(false);
    const cut = new SetupService({
      db: s.core.db,
      core: s.core,
      dataDir,
      ownerId: "me",
      hooks: hooks().h,
    });
    await cut.applyAtStartup();
    expect(check).toHaveBeenCalled();
    // Not checked: the file stays (the keychain already has its values, nothing is lost).
    expect(await exists(join(dataDir, "secrets.json"))).toBe(true);
    expect(s.core.vault.systemValue("me", "setup:keys.anthropic")).toBe(`${ANTHROPIC}-new`);
    check.mockRestore();
    cut.stop();
    // The next start finishes it.
    const next = new SetupService({
      db: s.core.db,
      core: s.core,
      dataDir,
      ownerId: "me",
      hooks: hooks().h,
    });
    await next.applyAtStartup();
    expect(await exists(join(dataDir, "secrets.json"))).toBe(false);
    expect(s.core.vault.systemValue("me", "setup:keys.anthropic")).toBe(`${ANTHROPIC}-new`);
    next.stop();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("finishes destroying a file a stop cut short after its check", async () => {
    const { s, dataDir } = await start();
    // A stop between the rename and the removal leaves secrets.json.shred: its keys were checked.
    await writeFile(join(dataDir, "secrets.json.shred"), JSON.stringify(OLD_FILE));
    const next = new SetupService({
      db: s.core.db,
      core: s.core,
      dataDir,
      ownerId: "me",
      hooks: hooks().h,
    });
    await next.applyAtStartup();
    expect(await exists(join(dataDir, "secrets.json.shred"))).toBe(false);
    expect(s.core.vault.systemValue("me", "setup:githubToken")).toBe(GITHUB);
    next.stop();
  });

  it("deletes nothing when the keychain cannot open, and keeps working from the file", async () => {
    const broken: MasterKeyStore = {
      kind: "file",
      load: async () => null,
      save: async () => {
        throw new Error("disk is read-only");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { s, dataDir, calls, setup } = await start({ keyStores: [broken] });
    expect(s.core.vault.ready).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("stay in secrets.json"))).toBe(true);
    warn.mockRestore();
    // Untouched, and used.
    expect(JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8"))).toEqual(OLD_FILE);
    expect(calls).toContain(`key:anthropic:${ANTHROPIC}`);
    // A key saved meanwhile still lands in the file (it moves once the keychain opens).
    await setup.saveKey("openai", "sk-proj-saved-while-closed-0006");
    expect(JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8")).keys.openai).toBe(
      "sk-proj-saved-while-closed-0006",
    );
    const view = (await s.api<VaultView>("GET", "/api/vault")).body;
    expect(view.ready).toBe(false);
    expect(JSON.stringify(view)).not.toContain(ANTHROPIC);
  });

  it("a key changed in the keychain reaches the part that uses it; removing it is for its page", async () => {
    const { s, calls } = await start();
    const view = (await s.api<VaultView>("GET", "/api/vault")).body;
    const e = view.entries.find((x) => x.usedBy?.key === "setup:keys.anthropic") as VaultEntry;
    const { id, length: _l, uses: _u, lastUsedAt: _a, createdAt: _c, updatedAt: _d, ...rest } = e;
    const changed = await s.api("PUT", `/api/vault/${id}`, {
      ...rest,
      name: "my-anthropic",
      hosts: ["api.anthropic.com", "*.anthropic.com"],
      value: "sk-ant-api03-changed-in-the-keychain-0007",
    });
    expect(changed.status).toBe(200);
    await vi.waitFor(() =>
      expect(calls).toContain("key:anthropic:sk-ant-api03-changed-in-the-keychain-0007"),
    );
    const after = (await s.api<VaultView>("GET", "/api/vault")).body.entries.find(
      (x) => x.id === id,
    );
    // The person's name and hosts stay; it is still the setup's key.
    expect(after).toMatchObject({
      name: "my-anthropic",
      hosts: ["api.anthropic.com", "*.anthropic.com"],
      usedBy: { key: "setup:keys.anthropic", section: "subscriptions" },
    });
    expect(JSON.stringify(changed.body)).not.toContain("changed-in-the-keychain");
    const removed = await s.api<{ code: string }>("DELETE", `/api/vault/${id}`);
    expect(removed.status).toBe(400);
    expect(removed.body.code).toBe("vault_system");
    // Its page removes it.
    await s.api("DELETE", "/api/setup/keys/anthropic");
    expect(s.core.vault.systemValue("me", "setup:keys.anthropic")).toBeUndefined();
  });

  it("lists the keys set by the administrator as locked", async () => {
    const { h } = hooks();
    let setup: SetupService | undefined;
    const s = await startServer({ text: "OK" }, {}, {}, undefined, undefined, async (core, dir) => {
      setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks: h,
        locked: { anthropic: true, telegram: true },
      });
      await setup.applyAtStartup();
      core.vaultSystem = async () => (setup as SetupService).keysForVault();
      return { setup };
    });
    servers.push(s);
    const view = (await s.api<VaultView>("GET", "/api/vault")).body;
    expect(view.system).toEqual([
      expect.objectContaining({ id: "env:anthropic", locked: true, section: "subscriptions" }),
      expect.objectContaining({ id: "env:telegram", locked: true, section: "telegram" }),
    ]);
  });

  it("moves a mailbox's password file and reads the password from the keychain", async () => {
    const mailbox: Mailbox = { newer: async () => ({ mails: [] as Mail[], last: 1 }) };
    const { s, dataDir } = await start({ file: null, mailbox });
    const added = await s.api<{ id: string }>("POST", "/api/settings/mailboxes", {
      name: "Work",
      category: "work",
      host: "imap.example.org",
      port: 993,
      secure: true,
      user: "me@example.org",
      password: "mail-pw-in-the-keychain-0008",
    });
    expect(added.status).toBe(201);
    const id = added.body.id;
    // Saved from its page: straight into the keychain, no file.
    expect(s.core.vault.systemValue("me", `email:${id}`)).toBe("mail-pw-in-the-keychain-0008");
    expect(await exists(join(dataDir, "..", "email", "me", `${id}.json`))).toBe(false);
    // As a version before G36.20 left it: a private file, nothing in the keychain.
    await s.core.vault.setSystem("me", `email:${id}`, null);
    const file = join(dataDir, "..", "email", "me", `${id}.json`);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ password: "mail-pw-in-the-keychain-0008" }));
    await s.core.email.moveSecretsToVault();
    // Owners come from the agents; with none yet, the first read moves it.
    expect((await s.core.email.accountOf("me", id))?.password).toBe("mail-pw-in-the-keychain-0008");
    expect(await exists(file)).toBe(false);
    const entry = (await s.core.vault.view("me")).entries.find(
      (e) => e.usedBy?.key === `email:${id}`,
    );
    expect(entry).toMatchObject({
      service: "Work",
      username: "me@example.org",
      category: "email",
      hosts: ["imap.example.org", "smtp.example.org"],
      usedBy: { section: "automations", kind: "email" },
    });
    expect(s.core.vault.systemValue("me", `email:${id}`)).toBe("mail-pw-in-the-keychain-0008");
    // Removing the mailbox removes its key.
    await s.core.email.removeBox("me", id);
    expect(s.core.vault.systemValue("me", `email:${id}`)).toBeUndefined();
  });

  it("moves an MCP server's sign-in file and keeps new sign-ins in the keychain", async () => {
    const { s, dataDir } = await start({ file: null });
    const file = join(dataDir, "..", "mcp-credentials", "me", "linear.json");
    await mkdir(join(file, ".."), { recursive: true });
    const tokens = { access_token: "lin_oauth_moved_token_0009", token_type: "Bearer" };
    await writeFile(file, JSON.stringify({ tokens }));
    expect((await s.core.mcpCredentials.load("me", "linear")).tokens).toEqual(tokens);
    expect(await exists(file)).toBe(false);
    expect(JSON.parse(s.core.vault.systemValue("me", "mcp:linear") as string)).toEqual({ tokens });
    await s.core.mcpCredentials.save("me", "linear", { headers: { "x-key": "k-0010" } });
    expect(await exists(file)).toBe(false);
    expect(await s.core.mcpCredentials.load("me", "linear")).toEqual({
      tokens,
      headers: { "x-key": "k-0010" },
    });
    const entry = (await s.core.vault.view("me")).entries.find(
      (e) => e.usedBy?.key === "mcp:linear",
    );
    expect(entry).toMatchObject({
      service: "linear",
      usedBy: { section: "extensions", kind: "mcp" },
    });
    await s.core.mcpCredentials.remove("me", "linear");
    expect(s.core.vault.systemValue("me", "mcp:linear")).toBeUndefined();
  });

  it("a backup sealed with the person's passphrase carries the keys back to their parts", async () => {
    const a = await start();
    const sealed = a.s.core.vault.exportSealed("me", "a long passphrase");
    for (const v of VALUES) expect(sealed).not.toContain(v);
    // A new installation, nothing set yet.
    const b = await start({ file: null });
    expect(b.s.core.vault.systemValue("me", "setup:keys.anthropic")).toBeUndefined();
    const added = await b.s.core.vault.importSealed("me", sealed, "a long passphrase");
    expect(added).toBe(5);
    expect(b.s.core.vault.systemValue("me", "setup:keys.anthropic")).toBe(ANTHROPIC);
    await vi.waitFor(() => expect(b.calls).toContain(`key:anthropic:${ANTHROPIC}`));
    await vi.waitFor(() => expect(b.calls).toContain(`telegram:${TELEGRAM}`));
    const entry = (await b.s.core.vault.view("me")).entries.find(
      (e) => e.usedBy?.key === "setup:githubToken",
    );
    expect(entry?.usedBy?.section).toBe("code");
    // The same backup again adds nothing.
    expect(await b.s.core.vault.importSealed("me", sealed, "a long passphrase")).toBe(0);
    // A wrong passphrase gets nothing.
    await expect(b.s.core.vault.importSealed("me", sealed, "not the passphrase")).rejects.toThrow();
  });
});
