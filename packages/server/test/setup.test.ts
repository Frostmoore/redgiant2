import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GgufFile,
  HuggingFace,
  quantOf,
  type SetupHooks,
  SetupService,
  type SetupState,
  suggest,
} from "../src/index.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** Hooks that record what the wizard asked for. */
function fakeHooks() {
  const calls: string[] = [];
  const hooks: SetupHooks = {
    async anthropic(key) {
      calls.push(`anthropic:${key ? "set" : "removed"}`);
    },
    async openai(cfg) {
      calls.push(`openai:${cfg?.baseUrl ?? "removed"}`);
      return cfg ? ["qwen3-8b"] : [];
    },
    async telegram(token) {
      if (token === "1:bad") throw new Error("Telegram refused the token (401)");
      calls.push(`telegram:${token ? "on" : "off"}`);
      return token ? { username: "my_bot" } : null;
    },
    async search(url) {
      calls.push(`search:${url}`);
    },
    async engine(cfg) {
      calls.push(`engine:${cfg ? `${cfg.variant}:${cfg.model}` : "off"}`);
    },
  };
  return { hooks, calls };
}

async function setup() {
  const { hooks, calls } = fakeHooks();
  let service: SetupService | undefined;
  let dataDir = "";
  s = await startServer(
    (req) => (req.model === "broken" ? { error: new Error("no such model") } : { text: "OK" }),
    {},
    {},
    undefined,
    undefined,
    async (core, dir) => {
      dataDir = join(dir, "data");
      service = new SetupService({ db: core.db, core, dataDir, ownerId: "me", hooks });
      await service.applyAtStartup();
      return { setup: service };
    },
  );
  return { calls, hooks, dataDir, service: service as SetupService };
}

describe("the setup wizard", () => {
  it("applies and keeps every step, with secrets only in a private file", async () => {
    const { calls, dataDir } = await setup();
    const api = (s as Server).api;
    const first = (await api<SetupState>("GET", "/api/setup")).body;
    expect(first.config.completed).toBe(false);
    expect(first.hardware.cores).toBeGreaterThan(0);
    expect(first.names).toEqual({ god: null, demigod: null, godPrompt: null });

    const key = "sk-ant-api03-secret-for-the-wizard-test";
    expect(
      (
        await api("PUT", "/api/setup/models", {
          anthropicKey: key,
          openai: { baseUrl: "http://llm.local:8080/v1" },
          searxngUrl: "http://searxng:8080",
          defaultModel: { provider: "fake", model: "good", effort: "low" },
        })
      ).body,
    ).toEqual({ openaiModels: ["qwen3-8b"] });
    expect(s?.core.defaultModel).toEqual({ provider: "fake", model: "good", effort: "low" });
    // A model that cannot answer is not made the default.
    const bad = await api<{ error: string }>("PUT", "/api/setup/models", {
      defaultModel: { provider: "fake", model: "broken" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/did not answer a test request/);
    expect(s?.core.defaultModel?.model).toBe("good");

    await api("PUT", "/api/setup/names", { god: "Zeus", demigod: "Hermes", language: "it" });
    await api("PUT", "/api/setup/names", {
      god: "Odino",
      demigod: "Hermes",
      godPrompt: "Be brief.",
    });
    const agents = s?.core.registry.list({ ownerId: "me" }) ?? [];
    expect(agents.map((a) => [a.kind, a.name])).toEqual([
      ["god", "Odino"],
      ["demigod", "Hermes"],
    ]);
    expect(agents[0]?.systemPrompt).toBe("Be brief.");

    expect((await api("PUT", "/api/setup/telegram", { token: "not a token" })).status).toBe(400);
    expect(
      (await api<{ error: string }>("PUT", "/api/setup/telegram", { token: "1:bad" })).body.error,
    ).toMatch(/refused/);
    expect((await api("PUT", "/api/setup/telegram", { token: "123:ABC-def" })).body).toEqual({
      username: "my_bot",
    });

    await api("PUT", "/api/setup/engine", { engine: { variant: "cuda", model: "gemma.gguf" } });
    expect(
      (await api("PUT", "/api/setup/engine", { engine: { variant: "cpu", model: "../x.gguf" } }))
        .status,
    ).toBe(400);
    await api("PUT", "/api/setup/safety", {
      budgetUsd: 25,
      humanOnly: ["git-push", "platform"],
      retentionDays: 90,
      subscriptionAck: true,
    });
    await api("POST", "/api/setup/complete");

    const state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config).toMatchObject({
      completed: true,
      language: "it",
      retentionDays: 90,
      subscriptionAck: true,
      engine: { variant: "cuda", model: "gemma.gguf" },
    });
    expect(state.secretsSet).toEqual({
      anthropic: true,
      openai: false,
      telegram: true,
      transcription: false,
    });
    expect(state.budgetUsd).toBe(25);
    expect(state.policy.humanOnly).toEqual(["git-push", "platform"]);
    expect(calls).toEqual([
      "anthropic:set",
      "openai:http://llm.local:8080/v1",
      "search:http://searxng:8080",
      "telegram:on",
      "engine:cuda:gemma.gguf",
    ]);

    // Secrets: in secrets.json (owner-only), never in the API, the database or redgiant.yaml.
    const secrets = join(dataDir, "secrets.json");
    if (process.platform !== "win32") expect((await stat(secrets)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(secrets, "utf8"))).toMatchObject({
      anthropicKey: key,
      telegramToken: "123:ABC-def",
    });
    expect(JSON.stringify(state)).not.toContain(key);
    const rows = await (s as Server).core.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings",
    );
    expect(JSON.stringify(rows)).not.toContain(key);
    const yaml = await readFile(join(dataDir, "redgiant.yaml"), "utf8");
    expect(yaml).toMatch(/completed: true/);
    expect(yaml).not.toContain(key);
  });

  it("puts the chosen names in the built-in instructions", async () => {
    const { service } = await setup();
    await service.saveNames({ god: "Zeus", demigod: "Hermes" });
    const [god, demigod] = s?.core.registry.list({ ownerId: "me" }) ?? [];
    expect(s?.core.systemFor(god as never)).toMatch(
      /^You are Zeus, .* relayed from their Telegram by Hermes/,
    );
    expect(s?.core.systemFor(demigod as never)).toMatch(
      /^You are Hermes, .*Pass every request to Zeus with ask_god/,
    );
  });

  it("applies the saved choices again at the next start, unless the environment sets them", async () => {
    const { service, dataDir } = await setup();
    await service.saveModels({
      anthropicKey: "sk-ant-api03-another-secret-value",
      searxngUrl: "http://s:8080",
    });
    await service.saveTelegram("9:TOKEN");
    const again = fakeHooks();
    const next = new SetupService({
      db: (s as Server).core.db,
      core: (s as Server).core,
      dataDir,
      ownerId: "me",
      hooks: again.hooks,
      locked: { telegram: true },
    });
    await next.applyAtStartup();
    expect(again.calls).toEqual(["anthropic:set", "search:http://s:8080"]);
    await expect(next.saveTelegram("9:OTHER")).rejects.toThrow(/environment/);
    next.stop();
  });

  it("erases old event payloads when a retention period is set", async () => {
    const { service } = await setup();
    const store = (s as Server).core.store;
    await store.append({ body: { type: "message.user", payload: { text: "old" } } });
    // Everything older than 0 days... is everything before now: use the store directly for the cutoff.
    await service.saveSafety({ retentionDays: 1 });
    expect((await store.list({})).filter((e) => e.erased)).toEqual([]); // nothing is a day old yet
    expect(await store.eraseBefore(new Date(Date.now() + 1000), "test")).toBe(1);
    service.stop();
  });
});

