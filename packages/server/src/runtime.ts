import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { KvStore, LocalEngineProvider } from "@redgiant/engine-local";
import type { Redactor, SqlClient } from "@redgiant/events";
import { keyProvider, OWN_SERVER_ID } from "@redgiant/protocol";
import {
  AnthropicProvider,
  OpenAICompatProvider,
  type ProviderRegistry,
} from "@redgiant/providers";
import { ChatgptSubscriptionProvider, ClaudeSubscriptionProvider } from "@redgiant/subscriptions";
import { migrateTelegram, TelegramGateway } from "@redgiant/telegram";
import { SearxngSearch } from "@redgiant/tools";
import type Docker from "dockerode";
import type { AppOptions } from "./app.js";
import type { RedGiantCore } from "./core.js";
import { engineError } from "./engine-errors.js";
import type { GpuAccess } from "./hardware.js";
import { JobFailure, type JobHandle } from "./jobs.js";
import type { SetupHooks } from "./setup.js";
import type { WinEngine } from "./win-engine.js";

export interface RuntimeOptions {
  core: RedGiantCore;
  providers: ProviderRegistry;
  db: SqlClient;
  redactor: Redactor;
  /** Shared with the HTTP app: the bot can start after the server. */
  telegram: NonNullable<AppOptions["telegram"]>;
  /** Where the subscription engines keep their own state (`$DATA/engines/…`). */
  dataDir?: string;
  /** The local engine, when the wizard starts it (Docker installs). */
  engine?: {
    docker: Docker;
    image: { cpu: string; cuda: string; vulkan: string };
    /** How the engine reaches a GPU that is not NVIDIA's (Vulkan): Linux's /dev/dri. */
    gpuAccess?: GpuAccess;
    /** The engine on Windows itself, driven through RedGiant.exe (G24.3b). */
    windows?: WinEngine;
    /** Gitea, when the user wants a code server of their own (G24.5). */
    gitea?: {
      image?: string;
      port?: number;
      bind?: string;
      /** How this server reaches Gitea (default `http://redgiant-gitea:3000`, inside Docker). */
      internalUrl?: string;
      /** Volumes' prefix (tests use their own). */
      volumePrefix?: string;
      /** The container's name (tests use their own). */
      name?: string;
    };
    network: string;
    modelsVolume: string;
    kvVolume: string;
    /** Where this server sees the KV volume. */
    kvDir: string;
  };
}

const ENGINE = "redgiant-engine";
const GITEA = "redgiant-gitea";

