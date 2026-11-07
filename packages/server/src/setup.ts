import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";
import type { Platform } from "@redgiant/gateway";
import { DEFAULT_POLICY } from "@redgiant/hierarchy";
import type { Job, VaultSystemEntry } from "@redgiant/protocol";
import {
  agentLanguage,
  keyProvider,
  MEDIA_PROVIDERS,
  type MediaChoice,
  type MediaKind,
  type ModelSpec,
  mediaProvider,
  OWN_SERVER_ID,
  type SearchProviderId,
} from "@redgiant/protocol";
import { complete, ProviderError } from "@redgiant/providers";
import {
  type ClaudeAccount,
  ClaudeLogin,
  ClaudeLoginError,
  type ClaudeLoginOptions,
  claudeAccount,
  claudeLogout,
} from "@redgiant/subscriptions";
import { searchProvider } from "@redgiant/tools";
import { stringify } from "yaml";
import type { RedGiantCore } from "./core.js";
import { debugLog } from "./debug-log.js";
import { freePort } from "./embedded-db.js";
import { ensureFfmpeg } from "./ffmpeg.js";
import { GitHostError, type GitHosts, type GitHostsConfig } from "./git-hosts.js";
import { detectHardware, type EngineVariant, type Hardware } from "./hardware.js";
import { IMAGE_MODEL } from "./images.js";
import { JobFailure, type JobHandle } from "./jobs.js";
import { LocalWhisper } from "./local-voice.js";
import { elevenVoices } from "./media.js";
import type { MoePrefetchState } from "./moe-prefetch.js";
import { defaultTemplate, toPlaceholders } from "./prompts.js";
import { REMOTE_STEPS, type RemoteRequest } from "./remote.js";
import { BIG_BATCHES, type EnginePlan, MOE_BATCH } from "./stream.js";

/** Applies a choice while the server runs (set by main.ts; tests pass fakes). */
export interface SetupHooks {
  /**
   * Registers a provider of the catalog (`KEY_PROVIDERS`) with this key, after checking it;
   * returns its models. null removes it.
   */
  key(id: string, key: string | null): Promise<string[]>;
  /** Registers the user's own OpenAI-compatible server; returns the models it offers. */
  server(o: { baseUrl: string; key?: string | undefined } | null): Promise<string[]>;
  /** Starts Demi-God's bot (null stops it); returns the bot's username. */
  telegram(token: string | null): Promise<{ username: string } | null>;
  /** Starts Demi-God on Discord, Slack, Signal or WhatsApp (null stops it), G29.5. */
  chat?(platform: Platform, settings: Record<string, string> | null): Promise<void>;
  /** The web search service for models that cannot search by themselves (null: none). */
  search(c: SearchChoice | null): Promise<void>;
  /** Claude on a flat subscription (G21): its token, "" for the login already in its folder, null off. */
  claudeSubscription?(token: string | null): Promise<void>;
  /** Where Claude's engine keeps its login, for signing in from the browser (G24.2). */
  claudeAuth?(): ClaudeLoginOptions;
  /** ChatGPT on a flat subscription (G21): its login lives in Codex's own folder. */
  chatgptSubscription?(on: boolean): Promise<void>;
  /** Finds or downloads a subscription's program (2026-11-05), with its bar. */
  prepareTool?(name: "codex" | "claude"): Promise<void>;
  /** Whether that program is here, and whether the person's own sign-in is used. */
  toolStatus?(name: "codex" | "claude"): {
    program: "bundled" | "downloaded" | "system" | null;
    sharedLogin: boolean;
  };
  /**
   * Starts the local engine container with this model file (null stops it); with a job, it
   * reports its steps (`image`, `start`, `load`) and throws `JobFailure`s the UI explains.
   */
  engine(o: EngineConfig | null, h?: JobHandle): Promise<void | EnginePlan>;
  dockerRuntimes?(): Promise<string[]>;
  /** Model files inside WSL that the engine on Windows could run instead (2026-11-04). */
  /** Moves them to the engine on Windows' folder (a job's progress in bytes). */
  /** After the local model stops: gives its memory back to the system (Windows: WSL's cache). */
  releaseMemory?(): Promise<void>;
  /**
   * Gitea, the code server of one's own (G24.5): started (or found running) with an admin of
   * this name and password; returns a token for RedGiant. null stops it (the repositories stay).
   */
  gitea?(
    o: { user: string; password: string } | null,
    h?: JobHandle,
  ): Promise<{ token: string; publicUrl: string } | null>;
  /**
   * SearXNG run by RedGiant (2026-11-03): a search engine of one's own for the models that
   * cannot search by themselves (local ones). false stops it.
   */
  searxng?(on: boolean, h?: JobHandle): Promise<{ url: string } | null>;
  /**
   * Moves the models to another disk (Windows, 2026-11-03): the Windows engine's folder, or
   * the whole distribution for the engines in Docker. Only where RedGiant.exe can do it.
   */
  moveModels?(kind: "models", to: string, h?: JobHandle): Promise<void>;
  /**
   * Whether this version's release has llama.cpp with the «next layer ahead» patch (G32.2);
   * null where it has nothing to do (not Windows, or no NVIDIA card).
   */
  moePrefetchBinaries?(): Promise<MoePrefetchState>;
  /**
   * The same for the engines in Docker (Linux with Docker's NVIDIA runtime): whether the patched
   * image (`redgiant2-engine:cuda-prefetch`) is here or in the registry; null where it does not apply.
   */
  moePrefetchImage?(): Promise<MoePrefetchState>;
  /** Asks RedGiant.exe to look for a newer version now (Windows); null where it cannot. */
  checkUpdate?(): Promise<{ state: string; version: string } | null>;
  /** A way to reach RedGiant from outside home (G24.6); null switches every way off. */
  remote?(req: RemoteRequest | null, h?: JobHandle): Promise<{ url: string } | null>;
  /**
   * Pi-hole, the home's own DNS (G24.14c, by choice): the domain answers with the server's
   * address at home, ads and trackers are blocked. null stops it (its settings stay).
   */
  pihole?(
    o: { lanIp: string; domain?: string; password: string } | null,
    h?: JobHandle,
  ): Promise<{ adminUrl: string } | null>;
}

/** One try of the SSD stream's tuning, as the engine page shows it. */
export interface Trial {
  share: number;
  /** false: the try without sending the experts to the card to read a context. */
  opOffload?: boolean;
  /** Tokens a pass, for the tries of bigger passes (G32.1); absent: 4096. */
  batch?: number;
  /** Tokens of the long message those tries read (their `turnS` reads it instead of 1,500). */
  readTokens?: number;
  ctx: number;
  cacheMib: number;
  state: "running" | "done" | "failed";
  genTps?: number;
  prefillTps?: number;
  /** Seconds of a typical agent's turn with this setting (`typicalTurn`). */
  turnS?: number;
  chosen?: boolean;
  error?: string;
}

/**
 * How long a typical agent's turn takes (2026-11-05): reading what the tools gave back (about
 * 1,500 tokens) and writing the answer (about 300). One column alone chose wrong: on Rig the try
 * that read slower wrote almost twice as fast (gpt-oss 120B, 13.4 against 7.8 tokens a second).
 */
export const TURN_READ = 1500;
export const TURN_WRITE = 300;
export function typicalTurn(
  t: { prefillTps?: number; genTps?: number },
  read: number = TURN_READ,
): number | undefined {
  if (!t.prefillTps || !t.genTps) return undefined;
  return Math.round((read / t.prefillTps + TURN_WRITE / t.genTps) * 10) / 10;
}

/**
 * The bigger passes the tuning tries (G32.1) and how long the message it reads is: as long as
 * the biggest pass, or a pass of 16384 would read the same as one of 8192; never past the
 * context (a thousand tokens left for the answer and the template).
 */
export function batchTrials(plan: { ctx: number; bigBatches?: number[] | undefined } | undefined): {
  batches: number[];
  read: number;
} {
  const ctx = plan?.ctx ?? 0;
  const batches = (plan?.bigBatches ?? []).filter((b) => b <= ctx);
  if (batches.length === 0) return { batches: [], read: 0 };
  return { batches, read: Math.min(Math.max(...batches), ctx - 1024) };
}

/** The fastest try for a typical turn; the first one when none finished. */
export function fastestTrial<T extends { state: string; turnS?: number }>(
  trials: T[],
): T | undefined {
  const done = trials.filter((x) => x.state === "done" && x.turnS !== undefined);
  return done.sort((a, b) => (a.turnS ?? 0) - (b.turnS ?? 0))[0] ?? trials[0];
}

/** One configuration tried by a speed test (2026-11-04): how fast it wrote each kind of text. */
export interface SpeedTrial {
  /** `none`, `draft`, `ngram` (speculative decoding); later the sparsity presets. */
  mode: string;
  state: "waiting" | "running" | "done" | "failed" | "skipped";
  /** Tokens a second writing new prose, and rewriting a piece of code. */
  proseTps?: number;
  codeTps?: number;
  error?: string;
}

/** The two texts of a speed test: new prose, and code rewritten (where proposals hit most). */
const SPEED_PROSE = "Explain how a refrigerator works to a curious teenager, in about 120 words.";
const SPEED_CODE = `Rewrite this Python function exactly, renaming 'items' to 'products' everywhere and changing nothing else.

def total_price(items, tax_rate):
    subtotal = 0
    for item in items:
        if item.get('quantity', 0) <= 0:
            continue
        price = item['price'] * item['quantity']
        if item.get('discount'):
            price = price * (1 - item['discount'])
        subtotal += price
    tax = subtotal * tax_rate
    shipping = 0 if subtotal > 50 else 5.99
    return {'items': len(items), 'subtotal': round(subtotal, 2), 'tax': round(tax, 2), 'total': round(subtotal + tax + shipping, 2)}`;

/** A web search service with what it needs (2026-11-03). */
export interface SearchChoice {
  provider: SearchProviderId;
  url?: string;
  key?: string;
}

/**
 * The local engine: its build, the model file, and SSD streaming (2026-11-03) with its plan
 * as the last start computed it and the tuning that changes it.
 */
