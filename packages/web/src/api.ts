import {
  type Automation,
  type AutomationRun,
  type BackupPreview,
  type ClientMessage,
  type CloudEmbeddingModel,
  type Event,
  type FoundBackup,
  type ImportApply,
  type ImportPreview,
  type ImportRecord,
  type Job,
  type KnowledgeAgentCollection,
  type KnowledgeCollection,
  type KnowledgeCollectionInput,
  type KnowledgeDisk,
  type KnowledgeDocument,
  type KnowledgeOpenTarget,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSettings,
  type KnowledgeSource,
  type KnowledgeSourceInput,
  type KnowledgeStatus,
  type LocalEmbeddingModel,
  type LocalModel,
  type LocalRerankModel,
  type MagicAutomation,
  type Mailbox as MailboxInfo,
  type OcrLanguage,
  type PermissionRequestInfo,
  PROTOCOL_VERSION,
  type Recipe,
  type RefineEstimate,
  type RefineRequest,
  type RefineResult,
  type SearchProviderId,
  type ServerMessage,
  type SharedMemoryEntry,
  type SharedMemoryView,
  type UpdateStatus,
  type VaultBrowser,
  type VaultBrowserCode,
  type VaultEntry,
  type VaultImportPreview,
  type VaultInput,
  type VaultView,
} from "@redgiant/protocol";

/** What the «Knowledge» page can choose (`GET /api/knowledge/models`). */
export interface KnowledgeModels {
  providers: readonly string[];
  rerankProviders: readonly string[];
  local: (LocalEmbeddingModel & { here: boolean })[];
  localRerank: (LocalRerankModel & { here: boolean })[];
  cloud: CloudEmbeddingModel[];
  languages: string[];
  ocr: (OcrLanguage & { here: boolean })[];
}

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
    /** The interface's language. */
    language?: "it" | "en";
    /** The language the agents speak to the person (G33.5, BCP-47). */
    agentLanguage?: string;
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
  names: {
    god: string | null;
    demigod: string | null;
    godPrompt: string | null;
    /** God's built-in instructions, {name} and {demigod} standing for the names. */
    godPromptTemplate?: string;
  };
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
  /** The same for the `cuda` engine in Docker (Linux): the patched image is there, or not. */
  moePrefetchImage?: "available" | "missing" | null;
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
export type ChatPlatform =
  | "discord"
  | "slack"
  | "signal"
  | "whatsapp"
  | "matrix"
  | "teams"
  | "imessage";

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
  /** Archived (2026-11-09): out of every list, read only until it is restored. */
  archivedAt?: string;
}

/** Who works in a project now: what archiving it stops (the window says it first). */
export interface ProjectWork {
  working: { sessionId: string; agentId: string; agentName: string; title: string | null }[];
  automations: { id: string; name: string }[];
}

/** A project's task, from the log. */
export interface ProjectTask {
  id: string;
  title: string;
  agentId: string | null;
  agentName: string;
  sessionId: string | null;
  outcome: "open" | "verified" | "not_testable" | "abandoned";
  openedAt: string;
}

/** Instructions as the person reads them: the text in use, whether built-in, and the built-in one. */
export interface PromptView {
  text: string;
  isDefault: boolean;
  defaultText: string;
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
  /** The title of the task it works on, while one is open (p3.5.4). */
  task?: string | null;
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
    /** G36.8: the problem and what worked, in the agent's words. */
    summary?: string;
    /** G36.8: it changes the installed skill of the same name. */
    updates?: boolean;
  };
  /** G36.8: the installed skill an update replaces, as it is now. */
  previous?: { skillMd: string; files: string[] } | null;
  decidedBy?: string | null;
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

/** A loss as a stable code (`loss_<code>` in i18n) with its values; null code: only the English. */
export interface LossCode {
  code: string | null;
  vars?: Record<string, string>;
}

/** The closed app a file needs when no free program can read it (INDD, Affinity, XD, .fig). */
export interface FileNeeds {
  app: "affinity" | "indesign" | "figma" | "xd";
  name: string;
  url?: string;
  /** The open format another program can make from it instead (INDD: the IDML). */
  alt?: string;
  /** What to export from the app, beside the file. */
  export: string[];
  /** For the agents, in English. */
  message: string;
  /** The app is on this computer: «Open in…» works. */
  installed: boolean;
}

