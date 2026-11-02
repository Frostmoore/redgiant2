#!/usr/bin/env node
// RedGiant server. Configured by environment variables until the setup wizard (G17) exists.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KvStore, LocalEngineProvider } from "@redgiant/engine-local";
import { pgPoolClient, Redactor, type SqlClient } from "@redgiant/events";
import type { ModelSpec } from "@redgiant/protocol";
import { AnthropicProvider, OpenAICompatProvider, ProviderRegistry } from "@redgiant/providers";
import { DockerSandboxProvider, HostSandboxProvider } from "@redgiant/sandbox";
import { RESTART_EXIT_CODE } from "@redgiant/supervisor";
import type { TelegramGateway } from "@redgiant/telegram";
import { SearxngSearch } from "@redgiant/tools";
import Docker from "dockerode";
import pg from "pg";
import { TokenAuth } from "./auth.js";
import { RedGiantCore } from "./core.js";
import { HuggingFace } from "./hf.js";
import { runtimeHooks } from "./runtime.js";
import { serve } from "./serve.js";
import { SetupService } from "./setup.js";

const env = process.env;

async function memoryDb(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = await PGlite.create();
  type Q = Pick<typeof pglite, "query">;
  const wrap = (q: Q, top: boolean): SqlClient => ({
    query: async <T>(text: string, params?: unknown[]) => (await q.query<T>(text, params)).rows,
    transaction: (fn) =>
      top ? pglite.transaction((tx) => fn(wrap(tx, false))) : fn(wrap(q, false)),
  });
  return wrap(pglite, true);
}
const need = (name: string) => {
  const v = env[name];
  if (!v) {
    console.error(`Missing ${name}. See the README for the configuration variables.`);
    process.exit(2);
  }
  return v;
};

const token = need("REDGIANT_TOKEN");
const dataDir = resolve(env.REDGIANT_DATA_DIR ?? "./data");
const redactor = new Redactor().addSecret("redgiant-token", token);

const providers = new ProviderRegistry();
const shutdownHooks: (() => Promise<void>)[] = [];
if (env.ANTHROPIC_API_KEY) {
  providers.register(new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }));
  redactor.addSecret("anthropic", env.ANTHROPIC_API_KEY);
}
// A llama.cpp engine shared by every agent: slots by priority, KV cache saved on the SSD.
if (env.REDGIANT_LLAMACPP_URL) {
  const kvDir = env.REDGIANT_KV_DIR;
  const engine = new LocalEngineProvider({
    id: env.REDGIANT_LLAMACPP_ID ?? "local",
    baseURL: env.REDGIANT_LLAMACPP_URL,
    ...(kvDir && { kv: new KvStore(kvDir) }),
    ...(env.REDGIANT_KV_BUDGET_MB && {
      kvBudgetBytes: Number(env.REDGIANT_KV_BUDGET_MB) * 1024 * 1024,
    }),
  });
  await engine
    .connect()
    .catch((err) =>
      console.warn(`llama.cpp engine not reachable at ${env.REDGIANT_LLAMACPP_URL}: ${err}`),
    );
  providers.register(engine);
  shutdownHooks.push(() => engine.shutdown());
}
if (env.REDGIANT_OPENAI_BASE_URL) {
  const local = new OpenAICompatProvider({
    id: env.REDGIANT_OPENAI_ID ?? "local",
    baseURL: env.REDGIANT_OPENAI_BASE_URL,
    ...(env.OPENAI_API_KEY && { apiKey: env.OPENAI_API_KEY }),
  });
  await local
    .discover()
    .catch((err) =>
      console.warn(`Could not list models at ${env.REDGIANT_OPENAI_BASE_URL}: ${err}`),
    );
  providers.register(local);
  if (env.OPENAI_API_KEY) redactor.addSecret("openai", env.OPENAI_API_KEY);
}

const [provider, ...model] = (env.REDGIANT_DEFAULT_MODEL ?? "").split("/");
const defaultModel: ModelSpec | undefined =
  provider && model.length ? { provider, model: model.join("/") } : undefined;

const sandbox =
  env.REDGIANT_SANDBOX === "docker"
    ? new DockerSandboxProvider({
        image: env.REDGIANT_SANDBOX_IMAGE ?? "redgiant/sandbox:latest",
        network: env.REDGIANT_SANDBOX_NETWORK ?? "redgiant-sandbox",
        ...(env.REDGIANT_EGRESS_URL && { egressProxyUrl: env.REDGIANT_EGRESS_URL }),
        ...(env.REDGIANT_SANDBOX_USER && { user: env.REDGIANT_SANDBOX_USER }),
        // In the official image the data lives in a named volume (see compose.yaml).
        ...(env.REDGIANT_DATA_VOLUME && {
          dataVolume: { name: env.REDGIANT_DATA_VOLUME, mountPoint: dataDir },
        }),
      })
    : new HostSandboxProvider();

// `memory:` is an in-process Postgres that vanishes on exit: for trial copies (G14) and demos.
const databaseUrl = need("DATABASE_URL");
// God on the real system (G14.3) and God's changes to RedGiant's own code (G14.2).
const metal = env.REDGIANT_METAL === "1";
let restart: (() => void) | undefined;
const source = env.REDGIANT_SOURCE_DIR
  ? {
      dir: resolve(env.REDGIANT_SOURCE_DIR),
      stateDir: resolve(env.REDGIANT_STATE_DIR ?? join(dataDir, "release")),
      // Only a supervised server may restart onto new code: the supervisor rolls back.
      ...(env.REDGIANT_SUPERVISED === "1" && { restart: () => restart?.() }),
    }
  : undefined;

