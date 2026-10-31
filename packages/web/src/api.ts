import {
  type Automation,
  type AutomationRun,
  type ClientMessage,
  type Event,
  type PermissionRequestInfo,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@redgiant/protocol";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  kind: "god" | "demigod" | "orchestrator" | "agent" | "subagent" | "inspector";
  parentId: string | null;
  projectId: string | null;
  name: string;
  role?: string;
  model?: { provider: string; model: string; effort?: string };
  mode?: string;
  status: "active" | "stopped";
}

export interface SessionInfo {
  id: string;
  agentId: string;
  projectId: string | null;
  createdAt: string;
  running: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "link";
  size: number;
  modifiedAt: string;
}

export interface Budget {
  scope: "agent" | "project" | "global";
  id: string;
  limit: { usd?: number; tokens?: number };
  used: { usd: number; tokens: number };
}

export interface BoardThread {
  id: string;
  projectId: string | null;
  title: string;
  status: "open" | "resolved" | "blocked";
  createdBy: string;
  updatedAt: string;
  posts: number;
  summary: string | null;
}

export interface BoardPost {
  id: string;
  threadId: string;
  author: string;
  kind: "task" | "result" | "question" | "decision" | "blocker" | "note";
  body: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  projectId: string | null;
  kind: "tool" | "skill";
  name: string;
  author: string;
  status: "failed" | "pending" | "installed" | "rejected";
  report: { name: string; passed: boolean; detail: string }[];
  createdAt: string;
  input: {
    description?: string;
    spec?: { description: string; command: string };
    body?: string;
    files?: Record<string, string>;
  };
}

export interface Installed {
  kind: "tool" | "skill";
  name: string;
  description: string;
  scope: string;
  path: string;
}