export interface EngineConfig {
  variant: EngineVariant;
  model: string;
  stream?: boolean | undefined;
  tuning?:
    | {
        moeCacheShare?: number | undefined;
        opOffload?: boolean | undefined;
        /** Tokens a pass the tuning chose with `bigChunks` (G32.1). */
        batch?: number | undefined;
      }
    | undefined;
  /**
   * Bigger reading passes (G32.1, experimental, off by default): with SSD stream, the tuning
   * also tries passes of 8192 and 16384 tokens when the card has room, and keeps the fastest;
   * the weights are loaded in RAM instead of mapped when they fit with a margin.
   */
  bigChunks?: boolean | undefined;
  /**
   * «Next layer ahead» (G32.2, experimental, off by default): with an NVIDIA card, llama.cpp with
   * RedGiant's patch (its own download: the zip of RedGiant's release on Windows, the image
   * `redgiant2-engine:cuda-prefetch` in Docker) copies the next experts to the card while it
   * computes; the weights are loaded in RAM when they fit. Used only with SSD stream and where that
   * build exists (`SetupState.moePrefetch` for Windows, `moePrefetchImage` for Docker).
   */
  moePrefetch?: boolean | undefined;
  /** The tries that chose `tuning` (2026-11-05): shown again, and another can be picked. */
  trials?: Trial[] | undefined;
  plan?: EnginePlan | undefined;
  /**
   * Speculative decoding (2026-11-04, an option for power users): `draft` a small model of the
   * same family (`draftModel`, a file in the models folder) proposes tokens the big one checks
   * in one pass; `ngram` the proposals come from the text already written.
   */
  speculative?: "draft" | "ngram" | undefined;
  draftModel?: string | undefined;
  /**
   * Turned off by the person (2026-11-04): kept with its tuning, but not started when RedGiant
   * opens and using no memory until it is turned on again.
   */
  off?: boolean | undefined;
}

export interface SetupConfig {
  completed: boolean;
  /** The interface's language (and the wizard's). */
  language?: "it" | "en";
  /**
   * The language the agents speak to the person (G33.5): a BCP-47 code of `AGENT_LANGUAGES`.
   * Installations from before keep the interface's language (`migrate`).
   */
  agentLanguage?: string;
  /** The person's instructions for every agent (2026-11-05), part of each one's system prompt. */
  instructions?: string;
  /** Tries again a task an agent gave up on (2026-11-05), best from another provider. */
  backupModel?: ModelSpec;
  defaultModel?: ModelSpec;
  /** Providers connected with a key (the keys are in the secrets). */
  keyProviders?: string[];
  /** The user's own OpenAI-compatible server (its key, if any, is in the secrets). */
  server?: { baseUrl: string };
  searxngUrl?: string;
  /**
   * The search service chosen (2026-11-03); none chosen: SearXNG when its address is set.
   * Its key, for those that need one, is among the secrets.
   */
  searchProvider?: SearchProviderId;
  /** The search engine is the one RedGiant runs itself (started again at each start). */
  searxngManaged?: boolean;
  /** The person switched RedGiant's search engine off: it is not started by itself again. */
  searxngDeclined?: boolean;
  /** Speech to text for voice messages; its key, if any, is in the secrets. */
  transcription?: { api: "whisper-asr" | "openai" | "local"; url: string; model?: string };
  /** Flat subscriptions switched on (their tokens are in the secrets). */
  subscriptions?: { claude?: boolean; chatgpt?: boolean };
  /** Image generation: the model, when not the default (the OpenAI key is in the secrets). */
  imagesModel?: string;
  /** Who makes pictures, videos and sounds (G25.3), by kind. */
  media?: Partial<Record<MediaKind, MediaChoice>>;
  engine?: EngineConfig;
  retentionDays?: number;
  /** The user read that a personal subscription may not be allowed in third-party tools (RD23). */
  subscriptionAck?: boolean;
  /** Standard (everything ready, nothing reachable from outside) or advanced (G24.5). */
  mode?: "standard" | "advanced";
  /** Where the code lives: GitHub and/or Gitea (their tokens are in the secrets). */
  git?: GitHostsConfig;
  /** How RedGiant is reached from outside home, and at which address (G24.6). */
  remote?: { way: RemoteRequest["way"]; url: string };
  /** Pi-hole, when chosen (its admin password is in the secrets). */
  pihole?: { lanIp: string; domain?: string; adminUrl: string };
}

interface Secrets {
  /** Keys of the providers in `KEY_PROVIDERS`, by id. */
  keys?: Record<string, string>;
  /** Keys of the media providers (`MEDIA_PROVIDERS`), when not the chat provider's one. */
  mediaKeys?: Record<string, string>;
  serverKey?: string;
  telegramToken?: string;
  /** Discord, Slack, Signal, WhatsApp settings with their tokens (G29.5). */
  chats?: Partial<Record<Platform, Record<string, string>>>;
  transcriptionKey?: string;
  openaiImagesKey?: string;
  claudeSubscriptionToken?: string;
  githubToken?: string;
  giteaToken?: string;
  piholePassword?: string;
  /** Keys of the web search services, by id (Brave, Tavily, Exa, Serper). */
  searchKeys?: Record<string, string>;
  cloudflareToken?: string;
}

/** What the environment already sets: the wizard shows it and does not change it. */
export interface Locked {
  anthropic?: boolean;
  server?: boolean;
  telegram?: boolean;
  defaultModel?: boolean;
  search?: boolean;
  engine?: boolean;
  voice?: boolean;
  images?: boolean;
}

/** How services are written, for the keychain's list. */
const SERVICE_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  gemini: "Gemini",
  google: "Google",
  elevenlabs: "ElevenLabs",
  whatsapp: "WhatsApp",
  brave: "Brave Search",
  tavily: "Tavily",
  exa: "Exa",
  serper: "Serper",
};

export interface SetupState {
  config: SetupConfig;
  /** Model files inside WSL that the engine on Windows could run instead (2026-11-04). */
  secretsSet: {
    /** Providers with a saved key. */
    keys: string[];
    server: boolean;
    telegram: boolean;
    /** Chat platforms set up besides Telegram (G29.5). */
    chats: Platform[];
    transcription: boolean;
    images: boolean;
    /** Media providers with a key (their own, or the chat key they share). */
    media: string[];
    claudeSubscription: boolean;
    github: boolean;
    gitea: boolean;
    /** Web search services with a saved key. */
    search: string[];
  };
  locked: Locked;
  providers: string[];
  hardware: Hardware;
  names: {
    god: string | null;
    demigod: string | null;
    godPrompt: string | null;
    godPromptTemplate: string;
  };
  policy: {
    humanOnly: string[];
    disabledDanger: string[];
    /** The guardian (2026-11-04): ask before writing outside the project, or let it be. */
    guardian: "ask" | "auto";
    /** Skills written by agents (G29.4): wait for the human, or install once tested. */
    skills: "ask" | "auto";
    dangers: { id: string }[];
  };
  budgetUsd: number | null;
  /** RedGiant can run its own search engine here (SearXNG in Docker). */
  canRunSearch: boolean;
  /** The «next layer ahead» build for this version (G32.2): null where it does not apply. */
  moePrefetch: MoePrefetchState;
  /** The same for the `cuda` engine in Docker (Linux): the patched image. null where it does not apply. */
  moePrefetchImage: MoePrefetchState;
}

