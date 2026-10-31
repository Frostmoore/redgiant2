#!/usr/bin/env node
// RedGiant server. Configured by environment variables until the setup wizard (G17) exists.
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KvStore, LocalEngineProvider } from "@redgiant/engine-local";
import { pgPoolClient, Redactor } from "@redgiant/events";
import type { ModelSpec } from "@redgiant/protocol";
import { AnthropicProvider, OpenAICompatProvider, ProviderRegistry } from "@redgiant/providers";
import { DockerSandboxProvider, HostSandboxProvider } from "@redgiant/sandbox";
import { SearxngSearch } from "@redgiant/tools";
import pg from "pg";
import { TokenAuth } from "./auth.js";
import { RedGiantCore } from "./core.js";
import { serve } from "./serve.js";

const env = process.env;
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
      })
    : new HostSandboxProvider();

const core = await RedGiantCore.create({
  db: pgPoolClient(new pg.Pool({ connectionString: need("DATABASE_URL") })),
  providers,
  workspacesDir: join(dataDir, "workspaces"),
  platformDir: join(dataDir, "platform"),
  sandbox,
  redactor,
  ...(defaultModel && { defaultModel }),
  ...(env.REDGIANT_SEARXNG_URL && { search: new SearxngSearch(env.REDGIANT_SEARXNG_URL) }),
});
const running = await serve(core, new TokenAuth({ [token]: env.REDGIANT_OWNER ?? "local" }), {
  port: Number(env.REDGIANT_PORT ?? 7600),
  host: env.REDGIANT_HOST ?? "0.0.0.0",
  webDir: env.REDGIANT_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
console.log(`RedGiant listening on ${running.url} (sandbox: ${sandbox.kind})`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    for (const h of shutdownHooks) await h().catch(() => {});
    await running.close();
    process.exit(0);
  });
}
