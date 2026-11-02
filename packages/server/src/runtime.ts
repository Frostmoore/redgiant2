import { Resolver } from "node:dns/promises";
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
import { JobFailure, type JobHandle, type Jobs } from "./jobs.js";
import { startRemote, stopRemote } from "./remote.js";
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
    /** Pi-hole, the home's DNS by choice (G24.14c). */
    pihole?: {
      image?: string;
      name?: string;
      volumePrefix?: string;
      /** "" publishes nothing (tests share a network instead); else ports on the home address. */
      bind?: string;
      /** Where the check asks it (tests: 127.0.0.1); default its address on `network`. */
      checkAt?: string;
      /** Its admin page's port inside (tests change it when sharing a network). */
      webPort?: number;
    };
    network: string;
    modelsVolume: string;
    kvVolume: string;
    /** Where this server sees the KV volume. */
    kvDir: string;
  };
}

const ENGINE = "redgiant-engine";
const PIHOLE = "redgiant-pihole";
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
      o.core.sendFile = (ownerId, data, name, mime, caption) =>
        g.sendFile(ownerId, data, name, mime, caption);
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

    async pihole(cfg, h) {
      const e = o.engine;
      if (!e) throw new Error("Pi-hole needs RedGiant's Docker installation");
      const p = e.pihole ?? {};
      const name = p.name ?? PIHOLE;
      const old = e.docker.getContainer(name);
      // Settings may have changed: it is always started anew (its data stay in the volume).
      await old.remove({ force: true }).catch(() => {});
      if (!cfg) return null;
      const image = p.image ?? "pihole/pihole:2026.10.1";
      const present = await e.docker
        .getImage(image)
        .inspect()
        .then(() => true)
        .catch(() => false);
      if (present) h?.skip("pihole_image");
      else {
        h?.step("pihole_image");
        await pullWithProgress(e.docker, image, h);
      }
      h?.step("pihole_start");
      const webPort = p.webPort ?? 80;
      const publish = p.bind !== "";
      const c = await e.docker.createContainer({
        name,
        Image: image,
        Labels: { "io.redgiant.pihole": "1" },
        Env: [
          `TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`,
          `FTLCONF_webserver_api_password=${cfg.password}`,
          "FTLCONF_dns_listeningMode=all",
          `FTLCONF_webserver_port=${webPort}`,
          ...(cfg.domain ? [`FTLCONF_dns_hosts=${cfg.lanIp} ${cfg.domain}`] : []),
        ],
        ...(publish && {
          ExposedPorts: { "53/tcp": {}, "53/udp": {}, [`${webPort}/tcp`]: {} },
        }),
        HostConfig: {
          RestartPolicy: { Name: "unless-stopped" },
          NetworkMode: e.network,
          // DNS only on the server's home address: never on the whole internet.
          ...(publish && {
            PortBindings: {
              "53/tcp": [{ HostIp: cfg.lanIp, HostPort: "53" }],
              "53/udp": [{ HostIp: cfg.lanIp, HostPort: "53" }],
              [`${webPort}/tcp`]: [{ HostIp: cfg.lanIp, HostPort: "8053" }],
            },
          }),
          Mounts: [
            {
              Type: "volume",
              Source: `${p.volumePrefix ?? "redgiant-pihole"}-etc`,
              Target: "/etc/pihole",
            },
          ],
        },
      });
      try {
        await c.start();
      } catch (err) {
        await c.remove({ force: true }).catch(() => {});
        const m = (err as Error).message;
        if (/address already in use|port is already allocated/i.test(m))
          throw new JobFailure(
            "port_busy",
            `Port 53 on ${cfg.lanIp} is already used by another DNS (often the system's own)`,
          );
        if (/cannot assign requested address/i.test(m))
          throw new JobFailure("wrong_address", `${cfg.lanIp} is not an address of this computer`);
        throw err;
      }
      h?.step("pihole_check");
      const at =
        p.checkAt ??
        (await c.inspect()).NetworkSettings.Networks[e.network]?.IPAddress ??
        cfg.lanIp;
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers([at]);
      for (let i = 0; ; i++) {
        const ok = await resolver
          .resolve4(cfg.domain ?? "pi.hole")
          .then((a) => !cfg.domain || a.includes(cfg.lanIp))
          .catch(() => false);
        if (ok) break;
        if (i > 45)
          throw new JobFailure("pihole_silent", "Pi-hole did not answer within 90 seconds");
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { adminUrl: `http://${cfg.lanIp}:8053/admin/` };
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
            // Routines on repository events (G24.14c): Gitea may call RedGiant inside Docker.
            "GITEA__webhook__ALLOWED_HOST_LIST=external,redgiant",
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

    async remote(req, h) {
      const e = o.engine;
      if (!e) throw new Error("Access from outside needs RedGiant's Docker installation");
      const ro = {
        docker: e.docker,
        network: e.network,
        pull: (image: string, jh?: JobHandle) => pullWithProgress(e.docker, image, jh),
        exec: dockerExec,
        hide: (name: string, value: string) => o.redactor.addSecret(name, value),
      };
      if (!req) {
        await stopRemote(ro);
        return null;
      }
      return startRemote(ro, req, h);
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

/** Registry, repository and tag of an image reference. */
export function splitImage(ref: string): { registry: string; repo: string; tag: string } {
  const at = ref.lastIndexOf(":");
  const tagged = at > ref.lastIndexOf("/");
  const name = tagged ? ref.slice(0, at) : ref;
  const tag = tagged ? ref.slice(at + 1) : "latest";
  const first = name.split("/")[0] ?? "";
  if (name.includes("/") && (first.includes(".") || first.includes(":")))
    return { registry: first, repo: name.slice(first.length + 1), tag };
  return {
    registry: "registry-1.docker.io",
    repo: name.includes("/") ? name : `library/${name}`,
    tag,
  };
}

const MANIFESTS = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

/**
 * The size of every layer of an image for this machine, from its registry (anonymous pull), keyed
 * by the 12-character id Docker reports: so a download shows its true total from the start.
 * Empty when the registry cannot tell (private image, no network): the bar then grows as it goes.
 */
export async function layerSizes(image: string, fetcher = fetch): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    const { registry, repo, tag } = splitImage(image);
    const auth =
      registry === "registry-1.docker.io"
        ? `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`
        : `https://${registry}/token?scope=repository:${repo}:pull`;
    const { token } = (await (await fetcher(auth)).json()) as { token?: string };
    const get = async (ref: string) =>
      (await (
        await fetcher(`https://${registry}/v2/${repo}/manifests/${ref}`, {
          headers: { Accept: MANIFESTS, ...(token && { Authorization: `Bearer ${token}` }) },
        })
      ).json()) as {
        manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[];
        layers?: { digest: string; size: number }[];
      };
    let m = await get(tag);
    const arch = process.arch === "arm64" ? "arm64" : "amd64";
    const own = m.manifests?.find(
      (x) => x.platform?.os === "linux" && x.platform.architecture === arch,
    );
    if (own) m = await get(own.digest);
    for (const l of m.layers ?? []) sizes.set(l.digest.slice(7, 19), l.size);
  } catch {
    sizes.clear();
  }
  return sizes;
}

/** Pulls an image, reporting the bytes of all its layers: their sizes from the registry first. */
export async function pullWithProgress(
  docker: Docker,
  image: string,
  h?: JobHandle,
  sizes: (image: string) => Promise<Map<string, number>> = layerSizes,
): Promise<void> {
  const known = h ? await sizes(image) : new Map<string, number>();
  let stream: NodeJS.ReadableStream;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    throw new JobFailure("image_download", (err as Error).message);
  }
  const layers = new Map<string, { current: number; total: number }>();
  for (const [id, size] of known) layers.set(id, { current: 0, total: size });
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
        if (ev.status === "Downloading") {
          if (ev.progressDetail?.total) l.total = ev.progressDetail.total;
          l.current = ev.progressDetail?.current ?? l.current;
        } else if (
          ev.status === "Download complete" ||
          ev.status === "Pull complete" ||
          ev.status === "Already exists" ||
          ev.status === "Extracting" ||
          ev.status === "Verifying Checksum"
        ) {
          l.current = l.total;
        } else if (!layers.has(ev.id)) return;
        layers.set(ev.id, l);
        let done = 0;
        let total = 0;
        for (const x of layers.values()) {
          done += Math.min(x.current, x.total || x.current);
          total += x.total;
        }
        if (total > 0) h.progress(Math.min(done, total), total);
      },
    ),
  );
}

/**
 * Pulls an image RedGiant needs on its own (the agents' computer, their browser) as a job, so
 * the person sees a bar with the speed and the time left (decision 2026-11-02: every download
 * shows its progress). One job per image at a time; an image already there is not pulled.
 */
export function backgroundPuller(
  docker: Docker,
  jobs: Jobs,
  owner: () => string,
  sizes: (image: string) => Promise<Map<string, number>> = layerSizes,
): (image: string, what: "sandbox" | "browser") => Promise<void> {
  const running = new Map<string, Promise<void>>();
  return (image, what) => {
    let p = running.get(image);
    if (!p) {
      p = (async () => {
        const present = await docker
          .getImage(image)
          .inspect()
          .then(() => true)
          .catch(() => false);
        if (present) return;
        const job = jobs.start(
          owner(),
          `download_${what}`,
          ["image_download"],
          async (h) => {
            h.step("image_download");
            await pullWithProgress(docker, image, h, sizes);
          },
          { image },
        );
        const end = await jobs.settled(job.id, 500);
        if (end?.state !== "done") throw new Error(end?.error?.message ?? `Cannot pull ${image}`);
      })().finally(() => running.delete(image));
      running.set(image, p);
    }
    return p;
  };
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
