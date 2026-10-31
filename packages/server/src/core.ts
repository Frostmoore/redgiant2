import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentSession, type SendResult, type Tool } from "@redgiant/agent";
import { Board, BoardSummarizer, boardTools, migrateBoard } from "@redgiant/board";
import { EventStore, migrate, type Redactor, type SqlClient } from "@redgiant/events";
import {
  customTools,
  ExtensionBuilder,
  loadCustomTools,
  loadSkills,
  McpConnection,
  type McpServerConfig,
  migrateExtensions,
  proposeTool,
  skillsIndex,
  skillTools,
} from "@redgiant/extensions";
import {
  type AgentAnswer,
  type AgentRecord,
  AgentRegistry,
  type ApprovalRequest,
  DEFAULT_POLICY,
  hierarchyGuards,
  migrateHierarchy,
  PermissionBroker,
  PersistentBudget,
  type PolicySettings,
} from "@redgiant/hierarchy";
import type { Event, ModelSpec, ServerMessage } from "@redgiant/protocol";
import type { ProviderRegistry } from "@redgiant/providers";
import {
  createWorktree,
  HostSandboxProvider,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
} from "@redgiant/sandbox";
import {
  baseTools,
  type ModelProfile,
  type WebSearchProvider,
  type Workspace,
} from "@redgiant/tools";
import { HumanApprovals } from "./approvals.js";
import {
  completeTaskTool,
  modelApprover,
  type OrchestrationHost,
  orchestrationTools,
  TaskTracker,
} from "./orchestration.js";
import { migrateProjects, ProjectStore, slug } from "./projects.js";

export interface CoreOptions {
  db: SqlClient;
  providers: ProviderRegistry;
  /** Root of the project workspaces. */
  workspacesDir: string;
  /** God's own workspace (the platform). */
  platformDir: string;
  sandbox?: SandboxProvider;
  /** Used when neither the agent nor its ancestors set a model. */
  defaultModel?: ModelSpec;
  policyFor?: (agent: AgentRecord) => PolicySettings;
  /** How a parent agent answers a child's request; default: the parent's own model decides. */
  askAgent?: (approver: AgentRecord, request: ApprovalRequest) => Promise<AgentAnswer>;
  search?: WebSearchProvider;
  redactor?: Redactor;
  profileFor?: (model: ModelSpec) => ModelProfile;
  /** Model for board summaries and digests (default: `defaultModel`; none ⇒ no summaries). */
  boardModel?: ModelSpec;
}

export class SessionBusyError extends Error {
  constructor() {
    super("The agent is already working on a message; interrupt it or wait.");
  }
}

export class NotFoundError extends Error {}

/** A request that cannot be satisfied as asked (bad path, wrong kind of file, …). */
export class BadRequestError extends Error {}

interface Live {
  id: string;
  ownerId: string;
  agentId: string;
  projectId: string | null;
  session: AgentSession;
  running: AbortController | null;
  listeners: Set<(m: ServerMessage) => void>;
}

/** Who goes first on a shared local engine (RD16): the user's interlocutors, then the workers. */
const PRIORITY: Record<AgentRecord["kind"], number> = {
  god: 100,
  demigod: 100,
  orchestrator: 70,
  inspector: 60,
  agent: 50,
  subagent: 30,
};

const DEFAULT_PROMPTS: Record<AgentRecord["kind"], string> = {
  god: "You are God, the main orchestrator of this RedGiant installation. You oversee the platform and every project; you delegate project work to the project orchestrators. Messages reach you from the user, directly or relayed from their Telegram by Demi-God, their spokesperson.",
  demigod:
    "You are Demi-God, the user's spokesperson on Telegram. Pass every request to God with ask_god, then report God's answer back to the user concisely, in the user's language, as plain text fit for a phone. You never act on projects yourself.",
  orchestrator:
    "You are the orchestrator of this project. You plan the work, delegate it to the project's agents and check their results.",
  agent:
    "You are a coding agent working in your own git worktree of the project. Every result that can be tested must be tested before you say it is done.",
  subagent: "You are a sub-agent with one task. Do it, verify it, and report the result briefly.",
  inspector:
    "You are the project's inspector. You can only read. Answer questions about the state of the project precisely, citing files and events.",
};

