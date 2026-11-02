import { type Signal, signal } from "@preact/signals";
import type {
  Answers,
  AssistantPart,
  Event,
  ImagePart,
  MessageMetrics,
  PermissionRequestInfo,
  Question,
  QuestionRequestInfo,
  ServerMessage,
} from "@redgiant/protocol";
import {
  type Agent,
  Api,
  ApiError,
  type Budget,
  Live,
  type PlatformInfo,
  type Project,
  type Room,
  type Subproject,
} from "./api.js";
import { tOptional } from "./i18n.js";

/** What the canvas shows (G25.1): a file or folder of a workspace, or a port of an agent. */
export type CanvasTarget =
  | { kind: "file"; scope: string; path: string }
  | { kind: "port"; agentId: string; port: number; path?: string | undefined };

// ---------- Chat items (pure) ----------

export type ChatItem =
  | { kind: "user"; key: string; text: string; ts: string; images: ImagePart[]; from?: string }
  | {
      kind: "assistant";
      key: string;
      parts: AssistantPart[];
      metrics: MessageMetrics;
      costUsd: number;
      model: string;
      stopReason: string;
    }
  | {
      kind: "tool";
      key: string;
      callId: string;
      tool: string;
      input: unknown;
      result?: { ok: boolean; output: string };
    }
  | {
      kind: "question";
      key: string;
      requestId: string;
      questions: Question[];
      plan?: string;
      /** undefined: still open; null: nobody answered. */
      answers?: Answers | null;
    }
  | { kind: "notice"; key: string; tone: "info" | "warn" | "ok" | "error"; text: string }
  /** A call that should have been in the cache was not (G24.14c). */
  | { kind: "cache"; key: string; expected: number; cached: number }
  /** Something the agent showed in the canvas (G25.1): a card that opens it. */
  | { kind: "canvas"; key: string; title: string; target: CanvasTarget }
  /** The conversation was summarised here (G24.14). */
  | {
      kind: "compaction";
      key: string;
      seq: number;
      summary: string;
      reason: "auto" | "manual" | "emergency" | "engine";
      undone: boolean;
      /** The last summary asked by hand, nothing said since: it can be undone. */
      undoable: boolean;
    };

/** Their question card stands for these calls: no tool line for them. */
const QUESTION_TOOLS = new Set(["ask_user", "propose_plan"]);

