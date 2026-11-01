import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlClient } from "@redgiant/events";
import { DEFAULT_POLICY } from "@redgiant/hierarchy";
import type { ModelSpec } from "@redgiant/protocol";
import { stringify } from "yaml";
import type { RedGiantCore } from "./core.js";
import { detectHardware, type Hardware } from "./hardware.js";

/** Applies a choice while the server runs (set by main.ts; tests pass fakes). */
export interface SetupHooks {
  /** Registers the Anthropic provider with this key (null removes it). */
  anthropic(key: string | null): Promise<void>;
  /** Registers an OpenAI-compatible server; returns the models it offers. */
  openai(o: { baseUrl: string; key?: string | undefined } | null): Promise<string[]>;
  /** Starts Demi-God's bot (null stops it); returns the bot's username. */
  telegram(token: string | null): Promise<{ username: string } | null>;
  search(url: string | null): Promise<void>;
  /** Starts the local engine container with this model file (null stops it). */
  engine(o: { variant: "cpu" | "cuda"; model: string } | null): Promise<void>;
  dockerRuntimes?(): Promise<string[]>;
}

export interface SetupConfig {
  completed: boolean;
  language?: "it" | "en";
  defaultModel?: ModelSpec;
  openaiBaseUrl?: string;
  searxngUrl?: string;
  engine?: { variant: "cpu" | "cuda"; model: string };
  retentionDays?: number;
  /** The user read that a personal subscription may not be allowed in third-party tools (RD23). */
  subscriptionAck?: boolean;
}

interface Secrets {
  anthropicKey?: string;
  openaiKey?: string;
  telegramToken?: string;
}

/** What the environment already sets: the wizard shows it and does not change it. */
export interface Locked {
  anthropic?: boolean;
  openai?: boolean;
  telegram?: boolean;
  defaultModel?: boolean;
  search?: boolean;
  engine?: boolean;
}

export interface SetupState {
  config: SetupConfig;
  secretsSet: { anthropic: boolean; openai: boolean; telegram: boolean };
  locked: Locked;
  providers: string[];
  hardware: Hardware;
  names: { god: string | null; demigod: string | null; godPrompt: string | null };
  policy: {
    humanOnly: string[];
    disabledDanger: string[];
    dangers: { id: string; label: string }[];
  };
  budgetUsd: number | null;
}

export class SetupError extends Error {}

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
    if (!this.locked.anthropic && s.anthropicKey)
      await run("Anthropic", h.anthropic(s.anthropicKey));
    if (!this.locked.openai && c.openaiBaseUrl)
      await run(
        "OpenAI-compatible",
        h.openai({ baseUrl: c.openaiBaseUrl, ...(s.openaiKey && { key: s.openaiKey }) }),
      );
    if (!this.locked.search && c.searxngUrl) await run("search", h.search(c.searxngUrl));
    if (!this.locked.engine && c.engine) await run("engine", h.engine(c.engine));
    if (!this.locked.defaultModel && c.defaultModel) this.o.core.setDefaultModel(c.defaultModel);
    if (!this.locked.telegram && s.telegramToken)
      await run("Telegram", h.telegram(s.telegramToken));
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
        anthropic: Boolean(this.secrets.anthropicKey),
        openai: Boolean(this.secrets.openaiKey),
        telegram: Boolean(this.secrets.telegramToken),
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
        dangers: DEFAULT_POLICY.danger.map((d) => ({ id: d.id, label: d.label })),
      },
      budgetUsd: global?.limit.usd ?? null,
    };
  }

  /** Step "models": cloud keys, an OpenAI-compatible server, search, and the default model. */
  async saveModels(m: {
    anthropicKey?: string | null | undefined;
    openai?: { baseUrl: string; key?: string | undefined } | null | undefined;
    searxngUrl?: string | null | undefined;
    defaultModel?: ModelSpec | undefined;
  }): Promise<{ openaiModels: string[] }> {
    let openaiModels: string[] = [];
    if (m.anthropicKey !== undefined && !this.locked.anthropic) {
      await this.o.hooks.anthropic(m.anthropicKey);
      if (m.anthropicKey) this.secrets.anthropicKey = m.anthropicKey;
      else delete this.secrets.anthropicKey;
    }
    if (m.openai !== undefined && !this.locked.openai) {
      openaiModels = await this.o.hooks.openai(m.openai);
      if (m.openai) {
        this.config.openaiBaseUrl = m.openai.baseUrl;
        if (m.openai.key) this.secrets.openaiKey = m.openai.key;
      } else {
        delete this.config.openaiBaseUrl;
        delete this.secrets.openaiKey;
      }
    }
    if (m.searxngUrl !== undefined && !this.locked.search) {
      await this.o.hooks.search(m.searxngUrl);
      if (m.searxngUrl) this.config.searxngUrl = m.searxngUrl;
      else delete this.config.searxngUrl;
    }
    if (m.defaultModel && !this.locked.defaultModel) {
      // A model that cannot answer is not made the default.
      await this.o.core.trialModel(this.o.ownerId, m.defaultModel);
      this.config.defaultModel = m.defaultModel;
      this.o.core.setDefaultModel(m.defaultModel);
    }
    await this.save();
    return { openaiModels };
  }

  async saveEngine(e: { variant: "cpu" | "cuda"; model: string } | null): Promise<void> {
    if (this.locked.engine) throw new SetupError("The local engine is set by the environment");
    if (e && (e.model.includes("/") || e.model.includes("..") || !e.model.endsWith(".gguf")))
      throw new SetupError("The model is a .gguf file in the models folder");
    await this.o.hooks.engine(e);
    if (e) this.config.engine = e;
    else delete this.config.engine;
    await this.save();
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
    if (n.language) this.config.language = n.language;
    await this.save();
  }

  /** Step "Telegram": the token is checked with Telegram before it is kept. */
  async saveTelegram(token: string | null): Promise<{ username: string } | null> {
    if (this.locked.telegram) throw new SetupError("Telegram is set by the environment");
    const bot = await this.o.hooks.telegram(token);
    if (token) this.secrets.telegramToken = token;
    else delete this.secrets.telegramToken;
    await this.save();
    return bot;
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
    clearInterval(this.retention);
  }
}