/** The converter's report on a file (G34.3, `GET /api/files/convert`). */
export interface FileReport {
  path: string;
  format: { id: string; name: string; kind: string; open: boolean; browser: boolean } | null;
  needsConversion: boolean;
  suggested: boolean;
  targets: {
    ext: string;
    via: string;
    /** In English, for the agents; `lossCodes` says the same for the page. */
    losses: string[];
    lossCodes?: LossCode[];
    asked?: boolean;
    unless?: string;
    preview?: boolean;
    program?: { id: string; name: string; here: boolean; canDownload: boolean; size: string };
  }[];
  converted: {
    outputs: { path: string; ext: string }[];
    losses: string[];
    lossCodes?: LossCode[];
    convertedAt: string;
    stale: boolean;
    /** Only the picture stored inside the file: not a conversion. */
    previewOnly?: boolean;
  } | null;
  needs?: FileNeeds;
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
  projectWork = (id: string) => this.call<ProjectWork>("GET", `/api/projects/${id}/work`);
  projectTasks = (id: string) => this.call<ProjectTask[]>("GET", `/api/projects/${id}/tasks`);
  archiveProject = (id: string) => this.call<unknown>("POST", `/api/projects/${id}/archive`);
  restoreProject = (id: string) => this.call<unknown>("POST", `/api/projects/${id}/restore`);
  agents = () => this.call<Agent[]>("GET", "/api/agents");
  createAgent = (a: Record<string, unknown>) => this.call<Agent>("POST", "/api/agents", a);
  configureAgent = (id: string, change: Record<string, unknown>) =>
    this.call<Agent>("PATCH", `/api/agents/${id}`, change);
  /** An agent's instructions as they are now, and the built-in ones (2026-11-06). */
  agentPrompt = (id: string) => this.call<PromptView>("GET", `/api/agents/${id}/prompt`);
  /** null: the built-in instructions again. */
  setAgentPrompt = (id: string, text: string | null) =>
    this.call<PromptView>("PUT", `/api/agents/${id}/prompt`, { text });
  chatPrompt = () => this.call<PromptView>("GET", "/api/chat/prompt");
  setChatPrompt = (text: string | null) =>
    this.call<PromptView>("PUT", "/api/chat/prompt", { text });
  /** About how much a revision of instructions takes (G36.13): nothing is spent. */
  refineEstimate = (r: RefineRequest) =>
    this.call<RefineEstimate>("POST", "/api/prompts/refine/estimate", r);
  /** A revised text and what changed: never saved by itself. */
  refinePrompt = (r: RefineRequest) => this.call<RefineResult>("POST", "/api/prompts/refine", r);
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
  /** The interface's language and the agents' (G33.5). */
  setupLanguages = (b: { language?: "it" | "en"; agentLanguage?: string }) =>
    this.call("PUT", "/api/setup/languages", b);
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
  /** The shared memory (G33.2): what every agent knows about the person. */
  sharedMemory = () => this.call<SharedMemoryView>("GET", "/api/memory");
  addMemory = (text: string) =>
    this.call<{ entry: SharedMemoryEntry; duplicate: boolean }>("POST", "/api/memory", { text });
  editMemory = (id: string, text: string) =>
    this.call<SharedMemoryEntry>("PUT", `/api/memory/${encodeURIComponent(id)}`, { text });
  removeMemory = (id: string) => this.call("DELETE", `/api/memory/${encodeURIComponent(id)}`);
  undoMemory = (seq: number) => this.call("POST", "/api/memory/undo", { seq });
  /** Forgets a memory for good: its text goes from every past change too. */
  forgetMemory = (id: string) => this.call("POST", `/api/memory/${encodeURIComponent(id)}/forget`);
  setMemoryAuto = (auto: boolean) => this.call("PUT", "/api/memory/settings", { auto });
  /** The keychain (G33.4): values go up once and come back only through `revealVault`. */
  vault = () => this.call<VaultView>("GET", "/api/vault");
  addVault = (e: VaultInput) => this.call<VaultEntry>("POST", "/api/vault", e);
  editVault = (id: string, e: VaultInput) =>
    this.call<VaultEntry>("PUT", `/api/vault/${encodeURIComponent(id)}`, e);
  removeVault = (id: string) => this.call("DELETE", `/api/vault/${encodeURIComponent(id)}`);
  revealVault = (id: string) =>
    this.call<{ value: string }>("POST", `/api/vault/${encodeURIComponent(id)}/reveal`);
  previewVaultImport = (csv: string) =>
    this.call<VaultImportPreview>("POST", "/api/vault-import/preview", { csv });
  confirmVaultImport = (id: string, keep: number[]) =>
    this.call<{ added: number }>("POST", "/api/vault-import/confirm", { id, keep });
  exportVault = (passphrase: string) =>
    this.call<{ file: string }>("POST", "/api/vault-export", { passphrase });
  importVaultFile = (file: string, passphrase: string) =>
    this.call<{ added: number }>("POST", "/api/vault-import/sealed", { file, passphrase });
  /** Browsers linked to the keychain (G36.21): the list, a code to link one, «Unlink». */
  vaultBrowsers = () => this.call<VaultBrowser[]>("GET", "/api/vault-browsers");
  vaultBrowserCode = () => this.call<VaultBrowserCode>("POST", "/api/vault-browsers/code");
  unlinkVaultBrowser = (id: string) =>
    this.call("DELETE", `/api/vault-browsers/${encodeURIComponent(id)}`);
  // Import from other agents (G36.7).
  importScan = (places: { home?: boolean; projects?: boolean; folder?: string }) =>
    this.call<ImportPreview>("POST", "/api/import/scan", places);
  importUpload = () => this.call<{ id: string }>("POST", "/api/import/upload");
  importPreview = (id: string) =>
    this.call<ImportPreview>("POST", `/api/import/upload/${encodeURIComponent(id)}/preview`);
  importApply = (body: ImportApply) => this.call<Job>("POST", "/api/import/apply", body);
  importHistory = () => this.call<ImportRecord[]>("GET", "/api/import/history");
  importUndo = (id: string) =>
    this.call<ImportRecord>("POST", `/api/import/${encodeURIComponent(id)}/undo`);
  importMemories = (id: string) =>
    this.call<ImportPreview>("POST", `/api/import/${encodeURIComponent(id)}/memories`);
  /** One picked file into an upload (a .zip is opened there), with its progress. */
  importFile(
    id: string,
    path: string,
    file: Blob,
    progress: (done: number, total: number) => void,
  ): Promise<{ added: number }> {
    return new Promise((ok, ko) => {
      const x = new XMLHttpRequest();
      x.open(
        "PUT",
        `/api/import/upload/${encodeURIComponent(id)}?path=${encodeURIComponent(path)}`,
      );
      x.setRequestHeader("authorization", `Bearer ${this.token}`);
      x.setRequestHeader("content-type", "application/octet-stream");
      x.upload.onprogress = (e) => progress(e.loaded, e.total || file.size);
      x.onerror = () => ko(new ApiError(0, "Network error"));
      x.onload = () => {
        let data: { error?: string; added?: number } = {};
        try {
          data = JSON.parse(x.responseText) as typeof data;
        } catch {}
        if (x.status >= 400) ko(new ApiError(x.status, data.error ?? x.statusText));
        else ok({ added: data.added ?? 0 });
      };
      x.send(file);
    });
  }
  /**
   * A new conversation that goes on from this one (G36.23): from a message (`fromSeq`, «Continua da
   * qui») or before one (`beforeSeq`, to send it edited).
   */
  forkSession = (sessionId: string, at: { fromSeq: number } | { beforeSeq: number }) =>
    this.call<{ sessionId: string }>("POST", `/api/sessions/${sessionId}/fork`, at);
  /** «Intanto» (G36.24): a side question, never part of the conversation. */
  aside = (sessionId: string, question: string) =>
    this.call<{ aside: { id: string; answer: string; error?: string } }>(
      "POST",
      `/api/sessions/${sessionId}/aside`,
      { question },
    );
  /** «Porta nella chat»: the side question and its answer become a normal exchange. */
  promoteAside = (sessionId: string, asideId: string) =>
    this.call("POST", `/api/sessions/${sessionId}/asides/${asideId}/chat`);
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
  /** The tools page (G34.5): every common tool and its weight, for every agent or for one. */
  toolsView = (agentId?: string) =>
    this.call<import("@redgiant/protocol").ToolsView>(
      "GET",
      `/api/tools${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
    );
  /** Background commands' and bash's limits (G36.16, Settings > Commands). */
  commandSettings = () =>
    this.call<{
      settings: import("@redgiant/protocol").CommandSettings;
      defaults: import("@redgiant/protocol").CommandSettings;
      /** The steps of a turn when none is chosen (REDGIANT_MAX_TURNS, else 50; G36.15). */
      serverMaxTurns?: number;
    }>("GET", "/api/settings/commands");
  setCommandSettings = (s: import("@redgiant/protocol").CommandSettings) =>
    this.call<PlatformChange>("PUT", "/api/settings/commands", s);
  /** What reaches the person and what their classifier decides (G36.17, Settings > Requests). */
  requestSettings = () =>
    this.call<{
      settings: import("@redgiant/protocol").RequestSettings;
      defaults: import("@redgiant/protocol").RequestSettings;
      defaultModel: { provider: string; model: string } | null;
      /** The truly dangerous requests (G36.17b): they always reach the person. */
      critical: import("@redgiant/protocol").CriticalId[];
    }>("GET", "/api/settings/requests");
  setRequestSettings = (s: import("@redgiant/protocol").RequestSettings) =>
    this.call<PlatformChange>("PUT", "/api/settings/requests", s);
  /** The rule for the agents' edits in the editor (G37.1): at once or proposed, per agent or file. */
  editorSettings = () =>
    this.call<{ settings: import("@redgiant/protocol").EditorSettings }>(
      "GET",
      "/api/settings/editor",
    );
  setEditorSettings = (s: import("@redgiant/protocol").EditorSettings) =>
    this.call<PlatformChange>("PUT", "/api/settings/editor", s);
  /** A file before and after a change, a turn or a proposal (G37.2: the difference view). */
  editorDiff = (
    file: import("@redgiant/protocol").DocFile,
    what: { revision?: number; groupId?: string; proposalId?: string },
  ) =>
    this.call<{
      before: import("@redgiant/protocol").DocSnapshot;
      after: import("@redgiant/protocol").DocSnapshot;
      from: number;
      to: number;
    }>("POST", "/api/editor/diff", { file, ...what });
  /** Requests decided without the person (the classifier, or the time running out). */
  unattended = () =>
    this.call<import("@redgiant/protocol").UnattendedDecision[]>("GET", "/api/unattended");
  /** Tools off for every agent (the essential ones are refused). */
  setToolsOff = (off: string[]) => this.call<PlatformChange>("PUT", "/api/tools", { off });
  /** One agent's own choice: always on, off, or as for every agent ("default"). */
  setAgentTools = (agentId: string, tools: Record<string, "on" | "off" | "default">) =>
    this.call<PlatformChange>("PUT", `/api/agents/${encodeURIComponent(agentId)}/tools`, {
      tools,
    });
  /** What an agent's summaries do when it sets nothing (12% kept on a local model). */
  compactionDefaults = (agentId: string) =>
    this.call<{ at: number; keep: number }>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/compaction-defaults`,
    );
  /** A background command's log (p3.3.1): the last lines, or from a line on. */
  commandOutput = (sessionId: string, id: string, from?: number) =>
    this.call<{
      log: { started?: string; folder?: string; by?: string; command?: string; dropped: number };
      lines: { n: number; clock: string; at: number; stream: "out" | "err"; text: string }[];
      running: boolean;
    }>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(id)}/output${from ? `?from=${from}` : ""}`,
    );
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
  /** Many mailboxes, by category (G33.3); passwords never come back. */
  mailboxes = () =>
    this.call<{ boxes: MailboxInfo[]; categories: string[] }>("GET", "/api/settings/mailboxes");
  addMailbox = (b: {
    name: string;
    category: string;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    smtp?: { host: string; port: number; secure: boolean };
  }) => this.call<MailboxInfo>("POST", "/api/settings/mailboxes", b);
  updateMailbox = (
    id: string,
    b: Partial<{
      name: string;
      category: string;
      host: string;
      port: number;
      secure: boolean;
      user: string;
      password: string;
      smtp: { host: string; port: number; secure: boolean } | null;
    }>,
  ) => this.call<MailboxInfo>("PUT", `/api/settings/mailboxes/${encodeURIComponent(id)}`, b);
  removeMailbox = (id: string) =>
    this.call("DELETE", `/api/settings/mailboxes/${encodeURIComponent(id)}`);
  /** The recipe as the server reads it, or why not, and its next times (G33.3). */
  previewAutomation = (yaml: string, count = 5) =>
    this.call<{ recipe: Recipe | null; error: string | null; next: string[] }>(
      "POST",
      "/api/automations/preview",
      { yaml, count },
    );
  /** Magic automations (G33.3): a conversation with God that ends in a proposal. */
  magicAutomations = () => this.call<MagicAutomation[]>("GET", "/api/magic");
  magicAutomation = (id: string) => this.call<MagicAutomation>("GET", `/api/magic/${id}`);
  startMagic = (request: string) => this.call<MagicAutomation>("POST", "/api/magic", { request });
  approveMagic = (id: string, yaml?: string) =>
    this.call<{ magic: MagicAutomation; automation: Automation; webhookSecret?: string }>(
      "POST",
      `/api/magic/${id}/approve`,
      yaml ? { yaml } : {},
    );
  rejectMagic = (id: string, reason?: string) =>
    this.call<MagicAutomation>("POST", `/api/magic/${id}/reject`, reason ? { reason } : {});
  dismissMagic = (id: string) => this.call("DELETE", `/api/magic/${id}`);
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
  /** The app package to upload in Teams (G36.9), naming RedGiant's public host. */
  async teamsApp(host: string): Promise<Blob> {
    const r = await fetch(`/api/chats/teams/app.zip?host=${encodeURIComponent(host)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
    return r.blob();
  }
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
  ) =>
    // `folder`: the path is a folder (its site), not a file (p3.5.1: `Makefile`, `hosts`).
    this.call<{ url: string; folder?: boolean }>("POST", "/api/canvas/link", target);
  /** When what the canvas shows last changed (ms). */
  canvasVersion = (scope: string, path: string, fileOnly = false) =>
    this.call<{ version: number }>(
      "GET",
      `/api/canvas/version?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}${fileOnly ? "&only=file" : ""}`,
    );

  /** What a file is and what it can become (G34.3): the converter's report. */
  fileReport = (scope: string, path: string) =>
    this.call<FileReport>(
      "GET",
      `/api/files/convert?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  // ---- The knowledge (G36): what the «Knowledge» page (G36.5) uses ----
  knowledgeStatus = () => this.call<KnowledgeStatus>("GET", "/api/knowledge");
  knowledgeSearch = (input: KnowledgeSearchInput) =>
    this.call<KnowledgeSearchResult>("POST", "/api/knowledge/search", input);
  /** Where a citation opens: a file at its page or line, a web page, a mail's text, a conversation. */
  knowledgeOpen = (chunkId: string) =>
    this.call<KnowledgeOpenTarget>("GET", `/api/knowledge/open/${encodeURIComponent(chunkId)}`);
  /** The models and OCR languages one can choose (G36.5), and which are here already. */
  knowledgeModels = () => this.call<KnowledgeModels>("GET", "/api/knowledge/models");
  setKnowledgeSettings = (
    s: Partial<
      Pick<KnowledgeSettings, "embedding" | "rerank" | "threads" | "ocr" | "backupVectors">
    >,
  ) => this.call<KnowledgeSettings>("PUT", "/api/knowledge/settings", s);
  downloadKnowledgeModel = (role: "embed" | "rerank", id: string, gpu = false) =>
    this.call<{ ok: true }>("POST", "/api/knowledge/models/download", { role, id, gpu });
  downloadOcr = (languages: string[]) =>
    this.call<{ ok: true }>("POST", "/api/knowledge/ocr/download", { languages });
  rebuildKnowledge = () => this.call<{ ok: true }>("POST", "/api/knowledge/rebuild");
  pauseKnowledge = (paused: boolean) =>
    this.call<{ ok: true }>("POST", "/api/knowledge/pause", { paused });
  knowledgeDisk = () => this.call<KnowledgeDisk>("GET", "/api/knowledge/disk");
  knowledgeMailboxes = () =>
    this.call<{ mailboxes: { id: string; name: string }[] }>("GET", "/api/knowledge/mailboxes");
  knowledgeCollections = () =>
    this.call<{ collections: KnowledgeCollection[] }>("GET", "/api/knowledge/collections");
  createKnowledgeCollection = (c: KnowledgeCollectionInput) =>
    this.call<KnowledgeCollection>("POST", "/api/knowledge/collections", c);
  updateKnowledgeCollection = (id: string, c: Partial<KnowledgeCollectionInput>) =>
    this.call<KnowledgeCollection>(
      "PUT",
      `/api/knowledge/collections/${encodeURIComponent(id)}`,
      c,
    );
  removeKnowledgeCollection = (id: string) =>
    this.call<{ ok: true }>("DELETE", `/api/knowledge/collections/${encodeURIComponent(id)}`);
  knowledgeSources = (id: string) =>
    this.call<{ sources: KnowledgeSource[] }>(
      "GET",
      `/api/knowledge/collections/${encodeURIComponent(id)}/sources`,
    );
  addKnowledgeSource = (id: string, source: KnowledgeSourceInput) =>
    this.call<KnowledgeSource>(
      "POST",
      `/api/knowledge/collections/${encodeURIComponent(id)}/sources`,
      source,
    );
  removeKnowledgeSource = (id: string, source: string) =>
    this.call<{ ok: true }>(
      "DELETE",
      `/api/knowledge/collections/${encodeURIComponent(id)}/sources/${encodeURIComponent(source)}`,
    );
  rescanKnowledge = (id: string, source?: string) =>
    this.call<{ ok: true }>(
      "POST",
      `/api/knowledge/collections/${encodeURIComponent(id)}/rescan`,
      source ? { source } : {},
    );
  knowledgeDocuments = (id: string, state?: KnowledgeDocument["state"], limit = 200) =>
    this.call<{ documents: KnowledgeDocument[] }>(
      "GET",
      `/api/knowledge/collections/${encodeURIComponent(id)}/documents?limit=${limit}${state ? `&state=${state}` : ""}`,
    );
  /** One agent's collections (its window's Knowledge tab, G36.5). */
  agentKnowledge = (agentId: string) =>
    this.call<{ collections: KnowledgeAgentCollection[] }>(
      "GET",
      `/api/knowledge/agents/${encodeURIComponent(agentId)}`,
    );
  setAgentKnowledge = (agentId: string, collection: string, pick: "on" | "off" | null) =>
    this.call<{ collections: KnowledgeAgentCollection[] }>(
      "PUT",
      `/api/knowledge/agents/${encodeURIComponent(agentId)}`,
      { collection, pick },
    );
  /** Converts a file into open formats beside it: a job to follow (G34.3). */
  convertFile = (scope: string, path: string, to?: string[]) =>
    this.call<Job>("POST", "/api/files/convert", { scope, path, ...(to && { to }) });
  /** The formats the converter knows and its outside programs (here, can come down). */
  fileFormats = () =>
    this.call<{ programs: { id: string; name: string; here: boolean; canDownload: boolean }[] }>(
      "GET",
      "/api/files/formats",
    );
  /** Opens a file no free program reads in the closed app on this computer (Affinity, InDesign). */
  openWith = (scope: string, path: string) =>
    this.call<{ opened: boolean; app: string }>("POST", "/api/files/open-with", { scope, path });
  /** The paged preview of an office file (LibreOffice): ready now, or a job to follow. */
  startFilePreview = (scope: string, path: string) =>
    this.call<{ ready: boolean; job?: Job }>("POST", "/api/files/preview", { scope, path });
  /** The paged preview as a PDF, once ready. */
  async filePreview(scope: string, path: string): Promise<Blob> {
    const r = await fetch(
      `/api/files/preview?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`);
    return r.blob();
  }

  /** What saving a sheet needs, and the closed original an open copy came from (G37.3). */
  sheetInfo = (scope: string, path: string) =>
    this.call<{
      libreoffice: boolean;
      canDownload: boolean;
      original?: string;
      noReexport?: boolean;
    }>(
      "GET",
      `/api/files/sheet-info?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  /** A sheet in another format made by LibreOffice («Esporta come…», G37.3). */
  async sheetExport(scope: string, path: string, to: string): Promise<Blob> {
    const r = await fetch(
      `/api/files/sheet-export?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}&to=${encodeURIComponent(to)}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, body.error ?? `HTTP ${r.status}`);
    }
    return r.blob();
  }

  // ---- documents and presentations in the editor (G37.4) ----
  /** Whether the full editor (ZetaOffice) is here, and what it weighs the first time. */
  officeState = () =>
    this.call<import("@redgiant/protocol").OfficeEngineState>("GET", "/api/editor/office");
  /** Its download on the server, as a job with the bar. */
  officePrepare = () =>
    this.call<{ ready: boolean; job?: string }>("POST", "/api/editor/office/prepare");
  private async bytes(method: string, path: string, body?: BodyInit): Promise<Uint8Array> {
    const r = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${this.token}` },
      ...(body !== undefined && { body }),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    }
    return new Uint8Array(await r.arrayBuffer());
  }
  /** The bytes a document opens from (the file, or a page's saved one). */
  officeFile = (scope: string, path: string, hash: string) =>
    this.bytes(
      "GET",
      `/api/editor/office/file?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}&hash=${hash}`,
    );
  /** A picture an action puts in a document. */
  officeBlob = (hash: string) => this.bytes("GET", `/api/editor/blobs/${hash}`);
  /** The file the page's editor saved: kept, and the items it changed since `base`. */
  async officeUpload(scope: string, path: string, base: number, bytes: Uint8Array) {
    const r = await fetch(
      `/api/editor/office/upload?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}&base=${base}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}` },
        body: bytes as BodyInit,
      },
    );
    const data = (await r.json().catch(() => ({}))) as {
      error?: string;
      blob: string;
      size: number;
      hunks: import("@redgiant/protocol").OfficeHunk[];
    };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data;
  }
  /** The person's find and replace, applied by LibreOffice on the server. */
  officeReplace = (b: { scope: string; path: string; find: string; text: string; all: boolean }) =>
    this.call<{ revision: number }>("POST", "/api/editor/office/replace", b);
  /** The open copy of a DOCX/PPTX (made with its bar when missing). */
  officeCopy = (scope: string, path: string) =>
    this.call<{ path: string; job?: string }>("POST", "/api/editor/office/copy", { scope, path });
  /** «Esporta come…»: the document in another format. */
  async officeExport(scope: string, path: string, to: string): Promise<Blob> {
    const r = await fetch("/api/editor/office/export", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, path, to }),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    }
    return r.blob();
  }

  // ---- drawings in the editor (G37.6) ----
  /** Inkscape on this computer, how a PDF would be made, and the AI/EPS a copy came from. */
  svgInfo = (scope: string, path: string) =>
    this.call<{
      inkscape: boolean;
      pdf: "inkscape" | "libreoffice" | "download" | "missing";
      original?: string;
    }>(
      "GET",
      `/api/editor/svg/info?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  /** «Apri in Inkscape»: the drawing as last saved, in the Inkscape installed here. */
  openInInkscape = (scope: string, path: string) =>
    this.call<{ opened: boolean }>("POST", "/api/editor/svg/inkscape", { scope, path });
  /** «Esporta come PDF» (SVG and PNG are made in the page). */
  async svgExport(scope: string, path: string, to: "pdf"): Promise<Blob> {
    const r = await fetch("/api/editor/svg/export", {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope, path, to }),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    }
    return r.blob();
  }
  // ---- PDFs in the editor (G37.8) ----
  /** The PDF at its head revision (what the page shows). */
  pdfFile = (scope: string, path: string) =>
    this.bytes(
      "GET",
      `/api/editor/pdf/file?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  /** Its pages, annotations and fields at the head, and the head's revision. */
  pdfOutline = (scope: string, path: string) =>
    this.call<{ revision: number; outline: import("@redgiant/protocol").PdfOutline }>(
      "GET",
      `/api/editor/pdf/outline?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  /** A picture the person puts on a page (a stamp, a signature): kept apart, cited by hash. */
  async pdfBlob(scope: string, path: string, bytes: Uint8Array) {
    const r = await fetch(
      `/api/editor/pdf/blob?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}` },
        body: bytes as BodyInit,
      },
    );
    const data = (await r.json().catch(() => ({}))) as {
      error?: string;
      blob: string;
      mime: "image/png" | "image/jpeg";
    };
    if (!r.ok) throw new ApiError(r.status, data.error ?? `HTTP ${r.status}`);
    return data;
  }
  /** The person's redaction: checked on the written file, then applied. */
  pdfRedact = (b: {
    scope: string;
    path: string;
    page: number;
    rects: [number, number, number, number][];
  }) => this.call<{ revision: number }>("POST", "/api/editor/pdf/redact", b);
  /** The versions kept before the file was written anew (pages taken out or moved, redactions). */
  pdfVersions = (scope: string, path: string) =>
    this.call<{ versions: { name: string; size: number; at: string }[] }>(
      "GET",
      `/api/editor/pdf/versions?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`,
    );
  pdfVersion = (scope: string, path: string, name: string) =>
    this.bytes(
      "GET",
      `/api/editor/pdf/version?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
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
  /** Mandatory and breaking updates (G36.19): the last look, a look now, the window's buttons. */
  updateStatus = () => this.call<UpdateStatus>("GET", "/api/update/status");
  updateLook = () => this.call<UpdateStatus>("POST", "/api/update/look");
  updateAct = (action: "update" | "quit" | "uninstall") =>
    this.call<{ ok: true }>("POST", "/api/update/act", { action });
  /** A full backup into Documents (or the data volume), read back to the end. */
  safetyBackup = (keychainPassphrase?: string) =>
    this.call<Job>("POST", "/api/update/safety-backup", {
      ...(keychainPassphrase && { keychainPassphrase }),
    });
  /** The backups a breaking update left in that folder, for the wizard. */
  foundBackups = () => this.call<FoundBackup[]>("GET", "/api/backup/found");
  restoreFound = (id: string, keychainPassphrase?: string) =>
    this.call<Job>("POST", "/api/backup/found/import", {
      id,
      ...(keychainPassphrase && { keychainPassphrase }),
    });
  /** RedGiant's own search engine (SearXNG). */
  startSearch = () => this.call<Job>("POST", "/api/setup/searxng");
  stopSearch = () => this.call("DELETE", "/api/setup/searxng");
  /** Backup (2026-11-03): made on the server as a job, then downloaded with its progress. */
  /** With a passphrase, the keychain goes in sealed (G33.4). */
  exportBackup = (keychainPassphrase?: string) =>
    this.call<Job>(
      "POST",
      "/api/backup/export",
      keychainPassphrase ? { keychainPassphrase } : undefined,
    );
  importBackup = (b: {
    id: string;
    godName?: string;
    demigodName?: string;
    keychainPassphrase?: string;
  }) => this.call<Job>("POST", "/api/backup/import", b);
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
 * A page whose server came back as another version (3.5.3, an update) loads again, so it runs
 * the new page. `seen` is the version of the first welcome (undefined before it); a server that
 * says no version (an older one) never makes the page reload.
 */
export function versionChanged(
  seen: string | null | undefined,
  now: string | null | undefined,
): boolean {
  return seen !== undefined && now !== undefined && now !== seen;
}

/**
 * The longest wait between two reconnections: 5 s for a RedGiant on this computer (the desktop
 * launchers: after an update the page comes back within seconds, and the launcher opens no
 * other), 30 s elsewhere.
 */
export function reconnectCap(hostname: string): number {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
    ? 5_000
    : 30_000;
}

/** How often the page asks whether the server is there (p3.5.4), and how long it waits. */
export const PING_EVERY = 15_000;
export const PONG_WITHIN = 10_000;
const PING = JSON.stringify({ type: "ping" });

/**
 * The live channel, with automatic reconnection (1 s … 30 s, 5 s on this computer) and a queue
 * for messages sent while offline. After a reconnection followed sessions are followed again
 * from the last event the page has (`afterSeq`; the server sends their state again); a server
 * back as another version reloads the page.
 *
 * A heartbeat (p3.5.4, a page left with stale spinners on Windows): every `PING_EVERY` a `ping`;
 * with nothing at all from the server within `PONG_WITHIN` the connection counts as dead even if
 * the browser still calls it open: it is dropped and opened again. A «Stop» sent on a connection
 * not yet confirmed alive goes again after the reconnection.
 */
export class Live {
  private ws: WebSocket | undefined;
  private queue: ClientMessage[] = [];
  private delay = 1000;
  private closed = false;
  private readonly followed = new Set<string>();
  /** The last event seen of each followed conversation. */
  private readonly seen = new Map<string, number>();
  private readonly docs = new Map<string, ClientMessage>();
  /** Stops sent since the server last said anything: sent again if the connection was dead. */
  private unconfirmed: ClientMessage[] = [];
  private version: string | null | undefined;
  private readonly cap = reconnectCap(location.hostname);
  private beat: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") this.ping();
  };

  constructor(
    private readonly token: string,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onStatus: (s: "online" | "offline" | "connecting") => void,
    private readonly onNewVersion: () => void = () => location.reload(),
  ) {
    // Back on a page that was hidden (or frozen): check at once that the server still hears it.
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  private connect() {
    this.retry = undefined;
    this.onStatus("connecting");
    const ws = new WebSocket(wsUrl("/ws"));
    this.ws = ws;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: this.token,
          reloads: true,
        }),
      );
    ws.onmessage = (e) => {
      // Anything from the server says the connection is alive.
      this.alive();
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === "pong") return;
      if (m.type === "event" && this.followed.has(m.sessionId))
        this.seen.set(m.sessionId, Math.max(this.seen.get(m.sessionId) ?? -1, m.event.seq));
      if (m.type === "welcome") {
        if (versionChanged(this.version, m.version)) {
          this.closed = true;
          ws.close();
          this.onNewVersion();
          return;
        }
        if (this.version === undefined) this.version = m.version;
        this.delay = 1000;
        this.onStatus("online");
        for (const s of this.followed) {
          const afterSeq = this.seen.get(s);
          ws.send(
            JSON.stringify({
              type: "session.follow",
              sessionId: s,
              ...(afterSeq !== undefined && { afterSeq }),
            }),
          );
        }
        for (const d of this.docs.values()) ws.send(JSON.stringify(d));
        for (const q of this.queue.splice(0)) ws.send(JSON.stringify(q));
        this.startBeat();
      }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.stopBeat();
      this.onStatus("offline");
      if (this.closed || e.code === 4003) return;
      this.later();
    };
  }

  /** Opens the connection again after the current delay, which grows up to the cap. */
  private later() {
    if (this.retry || this.closed) return;
    this.retry = setTimeout(() => this.connect(), this.delay);
    this.delay = Math.min(this.delay * 2, this.cap);
  }

  private startBeat() {
    this.stopBeat();
    this.beat = setInterval(() => this.ping(), PING_EVERY);
  }

  private stopBeat() {
    clearInterval(this.beat);
    this.beat = undefined;
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  /** Asks the server whether it is there; silence within `PONG_WITHIN` drops the connection. */
  private ping() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closed) return;
    try {
      ws.send(PING);
    } catch {}
    this.deadline ??= setTimeout(() => this.drop(ws), PONG_WITHIN);
  }

  private alive() {
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.unconfirmed = [];
  }

  /** A connection that stopped answering: let go of it (without waiting for the browser). */
  private drop(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.stopBeat();
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {}
    this.ws = undefined;
    // What may never have arrived goes again once the connection is back.
    this.queue.unshift(...this.unconfirmed.splice(0));
    this.onStatus("offline");
    this.later();
  }

  /** True when the connection is open and has answered lately. */
  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.deadline === undefined;
  }

  send(m: ClientMessage): void {
    if (m.type === "session.follow") this.followed.add(m.sessionId);
    if (m.type === "session.unfollow") {
      this.followed.delete(m.sessionId);
      this.seen.delete(m.sessionId);
    }
    // Files open in the editor (G37.1) are opened again after a reconnection.
    if (m.type === "doc.open") this.docs.set(`${m.file.scope}\u0000${m.file.path}`, m);
    if (m.type === "doc.close") this.docs.delete(`${m.file.scope}\u0000${m.file.path}`);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      // A stop must not be lost on a dead connection: kept until the server says anything,
      // and the server is asked at once.
      if (m.type === "session.interrupt") {
        this.unconfirmed.push(m);
        this.ping();
      }
    } else this.queue.push(m);
  }

  close(): void {
    this.closed = true;
    this.stopBeat();
    clearTimeout(this.retry);
    document.removeEventListener("visibilitychange", this.onVisible);
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