/** Turns a session's events into what the chat shows. Pure: tested without a browser. */
export function buildItems(events: Event[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  const asked = new Map<string, Extract<ChatItem, { kind: "question" }>>();
  for (const e of events) {
    const key = `e${e.seq}`;
    if (e.payload === null) {
      items.push({ kind: "notice", key, tone: "warn", text: `${e.type} (erased)` });
      continue;
    }
    switch (e.type) {
      case "message.user":
        items.push({
          kind: "user",
          key,
          text: e.payload.text,
          ts: e.ts,
          images: e.payload.images ?? [],
          ...(e.payload.from && { from: e.payload.from }),
        });
        break;
      case "message.assistant":
        items.push({
          kind: "assistant",
          key,
          parts: e.payload.parts.filter((p) => p.type !== "tool_call"),
          metrics: e.payload.metrics,
          costUsd: e.payload.costUsd,
          model: e.payload.model,
          stopReason: e.payload.stopReason,
        });
        break;
      case "tool.call": {
        if (QUESTION_TOOLS.has(e.payload.tool)) break;
        const item = {
          kind: "tool" as const,
          key,
          callId: e.payload.callId,
          tool: e.payload.tool,
          input: e.payload.input,
        };
        tools.set(e.payload.callId, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const call = tools.get(e.payload.callId);
        if (call) call.result = { ok: e.payload.ok, output: e.payload.output };
        break;
      }
      case "question.asked": {
        const item = {
          kind: "question" as const,
          key,
          requestId: e.payload.requestId,
          questions: e.payload.questions,
          ...(e.payload.plan !== undefined && { plan: e.payload.plan }),
        };
        asked.set(e.payload.requestId, item);
        items.push(item);
        break;
      }
      case "question.answered": {
        const item = asked.get(e.payload.requestId);
        if (item) item.answers = e.payload.answers;
        break;
      }
      case "permission.requested":
        items.push({
          kind: "notice",
          key,
          tone: "warn",
          text: `${e.payload.reason} (${e.payload.askedTo})`,
        });
        break;
      case "permission.resolved":
        items.push({
          kind: "notice",
          key,
          tone:
            e.payload.decision === "allow"
              ? "ok"
              : e.payload.decision === "deny"
                ? "error"
                : "info",
          text: `${e.payload.decision} (${e.payload.by})`,
        });
        break;
      case "hook.blocked":
        items.push({ kind: "notice", key, tone: "error", text: e.payload.reason });
        break;
      case "compaction":
        items.push({
          kind: "compaction",
          key,
          seq: e.seq,
          summary: e.payload.summary,
          reason: e.payload.reason ?? "auto",
          undone: false,
          undoable: false,
        });
        break;
      case "engine.compacted":
        items.push({
          kind: "compaction",
          key,
          seq: e.seq,
          summary: "",
          reason: "engine",
          undone: false,
          undoable: false,
        });
        break;
      case "canvas.show":
        items.push({ kind: "canvas", key, title: e.payload.title, target: e.payload.target });
        break;
      case "cache.missed":
        items.push({
          kind: "cache",
          key,
          expected: e.payload.expected,
          cached: e.payload.cached,
        });
        break;
      case "compaction.undone": {
        const c = items.find((i) => i.kind === "compaction" && i.seq === e.payload?.compactionSeq);
        if (c?.kind === "compaction") c.undone = true;
        break;
      }
      case "task.opened":
        items.push({
          kind: "notice",
          key,
          tone: "info",
          text: `${e.payload.taskId}: ${e.payload.title}`,
        });
        break;
      case "task.verified":
        items.push({
          kind: "notice",
          key,
          tone: e.payload.passed ? "ok" : "error",
          text: e.payload.verifier,
        });
        break;
      case "task.closed":
        items.push({
          kind: "notice",
          key,
          tone: e.payload.outcome === "abandoned" ? "error" : "ok",
          text: `${e.payload.taskId}: ${e.payload.outcome}`,
        });
        break;
      case "budget.exceeded":
        items.push({
          kind: "notice",
          key,
          tone: "error",
          text: `$ budget ${e.payload.scope}: ${e.payload.used} / ${e.payload.limit}`,
        });
        break;
    }
  }
  const last = [...items].reverse().find((i) => i.kind === "compaction" && !i.undone);
  if (last?.kind === "compaction" && last.reason === "manual") {
    const after = items.slice(items.indexOf(last) + 1);
    last.undoable = !after.some((i) => i.kind === "user" || i.kind === "assistant");
  }
  return items;
}

// ---------- Live session views ----------

export interface SessionView {
  events: Event[];
  text: string;
  thinking: string;
  state: "idle" | "running";
  synced: boolean;
  /** A summary is being made while the person waits (G24.14). */
  compacting?: boolean;
  /** generate_image at work: its step and latest preview (base64 PNG). */
  drawing?: { percent: number; preview?: string } | undefined;
}

const sessions = new Map<string, Signal<SessionView>>();

export function sessionView(id: string): Signal<SessionView> {
  let s = sessions.get(id);
  if (!s) {
    s = signal<SessionView>({ events: [], text: "", thinking: "", state: "idle", synced: false });
    sessions.set(id, s);
  }
  return s;
}

/** Applies one server message to the views (events deduplicated by sequence number). */
/** The agents' browser (G24.14b): its latest frame and who drives it. */
export const browserScreen = signal<{
  frame?: { data: string; width: number; height: number };
  control: "agents" | "person";
  url: string;
  /** The agent being taught a task. */
  teaching?: string | undefined;
  unavailable?: boolean;
}>({ control: "agents", url: "" });

export function applyMessage(m: ServerMessage): void {
  switch (m.type) {
    case "browser.frame":
      browserScreen.value = {
        ...browserScreen.value,
        frame: { data: m.data, width: m.width, height: m.height },
      };
      return;
    case "browser.state":
      browserScreen.value = {
        ...browserScreen.value,
        control: m.control,
        url: m.url,
        teaching: m.teaching,
      };
      return;
    case "error":
      if (m.code === "unavailable")
        browserScreen.value = { ...browserScreen.value, unavailable: true };
      else lastError.value = tOptional(`err_${m.code}`) ?? m.message;
      return;
    case "event": {
      const v = sessionView(m.sessionId);
      if (v.value.events.some((e) => e.seq === m.event.seq)) return;
      const done = m.event.type === "message.assistant";
      // Shown while the person watches: the canvas opens by itself (not when the log replays).
      if (m.event.type === "canvas.show" && m.event.payload && v.value.synced)
        openCanvas(m.event.payload.title, m.event.payload.target);
      v.value = {
        ...v.value,
        events: [...v.value.events, m.event],
        ...(done && { text: "", thinking: "" }),
        // The picture is in the tool's result now: the live preview goes.
        ...(m.event.type === "tool.result" && { drawing: undefined }),
      };
      return;
    }
    case "image.progress": {
      const v = sessionView(m.sessionId);
      v.value = {
        ...v.value,
        drawing: {
          percent: m.percent,
          ...((m.preview ?? v.value.drawing?.preview) && {
            preview: m.preview ?? v.value.drawing?.preview,
          }),
        },
      };
      return;
    }
    case "delta": {
      const v = sessionView(m.sessionId);
      v.value =
        m.kind === "text"
          ? { ...v.value, text: v.value.text + m.text }
          : { ...v.value, thinking: v.value.thinking + m.text };
      return;
    }
    case "session.state":
      sessionView(m.sessionId).value = { ...sessionView(m.sessionId).value, state: m.state };
      // A turn just ended: the plan's limits may have moved.
      if (m.state === "idle") void refreshLimits().catch(() => {});
      sessionRows.value = sessionRows.value.map((r) =>
        r.id === m.sessionId ? { ...r, running: m.state === "running" } : r,
      );
      return;
    case "session.compacting":
      sessionView(m.sessionId).value = { ...sessionView(m.sessionId).value, compacting: m.busy };
      return;
    case "session.synced":
      sessionView(m.sessionId).value = { ...sessionView(m.sessionId).value, synced: true };
      return;
    case "permission.request":
      if (!approvals.value.some((r) => r.requestId === m.request.requestId))
        approvals.value = [...approvals.value, m.request];
      return;
    case "permission.closed":
      approvals.value = approvals.value.filter((r) => r.requestId !== m.requestId);
      return;
    case "question.request":
      if (!questions.value.some((q) => q.requestId === m.request.requestId))
        questions.value = [...questions.value, m.request];
      return;
    case "question.closed":
      questions.value = questions.value.filter((q) => q.requestId !== m.requestId);
      return;
    case "board.changed":
      boardVersion.value++;
      return;
    case "room.changed":
      roomsVersion.value++;
      void refreshRooms();
      return;
    case "automations.changed":
      automationsVersion.value++;
      return;
    case "platform.changed":
      platformVersion.value++;
      return;
  }
}

// ---------- Global state ----------

export const token = signal<string | null>(localStorage.getItem("rg.token"));
export const status = signal<"online" | "offline" | "connecting">("offline");
export const projects = signal<Project[]>([]);
export const agents = signal<Agent[]>([]);
export const approvals = signal<PermissionRequestInfo[]>([]);
/** Questions and plans waiting for the human (G20.3). */
export const questions = signal<QuestionRequestInfo[]>([]);
export const budgets = signal<Budget[]>([]);
export const lastError = signal<string | null>(null);
/** Bumped on every board change pushed by the server: board views reload. */
export const boardVersion = signal(0);
/** Bumped when an automation is edited or one of its runs starts or ends. */
export const automationsVersion = signal(0);
/** Group chats (G24.12) and a counter that moves when any of them changes. */
export const rooms = signal<Room[]>([]);
/** Every project's subprojects (G24.13). */
export const subprojects = signal<Subproject[]>([]);
export async function refreshSubprojects(): Promise<void> {
  const a = getApi();
  const all = await Promise.all(
    projects.value.map((p) => a.subprojects(p.id).catch(() => [] as Subproject[])),
  );
  subprojects.value = all.flat();
}
export const roomsVersion = signal(0);
export async function refreshRooms(): Promise<void> {
  rooms.value = await getApi()
    .rooms()
    .catch(() => rooms.value);
}
/** Bumped on every platform change; the platform view reloads. */
export const platformVersion = signal(0);
/** How the platform runs: the header warns about metal and unisolated sandboxes. */
export const platformInfo = signal<PlatformInfo | null>(null);
/** The setup wizard has never been completed: it takes the whole page. */
export const firstRun = signal(false);

let api: Api | undefined;
let live: Live | undefined;

export const getApi = (): Api => {
  if (!api) throw new Error("Not signed in");
  return api;
};
export const getLive = (): Live => {
  if (!live) throw new Error("Not signed in");
  return live;
};

/** The flat subscriptions' windows (the header's bars when the open chat uses one). */
export const limits = signal<import("./api.js").PlanLimits[]>([]);
export async function refreshLimits(): Promise<void> {
  limits.value = await getApi()
    .limits()
    .catch(() => limits.value);
}

/** The model an agent inherits from its ancestors (RD13). */
export function inheritedModel(agentId: string) {
  let a = agents.value.find((x) => x.id === agentId);
  while (a) {
    if (a.model) return a.model;
    a = agents.value.find((x) => x.id === a?.parentId);
  }
  return undefined;
}

/** The open conversation and the model it uses (its own, or its agent's). */
export function activeChat() {
  const tab = tabs.value.find((x) => x.id === activeTab.value);
  if (tab?.type !== "chat") return undefined;
  const own = sessionRows.value.find((r) => r.id === tab.sessionId)?.model ?? undefined;
  const agent = agents.value.find((a) => a.id === tab.agentId);
  return { sessionId: tab.sessionId, model: own ?? agent?.model ?? inheritedModel(tab.agentId) };
}

export async function refresh(): Promise<void> {
  const a = getApi();
  [projects.value, agents.value, approvals.value, budgets.value, platformInfo.value] =
    await Promise.all([a.projects(), a.agents(), a.approvals(), a.budgets(), a.platform()]);
  await refreshConversations().catch(() => {});
  await refreshRooms();
  await refreshSubprojects();
  await refreshLimits();
}

export async function signIn(t: string): Promise<void> {
  api = new Api(t);
  await api.projects(); // throws on a wrong token
  localStorage.setItem("rg.token", t);
  token.value = t;
  live?.close();
  live = new Live(t, applyMessage, (s) => {
    status.value = s;
  });
  await refresh();
  firstRun.value = !(await api.setup().catch(() => ({ config: { completed: true } }))).config
    .completed;
}

export function signOut(): void {
  live?.close();
  live = undefined;
  api = undefined;
  localStorage.removeItem("rg.token");
  token.value = null;
}

/** Runs an action and shows its error in the header instead of throwing. */
export async function attempt<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    lastError.value = null;
    return await f();
  } catch (err) {
    const code = err instanceof ApiError ? err.code : undefined;
    lastError.value = (code && tOptional(`err_${code}`)) || (err as Error).message;
    return undefined;
  }
}

