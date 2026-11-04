import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Job } from "@redgiant/protocol";
import { FakeProvider, ProviderError } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeGpu,
  detectHardware,
  engineError,
  firstDefault,
  type GgufFile,
  HuggingFace,
  hostGpus,
  isModelFile,
  JobFailure,
  Jobs,
  localModelChoices,
  qualityOf,
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
    async key(id, key) {
      // Each provider's own way of refusing a key.
      if (key?.includes("wrong"))
        throw new ProviderError(`${id}: HTTP 401`, false, { status: id === "gemini" ? 400 : 401 });
      if (key?.includes("offline")) throw new ProviderError(`${id}: fetch failed`, true);
      calls.push(`key:${id}:${key ? "set" : "removed"}`);
      return key ? [`${id}-model`] : [];
    },
    async server(cfg) {
      calls.push(`server:${cfg?.baseUrl ?? "removed"}`);
      return cfg ? ["qwen3-8b"] : [];
    },
    async telegram(token) {
      if (token === "1:bad") throw new Error("Telegram refused the token (401)");
      calls.push(`telegram:${token ? "on" : "off"}`);
      return token ? { username: "my_bot" } : null;
    },
    async search(c) {
      calls.push(`search:${c ? (c.url ?? `${c.provider}:${c.key ? "key" : "none"}`) : null}`);
    },
    async engine(cfg) {
      const share = cfg?.tuning?.moeCacheShare;
      calls.push(
        `engine:${cfg ? `${cfg.variant}:${cfg.model}${cfg.stream ? `:stream${share ?? ""}` : ""}` : "off"}`,
      );
      // A mixture of experts streamed: a plan with a cache for its experts.
      if (cfg?.stream)
        return {
          ctx: 131072,
          args: ["--cpu-moe"],
          fit: true,
          moe: true,
          moeCacheMib: Math.round((share ?? 0) * 8192),
          source: "ram" as const,
          ssdGbPerWord: 0,
        };
    },
    async pihole(o, h) {
      if (o?.lanIp === "10.9.9.9") throw new JobFailure("port_busy", "port 53 is taken");
      calls.push(`pihole:${o ? `${o.lanIp}:${o.domain}:${o.password.length}` : "off"}`);
      h?.step("pihole_image");
      return o ? { adminUrl: `http://${o.lanIp}:8053/admin/` } : null;
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
    expect((await api("PUT", "/api/setup/keys/anthropic", { key })).body).toEqual({
      models: ["anthropic-model"],
    });
    expect(
      (await api("PUT", "/api/setup/server", { baseUrl: "http://llm.local:8080/v1" })).body,
    ).toEqual({
      models: ["qwen3-8b"],
    });
    await api("PUT", "/api/setup/models", {
      searxngUrl: "http://searxng:8080",
      defaultModel: { provider: "fake", model: "good", effort: "low" },
    });
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
    const refused = await api<{ error: string; code: string }>("PUT", "/api/setup/telegram", {
      token: "1:bad",
    });
    expect(refused.body.error).toMatch(/refused/);
    expect(refused.body.code).toBe("token_rejected");
    expect((await api("PUT", "/api/setup/telegram", { token: "123:ABC-def" })).body).toEqual({
      username: "my_bot",
    });

    // Starting the engine is a job; it is kept only once the model answers.
    s?.core.providers.register(new FakeProvider(() => ({ text: "OK" }), { id: "local" }));
    const job = await api<Job>("PUT", "/api/setup/engine", {
      engine: { variant: "cuda", model: "gemma.gguf" },
    });
    expect(job.body.steps.map((x) => x.id)).toEqual([
      "image",
      "preload",
      "start",
      "load",
      "tune",
      "try",
    ]);
    expect((await s?.core.jobs.settled(job.body.id))?.state).toBe("done");
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
      keys: ["anthropic"],
      server: false,
      chats: [],
      telegram: true,
      transcription: false,
      images: false,
      media: [],
      claudeSubscription: false,
      github: false,
      gitea: false,
      search: [],
    });
    expect(state.budgetUsd).toBe(25);
    expect(state.policy.humanOnly).toEqual(["git-push", "platform"]);
    expect(calls).toEqual([
      "key:anthropic:set",
      "server:http://llm.local:8080/v1",
      "search:http://searxng:8080",
      "telegram:on",
      "engine:cuda:gemma.gguf",
    ]);

    // Secrets: in secrets.json (owner-only), never in the API, the database or redgiant.yaml.
    const secrets = join(dataDir, "secrets.json");
    if (process.platform !== "win32") expect((await stat(secrets)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(secrets, "utf8"))).toMatchObject({
      keys: { anthropic: key },
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
    await service.saveKey("anthropic", "sk-ant-api03-another-secret-value");
    await service.saveKey("gemini", "AIza-another-secret-value");
    await service.saveModels({ searxngUrl: "http://s:8080" });
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
    expect(again.calls).toEqual(["key:anthropic:set", "key:gemini:set", "search:http://s:8080"]);
    await expect(next.saveTelegram("9:OTHER")).rejects.toThrow(/environment/);
    next.stop();
  });

  it("connects providers with a key, and says why one failed", async () => {
    await setup();
    const api = (s as Server).api;
    type Failed = { error: string; code?: string };
    const wrong = await api<Failed>("PUT", "/api/setup/keys/gemini", { key: "AIza-wrong-key" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("key_rejected");
    expect(wrong.body.error).toMatch(/Google Gemini refused the key/);
    expect(
      (await api<Failed>("PUT", "/api/setup/keys/mistral", { key: "offline-key-123" })).body.code,
    ).toBe("unreachable");
    expect(
      (await api<Failed>("PUT", "/api/setup/keys/nope", { key: "12345678" })).body.error,
    ).toMatch(/Unknown provider/);
    // Nothing was kept for the keys that failed.
    expect((await api<SetupState>("GET", "/api/setup")).body.secretsSet.keys).toEqual([]);
    await api("PUT", "/api/setup/keys/groq", { key: "gsk_good-key-1234" });
    await api("PUT", "/api/setup/keys/openai", { key: "sk-proj-good-key" });
    let state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.secretsSet.keys).toEqual(["groq", "openai"]);
    expect(state.config.keyProviders).toEqual(["groq", "openai"]);
    await api("DELETE", "/api/setup/keys/groq");
    state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.secretsSet.keys).toEqual(["openai"]);
  });

  it("moves settings from before G24.2 to the new shape", async () => {
    const { dataDir } = await setup();
    const core = (s as Server).core;
    await core.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ('me', 'setup', $1)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({
          completed: true,
          openaiBaseUrl: "http://llm.local:8080/v1",
          defaultModel: { provider: "openai", model: "qwen3-8b" },
        }),
      ],
    );
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "secrets.json"),
      JSON.stringify({ anthropicKey: "sk-ant-api03-old-key", openaiKey: "old-server-key" }),
    );
    const again = fakeHooks();
    const next = new SetupService({
      db: core.db,
      core,
      dataDir,
      ownerId: "me",
      hooks: again.hooks,
    });
    await next.applyAtStartup();
    expect(again.calls).toEqual(["key:anthropic:set", "server:http://llm.local:8080/v1"]);
    const state = await next.state();
    expect(state.config).toMatchObject({
      keyProviders: ["anthropic"],
      server: { baseUrl: "http://llm.local:8080/v1" },
      defaultModel: { provider: "server", model: "qwen3-8b" },
    });
    expect(state.config).not.toHaveProperty("openaiBaseUrl");
    expect(JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8"))).toEqual({
      keys: { anthropic: "sk-ant-api03-old-key" },
      serverKey: "old-server-key",
    });
    next.stop();
  });

  it("uses a web search service with a key, the key kept only with the secrets (2026-11-03)", async () => {
    const { calls, dataDir } = await setup();
    const api = (s as Server).api;
    const r = await api("PUT", "/api/setup/models", {
      search: { provider: "tavily", key: "tvly-secret-123456" },
    });
    expect(r.status).toBe(200);
    expect(calls).toContain("search:tavily:key");
    const state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.searchProvider).toBe("tavily");
    expect(state.secretsSet.search).toEqual(["tavily"]);
    expect(JSON.stringify(state)).not.toContain("tvly-secret-123456");
    expect(await readFile(join(dataDir, "redgiant.yaml"), "utf8")).not.toContain("tvly-secret");
    // Back to SearXNG at an address: the Tavily key stays for later.
    await api("PUT", "/api/setup/models", {
      search: { provider: "searxng", url: "http://s:8080" },
    });
    expect(calls.at(-1)).toBe("search:http://s:8080");
    expect((await api<SetupState>("GET", "/api/setup")).body.secretsSet.search).toEqual(["tavily"]);
  });

  it("turns the local model off and on, and loads it as a job when RedGiant opens (2026-11-04)", async () => {
    const { calls, hooks, dataDir } = await setup();
    const api = (s as Server).api;
    s?.core.providers.register(new FakeProvider(() => ({ text: "OK" }), { id: "local" }));
    const started = await api<Job>("PUT", "/api/setup/engine", {
      engine: { variant: "cuda", model: "big.gguf" },
    });
    await s?.core.jobs.settled(started.body.id);
    // Off: the engine stops, the choice stays.
    calls.length = 0;
    expect((await api("PUT", "/api/setup/engine/power", { on: false })).status).toBe(200);
    expect(calls).toEqual(["engine:off"]);
    let state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.engine).toMatchObject({ model: "big.gguf", off: true });
    // Opening RedGiant again: an engine turned off is not started.
    const again = new SetupService({
      db: (s as Server).core.db,
      core: (s as Server).core,
      dataDir,
      ownerId: "me",
      hooks,
    });
    calls.length = 0;
    await again.applyAtStartup();
    expect(calls.filter((c) => c.startsWith("engine"))).toEqual([]);
    again.stop();
    // On: a job loads it again, the one the page shows at the top.
    const on = await api<Job>("PUT", "/api/setup/engine/power", { on: true });
    expect(on.body.kind).toBe("engine_load");
    expect((await s?.core.jobs.settled(on.body.id))?.state).toBe("done");
    expect(calls).toContain("engine:cuda:big.gguf");
    state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.engine?.off).toBeUndefined();
    // Opening RedGiant with it on: loaded as a job.
    const third = new SetupService({
      db: (s as Server).core.db,
      core: (s as Server).core,
      dataDir,
      ownerId: "me",
      hooks,
    });
    await third.applyAtStartup();
    const load = (s as Server).core.jobs.list("me").filter((j) => j.kind === "engine_load");
    expect(load.length).toBeGreaterThanOrEqual(2);
    third.stop();
  });

  it("measures what speculative decoding gains, and puts the engine back (2026-11-04)", async () => {
    const { calls, hooks } = await setup();
    const api = (s as Server).api;
    const seen: (string | undefined)[] = [];
    const engine = hooks.engine.bind(hooks);
    hooks.engine = async (cfg, h) => {
      seen.push(cfg ? (cfg.speculative ?? "none") : "off");
      return engine(cfg, h);
    };
    s?.core.providers.register(new FakeProvider(() => ({ text: "OK" }), { id: "local" }));
    const started = await api<Job>("PUT", "/api/setup/engine", {
      engine: { variant: "cuda", model: "big.gguf" },
    });
    await s?.core.jobs.settled(started.body.id);
    seen.length = 0;
    const job = await api<Job>("POST", "/api/setup/engine/speed-test", {
      engine: { variant: "cuda", model: "big.gguf" },
      modes: ["none", "draft", "ngram"],
    });
    // The engine runs alone now: that way goes last, and nothing is loaded again at the end.
    expect(job.body.steps.map((x) => x.id)).toEqual(["draft", "ngram", "none", "restore"]);
    const done = await s?.core.jobs.settled(job.body.id);
    expect(done?.state).toBe("done");
    const trials = JSON.parse(done?.vars.trials ?? "[]") as { mode: string; state: string }[];
    // No small model downloaded: that way is skipped, the others measured.
    expect(trials.map((x) => [x.mode, x.state])).toEqual([
      ["draft", "skipped"],
      ["ngram", "done"],
      ["none", "done"],
    ]);
    // The n-grams, then the model alone, which is how it ran: no restart to put it back.
    expect(seen).toEqual(["ngram", "none"]);
    expect(done?.steps.find((x) => x.id === "restore")?.state).toBe("skipped");
    expect(calls.at(-1)).toBe("engine:cuda:big.gguf");
  });

  it("streams a mixture of experts from the SSD, tuning the card's split by measuring (2026-11-03)", async () => {
    const { calls } = await setup();
    const api = (s as Server).api;
    // The engine writes fastest with 30 % of the card for the experts (the fake's say).
    const share = 0;
    s?.core.providers.register(
      new FakeProvider(() => ({ text: "OK" }), { id: "local", now: () => 0 }),
    );
    const job = await api<Job>("PUT", "/api/setup/engine", {
      engine: { variant: "cuda", model: "qwen.gguf", stream: true },
    });
    const done = await s?.core.jobs.settled(job.body.id);
    expect(done?.state).toBe("done");
    expect(done?.steps.find((x) => x.id === "tune")?.state).toBe("done");
    // Each try is on the job for the page: the split, the context, the speeds, the one kept.
    const trials = JSON.parse(done?.vars.trials ?? "[]") as {
      share: number;
      ctx: number;
      chosen?: boolean;
      opOffload?: boolean;
    }[];
    // The three splits, then reading without sending the experts to the card (2026-11-04).
    expect(trials.map((x) => x.share).slice(0, 3)).toEqual([0, 0.15, 0.3]);
    expect(trials).toHaveLength(4);
    expect(trials[3]).toMatchObject({ opOffload: false });
    expect(trials.every((x) => x.ctx === 131072)).toBe(true);
    expect(trials.filter((x) => x.chosen)).toHaveLength(1);
    const tries = calls.filter((c) => /^engine:cuda:qwen\.gguf:stream0/.test(c));
    expect(tries.slice(0, 3)).toEqual([
      "engine:cuda:qwen.gguf:stream0",
      "engine:cuda:qwen.gguf:stream0.15",
      "engine:cuda:qwen.gguf:stream0.3",
    ]);
    const state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.engine?.stream).toBe(true);
    expect(state.config.engine?.tuning?.moeCacheShare).toBeDefined();
    expect(typeof state.config.engine?.tuning?.opOffload).toBe("boolean");
    expect(state.config.engine?.plan?.ctx).toBe(131072);
    // Asked again while it runs as asked: nothing is done again (2026-11-04).
    const before = calls.length;
    const again = await api<Job>("PUT", "/api/setup/engine", {
      engine: { variant: "cuda", model: "qwen.gguf", stream: true },
    });
    const second = await s?.core.jobs.settled(again.body.id);
    expect(second?.steps.find((x) => x.id === "tune")?.state).toBe("skipped");
    expect(calls.length - before).toBe(0);
    expect(second?.steps.every((x) => x.state === "skipped")).toBe(true);
  });

  it("runs Pi-hole by choice, keeps its password and stops it", async () => {
    const { calls, dataDir } = await setup();
    const api = (s as Server).api;
    // Not a home address: refused before anything starts.
    expect((await api("POST", "/api/setup/pihole", { lanIp: "not-an-ip" })).status).toBe(400);
    const busy = await api<Job>("POST", "/api/setup/pihole", { lanIp: "10.9.9.9" });
    expect((await s?.core.jobs.settled(busy.body.id))?.error?.code).toBe("port_busy");
    expect((await api("GET", "/api/setup/pihole/password")).body).toEqual({ password: null });

    const job = await api<Job>("POST", "/api/setup/pihole", {
      lanIp: "192.168.1.50",
      domain: "casa.example.org",
    });
    expect(job.body.steps.map((x) => x.id)).toEqual([
      "pihole_image",
      "pihole_start",
      "pihole_check",
    ]);
    expect((await s?.core.jobs.settled(job.body.id))?.state).toBe("done");
    expect(calls).toContain("pihole:192.168.1.50:casa.example.org:16");
    const state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.pihole).toEqual({
      lanIp: "192.168.1.50",
      domain: "casa.example.org",
      adminUrl: "http://192.168.1.50:8053/admin/",
    });
    const { password } = (await api<{ password: string }>("GET", "/api/setup/pihole/password"))
      .body;
    expect(password).toHaveLength(16);
    // The password is a secret: never in the configuration the API returns.
    expect(JSON.stringify(state)).not.toContain(password);
    expect(JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8")).piholePassword).toBe(
      password,
    );
    // Started again, it keeps the same password.
    const again = await api<Job>("POST", "/api/setup/pihole", { lanIp: "192.168.1.51" });
    await s?.core.jobs.settled(again.body.id);
    expect((await api("GET", "/api/setup/pihole/password")).body).toEqual({ password });

    expect((await api("DELETE", "/api/setup/pihole")).status).toBe(200);
    expect(calls.at(-1)).toBe("pihole:off");
    expect((await api<SetupState>("GET", "/api/setup")).body.config.pihole).toBeUndefined();
    expect((await api("GET", "/api/setup/pihole/password")).body).toEqual({ password: null });
  });

  it("makes the first model connected the default, Opus first, and keeps a choice made", async () => {
    expect(
      firstDefault([
        { provider: "local", model: "gemma", effort: false },
        { provider: "claude-subscription", model: "claude-sonnet-5-5", effort: true },
        { provider: "claude-subscription", model: "claude-opus-5-5", effort: true },
        { provider: "anthropic", model: "claude-opus-5-5", effort: true },
      ]),
    ).toEqual({ provider: "claude-subscription", model: "claude-opus-5-5", effort: "medium" });
    expect(firstDefault([{ provider: "local", model: "gemma", effort: false }])).toEqual({
      provider: "local",
      model: "gemma",
    });
    expect(firstDefault([])).toBeUndefined();

    const { hooks } = await setup();
    const api = (s as Server).api;
    const core = (s as Server).core;
    core.setDefaultModel(undefined);
    // Connecting a key registers its models: the strongest becomes the default at once.
    const key = hooks.key;
    hooks.key = async (id, k) => {
      core.providers.register(
        new FakeProvider(() => ({ text: "OK" }), {
          id,
          models: ["claude-sonnet-5-5", "claude-opus-5-5"],
        }),
      );
      return key(id, k);
    };
    await api("PUT", "/api/setup/keys/anthropic", { key: "sk-ant-api03-a-good-key" });
    expect((await api<SetupState>("GET", "/api/setup")).body.config.defaultModel).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(core.defaultModel?.model).toBe("claude-opus-5-5");
    // A model chosen by the person is never replaced by a later connection.
    await api("PUT", "/api/setup/models", { defaultModel: { provider: "fake", model: "good" } });
    await api("PUT", "/api/setup/keys/openai", { key: "sk-proj-good-key" });
    expect(core.defaultModel).toMatchObject({ provider: "fake", model: "good" });
  });

  it("chooses who makes pictures, videos and sounds, with their keys (G25.3)", async () => {
    const { dataDir } = await setup();
    const api = (s as Server).api;
    // Runway cannot speak: refused before anything is kept.
    const wrong = await api<{ error: string }>("PUT", "/api/setup/media/speech", {
      choice: { provider: "runway", model: "gen4.5" },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/Runway cannot make speech/);
    expect(
      (
        await api("PUT", "/api/setup/media/speech", {
          choice: { provider: "elevenlabs", model: "eleven_v3", voice: "v-1" },
        })
      ).status,
    ).toBe(200);
    await api("PUT", "/api/setup/media/video", { choice: { provider: "runway", model: "gen4.5" } });
    await api("PUT", "/api/setup/media-keys/runway", { key: "key_runway_secret_123" });
    // A chat key of the same provider makes pictures too.
    await api("PUT", "/api/setup/keys/openai", { key: "sk-proj-shared-key" });
    let state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.media).toEqual({
      speech: { provider: "elevenlabs", model: "eleven_v3", voice: "v-1" },
      video: { provider: "runway", model: "gen4.5" },
    });
    expect(state.secretsSet.media.sort()).toEqual(["openai", "runway"]);
    expect(JSON.stringify(state)).not.toContain("key_runway_secret_123");
    const secrets = JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8"));
    expect(secrets.mediaKeys).toEqual({ runway: "key_runway_secret_123" });
    // ElevenLabs' voices need its key.
    expect(
      (await api<{ code?: string }>("GET", "/api/setup/media/voices?provider=elevenlabs")).body
        .code,
    ).toBe("no_key");
    expect(
      (await api<{ id: string }[]>("GET", "/api/setup/media/voices?provider=google")).body[0],
    ).toEqual({ id: "Kore", label: "Kore" });
    await api("PUT", "/api/setup/media/video", { choice: null });
    state = (await api<SetupState>("GET", "/api/setup")).body;
    expect(state.config.media?.video).toBeUndefined();
  });

  it("turns the old OpenAI pictures key into the pictures choice", async () => {
    const { dataDir } = await setup();
    const core = (s as Server).core;
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "secrets.json"),
      JSON.stringify({ openaiImagesKey: "sk-old-images-key" }),
    );
    const next = new SetupService({
      db: core.db,
      core,
      dataDir,
      ownerId: "me",
      hooks: fakeHooks().hooks,
    });
    await next.applyAtStartup();
    const state = await next.state();
    expect(state.config.media).toEqual({
      image: { provider: "openai", model: "gpt-image-2.5-flare" },
    });
    expect(state.secretsSet.media).toEqual(["openai"]);
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

