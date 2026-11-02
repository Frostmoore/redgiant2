import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeProvider } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { type SetupHooks, SetupService } from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("flat subscriptions", () => {
  it("switch on only after the terms warning, and their plans' limits reach the header", async () => {
    const calls: string[] = [];
    const hooks: SetupHooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
      claudeSubscription: async (token) =>
        void calls.push(`claude:${token === null ? "off" : token || "folder"}`),
      chatgptSubscription: async (on) => void calls.push(`chatgpt:${on}`),
    };
    s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      const setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
      });
      await setup.applyAtStartup();
      return { setup };
    });
    const put = (b: unknown) => s?.api<{ error?: string }>("PUT", "/api/setup/subscriptions", b);
    const before = await put({ chatgpt: true });
    expect(before?.status).toBe(400);
    expect(before?.body.error).toMatch(/terms/);
    await s.api("PUT", "/api/setup/safety", { subscriptionAck: true });
    expect((await put({ chatgpt: true }))?.status).toBe(200);
    expect((await put({ claude: { token: "sk-ant-oat01-abcdefghijklmnopqrstuv" } }))?.status).toBe(
      200,
    );
    expect(calls).toEqual(["chatgpt:true", "claude:sk-ant-oat01-abcdefghijklmnopqrstuv"]);
    const state = await s.api<{
      config: { subscriptions: unknown };
      secretsSet: { claudeSubscription: boolean };
    }>("GET", "/api/setup");
    expect(state.body.config.subscriptions).toEqual({ chatgpt: true, claude: true });
    expect(state.body.secretsSet.claudeSubscription).toBe(true);

    // A provider with limits shows them; the others do not appear.
    const plan = Object.assign(new FakeProvider([], { id: "fake-plan" }), {
      limits: async () => [{ id: "7d", label: "7g", usedPct: 36 }],
    });
    s.core.providers.register(plan);
    expect((await s.api("GET", "/api/limits")).body).toEqual([
      { provider: "fake-plan", windows: [{ id: "7d", label: "7g", usedPct: 36 }] },
    ]);
  });

  it("sign in to Claude from the browser: Anthropic's page, then the code it shows", async () => {
    const calls: string[] = [];
    let configDir = "";
    const hooks: SetupHooks = {
      key: async () => [],
      server: async () => [],
      telegram: async () => null,
      search: async () => {},
      engine: async () => {},
      claudeSubscription: async (token) =>
        void calls.push(`claude:${token === null ? "off" : token || "folder"}`),
      claudeAuth: () => ({
        configDir,
        command: [
          process.execPath,
          join(import.meta.dirname, "../../subscriptions/test/fake-claude.mjs"),
        ],
      }),
    };
    s = await startServer([], {}, {}, undefined, undefined, async (core, dir) => {
      configDir = join(dir, "claude");
      await mkdir(configDir, { recursive: true });
      const setup = new SetupService({
        db: core.db,
        core,
        dataDir: join(dir, "data"),
        ownerId: "me",
        hooks,
      });
      await setup.applyAtStartup();
      return { setup };
    });
    const api = (s as Server).api;
    type Reply = { error?: string; code?: string; url?: string };
    // Without reading the warning on the terms, nothing starts.
    const first = await api<Reply>("POST", "/api/subscriptions/claude/login", {});
    expect(first.body.code).toBe("terms");
    expect(
      (await api<Reply>("POST", "/api/subscriptions/claude/code", { code: "good-code#abc" })).body
        .code,
    ).toBe("no_login");
    const page = await api<Reply>("POST", "/api/subscriptions/claude/login", { ack: true });
    expect(page.body.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize/);
    const wrong = await api<Reply>("POST", "/api/subscriptions/claude/code", {
      code: "old-code#abc",
    });
    expect(wrong.body.code).toBe("code_rejected");
    expect(calls).toEqual([]);
    // A new sign-in, the right code: the login stays in the folder and Claude is on.
    await api("POST", "/api/subscriptions/claude/login", {});
    expect(
      (await api("POST", "/api/subscriptions/claude/code", { code: "good-code#abc" })).body,
    ).toEqual({
      loggedIn: true,
      email: "me@example.com",
      plan: "max",
    });
    expect(calls).toEqual(["claude:folder"]);
    expect((await api("GET", "/api/subscriptions/claude")).body).toEqual({
      on: true,
      account: { loggedIn: true, email: "me@example.com", plan: "max" },
    });
    await api("POST", "/api/subscriptions/claude/logout");
    expect(calls).toEqual(["claude:folder", "claude:off"]);
    expect((await api("GET", "/api/subscriptions/claude")).body).toEqual({
      on: false,
      account: { loggedIn: false, email: null, plan: null },
    });
  });
});
