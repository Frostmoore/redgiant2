import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import { PassThrough } from "node:stream";
import {
  type ExecOptions,
  type ExecResult,
  LocalWorkspace,
  type Terminal,
  type TerminalOptions,
} from "@redgiant/tools";
import Docker from "dockerode";
import type { Sandbox, SandboxLimits, SandboxProvider, SandboxSpec } from "./provider.js";

export interface DockerSandboxOptions {
  docker?: Docker;
  image: string;
  /** Internal network (no route outside) the sandboxes join; created if missing. */
  network: string;
  /** URL of the egress proxy as reachable from the network, e.g. `http://redgiant-egress:3128`. */
  egressProxyUrl?: string;
  /** `runsc` for gVisor; default is the engine's default runtime. */
  runtime?: string;
  defaultLimits?: SandboxLimits;
  /** uid:gid inside the container; default: the uid:gid of this process, so file owners match. */
  user?: string;
  /** Container name prefix. */
  prefix?: string;
  /** Pulls a missing image showing its progress to the person; without it, a plain pull. */
  pull?: (image: string) => Promise<void>;
  /**
   * RedGiant itself runs in a container with its data in this volume, mounted at `mountPoint`:
   * a workspace under it is mounted from the same volume (with a subpath), not by host path,
   * so it works the same on Linux, macOS and Windows.
   */
  dataVolume?: { name: string; mountPoint: string };
}

/** A bind mount under the data volume becomes a volume mount with a subpath. */
export function translateMount(
  mount: SandboxSpec["mount"],
  dataVolume?: { name: string; mountPoint: string },
): SandboxSpec["mount"] {
  if (mount.type !== "bind" || !dataVolume) return mount;
  const root = posix.normalize(dataVolume.mountPoint).replace(/\/+$/, "");
  const source = posix.normalize(mount.source.split("\\").join("/")).replace(/\/+$/, "");
  if (source === root) return { type: "volume", name: dataVolume.name };
  if (!source.startsWith(`${root}/`)) return mount;
  return { type: "volume", name: dataVolume.name, subpath: source.slice(root.length + 1) };
}

const LABEL = "io.redgiant.sandbox";