describe("Hugging Face models", () => {
  const files: GgufFile[] = [
    { file: "m-Q2_K.gguf", sizeGb: 1.2, quant: "Q2_K" },
    { file: "m-Q4_K_M.gguf", sizeGb: 2.5, quant: "Q4_K_M" },
    { file: "m-Q6_K.gguf", sizeGb: 3.6, quant: "Q6_K" },
    { file: "m-Q8_0.gguf", sizeGb: 4.7, quant: "Q8_0" },
  ];

  it("reads the quantisation and picks the best one that fits", () => {
    expect(quantOf("gemma-4-E2B-it-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("model.IQ4_XS.gguf")).toBe("IQ4_XS");
    expect(quantOf("x-f16.gguf")).toBe("F16");
    expect(suggest(files, 3)?.quant).toBe("Q4_K_M");
    expect(suggest(files, 4)?.quant).toBe("Q6_K");
    expect(suggest(files, 100)?.quant).toBe("Q8_0");
    expect(suggest(files, 1)).toBeUndefined();
  });

  it("searches, lists GGUF files and downloads one with progress", async () => {
    const payload = new Uint8Array(1500).fill(7);
    const fake = (async (url: string) => {
      if (url.includes("/api/models?search="))
        return Response.json([{ id: "acme/tiny-GGUF", downloads: 10, likes: 2 }]);
      if (url.includes("/tree/main"))
        return Response.json([
          { path: "tiny-Q4_K_M.gguf", lfs: { size: 2 * 1024 ** 3 } },
          { path: "mmproj-tiny-f16.gguf", size: 10 },
          { path: "README.md", size: 5 },
        ]);
      if (url.endsWith("/resolve/main/tiny-Q4_K_M.gguf"))
        return new Response(payload, { headers: { "content-length": "1500" } });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    s = await startServer(() => ({ text: "x" }));
    const dir = join(s.dir, "models");
    const hf = new HuggingFace(dir, fake);
    expect(await hf.search("tiny")).toEqual([{ id: "acme/tiny-GGUF", downloads: 10, likes: 2 }]);
    expect(await hf.files("acme/tiny-GGUF")).toEqual([
      { file: "tiny-Q4_K_M.gguf", sizeGb: 2, quant: "Q4_K_M" },
    ]);
    expect(() => hf.start("acme/tiny-GGUF", "../../etc/passwd.gguf")).toThrow();
    const d = hf.start("acme/tiny-GGUF", "tiny-Q4_K_M.gguf");
    for (let i = 0; i < 100 && d.state === "running"; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(d).toMatchObject({ state: "done", bytes: 1500, total: 1500 });
    expect((await readFile(join(dir, "tiny-Q4_K_M.gguf"))).length).toBe(1500);
  });
});