/** Composition root: storage, hierarchy, approvals and live sessions. */
export class RedGiantCore implements OrchestrationHost {
  readonly store: EventStore;
  readonly registry: AgentRegistry;
  readonly budget: PersistentBudget;
  readonly broker: PermissionBroker;
  readonly projects: ProjectStore;
  readonly approvals = new HumanApprovals();
  readonly tasks: TaskTracker;
  readonly board: Board;
  readonly extensions: ExtensionBuilder;
  /** Connected MCP servers, by owner and name. */
  private readonly mcp = new Map<string, McpConnection>();
  readonly summarizer: BoardSummarizer | undefined;
  /** Where each agent receives delegated work. */
  private readonly workSessions = new Map<string, string>();
  private readonly live = new Map<string, Live>();
  private readonly sandbox: SandboxProvider;
  /** One sandbox per workspace, shared by every session that works there. */
  private readonly sandboxes = new Map<string, Promise<Sandbox>>();

  private constructor(private readonly o: CoreOptions) {
    this.store = new EventStore(o.db, o.redactor ? { redactor: o.redactor } : {});
    this.registry = new AgentRegistry(o.db, this.store);
    this.budget = new PersistentBudget(o.db, this.store);
    this.projects = new ProjectStore(o.db, o.workspacesDir);
    this.sandbox = o.sandbox ?? new HostSandboxProvider();
    this.tasks = new TaskTracker(this.store);
    this.board = new Board(o.db, this.store);
    this.board.followTasks();
    this.extensions = new ExtensionBuilder({
      db: o.db,
      store: this.store,
      // Each proposal is tested in its own throwaway sandbox.
      testWorkspace: async (id) => {
        const dir = join(o.platformDir, "_proposals", id);
        await mkdir(dir, { recursive: true });
        const sb = await this.sandbox.create({
          id: `proposal-${id}`,
          localPath: dir,
          mount: { type: "bind", source: dir },
        });
        return {
          workspace: sb.workspace(),
          dispose: async () => {
            await sb.destroy();
            await rm(dir, { recursive: true, force: true });
          },
        };
      },
      installRoot: async (ownerId, projectId) => {
        if (!projectId) return this.platformPath(ownerId);
        const p = await this.projects.get(ownerId, projectId);
        if (!p) throw new NotFoundError(`Project "${projectId}" not found`);
        return join(p.path, ".redgiant");
      },
    });
    const boardModel = o.boardModel ?? o.defaultModel;
    this.summarizer = boardModel
      ? new BoardSummarizer(this.board, o.providers, boardModel)
      : undefined;
    // Long threads get summarised in the background, without slowing whoever posted.
    this.board.onChange((ownerId, _project, threadId) => {
      void this.summarizer?.maybeSummarize(ownerId, threadId).catch(() => {});
    });
    this.broker = new PermissionBroker({
      store: this.store,
      resolve: this.registry.resolve,
      settingsFor: (a) => o.policyFor?.(this.registry.get(a.id) as AgentRecord) ?? DEFAULT_POLICY,
      modeFor: (a) => this.registry.get(a.id)?.mode ?? "auto",
      askAgent: (approver, req) => {
        const a = this.registry.get(approver.id) as AgentRecord;
        return o.askAgent
          ? o.askAgent(a, req)
          : modelApprover({
              registry: this.registry,
              providers: o.providers,
              budget: this.budget,
              ...(o.defaultModel && { defaultModel: o.defaultModel }),
              systemFor: (x) => x.systemPrompt ?? DEFAULT_PROMPTS[x.kind],
            })(a, req);
      },
      askHuman: (req, signal) => this.approvals.ask(req, signal),
    });
    // Persisted events reach the followers of their session.
    this.store.subscribe((e: Event) => {
      const l = e.sessionId ? this.live.get(e.sessionId) : undefined;
      if (l) for (const f of l.listeners) f({ type: "event", sessionId: l.id, event: e });
    });
  }