describe("the GPUs of the host", () => {
  it("come from REDGIANT_HOST_GPUS when the server cannot see them, with their maker", () => {
    expect(
      hostGpus("NVIDIA GeForce RTX 4080 SUPER:16;bad;Intel(R) UHD Graphics 770:0;Second GPU:8.5"),
    ).toEqual([
      { name: "NVIDIA GeForce RTX 4080 SUPER", vramGb: 16, vendor: "nvidia", integrated: false },
      { name: "Intel(R) UHD Graphics 770", vramGb: 0, vendor: "intel", integrated: true },
      { name: "Second GPU", vramGb: 8.5, vendor: "other", integrated: false },
    ]);
  });

  it("tells discrete cards from the ones built into the processor", () => {
    const kind = (name: string, gb: number) => {
      const g = describeGpu(name, gb);
      return `${g.vendor}${g.integrated ? " integrated" : ""}`;
    };
    expect(kind("AMD Radeon RX 7900 XTX", 24)).toBe("amd");
    expect(kind("AMD Radeon(TM) Graphics", 0.5)).toBe("amd integrated");
    expect(kind("AMD Radeon 780M", 2)).toBe("amd integrated");
    expect(kind("Intel(R) Arc(TM) A770 Graphics", 16)).toBe("intel");
    expect(kind("Intel(R) Iris(R) Xe Graphics", 2)).toBe("intel integrated");
    expect(kind("NVIDIA RTX A2000", 6)).toBe("nvidia");
  });

  it("suggests CUDA, Vulkan or the CPU by what the containers can reach", async () => {
    const h = (hostGpus: string, runtimes: string[], gpuAccess = "") =>
      detectHardware({
        dataDir: "/tmp",
        gpus: async () => [],
        hostGpus,
        gpuAccess,
        dockerRuntimes: async () => runtimes,
      }).then((x) => x.suggestion);
    expect(await h("NVIDIA GeForce RTX 4080 SUPER:16", ["nvidia", "runc"])).toEqual({
      engine: "cuda",
      maxModelGb: 12.8,
      kind: "gpu",
      vramGb: 16,
    });
    // Docker's NVIDIA runtime alone: a GPU of unknown memory.
    expect(await h("", ["nvidia"])).toMatchObject({ engine: "cuda", kind: "gpu-unknown" });
    expect(await h("AMD Radeon RX 7800 XT:16", ["runc"], "dri")).toEqual({
      engine: "vulkan",
      maxModelGb: 12.8,
      kind: "gpu",
      vramGb: 16,
    });
    // An NVIDIA card without the NVIDIA runtime, on Linux: Vulkan.
    expect(await h("NVIDIA GeForce RTX 3060:12", ["runc"], "dri")).toMatchObject({
      engine: "vulkan",
    });
    const igpu = await h("Intel(R) Iris(R) Xe Graphics:0", ["runc"], "dri");
    expect(igpu).toMatchObject({ engine: "vulkan", kind: "igpu", vramGb: 0 });
    expect(igpu.maxModelGb).toBeLessThanOrEqual(8);
    // A GPU the containers cannot reach is no use (AMD and Intel on Windows, for now): the CPU.
    expect(await h("AMD Radeon RX 7800 XT:16", ["runc"], "wsl")).toMatchObject({ engine: "cpu" });
    expect(await h("AMD Radeon RX 7800 XT:16", ["runc"], "")).toMatchObject({
      engine: "cpu",
      kind: "cpu",
    });
    const cpu = await h("", []);
    expect(cpu).toMatchObject({ engine: "cpu", kind: "cpu", vramGb: 0 });
    expect(cpu.maxModelGb).toBeLessThanOrEqual(6);
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

  it("keeps only the files that are models", () => {
    for (const f of [
      "MTP/mtp-gemma-4-12b-it-Q8_0.gguf",
      "mtp-gemma-4-12b-it.gguf",
      "mmproj-F16.gguf",
      "imatrix_unsloth.gguf",
      "BF16/Qwen3.8-27B-BF16-00001-of-00002.gguf",
      "gemma-4-12b-it-BF16.gguf",
      "gpt-oss-20b-F16.gguf",
    ])
      expect(isModelFile(f), f).toBe(false);
    for (const f of [
      "gemma-4-12b-it-Q4_K_M.gguf",
      "Qwen3.8-27B-UD-Q4_K_XL.gguf",
      "gemma-4-26B-A4B-it-MXFP4_MOE.gguf",
    ])
      expect(isModelFile(f), f).toBe(true);
    expect(quantOf("Qwen3.8-27B-UD-Q4_K_XL.gguf")).toBe("UD-Q4_K_XL");
    expect(quantOf("gemma-4-26B-A4B-it-MXFP4_MOE.gguf")).toBe("MXFP4_MOE");
    expect([qualityOf("Q8_0"), qualityOf("UD-Q4_K_XL"), qualityOf("UD-IQ3_XXS")]).toEqual([
      "high",
      "good",
      "reduced",
    ]);
  });

  it("offers a model split in parts as one, downloads every part with one bar (2026-11-04)", async () => {
    const sizes: Record<string, number> = {
      "Q4/big-Q4_K_M-00001-of-00002.gguf": 1200,
      "Q4/big-Q4_K_M-00002-of-00002.gguf": 800,
    };
    const fake = (async (url: string) => {
      if (url.includes("/tree/main"))
        return Response.json([
          ...Object.entries(sizes).map(([path, size]) => ({ path, lfs: { size } })),
          { path: "Q8/big-Q8_0-00001-of-00002.gguf", lfs: { size: 3000 } },
        ]);
      const part = Object.keys(sizes).find((k) => url.endsWith(`/resolve/main/${k}`));
      if (part) {
        const body = new Uint8Array(sizes[part] as number);
        return new Response(body, { headers: { "content-length": String(body.length) } });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    s = await startServer(() => ({ text: "x" }));
    const hf = new HuggingFace(join(s.dir, "models-split"), fake);
    const listed = await hf.files("acme/big-GGUF");
    // The Q8 one lacks a part: not offered.
    expect(listed).toEqual([
      {
        file: "Q4/big-Q4_K_M-00001-of-00002.gguf",
        sizeGb: 0,
        quant: "Q4_K_M",
        parts: Object.keys(sizes),
      },
    ]);
    const jobs = new Jobs();
    const seen: number[] = [];
    const job = jobs.start("me", "model_download", ["download"], (h) =>
      hf.download("acme/big-GGUF", "Q4/big-Q4_K_M-00001-of-00002.gguf", {
        ...h,
        progress: (done, total) => {
          seen.push(done);
          h.progress(done, total);
        },
      }),
    );
    expect((await jobs.settled(job.id))?.state).toBe("done");
    expect(Math.max(...seen)).toBe(2000);
    expect(await hf.local()).toEqual([
      { file: "big-Q4_K_M-00001-of-00002.gguf", bytes: 2000, partial: false },
    ]);
    await hf.remove("big-Q4_K_M-00001-of-00002.gguf");
    expect(await hf.local()).toEqual([]);
  });

  it("downloads a model as a job, and a paused download goes on from where it was", async () => {
    const payload = new Uint8Array(1500).map((_, i) => i % 251);
    const ranges: (string | null)[] = [];
    let cut = true;
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.includes("/api/models?search="))
        return Response.json([{ id: "acme/tiny-GGUF", downloads: 10, likes: 2 }]);
      if (url.includes("/tree/main"))
        return Response.json([
          { path: "tiny-Q4_K_M.gguf", lfs: { size: 2 * 1024 ** 3 } },
          { path: "mmproj-tiny-f16.gguf", size: 10 },
          { path: "MTP/mtp-tiny-Q8_0.gguf", size: 10 },
          { path: "README.md", size: 5 },
        ]);
      if (url.endsWith("/resolve/main/tiny-Q4_K_M.gguf")) {
        const range = new Headers(init?.headers).get("range");
        ranges.push(range);
        const from = range ? Number(range.slice(6, -1)) : 0;
        const rest = payload.slice(from);
        // The first time the connection drops after 600 bytes.
        const body = cut
          ? new ReadableStream({
              start(c) {
                c.enqueue(rest.slice(0, 600));
                setTimeout(() => c.error(new Error("connection reset")), 100);
              },
            })
          : rest;
        cut = false;
        return new Response(body, {
          status: range ? 206 : 200,
          headers: { "content-length": String(rest.length) },
        });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    s = await startServer(() => ({ text: "x" }));
    const dir = join(s.dir, "models");
    const hf = new HuggingFace(dir, fake);
    expect(await hf.search("tiny")).toEqual([{ id: "acme/tiny-GGUF", downloads: 10, likes: 2 }]);
    expect(await hf.files("acme/tiny-GGUF")).toEqual([
      { file: "tiny-Q4_K_M.gguf", sizeGb: 2, quant: "Q4_K_M" },
    ]);
    const jobs = new Jobs();
    const run = () =>
      jobs.start("me", "model_download", ["download"], (h) =>
        hf.download("acme/tiny-GGUF", "tiny-Q4_K_M.gguf", h),
      );
    const bad = jobs.start("me", "model_download", ["download"], (h) =>
      hf.download("acme/tiny-GGUF", "../../etc/passwd.gguf", h),
    );
    expect((await jobs.settled(bad.id))?.error?.code).toBe("bad_file");
    const first = await jobs.settled(run().id);
    expect(first?.state).toBe("failed");
    expect(await hf.local()).toEqual([{ file: "tiny-Q4_K_M.gguf", bytes: 600, partial: true }]);
    const second = await jobs.settled(run().id);
    expect(second?.state).toBe("done");
    expect(ranges).toEqual([null, "bytes=600-"]);
    expect(new Uint8Array(await readFile(join(dir, "tiny-Q4_K_M.gguf")))).toEqual(payload);
    expect(await hf.local()).toEqual([{ file: "tiny-Q4_K_M.gguf", bytes: 1500, partial: false }]);
    await hf.remove("tiny-Q4_K_M.gguf");
    expect(await hf.local()).toEqual([]);
    await expect(hf.remove("../x.gguf")).rejects.toThrow();
  });

  it("suggests models that fit, with the best file for this computer", async () => {
    const fake = (async (url: string) =>
      Response.json(
        url.includes("gemma-4-12b")
          ? [
              { path: "gemma-4-12b-it-Q4_K_M.gguf", size: 7.1 * 1024 ** 3 },
              { path: "gemma-4-12b-it-Q8_0.gguf", size: 12.7 * 1024 ** 3 },
              { path: "MTP/mtp-gemma-4-12b-it-Q8_0.gguf", size: 0.5 * 1024 ** 3 },
            ]
          : url.includes("E2B")
            ? [{ path: "gemma-4-E2B-it-Q4_K_M.gguf", size: 3.1 * 1024 ** 3 }]
            : url.includes("E4B")
              ? new Response("down", { status: 503 })
              : [{ path: "big-Q4_K_M.gguf", size: 17 * 1024 ** 3 }],
      )) as typeof fetch;
    const hf = new HuggingFace("/tmp/none", (async (u: string) => {
      const r = await fake(u);
      return r instanceof Response ? r : Response.json(r);
    }) as typeof fetch);
    const list = await localModelChoices(hf, 12.8);
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    expect(byId["gemma-4-12b"]?.file).toMatchObject({
      file: "gemma-4-12b-it-Q8_0.gguf",
      quality: "high",
    });
    expect(byId["gemma-4-e2b"]?.file).toMatchObject({ quant: "Q4_K_M", quality: "good" });
    expect(byId["gemma-4-e4b"]).toMatchObject({ file: null, unavailable: true });
    expect(byId["qwen3.8-27b"]).toMatchObject({ file: null, smallestGb: 17 });
    expect((await localModelChoices(hf, 8)).find((m) => m.id === "gemma-4-12b")?.file?.file).toBe(
      "gemma-4-12b-it-Q4_K_M.gguf",
    );
    // SSD stream (2026-11-04): too big for memory, but the disk has room: the smallest file comes.
    const streamed = await localModelChoices(hf, 12.8, { diskFreeGb: 100 });
    expect(streamed.find((m) => m.id === "qwen3.8-27b")).toMatchObject({
      beyondMemory: true,
      file: { sizeGb: 17 },
    });
    const full = await localModelChoices(hf, 12.8, { diskFreeGb: 20 });
    expect(full.find((m) => m.id === "qwen3.8-27b")).toMatchObject({ file: null });
  });

  it("explains why the engine did not start", () => {
    expect(
      engineError(
        "ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory",
      ),
    ).toBe("out_of_memory");
    expect(
      engineError(
        'docker: Error response from daemon: could not select device driver "nvidia" with capabilities: [[gpu]]',
      ),
    ).toBe("no_gpu");
    expect(engineError("ggml_vulkan: No devices found.")).toBe("no_gpu");
    expect(engineError("warning: no usable GPU found, --gpu-layers option will be ignored")).toBe(
      "no_gpu",
    );
    expect(
      engineError("llama_model_load: error loading model: unknown model architecture: 'mtp'"),
    ).toBe("bad_model");
    expect(engineError("all good")).toBeUndefined();
  });
});
