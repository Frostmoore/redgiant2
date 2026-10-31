import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { AgentSession, type SendResult, type Tool } from "@redgiant/agent";
import { EventStore, migrate, type Redactor, type SqlClient } from "@redgiant/events";
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
import { createWorktree, HostSandboxProvider, type SandboxProvider } from "@redgiant/sandbox";
import {
  baseTools,
  type ModelProfile,
  type WebSearchProvider,
  type Workspace,
} from "@redgiant/tools";
import { HumanApprovals } from "./approvals.js";
import { migrateProjects, ProjectStore } from "./projects.js";

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
  /** How a parent agent answers a child's request; default: pass it up (G7 lets the model decide). */
  askAgent?: (approver: AgentRecord, request: ApprovalRequest) => Promise<AgentAnswer>;
  search?: WebSearchProvider;
  redactor?: Redactor;
  profileFor?: (model: ModelSpec) => ModelProfile;
}

export class SessionBusyError extends Error {
  constructor() {
    super("The agent is already working on a message; interrupt it or wait.");
  }
}

export class NotFoundError extends Error {}

interface Live {
  id: string;
  ownerId: string;
  agentId: string;
  projectId: string | null;
  session: AgentSession;
  running: AbortController | null;
  listeners: Set<(m: ServerMessage) => void>;
}

const DEFAULT_PROMPTS: Record<AgentRecord["kind"], string> = {
  god: "You are God, the main orchestrator of this RedGiant installation. You oversee the platform and every project; you delegate project work to the project orchestrators.",
  demigod:
    "You are Demi-God, the user's spokesperson on Telegram. You relay requests to God and report results back concisely. You never act on projects yourself.",
  orchestrator:
    "You are the orchestrator of this project. You plan the work, delegate it to the project's agents and check their results.",
  agent:
    "You are a coding agent working in your own git worktree of the project. Every result that can be tested must be tested before you say it is done.",
  subagent: "You are a sub-agent with one task. Do it, verify it, and report the result briefly.",
  inspector:
    "You are the project's inspector. You can only read. Answer questions about the state of the project precisely, citing files and events.",
};

/** Composition root: storage, hierarchy, approvals and live sessions. */
export class RedGiantCore {
  readonly store: EventStore;
  readonly registry: AgentRegistry;
  readonly budget: PersistentBudget;
  readonly broker: PermissionBroker;
  readonly projects: ProjectStore;
  readonly approvals = new HumanApprovals();
  private readonly live = new Map<string, Live>();
  private readonly sandbox: SandboxProvider;

  private constructor(private readonly o: CoreOptions) {
    this.store = new EventStore(o.db, o.redactor ? { redactor: o.redactor } : {});
    this.registry = new AgentRegistry(o.db, this.store);
    this.budget = new PersistentBudget(o.db, this.store);
    this.projects = new ProjectStore(o.db, o.workspacesDir);
    this.sandbox = o.sandbox ?? new HostSandboxProvider();
    this.broker = new PermissionBroker({
      store: this.store,
      resolve: this.registry.resolve,
      settingsFor: (a) => o.policyFor?.(this.registry.get(a.id) as AgentRecord) ?? DEFAULT_POLICY,
      modeFor: (a) => this.registry.get(a.id)?.mode ?? "auto",
      askAgent: (approver, req) =>
        o.askAgent
          ? o.askAgent(this.registry.get(approver.id) as AgentRecord, req)
          : Promise.resolve("escalate"),
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
    const core = new RedGiantCore(o);
    await core.registry.load();
    return core;
  }

  /** The workspace an agent works in, and whether it may write there. */
  private async workspaceFor(agent: AgentRecord): Promise<Workspace | undefined> {
    if (agent.kind === "demigod") return undefined;
    if (agent.kind === "god") {
      await mkdir(this.o.platformDir, { recursive: true });
      const sb = await this.sandbox.create({
        id: `${agent.ownerId}-platform`,
        localPath: this.o.platformDir,
        mount: { type: "bind", source: this.o.platformDir },
      });
      return sb.workspace();
    }
    const project = agent.projectId
      ? await this.projects.get(agent.ownerId, agent.projectId)
      : undefined;
    if (!project) throw new NotFoundError(`Project "${agent.projectId}" not found`);
    const readOnly = agent.kind === "inspector";
    const sb = await this.sandbox.create({
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
    const listeners = new Set<(m: ServerMessage) => void>();
    const options = {
      store: this.store,
      providers: this.o.providers,
      model,
      system: agent.systemPrompt ?? DEFAULT_PROMPTS[agent.kind],
      tools,
      sessionId,
      ownerId,
      projectId: agent.projectId,
      agentId,
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
  }
}
