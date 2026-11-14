#!/usr/bin/env node
// RedGiant server. Configured by environment variables until the setup wizard (G17) exists.
import { readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KvStore, LocalEngineProvider } from "@redgiant/engine-local";
import { pgPoolClient, Redactor, type SqlClient } from "@redgiant/events";
import type { ModelSpec } from "@redgiant/protocol";
import {
  AnthropicProvider,
  LOCAL_STALL,
  OpenAICompatProvider,
  ProviderRegistry,
  setStallLog,
} from "@redgiant/providers";
import { DockerSandboxProvider, HostSandboxProvider } from "@redgiant/sandbox";
import { RESTART_EXIT_CODE } from "@redgiant/supervisor";
import type { TelegramGateway } from "@redgiant/telegram";
import { SearxngSearch } from "@redgiant/tools";
import Docker from "dockerode";
import pg from "pg";
import { TokenAuth } from "./auth.js";
import { Browsers, DockerBrowserLauncher, findBrowser, LocalBrowserLauncher } from "./browser.js";
import { ChatHub, Outlets } from "./chats.js";
import { RedGiantCore } from "./core.js";
import { debugLog } from "./debug-log.js";
import { localVaultEgress, routesFileEgress } from "./egress-routes.js";
import { startEmbeddedDatabase } from "./embedded-db.js";
import { firstAccessFromEnv, setupCodeRequired } from "./first-access.js";
import { FirstBoot } from "./firstboot.js";
import { backupScheduler } from "./firstboot-routes.js";
import { GitHosts } from "./git-hosts.js";
import { HuggingFace } from "./hf.js";
import { EmbeddingError, type KeyedFetch } from "./knowledge/embedders.js";
import { LocalEmbedServers } from "./knowledge/local-embed.js";
import { mailSource } from "./knowledge/mail.js";
import { LocalOcr } from "./knowledge/ocr.js";
import { ensurePgvector } from "./knowledge/pgvector.js";
import { KnowledgeService } from "./knowledge/service.js";
import { CatalogWatcher } from "./models-catalog.js";
import { NativeLauncher } from "./native-launcher.js";
import { osHelperFrom } from "./os-helper.js";
import { ensureGit } from "./portable-git.js";
import { backgroundPuller, runtimeHooks } from "./runtime.js";
import { serve } from "./serve.js";
import { SetupService } from "./setup.js";
import {
  installedVersion,
  installKind,
  rememberFirstVersion,
  safetyBackupBase,
  UpdateWatcher,
} from "./updates.js";
import { WIN_ENGINE_BUILD, WinEngine } from "./win-engine.js";

const env = process.env;