/** How the wizard's choices take effect while the server runs (G17). */
export function runtimeHooks(o: RuntimeOptions): SetupHooks {
  let gateway: TelegramGateway | undefined;
  return {
    async key(id, key) {
      const entry = keyProvider(id);
      if (!entry) throw new Error(`Unknown provider "${id}"`);
      if (!key) {
        o.providers.remove(id);
        return [];
      }
      // Checked before anything is kept: a wrong key fails here.
      let models: string[];
      if (entry.kind === "anthropic") {
        const p = new AnthropicProvider({ apiKey: key });
        await p.checkKey(AbortSignal.timeout(20_000));
        models = await p.models();
        o.providers.register(p);
      } else {
        const p = new OpenAICompatProvider({
          id,
          baseURL: entry.baseUrl ?? "",
          apiKey: key,
          effortStyle: entry.effortStyle,
          defaultContextWindow: entry.contextWindow,
          // Cloud APIs do not take back the reasoning they sent (some reject it).
          replayReasoning: false,
          sendCacheKey: id === "openai",
        });
        models = (await p.discover(AbortSignal.timeout(20_000))).map((m) => m.id);
        o.providers.register(p);
      }
      o.redactor.addSecret(id, key);
      o.core.clearKeyProblem(id);
      return models;
    },

    async server(cfg) {
      if (!cfg) {
        o.providers.remove(OWN_SERVER_ID);
        return [];
      }
      const p = new OpenAICompatProvider({
        id: OWN_SERVER_ID,
        baseURL: cfg.baseUrl,
        ...(cfg.key && { apiKey: cfg.key }),
      });
      const models = await p.discover(AbortSignal.timeout(20_000));
      if (cfg.key) o.redactor.addSecret(OWN_SERVER_ID, cfg.key);
      o.providers.register(p);
      o.core.clearKeyProblem(OWN_SERVER_ID);
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
      o.core.sendPhoto = (ownerId, png, caption) => g.sendPhoto(ownerId, png, caption);
      if (!o.telegram.webhookSecret) await g.startPolling();
      gateway = g;
      o.telegram.gateway = g;
      return me;
    },

    async claudeSubscription(token) {
      o.providers.remove("claude-subscription");
      if (token === null) return;
      if (token) o.redactor.addSecret("claude-subscription", token);
      const dir = join(o.dataDir ?? ".", "engines", "claude");
      await mkdir(join(dir, "work"), { recursive: true });
      o.providers.register(
        new ClaudeSubscriptionProvider({ token, configDir: dir, cwd: join(dir, "work") }),
      );
      o.core.clearKeyProblem("claude-subscription");
    },

    claudeAuth() {
      return { configDir: join(o.dataDir ?? ".", "engines", "claude") };
    },

    async chatgptSubscription(on) {
      const old = o.providers.has("chatgpt-subscription")
        ? (o.providers.get("chatgpt-subscription") as ChatgptSubscriptionProvider)
        : undefined;
      old?.stop();
      o.providers.remove("chatgpt-subscription");
      if (!on) return;
      const home = join(o.dataDir ?? ".", "engines", "codex");
      o.providers.register(new ChatgptSubscriptionProvider({ home, cwd: join(home, "work") }));
      o.core.clearKeyProblem("chatgpt-subscription");
    },

    async search(url) {
      o.core.setSearch(url ? new SearxngSearch(url) : undefined);
    },

    async engine(cfg, h) {
      const e = o.engine;
      if (!e) throw new Error("The local engine needs RedGiant's Docker installation");
      await e.docker
        .getContainer(ENGINE)
        .remove({ force: true })
        .catch(() => {});
      if (!cfg || cfg.variant !== "windows") await e.windows?.stop().catch(() => {});
      if (!cfg) {
        o.providers.remove("local");
        return;
      }
      if (cfg.variant === "windows") {
        const win = e.windows;
        if (!win)
          throw new JobFailure(
            "start",
            "The Windows engine exists only in RedGiant's Windows install",
          );
        const started = async () => {
          const baseURL = await win.start(cfg.model, h);
          const provider = new LocalEngineProvider({
            id: "local",
            baseURL,
            kv: new KvStore(win.kvDir),
          });
          await provider.connect();
          o.providers.register(provider);
        };
        if (h) return started();
        // At startup nobody waits: the launcher may still be starting.
        void started().catch((err) => console.warn(`engine (Windows): ${(err as Error).message}`));
        return;
      }
      const image = e.image[cfg.variant];
      const present = await e.docker
        .getImage(image)
        .inspect()
        .then(() => true)
        .catch(() => false);
      if (present) h?.skip("image");
      else {
        h?.step("image");
        await pullWithProgress(e.docker, image, h);
      }
      h?.step("start");
      const gpu = cfg.variant !== "cpu";
      let container: Docker.Container;
      try {
        container = await e.docker.createContainer({
          name: ENGINE,
          Image: image,
          Cmd: ["-m", `/models/${cfg.model}`, ...(gpu ? ["--n-gpu-layers", "999"] : [])],
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
            ...(cfg.variant === "vulkan" && {
              Devices: [
                { PathOnHost: "/dev/dri", PathInContainer: "/dev/dri", CgroupPermissions: "rwm" },
              ],
            }),
          },
        });
        await container.start();
      } catch (err) {
        throw new JobFailure(
          engineError(String((err as Error).message)) ?? "start",
          (err as Error).message,
        );
      }
      const provider = new LocalEngineProvider({
        id: "local",
        baseURL: `http://${ENGINE}:8080`,
        kv: new KvStore(e.kvDir),
      });
      o.providers.register(provider);
      const connect = () =>
        provider.connect().then(
          () => true,
          () => false,
        );
      if (!h) {
        // At startup nobody waits: connect in the background.
        void (async () => {
          for (let i = 0; i < 120; i++) {
            if (await connect()) return;
            await new Promise((r) => setTimeout(r, 5000));
          }
          console.warn("engine: the local engine did not answer within 10 minutes");
        })();
        return;
      }
      // Loading a model takes from seconds to minutes; a container that stops tells why.
      h.step("load");
      const deadline = Date.now() + 15 * 60_000;
      while (!(await connect())) {
        if (h.signal.aborted) throw new Error("cancelled");
        const state = await container.inspect().catch(() => undefined);
        if (state && (!state.State.Running || state.RestartCount > 0)) {
          const logs = await engineLogs(container);
          o.providers.remove("local");
          await container.remove({ force: true }).catch(() => {});
          throw new JobFailure(engineError(logs) ?? "engine_stopped", logs.slice(-1500));
        }
        if (Date.now() > deadline) {
          o.providers.remove("local");
          throw new JobFailure("load_timeout", "The model did not load within 15 minutes");
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      // llama.cpp falls back to the CPU when it finds no GPU, saying so only in its log.
      if (gpu && /no usable GPU found/i.test(await engineLogs(container))) {
        o.providers.remove("local");
        await container.remove({ force: true }).catch(() => {});
        throw new JobFailure("no_gpu", "llama.cpp found no usable GPU and would run on the CPU");
      }
    },

    async gitea(cfg, h) {
      const e = o.engine;
      if (!e) throw new Error("Gitea needs RedGiant's Docker installation");
      const name = e.gitea?.name ?? GITEA;
      const volumes = e.gitea?.volumePrefix ?? "redgiant-gitea";
      const old = e.docker.getContainer(name);
      if (!cfg) {
        // Off: the container goes, the repositories stay in their volume.
        await old.remove({ force: true }).catch(() => {});
        return null;
      }
      const image = e.gitea?.image ?? "gitea/gitea:28.3-rootless";
      const port = e.gitea?.port ?? 3000;
      const running = await old
        .inspect()
        .then((x) => x.State.Running)
        .catch(() => false);
      if (running) {
        h?.skip("gitea_image");
        h?.skip("gitea_start");
      } else {
        await old.remove({ force: true }).catch(() => {});
        const present = await e.docker
          .getImage(image)
          .inspect()
          .then(() => true)
          .catch(() => false);
        if (present) h?.skip("gitea_image");
        else {
          h?.step("gitea_image");
          await pullWithProgress(e.docker, image, h);
        }
        h?.step("gitea_start");
        const c = await e.docker.createContainer({
          name,
          Image: image,
          Labels: { "io.redgiant.gitea": "1" },
          Env: [
            "GITEA__security__INSTALL_LOCK=true",
            "GITEA__database__DB_TYPE=sqlite3",
            "GITEA__service__DISABLE_REGISTRATION=true",
            `GITEA__server__ROOT_URL=http://localhost:${port}/`,
          ],
          ...(e.gitea?.bind !== "" && { ExposedPorts: { "3000/tcp": {} } }),
          HostConfig: {
            RestartPolicy: { Name: "unless-stopped" },
            NetworkMode: e.network,
            // An empty bind publishes nothing (tests share a network instead).
            ...(e.gitea?.bind !== "" && {
              PortBindings: {
                "3000/tcp": [{ HostIp: e.gitea?.bind ?? "127.0.0.1", HostPort: String(port) }],
              },
            }),
            Mounts: [
              { Type: "volume", Source: `${volumes}-data`, Target: "/var/lib/gitea" },
              { Type: "volume", Source: `${volumes}-config`, Target: "/etc/gitea" },
            ],
          },
        });
        await c.start();
      }
      h?.step("account");
      const url = `${e.gitea?.internalUrl ?? `http://${GITEA}:3000`}/api/healthz`;
      for (let i = 0; ; i++) {
        if (
          await fetch(url).then(
            (r) => r.ok,
            () => false,
          )
        )
          break;
        if (i > 90) throw new JobFailure("start", "Gitea did not start within 3 minutes");
        await new Promise((r) => setTimeout(r, 2000));
      }
      const c = e.docker.getContainer(name);
      const made = await dockerExec(c, [
        "gitea",
        "admin",
        "user",
        "create",
        "--admin",
        "--username",
        cfg.user,
        "--password",
        cfg.password,
        "--email",
        `${cfg.user}@redgiant.local`,
        "--must-change-password=false",
      ]);
      if (made.code !== 0 && !/already exists/i.test(made.out))
        throw new JobFailure("account", made.out.slice(-500));
      const token = await dockerExec(c, [
        "gitea",
        "admin",
        "user",
        "generate-access-token",
        "--username",
        cfg.user,
        "--token-name",
        `redgiant-${Date.now()}`,
        "--scopes",
        "all",
        "--raw",
      ]);
      const value = token.out.trim().split(/\s+/).at(-1) ?? "";
      if (token.code !== 0 || !/^[0-9a-f]{20,}$/.test(value))
        throw new JobFailure("account", token.out.slice(-500));
      o.redactor.addSecret("gitea", value);
      return { token: value, publicUrl: `http://localhost:${port}` };
    },

    async dockerRuntimes() {
      if (!o.engine) return [];
      const info = (await o.engine.docker.info()) as { Runtimes?: Record<string, unknown> };
      return Object.keys(info.Runtimes ?? {});
    },
  };
}

/** The last lines the engine wrote. */
async function engineLogs(container: Docker.Container): Promise<string> {
  const raw = (await container
    .logs({ stdout: true, stderr: true, tail: 60 })
    .catch(() => Buffer.from(""))) as unknown as Buffer;
  // Docker multiplexes stdout and stderr with an 8-byte header per frame.
  let out = "";
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out || raw.toString("utf8");
}

/** Pulls an image, reporting the bytes of all its layers as they become known. */
async function pullWithProgress(docker: Docker, image: string, h?: JobHandle): Promise<void> {
  let stream: NodeJS.ReadableStream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw new JobFailure("image_download", (err as Error).message);
  }
  const layers = new Map<string, { current: number; total: number }>();
  h?.signal.addEventListener("abort", () => (stream as unknown as { destroy(): void }).destroy());
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(
      stream,
      (err) => (err ? reject(new JobFailure("image_download", err.message)) : resolve()),
      (ev: {
        id?: string;
        status?: string;
        progressDetail?: { current?: number; total?: number };
      }) => {
        if (!ev.id || !h) return;
        const l = layers.get(ev.id) ?? { current: 0, total: 0 };
        if (ev.status === "Downloading" && ev.progressDetail?.total) {
          l.total = ev.progressDetail.total;
          l.current = ev.progressDetail.current ?? l.current;
        } else if (ev.status === "Download complete" || ev.status === "Pull complete") {
          l.current = l.total;
        }
        layers.set(ev.id, l);
        let done = 0;
        let total = 0;
        for (const x of layers.values()) {
          done += x.current;
          total += x.total;
        }
        if (total > 0) h.progress(done, total);
      },
    ),
  );
}

/** Runs a command in a container (arguments, never a shell); its exit code and output. */
async function dockerExec(
  c: Docker.Container,
  cmd: string[],
): Promise<{ code: number; out: string }> {
  const ex = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("end", resolve);
    stream.on("error", () => resolve());
  });
  const raw = Buffer.concat(chunks);
  // Multiplexed: an 8-byte header per frame.
  let out = "";
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  const info = await ex.inspect();
  return { code: info.ExitCode ?? 1, out: out || raw.toString("utf8") };
}
