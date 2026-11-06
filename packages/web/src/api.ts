import {
  type Automation,
  type AutomationRun,
  type BackupPreview,
  type ClientMessage,
  type Event,
  type Job,
  type LocalModel,
  type PermissionRequestInfo,
  PROTOCOL_VERSION,
  type SearchProviderId,
  type ServerMessage,
} from "@redgiant/protocol";

export interface ChatSummary {
  id: string;
  title: string;
  /** Its folder, if the person put it in one. */
  folder?: string | null;
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
  /** Model files inside WSL that the engine on Windows could run instead (2026-11-04). */
  config: {
    completed: boolean;
    language?: "it" | "en";
    /** The person's instructions for every agent (2026-11-05). */
    instructions?: string;
    backupModel?: { provider: string; model: string; effort?: string };
    defaultModel?: { provider: string; model: string; effort?: string };
    keyProviders?: string[];
    mode?: "standard" | "advanced";
    git?: { github?: { login: string }; gitea?: { user: string; publicUrl: string } };
    remote?: { way: "tailscale" | "cloudflare" | "caddy"; url: string };
    pihole?: { lanIp: string; domain?: string; adminUrl: string };
    server?: { baseUrl: string };
    searxngUrl?: string;
    searxngManaged?: boolean;
    searchProvider?: SearchProviderId;
    transcription?: { api: "whisper-asr" | "openai" | "local"; url: string; model?: string };
    imagesModel?: string;
    media?: Partial<
      Record<
        import("@redgiant/protocol").MediaKind,
        { provider: string; model: string; voice?: string }
      >
    >;
    subscriptions?: { claude?: boolean; chatgpt?: boolean };
    engine?: {
      variant: EngineVariant;
      model: string;
      stream?: boolean;
      tuning?: { moeCacheShare?: number; opOffload?: boolean; batch?: number };
      /** Bigger reading passes with SSD stream (G32.1, experimental). */
      bigChunks?: boolean;
      /** The next layer's experts copied ahead, patched llama.cpp (G32.2, experimental). */
      moePrefetch?: boolean;
      /** Turned off by the person: kept, not loaded (2026-11-04). */
      off?: boolean;
      /** Speculative decoding (2026-11-04). */
      speculative?: "draft" | "ngram";
      draftModel?: string;
      /** The tuning's tries (2026-11-05): the kept one's speed is the model's measured speed. */
      trials?: { genTps?: number; chosen?: boolean }[];
      /** What the last start decided (SSD stream). */
      plan?: {
        ctx: number;
        moeCacheMib: number;
        source: "card" | "ram" | "ssd";
        ssdGbPerWord: number;
        /** The free RAM the plan counted on (2026-11-04). */
        ramGb?: number;
        /** Tokens a reading pass (G32.1). */
        batch?: number;
      };
    };
    retentionDays?: number;
    subscriptionAck?: boolean;
  };
  secretsSet: {
    keys: string[];
    server: boolean;
    telegram: boolean;
    /** Chat platforms set up besides Telegram (G29.5). */
    chats?: ChatPlatform[];
    transcription?: boolean;
    images?: boolean;
    /** Media providers with a key (G25.3). */
    media?: string[];
    claudeSubscription?: boolean;
    github?: boolean;
    gitea?: boolean;
    /** Web search services with a saved key (2026-11-03). */
    search?: string[];
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
    /** The RAM a model may use now (free, not total; 2026-11-04). */
    freeRamGb?: number;
    diskFreeGb: number | null;
    /** The computer's disks and the one each engine keeps its models on (2026-11-03). */
    disks?: { name: string; ssd: boolean | null; bus: string; freeGb: number; totalGb: number }[];
    modelDisk?: { docker?: string; windows?: string };
    gpus: {
      name: string;
      vramGb: number;
      vendor: "nvidia" | "amd" | "intel" | "other";
      integrated: boolean;
    }[];
    dockerGpu: boolean;
    gpuAccess: "dri" | "";
    windowsEngine: boolean;
    /** RedGiant's Windows installation (the launcher's folder is shared). */
    onWindows?: boolean;
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
    /** The guardian (2026-11-04): ask before writing outside the project, or let it be. */
    guardian?: "ask" | "auto";
    /** Skills written by agents (G29.4): wait for the human, or install once tested. */
    skills?: "ask" | "auto";
  };
  budgetUsd: number | null;
  canRunSearch: boolean;
  /**
   * «Next layer ahead» (G32.2): this version's release has the patched engine, or not; null (or
   * absent, an older server) where it does not apply (not Windows, no NVIDIA card).
   */
  moePrefetch?: "available" | "missing" | null;
}

