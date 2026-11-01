import { KvStore, LocalEngineProvider } from "@redgiant/engine-local";
import type { Redactor, SqlClient } from "@redgiant/events";
import {
  AnthropicProvider,
  OpenAICompatProvider,
  type ProviderRegistry,
} from "@redgiant/providers";
import { migrateTelegram, TelegramGateway } from "@redgiant/telegram";
import { SearxngSearch } from "@redgiant/tools";
import type Docker from "dockerode";
import type { AppOptions } from "./app.js";
import type { RedGiantCore } from "./core.js";
import type { SetupHooks } from "./setup.js";

export interface RuntimeOptions {
  core: RedGiantCore;
  providers: ProviderRegistry;
  db: SqlClient;
  redactor: Redactor;
  /** Shared with the HTTP app: the bot can start after the server. */
  telegram: NonNullable<AppOptions["telegram"]>;
  /** The local engine, when the wizard starts it (Docker installs). */
  engine?: {
    docker: Docker;
    image: { cpu: string; cuda: string };
    network: string;
    modelsVolume: string;
    kvVolume: string;
    /** Where this server sees the KV volume. */
    kvDir: string;
  };
}

const ENGINE = "redgiant-engine";

/** How the wizard's choices take effect while the server runs (G17). */
export function runtimeHooks(o: RuntimeOptions): SetupHooks {
  let gateway: TelegramGateway | undefined;
  return {
    async anthropic(key) {
      if (!key) {
        o.providers.remove("anthropic");
        return;
      }
      o.redactor.addSecret("anthropic", key);
      o.providers.register(new AnthropicProvider({ apiKey: key }));
      o.core.clearKeyProblem("anthropic");
    },

    async openai(cfg) {
      if (!cfg) {
        o.providers.remove("openai");
        return [];
      }
      if (cfg.key) o.redactor.addSecret("openai", cfg.key);
      const p = new OpenAICompatProvider({
        id: "openai",
        baseURL: cfg.baseUrl,
        ...(cfg.key && { apiKey: cfg.key }),
      });
      const models = await p.discover();
      o.providers.register(p);
      o.core.clearKeyProblem("openai");
      return models.map((m) => m.id);
    },

    async telegram(token) {
      await gateway?.stop();
      gateway = undefined;
      delete o.telegram.gateway;
      if (!token) return null;
      const g = new TelegramGateway({ token, db: o.db, host: o.core });
      const me = await g.init(); // a wrong token fails here, before anything is kept
      o.redactor.addSecret("telegram-bot", token);
      await migrateTelegram(o.db);
      o.core.notify = (ownerId, text) => g.notify(ownerId, text);
      if (!o.telegram.webhookSecret) await g.startPolling();
      gateway = g;
      o.telegram.gateway = g;
      return me;
    },

    async search(url) {
      o.core.setSearch(url ? new SearxngSearch(url) : undefined);
    },

    async engine(cfg) {
      const e = o.engine;
      if (!e) throw new Error("The local engine needs RedGiant's Docker installation");
      await e.docker
        .getContainer(ENGINE)
        .remove({ force: true })
        .catch(() => {});
      if (!cfg) {
        o.providers.remove("local");
        return;
      }
      const image = cfg.variant === "cuda" ? e.image.cuda : e.image.cpu;
      const present = await e.docker
        .getImage(image)
        .inspect()
        .then(() => true)
        .catch(() => false);
      if (!present) {
        const stream = await e.docker.pull(image);
        await new Promise<void>((resolve, reject) =>
          e.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
        );
      }
      const container = await e.docker.createContainer({
        name: ENGINE,
        Image: image,
        Cmd: [
          "-m",
          `/models/${cfg.model}`,
          ...(cfg.variant === "cuda" ? ["--n-gpu-layers", "999"] : []),
        ],
        Labels: { "io.redgiant.engine": "1" },
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
          NetworkMode: e.network,
          Mounts: [
            { Type: "volume", Source: e.modelsVolume, Target: "/models", ReadOnly: true },
            { Type: "volume", Source: e.kvVolume, Target: "/kv" },
          ],
          ...(cfg.variant === "cuda" && {
            DeviceRequests: [{ Driver: "nvidia", Count: -1, Capabilities: [["gpu"]] }],
          }),
        },
      });
      await container.start();
      const provider = new LocalEngineProvider({
        id: "local",
        baseURL: `http://${ENGINE}:8080`,
        kv: new KvStore(e.kvDir),
      });
      o.providers.register(provider);
      // The model takes a while to load: connect in the background.
      void (async () => {
        for (let i = 0; i < 120; i++) {
          if (
            await provider.connect().then(
              () => true,
              () => false,
            )
          )
            return;
          await new Promise((r) => setTimeout(r, 5000));
        }
        console.warn("engine: the local engine did not answer within 10 minutes");
      })();
    },

    async dockerRuntimes() {
      if (!o.engine) return [];
      const info = (await o.engine.docker.info()) as { Runtimes?: Record<string, unknown> };
      return Object.keys(info.Runtimes ?? {});
    },
  };
}