/** One container per workspace, on an internal network, with limits and no capabilities. */
export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  private readonly docker: Docker;

  constructor(private readonly o: DockerSandboxOptions) {
    this.docker = o.docker ?? new Docker();
  }

  async ensureNetwork(): Promise<void> {
    const existing = await this.docker.listNetworks({ filters: { name: [this.o.network] } });
    if (existing.some((n) => n.Name === this.o.network)) return;
    await this.docker.createNetwork({
      Name: this.o.network,
      Driver: "bridge",
      Internal: true,
      Labels: { [LABEL]: "network" },
    });
  }

  private readonly imagesReady = new Map<string, Promise<void>>();

  /** Pulls a sandbox image the first time it is needed (a fresh install has not got it). */
  ensureImage(image = this.o.image): Promise<void> {
    let ready = this.imagesReady.get(image);
    if (!ready) {
      ready = (async () => {
        const present = await this.docker
          .getImage(image)
          .inspect()
          .then(() => true)
          .catch(() => false);
        if (present) return;
        if (this.o.pull) return this.o.pull(image);
        const stream = await this.docker.pull(image);
        await new Promise<void>((resolve, reject) =>
          this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
        );
      })().catch((err) => {
        this.imagesReady.delete(image);
        throw new Error(`Cannot get the sandbox image ${image}: ${(err as Error).message}`);
      });
      this.imagesReady.set(image, ready);
    }
    return ready;
  }

  async create(spec: SandboxSpec): Promise<Sandbox> {
    await this.ensureNetwork();
    await this.ensureImage(spec.image);
    const name = `${this.o.prefix ?? "rg-sbx"}-${spec.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
    const old = this.docker.getContainer(name);
    await old.remove({ force: true }).catch(() => {});

    const limits = { ...this.o.defaultLimits, ...spec.limits };
    const proxy = this.o.egressProxyUrl;
    const env = {
      ...(proxy && {
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        // The proxy itself is reached directly (credential routes live on it).
        NO_PROXY: `localhost,127.0.0.1,${new URL(proxy).hostname}`,
        no_proxy: `localhost,127.0.0.1,${new URL(proxy).hostname}`,
        REDGIANT_EGRESS: proxy,
      }),
      ...spec.env,
    };
    const user =
      this.o.user ??
      (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : "1000:1000");
    const m = translateMount(spec.mount, this.o.dataVolume);
    const mount: Docker.MountSettings =
      m.type === "bind"
        ? {
            Type: "bind" as const,
            Source: m.source,
            Target: "/workspace",
            ReadOnly: spec.readOnly ?? false,
          }
        : {
            Type: "volume" as const,
            Source: m.name,
            Target: "/workspace",
            ReadOnly: spec.readOnly ?? false,
            // NoCopy: Docker would otherwise copy the image's /workspace (owned by root) over
            // the workspace, and the agent could no longer write in it.
            VolumeOptions: {
              NoCopy: true,
              ...(m.subpath && { Subpath: m.subpath }),
            } as Docker.MountSettings["VolumeOptions"],
          };

    const options: Docker.ContainerCreateOptions = {
      name,
      Image: spec.image ?? this.o.image,
      // Another image's own command may end at once (an interpreter): the container stays up.
      ...(spec.image && { Entrypoint: [], Cmd: ["sleep", "infinity"] }),
      User: user,
      WorkingDir: "/workspace",
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { [LABEL]: spec.id },
      HostConfig: {
        NetworkMode: this.o.network,
        Mounts: [mount],
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ...(this.o.runtime && { Runtime: this.o.runtime }),
        ...(limits.cpus !== undefined && { NanoCpus: Math.round(limits.cpus * 1e9) }),
        ...(limits.memoryMb !== undefined && {
          Memory: limits.memoryMb * 1024 * 1024,
          MemorySwap: limits.memoryMb * 1024 * 1024,
        }),
        ...(limits.pids !== undefined && { PidsLimit: limits.pids }),
        Tmpfs: { "/tmp": "rw,nosuid,size=512m" },
      },
    };
    const container: Docker.Container = await this.docker.createContainer(options);
    await container.start();
    return new DockerSandbox(spec, container, name);
  }

  /** Removes every sandbox container this provider created (e.g. at shutdown). */
  async removeAll(): Promise<number> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [LABEL] } });
    await Promise.all(
      list.map((c) =>
        this.docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {}),
      ),
    );
    return list.length;
  }
}

class DockerSandbox implements Sandbox {
  readonly id: string;

  constructor(
    private readonly spec: SandboxSpec,
    readonly container: Docker.Container,
    /** Its name: the server reaches it by name on the sandboxes' network. */
    readonly host: string,
  ) {
    this.id = spec.id;
  }

  workspace(subdir = "."): ContainerWorkspace {
    return new ContainerWorkspace(
      join(this.spec.localPath, subdir),
      posix.join("/workspace", subdir),
      this.container,
      this.spec.readOnly ?? false,
    );
  }

  async destroy(): Promise<void> {
    await this.container.remove({ force: true }).catch(() => {});
  }
}

/**
 * Files are read and written through the shared directory (fast, path-confined by
 * LocalWorkspace); commands run inside the container.
 */
export class ContainerWorkspace extends LocalWorkspace {
  constructor(
    localPath: string,
    private readonly containerPath: string,
    private readonly container: Docker.Container,
    readOnly: boolean,
  ) {
    super(localPath, readOnly);
  }

  /** An interactive login shell in the container, with a real TTY and resizing. */
  override async openTerminal({ cols, rows }: TerminalOptions): Promise<Terminal> {
    const exec = await this.container.exec({
      Cmd: ["bash", "-l"],
      Tty: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: this.containerPath,
      Env: ["TERM=xterm-256color"],
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    await exec.resize({ h: rows, w: cols }).catch(() => {});
    const decoder = new TextDecoder();
    const dataListeners: ((d: string) => void)[] = [];
    const exitListeners: ((c: number | null) => void)[] = [];
    stream.on("data", (b: Buffer) => {
      const text = decoder.decode(b, { stream: true });
      for (const l of dataListeners) l(text);
    });
    let exited = false;
    const finish = async () => {
      if (exited) return;
      exited = true;
      const code = (await exec.inspect().catch(() => undefined))?.ExitCode ?? null;
      for (const l of exitListeners) l(code);
    };
    stream.on("end", () => void finish());
    stream.on("close", () => void finish());
    return {
      write: (d) => stream.write(d),
      resize: (c, r) => void exec.resize({ h: r, w: c }).catch(() => {}),
      onData: (l) => dataListeners.push(l),
      onExit: (l) => exitListeners.push(l),
      kill: () => {
        stream.write("\u0004exit\n");
        stream.end();
      },
    };
  }

  /** Arguments are quoted here, so nothing in them is interpreted by the container's shell. */
  override execFile(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    return this.exec([file, ...args].map(shellQuote).join(" "), options);
  }

  override async exec(
    command: string,
    { timeoutMs, signal, env }: ExecOptions,
  ): Promise<ExecResult> {
    const pidFile = `/tmp/rg-exec-${randomUUID()}.pid`;
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    // `timeout` kills the command (exit 137) when it runs too long; the pid file lets an
    // abort kill it from outside.
    const script = `echo $$ > ${pidFile}; exec timeout -s KILL ${seconds} bash -c ${shellQuote(command)}`;
    const exec = await this.container.exec({
      Cmd: ["bash", "-c", script],
      WorkingDir: this.containerPath,
      ...(env && { Env: Object.entries(env).map(([k, v]) => `${k}=${v}`) }),
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const err = new PassThrough();
    let stdout = "";
    let stderr = "";
    out.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    err.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    this.container.modem.demuxStream(stream, out, err);

    const onAbort = () => {
      void this.container
        .exec({
          Cmd: ["bash", "-c", `kill -9 -- -$(cat ${pidFile}) $(cat ${pidFile}) 2>/dev/null`],
        })
        .then((e) => e.start({ hijack: true, stdin: false }))
        .catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    await new Promise<void>((done) => {
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", () => done());
    });
    signal?.removeEventListener("abort", onAbort);
    const info = await exec.inspect();
    const exitCode = info.ExitCode ?? null;
    return { stdout, stderr, exitCode, timedOut: exitCode === 137 && !signal?.aborted };
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
