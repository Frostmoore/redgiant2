import {
  type Automation,
  type AutomationRun,
  type ClientMessage,
  type Event,
  type Job,
  type PermissionRequestInfo,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@redgiant/protocol";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatEntry {
  id: number;
  message: import("@redgiant/protocol").ChatMessage;
  shown: string | null;
  metrics: import("@redgiant/protocol").MessageMetrics | null;
  costUsd: number | null;
  model: string | null;
  createdAt: string;
}

export type ChatStreamEvent =
  | { type: "delta"; kind: "text" | "thinking"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "entry"; entry: ChatEntry }
  | { type: "done" }
  | { type: "error"; error: string };

export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
}

export interface SetupState {
  config: {
    completed: boolean;
    language?: "it" | "en";
    defaultModel?: { provider: string; model: string; effort?: string };
    keyProviders?: string[];
    mode?: "standard" | "advanced";
    git?: { github?: { login: string }; gitea?: { user: string; publicUrl: string } };
    server?: { baseUrl: string };
    searxngUrl?: string;
    transcription?: { api: "whisper-asr" | "openai"; url: string; model?: string };
    imagesModel?: string;
    subscriptions?: { claude?: boolean; chatgpt?: boolean };
    engine?: { variant: EngineVariant; model: string };
    retentionDays?: number;
    subscriptionAck?: boolean;
  };
  secretsSet: {
    keys: string[];
    server: boolean;
    telegram: boolean;
    transcription?: boolean;
    images?: boolean;
    claudeSubscription?: boolean;
    github?: boolean;
    gitea?: boolean;
  };
  locked: Partial<
    Record<
      | "anthropic"
      | "server"
      | "telegram"
      | "defaultModel"
      | "search"
      | "engine"
      | "voice"
      | "images",
      boolean
    >
  >;
  providers: string[];
  hardware: {
    os: string;
    cpu: string;
    cores: number;
    ramGb: number;
    diskFreeGb: number | null;
    gpus: {
      name: string;
      vramGb: number;
      vendor: "nvidia" | "amd" | "intel" | "other";
      integrated: boolean;
    }[];
    dockerGpu: boolean;
    gpuAccess: "dri" | "";
    windowsEngine: boolean;
    suggestion: {
      engine: EngineVariant;
      maxModelGb: number;
      kind: "gpu" | "gpu-unknown" | "igpu" | "cpu";
      vramGb: number;
    };
  };
  names: { god: string | null; demigod: string | null; godPrompt: string | null };
  policy: {
    humanOnly: string[];
    disabledDanger: string[];
    dangers: { id: string }[];
  };
  budgetUsd: number | null;
}

export interface GgufFile {
  file: string;
  sizeGb: number;
  quant: string | null;
}

export type EngineVariant = "cpu" | "cuda" | "vulkan" | "windows";

/** A suggested local model with the best file for this computer (G24.3). */
export interface LocalModelChoice {
  id: string;
  name: string;
  repo: string;
  file: (GgufFile & { quality: "high" | "good" | "reduced" }) | null;
  smallestGb: number | null;
  unavailable?: boolean;
}

/** A file of the models folder: ready, or a download paused halfway. */
export interface LocalFile {
  file: string;
  bytes: number;
  partial: boolean;
}

export interface PlatformInfo {
  sandbox: "host" | "docker";
  metal: boolean;
  codeChanges: boolean;
  supervised: boolean;
  /** A transcription service is set: the microphone records and the server transcribes. */
  voice?: boolean;
  /** Providers whose key was refused (a banner until a new key works). */
  keyProblems?: { provider: string; message: string }[];
  lastGood: string | null;
  releases: {
    commit: string;
    result: "promoted" | "rolled_back";
    reason?: string;
    changeId?: string;
    at: string;
  }[];
}

export interface PlatformChange {
  id: string;
  kind: "config" | "code";
  change: string;
  stage: "proposed" | "tested" | "failed" | "promoted" | "rolled_back" | "discarded" | "undone";
  target: string | null;
  before: unknown;
  after: unknown;
  detail: string | null;
  by: string;
  createdAt: string;
  updatedAt: string;
}

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
  lastAt: string | null;
  title: string | null;
  pinned: boolean;
  archived: boolean;
  running: boolean;
  model: { provider: string; model: string; effort?: string } | null;
}

