// The asking side of a node's capabilities (G39.4): a sandbox there as a `SandboxProvider` and a
// `Workspace` (every call travels over the node channel and is checked again there), and the
// node's models as a provider «via <node>» (the node's keys never leave it: it answers with them).

import {
  type Completion,
  type CompletionRequest,
  type ModelInfo,
  type Provider,
  ProviderError,
  type StreamEvent,
} from "@redgiant/providers";
import type { Sandbox, SandboxProvider, SandboxSpec } from "@redgiant/sandbox";
import {
  type ExecOptions,
  type ExecResult,
  type Terminal,
  TerminalUnavailableError,
  type Workspace,
} from "@redgiant/tools";
import type { NodeError, Nodes } from "./service.js";

/** Where a request is logged on the asking side: the conversation that asked. */
export interface NodeLogPlace {
  projectId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}

/** A sandbox name for the node: the spec id with only safe characters. */
const sandboxName = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80) || "default";

export interface NodeTarget {
  nodes: Nodes;
  ownerId: string;
  /** The node's fingerprint and name. */
  fingerprint: string;
  name: string;
}

/** A workspace on a node: files and commands in the node's sandbox kept for this machine. */
export class NodeWorkspace implements Workspace {
  readonly readOnly: boolean;

  constructor(
    private readonly t: NodeTarget,
    private readonly sandbox: string,
    /** The node's own path of the sandbox folder (reported by the node). */
    readonly root: string,
    readOnly = false,
    /** Truly dangerous checks the person said yes to, for the next command (set by the tool). */
    private readonly approved: () => string[] = () => [],
    /** A folder inside the sandbox this workspace is rooted at (an agent's worktree). */
    private readonly prefix = "",
  ) {
    this.readOnly = readOnly;
  }

  private at(path: string): string {
    return this.prefix ? `${this.prefix}/${path.replace(/^\.\/?/, "")}` : path;
  }

  get node(): string {
    return this.t.name;
  }

  private fs<T>(body: Record<string, unknown>): Promise<T> {
    return this.t.nodes.request(this.t.ownerId, this.t.fingerprint, "fs", {
      sandbox: this.sandbox,
      ...body,
    }) as Promise<T>;
  }

  async readText(path: string): Promise<string> {
    return (await this.fs<{ text: string }>({ action: "read", path: this.at(path) })).text;
  }

  async writeText(path: string, content: string): Promise<void> {
    if (this.readOnly) throw new Error("This workspace is read-only");
    await this.fs({ action: "write", path: this.at(path), content });
  }

  async exists(path: string): Promise<boolean> {
    return (await this.fs<{ value: boolean }>({ action: "exists", path: this.at(path) })).value;
  }

  async isFile(path: string): Promise<boolean> {
    return (await this.fs<{ value: boolean }>({ action: "isFile", path: this.at(path) })).value;
  }

  async glob(pattern: string, under?: string): Promise<string[]> {
    return (
      await this.fs<{ files: string[] }>({
        action: "glob",
        pattern,
        ...((under || this.prefix) && { under: this.at(under ?? "") }),
      })
    ).files;
  }

  /**
   * A command whose truly dangerous parts the person said yes to (`approved`: the ids of
   * `criticalOf`, asked by the broker here): the node checks them again and refuses any other.
   */
  execApproved(
    command: string,
    o: ExecOptions,
    approved: string[],
    log?: NodeLogPlace,
  ): Promise<ExecResult> {
    return this.run({ command }, o, approved, log && { ...log, what: `exec ${command}` });
  }

  private async run(
    body: Record<string, unknown>,
    o: ExecOptions,
    approved = this.approved(),
    log?: NodeLogPlace & { what: string },
  ): Promise<ExecResult> {
    const r = (await this.t.nodes.request(
      this.t.ownerId,
      this.t.fingerprint,
      "exec",
      {
        sandbox: this.sandbox,
        ...body,
        ...((o.cwd || this.prefix) && { cwd: this.at(o.cwd ?? "") }),
        timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : 3_600_000,
        approvedCritical: approved,
      },
      {
        signal: o.signal,
        ...(log && { log }),
        // The command's own time, and the way back.
        ...(Number.isFinite(o.timeoutMs) && { timeoutMs: o.timeoutMs + 30_000 }),
      },
    )) as ExecResult;
    if (o.onOutput) {
      if (r.stdout) o.onOutput(r.stdout, "out");
      if (r.stderr) o.onOutput(r.stderr, "err");
      return { stdout: "", stderr: "", exitCode: r.exitCode, timedOut: r.timedOut };
    }
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut };
  }

  exec(command: string, o: ExecOptions): Promise<ExecResult> {
    return this.run({ command }, o);
  }

  execFile(file: string, args: string[], o: ExecOptions): Promise<ExecResult> {
    return this.run({ file, args }, o);
  }

  async openTerminal(): Promise<Terminal> {
    throw new TerminalUnavailableError(
      `No terminal on the node "${this.t.name}" yet: its commands run one by one`,
    );
  }
}

