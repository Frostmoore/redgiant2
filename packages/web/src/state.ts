import { type Signal, signal } from "@preact/signals";
import type {
  AssistantPart,
  Event,
  MessageMetrics,
  PermissionRequestInfo,
  ServerMessage,
} from "@redgiant/protocol";
import { type Agent, Api, type Budget, Live, type PlatformInfo, type Project } from "./api.js";

// ---------- Chat items (pure) ----------

export type ChatItem =
  | { kind: "user"; key: string; text: string; ts: string }
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
  | { kind: "notice"; key: string; tone: "info" | "warn" | "ok" | "error"; text: string };

/** Turns a session's events into what the chat shows. Pure: tested without a browser. */
export function buildItems(events: Event[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  for (const e of events) {
    const key = `e${e.seq}`;
    if (e.payload === null) {
      items.push({ kind: "notice", key, tone: "warn", text: `${e.type} (erased)` });
      continue;
    }
    switch (e.type) {
      case "message.user":
        items.push({ kind: "user", key, text: e.payload.text, ts: e.ts });
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
      case "permission.requested":
        items.push({
          kind: "notice",
          key,
          tone: "warn",
          text: `⏳ ${e.payload.reason} → ${e.payload.askedTo}`,
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
        items.push({ kind: "notice", key, tone: "error", text: `⛔ ${e.payload.reason}` });
        break;
      case "compaction":
        items.push({
          kind: "notice",
          key,
          tone: "info",
          text: `⇣ compaction: ${e.payload.summary.slice(0, 200)}`,
        });
        break;
      case "task.opened":
        items.push({
          kind: "notice",
          key,
          tone: "info",
          text: `☐ ${e.payload.taskId}: ${e.payload.title}`,
        });
        break;
      case "task.verified":
        items.push({
          kind: "notice",
          key,
          tone: e.payload.passed ? "ok" : "error",
          text: `${e.payload.passed ? "✓" : "✗"} ${e.payload.verifier}`,
        });
        break;
      case "task.closed":
        items.push({
          kind: "notice",
          key,
          tone: e.payload.outcome === "abandoned" ? "error" : "ok",
          text: `☑ ${e.payload.taskId}: ${e.payload.outcome}`,
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
  return items;
}

// ---------- Live session views ----------

export interface SessionView {
  events: Event[];
  text: string;
  thinking: string;
  state: "idle" | "running";
  synced: boolean;
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
export function applyMessage(m: ServerMessage): void {
  switch (m.type) {
    case "event": {
      const v = sessionView(m.sessionId);
      if (v.value.events.some((e) => e.seq === m.event.seq)) return;
      const done = m.event.type === "message.assistant";
      v.value = {
        ...v.value,
        events: [...v.value.events, m.event],
        ...(done && { text: "", thinking: "" }),
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
    case "board.changed":
      boardVersion.value++;
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
export const budgets = signal<Budget[]>([]);
export const lastError = signal<string | null>(null);
/** Bumped on every board change pushed by the server: board views reload. */
export const boardVersion = signal(0);
/** Bumped when an automation is edited or one of its runs starts or ends. */
export const automationsVersion = signal(0);
/** Bumped on every platform change; the platform view reloads. */
export const platformVersion = signal(0);
/** How the platform runs: the header warns about metal and unisolated sandboxes. */
export const platformInfo = signal<PlatformInfo | null>(null);

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

export async function refresh(): Promise<void> {
  const a = getApi();
  [projects.value, agents.value, approvals.value, budgets.value, platformInfo.value] =
    await Promise.all([a.projects(), a.agents(), a.approvals(), a.budgets(), a.platform()]);
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
    lastError.value = (err as Error).message;
    return undefined;
  }
}

// ---------- Layout: panes with tabs ----------

export type Tab =
  | { id: string; type: "chat"; title: string; sessionId: string; agentId: string }
  | { id: string; type: "files"; title: string; scope: string }
  | { id: string; type: "editor"; title: string; scope: string; path: string }
  | { id: string; type: "terminal"; title: string; scope: string }
  | { id: string; type: "board"; title: string; projectId: string | null }
  | { id: string; type: "extensions"; title: string }
  | { id: string; type: "telegram"; title: string }
  | { id: string; type: "automations"; title: string }
  | { id: string; type: "platform"; title: string }
  | { id: string; type: "hierarchy" | "approvals" | "budgets"; title: string };

export interface Pane {
  id: string;
  tabs: Tab[];
  active: string | null;
}

const MAX_PANES = 3;

const loadLayout = (): { panes: Pane[]; focused: string } => {
  try {
    const saved = JSON.parse(localStorage.getItem("rg.layout") ?? "") as {
      panes: Pane[];
      focused: string;
    };
    // Terminals do not survive a reload: their shells are gone.
    const panes = saved.panes.map((p) => ({
      ...p,
      tabs: p.tabs.filter((t) => t.type !== "terminal"),
    }));
    if (panes.length > 0) return { panes, focused: saved.focused };
  } catch {
    // fresh layout
  }
  return { panes: [{ id: "p1", tabs: [], active: null }], focused: "p1" };
};

const initial = loadLayout();
export const panes = signal<Pane[]>(initial.panes);
export const focusedPane = signal<string>(initial.focused);

const persist = () =>
  localStorage.setItem(
    "rg.layout",
    JSON.stringify({ panes: panes.value, focused: focusedPane.value }),
  );

/** Opens a tab in the focused pane, or focuses it where it is already open. */
export function openTab(tab: Tab): void {
  for (const p of panes.value) {
    if (p.tabs.some((t) => t.id === tab.id)) {
      panes.value = panes.value.map((x) => (x.id === p.id ? { ...x, active: tab.id } : x));
      focusedPane.value = p.id;
      persist();
      return;
    }
  }
  const target = panes.value.find((p) => p.id === focusedPane.value) ?? panes.value[0];
  if (!target) return;
  panes.value = panes.value.map((p) =>
    p.id === target.id ? { ...p, tabs: [...p.tabs, tab], active: tab.id } : p,
  );
  persist();
}

export function activateTab(paneId: string, tabId: string): void {
  panes.value = panes.value.map((p) => (p.id === paneId ? { ...p, active: tabId } : p));
  focusedPane.value = paneId;
  persist();
}

export function closeTab(paneId: string, tabId: string): void {
  let next = panes.value.map((p) => {
    if (p.id !== paneId) return p;
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    return { ...p, tabs, active: p.active === tabId ? (tabs.at(-1)?.id ?? null) : p.active };
  });
  // An empty pane disappears, unless it is the last one.
  if (next.length > 1) next = next.filter((p) => p.tabs.length > 0);
  panes.value = next;
  if (!next.some((p) => p.id === focusedPane.value)) focusedPane.value = next[0]?.id ?? "p1";
  persist();
}

/** Moves a tab into a new pane on the right (at most three panes). */
export function splitRight(paneId: string, tabId: string): void {
  const from = panes.value.find((p) => p.id === paneId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !tab || panes.value.length >= MAX_PANES || from.tabs.length < 2) return;
  const id = `p${Date.now()}`;
  const index = panes.value.indexOf(from);
  const rest = from.tabs.filter((t) => t.id !== tabId);
  const next = [...panes.value];
  next[index] = { ...from, tabs: rest, active: rest.at(-1)?.id ?? null };
  next.splice(index + 1, 0, { id, tabs: [tab], active: tab.id });
  panes.value = next;
  focusedPane.value = id;
  persist();
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