export interface GgufFile {
  file: string;
  sizeGb: number;
  quant: string | null;
}

export type EngineVariant = "cpu" | "cuda" | "vulkan" | "windows";

/** A suggested local model with the best file for this computer (G24.3). */
export interface LocalModelChoice extends LocalModel {
  file: (GgufFile & { quality: "high" | "good" | "reduced" }) | null;
  smallestGb: number | null;
  unavailable?: boolean;
  /** SSD stream: bigger than RAM and card together, part of it read from the SSD at each token. */
  beyondMemory?: boolean;
  /** Every version worth offering, smallest first. */
  versions?: (GgufFile & { quality: "high" | "good" | "reduced" })[];
  /** The small model's file for speculative decoding, when the family has one. */
  draftFile?: GgufFile;
}

/** A file of the models folder: ready, or a download paused halfway. */
export interface LocalFile {
  file: string;
  bytes: number;
  partial: boolean;
}

/**
 * A subscription's program (2026-11-05): carried, downloaded before, the person's own, or not
 * here yet (downloaded when switched on); and whether the person's own sign-in is used.
 */
export interface SubscriptionProgram {
  program?: "bundled" | "downloaded" | "system" | null;
  sharedLogin?: boolean;
}

/** Chat platforms besides Telegram (G29.5). */
export type ChatPlatform = "discord" | "slack" | "signal" | "whatsapp";

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
  kind: "god" | "demigod" | "orchestrator" | "agent" | "subagent" | "inspector" | "assistant";
  parentId: string | null;
  projectId: string | null;
  name: string;
  role?: string;
  systemPrompt?: string;
  model?: { provider: string; model: string; effort?: string };
  mode?: string;
  /** For assistants: the services they may use. */
  connections?: string[];
  /** The subproject it works in (G24.13). */
  subprojectId?: string;
  /** The skills it uses; all when absent (G24.14c). */
  skills?: string[];
  /** When its conversations are summarised and how much stays (G24.14c). */
  compaction?: { at?: number; keep?: number };
  /** Other projects it is assigned to, under their orchestrators (2026-11-03). */
  projects?: string[];
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
  /** The subproject it belongs to; null: the whole project (G24.14c). */
  subprojectId?: string | null;
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
  transport:
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "http"; url: string; oauth?: boolean };
}

/** A part of a project in its own folder (G24.13). */
export interface Subproject {
  id: string;
  projectId: string;
  name: string;
  dir: string;
  createdAt: string;
}

/** A group chat (G24.12): the person and 1–6 agents, each answering in its own session. */
export interface Room {
  id: string;
  title: string;
  members: { agentId: string; sessionId: string; costUsd?: number; context?: number }[];
  createdAt: string;
  lastAt: string | null;
  answering: string[];
}