// ---------- Layout (as in Officina): tabs in the middle, files and terminals on the right ----------

/** What the middle shows. */
export type Tab =
  | { id: string; type: "chat"; title: string; sessionId: string; agentId: string }
  | { id: string; type: "dailychat"; title: string; chatId: string | null }
  | { id: string; type: "board"; title: string; projectId: string | null }
  | { id: string; type: "inspector"; title: string; projectId: string }
  | { id: string; type: "settings"; title: string; section?: SettingsSection }
  | { id: string; type: "room"; title: string; roomId: string }
  /** A personal assistant's page, or a new one when `agentId` is null (G24.11). */
  | { id: string; type: "assistant"; title: string; agentId: string | null };

/** What the area on the right shows, next to the chat. */
export type SideView =
  | { id: string; type: "editor"; title: string; scope: string; path: string }
  | { id: string; type: "terminal"; title: string; scope: string }
  /** The personal agents' browser, live (G24.14b). */
  | { id: string; type: "screen"; title: string }
  /** What an agent showed (G25.1). */
  | { id: string; type: "canvas"; title: string; target: CanvasTarget };

export type SettingsSection =
  | "general"
  | "setup"
  | "agents"
  | "automations"
  | "extensions"
  | "telegram"
  | "budgets"
  | "subscriptions"
  | "code"
  | "remote"
  | "platform";

