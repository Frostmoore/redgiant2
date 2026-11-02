import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";
import { DEFAULT_POLICY } from "@redgiant/hierarchy";
import type { Job } from "@redgiant/protocol";
import { keyProvider, type ModelSpec, OWN_SERVER_ID } from "@redgiant/protocol";
import { ProviderError } from "@redgiant/providers";
import {
  type ClaudeAccount,
  ClaudeLogin,
  ClaudeLoginError,
  type ClaudeLoginOptions,
  claudeAccount,
  claudeLogout,
} from "@redgiant/subscriptions";
import { stringify } from "yaml";
import type { RedGiantCore } from "./core.js";
import { GitHostError, type GitHosts, type GitHostsConfig } from "./git-hosts.js";
import { detectHardware, type EngineVariant, type Hardware } from "./hardware.js";
import { JobFailure, type JobHandle } from "./jobs.js";
import { REMOTE_STEPS, type RemoteRequest } from "./remote.js";

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
  search(url: string | null): Promise<void>;
  /** Claude on a flat subscription (G21): its token, "" for the login already in its folder, null off. */
  claudeSubscription?(token: string | null): Promise<void>;
  /** Where Claude's engine keeps its login, for signing in from the browser (G24.2). */
  claudeAuth?(): ClaudeLoginOptions;
  /** ChatGPT on a flat subscription (G21): its login lives in Codex's own folder. */
  chatgptSubscription?(on: boolean): Promise<void>;
  /**
   * Starts the local engine container with this model file (null stops it); with a job, it
   * reports its steps (`image`, `start`, `load`) and throws `JobFailure`s the UI explains.
   */
  engine(o: { variant: EngineVariant; model: string } | null, h?: JobHandle): Promise<void>;
  dockerRuntimes?(): Promise<string[]>;
  /**
   * Gitea, the code server of one's own (G24.5): started (or found running) with an admin of
   * this name and password; returns a token for RedGiant. null stops it (the repositories stay).
   */
  gitea?(
    o: { user: string; password: string } | null,
    h?: JobHandle,
  ): Promise<{ token: string; publicUrl: string } | null>;
  /** A way to reach RedGiant from outside home (G24.6); null switches every way off. */
  remote?(req: RemoteRequest | null, h?: JobHandle): Promise<{ url: string } | null>;
}

export interface SetupConfig {
  completed: boolean;
  language?: "it" | "en";
  defaultModel?: ModelSpec;
  /** Providers connected with a key (the keys are in the secrets). */
  keyProviders?: string[];
  /** The user's own OpenAI-compatible server (its key, if any, is in the secrets). */
  server?: { baseUrl: string };
  searxngUrl?: string;
  /** Speech to text for voice messages; its key, if any, is in the secrets. */
  transcription?: { api: "whisper-asr" | "openai"; url: string; model?: string };
  /** Flat subscriptions switched on (their tokens are in the secrets). */
  subscriptions?: { claude?: boolean; chatgpt?: boolean };
  /** Image generation: the model, when not the default (the OpenAI key is in the secrets). */
  imagesModel?: string;
  engine?: { variant: EngineVariant; model: string };
  retentionDays?: number;
  /** The user read that a personal subscription may not be allowed in third-party tools (RD23). */
  subscriptionAck?: boolean;
  /** Standard (everything ready, nothing reachable from outside) or advanced (G24.5). */
  mode?: "standard" | "advanced";
  /** Where the code lives: GitHub and/or Gitea (their tokens are in the secrets). */
  git?: GitHostsConfig;
  /** How RedGiant is reached from outside home, and at which address (G24.6). */
  remote?: { way: RemoteRequest["way"]; url: string };
}