export class SetupError extends Error {
  /** A code the UI explains in plain words (`key_rejected`, `unreachable`…). */
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function asSetupError(err: unknown): SetupError {
  if (err instanceof ClaudeLoginError) return new SetupError(err.message, err.code);
  return err instanceof SetupError ? err : new SetupError((err as Error).message);
}

/** Why a provider could not be connected, in a code the UI explains. */
function connectError(name: string, err: unknown): SetupError {
  const status = err instanceof ProviderError ? err.status : undefined;
  // Gemini answers 400 to a wrong key.
  if (status === 400 || status === 401 || status === 403)
    return new SetupError(`${name} refused the key: ${(err as Error).message}`, "key_rejected");
  return new SetupError(`${name} did not answer: ${(err as Error).message}`, "unreachable");
}

const DAY = 86_400_000;

/**
 * The first-run wizard's backend (G17): every step is applied at once and saved — secrets in
 * a file only the server reads (never in the database or its dumps), the rest in Postgres and
 * in a readable `redgiant.yaml`.
 */
/** Providers in the order their models are preferred as the first default. */
const PREFERRED = ["claude-subscription", "anthropic", "chatgpt-subscription", "openai", "gemini"];

/**
 * The model that becomes the default when the person connects the first way of thinking and
 * has not chosen one: the subscriptions first, then the keys, then the rest; within a provider
 * its strongest model (Opus for Claude), otherwise the first it lists.
 */
export function firstDefault(
  models: { provider: string; model: string; effort: boolean }[],
): ModelSpec | undefined {
  const rank = (p: string) => {
    const i = PREFERRED.indexOf(p);
    return i === -1 ? PREFERRED.length : i;
  };
  const provider = [...new Set(models.map((m) => m.provider))].sort((a, b) => rank(a) - rank(b))[0];
  if (!provider) return undefined;
  const own = models.filter((m) => m.provider === provider);
  const best = own.find((m) => /opus/i.test(m.model)) ?? own[0];
  if (!best) return undefined;
  return { provider, model: best.model, ...(best.effort && { effort: "medium" as const }) };
}

/**
 * A folder for the models chosen by the person (2026-11-06): a Windows path on the chosen disk,
 * without the characters Windows refuses and without `..`; the trailing backslash dropped.
 */
export function modelsFolder(drive: string, folder: string): string {
  const path = folder
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\//g, "\\");
  if (!/^[A-Za-z]:\\[^"<>|?*:]+$/.test(path) || path.split("\\").includes(".."))
    throw new SetupError(`Not a folder of ${drive}: (for example ${drive}:\\RedGiant\\models)`);
  if (path[0]?.toUpperCase() !== drive.toUpperCase())
    throw new SetupError(`The folder is not on ${drive}:`);
  return `${drive.toUpperCase()}${path.slice(1)}`;
}

export class SetupService {
  private config: SetupConfig = { completed: false };
  private secrets: Secrets = {};
  private retention: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: {
      db: SqlClient;
      core: RedGiantCore;
      dataDir: string;
      ownerId: string;
      hooks: SetupHooks;
      locked?: Locked;
      /** GitHub and Gitea (G24.5). */
      git?: GitHosts;
    },
  ) {}

  private get secretsFile() {
    return join(this.o.dataDir, "secrets.json");
  }

  async load(): Promise<void> {
    const [r] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = 'setup'",
      [this.o.ownerId],
    );
    if (r)
      this.config = (typeof r.value === "string" ? JSON.parse(r.value) : r.value) as SetupConfig;
    this.secrets = await readFile(this.secretsFile, "utf8")
      .then((t) => JSON.parse(t) as Secrets)
      .catch(() => ({}));
    if (this.migrate()) await this.save();
    // Push notifications through ntfy are gone (G24.1): alerts go to Telegram.
    const old = this.config as { ntfyUrl?: string };
    const oldSecrets = this.secrets as { ntfyToken?: string };
    if (old.ntfyUrl !== undefined || oldSecrets.ntfyToken !== undefined) {
      delete old.ntfyUrl;
      delete oldSecrets.ntfyToken;
      await this.save();
    }
  }

  /**
   * Older settings (before G24.2): one Anthropic key and one OpenAI-compatible server with the
   * id "openai". The server keeps working under its new id; true when something changed.
   */
  private migrate(): boolean {
    const c = this.config as SetupConfig & { openaiBaseUrl?: string };
    const s = this.secrets as Secrets & { anthropicKey?: string; openaiKey?: string };
    let changed = false;
    if (s.anthropicKey) {
      s.keys = { ...s.keys, anthropic: s.anthropicKey };
      c.keyProviders = [...new Set([...(c.keyProviders ?? []), "anthropic"])];
      delete s.anthropicKey;
      changed = true;
    }
    if (c.openaiBaseUrl) {
      c.server = { baseUrl: c.openaiBaseUrl };
      if (s.openaiKey) s.serverKey = s.openaiKey;
      if (c.defaultModel?.provider === "openai")
        c.defaultModel = { ...c.defaultModel, provider: OWN_SERVER_ID };
      delete c.openaiBaseUrl;
      delete s.openaiKey;
      changed = true;
    }
    // One language for both before G33.5: the agents keep speaking the one they spoke.
    if (c.language && !c.agentLanguage) {
      c.agentLanguage = c.language;
      changed = true;
    }
    // The OpenAI pictures key (G20.7) becomes the pictures choice (G25.3).
    if (s.openaiImagesKey && !c.media?.image) {
      s.mediaKeys = { openai: s.openaiImagesKey, ...s.mediaKeys };
      c.media = { ...c.media, image: { provider: "openai", model: c.imagesModel ?? IMAGE_MODEL } };
      changed = true;
    }
    return changed;
  }

  private async save(): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, 'setup', $2)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [this.o.ownerId, JSON.stringify(this.config)],
    );
    await mkdir(this.o.dataDir, { recursive: true });
    const tmp = `${this.secretsFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.secretsFile);
    // Readable copy of the choices (no secrets): for people and backups.
    await writeFile(
      join(this.o.dataDir, "redgiant.yaml"),
      `# Written by RedGiant's setup wizard; secrets are in secrets.json.\n${stringify(this.config)}`,
    );
  }

  private get locked(): Locked {
    return this.o.locked ?? {};
  }

  /** At startup: what the wizard set (and the environment does not) is applied again. */
  async applyAtStartup(): Promise<void> {
    await this.load();
    const h = this.o.hooks;
    const c = this.config;
    const s = this.secrets;
    const run = (what: string, p: Promise<unknown>) =>
      p.catch((err) => console.warn(`setup: ${what}: ${(err as Error).message}`));
    for (const [id, key] of Object.entries(s.keys ?? {}))
      if (!(id === "anthropic" && this.locked.anthropic)) await run(id, h.key(id, key));
    if (!this.locked.server && c.server)
      await run(
        "own server",
        h.server({ baseUrl: c.server.baseUrl, ...(s.serverKey && { key: s.serverKey }) }),
      );
    // RedGiant's own search engine is started again (a restart of the computer stops it).
    // Run on this computer (no Docker, 2026-11-05) it answers on a new port each time: kept.
    if (!this.locked.search && c.searxngManaged && h.searxng) {
      const searxng = h.searxng;
      await run(
        "searxng",
        searxng(true).then(async (r) => {
          if (r && r.url !== c.searxngUrl) {
            c.searxngUrl = r.url;
            await this.save();
          }
          return r;
        }),
      );
    }
    const search = this.searchChoice();
    if (!this.locked.search && search) await run("search", h.search(search));
    // No search set at all: RedGiant's own starts, so every model can search (2026-11-03).
    else if (!this.locked.search && c.completed && this.canRunSearch && !c.searxngDeclined)
      this.startSearch();
    // The local model as a job the page shows (2026-11-04: it loaded unseen, the RAM filling up
    // with nothing on screen); not at all when the person turned it off.
    if (!this.locked.engine && c.engine && !c.engine.off) this.loadEngine(c.engine);
    if (!this.locked.voice && c.transcription) this.applyTranscription();
    if (!this.locked.images && s.openaiImagesKey) this.applyImages();
    this.applyMedia();
    // Links sent to the phone (boards on Telegram) use the way in from outside.
    this.o.core.setPublicUrl(c.remote?.url);
    if (c.subscriptions?.chatgpt && h.chatgptSubscription)
      await run("ChatGPT subscription", h.chatgptSubscription(true));
    if (c.subscriptions?.claude && h.claudeSubscription)
      await run("Claude subscription", h.claudeSubscription(s.claudeSubscriptionToken ?? ""));
    if (!this.locked.defaultModel && c.defaultModel) this.o.core.setDefaultModel(c.defaultModel);
    if (c.language) this.o.core.setLanguage(c.language);
    this.o.core.setAgentLanguage(c.agentLanguage);
    if (c.instructions) this.o.core.setInstructions(c.instructions);
    if (c.backupModel) this.o.core.setBackupModel(c.backupModel);
    if (!this.locked.telegram && s.telegramToken)
      await run("Telegram", h.telegram(s.telegramToken));
    for (const [p, settings] of Object.entries(s.chats ?? {}))
      if (settings && h.chat) await run(p, h.chat(p as Platform, settings));
    await run("git routes", this.applyGit());
    this.scheduleTokenReminder();
    this.scheduleRetention();
  }

  /**
   * The keys kept here, for the keychain's list (G33.4): what each is and where it is managed.
   * Names only: the values stay in secrets.json, used as before.
   */
  keysForVault(): VaultSystemEntry[] {
    const s = this.secrets;
    const out: VaultSystemEntry[] = [];
    const add = (
      id: string,
      service: string,
      section: string,
      kind: VaultSystemEntry["kind"],
      what: string,
      category: VaultSystemEntry["category"] = "api",
    ) =>
      out.push({
        id: `setup:${id}`,
        service: SERVICE_NAMES[service] ?? service.charAt(0).toUpperCase() + service.slice(1),
        brand: service.toLowerCase(),
        section,
        kind,
        what,
        category,
      });
    for (const p of Object.keys(s.keys ?? {})) add(`key-${p}`, p, "setup", "provider", "API key");
    if (s.serverKey) add("server", "OpenAI-compatible server", "setup", "provider", "API key");
    if (s.claudeSubscriptionToken)
      add("claude-subscription", "Claude", "subscriptions", "provider", "subscription");
    for (const p of Object.keys(s.mediaKeys ?? {}))
      add(`media-${p}`, p, "setup", "provider", "API key");
    if (s.transcriptionKey) add("transcription", "Transcription", "setup", "other", "API key");
    if (s.openaiImagesKey) add("images", "OpenAI", "setup", "provider", "images key");
    if (s.telegramToken) add("telegram", "Telegram", "telegram", "chat", "bot token");
    for (const p of Object.keys(s.chats ?? {})) add(`chat-${p}`, p, "chats", "chat", "token");
    if (s.githubToken) add("github", "GitHub", "code", "git", "token", "server");
    if (s.giteaToken) add("gitea", "Gitea", "code", "git", "token", "server");
    for (const p of Object.keys(s.searchKeys ?? {}))
      add(`search-${p}`, p, "setup", "search", "API key");
    if (s.piholePassword) add("pihole", "Pi-hole", "remote", "other", "password", "server");
    if (s.cloudflareToken) add("cloudflare", "Cloudflare", "remote", "other", "token", "server");
    return out;
  }

  async state(): Promise<SetupState> {
    const owner = this.o.ownerId;
    const agents = this.o.core.registry.list({ ownerId: owner });
    const god = agents.find((a) => a.kind === "god");
    const demigod = agents.find((a) => a.kind === "demigod");
    const policy = this.o.core.policies.get(owner);
    const [global] = (await this.o.core.budget.listFor(owner, [], [])).filter(
      (b) => b.scope === "global",
    );
    return {
      config: this.config,
      secretsSet: {
        keys: Object.keys(this.secrets.keys ?? {}),
        server: Boolean(this.secrets.serverKey),
        telegram: Boolean(this.secrets.telegramToken),
        chats: Object.keys(this.secrets.chats ?? {}) as Platform[],
        transcription: Boolean(this.secrets.transcriptionKey),
        images: Boolean(this.secrets.openaiImagesKey),
        media: MEDIA_PROVIDERS.filter((p) => this.mediaKey(p.id)).map((p) => p.id),
        claudeSubscription: Boolean(this.secrets.claudeSubscriptionToken),
        github: Boolean(this.secrets.githubToken),
        gitea: Boolean(this.secrets.giteaToken),
        search: Object.keys(this.secrets.searchKeys ?? {}),
      },
      locked: this.locked,
      providers: this.o.core.providerIds(),
      hardware: await detectHardware({
        dataDir: this.o.dataDir,
        ...(this.o.hooks.dockerRuntimes && { dockerRuntimes: this.o.hooks.dockerRuntimes }),
      }),
      names: {
        god: god?.name ?? null,
        demigod: demigod?.name ?? null,
        // As the person reads it: the names in place of the placeholders.
        godPrompt: god?.systemPrompt ? this.o.core.systemFor(god) : null,
        /** God's built-in instructions, with {name} and {demigod} for the names being chosen. */
        godPromptTemplate: defaultTemplate("god", false),
      },
      policy: {
        guardian: policy.guardian ?? "ask",
        skills: policy.skills ?? "ask",
        humanOnly: policy.humanOnly ?? DEFAULT_POLICY.humanOnly,
        disabledDanger: policy.disabledDanger,
        dangers: DEFAULT_POLICY.danger.map((d) => ({ id: d.id })),
      },
      budgetUsd: global?.limit.usd ?? null,
      canRunSearch: this.canRunSearch,
      moePrefetch: (await this.o.hooks.moePrefetchBinaries?.().catch(() => null)) ?? null,
      moePrefetchImage: (await this.o.hooks.moePrefetchImage?.().catch(() => null)) ?? null,
    };
  }

  /**
   * Agents need a model: when the person connects a way of thinking and none is chosen yet, the
   * best one connected becomes the default at once (they change it in "The model agents use").
   */
  private async autoDefault(): Promise<void> {
    if (this.config.defaultModel || this.locked.defaultModel) return;
    const pick = firstDefault(await this.o.core.models().catch(() => []));
    if (!pick) return;
    this.config.defaultModel = pick;
    this.o.core.setDefaultModel(pick);
    await this.save();
  }

  /**
   * A provider of the catalog with the user's key: checked with the provider first, then kept.
   * null disconnects it. Returns the models it offers.
   */
  async saveKey(id: string, key: string | null): Promise<{ models: string[] }> {
    const p = keyProvider(id);
    if (!p) throw new SetupError(`Unknown provider "${id}"`);
    if (id === "anthropic" && this.locked.anthropic)
      throw new SetupError("The Anthropic key is set by the environment");
    let models: string[];
    try {
      models = await this.o.hooks.key(id, key);
    } catch (err) {
      throw connectError(p.name, err);
    }
    const keys = { ...this.secrets.keys };
    if (key) keys[id] = key;
    else delete keys[id];
    this.secrets.keys = keys;
    this.config.keyProviders = Object.keys(keys);
    await this.save();
    // The same key may make pictures and sounds too (OpenAI, Gemini, xAI).
    this.applyMedia();
    if (key) await this.autoDefault();
    return { models };
  }

  /** The user's own OpenAI-compatible server (Ollama, LM Studio, vLLM…); null removes it. */
  async saveServer(
    cfg: { baseUrl: string; key?: string | undefined } | null,
  ): Promise<{ models: string[] }> {
    if (this.locked.server) throw new SetupError("The server is set by the environment");
    // An empty key keeps the saved one.
    const key = cfg?.key || this.secrets.serverKey;
    let models: string[];
    try {
      models = await this.o.hooks.server(cfg && { baseUrl: cfg.baseUrl, ...(key && { key }) });
    } catch (err) {
      throw connectError(cfg?.baseUrl ?? "server", err);
    }
    if (cfg) {
      this.config.server = { baseUrl: cfg.baseUrl };
      if (cfg.key) this.secrets.serverKey = cfg.key;
    } else {
      delete this.config.server;
      delete this.secrets.serverKey;
    }
    await this.save();
    if (cfg) await this.autoDefault();
    return { models };
  }

  /** Search, voice messages, pictures and the default model (Settings, General). */
  async saveModels(m: {
    searxngUrl?: string | null | undefined;
    /** The search service (2026-11-03): which, its address (SearXNG) or its key. */
    search?:
      | { provider: SearchProviderId; url?: string | undefined; key?: string | undefined }
      | null
      | undefined;
    /** null removes the key; a model alone keeps the saved key. */
    images?: { key?: string | undefined; model?: string | undefined } | null | undefined;
    transcription?:
      | {
          api: "whisper-asr" | "openai" | "local";
          url: string;
          model?: string | undefined;
          key?: string | undefined;
        }
      | null
      | undefined;
    defaultModel?: ModelSpec | undefined;
  }): Promise<void> {
    if (m.searxngUrl !== undefined && !this.locked.search) {
      if (m.searxngUrl) this.config.searxngUrl = m.searxngUrl;
      else delete this.config.searxngUrl;
      await this.o.hooks.search(this.searchChoice() ?? null);
    }
    if (m.search !== undefined && !this.locked.search) {
      if (!m.search) {
        delete this.config.searchProvider;
      } else {
        this.config.searchProvider = m.search.provider;
        if (m.search.provider === "searxng" && m.search.url) this.config.searxngUrl = m.search.url;
        if (m.search.key)
          this.secrets.searchKeys = {
            ...this.secrets.searchKeys,
            [m.search.provider]: m.search.key,
          };
      }
      await this.o.hooks.search(this.searchChoice() ?? null);
    }
    if (m.images !== undefined && !this.locked.images) {
      if (m.images) {
        if (m.images.key) this.secrets.openaiImagesKey = m.images.key;
        if (m.images.model) this.config.imagesModel = m.images.model;
        else delete this.config.imagesModel;
      } else {
        delete this.secrets.openaiImagesKey;
        delete this.config.imagesModel;
      }
      this.applyImages();
    }
    if (m.transcription !== undefined && !this.locked.voice) {
      if (m.transcription) {
        const { key, model, ...rest } = m.transcription;
        this.config.transcription = { ...rest, ...(model && { model }) };
        // An empty key keeps the one saved before; null-ing the service removes it.
        if (key) this.secrets.transcriptionKey = key;
      } else {
        delete this.config.transcription;
        delete this.secrets.transcriptionKey;
      }
      this.applyTranscription();
    }
    if (m.defaultModel && !this.locked.defaultModel) {
      // A model that cannot answer is not made the default.
      await this.o.core.trialModel(this.o.ownerId, m.defaultModel);
      this.config.defaultModel = m.defaultModel;
      this.o.core.setDefaultModel(m.defaultModel);
    }
    await this.save();
  }

  private applyTranscription(): void {
    const t = this.config.transcription;
    if (t?.api === "local") {
      this.startLocalVoice();
      return;
    }
    this.localVoice?.stop();
    this.o.core.setTranscription(
      t && { ...t, ...(this.secrets.transcriptionKey && { key: this.secrets.transcriptionKey }) },
    );
  }

  /** whisper.cpp on this computer (RedGiant 3.0): downloaded once, then started here. */
  private localVoice: LocalWhisper | undefined;
  private startLocalVoice(): void {
    this.localVoice ??= new LocalWhisper(this.o.dataDir);
    const voice = this.localVoice;
    const ffmpeg = () => ensureFfmpeg(this.o.core.jobs, this.o.ownerId, this.o.dataDir);
    this.o.core.ffmpeg = ffmpeg;
    void (async () => {
      await voice.ensure(this.o.core.jobs, this.o.ownerId);
      // ffmpeg too, so the first M4A voice note does not wait for it.
      void ffmpeg().catch((err) =>
        debugLog.write("voice", "ffmpeg did not download", { error: String(err) }),
      );
      const url = await voice.start(await freePort());
      if (this.config.transcription?.api === "local")
        this.o.core.setTranscription({
          api: "local",
          url,
          ...(voice.wavOnly && { wavOnly: true }),
        });
    })().catch((err) =>
      debugLog.write("voice", "whisper.cpp did not start", { error: String(err) }),
    );
  }

  /**
   * Starts the local engine as a job the UI follows: the engine's image (downloaded if
   * missing), the container, the model loaded, a first answer. Kept only when it answers.
   */
  startEngine(e: EngineConfig): Job {
    this.checkEngine(e);
    return this.o.core.jobs.start(
      this.o.ownerId,
      "engine",
      ["image", "preload", "start", "load", "tune", "try"],
      async (h) => {
        const { plan: _old, ...asked } = e;
        // Already running as asked: nothing to do again (2026-11-04, «non ha senso»).
        const now = this.config.engine;
        if (
          now &&
          now.variant === e.variant &&
          now.model === e.model &&
          Boolean(now.stream) === Boolean(e.stream) &&
          Boolean(now.bigChunks) === Boolean(e.bigChunks) &&
          Boolean(now.moePrefetch) === Boolean(e.moePrefetch) &&
          now.speculative === e.speculative &&
          now.draftModel === e.draftModel &&
          // Another tuning picked from the table (2026-11-05) is a new start.
          (!e.tuning ||
            ((e.tuning.moeCacheShare ?? 0) === (now.tuning?.moeCacheShare ?? 0) &&
              (e.tuning.opOffload === false) === (now.tuning?.opOffload === false) &&
              (e.tuning.batch ?? 0) === (now.tuning?.batch ?? 0))) &&
          // Tuned before the try without the copy to the card (2026-11-04): that try is still due.
          !(
            now.plan &&
            (now.plan.moe ?? now.plan.moeCacheMib > 0) &&
            now.tuning?.opOffload === undefined
          ) &&
          this.o.core.providers.has("local") &&
          (await this.o.core
            .trialModel(this.o.ownerId, { provider: "local", model: e.model })
            .then(() => true)
            .catch(() => false))
        ) {
          for (const step of ["image", "preload", "start", "load", "tune", "try"]) h.skip(step);
          return;
        }
        let wanted: EngineConfig = asked;
        let plan = await this.o.hooks.engine(wanted, h);
        // SSD stream of a mixture of experts, not tuned yet for this model: the card's room is
        // split three ways between the experts' cache and the context, each one measured, and
        // the fastest kept (2026-11-03). Then reading a context with and without sending the
        // experts to the card at every pass (2026-11-04: in WSL that copy took 30 s a message
        // for gpt-oss 120B, the processor does it faster); a model tuned before gets that try only.
        const tuned =
          this.config.engine?.model === e.model ? this.config.engine?.tuning : undefined;
        const moe = !!plan && (plan.moe ?? plan.moeCacheMib > 0) && !e.tuning;
        // Bigger passes (G32.1): tried once for the model, after the split of the card; a model
        // tuned before without them gets only these tries.
        const fullTune = moe && (!tuned || tuned.opOffload === undefined);
        const batchTune = moe && !!asked.bigChunks && (fullTune || tuned?.batch === undefined);
        if (fullTune || batchTune) {
          h.step("tune");
          const earlier =
            this.config.engine?.model === e.model ? this.config.engine?.trials : undefined;
          const trials: Trial[] = fullTune ? [] : (earlier ?? []).map((x) => ({ ...x }));
          const show = () => h.info({ trials: JSON.stringify(trials) });
          type Tuning = { moeCacheShare: number; opOffload?: boolean; batch?: number };
          /** Starts the engine with `tuning` (unless `started` already did) and measures it. */
          const tryOne = async (tuning: Tuning, read?: number, started?: EnginePlan) => {
            const tried = started ?? (await this.o.hooks.engine({ ...asked, tuning }));
            const trial: Trial = {
              share: tuning.moeCacheShare,
              ctx: tried ? tried.ctx : 0,
              cacheMib: tried ? tried.moeCacheMib : 0,
              state: "running",
              ...(tuning.opOffload === false && { opOffload: false }),
              ...(tuning.batch !== undefined && { batch: tuning.batch }),
              ...(read !== undefined && { readTokens: read }),
            };
            trials.push(trial);
            show();
            try {
              await this.waitLocal(h);
              Object.assign(trial, await this.benchLocal(e.model, read), { state: "done" });
              const turn = typicalTurn(trial, read);
              if (turn !== undefined) trial.turnS = turn;
            } catch (err) {
              Object.assign(trial, {
                state: "failed",
                error: (err as Error).message.slice(0, 200),
              });
            }
            show();
            return trial;
          };
          const shares = !fullTune
            ? []
            : tuned?.moeCacheShare !== undefined
              ? [tuned.moeCacheShare]
              : [0, 0.15, 0.3];
          const steps =
            (fullTune ? shares.length + 1 : 0) + (batchTune ? 1 + BIG_BATCHES.length : 0);
          let done = 0;
          let base: Tuning = {
            moeCacheShare: tuned?.moeCacheShare ?? 0,
            ...(tuned?.opOffload === false && { opOffload: false }),
          };
          let chosen: Trial | undefined = trials.find((x) => x.chosen);
          if (fullTune) {
            // No cache of experts on the card first: it was the fastest through WSL (2026-11-04).
            for (const share of shares) {
              h.progress(done++, steps);
              const now = await tryOne({ moeCacheShare: share });
              // More of the card for the experts made it slower: more would too (2026-11-05,
              // Rig: 0 % then 15 % then 30 %, each worse). The rest of the shares are not tried.
              const before = trials.at(-2);
              if (
                before?.turnS !== undefined &&
                now.turnS !== undefined &&
                now.turnS > before.turnS
              )
                break;
            }
            const best = fastestTrial(trials);
            const share = best?.share ?? 0;
            h.progress(done++, steps);
            const local = await tryOne({ moeCacheShare: share, opOffload: false });
            // The fastest for a typical turn, reading and writing together (2026-11-05).
            chosen = fastestTrial(trials);
            base = {
              moeCacheShare: chosen?.share ?? share,
              opOffload: chosen !== local,
            };
          }
          if (batchTune) {
            // The kept split again with passes of 4096 and then each bigger pass the card has
            // room for, all reading the same long message: the fastest for it is kept. A bigger
            // pass slower than the one before ends the tries (its buffers took the context's room).
            const first = await this.o.hooks.engine({
              ...asked,
              tuning: { ...base, batch: MOE_BATCH },
            });
            const long = batchTrials(first || undefined);
            const rows: Trial[] = [];
            if (long.batches.length > 0) {
              h.progress(done++, steps);
              rows.push(await tryOne({ ...base, batch: MOE_BATCH }, long.read, first || undefined));
              for (const batch of long.batches) {
                h.progress(done++, steps);
                const now = await tryOne({ ...base, batch }, long.read);
                rows.push(now);
                const before = rows.at(-2);
                if (
                  before?.turnS !== undefined &&
                  now.turnS !== undefined &&
                  now.turnS > before.turnS
                )
                  break;
              }
            }
            const best = fastestTrial(rows);
            const ok = best?.state === "done";
            if (ok) chosen = best;
            base = { ...base, batch: ok ? (best.batch ?? MOE_BATCH) : MOE_BATCH };
          }
          h.progress(steps, steps);
          for (const x of trials) x.chosen = x === chosen;
          show();
          wanted = { ...asked, tuning: { ...base, opOffload: base.opOffload !== false }, trials };
          plan = await this.o.hooks.engine(wanted, h);
        } else {
          h.skip("tune");
          // The tuning measured before, unless the person picked one (2026-11-05).
          if (tuned && !e.tuning) wanted = { ...asked, tuning: tuned };
          // The person picked another try (2026-11-05): the table again, with that one chosen.
          const before =
            this.config.engine?.model === e.model ? this.config.engine?.trials : undefined;
          if (before && wanted.tuning) {
            const pick = wanted.tuning;
            const trials = before.map((x) => ({
              ...x,
              chosen:
                x.state === "done" &&
                x.share === (pick.moeCacheShare ?? 0) &&
                (x.opOffload === false) === (pick.opOffload === false) &&
                (x.batch ?? 0) === (pick.batch ?? 0),
            }));
            wanted = { ...wanted, trials };
            h.info({ trials: JSON.stringify(trials) });
          }
        }
        h.step("try");
        try {
          await this.warmLocal(e.model, h);
        } catch (err) {
          throw new JobFailure("no_answer", (err as Error).message);
        }
        this.prefillConversations();
        // The plan the start computed (SSD stream): the page shows its context and source.
        this.config.engine = { ...wanted, ...(plan && { plan }) };
        await this.save();
        // A local model cannot search the web by itself: RedGiant's search engine starts too.
        if (!this.searchChoice() && this.canRunSearch && !this.config.searxngDeclined)
          this.startSearch();
      },
      { model: e.model },
    );
  }

  /** Until the local engine answers (after a restart without a job of its own). */
  private async waitLocal(h: JobHandle): Promise<void> {
    for (let i = 0; i < 450; i++) {
      if (h.signal.aborted) throw new Error("cancelled");
      const ok = await this.o.core
        .trialModel(this.o.ownerId, { provider: "local", model: "probe" })
        .then(() => true)
        .catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new JobFailure("load_timeout", "The model did not load again within 15 minutes");
  }

  /**
   * The first real answer, as a warm-up (2026-11-04): a context of about 3,000 tokens read and
   * a few words written, the reading shown as it goes. The first time on a new card the engine
   * prepares its programs here (minutes, once), not at the person's first message.
   */
  /**
   * After the warm-up (2026-11-05): the latest conversations on the local model are computed in
   * their slots, in the background, so the first message after starting reads only itself.
   */
  private prefillConversations(): void {
    const t0 = Date.now();
    void this.o.core
      .prefillRecent(this.o.ownerId)
      .then((n) =>
        debugLog.write("engine", "conversations computed ahead", { count: n, ms: Date.now() - t0 }),
      )
      // Then the start of a new conversation, for the agents used last.
      .then(() => this.o.core.prefillStarts(this.o.ownerId))
      .then((n) =>
        debugLog.write("engine", "new conversations' start computed ahead", {
          count: n,
          ms: Date.now() - t0,
        }),
      )
      .catch(() => {});
  }

  private async warmLocal(model: string, h: JobHandle): Promise<void> {
    const p = this.o.core.providers.get("local");
    // A new first line every time: the same text would come back from the saved contexts and
    // measure nothing (it showed 3,487 tokens/s, the first real message read at 21).
    const text = `Warm-up ${randomBytes(6).toString("hex")}.\n${"RedGiant warms up the model before the first conversation. ".repeat(260)}`;
    let written = 0;
    const started = Date.now();
    let read = 0;
    for await (const ev of p.stream({
      model,
      system: "",
      tools: [],
      messages: [
        { role: "user", parts: [{ type: "text", text: `${text}\nReply with the word OK.` }] },
      ],
      maxTokens: 32,
    })) {
      if (h.signal.aborted) throw new Error("cancelled");
      if (ev.type === "prefill_progress") {
        h.progress(ev.processed, ev.total);
        read = ev.processed;
      }
      if (ev.type === "text_delta" || ev.type === "thinking_delta") {
        // How fast the context was read, for the page (2026-11-04): the measure of the first message.
        if (written === 0 && read > 0)
          h.info({
            warmTps: String(Math.round(read / Math.max((Date.now() - started) / 1000, 0.001))),
          });
        h.info({ written: String(++written) });
      }
    }
  }

  /**
   * Measures what speculative decoding gains on this computer (2026-11-04, the person's
   * request: an option with a test, "more time and compute"). The model is started once per
   * mode, each one writes a short new text and rewrites a piece of code, and in the end the
   * engine goes back to how it was. As fast as it can: 128 tokens per text, one warm-up.
   */
  testSpeed(e: EngineConfig, asked: string[]): Job {
    this.checkEngine(e);
    const before = this.config.engine;
    // The way the engine runs now goes last (2026-11-04): when it is one of those tried, the
    // test ends with the engine as it was, and no model is loaded once more to put it back.
    const runningMode =
      before && !before.off && before.model === e.model && before.variant === e.variant
        ? (before.speculative ?? "none")
        : undefined;
    const modes =
      runningMode && asked.includes(runningMode)
        ? [...asked.filter((m) => m !== runningMode), runningMode]
        : asked;
    const endsAsBefore = runningMode !== undefined && modes.at(-1) === runningMode;
    const steps = [...modes, "restore"];
    return this.o.core.jobs.start(
      this.o.ownerId,
      "speed_test",
      steps,
      async (h) => {
        const trials: SpeedTrial[] = modes.map((mode) => ({ mode, state: "waiting" }));
        const show = () => h.info({ trials: JSON.stringify(trials) });
        show();
        try {
          for (const [i, mode] of modes.entries()) {
            const trial = trials[i] as SpeedTrial;
            if (h.signal.aborted) throw new Error("cancelled");
            h.step(mode);
            // The running engine's own settings (its tuning, its plan) when it is the same model.
            const { plan: _plan, off: _off, ...base } = runningMode && before ? before : e;
            const cfg: EngineConfig = {
              ...base,
              speculative: mode === "draft" ? "draft" : mode === "ngram" ? "ngram" : undefined,
              draftModel: mode === "draft" ? e.draftModel : undefined,
            };
            if (mode === "draft" && !e.draftModel) {
              trial.state = "skipped";
              show();
              continue;
            }
            trial.state = "running";
            show();
            try {
              await this.o.hooks.engine(cfg);
              await this.waitLocal(h);
              // One short answer first: the first one after a start pays for the warm-up.
              await this.speedOf(e.model, "Name three rivers in Europe.", 16);
              trial.proseTps = await this.speedOf(e.model, SPEED_PROSE, 128);
              h.progress(i * 2 + 1, modes.length * 2);
              trial.codeTps = await this.speedOf(e.model, SPEED_CODE, 128);
              h.progress(i * 2 + 2, modes.length * 2);
              trial.state = "done";
            } catch (err) {
              trial.state = "failed";
              trial.error = (err as Error).message.slice(0, 200);
            }
            show();
          }
        } finally {
          // The engine as it was, whatever happened (nothing to do when the last try was it).
          const last = trials.at(-1);
          if (endsAsBefore && last?.state === "done" && !h.signal.aborted) h.skip("restore");
          else {
            h.step("restore");
            await this.o.hooks.engine(before && !before.off ? before : null).catch(() => {});
            if (before && !before.off) await this.waitLocal(h).catch(() => {});
          }
        }
      },
      { model: e.model },
    );
  }

  /** Tokens a second the local engine writes for one request (the engine's own count). */
  private async speedOf(model: string, text: string, maxTokens: number): Promise<number> {
    const p = this.o.core.providers.get("local");
    const c = await complete(
      p.stream({
        model,
        system: "",
        tools: [],
        messages: [{ role: "user", parts: [{ type: "text", text }] }],
        maxTokens,
      }),
    );
    return Math.round((c.metrics.tokPerSec ?? 0) * 10) / 10;
  }

  /** How fast the local engine reads a context of about 2,000 tokens and writes 64. */
  private async benchLocal(
    model: string,
    /** About how many tokens to read (G32.1, the bigger passes' long message); default ~2,000. */
    read?: number,
  ): Promise<{ genTps: number; prefillTps: number }> {
    const p = this.o.core.providers.get("local");
    // The sentence is about 11 tokens: a few fewer than asked, never more than the context.
    const times = read ? Math.max(1, Math.floor(read / 12)) : 180;
    const text = `Measure ${randomBytes(6).toString("hex")}.\n${"RedGiant measures how fast this computer runs the model. ".repeat(times)}`;
    const c = await complete(
      p.stream({
        model,
        system: "",
        tools: [],
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: `${text}\nSay in three sentences what this text is.` }],
          },
        ],
        maxTokens: 64,
      }),
    );
    const fresh = Math.max(0, c.usage.inputTokens - c.usage.cachedReadTokens);
    return {
      genTps: Math.round((c.metrics.tokPerSec ?? 0) * 10) / 10,
      prefillTps: c.metrics.prefillMs ? Math.round(fresh / (c.metrics.prefillMs / 1000)) : 0,
    };
  }

  private checkEngine(e: EngineConfig | null): void {
    if (this.locked.engine) throw new SetupError("The local engine is set by the environment");
    const file = (x: string) =>
      !x.includes("/") && !x.includes("\\") && !x.includes("..") && x.endsWith(".gguf");
    if (e && !file(e.model)) throw new SetupError("The model is a .gguf file in the models folder");
    if (e?.speculative === "draft" && !(e.draftModel && file(e.draftModel)))
      throw new SetupError("The small model is a .gguf file in the models folder");
  }

  /**
   * The local model loaded when RedGiant opens, followed like an activation: reading it, starting
   * the engine, loading it on the card, and the warm-up (2026-11-04, the person's question: the
   * first message paid for it otherwise, bringing the experts from the SSD). No tuning: it was
   * done at the activation.
   */
  loadEngine(e: EngineConfig): Job {
    return this.o.core.jobs.start(
      this.o.ownerId,
      "engine_load",
      ["image", "preload", "start", "load", "try"],
      async (h) => {
        await this.o.hooks.engine(e, h);
        h.step("try");
        // A warm-up that fails does not undo the load: the model is there, it answers later.
        await this.warmLocal(e.model, h).catch((err: unknown) =>
          debugLog.write("engine", "warm-up after loading failed", { error: String(err) }),
        );
        this.prefillConversations();
      },
      { model: e.model },
    );
  }

  /**
   * The local model turned on or off (2026-11-04): off stops the engine and frees its memory,
   * keeping the choice and its tuning; on starts it again as it was.
   */
  async setEnginePower(on: boolean): Promise<Job | null> {
    const e = this.config.engine;
    if (!e) throw new SetupError("No local model chosen");
    if (this.locked.engine) throw new SetupError("The local engine is set by the environment");
    if (!on) {
      await this.o.hooks.engine(null);
      await this.o.hooks.releaseMemory?.().catch(() => {});
      this.config.engine = { ...e, off: true };
      await this.save();
      return null;
    }
    const { off: _off, ...rest } = e;
    this.config.engine = rest;
    await this.save();
    // Never tuned (a mixture of experts streamed): the whole activation, tuning included.
    if (rest.stream && !rest.tuning) {
      const { plan: _plan, ...asked } = rest;
      return this.startEngine(asked);
    }
    return this.loadEngine(rest);
  }

  async saveEngine(e: EngineConfig | null): Promise<void> {
    this.checkEngine(e);
    await this.o.hooks.engine(e);
    if (e) this.config.engine = e;
    else delete this.config.engine;
    await this.save();
  }

  /** Standard or advanced installation (G24.5): advanced adds the code server and remote access. */
  async saveMode(mode: "standard" | "advanced"): Promise<void> {
    this.config.mode = mode;
    await this.save();
  }

  private gitParts() {
    return {
      cfg: this.config.git ?? {},
      secrets: { githubToken: this.secrets.githubToken, giteaToken: this.secrets.giteaToken },
    };
  }

  /** The proxy's credential routes, and a repository for every project created from now on. */
  private async applyGit(): Promise<void> {
    const git = this.o.git;
    if (!git) return;
    const { cfg, secrets } = this.gitParts();
    await git.writeRoutes(cfg, secrets);
    // Pull requests and issues for the projects' agents (G24.14c), when there is a host.
    this.o.core.repoActions =
      cfg.github || cfg.gitea
        ? (projectId, a) => {
            const { cfg: c, secrets: s } = this.gitParts();
            return git.repoAction(c, s, projectId, a);
          }
        : undefined;
    this.o.core.projects.onCreate =
      cfg.github || cfg.gitea
        ? async (p) => {
            const { cfg: c, secrets: s } = this.gitParts();
            await git.repoFor(c, s, p);
          }
        : undefined;
  }

  private reminder: NodeJS.Timeout | undefined;
  private reminded: string | undefined;

  /** Two weeks before GitHub's token expires, the owner is told on Telegram (once per date). */
  private scheduleTokenReminder(): void {
    clearInterval(this.reminder);
    const check = () => void this.remindToken().catch(() => {});
    this.reminder = setInterval(check, 12 * 3_600_000);
    this.reminder.unref();
    check();
  }

  async remindToken(now = Date.now()): Promise<boolean> {
    const expires = this.config.git?.github?.expires;
    if (!expires || this.reminded === expires) return false;
    const days = (Date.parse(expires) - now) / 86_400_000;
    if (days > 14) return false;
    this.reminded = expires;
    const it = this.o.core.language(this.o.ownerId) === "it";
    const date = new Date(expires).toLocaleDateString(it ? "it-IT" : "en-GB");
    await this.o.core.tell(
      this.o.ownerId,
      it
        ? `Il token di GitHub di RedGiant scade il ${date}. Creane uno nuovo (Impostazioni, Dove sta il codice) per non fermare i push dei progetti.`
        : `RedGiant's GitHub token expires on ${date}. Make a new one (Settings, Where the code lives) so the projects can keep pushing.`,
    );
    return true;
  }

  /** GitHub with the user's fine-grained token: checked first; null disconnects it. */
  async saveGithub(token: string | null): Promise<{ login: string } | null> {
    const git = this.o.git;
    if (!git) throw new SetupError("This installation cannot use GitHub");
    let login: string | null = null;
    if (token) {
      let expires: string | undefined;
      try {
        ({ login, expires } = await git.checkGithub(token));
      } catch (err) {
        throw err instanceof GitHostError ? new SetupError(err.message, err.code) : err;
      }
      this.secrets.githubToken = token;
      this.config.git = { ...this.config.git, github: { login, ...(expires && { expires }) } };
    } else {
      delete this.secrets.githubToken;
      const { github: _gone, ...rest } = this.config.git ?? {};
      this.config.git = rest;
    }
    await this.save();
    await this.applyGit();
    return login ? { login } : null;
  }

  /** Starts Gitea as a job (image, start, account); the token it gives is kept. */
  startGitea(user: string, password: string): Job {
    const hook = this.o.hooks.gitea;
    if (!hook || !this.o.git) throw new SetupError("This installation cannot run Gitea");
    return this.o.core.jobs.start(
      this.o.ownerId,
      "gitea",
      ["gitea_image", "gitea_start", "account"],
      async (h) => {
        const r = await hook({ user, password }, h);
        if (!r) throw new JobFailure("start", "Gitea did not start");
        this.secrets.giteaToken = r.token;
        this.config.git = { ...this.config.git, gitea: { user, publicUrl: r.publicUrl } };
        await this.save();
        await this.applyGit();
        return { url: r.publicUrl };
      },
      { user },
    );
  }

  /** The search service in use, with what it needs; none when it lacks its address or key. */
  searchChoice(): SearchChoice | undefined {
    const c = this.config;
    const provider = c.searchProvider ?? (c.searxngUrl ? "searxng" : undefined);
    if (!provider) return undefined;
    if (provider === "searxng") return c.searxngUrl ? { provider, url: c.searxngUrl } : undefined;
    const key = this.secrets.searchKeys?.[provider];
    return key ? { provider, key } : undefined;
  }

  /** A search with these settings, before they are saved: how many results came, or why not. */
  async tryWebSearch(c: SearchChoice): Promise<{ results: number; first?: string }> {
    const key = c.key ?? this.secrets.searchKeys?.[c.provider];
    const url = c.url ?? (c.provider === "searxng" ? this.config.searxngUrl : undefined);
    const p = searchProvider({ provider: c.provider, ...(url && { url }), ...(key && { key }) });
    if (!p)
      throw new SetupError(
        c.provider === "searxng" ? "The address is missing" : "The key is missing",
      );
    try {
      const r = await p.search("RedGiant", { maxResults: 3, signal: AbortSignal.timeout(15_000) });
      return { results: r.length, ...(r[0] && { first: r[0].title }) };
    } catch (err) {
      throw new SetupError((err as Error).message);
    }
  }

  /**
   * Moves the models to an SSD the person chose (2026-11-03): the Windows engine's folder to
   * `<drive>:\\RedGiant\\models`, or to a folder of that disk the person chose (2026-11-06).
   * The engine in use starts again afterwards.
   */
  async startModelsMove(drive: string, kind: "models" = "models", folder?: string): Promise<Job> {
    const hook = this.o.hooks.moveModels;
    if (!hook) throw new SetupError("Models can be moved only in RedGiant's Windows installation");
    const hw = await detectHardware({
      dataDir: this.o.dataDir,
      ...(this.o.hooks.dockerRuntimes && { dockerRuntimes: this.o.hooks.dockerRuntimes }),
    });
    const disk = hw.disks.find((d) => d.name === drive.toUpperCase());
    if (!disk) throw new SetupError(`No disk ${drive}: on this computer`);
    if (disk.ssd === false)
      throw new SetupError(`${disk.name}: is a spinning disk, too slow for streaming`);
    const to =
      folder === undefined ? `${disk.name}:\\RedGiant\\models` : modelsFolder(disk.name, folder);
    return this.o.core.jobs.start(
      this.o.ownerId,
      "models_move",
      ["move"],
      async (h) => {
        h.step("move");
        await hook(kind, to, h);
        if (this.config.engine?.variant === "windows")
          await this.o.hooks.engine(this.config.engine).catch(() => {});
      },
      { to },
    );
  }

  /**
   * «Look for updates» (2026-11-04). On Windows RedGiant.exe looks and asks (it installs);
   * elsewhere the latest release is read from GitHub and the page says how to update.
   */
  async checkUpdates(): Promise<{
    state: "available" | "latest" | "unreachable" | "manual";
    version?: string;
  }> {
    const win = await this.o.hooks.checkUpdate?.();
    // RedGiant.exe could not reach GitHub (2026-11-05, Rig): the server tries on its own before
    // saying so; what it finds is shown as a version to download.
    if (win && win.state !== "unreachable")
      return { state: win.state as "available" | "latest", version: win.version };
    try {
      const r = await fetch("https://api.github.com/repos/Frostmoore/redgiant2/releases/latest", {
        headers: { "user-agent": "RedGiant", accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15_000),
      });
      const tag = ((await r.json()) as { tag_name?: string }).tag_name;
      return tag ? { state: "manual", version: tag.replace(/^v/, "") } : { state: "unreachable" };
    } catch {
      return { state: "unreachable" };
    }
  }

  /** RedGiant's own search engine can be started here (Docker installation). */
  get canRunSearch(): boolean {
    return !!this.o.hooks.searxng && !this.locked.search;
  }

  /**
   * Starts RedGiant's own search engine as a job (2026-11-03): the image, the container, a
   * check that it answers; then every agent and the Chat search through it.
   */
  startSearch(): Job {
    const hook = this.o.hooks.searxng;
    if (!hook || this.locked.search)
      throw new SetupError("This installation cannot run the search engine");
    const running = this.o.core.jobs
      .list(this.o.ownerId)
      .find((j) => j.kind === "searxng" && j.state === "running");
    if (running) return running;
    return this.o.core.jobs.start(
      this.o.ownerId,
      "searxng",
      ["searxng_image", "searxng_start", "searxng_check"],
      async (h) => {
        const r = await hook(true, h);
        if (!r) throw new JobFailure("searxng_silent", "The search engine did not start");
        this.config.searxngUrl = r.url;
        this.config.searxngManaged = true;
        delete this.config.searxngDeclined;
        // Another service chosen meanwhile stays the one in use.
        if (!this.config.searchProvider) this.config.searchProvider = "searxng";
        await this.save();
        await this.o.hooks.search(this.searchChoice() ?? null);
      },
    );
  }

  async stopSearch(): Promise<void> {
    await this.o.hooks.searxng?.(false);
    this.config.searxngDeclined = true;
    if (this.config.searxngManaged) {
      delete this.config.searxngUrl;
      delete this.config.searxngManaged;
      if (this.config.searchProvider === "searxng") delete this.config.searchProvider;
      await this.o.hooks.search(this.searchChoice() ?? null);
    }
    await this.save();
  }

  /**
   * Starts Pi-hole as a job (G24.14c): the image, the container on the server's home address,
   * a check that it answers for the domain. Its admin password is made here and kept.
   */
  startPihole(lanIp: string, domain?: string): Job {
    const hook = this.o.hooks.pihole;
    if (!hook) throw new SetupError("This installation cannot run Pi-hole");
    const password = this.secrets.piholePassword ?? randomBytes(12).toString("base64url");
    return this.o.core.jobs.start(
      this.o.ownerId,
      "pihole",
      ["pihole_image", "pihole_start", "pihole_check"],
      async (h) => {
        const r = await hook({ lanIp, ...(domain && { domain }), password }, h);
        if (!r) throw new JobFailure("pihole_silent", "Pi-hole did not start");
        this.secrets.piholePassword = password;
        this.config.pihole = { lanIp, ...(domain && { domain }), adminUrl: r.adminUrl };
        await this.save();
        return { url: r.adminUrl };
      },
      { lanIp },
    );
  }

  async stopPihole(): Promise<void> {
    await this.o.hooks.pihole?.(null);
    delete this.config.pihole;
    await this.save();
  }

  /** Pi-hole's admin password, for the person (shown on request, never logged). */
  piholePassword(): string | null {
    return this.config.pihole ? (this.secrets.piholePassword ?? null) : null;
  }

  /** Stops Gitea; its repositories stay, ready for the next start. */
  async stopGitea(): Promise<void> {
    await this.o.hooks.gitea?.(null);
    delete this.secrets.giteaToken;
    const { gitea: _gone, ...rest } = this.config.git ?? {};
    this.config.git = rest;
    await this.save();
    await this.applyGit();
  }

  /**
   * Opens a way in from outside home, as a job. Never without a password: the token in the
   * link would be the only lock on a public address.
   */
  async startRemote(req: RemoteRequest): Promise<Job> {
    const hook = this.o.hooks.remote;
    if (!hook) throw new SetupError("This installation cannot open access from outside");
    if (!(await this.o.core.logins.status(this.o.ownerId)).password)
      throw new SetupError("Set a password first", "no_password");
    return this.o.core.jobs.start(
      this.o.ownerId,
      "remote",
      REMOTE_STEPS[req.way],
      async (h) => {
        const r = await hook(req, h);
        if (!r) throw new JobFailure("start", "Nothing started");
        this.config.remote = { way: req.way, url: r.url };
        if (req.way === "cloudflare") this.secrets.cloudflareToken = req.token;
        await this.save();
        this.o.core.setPublicUrl(r.url);
        return r;
      },
      { way: req.way },
    );
  }

  /** Closes every way in from outside home. */
  async stopRemote(): Promise<void> {
    await this.o.hooks.remote?.(null);
    delete this.config.remote;
    delete this.secrets.cloudflareToken;
    await this.save();
    this.o.core.setPublicUrl(undefined);
  }

  /**
   * A routine on a project's repository events (G24.14c): its webhook on Gitea or GitHub,
   * pointing at the automation's address with its secret.
   */
  async repoHook(
    projectId: string,
    automationId: string,
    secret: string,
    events: string[],
  ): Promise<{ home: "gitea" | "github" }> {
    const git = this.o.git;
    if (!git) throw new SetupError("Git is not set up", "no_git");
    const { cfg, secrets } = this.gitParts();
    const path = `/api/automations/${automationId}/hook/${secret}`;
    const internal = `${process.env.REDGIANT_INTERNAL_URL ?? "http://redgiant:7600"}${path}`;
    const pub = this.config.remote?.url
      ? `${this.config.remote.url.replace(/\/+$/, "")}${path}`
      : undefined;
    try {
      return await git.hookFor(cfg, secrets, projectId, { internal, public: pub }, events);
    } catch (err) {
      if (err instanceof GitHostError) throw new SetupError(err.message, err.code);
      throw err;
    }
  }

  /** A repository for every project that has none yet; each project's result. */
  async gitSync(): Promise<{ project: string; ok: boolean; error?: string; code?: string }[]> {
    const git = this.o.git;
    if (!git) return [];
    const { cfg, secrets } = this.gitParts();
    const out: { project: string; ok: boolean; error?: string; code?: string }[] = [];
    for (const p of await this.o.core.projects.list(this.o.ownerId))
      try {
        await git.repoFor(cfg, secrets, p);
        out.push({ project: p.id, ok: true });
      } catch (err) {
        out.push({
          project: p.id,
          ok: false,
          error: (err as Error).message,
          ...(err instanceof GitHostError && { code: err.code }),
        });
      }
    return out;
  }

  /** Step "names": God and Demi-God (created if missing), God's prompt, the language. */
  async saveNames(n: {
    god: string;
    demigod: string;
    godPrompt?: string | null | undefined;
    language?: "it" | "en" | undefined;
    agentLanguage?: string | undefined;
  }) {
    const owner = this.o.ownerId;
    const reg = this.o.core.registry;
    const human = { type: "human" as const, ownerId: owner };
    let god = reg.list({ ownerId: owner }).find((a) => a.kind === "god");
    // The names before this step: a text read with them and saved now keeps them as placeholders.
    const before = god && this.o.core.promptNames(god);
    if (!god) god = await reg.create(human, { kind: "god", parentId: null, name: n.god });
    else if (god.name !== n.god) god = await reg.rename(god.id, n.god);
    const demigod = reg.list({ ownerId: owner }).find((a) => a.kind === "demigod");
    if (!demigod) await reg.create(human, { kind: "demigod", parentId: god.id, name: n.demigod });
    else if (demigod.name !== n.demigod) await reg.rename(demigod.id, n.demigod);
    // Kept with placeholders for the names; the built-in text (or none) is the built-in one again.
    if (n.godPrompt !== undefined) {
      const kept = this.o.core.keptPromptFor(god, n.godPrompt);
      await reg.configure(human, god.id, {
        systemPrompt:
          kept && before ? toPlaceholders(kept, before, new Set(["name", "demigod"])) : kept,
      });
    }
    this.setLanguages(n);
    await this.save();
  }

  /**
   * The interface's language and the agents' (G33.5), apart: new conversations speak the new one.
   * Without an agents' language yet, the agents take the interface's.
   */
  async saveLanguages(n: {
    language?: "it" | "en" | undefined;
    agentLanguage?: string | undefined;
  }): Promise<void> {
    this.setLanguages(n);
    await this.save();
  }

  private setLanguages(n: {
    language?: "it" | "en" | undefined;
    agentLanguage?: string | undefined;
  }): void {
    if (n.agentLanguage !== undefined) {
      const known = agentLanguage(n.agentLanguage);
      if (!known) throw new SetupError(`Unknown language: ${n.agentLanguage}`, "unknown_language");
      this.config.agentLanguage = known.code;
    }
    if (n.language) {
      this.config.language = n.language;
      this.o.core.setLanguage(n.language);
    }
    if (!this.config.agentLanguage && this.config.language)
      this.config.agentLanguage = this.config.language;
    this.o.core.setAgentLanguage(this.config.agentLanguage);
  }

  /** Instructions for every agent (2026-11-05): new conversations start with them. */
  async saveInstructions(text: string): Promise<void> {
    const t = text.trim();
    if (t) this.config.instructions = t;
    else delete this.config.instructions;
    this.o.core.setInstructions(t || undefined);
    await this.save();
  }

  /** The backup model for tasks given up on (2026-11-05); null: none. */
  async saveBackupModel(model: ModelSpec | null): Promise<void> {
    if (model) {
      if (!this.o.core.providers.has(model.provider))
        throw new SetupError(`${model.provider} is not connected`);
      this.config.backupModel = model;
    } else delete this.config.backupModel;
    this.o.core.setBackupModel(model ?? undefined);
    await this.save();
  }

  /** Discord, Slack, Signal, WhatsApp (G29.5): checked by connecting before anything is kept. */
  async saveChat(platform: Platform, settings: Record<string, string> | null): Promise<void> {
    if (!this.o.hooks.chat) throw new SetupError("Chat platforms are not available here");
    try {
      await this.o.hooks.chat(platform, settings);
    } catch (err) {
      const message = (err as Error).message;
      throw new SetupError(
        message,
        /401|403|invalid|unauthorized|not_authed|4004/i.test(message)
          ? "token_rejected"
          : "unreachable",
      );
    }
    const chats = { ...(this.secrets.chats ?? {}) };
    if (settings) chats[platform] = settings;
    else delete chats[platform];
    this.secrets.chats = chats;
    await this.save();
  }

  /** Step "Telegram": the token is checked with Telegram before it is kept. */
  async saveTelegram(token: string | null): Promise<{ username: string } | null> {
    if (this.locked.telegram) throw new SetupError("Telegram is set by the environment");
    let bot: { username: string } | null;
    try {
      bot = await this.o.hooks.telegram(token);
    } catch (err) {
      const message = (err as Error).message;
      // Telegram answers 401 or 404 to a token that is wrong or revoked.
      throw new SetupError(
        message,
        /401|404|unauthorized|not found|refused/i.test(message) ? "token_rejected" : "unreachable",
      );
    }
    if (token) this.secrets.telegramToken = token;
    else delete this.secrets.telegramToken;
    await this.save();
    return bot;
  }

  /**
   * Flat subscriptions (G21). Allowed only after the user read the warning on the providers'
   * terms (RD23): the token alone is not consent.
   */
  async saveSubscriptions(s: {
    claude?: { token?: string | undefined } | null | undefined;
    chatgpt?: boolean | undefined;
    /** The user read the warning on the providers' terms, next to the subscription. */
    ack?: boolean | undefined;
  }): Promise<void> {
    if (s.ack !== undefined) this.config.subscriptionAck = s.ack;
    if (s.chatgpt !== undefined) {
      if (s.chatgpt && !this.config.subscriptionAck)
        throw new SetupError("Read and accept the warning on the providers' terms first");
      if (!this.o.hooks.chatgptSubscription)
        throw new SetupError("This installation cannot run subscription engines");
      await this.o.hooks.chatgptSubscription(s.chatgpt);
      this.config.subscriptions = { ...this.config.subscriptions, chatgpt: s.chatgpt };
    }
    if (s.claude !== undefined) {
      if (s.claude && !this.config.subscriptionAck)
        throw new SetupError("Read and accept the warning on the providers' terms first");
      if (!this.o.hooks.claudeSubscription)
        throw new SetupError("This installation cannot run subscription engines");
      if (s.claude) {
        if (s.claude.token) this.secrets.claudeSubscriptionToken = s.claude.token;
        await this.o.hooks.claudeSubscription(this.secrets.claudeSubscriptionToken ?? "");
        this.config.subscriptions = { ...this.config.subscriptions, claude: true };
      } else {
        await this.o.hooks.claudeSubscription(null);
        delete this.secrets.claudeSubscriptionToken;
        this.config.subscriptions = { ...this.config.subscriptions, claude: false };
      }
    }
    await this.save();
    if (s.claude || s.chatgpt) await this.autoDefault();
  }

  private claudeLogin: ClaudeLogin | undefined;

  private claudeAuth(): ClaudeLoginOptions {
    const auth = this.o.hooks.claudeAuth?.();
    if (!auth || !this.o.hooks.claudeSubscription)
      throw new SetupError("This installation cannot run subscription engines");
    return auth;
  }

  /** Claude's subscription: on or off, who is signed in, and where its program comes from. */
  async claudeStatus(): Promise<{
    on: boolean;
    account: ClaudeAccount | null;
    program: "bundled" | "downloaded" | "system" | null;
    sharedLogin: boolean;
  }> {
    const on = this.config.subscriptions?.claude === true;
    const tool = this.toolStatus("claude");
    const auth = this.o.hooks.claudeAuth?.();
    // Asking `claude` who is signed in needs the program: not before it is here.
    const account = auth && tool.program ? await claudeAccount(auth).catch(() => null) : null;
    return { on, account, ...tool };
  }

  /** Whether a subscription's program is here, and whether the person's own sign-in is used. */
  toolStatus(name: "codex" | "claude"): {
    program: "bundled" | "downloaded" | "system" | null;
    sharedLogin: boolean;
  } {
    return this.o.hooks.toolStatus?.(name) ?? { program: "bundled", sharedLogin: false };
  }

  /**
   * Starts signing in to Claude: returns Anthropic's page. Reading the warning on the terms
   * comes with it (`ack`), as for every subscription.
   */
  async claudeLoginStart(ack: boolean): Promise<{ url: string }> {
    if (!ack && !this.config.subscriptionAck)
      throw new SetupError("Read and accept the warning on the providers' terms first", "terms");
    // Claude Code's program first (downloaded with its bar when missing, 2026-11-05).
    await this.o.hooks.prepareTool?.("claude");
    const auth = this.claudeAuth();
    this.claudeLogin?.cancel();
    if (ack && !this.config.subscriptionAck) {
      this.config.subscriptionAck = true;
      await this.save();
    }
    const login = new ClaudeLogin(auth);
    this.claudeLogin = login;
    try {
      return await login.start();
    } catch (err) {
      throw asSetupError(err);
    }
  }

  /** The code from Anthropic's page: the login is kept in the engine's folder and Claude is on. */
  async claudeLoginFinish(code: string): Promise<ClaudeAccount> {
    const login = this.claudeLogin;
    if (!login) throw new SetupError("Start signing in first", "no_login");
    try {
      await login.finish(code);
    } catch (err) {
      throw asSetupError(err);
    } finally {
      this.claudeLogin = undefined;
    }
    // The login in the folder renews itself: an old pasted token would take its place.
    delete this.secrets.claudeSubscriptionToken;
    await this.saveSubscriptions({ claude: {} });
    return claudeAccount(this.claudeAuth());
  }

  /** Signs out of Claude and switches the subscription off. */
  async claudeSignOut(): Promise<void> {
    this.claudeLogin?.cancel();
    await claudeLogout(this.claudeAuth()).catch(() => {});
    await this.saveSubscriptions({ claude: null });
  }

  /** The key a media provider uses: its own, or the chat provider's it shares. */
  private mediaKey(provider: string): string | undefined {
    const own = this.secrets.mediaKeys?.[provider];
    if (own) return own;
    const shared = mediaProvider(provider)?.sharesKeyWith;
    return shared ? this.secrets.keys?.[shared] : undefined;
  }

  private applyMedia(): void {
    const keys: Record<string, string> = {};
    for (const p of MEDIA_PROVIDERS) {
      const k = this.mediaKey(p.id);
      if (k) keys[p.id] = k;
    }
    this.o.core.setMedia({ choices: this.config.media ?? {}, keys });
  }

  /** Who makes one kind (Settings, Generation); null: nobody. */
  async saveMedia(kind: MediaKind, choice: MediaChoice | null): Promise<void> {
    if (choice) {
      const p = mediaProvider(choice.provider);
      if (!p?.models[kind])
        throw new SetupError(`${p?.name ?? choice.provider} cannot make ${kind}`);
      if (!choice.model.trim()) throw new SetupError("Choose a model");
      this.config.media = { ...this.config.media, [kind]: choice };
    } else if (this.config.media) {
      const { [kind]: _gone, ...rest } = this.config.media;
      this.config.media = rest;
    }
    await this.save();
    this.applyMedia();
  }

  /** A media provider's key; null removes it (a shared chat key stays the chat's). */
  async saveMediaKey(provider: string, key: string | null): Promise<void> {
    if (!mediaProvider(provider)) throw new SetupError(`Unknown provider "${provider}"`);
    const keys = { ...this.secrets.mediaKeys };
    if (key) keys[provider] = key.trim();
    else delete keys[provider];
    this.secrets.mediaKeys = keys;
    await this.save();
    this.applyMedia();
  }

  /** The voices for speech: ElevenLabs' from the account, the others' from the list. */
  async mediaVoices(provider: string): Promise<{ id: string; label: string }[]> {
    const p = mediaProvider(provider);
    if (!p) throw new SetupError(`Unknown provider "${provider}"`);
    if (provider !== "elevenlabs") return [...(p.voices ?? [])];
    const key = this.mediaKey(provider);
    if (!key) throw new SetupError("Add the ElevenLabs key first", "no_key");
    try {
      return await elevenVoices(key);
    } catch (err) {
      throw new SetupError((err as Error).message, "key_rejected");
    }
  }

  private applyImages(): void {
    const key = this.secrets.openaiImagesKey;
    this.o.core.setImages(
      key ? { key, ...(this.config.imagesModel && { model: this.config.imagesModel }) } : undefined,
    );
  }

  /** Step "safety and costs": what only you approve, a global budget, how long the log keeps details. */
  async saveSafety(s: {
    humanOnly?: string[] | undefined;
    disabledDanger?: string[] | undefined;
    budgetUsd?: number | null | undefined;
    retentionDays?: number | null | undefined;
    subscriptionAck?: boolean | undefined;
    guardian?: "ask" | "auto" | undefined;
    skills?: "ask" | "auto" | undefined;
  }): Promise<void> {
    const owner = this.o.ownerId;
    const core = this.o.core;
    if (s.humanOnly || s.disabledDanger || s.guardian || s.skills) {
      const p = core.policies.get(owner);
      await core.config.setPolicy(owner, "human", {
        ...p,
        ...(s.humanOnly && { humanOnly: s.humanOnly }),
        ...(s.disabledDanger && { disabledDanger: s.disabledDanger }),
        ...(s.guardian && { guardian: s.guardian }),
        ...(s.skills && { skills: s.skills }),
      });
    }
    if (s.budgetUsd !== undefined)
      await core.config.setBudget(
        owner,
        "human",
        { scope: "global", id: owner },
        s.budgetUsd === null ? {} : { usd: s.budgetUsd },
      );
    if (s.retentionDays !== undefined) {
      if (s.retentionDays === null) delete this.config.retentionDays;
      else this.config.retentionDays = s.retentionDays;
      this.scheduleRetention();
    }
    if (s.subscriptionAck !== undefined) this.config.subscriptionAck = s.subscriptionAck;
    await this.save();
  }

  async complete(): Promise<void> {
    this.config.completed = true;
    await this.save();
  }

  /** Erases payloads older than the retention period, once a day (the chain stays valid). */
  private scheduleRetention() {
    clearInterval(this.retention);
    const days = this.config.retentionDays;
    if (!days) return;
    const sweep = () =>
      void this.o.core.store
        .eraseBefore(new Date(Date.now() - days * DAY), `retention: ${days} days`, this.o.ownerId)
        .catch((err) => console.warn("retention:", err));
    sweep();
    this.retention = setInterval(sweep, DAY);
    this.retention.unref?.();
  }

  stop(): void {
    this.localVoice?.stop();
    clearInterval(this.reminder);
    clearInterval(this.retention);
  }
}