/** Older ways to open things, still used by the views: they land in the new places. */
export type OpenRequest =
  | Tab
  | SideView
  | {
      id: string;
      type:
        | "files"
        | "extensions"
        | "telegram"
        | "automations"
        | "platform"
        | "setup"
        | "hierarchy"
        | "approvals"
        | "budgets";
      title: string;
      scope?: string;
    };

const loadTabs = (): { tabs: Tab[]; active: string | null } => {
  try {
    const saved = JSON.parse(localStorage.getItem("rg.tabs") ?? "") as {
      tabs: Tab[];
      active: string | null;
    };
    if (Array.isArray(saved.tabs)) return saved;
  } catch {
    // fresh layout
  }
  return { tabs: [], active: null };
};

const initialTabs = loadTabs();
export const tabs = signal<Tab[]>(initialTabs.tabs);
export const activeTab = signal<string | null>(initialTabs.active);
/** Files and terminals open on the right (terminals never survive a reload: their shells are gone). */
export const sideViews = signal<SideView[]>([]);
export const activeSide = signal<string | null>(null);
/** The project's file explorer on the right. */
export const explorerOpen = signal(localStorage.getItem("rg.explorer") === "1");
/** The phone's drawer with the left bar. */
export const drawerOpen = signal(false);

const persistTabs = () =>
  localStorage.setItem("rg.tabs", JSON.stringify({ tabs: tabs.value, active: activeTab.value }));