async function memoryDb(): Promise<SqlClient> {
  const { PGlite } = await import("@electric-sql/pglite");
  // pgvector for the knowledge (G36): the same 0.8.7 as the native Postgres.
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const pglite = await PGlite.create({ extensions: { vector } });
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
    // A server of one's own: probably a local engine, slow to read a long prompt (3.5.4).
    stall: LOCAL_STALL,
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

// Images RedGiant pulls on its own, as jobs with a progress bar (set once the core exists).
let puller: ReturnType<typeof backgroundPuller> | undefined;
const pullInBackground = (image: string, what: "sandbox" | "browser") => {
  if (!puller) throw new Error(`Cannot pull ${image} yet`);
  return puller(image, what);
};

const sandbox =
  env.REDGIANT_SANDBOX === "docker"
    ? new DockerSandboxProvider({
        image: env.REDGIANT_SANDBOX_IMAGE ?? "redgiant/sandbox:latest",
        // A missing image is pulled as a job, with its bar in the web page.
        pull: (image: string) => pullInBackground(image, "sandbox"),
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

// `embedded` (G30.1, RedGiant 3.0 on Windows): a real Postgres started here, in the data folder.
const embedded =
  databaseUrl === "embedded"
    ? await startEmbeddedDatabase(dataDir, (line) => console.error(line))
    : undefined;
const pool =
  databaseUrl === "memory:"
    ? undefined
    : new pg.Pool({ connectionString: embedded?.url ?? databaseUrl });
// An idle connection the database closes (a restart, the shutdown) must not take the server down.
pool?.on("error", (err) => console.warn(`database: ${err.message}`));
const db = pool ? pgPoolClient(pool) : await memoryDb();
// The keychain (G33.4): beside the data, never inside a git repository; credentials bound to tools
// reach the sandboxes through the egress proxy (Docker) or a proxy of the server's own (no Docker).
const vaultEgress =
  env.REDGIANT_EGRESS_ROUTES && env.REDGIANT_EGRESS_URL
    ? { egress: routesFileEgress(env.REDGIANT_EGRESS_ROUTES, env.REDGIANT_EGRESS_URL) }
    : env.REDGIANT_SANDBOX === "docker"
      ? undefined
      : await localVaultEgress().catch(() => undefined);
const core = await RedGiantCore.create({
  db,
  providers,
  vault: {
    dir: resolve(env.REDGIANT_VAULT_DIR ?? join(dataDir, "keychain")),
    ...(vaultEgress && { egress: vaultEgress.egress }),
  },
  workspacesDir: join(dataDir, "workspaces"),
  // Model calls in one turn nobody started (automations, tasks) when the person set none in
  // Settings (G36.15, 3.5.6); the person's own turns have no limit unless they set one.
  ...(Number(env.REDGIANT_MAX_TURNS) >= 1 && {
    maxTurns: Math.floor(Number(env.REDGIANT_MAX_TURNS)),
  }),
  // In the Docker image the sandboxes mount from the data volume only.
  ...(env.REDGIANT_SANDBOX === "docker" &&
    env.REDGIANT_DATA_VOLUME && { projectFoldersInside: join(dataDir, "workspaces") }),
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
// Docker for what RedGiant runs next to itself (engine, search, Pi-hole, Gitea, remote access):
// a Docker installation says so with its engine network, whatever runs the agents' commands
// (2.0.1: tying it to the sandbox left the engine without Docker once agents moved to host).
const docker = sandbox.kind === "docker" || env.REDGIANT_ENGINE_NETWORK ? new Docker() : undefined;
// The engine on Windows itself (G24.3b): RedGiant.exe runs it; the folder is shared through WSL.
// The folder alone is enough for what goes through files (updates from Settings, Windows' free
// RAM, moving models, the launcher's debug log): an empty address (2026-11-04: the distribution
// had no `ip` command) turned all of it off. The address is needed only to run the engine there.
// RedGiant 3.0 (G30.1): on Windows the server itself runs there, next to RedGiant.exe and its
// engine folder; the engine answers on this computer.
const nativeWindows = process.platform === "win32";
// On a Mac (2026-11-05) the same engine folder and files, with the launcher's part done here
// (native-launcher.ts): llama.cpp's macOS build with Metal, next to the server.
const nativeMac = process.platform === "darwin";
if (nativeMac)
  env.REDGIANT_WIN_ENGINE_DIR ??= join(
    homedir(),
    "Library",
    "Application Support",
    "RedGiant",
    "engine",
  );
const winEngine =
  env.REDGIANT_WIN_HOST || env.REDGIANT_HOST_ENGINE_DIR || nativeWindows || nativeMac
    ? new WinEngine({
        dir:
          env.REDGIANT_WIN_ENGINE_DIR ??
          (nativeWindows
            ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "RedGiant", "engine")
            : "/winengine"),
        host: env.REDGIANT_WIN_HOST ?? (nativeWindows || nativeMac ? "127.0.0.1" : ""),
      })
    : undefined;
if (nativeMac && winEngine) {
  const launcher = new NativeLauncher({ dir: winEngine.dir, build: WIN_ENGINE_BUILD });
  launcher.start();
  shutdownHooks.push(() => launcher.close());
}
// Debug mode (2026-11-04): before the engine and the setup start, so their start is logged too.
await debugLog.configure({
  dir: join(dataDir, "logs"),
  winDir: winEngine?.dir,
  forced: env.REDGIANT_DEBUG === "1",
});
// Every chat the person reads (Telegram and the others, G29.5) gets the core's messages.
const outlets = new Outlets(core);
const chats = new ChatHub(db, core, outlets);
shutdownHooks.push(() => chats.stop());
const hooks = runtimeHooks({
  dataDir,
  core,
  providers,
  db,
  redactor,
  telegram,
  outlets,
  chats,
  owner: () => owner,
  // The wizard can start a local engine container next to RedGiant (Docker installs).
  // On Windows' native install (G30.1) only the engine there: no Docker, no network.
  ...(((docker && env.REDGIANT_ENGINE_NETWORK) || winEngine) && {
    engine: {
      ...(docker && env.REDGIANT_ENGINE_NETWORK && { docker }),
      image: {
        cpu: env.REDGIANT_ENGINE_IMAGE ?? "ghcr.io/frostmoore/redgiant2-engine:cpu",
        cuda: env.REDGIANT_ENGINE_CUDA_IMAGE ?? "ghcr.io/frostmoore/redgiant2-engine:cuda",
        vulkan: env.REDGIANT_ENGINE_VULKAN_IMAGE ?? "ghcr.io/frostmoore/redgiant2-engine:vulkan",
        // «Next layer ahead» (G32.2): llama.cpp with RedGiant's patch, NVIDIA cards.
        cudaPrefetch:
          env.REDGIANT_ENGINE_CUDA_PREFETCH_IMAGE ??
          "ghcr.io/frostmoore/redgiant2-engine:cuda-prefetch",
      },
      gpuAccess: env.REDGIANT_ENGINE_GPU === "dri" ? "dri" : "",
      ...(winEngine && { windows: winEngine }),
      gitea: {
        ...(env.REDGIANT_GITEA_IMAGE && { image: env.REDGIANT_GITEA_IMAGE }),
        port: Number(env.REDGIANT_GITEA_PORT ?? 3000),
        bind: env.REDGIANT_GITEA_BIND ?? "127.0.0.1",
      },
      network: env.REDGIANT_ENGINE_NETWORK ?? "",
      modelsDir: env.REDGIANT_MODELS_DIR ?? "/models",
      modelsVolume: env.REDGIANT_MODELS_VOLUME ?? "redgiant-models",
      kvVolume: env.REDGIANT_KV_VOLUME ?? "redgiant-kv",
      kvDir: env.REDGIANT_KV_DIR ?? "/kv",
    },
  }),
});
if (docker) puller = backgroundPuller(docker, core.jobs, () => owner);
// The personal agents' browser (G24.14b). RedGiant 2.0 (G29.8): the Chrome, Chromium or Edge of
// this computer when there is one, with a profile of its own; the container only when asked
// (REDGIANT_BROWSER=docker) or when no browser is installed.
const localBrowser = env.REDGIANT_BROWSER !== "docker" ? findBrowser() : undefined;
if (localBrowser) {
  core.browsers = new Browsers(
    new LocalBrowserLauncher({
      executable: localBrowser,
      profilesDir: join(dataDir, "browser"),
      headless: env.REDGIANT_BROWSER_HEADLESS !== "0",
    }),
    { desk: (o) => core.assistantsPath(o) },
  );
  shutdownHooks.push(async () => void (await core.browsers?.shutdown()));
} else if (docker && env.REDGIANT_ENGINE_NETWORK) {
  core.browsers = new Browsers(
    new DockerBrowserLauncher({
      docker,
      // Its own network: a page cannot reach the database, the engine or Gitea.
      network: env.REDGIANT_BROWSER_NETWORK ?? "redgiant-browser",
      join: env.REDGIANT_SERVER_CONTAINER ?? hostname(),
      ...(env.REDGIANT_BROWSER_IMAGE && { image: env.REDGIANT_BROWSER_IMAGE }),
      pull: (image) => pullInBackground(image, "browser"),
    }),
    // Downloads land in the personal agents' desk.
    { desk: (o) => core.assistantsPath(o) },
  );
  shutdownHooks.push(async () => void (await core.browsers?.shutdown()));
}
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
// GitHub and Gitea (G24.5): their tokens become credential routes of the egress proxy.
const gitHosts = new GitHosts({
  ...(env.REDGIANT_EGRESS_ROUTES && { routesFile: env.REDGIANT_EGRESS_ROUTES }),
  ...(env.REDGIANT_EGRESS_URL && { egressUrl: env.REDGIANT_EGRESS_URL }),
});
// The OS helper (G39.3): root actions on the machine, when this installation has one.
const osHelper = osHelperFrom(env);
const setup = new SetupService({
  git: gitHosts,
  // The machine (G39.3): disks for backups, SSH, what reaches it; root actions through the OS helper.
  firstBoot: new FirstBoot({
    dataDir,
    hostDataDir: env.REDGIANT_HOST_DATA_DIR,
    helper: osHelper,
  }),
  db,
  core,
  dataDir,
  ownerId: owner,
  hooks,
  locked: {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    server: Boolean(env.REDGIANT_OPENAI_BASE_URL),
    telegram: Boolean(tgToken),
    defaultModel: Boolean(defaultModel),
    search: Boolean(env.REDGIANT_SEARXNG_URL),
    engine: Boolean(env.REDGIANT_LLAMACPP_URL),
    voice: Boolean(env.REDGIANT_WHISPER_URL),
    images: Boolean(env.REDGIANT_OPENAI_IMAGES_KEY),
  },
});
await setup.applyAtStartup();
// The keys the setup keeps are listed in the keychain too (names only), so there is one place.
core.vaultSystem = async () => setup.keysForVault();
if (vaultEgress && "close" in vaultEgress) shutdownHooks.push(() => vaultEgress.close());
// Claude on a flat subscription from the environment (the wizard's choice otherwise).
if (env.REDGIANT_CLAUDE_SUBSCRIPTION_TOKEN)
  await hooks.claudeSubscription?.(env.REDGIANT_CLAUDE_SUBSCRIPTION_TOKEN);
shutdownHooks.push(async () => setup.stop());
const modelsDir = env.REDGIANT_MODELS_DIR ?? join(dataDir, "models");

// The knowledge (G36): pgvector in this same database, models chosen by the person. Keys are put
// on by the server: the setup's provider key, or the keychain entry chosen in the page.
const knowledgeFetch =
  (who: string, provider: string, credential?: string): KeyedFetch =>
  async (url, init, key, signal) => {
    const base = { ...init, redirect: "manual" as const, ...(signal && { signal }) };
    if (!key) return fetch(url, base);
    if (credential)
      return core.vault.serviceFetch(
        who,
        credential,
        "knowledge",
        url,
        {
          ...init,
          headers: {
            ...init.headers,
            [key.header]: key.format.replace("{value}", `{{vault:${credential}}}`),
          },
        },
        signal,
      );
    const value = setup.providerKey(provider);
    if (!value)
      throw new EmbeddingError(
        "key_missing",
        `No key for ${provider}: add it in the setup or choose a keychain entry`,
      );
    return fetch(url, {
      ...base,
      headers: { ...init.headers, [key.header]: key.format.replace("{value}", value) },
    });
  };
const knowledge = new KnowledgeService({
  db,
  store: core.store,
  jobs: core.jobs,
  dataDir,
  forbidden: [
    resolve(env.REDGIANT_VAULT_DIR ?? join(dataDir, "keychain")),
    join(dataDir, "postgres"),
  ],
  local: new LocalEmbedServers({ dataDir, jobs: core.jobs }),
  keyedFetch: knowledgeFetch,
  scopeRoot: (who, scope) => core.scopeFolder(who, scope),
  places: (who) => core.knowledgePlaces(who),
  // G36.6: the OCR on this computer, the person's mailboxes and conversations (sources they add
  // themselves, with their yes), and the projects an agent works on.
  ocr: new LocalOcr({ dataDir, jobs: core.jobs }),
  mail: mailSource(core.email),
  chats: core.knowledgeChats(),
  agentProjects: async (_who, agentId) => {
    const a = core.registry.get(agentId);
    return a?.projectId ? [a.projectId] : [];
  },
  agentKind: (_who, agentId) => core.registry.get(agentId)?.kind,
  agentLanguage: () => core.agentLanguageOf(owner) ?? core.uiLanguageOf(owner),
  // Office files read through the PDF LibreOffice makes, only when it is already here.
  officePdf: async (who, abs, signal) =>
    core.programs.find("libreoffice")
      ? core.converter.preview(dirname(abs), basename(abs), { owner: who, signal })
      : undefined,
});
await knowledge.start();
core.knowledge = knowledge;
shutdownHooks.push(() => knowledge.stop());
// From the sources (Linux, development) pgvector is not in a package: it comes down once.
if (embedded && !embedded.pgvector)
  void ensurePgvector(core.jobs, owner, dataDir)
    .then(async (dir) => {
      await embedded.setPgvector(dir);
      await knowledge.vectorArrived();
    })
    .catch((err) => console.warn(`pgvector: ${(err as Error).message}`));

const running = await serve(core, new TokenAuth({ [token]: owner }), {
  port: Number(env.REDGIANT_PORT ?? 7600),
  host: env.REDGIANT_HOST ?? "0.0.0.0",
  telegram,
  chats,
  setup,
  hf: new HuggingFace(modelsDir),
  ...(winEngine && { winHf: new HuggingFace(winEngine.modelsDir) }),
  loginOwner: owner,
  // Who may create the first access (G39.7): the local network, or anywhere when allowed.
  firstAccessFrom: firstAccessFromEnv(env.REDGIANT_FIRST_ACCESS),
  webDir: env.REDGIANT_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
console.log(`RedGiant listening on ${running.url} (sandbox: ${sandbox.kind})`);
// A first start without a screen (G39.7): the address to open from another device of the
// network, where the page creates the access. The one-time code of G39.3 only when asked for
// (REDGIANT_SETUP_CODE=1, a network the administrator does not trust).
await setup
  .startSetupCode(
    Number(env.REDGIANT_PORT ?? 7600),
    (await core.logins.status(owner)).password,
    setupCodeRequired(env.REDGIANT_SETUP_CODE),
  )
  .catch((err) => console.warn(`setup code: ${(err as Error).message}`));
// Scheduled backups (G39.3) into the destination chosen in the wizard or Settings › System.
setup.scheduler = backupScheduler(core, setup, owner, () => installedVersion(env));
setup.scheduler.start();
shutdownHooks.push(async () => setup.scheduler?.stop());
// Where the `redgiant` command line finds this server (G36.15); its token is the app's token.txt.
await writeFile(
  join(dataDir, "address.txt"),
  `${running.url.replace("//0.0.0.0:", "//127.0.0.1:")}\n`,
).catch(() => {});
if (metal)
  console.warn("WARNING: metal mode: God works directly on this system (every change asks you).");
if (sandbox.kind === "host")
  console.log(
    "Agents work in their projects' folders on this system; the guardian asks before they write elsewhere (Settings, Safety).",
  );
// Mandatory and breaking updates (G36.19): at start and every few hours, from the release's
// signed release.json. Before the automations start, so a held RedGiant runs none.
{
  const install = nativeWindows ? "windows" : nativeMac ? "mac" : installKind(env);
  const updates = new UpdateWatcher({
    install,
    installed: installedVersion(env),
    // An update or a new installation, for the page's «what is new» (an installation that
    // already had a password or a completed wizard was there before).
    firstVersion: await rememberFirstVersion(
      dataDir,
      installedVersion(env),
      setup.completed || (await core.logins.status(owner)).password,
    ),
    dataDir,
    backupBase: safetyBackupBase(install, dataDir, env),
    ...(env.REDGIANT_UPDATE_FEED && { feed: env.REDGIANT_UPDATE_FEED }),
    ...(env.REDGIANT_HOME && { composeDir: env.REDGIANT_HOME }),
    launcher: nativeWindows && !!winEngine,
    osUpdater: install === "os" && !!osHelper,
    act: async (action) => {
      if (nativeWindows && winEngine) {
        await winEngine.updateAction(action);
        return true;
      }
      // RedGiant OS (G39.1): its signed updater, in the background (it restarts this server);
      // the page follows it through /api/setup/os-updates.
      if (install === "os" && osHelper && action === "update") {
        await osHelper.call({ op: "os-update-apply" });
        return true;
      }
      // The Mac app watches the data folder for this (RedGiant.swift).
      if (nativeMac && action === "quit") {
        await writeFile(
          join(dataDir, "quit-request.json"),
          `${JSON.stringify({ at: Date.now() })}\n`,
        );
        return true;
      }
      return false;
    },
  });
  core.updates = updates;
  if (env.REDGIANT_UPDATE_CHECK !== "0") updates.start();
  shutdownHooks.push(async () => updates.stop());
}
// The models catalog (3.5.4): the signed copy kept from an earlier run, then GitHub's newest,
// at start and every day. A provider that stops answering leaves a line here for every try.
setStallLog((line) => {
  console.warn(line);
  debugLog.write("provider", line);
});
{
  const catalog = new CatalogWatcher({
    dataDir,
    ...(env.REDGIANT_MODELS_CATALOG_URL && {
      sources: [
        { url: env.REDGIANT_MODELS_CATALOG_URL, sig: `${env.REDGIANT_MODELS_CATALOG_URL}.sig` },
      ],
    }),
  });
  core.catalog = catalog;
  if (env.REDGIANT_MODELS_CATALOG !== "0") await catalog.start();
  else await catalog.loadStored();
  shutdownHooks.push(async () => catalog.stop());
}
await core.automations.start();
// Windows without Git (RedGiant 3.0): the portable one comes down once, with its bar.
void ensureGit(core.jobs, owner, dataDir).catch((err) =>
  console.warn(`git: ${(err as Error).message}`),
);
core.inspector.start();
core.email.start();
// Routines on files that change in a project's folder (G33.3).
core.files.start();
// What the supervisor does (promotions, rollbacks) goes into the log and reaches the owner.
core.code?.watch();
/** At most `ms` waiting for `p`; then the stop goes on without it. */
const within = (p: Promise<unknown>, ms: number) =>
  Promise.race([p, new Promise<void>((done) => setTimeout(done, ms).unref())]);
const shutdown = async () => {
  // Everything but the database gets 15 s (2026-11-05): RedGiant.exe kills the server after 30 s,
  // and a stop that hung past them left Postgres running. The database is always stopped.
  await within(
    (async () => {
      for (const h of shutdownHooks) await h().catch(() => {});
      await running.close();
    })(),
    15_000,
  );
  // The database last: everything above may still write to it.
  if (embedded) {
    await pool?.end().catch(() => {});
    await embedded.stop().catch((err) => console.warn(`database stop: ${(err as Error).message}`));
  }
};
restart = () => void shutdown().finally(() => process.exit(RESTART_EXIT_CODE));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown().finally(() => process.exit(0)));
}
// RedGiant.exe on Windows (G30.2) has no signals to send: it closes our input to say "stop", so
// Postgres is stopped too instead of being left running.
if (env.REDGIANT_STOP_ON_STDIN_END === "1") {
  process.stdin.on("end", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.resume();
}