  static async create(o: CoreOptions): Promise<RedGiantCore> {
    await migrate(o.db);
    await migrateHierarchy(o.db);
    await migrateProjects(o.db);
    await migrateBoard(o.db);
    await migrateExtensions(o.db);
    const core = new RedGiantCore(o);
    await core.registry.load();
    return core;
  }

  /**
   * Creating a sandbox twice with the same id would replace the container under a running
   * session: sandboxes are created once and reused.
   */
  private sandboxFor(spec: SandboxSpec): Promise<Sandbox> {
    let sb = this.sandboxes.get(spec.id);
    if (!sb) {
      sb = this.sandbox.create(spec);
      sb.catch(() => this.sandboxes.delete(spec.id));
      this.sandboxes.set(spec.id, sb);
    }
    return sb;
  }

  /** God's workspace: one per owner, under the platform directory. */
  platformPath(ownerId: string): string {
    return join(this.o.platformDir, slug(ownerId) || "owner");
  }

  /** The workspace behind a file/terminal scope ("platform" or "project:<id>"), in its sandbox. */
  async scopeWorkspace(ownerId: string, scope: string): Promise<Workspace> {
    if (scope === "platform") {
      const platform = this.platformPath(ownerId);
      await mkdir(platform, { recursive: true });
      const sb = await this.sandboxFor({
        id: `${ownerId}-platform`,
        localPath: platform,
        mount: { type: "bind", source: platform },
      });
      return sb.workspace();
    }
    const id = scope.match(/^project:([a-z0-9-]+)$/)?.[1];
    const project = id ? await this.projects.get(ownerId, id) : undefined;
    if (!project) throw new NotFoundError(`No such scope "${scope}"`);
    const sb = await this.sandboxFor({
      id: `${ownerId}-${project.id}`,
      localPath: project.path,
      mount: { type: "bind", source: project.path },
    });
    return sb.workspace();
  }

  /** The project's main workspace and, for an agent, its own worktree. */
  async projectWorkspaces(
    agent: AgentRecord,
  ): Promise<{ root: Workspace; worktree: (agentId: string) => Promise<Workspace> }> {
    const project = agent.projectId
      ? await this.projects.get(agent.ownerId, agent.projectId)
      : undefined;
    if (!project) throw new NotFoundError(`Project "${agent.projectId}" not found`);
    const sb = await this.sandboxFor({
      id: `${agent.ownerId}-${project.id}`,
      localPath: project.path,
      mount: { type: "bind", source: project.path },
    });
    const root = sb.workspace();
    return { root, worktree: async (agentId) => sb.workspace(await createWorktree(root, agentId)) };
  }

  /** The workspace an agent works in, and whether it may write there. */
  private async workspaceFor(agent: AgentRecord): Promise<Workspace | undefined> {
    if (agent.kind === "demigod") return undefined;
    if (agent.kind === "god") {
      const platform = this.platformPath(agent.ownerId);
      await mkdir(platform, { recursive: true });
      const sb = await this.sandboxFor({
        id: `${agent.ownerId}-platform`,
        localPath: platform,
        mount: { type: "bind", source: platform },
      });
      return sb.workspace();
    }
    const project = agent.projectId
      ? await this.projects.get(agent.ownerId, agent.projectId)
      : undefined;
    if (!project) throw new NotFoundError(`Project "${agent.projectId}" not found`);
    const readOnly = agent.kind === "inspector";
    const sb = await this.sandboxFor({
      id: `${agent.ownerId}-${project.id}${readOnly ? "-ro" : ""}`,
      localPath: project.path,
      mount: { type: "bind", source: project.path },
      readOnly,
    });
    const root = sb.workspace();
    // Agents and sub-agents each get their own git worktree (RD14).
    if (agent.kind === "agent") return sb.workspace(await createWorktree(root, agent.id));
    if (agent.kind === "subagent" && agent.parentId)
      return sb.workspace(await createWorktree(root, agent.parentId));
    return root;
  }