export function toggleExplorer(open = !explorerOpen.value): void {
  explorerOpen.value = open;
  localStorage.setItem("rg.explorer", open ? "1" : "0");
}

const SECTIONS: Record<string, SettingsSection> = {
  extensions: "extensions",
  telegram: "telegram",
  automations: "automations",
  platform: "platform",
  setup: "setup",
  hierarchy: "agents",
  budgets: "budgets",
};

/** Opens something where it belongs: a tab in the middle, or a file or terminal on the right. */
export function openTab(req: OpenRequest): void {
  drawerOpen.value = false;
  if (req.type === "editor" || req.type === "terminal" || req.type === "screen") {
    if (!sideViews.value.some((v) => v.id === req.id)) sideViews.value = [...sideViews.value, req];
    activeSide.value = req.id;
    return;
  }
  if (req.type === "files") {
    toggleExplorer(true);
    return;
  }
  if (req.type === "approvals") return;
  const tab: Tab =
    req.type in SECTIONS
      ? {
          id: "settings",
          type: "settings",
          title: "",
          section: SECTIONS[req.type] as SettingsSection,
        }
      : (req as Tab);
  const existing = tabs.value.find((x) => x.id === tab.id);
  tabs.value = existing ? tabs.value.map((x) => (x.id === tab.id ? tab : x)) : [...tabs.value, tab];
  activeTab.value = tab.id;
  persistTabs();
}

export function activateTab(id: string): void {
  activeTab.value = id;
  persistTabs();
}

export function closeTab(id: string): void {
  const index = tabs.value.findIndex((x) => x.id === id);
  tabs.value = tabs.value.filter((x) => x.id !== id);
  if (activeTab.value === id)
    activeTab.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id ?? null;
  persistTabs();
}