/** Sandboxes on a node: created once per id, like every sandbox (`RedGiantCore.sandboxFor`). */
export class NodeSandboxProvider implements SandboxProvider {
  readonly kind = "node" as const;

  constructor(private readonly t: NodeTarget) {}

  async create(spec: SandboxSpec): Promise<Sandbox> {
    const name = sandboxName(spec.id);
    const { root } = (await this.t.nodes.request(this.t.ownerId, this.t.fingerprint, "fs", {
      sandbox: name,
      action: "root",
    })) as { root: string };
    const t = this.t;
    return {
      id: spec.id,
      workspace: (subdir?: string) =>
        new NodeWorkspace(
          t,
          name,
          subdir ? `${root}/${subdir}` : root,
          spec.readOnly === true,
          undefined,
          subdir ?? "",
        ),
      destroy: async () => {},
    };
  }
}

interface RemoteModel {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsEffort: boolean;
  vision?: boolean;
  name?: string;
}

/** The provider id of a node's models: `node-<name>`. */
export const nodeProviderId = (name: string) =>
  `node-${name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40)}`;

/**
 * A node's models «via <node>»: model ids are `<the node's provider>:<model>`. The request goes to
 * the node, which streams the answer back; a node that goes away mid-answer is a retriable
 * failure (the fallback chain and the stall watch decide what then).
 */
export class NodeProvider implements Provider {
  readonly id: string;
  private list: { provider: string; models: RemoteModel[] }[] = [];

  constructor(private readonly t: NodeTarget) {
    this.id = nodeProviderId(t.name);
  }

  /** Asks the node which models it lends now. */
  async refresh(): Promise<void> {
    this.list = (await this.t.nodes.request(
      this.t.ownerId,
      this.t.fingerprint,
      "models",
      {},
      {
        timeoutMs: 15_000,
        waitMs: 0,
      },
    )) as { provider: string; models: RemoteModel[] }[];
  }

  private split(model: string): { provider: string; model: string } {
    const i = model.indexOf(":");
    if (i > 0) return { provider: model.slice(0, i), model: model.slice(i + 1) };
    return { provider: this.list[0]?.provider ?? "", model };
  }

  modelInfo(model: string): ModelInfo {
    const { provider, model: m } = this.split(model);
    const found = this.list.find((p) => p.provider === provider)?.models.find((x) => x.id === m);
    return {
      id: model,
      contextWindow: found?.contextWindow ?? 32_000,
      maxOutputTokens: found?.maxOutputTokens ?? 4096,
      supportsEffort: found?.supportsEffort ?? false,
      ...(found?.vision && { vision: true }),
      name: `${found?.name ?? m} (via ${this.t.name})`,
      ...(!found && { unconfirmed: true }),
    };
  }

  async models(): Promise<string[]> {
    await this.refresh().catch(() => {});
    return this.list.flatMap((p) => p.models.map((m) => `${p.provider}:${m.id}`));
  }

  async *stream(request: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const { provider, model } = this.split(request.model);
    const queue: StreamEvent[] = [];
    let wake: (() => void) | undefined;
    let result: { completion?: Completion; error?: unknown } | undefined;
    void this.t.nodes
      .request(
        this.t.ownerId,
        this.t.fingerprint,
        "complete",
        { provider, request: { ...request, model } },
        {
          signal,
          once: true,
          onChunk: (b) => {
            queue.push(b as StreamEvent);
            wake?.();
          },
        },
      )
      .then(
        (c) => {
          result = { completion: c as Completion };
          wake?.();
        },
        (e) => {
          result = { error: e };
          wake?.();
        },
      );
    for (;;) {
      while (queue.length) yield queue.shift() as StreamEvent;
      if (result) break;
      await new Promise<void>((ok) => {
        wake = ok;
      });
      wake = undefined;
    }
    while (queue.length) yield queue.shift() as StreamEvent;
    if (result.error) {
      const e = result.error as NodeError;
      throw new ProviderError(
        `Via ${this.t.name}: ${e.message}`,
        e.code === "offline" || e.code === "lost" || e.code === "timeout",
        { cause: e },
      );
    }
    const c = result.completion as Completion;
    yield {
      type: "done",
      completion: { ...c, model: `${provider}:${c.model}`, provider: this.id },
    };
  }
}