  private async build(
    ownerId: string,
    agentId: string,
    sessionId: string,
    resume: boolean,
  ): Promise<Live> {
    const agent = this.registry.get(agentId);
    if (!agent || agent.ownerId !== ownerId)
      throw new NotFoundError(`Agent "${agentId}" not found`);
    if (agent.status !== "active") throw new Error(`Agent "${agent.name}" is stopped`);
    const model = this.registry.effectiveModel(agentId) ?? this.o.defaultModel;
    if (!model) throw new Error(`No model configured for "${agent.name}" or its ancestors`);
    const ws = await this.workspaceFor(agent);
    const tools: Tool[] = ws
      ? baseTools({
          workspace: ws,
          profile: this.o.profileFor?.(model) ?? "full",
          ...(this.o.search && { search: this.o.search }),
        })
      : [];
    tools.push(...orchestrationTools(agent, this, this.tasks), ...boardTools(agent, this.board));
    // Extensions: skills for every agent; custom and MCP tools for those that act (RD8, RD30).
    const project = agent.projectId ? await this.projects.get(ownerId, agent.projectId) : undefined;
    const roots = [
      { dir: this.platformPath(ownerId), scope: "platform" as const },
      ...(project ? [{ dir: join(project.path, ".redgiant"), scope: "project" as const }] : []),
    ];
    const skills = agent.kind === "demigod" ? [] : await loadSkills(roots);
    tools.push(...skillTools(skills));
    if (agent.kind !== "demigod" && agent.kind !== "inspector") {
      tools.push(
        ...customTools(await loadCustomTools(roots), ws),
        ...(await this.mcpTools(ownerId, agent.projectId)),
        proposeTool(agent, this.extensions),
      );
    }
    const receivesTasks = ["orchestrator", "agent", "subagent"].includes(agent.kind);
    if (receivesTasks) tools.push(completeTaskTool(agent, ws, this.broker, this.tasks));
    const listeners = new Set<(m: ServerMessage) => void>();
    const options = {
      store: this.store,
      providers: this.o.providers,
      model,
      system: [agent.systemPrompt ?? DEFAULT_PROMPTS[agent.kind], skillsIndex(skills)]
        .filter(Boolean)
        .join("\n\n"),
      tools,
      ...(receivesTasks && { hooks: { stop: [this.tasks.stopHook(agentId)] } }),
      sessionId,
      ownerId,
      projectId: agent.projectId,
      agentId,
      priority: PRIORITY[agent.kind],
      cacheScope: agent.projectId ?? `platform-${agent.ownerId}`,
      live: (e: { type: string; text?: string }) => {
        if (e.type !== "text_delta" && e.type !== "thinking_delta") return;
        for (const f of listeners)
          f({
            type: "delta",
            sessionId,
            kind: e.type === "text_delta" ? "text" : "thinking",
            text: e.text ?? "",
          });
      },
      ...hierarchyGuards({
        agent,
        resolve: this.registry.resolve,
        broker: this.broker,
        budget: this.budget,
      }),
    };
    const session = resume ? await AgentSession.resume(options) : await AgentSession.start(options);
    return {
      id: sessionId,
      ownerId,
      agentId,
      projectId: agent.projectId,
      session,
      running: null,
      listeners,
    };
  }