export function closeSide(id: string): void {
  const index = sideViews.value.findIndex((x) => x.id === id);
  sideViews.value = sideViews.value.filter((x) => x.id !== id);
  if (activeSide.value === id)
    activeSide.value = sideViews.value[Math.min(index, sideViews.value.length - 1)]?.id ?? null;
}

/** Opens (or brings forward) what an agent showed, in the area on the right (G25.1). */
export function openCanvas(title: string, target: CanvasTarget): void {
  const id =
    target.kind === "file"
      ? `canvas:${target.scope}:${target.path}`
      : `canvas:${target.agentId}:${target.port}:${target.path ?? ""}`;
  const view: SideView = { id, type: "canvas", title, target };
  sideViews.value = sideViews.value.some((v) => v.id === id)
    ? sideViews.value.map((v) => (v.id === id ? view : v))
    : [...sideViews.value, view];
  activeSide.value = id;
}

/** The scope the explorer shows: the active conversation's project, or God's platform. */
export function currentScope(): { scope: string; title: string; focus?: string } {
  const tab = tabs.value.find((x) => x.id === activeTab.value);
  const projectOf = (id: string | null | undefined) => projects.value.find((p) => p.id === id);
  let projectId: string | null | undefined;
  const agent =
    tab?.type === "chat"
      ? agents.value.find((a) => a.id === tab.agentId)
      : tab?.type === "assistant"
        ? agents.value.find((a) => a.id === tab.agentId)
        : undefined;
  // The personal agents' shared desk (G24.11).
  if (agent?.kind === "assistant") return { scope: "assistants", title: "Agents" };
  if (agent) projectId = agent.projectId;
  else if (tab?.type === "board" || tab?.type === "inspector") projectId = tab.projectId;
  const project = projectOf(projectId ?? undefined);
  // A subproject's agent: the explorer opens on its folder (G24.13).
  const sub = agent?.subprojectId
    ? subprojects.value.find((x) => x.id === agent.subprojectId)
    : undefined;
  return project
    ? { scope: `project:${project.id}`, title: project.name, ...(sub && { focus: sub.dir }) }
    : { scope: "platform", title: "Platform" };
}

// ---------- Conversations for the left bar ----------

export interface SessionRow {
  id: string;
  agentId: string;
  projectId: string | null;
  createdAt: string;
  lastAt: string | null;
  title: string | null;
  pinned: boolean;
  archived: boolean;
  running: boolean;
  model?: { provider: string; model: string; effort?: string } | null;
}

export const sessionRows = signal<SessionRow[]>([]);
export const chatRows = signal<import("./api.js").ChatSummary[]>([]);

export async function refreshConversations(): Promise<void> {
  const a = getApi();
  [sessionRows.value, chatRows.value] = await Promise.all([
    a.sessions() as Promise<SessionRow[]>,
    a.chats(),
  ]);
}

/** Opens one of an agent's conversations in the middle. */
export function openSession(row: { id: string; agentId: string; title: string | null }): void {
  const agent = agents.value.find((a) => a.id === row.agentId);
  openTab({
    id: `chat:${row.id}`,
    type: "chat",
    title: row.title ?? agent?.name ?? "",
    sessionId: row.id,
    agentId: row.agentId,
  });
}

/** A new conversation with an agent. */
export async function newSession(agent: Agent): Promise<void> {
  const { sessionId } = await getApi().startSession(agent.id);
  await refreshConversations();
  openSession({ id: sessionId, agentId: agent.id, title: null });
}

/** Opens the latest conversation with an agent, or starts one. */
export async function openAgent(agent: Agent, fresh = false): Promise<void> {
  const a = getApi();
  const existing = fresh ? [] : await a.sessions(agent.id);
  const sessionId = existing.at(-1)?.id ?? (await a.startSession(agent.id)).sessionId;
  openTab({
    id: `chat:${sessionId}`,
    type: "chat",
    title: agent.name,
    sessionId,
    agentId: agent.id,
  });
}