export interface McpStatus {
  name: string;
  projectId: string | null;
  state: "connected" | "login" | "error";
  tools: number;
  error?: string;
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
  /** The Chat's agent (2026-11-03), made on first use. */
  chatAgent = () => this.call<Agent>("GET", "/api/chat/agent");
  /** Its id if it exists already (nothing is made). */
  chatAgentIdOf = () => this.call<{ id: string | null }>("GET", "/api/chat/agent-id");
  sessions = (agentId?: string) =>
    this.call<SessionInfo[]>("GET", `/api/sessions${agentId ? `?agentId=${agentId}` : ""}`);
  updateSession = (
    id: string,
    change: {
      title?: string;
      pinned?: boolean;
      archived?: boolean;
      model?: { provider: string; model: string; effort?: string } | null;
      folder?: string | null;
    },
  ) => this.call("PATCH", `/api/sessions/${id}`, change);
  models = () => this.call<ModelChoice[]>("GET", "/api/models");
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
    subprojectId?: string | null;
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
  /** A skill's folder as a .zip, to share it (scope as in `installed`). */
  async exportSkill(name: string, scope: string): Promise<{ blob: Blob; name: string }> {
    const r = await fetch(
      `/api/extensions/skills/${encodeURIComponent(name)}/export?scope=${encodeURIComponent(scope)}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    }
    return { blob: await r.blob(), name: `${name}.zip` };
  }
  /** Installs a shared skill (.zip); a 409 means one of that name exists (ask, then `replace`). */
  async importSkill(
    file: Blob,
    scope: string,
    replace = false,
  ): Promise<{ name: string; description: string; replaced: boolean }> {
    const r = await fetch(
      `/api/extensions/skills/import?scope=${encodeURIComponent(scope)}${replace ? "&replace=1" : ""}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/zip" },
        body: file,
      },
    );
    const data = (await r.json().catch(() => ({}))) as {
      error?: string;
      name: string;
      description: string;
      replaced: boolean;
    };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data;
  }
  mcpServers = () => this.call<McpEntry[]>("GET", "/api/extensions/mcp");
  setMcp = (m: {
    name: string;
    projectId: string | null;
    transport: McpEntry["transport"];
    secrets?: { headers?: Record<string, string>; env?: Record<string, string> };
  }) => this.call("PUT", "/api/extensions/mcp", m);
  subprojects = (projectId: string) =>
    this.call<Subproject[]>("GET", `/api/projects/${projectId}/subprojects`);
  /** An existing project goes into this one as a subproject, with its history (G24.14c). */
  adoptProject = (projectId: string, project: string, dir?: string) =>
    this.call<Subproject>("POST", `/api/projects/${projectId}/adopt`, {
      project,
      ...(dir && { dir }),
    });
  /** A subproject's own sandbox image; null: the project's again. */
  setSubprojectImage = (projectId: string, sub: string, image: string | null) =>
    this.call("PATCH", `/api/projects/${projectId}/subprojects/${encodeURIComponent(sub)}`, {
      image,
    });
  createSubproject = (projectId: string, name: string, dir?: string) =>
    this.call<Subproject>("POST", `/api/projects/${projectId}/subprojects`, {
      name,
      ...(dir && { dir }),
    });
  rooms = () => this.call<Room[]>("GET", "/api/rooms");
  /** `members` takes agent ids, or "inspector:<project>" for a project's inspector. */
  createRoom = (r: {
    title?: string;
    members: string[];
    from?: { agentId: string; sessionId: string };
    /** An earlier chat this group continues. */
    context?: string;
  }) => this.call<Room>("POST", "/api/rooms", r);
  roomEvents = (id: string) => this.call<Event[]>("GET", `/api/rooms/${id}/events`);
  addRoomMember = (id: string, agentId: string) =>
    this.call<Room>("POST", `/api/rooms/${id}/members`, { agentId });
  removeRoomMember = (id: string, agentId: string) =>
    this.call<Room>("DELETE", `/api/rooms/${id}/members/${encodeURIComponent(agentId)}`);
  postRoom = (id: string, text: string, images: import("@redgiant/protocol").ImagePart[] = []) =>
    this.call("POST", `/api/rooms/${id}/messages`, { text, ...(images.length > 0 && { images }) });
  mcpStatus = () => this.call<McpStatus[]>("GET", "/api/extensions/mcp/status");
  /** Signs in to a server: either it already works, or the service's sign-in page. */
  mcpLogin = (name: string, origin: string) =>
    this.call<{ connected: true; tools: number } | { authorizeUrl: string }>(
      "POST",
      `/api/extensions/mcp/${encodeURIComponent(name)}/login`,
      { origin },
    );
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
  setChatFolder = (id: string, folder: string | null) =>
    this.call("PATCH", `/api/chats/${id}`, { folder });
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
  setupEngine = (
    engine: {
      variant: EngineVariant;
      model: string;
      stream?: boolean;
      /** Bigger reading passes (G32.1). */
      bigChunks?: boolean;
      /** «Next layer ahead» (G32.2). */
      moePrefetch?: boolean;
      speculative?: "draft" | "ngram";
      draftModel?: string;
      /** A row of the tuning table picked by the person (2026-11-05). */
      tuning?: { moeCacheShare: number; opOffload: boolean; batch?: number };
    } | null,
  ) => this.call<Job>("PUT", "/api/setup/engine", { engine });
  setupNames = (b: Record<string, unknown>) => this.call("PUT", "/api/setup/names", b);
  setupTelegram = (token: string | null) =>
    this.call<{ username: string } | null>("PUT", "/api/setup/telegram", { token });
  setupSafety = (b: Record<string, unknown>) => this.call("PUT", "/api/setup/safety", b);
  setupInstructions = (text: string) => this.call("PUT", "/api/setup/instructions", { text });
  setupBackupModel = (model: { provider: string; model: string; effort?: string } | null) =>
    this.call("PUT", "/api/setup/backup-model", { model });
  /** The conversation an agent works in for the chats (the same on every platform). */
  workSession = (agentId: string) =>
    this.call<{ sessionId: string }>("POST", `/api/agents/${agentId}/work-session`);
  /** An agent's or a project's notes (memory), or the shared notes about the person. */
  notes = (q: { scope: string; agentId?: string; projectId?: string }) =>
    this.call<{ text: string }>("GET", `/api/notes?${new URLSearchParams(q)}`);
  setNotes = (q: { scope: string; agentId?: string; projectId?: string }, text: string) =>
    this.call("PUT", `/api/notes?${new URLSearchParams(q)}`, { text });
  /** A copy of a conversation up to (not including) one event, to send an edited message. */
  forkSession = (sessionId: string, beforeSeq: number) =>
    this.call<{ sessionId: string }>("POST", `/api/sessions/${sessionId}/fork`, { beforeSeq });
  setupSubscriptions = (b: Record<string, unknown>) =>
    this.call("PUT", "/api/setup/subscriptions", b);
  chatgptStatus = () =>
    this.call<
      {
        on: boolean;
        account: { email: string | null; plan: string | null } | null;
      } & SubscriptionProgram
    >("GET", "/api/subscriptions/chatgpt");
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
  /** Opens a way in from outside home: a job to follow. */
  startRemote = (
    req:
      | { way: "tailscale" }
      | { way: "cloudflare"; token: string; hostname: string }
      | { way: "caddy"; domain: string },
  ) => this.call<Job>("POST", "/api/setup/remote", req);
  stopRemote = () => this.call("DELETE", "/api/setup/remote");
  setPassword = (password: string) => this.call("PUT", "/api/auth/password", { password });
  newCodeSecret = () => this.call<{ secret: string; url: string }>("POST", "/api/auth/code/new");
  enableCode = (secret: string, code: string) =>
    this.call("POST", "/api/auth/code", { secret, code });
  disableCode = () => this.call("DELETE", "/api/auth/code");
  loginSessions = () =>
    this.call<
      {
        id: string;
        name: string;
        createdAt: string;
        expiresAt: string;
        lastSeenAt: string | null;
      }[]
    >("GET", "/api/auth/sessions");
  revokeSessions = () => this.call("POST", "/api/auth/sessions/revoke");
  setupGithub = (token: string) =>
    this.call<{ login: string }>("PUT", "/api/setup/github", { token });
  removeGithub = () => this.call("DELETE", "/api/setup/github");
  /** Starts Gitea: a job to follow. */
  startGitea = (user: string, password: string) =>
    this.call<Job>("POST", "/api/setup/gitea", { user, password });
  stopGitea = () => this.call("DELETE", "/api/setup/gitea");
  /** Starts Pi-hole, the home's own DNS: a job to follow. */
  startPihole = (lanIp: string, domain?: string) =>
    this.call<Job>("POST", "/api/setup/pihole", { lanIp, ...(domain && { domain }) });
  stopPihole = () => this.call("DELETE", "/api/setup/pihole");
  piholePassword = () =>
    this.call<{ password: string | null }>("GET", "/api/setup/pihole/password");
  gitSync = () =>
    this.call<{ project: string; ok: boolean; error?: string; code?: string }[]>(
      "POST",
      "/api/setup/git/sync",
    );
  claudeStatus = () =>
    this.call<{ on: boolean; account: ClaudeAccount | null } & SubscriptionProgram>(
      "GET",
      "/api/subscriptions/claude",
    );
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
  localModels = (variant: EngineVariant, stream = false) =>
    this.call<{
      models: LocalModelChoice[];
      files: LocalFile[];
      budgetGb?: number;
      diskFreeGb?: number;
    }>("GET", `/api/setup/local-models?variant=${variant}${stream ? "&stream=1" : ""}`);
  /** Downloads a model file: a job to follow; cancelling it pauses, starting again goes on. */
  downloadModel = (repo: string, file: string, variant: EngineVariant) =>
    this.call<Job>("POST", "/api/setup/local-models/download", { repo, file, variant });
  removeModel = (file: string, variant: EngineVariant) =>
    this.call("DELETE", `/api/setup/local-models/${encodeURIComponent(file)}?variant=${variant}`);
  jobs = () => this.call<Job[]>("GET", "/api/jobs");
  job = (id: string) => this.call<Job>("GET", `/api/jobs/${encodeURIComponent(id)}`);
  /** The models out of WSL to the engine on Windows (2026-11-04): a job with a bar. */
  /** The local model turned on (a job that loads it) or off (2026-11-04). */
  setEnginePower = (on: boolean) => this.call<Job | null>("PUT", "/api/setup/engine/power", { on });
  /** Measures what speculative decoding gains here (2026-11-04): a job; the engine is put back. */
  speedTest = (
    engine: {
      variant: EngineVariant;
      model: string;
      stream?: boolean;
      draftModel?: string;
    },
    modes: ("none" | "draft" | "ngram")[],
  ) => this.call<Job>("POST", "/api/setup/engine/speed-test", { engine, modes });
  cancelJob = (id: string) => this.call("POST", `/api/jobs/${encodeURIComponent(id)}/cancel`);
  platform = () => this.call<PlatformInfo>("GET", "/api/platform");
  platformChanges = () => this.call<PlatformChange[]>("GET", "/api/platform/changes");
  undoCompaction = (sessionId: string) =>
    this.call("POST", `/api/sessions/${sessionId}/compaction/undo`);
  promoteChange = (id: string) =>
    this.call<{ commit: string }>("POST", `/api/platform/changes/${id}/promote`);
  spendDaily = (from: string) =>
    this.call<{ day: string; scope: Budget["scope"]; id: string; usd: number; tokens: number }[]>(
      "GET",
      `/api/budgets/daily?from=${from}`,
    );
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
  emailSettings = () =>
    this.call<{
      configured: boolean;
      host?: string;
      port?: number;
      secure?: boolean;
      user?: string;
    }>("GET", "/api/settings/email");
  setEmailSettings = (a: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  }) => this.call("PUT", "/api/settings/email", a);
  removeEmailSettings = () => this.call("DELETE", "/api/settings/email");
  /** Adds the routine's webhook to the project's repository (Gitea or GitHub). */
  repoHook = (id: string, secret: string, project: string) =>
    this.call("POST", `/api/automations/${id}/repo-hook`, { secret, project });
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
  setupChat = (p: ChatPlatform, settings: Record<string, string> | null) =>
    this.call("PUT", `/api/setup/chats/${p}`, { settings });
  chatPair = (p: ChatPlatform) =>
    this.call<{ code: string; expiresAt: string }>("POST", `/api/chats/${p}/pair`);
  chatLinks = (p: ChatPlatform) =>
    this.call<{ userId: string; username: string | null; linkedAt: string }[]>(
      "GET",
      `/api/chats/${p}/links`,
    );
  chatUnlink = (p: ChatPlatform, userId: string) =>
    this.call("DELETE", `/api/chats/${p}/links/${encodeURIComponent(userId)}`);
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
  /** Debug mode (2026-11-04): its state, the switch, deleting the logs. */
  debugState = () =>
    this.call<{ enabled: boolean; forced: boolean; bytes: number; files: number }>(
      "GET",
      "/api/debug",
    );
  setDebug = (enabled: boolean) =>
    this.call<{ enabled: boolean; forced: boolean; bytes: number; files: number }>(
      "PUT",
      "/api/debug",
      {
        enabled,
      },
    );
  clearDebugLogs = () =>
    this.call<{ enabled: boolean; forced: boolean; bytes: number; files: number }>(
      "DELETE",
      "/api/debug/logs",
    );
  /** Every log as one archive, to send to whoever helps. */
  async debugLogs(): Promise<{ blob: Blob; name: string }> {
    const r = await fetch("/api/debug/logs", {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
    const header = r.headers.get("content-disposition") ?? "";
    const name = header.match(/filename="([^"]+)"/)?.[1] ?? "redgiant-logs.tar.gz";
    return { blob: await r.blob(), name };
  }
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

  /** Who makes one kind of media (G25.3); null: nobody. */
  setupMedia = (kind: string, choice: { provider: string; model: string; voice?: string } | null) =>
    this.call("PUT", `/api/setup/media/${encodeURIComponent(kind)}`, { choice });
  setupMediaKey = (provider: string, key: string | null) =>
    this.call("PUT", `/api/setup/media-keys/${encodeURIComponent(provider)}`, { key });
  mediaVoices = (provider: string) =>
    this.call<{ id: string; label: string }[]>(
      "GET",
      `/api/setup/media/voices?provider=${encodeURIComponent(provider)}`,
    );
  /** The person chose a variant of a board, or commented on one (G25.4). */
  answerVariants = (
    sessionId: string,
    a: { proposalId: string; variant: number | null; choice?: boolean; comment?: string },
  ) => this.call("POST", `/api/sessions/${encodeURIComponent(sessionId)}/variants`, a);
  /** A signed link to a board's pages: `<base><n>.html`. */
  boardLink = (sessionId: string, proposalId: string) =>
    this.call<{ base: string }>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/variants/${encodeURIComponent(proposalId)}/link`,
    );
  /** A signed link to show something in the canvas (G25.1). */
  canvasLink = (
    target:
      | { kind: "file"; scope: string; path: string }
      | { kind: "port"; agentId: string; port: number; path?: string | undefined },
  ) => this.call<{ url: string }>("POST", "/api/canvas/link", target);
  /** When what the canvas shows last changed (ms). */
  canvasVersion = (scope: string, path: string) =>
    this.call<{ version: number }>(
      "GET",
      `/api/canvas/version?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );

  /** A web search service tried before it is saved: how many results, the first's title. */
  trySearch = (c: { provider: SearchProviderId; url?: string; key?: string }) =>
    this.call<{ results: number; first?: string }>("POST", "/api/setup/search/try", c);
  /** The models to another SSD (Windows): a job for the engine's folder; the distribution restarts RedGiant. */
  moveModels = (drive: string, kind: "models" = "models", folder?: string) =>
    this.call<Job>("POST", "/api/setup/models-disk", { drive, kind, ...(folder && { folder }) });
  /** Looks for a newer RedGiant (on Windows RedGiant.exe asks on the desktop). */
  checkUpdates = () =>
    this.call<{ state: "available" | "latest" | "unreachable" | "manual"; version?: string }>(
      "POST",
      "/api/update/check",
    );
  /** RedGiant's own search engine (SearXNG). */
  startSearch = () => this.call<Job>("POST", "/api/setup/searxng");
  stopSearch = () => this.call("DELETE", "/api/setup/searxng");
  /** Backup (2026-11-03): made on the server as a job, then downloaded with its progress. */
  exportBackup = () => this.call<Job>("POST", "/api/backup/export");
  importBackup = (b: { id: string; godName?: string; demigodName?: string }) =>
    this.call<Job>("POST", "/api/backup/import", b);
  async downloadBackup(
    name: string,
    progress: (done: number, total: number) => void,
  ): Promise<Blob> {
    const r = await fetch(`/api/backup/file/${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!r.ok || !r.body) throw new ApiError(r.status, `HTTP ${r.status}`);
    const total = Number(r.headers.get("content-length") ?? 0);
    const parts: BlobPart[] = [];
    let done = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      parts.push(value);
      done += value.length;
      progress(done, total);
    }
    return new Blob(parts, { type: "application/octet-stream" });
  }
  /** A backup file sent up with its progress (fetch cannot tell an upload's), then what it holds. */
  uploadBackup(
    file: Blob,
    progress: (done: number, total: number) => void,
  ): Promise<{ id: string; preview: BackupPreview }> {
    return new Promise((ok, ko) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/backup/upload");
      x.setRequestHeader("authorization", `Bearer ${this.token}`);
      x.setRequestHeader("content-type", "application/octet-stream");
      x.upload.onprogress = (e) => progress(e.loaded, e.total || file.size);
      x.onerror = () => ko(new ApiError(0, "Network error"));
      x.onload = () => {
        let data: { error?: string } = {};
        try {
          data = JSON.parse(x.responseText) as { error?: string };
        } catch {}
        if (x.status >= 200 && x.status < 300) ok(data as { id: string; preview: BackupPreview });
        else ko(new ApiError(x.status, data.error ?? `HTTP ${x.status}`));
      };
      x.send(file);
    });
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

/** How this installation signs in (before any token): a password, and a code too. */
export async function loginMethods(): Promise<{ password: boolean; code: boolean }> {
  const r = await fetch("/api/auth/methods");
  return r.ok
    ? ((await r.json()) as { password: boolean; code: boolean })
    : { password: false, code: false };
}

/** A password (and code) for a session token; errors carry their code. */
export async function passwordLogin(password: string, code?: string): Promise<string> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, ...(code && { code }) }),
  });
  const data = (await r.json().catch(() => ({}))) as {
    token?: string;
    error?: string;
    code?: string;
  };
  if (!r.ok || !data.token)
    throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`, data.code);
  return data.token;
}