  /** MCP servers configured by the owner: global ones and the project's. Failing servers are skipped. */
  private async mcpTools(ownerId: string, projectId: string | null): Promise<Tool[]> {
    const rows = await this.o.db.query<{
      name: string;
      project_id: string | null;
      transport: McpServerConfig["transport"] | string;
    }>(
      "SELECT name, project_id, transport FROM rg_mcp_servers WHERE owner_id = $1 AND (project_id IS NULL OR project_id = $2) ORDER BY name",
      [ownerId, projectId ?? ""],
    );
    const out: Tool[] = [];
    for (const r of rows) {
      const key = `${ownerId}/${r.name}`;
      let conn = this.mcp.get(key);
      if (!conn) {
        conn = new McpConnection({
          name: r.name,
          transport: typeof r.transport === "string" ? JSON.parse(r.transport) : r.transport,
        });
        this.mcp.set(key, conn);
      }
      try {
        out.push(...(await conn.tools()));
      } catch (err) {
        console.warn(`MCP server "${r.name}" unavailable: ${(err as Error).message}`);
        this.mcp.delete(key);
      }
    }
    return out;
  }

  async listMcp(ownerId: string) {
    return this.o.db.query<{ name: string; project_id: string | null; transport: unknown }>(
      "SELECT name, project_id, transport FROM rg_mcp_servers WHERE owner_id = $1 ORDER BY name",
      [ownerId],
    );
  }