const db =
  databaseUrl === "memory:"
    ? await memoryDb()
    : pgPoolClient(new pg.Pool({ connectionString: databaseUrl }));
const core = await RedGiantCore.create({
  db,
  providers,
  workspacesDir: join(dataDir, "workspaces"),
  platformDir: join(dataDir, "platform"),
  sandbox,
  redactor,
  ...(defaultModel && { defaultModel }),
  ...(env.REDGIANT_SEARXNG_URL && { search: new SearxngSearch(env.REDGIANT_SEARXNG_URL) }),
  // Voice messages: whisper-asr-webservice by URL, or an OpenAI-compatible transcription API.
  ...(env.REDGIANT_WHISPER_URL && {
    transcription: {
      api: env.REDGIANT_WHISPER_API === "openai" ? ("openai" as const) : ("whisper-asr" as const),
      url: env.REDGIANT_WHISPER_URL,
      ...(env.REDGIANT_WHISPER_MODEL && { model: env.REDGIANT_WHISPER_MODEL }),
      ...(env.REDGIANT_WHISPER_KEY && { key: env.REDGIANT_WHISPER_KEY }),
    },
  }),
  ...(env.REDGIANT_OPENAI_IMAGES_KEY && {
    images: {
      key: env.REDGIANT_OPENAI_IMAGES_KEY,
      ...(env.REDGIANT_IMAGES_MODEL && { model: env.REDGIANT_IMAGES_MODEL }),
    },
  }),
  ...(metal && { metal }),
  ...(source && { source }),
});
// Demi-God on Telegram: polling by default (works behind NAT), webhook when a secret is set.
// The holder is shared with the HTTP app, so the setup wizard can start the bot later.
const telegram: { gateway?: TelegramGateway; webhookSecret?: string } = {
  ...(env.REDGIANT_TELEGRAM_WEBHOOK_SECRET && {
    webhookSecret: env.REDGIANT_TELEGRAM_WEBHOOK_SECRET,
  }),
};
const owner = env.REDGIANT_OWNER ?? "local";
const docker = sandbox.kind === "docker" ? new Docker() : undefined;
const hooks = runtimeHooks({
  dataDir,
  core,
  providers,
  db,
  redactor,
  telegram,
  // The wizard can start a local engine container next to RedGiant (Docker installs).
  ...(docker &&
    env.REDGIANT_ENGINE_NETWORK && {
      engine: {
        docker,
        image: {
          cpu: env.REDGIANT_ENGINE_IMAGE ?? "ghcr.io/frostmoore/redgiant2-engine:cpu",
          cuda: env.REDGIANT_ENGINE_CUDA_IMAGE ?? "ghcr.io/frostmoore/redgiant2-engine:cuda",
        },
        network: env.REDGIANT_ENGINE_NETWORK,
        modelsVolume: env.REDGIANT_MODELS_VOLUME ?? "redgiant-models",
        kvVolume: env.REDGIANT_KV_VOLUME ?? "redgiant-kv",
        kvDir: env.REDGIANT_KV_DIR ?? "/kv",
      },
    }),
});
const tgToken =
  env.REDGIANT_TELEGRAM_TOKEN ??
  (env.REDGIANT_TELEGRAM_TOKEN_FILE
    ? (await readFile(env.REDGIANT_TELEGRAM_TOKEN_FILE, "utf8")).trim()
    : undefined);
if (tgToken) {
  const me = await hooks.telegram(tgToken);
  console.log(`Telegram bot @${me?.username} (${telegram.webhookSecret ? "webhook" : "polling"})`);
}
shutdownHooks.push(async () => void (await telegram.gateway?.stop()));

// The setup wizard (G17): what it set is applied again at every start; the environment wins.
const setup = new SetupService({
  db,
  core,
  dataDir,
  ownerId: owner,
  hooks,
  locked: {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.REDGIANT_OPENAI_BASE_URL),
    telegram: Boolean(tgToken),
    defaultModel: Boolean(defaultModel),
    search: Boolean(env.REDGIANT_SEARXNG_URL),
    engine: Boolean(env.REDGIANT_LLAMACPP_URL),
    voice: Boolean(env.REDGIANT_WHISPER_URL),
    images: Boolean(env.REDGIANT_OPENAI_IMAGES_KEY),
  },
});
await setup.applyAtStartup();
// Claude on a flat subscription from the environment (the wizard's choice otherwise).
if (env.REDGIANT_CLAUDE_SUBSCRIPTION_TOKEN)
  await hooks.claudeSubscription?.(env.REDGIANT_CLAUDE_SUBSCRIPTION_TOKEN);
shutdownHooks.push(async () => setup.stop());
const modelsDir = env.REDGIANT_MODELS_DIR ?? join(dataDir, "models");

const running = await serve(core, new TokenAuth({ [token]: owner }), {
  port: Number(env.REDGIANT_PORT ?? 7600),
  host: env.REDGIANT_HOST ?? "0.0.0.0",
  telegram,
  setup,
  hf: new HuggingFace(modelsDir),
  webDir: env.REDGIANT_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
console.log(`RedGiant listening on ${running.url} (sandbox: ${sandbox.kind})`);
if (metal)
  console.warn("WARNING: metal mode: God works directly on this system (every change asks you).");
if (sandbox.kind === "host")
  console.warn("WARNING: host sandbox: agents run commands directly on this system, unisolated.");
await core.automations.start();
core.inspector.start();
// What the supervisor does (promotions, rollbacks) goes into the log and reaches the owner.
core.code?.watch();
const shutdown = async () => {
  for (const h of shutdownHooks) await h().catch(() => {});
  await running.close();
};
restart = () => void shutdown().finally(() => process.exit(RESTART_EXIT_CODE));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown().finally(() => process.exit(0)));
}