interface Secrets {
  /** Keys of the providers in `KEY_PROVIDERS`, by id. */
  keys?: Record<string, string>;
  serverKey?: string;
  telegramToken?: string;
  transcriptionKey?: string;
  openaiImagesKey?: string;
  claudeSubscriptionToken?: string;
  githubToken?: string;
  giteaToken?: string;
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

export interface SetupState {
  config: SetupConfig;
  secretsSet: {
    /** Providers with a saved key. */
    keys: string[];
    server: boolean;
    telegram: boolean;
    transcription: boolean;
    images: boolean;
    claudeSubscription: boolean;
    github: boolean;
    gitea: boolean;
  };
  locked: Locked;
  providers: string[];
  hardware: Hardware;
  names: { god: string | null; demigod: string | null; godPrompt: string | null };
  policy: {
    humanOnly: string[];
    disabledDanger: string[];
    dangers: { id: string }[];
  };
  budgetUsd: number | null;
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
    if (!this.locked.search && c.searxngUrl) await run("search", h.search(c.searxngUrl));
    if (!this.locked.engine && c.engine) await run("engine", h.engine(c.engine));
    if (!this.locked.voice && c.transcription) this.applyTranscription();
    if (!this.locked.images && s.openaiImagesKey) this.applyImages();
    if (c.subscriptions?.chatgpt && h.chatgptSubscription)
      await run("ChatGPT subscription", h.chatgptSubscription(true));
    if (c.subscriptions?.claude && h.claudeSubscription)
      await run("Claude subscription", h.claudeSubscription(s.claudeSubscriptionToken ?? ""));
    if (!this.locked.defaultModel && c.defaultModel) this.o.core.setDefaultModel(c.defaultModel);
    if (c.language) this.o.core.setLanguage(c.language);
    if (!this.locked.telegram && s.telegramToken)
      await run("Telegram", h.telegram(s.telegramToken));
    await run("git routes", this.applyGit());
    this.scheduleTokenReminder();
    this.scheduleRetention();
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
        transcription: Boolean(this.secrets.transcriptionKey),
        images: Boolean(this.secrets.openaiImagesKey),
        claudeSubscription: Boolean(this.secrets.claudeSubscriptionToken),
        github: Boolean(this.secrets.githubToken),
        gitea: Boolean(this.secrets.giteaToken),
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
        godPrompt: god?.systemPrompt ?? null,
      },
      policy: {
        humanOnly: policy.humanOnly ?? DEFAULT_POLICY.humanOnly,
        disabledDanger: policy.disabledDanger,
        dangers: DEFAULT_POLICY.danger.map((d) => ({ id: d.id })),
      },
      budgetUsd: global?.limit.usd ?? null,
    };
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
    return { models };
  }

  /** Search, voice messages, pictures and the default model (Settings, General). */
  async saveModels(m: {
    searxngUrl?: string | null | undefined;
    /** null removes the key; a model alone keeps the saved key. */
    images?: { key?: string | undefined; model?: string | undefined } | null | undefined;
    transcription?:
      | {
          api: "whisper-asr" | "openai";
          url: string;
          model?: string | undefined;
          key?: string | undefined;
        }
      | null
      | undefined;
    defaultModel?: ModelSpec | undefined;
  }): Promise<void> {
    if (m.searxngUrl !== undefined && !this.locked.search) {
      await this.o.hooks.search(m.searxngUrl);
      if (m.searxngUrl) this.config.searxngUrl = m.searxngUrl;
      else delete this.config.searxngUrl;
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
    this.o.core.setTranscription(
      t && { ...t, ...(this.secrets.transcriptionKey && { key: this.secrets.transcriptionKey }) },
    );
  }

  /**
   * Starts the local engine as a job the UI follows: the engine's image (downloaded if
   * missing), the container, the model loaded, a first answer. Kept only when it answers.
   */
  startEngine(e: { variant: EngineVariant; model: string }): Job {
    this.checkEngine(e);
    return this.o.core.jobs.start(
      this.o.ownerId,
      "engine",
      ["image", "start", "load", "try"],
      async (h) => {
        await this.o.hooks.engine(e, h);
        h.step("try");
        try {
          await this.o.core.trialModel(this.o.ownerId, { provider: "local", model: e.model });
        } catch (err) {
          throw new JobFailure("no_answer", (err as Error).message);
        }
        this.config.engine = e;
        await this.save();
      },
      { model: e.model },
    );
  }

  private checkEngine(e: { variant: EngineVariant; model: string } | null): void {
    if (this.locked.engine) throw new SetupError("The local engine is set by the environment");
    if (e && (e.model.includes("/") || e.model.includes("..") || !e.model.endsWith(".gguf")))
      throw new SetupError("The model is a .gguf file in the models folder");
  }

  async saveEngine(e: { variant: EngineVariant; model: string } | null): Promise<void> {
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
    const date = new Date(expires).toLocaleDateString(
      this.config.language === "it" ? "it-IT" : "en-GB",
    );
    await this.o.core.tell(
      this.o.ownerId,
      this.config.language === "it"
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
  }) {
    const owner = this.o.ownerId;
    const reg = this.o.core.registry;
    const human = { type: "human" as const, ownerId: owner };
    let god = reg.list({ ownerId: owner }).find((a) => a.kind === "god");
    if (!god) god = await reg.create(human, { kind: "god", parentId: null, name: n.god });
    else if (god.name !== n.god) god = await reg.rename(god.id, n.god);
    const demigod = reg.list({ ownerId: owner }).find((a) => a.kind === "demigod");
    if (!demigod) await reg.create(human, { kind: "demigod", parentId: god.id, name: n.demigod });
    else if (demigod.name !== n.demigod) await reg.rename(demigod.id, n.demigod);
    if (n.godPrompt !== undefined)
      await reg.configure(human, god.id, { systemPrompt: n.godPrompt });
    if (n.language) {
      this.config.language = n.language;
      this.o.core.setLanguage(n.language);
    }
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
  }

  private claudeLogin: ClaudeLogin | undefined;

  private claudeAuth(): ClaudeLoginOptions {
    const auth = this.o.hooks.claudeAuth?.();
    if (!auth || !this.o.hooks.claudeSubscription)
      throw new SetupError("This installation cannot run subscription engines");
    return auth;
  }

  /** Claude's subscription: on or off, and who is signed in. */
  async claudeStatus(): Promise<{ on: boolean; account: ClaudeAccount | null }> {
    const on = this.config.subscriptions?.claude === true;
    const auth = this.o.hooks.claudeAuth?.();
    return { on, account: auth ? await claudeAccount(auth).catch(() => null) : null };
  }

  /**
   * Starts signing in to Claude: returns Anthropic's page. Reading the warning on the terms
   * comes with it (`ack`), as for every subscription.
   */
  async claudeLoginStart(ack: boolean): Promise<{ url: string }> {
    if (!ack && !this.config.subscriptionAck)
      throw new SetupError("Read and accept the warning on the providers' terms first", "terms");
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
  }): Promise<void> {
    const owner = this.o.ownerId;
    const core = this.o.core;
    if (s.humanOnly || s.disabledDanger) {
      const p = core.policies.get(owner);
      await core.config.setPolicy(owner, "human", {
        ...p,
        ...(s.humanOnly && { humanOnly: s.humanOnly }),
        ...(s.disabledDanger && { disabledDanger: s.disabledDanger }),
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
    clearInterval(this.reminder);
    clearInterval(this.retention);
  }
}