  async setMcp(
    ownerId: string,
    config: McpServerConfig & { projectId: string | null },
  ): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_mcp_servers (owner_id, name, project_id, transport) VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id, name) DO UPDATE SET project_id = EXCLUDED.project_id, transport = EXCLUDED.transport`,
      [ownerId, config.name, config.projectId, JSON.stringify(config.transport)],
    );
    await this.mcp.get(`${ownerId}/${config.name}`)?.close();
    this.mcp.delete(`${ownerId}/${config.name}`);
  }

  async removeMcp(ownerId: string, name: string): Promise<void> {
    await this.o.db.query("DELETE FROM rg_mcp_servers WHERE owner_id = $1 AND name = $2", [
      ownerId,
      name,
    ]);
    await this.mcp.get(`${ownerId}/${name}`)?.close();
    this.mcp.delete(`${ownerId}/${name}`);
  }

  /** Telegram: the owner's Demi-God answers, talking to God only (RD8). */
  async askDemigod(ownerId: string, _chatId: number, text: string): Promise<string> {
    const demigod = this.registry
      .list({ ownerId, activeOnly: true })
      .find((a) => a.kind === "demigod");
    if (!demigod) throw new Error("Demi-God is not set up yet: create it under God in RedGiant.");
    const sid = await this.workSession(demigod);
    let done: Promise<SendResult>;
    try {
      ({ done } = await this.send(ownerId, sid, text));
    } catch (err) {
      if (err instanceof SessionBusyError) return "I am still working on your previous message.";
      throw err;
    }
    const r = await done;
    const events = await this.store.list({ sessionId: sid });
    const last = [...events].reverse().find((e) => e.type === "message.assistant");
    const reply =
      last?.type === "message.assistant" && last.payload
        ? last.payload.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("")
        : "";
    return reply || (r.stopReason === "budget" ? "The budget is exhausted." : "No answer.");
  }

  /** The session where an agent receives delegated work (created on first use). */
  async workSession(agent: AgentRecord): Promise<string> {
    const existing = this.workSessions.get(agent.id);
    if (existing) return existing;
    const id = await this.startSession(agent.ownerId, agent.id);
    this.workSessions.set(agent.id, id);
    return id;
  }

  /** Starts a new conversation with an agent. */
  async startSession(ownerId: string, agentId: string): Promise<string> {
    const id = `sess_${randomUUID().slice(0, 12)}`;
    const agent = this.registry.get(agentId);
    if (!agent || agent.ownerId !== ownerId)
      throw new NotFoundError(`Agent "${agentId}" not found`);
    await this.o.db.query(
      "INSERT INTO rg_sessions (id, owner_id, agent_id, project_id) VALUES ($1, $2, $3, $4)",
      [id, ownerId, agentId, agent.projectId],
    );
    this.live.set(id, await this.build(ownerId, agentId, id, false));
    return id;
  }

  /** A live session, resumed from the log when the server restarted since. */
  private async open(ownerId: string, sessionId: string): Promise<Live> {
    const l = this.live.get(sessionId);
    if (l) {
      if (l.ownerId !== ownerId) throw new NotFoundError(`Session "${sessionId}" not found`);
      return l;
    }
    const [row] = await this.o.db.query<{ agent_id: string; owner_id: string }>(
      "SELECT agent_id, owner_id FROM rg_sessions WHERE id = $1",
      [sessionId],
    );
    if (!row || row.owner_id !== ownerId)
      throw new NotFoundError(`Session "${sessionId}" not found`);
    const built = await this.build(ownerId, row.agent_id, sessionId, true);
    this.live.set(sessionId, built);
    return built;
  }

  async listSessions(ownerId: string, agentId?: string) {
    return this.o.db.query<{
      id: string;
      agent_id: string;
      project_id: string | null;
      created_at: Date;
    }>(
      `SELECT id, agent_id, project_id, created_at FROM rg_sessions WHERE owner_id = $1${agentId ? " AND agent_id = $2" : ""} ORDER BY created_at`,
      agentId ? [ownerId, agentId] : [ownerId],
    );
  }

  async history(ownerId: string, sessionId: string): Promise<Event[]> {
    await this.open(ownerId, sessionId);
    return this.store.list({ sessionId });
  }

  /**
   * Sends a message; the agent works in the background, independent of any client. The
   * returned promise resolves when the turn is over (clients need not wait for it).
   */
  async send(
    ownerId: string,
    sessionId: string,
    text: string,
  ): Promise<{ done: Promise<SendResult> }> {
    const l = await this.open(ownerId, sessionId);
    if (l.running) throw new SessionBusyError();
    const controller = new AbortController();
    l.running = controller;
    const notify = (state: "idle" | "running") => {
      for (const f of l.listeners) f({ type: "session.state", sessionId, state });
    };
    notify("running");
    // Wrapped: an async function returning a bare promise would wait for the whole turn.
    const done = l.session.send(text, controller.signal).finally(() => {
      l.running = null;
      notify("idle");
    });
    return { done };
  }

  async interrupt(ownerId: string, sessionId: string): Promise<boolean> {
    const l = await this.open(ownerId, sessionId);
    l.running?.abort();
    return l.running !== null;
  }

  isRunning(sessionId: string): boolean {
    return this.live.get(sessionId)?.running != null;
  }

  /**
   * Follows a session: the stored history first, then everything live. The listener sees
   * no gap and no duplicate, whatever is written while the history is being read.
   */
  async follow(
    ownerId: string,
    sessionId: string,
    listener: (m: ServerMessage) => void,
  ): Promise<() => void> {
    const l = await this.open(ownerId, sessionId);
    const buffered: ServerMessage[] = [];
    let replaying = true;
    const relay = (m: ServerMessage) => (replaying ? buffered.push(m) : listener(m));
    l.listeners.add(relay);
    const past = await this.store.list({ sessionId });
    for (const e of past) listener({ type: "event", sessionId, event: e });
    const lastSeq = past.at(-1)?.seq ?? -1;
    listener({ type: "session.synced", sessionId, lastSeq });
    replaying = false;
    for (const m of buffered) if (m.type !== "event" || m.event.seq > lastSeq) listener(m);
    listener({ type: "session.state", sessionId, state: l.running ? "running" : "idle" });
    return () => l.listeners.delete(relay);
  }

  /** Stops every running turn and denies every open approval (shutdown). */
  async close(): Promise<void> {
    for (const l of this.live.values()) l.running?.abort();
    this.approvals.denyAll();
    for (const sb of this.sandboxes.values()) await (await sb.catch(() => undefined))?.destroy();
    this.sandboxes.clear();
    for (const c of this.mcp.values()) await c.close();
    this.mcp.clear();
  }
}