export interface McpEntry {
  name: string;
  project_id: string | null;
  transport: { type: "stdio"; command: string; args?: string[] } | { type: "http"; url: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP calls with the bearer token. */
export class Api {
  constructor(private readonly token: string) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data as T;
  }

  projects = () => this.call<Project[]>("GET", "/api/projects");
  createProject = (name: string) => this.call<Project>("POST", "/api/projects", { name });
  agents = () => this.call<Agent[]>("GET", "/api/agents");
  createAgent = (a: Record<string, unknown>) => this.call<Agent>("POST", "/api/agents", a);
  configureAgent = (id: string, change: Record<string, unknown>) =>
    this.call<Agent>("PATCH", `/api/agents/${id}`, change);
  stopAgent = (id: string) =>
    this.call<{ stopped: string[] }>("POST", `/api/agents/${id}/stop`, {
      reason: "stopped from the web UI",
    });
  sessions = (agentId?: string) =>
    this.call<SessionInfo[]>("GET", `/api/sessions${agentId ? `?agentId=${agentId}` : ""}`);
  startSession = (agentId: string) =>
    this.call<{ sessionId: string }>("POST", "/api/sessions", { agentId });
  events = (sessionId: string) => this.call<Event[]>("GET", `/api/sessions/${sessionId}/events`);
  approvals = () => this.call<PermissionRequestInfo[]>("GET", "/api/permissions");
  budgets = () => this.call<Budget[]>("GET", "/api/budgets");
  setBudget = (b: { scope: Budget["scope"]; id: string; usd?: number; tokens?: number }) =>
    this.call("PUT", "/api/budgets", b);
  threads = (projectId: string | null) =>
    this.call<BoardThread[]>(
      "GET",
      `/api/board/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    );
  thread = (id: string) =>
    this.call<{ thread: BoardThread; posts: BoardPost[] }>("GET", `/api/board/threads/${id}`);
  boardPost = (p: {
    threadId?: string;
    projectId?: string | null;
    title?: string;
    kind: BoardPost["kind"];
    body: string;
  }) => this.call<{ threadId: string; postId: string }>("POST", "/api/board/posts", p);
  boardStatus = (id: string, status: BoardThread["status"]) =>
    this.call("POST", `/api/board/threads/${id}/status`, { status });
  boardSearch = (q: string) =>
    this.call<(BoardPost & { title: string; projectId: string | null })[]>(
      "GET",
      `/api/board/search?q=${encodeURIComponent(q)}`,
    );
  proposals = (status?: Proposal["status"]) =>
    this.call<Proposal[]>("GET", `/api/extensions/proposals${status ? `?status=${status}` : ""}`);
  createExtension = (projectId: string | null, input: unknown) =>
    this.call<Proposal>("POST", "/api/extensions/proposals", { projectId, input });
  decideExtension = (id: string, decision: "approve" | "reject") =>
    this.call<Proposal>("POST", `/api/extensions/proposals/${id}/decision`, { decision });
  installed = () => this.call<Installed[]>("GET", "/api/extensions/installed");
  mcpServers = () => this.call<McpEntry[]>("GET", "/api/extensions/mcp");
  setMcp = (m: { name: string; projectId: string | null; transport: McpEntry["transport"] }) =>
    this.call("PUT", "/api/extensions/mcp", m);
  removeMcp = (name: string) =>
    this.call("DELETE", `/api/extensions/mcp/${encodeURIComponent(name)}`);
  automations = () => this.call<Automation[]>("GET", "/api/automations");
  createAutomation = (yaml: string) =>
    this.call<{ automation: Automation; webhookSecret?: string }>("POST", "/api/automations", {
      yaml,
    });
  updateAutomation = (id: string, yaml: string) =>
    this.call<{ automation: Automation; webhookSecret?: string }>("PUT", `/api/automations/${id}`, {
      yaml,
    });
  deleteAutomation = (id: string) => this.call("DELETE", `/api/automations/${id}`);
  enableAutomation = (id: string, enabled: boolean) =>
    this.call<Automation>("POST", `/api/automations/${id}/enabled`, { enabled });
  runAutomation = (id: string) => this.call<AutomationRun>("POST", `/api/automations/${id}/run`);
  rotateAutomationSecret = (id: string) =>
    this.call<{ webhookSecret: string }>("POST", `/api/automations/${id}/secret`);
  automationRuns = (id: string) => this.call<AutomationRun[]>("GET", `/api/automations/${id}/runs`);
  telegramPair = () =>
    this.call<{ code: string; expiresAt: string; bot: string; link: string }>(
      "POST",
      "/api/telegram/pair",
    );
  telegramLinks = () =>
    this.call<{ userId: number; chatId: number; username: string | null; linkedAt: string }[]>(
      "GET",
      "/api/telegram/links",
    );
  telegramUnlink = (userId: number) => this.call("DELETE", `/api/telegram/links/${userId}`);
  verify = () =>
    this.call<{ ok: boolean; checked?: number; seq?: number; reason?: string }>(
      "GET",
      "/api/log/verify",
    );
  list = (scope: string, path = ".") =>
    this.call<FileEntry[]>(
      "GET",
      `/api/files/list?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  read = (scope: string, path: string) =>
    this.call<{ path: string; encoding: "utf8" | "base64"; content: string; size: number }>(
      "GET",
      `/api/files/content?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  write = (scope: string, path: string, content: string, encoding: "utf8" | "base64" = "utf8") =>
    this.call("PUT", "/api/files/content", { scope, path, content, encoding });
  fileOp = (
    op:
      | { op: "mkdir" | "delete"; scope: string; path: string }
      | { op: "rename"; scope: string; path: string; to: string },
  ) => this.call("POST", "/api/files/op", op);
  async download(scope: string, path: string): Promise<Blob> {
    const r = await fetch(
      `/api/files/raw?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
    return r.blob();
  }
}

export const wsUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

/**
 * The live channel, with automatic reconnection (1 s … 30 s) and a queue for messages sent
 * while offline. After a reconnection followed sessions are followed again (the server
 * replays their history).
 */
export class Live {
  private ws: WebSocket | undefined;
  private queue: ClientMessage[] = [];
  private delay = 1000;
  private closed = false;
  private readonly followed = new Set<string>();

  constructor(
    private readonly token: string,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onStatus: (s: "online" | "offline" | "connecting") => void,
  ) {
    this.connect();
  }

  private connect() {
    this.onStatus("connecting");
    const ws = new WebSocket(wsUrl("/ws"));
    this.ws = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, token: this.token }),
      );
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === "welcome") {
        this.delay = 1000;
        this.onStatus("online");
        for (const s of this.followed)
          ws.send(JSON.stringify({ type: "session.follow", sessionId: s }));
        for (const q of this.queue.splice(0)) ws.send(JSON.stringify(q));
      }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      this.onStatus("offline");
      if (this.closed || e.code === 4003) return;
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    };
  }

  send(m: ClientMessage): void {
    if (m.type === "session.follow") this.followed.add(m.sessionId);
    if (m.type === "session.unfollow") this.followed.delete(m.sessionId);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.queue.push(m);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
