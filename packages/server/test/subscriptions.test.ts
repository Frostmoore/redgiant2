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
      anthropic: async () => {},
      openai: async () => [],
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
});