/** A flat subscription's usage windows (5 hours, 7 days, per-model ones). */
export interface PlanLimits {
  provider: string;
  windows: { id: string; label: string; usedPct: number; resetsAt?: string }[];
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface ModelChoice {
  provider: string;
  model: string;
  effort: boolean;
}

export interface SearchHit {
  kind: "session" | "chat" | "inspector";
  id: string;
  agentId: string | null;
  projectId: string | null;
  title: string | null;
  at: string;
  excerpt: string;
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
    /** Why, in a code the UI explains in plain words (`key_rejected`…), when the server says. */
    readonly code?: string,
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
    const data = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`, data.code);
    return data as T;
  }

  /** A recording to text (the server's transcription service). */
  async transcribe(audio: Blob, lang: string): Promise<string> {
    const r = await fetch(`/api/transcribe?lang=${encodeURIComponent(lang)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": audio.type || "application/octet-stream",
      },
      body: audio,
    });
    const data = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data.text ?? "";
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
  updateSession = (
    id: string,
    change: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      model?: { provider: string; model: string; effort?: string } | null;
    },
  ) => this.call("PATCH", `/api/sessions/${id}`, change);
  models = () => this.call<ModelChoice[]>("GET", "/api/models");
  devices = () => this.call<Device[]>("GET", "/api/devices");
  pairDevice = () => this.call<{ code: string; expiresAt: string }>("POST", "/api/devices/pair");
  revokeDevice = (id: string) => this.call("DELETE", `/api/devices/${id}`);
  search = (q: string) => this.call<SearchHit[]>("GET", `/api/search?q=${encodeURIComponent(q)}`);
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
  chats = (projectId?: string) =>
    this.call<ChatSummary[]>(
      "GET",
      projectId ? `/api/projects/${encodeURIComponent(projectId)}/inspector/chats` : "/api/chats",
    );
  createChat = (projectId?: string) =>
    this.call<ChatSummary>(
      "POST",
      projectId ? `/api/projects/${encodeURIComponent(projectId)}/inspector/chats` : "/api/chats",
    );
  inspectorSettings = (projectId: string) =>
    this.call<{
      alerts?: boolean;
      summaryHour?: number;
      model?: { provider: string; model: string };
    }>("GET", `/api/projects/${encodeURIComponent(projectId)}/inspector/settings`);
  setInspectorSettings = (projectId: string, s: Record<string, unknown>) =>
    this.call("PUT", `/api/projects/${encodeURIComponent(projectId)}/inspector/settings`, s);
  chat = (id: string) => this.call<ChatEntry[]>("GET", `/api/chats/${id}`);
  renameChat = (id: string, title: string) => this.call("PATCH", `/api/chats/${id}`, { title });
  deleteChat = (id: string) => this.call("DELETE", `/api/chats/${id}`);
  chatSettings = () =>
    this.call<{
      model?: { provider: string; model: string; effort?: string };
      systemPrompt?: string;
    }>("GET", "/api/chat/settings");
  setChatSettings = (s: Record<string, unknown>) => this.call("PUT", "/api/chat/settings", s);

  /** Sends a chat message; the answer arrives as server-sent events. */
  async sendChat(
    id: string,
    text: string,
    attachments: ({ name: string; content: string } | import("@redgiant/protocol").ImagePart)[],
    onEvent: (e: ChatStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const r = await fetch(`/api/chats/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text, attachments }),
      ...(signal && { signal }),
    });
    if (!r.ok || !r.body) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        if (event && data)
          onEvent({ ...(JSON.parse(data) as object), type: event } as ChatStreamEvent);
        cut = buffer.indexOf("\n\n");
      }
    }
  }

  setup = () => this.call<SetupState>("GET", "/api/setup");
  setupModels = (b: Record<string, unknown>) => this.call("PUT", "/api/setup/models", b);
  /** Starts the local engine: a job to follow (null stops it). */
  setupEngine = (engine: { variant: EngineVariant; model: string } | null) =>
    this.call<Job>("PUT", "/api/setup/engine", { engine });
  setupNames = (b: Record<string, unknown>) => this.call("PUT", "/api/setup/names", b);
  setupTelegram = (token: string | null) =>
    this.call<{ username: string } | null>("PUT", "/api/setup/telegram", { token });
  setupSafety = (b: Record<string, unknown>) => this.call("PUT", "/api/setup/safety", b);
  setupSubscriptions = (b: Record<string, unknown>) =>
    this.call("PUT", "/api/setup/subscriptions", b);
  chatgptStatus = () =>
    this.call<{ on: boolean; account: { email: string | null; plan: string | null } | null }>(
      "GET",
      "/api/subscriptions/chatgpt",
    );
  chatgptLogin = () =>
    this.call<{ url: string; code: string }>("POST", "/api/subscriptions/chatgpt/login");
  chatgptLogout = () => this.call("POST", "/api/subscriptions/chatgpt/logout");
  setupKey = (id: string, key: string) =>
    this.call<{ models: string[] }>("PUT", `/api/setup/keys/${encodeURIComponent(id)}`, { key });
  removeKey = (id: string) => this.call("DELETE", `/api/setup/keys/${encodeURIComponent(id)}`);
  setupServer = (b: { baseUrl: string; key?: string }) =>
    this.call<{ models: string[] }>("PUT", "/api/setup/server", b);
  removeServer = () => this.call("DELETE", "/api/setup/server");
  setupMode = (mode: "standard" | "advanced") => this.call("PUT", "/api/setup/mode", { mode });
  setupGithub = (token: string) =>
    this.call<{ login: string }>("PUT", "/api/setup/github", { token });
  removeGithub = () => this.call("DELETE", "/api/setup/github");
  /** Starts Gitea: a job to follow. */
  startGitea = (user: string, password: string) =>
    this.call<Job>("POST", "/api/setup/gitea", { user, password });
  stopGitea = () => this.call("DELETE", "/api/setup/gitea");
  gitSync = () =>
    this.call<{ project: string; ok: boolean; error?: string; code?: string }[]>(
      "POST",
      "/api/setup/git/sync",
    );
  claudeStatus = () =>
    this.call<{ on: boolean; account: ClaudeAccount | null }>("GET", "/api/subscriptions/claude");
  claudeLogin = (ack: boolean) =>
    this.call<{ url: string }>("POST", "/api/subscriptions/claude/login", { ack });
  claudeCode = (code: string) =>
    this.call<ClaudeAccount>("POST", "/api/subscriptions/claude/code", { code });
  claudeLogout = () => this.call("POST", "/api/subscriptions/claude/logout");
  limits = () => this.call<PlanLimits[]>("GET", "/api/limits");
  setupComplete = () => this.call("POST", "/api/setup/complete");
  hfSearch = (q: string) =>
    this.call<{ id: string; downloads: number; likes: number }[]>(
      "GET",
      `/api/setup/hf/search?q=${encodeURIComponent(q)}`,
    );
  hfFiles = (repo: string) =>
    this.call<GgufFile[]>("GET", `/api/setup/hf/files?repo=${encodeURIComponent(repo)}`);
  /** The suggested models and the folder's files, for the engine `variant` (each has its folder). */
  localModels = (variant: EngineVariant) =>
    this.call<{ models: LocalModelChoice[]; files: LocalFile[] }>(
      "GET",
      `/api/setup/local-models?variant=${variant}`,
    );
  /** Downloads a model file: a job to follow; cancelling it pauses, starting again goes on. */
  downloadModel = (repo: string, file: string, variant: EngineVariant) =>
    this.call<Job>("POST", "/api/setup/local-models/download", { repo, file, variant });
  removeModel = (file: string, variant: EngineVariant) =>
    this.call("DELETE", `/api/setup/local-models/${encodeURIComponent(file)}?variant=${variant}`);
  jobs = () => this.call<Job[]>("GET", "/api/jobs");
  job = (id: string) => this.call<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`);
  cancelJob = (id: string) => this.call("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`);
  platform = () => this.call<PlatformInfo>("GET", "/api/platform");
  platformChanges = () => this.call<PlatformChange[]>("GET", "/api/platform/changes");
  undoChange = (id: string) =>
    this.call<PlatformChange>("POST", `/api/platform/changes/${id}/undo`);
  discardChange = (id: string) =>
    this.call<PlatformChange>("POST", `/api/platform/changes/${id}/discard`);
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
    this.call<{
      path: string;
      encoding: "utf8" | "base64";
      content: string;
      size: number;
      modifiedAt: string;
    }>(
      "GET",
      `/api/files/content?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  write = (
    scope: string,
    path: string,
    content: string,
    encoding: "utf8" | "base64" = "utf8",
    opts: {
      expectedModifiedAt?: string | null;
      ifExists?: "replace" | "keep-both" | "fail";
    } = {},
  ) =>
    this.call<{ path: string; modifiedAt: string }>("PUT", "/api/files/content", {
      scope,
      path,
      content,
      encoding,
      ...opts,
    });
  fileOp = (
    op:
      | { op: "mkdir" | "delete"; scope: string; path: string }
      | { op: "rename"; scope: string; path: string; to: string },
  ) => this.call("POST", "/api/files/op", op);
  /** A conversation as a Markdown file. */
  async exportSession(id: string): Promise<{ blob: Blob; name: string }> {
    const r = await fetch(`/api/sessions/${id}/export`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
    const header = r.headers.get("content-disposition") ?? "";
    const name = decodeURIComponent(
      header.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? "conversation.md",
    );
    return { blob: await r.blob(), name };
  }

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

/** A name for a newly paired device, from what the browser says about itself. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad/.test(ua)
      ? "iOS"
      : /Mac/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return [browser, os].filter(Boolean).join(" · ") || "Browser";
}

/** A phone with a pairing code gets its own token (no token needed to ask). */
export async function claimDevice(code: string, name: string): Promise<string> {
  const r = await fetch("/api/devices/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  const data = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!r.ok || !data.token) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
  return data.token;
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
