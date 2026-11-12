import { type Signal, signal } from "@preact/signals";
import type {
  Answers,
  AsideView,
  AssistantPart,
  CanvasState,
  Event,
  ImagePart,
  JobProgress,
  MessageMetrics,
  MessageQuote,
  PermissionRequestInfo,
  Question,
  QuestionRequestInfo,
  ServerMessage,
} from "@redgiant/protocol";
import {
  type AgentEditMode,
  answerSegments,
  type ClientMessage,
  type DocChange,
  type DocFile,
  type DocPresence,
  type DocProposal,
  type DocSnapshot,
  docKey,
  PERSON,
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
import { bridgeResult } from "./artifact-bridge.js";
import { t, tOptional } from "./i18n.js";
import { coversNow } from "./phone.js";
import {
  forgetPlace,
  forgetTab,
  kindOfTab,
  order,
  placeOf,
  settled,
  tabOpened,
} from "./viewers/live.js";
import { copyOriginal } from "./viewers/office-bridge.js";

/** What the canvas shows (G25.1): a file or folder of a workspace, or a port of an agent. */
export type CanvasTarget =
  | {
      kind: "file";
      scope: string;
      path: string;
      /** Where to open it (G36.4, a citation): a PDF's page, a text's line. */
      at?: { page?: number | undefined; line?: number | undefined } | undefined;
    }
  | { kind: "port"; agentId: string; port: number; path?: string | undefined };

// ---------- Chat items (pure) ----------

export type ChatItem =
  | {
      kind: "user";
      key: string;
      text: string;
      ts: string;
      images: ImagePart[];
      from?: string;
      /** Passages of earlier messages it answers (G36.22). */
      quotes?: MessageQuote[];
      /** Sent by a button in an artifact or a widget (3.5.9). */
      via?: "artifact";
    }
  | {
      kind: "assistant";
      key: string;
      /** Its event and time: what a quote of it points at (G36.22). */
      seq: number;
      ts: string;
      parts: AssistantPart[];
      metrics: MessageMetrics;
      costUsd: number;
      /** The model's price is not known (3.5.4): the cost shows as "not known". */
      costUnknown?: boolean;
      model: string;
      stopReason: string;
      /** Brought in from another assistant (G36.7): no figures to show. */
      imported?: boolean;
      /**
       * The closing summary at the step limit, nothing written after it yet (3.5.6): the page
       * offers «Continue» under it.
       */
      stepLimit?: boolean;
    }
  | {
      kind: "tool";
      key: string;
      callId: string;
      tool: string;
      input: unknown;
      result?: { ok: boolean; output: string; images?: ImagePart[] };
      /** Called by the agent's program (run_script), not by the model directly. */
      viaScript?: boolean;
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
  /** A file the agent sent (G25.2): seen in place when it can be, otherwise opened or saved. */
  | {
      kind: "file";
      key: string;
      scope: string;
      path: string;
      name: string;
      size: number;
      mime: string;
      caption?: string;
    }
  /** A board of variants (G25.4): a card that opens it, with what the person said. */
  | {
      kind: "variants";
      key: string;
      sessionId: string;
      proposalId: string;
      title: string;
      count: number;
      chosen: number | null;
    }
  /** Something the agent showed in the canvas (G25.1): a card that opens it. */
  | { kind: "canvas"; key: string; title: string; target: CanvasTarget }
  /**
   * A ```widget block of an answer (3.5.9): run in the artifacts' frame, served from the log
   * (its answer's `seq` and its place among the answer's blocks).
   */
  | {
      kind: "widget";
      key: string;
      sessionId: string;
      seq: number;
      index: number;
      title: string;
    }
  /** Where a conversation that goes on from another one starts its own part (G36.23). */
  | {
      kind: "fork";
      key: string;
      fromSessionId: string;
      fromTitle?: string;
      how: "continue" | "edit";
    }
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

/**
 * An answer's parts without their closed ```widget blocks, and the widgets (3.5.9, pure). A block
 * still open (a cut answer) or over 64 KB stays text: it is never run.
 */
export function splitWidgets(parts: AssistantPart[]): {
  parts: AssistantPart[];
  widgets: { index: number; title: string }[];
} {
  const widgets: { index: number; title: string }[] = [];
  let n = 0;
  const out = parts.map((p) => {
    if (p.type !== "text" || !/^\s{0,3}(`{3,}|~{3,})\s*widget\b/im.test(p.text)) return p;
    const segs = answerSegments(p.text, n);
    n += segs.filter((x) => x.kind === "widget").length;
    const text = segs
      .map((x) => {
        if (x.kind === "text") return x.text;
        if (x.closed && !x.tooBig) {
          widgets.push({ index: x.index, title: x.title });
          return "";
        }
        return x.closed ? `\`\`\`html\n${x.html}\n\`\`\`` : `\`\`\`html\n${x.html}`;
      })
      .map((x) => x.replace(/^\n+|\n+$/g, ""))
      .filter((x) => x.trim())
      .join("\n\n");
    return { ...p, text };
  });
  return { parts: out, widgets };
}

/**
 * An answer being written (3.5.9): a widget block shows as a short line until it is closed and the
 * answer is recorded, never as its code.
 */
export function streamingWithoutWidgets(text: string): string {
  if (!/(`{3,}|~{3,})\s*widget\b/i.test(text)) return text;
  return answerSegments(text)
    .map((x) => (x.kind === "text" ? x.text : `\n_${t("widgetPreparing")}_\n`))
    .join("\n\n");
}

/** The conversation open in front of the person, if the active tab is one. */
export function frontSession(): string | undefined {
  const tab = tabs.value.find((x) => x.id === activeTab.value);
  return tab?.type === "chat" ? tab.sessionId : undefined;
}

/** Their question card stands for these calls: no tool line for them. */
const QUESTION_TOOLS = new Set(["ask_user", "propose_plan"]);

/** Turns a session's events into what the chat shows. Pure: tested without a browser. */
/**
 * A note from the browser when the page is not in view (2026-11-05, as Zed and Claude Desktop
 * do): an agent finished, or waits for an approval or an answer. Only once allowed in Settings.
 */
function notifyHidden(body: string, tag?: string): void {
  if (typeof document === "undefined" || !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification("RedGiant", { body, ...(tag && { tag }) });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {}
}

export function buildItems(events: Event[]): ChatItem[] {
  const items: ChatItem[] = [];
  // Calls by id, oldest first: an id given twice (an engine's two calls in the same instant,
  // 3.5.4) still pairs each result with its own call instead of leaving one spinning.
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>[]>();
  /** Calls with no result yet: once the model speaks again they cannot be running any more. */
  const open = new Set<Extract<ChatItem, { kind: "tool" }>>();
  const asked = new Map<string, Extract<ChatItem, { kind: "question" }>>();
  /** The last closing summary at the step limit: a message after it takes its «Continue» away. */
  let limited: Extract<ChatItem, { kind: "assistant" }> | undefined;
  for (const e of events) {
    const key = `e${e.seq}`;
    if (e.payload === null) {
      items.push({ kind: "notice", key, tone: "warn", text: `${e.type} (erased)` });
      continue;
    }
    switch (e.type) {
      case "message.user":
        // RedGiant's own note to the model (the step limit): the answer is what the person reads.
        if (e.payload.from === "redgiant") break;
        if (limited) {
          delete limited.stepLimit;
          limited = undefined;
        }
        items.push({
          kind: "user",
          key,
          text: e.payload.text,
          ts: e.ts,
          images: e.payload.images ?? [],
          ...(e.payload.from && { from: e.payload.from }),
          ...(e.payload.quotes?.length && { quotes: e.payload.quotes }),
          ...(e.payload.via && { via: e.payload.via }),
        });
        break;
      case "session.forked":
        items.push({
          kind: "fork",
          key,
          fromSessionId: e.payload.fromSessionId,
          ...(e.payload.fromTitle && { fromTitle: e.payload.fromTitle }),
          how: e.payload.how ?? "edit",
        });
        break;
      case "message.assistant": {
        // A final answer after these calls (no tool asked for): whatever they were, they are
        // over, their result was lost (a turn cancelled while they ran). A message that asks
        // for tools may be recorded after its own calls started (an engine), so it does not.
        if (e.payload.stopReason !== "tool_use") {
          for (const c of open) c.result = { ok: false, output: t("toolNoResult") };
          open.clear();
        }
        // Its ```widget blocks become widgets after it (3.5.9); the text keeps the rest.
        const { parts, widgets } = splitWidgets(
          e.payload.parts.filter((p) => p.type !== "tool_call"),
        );
        items.push({
          kind: "assistant",
          key,
          seq: e.seq,
          ts: e.ts,
          parts,
          metrics: e.payload.metrics,
          costUsd: e.payload.costUsd,
          ...(e.payload.costUnknown && { costUnknown: true }),
          model: e.payload.model,
          stopReason: e.payload.stopReason,
          // Older or hand-made events may lack the provider. An external ACP agent's (G38.6) have
          // no figures either: its program counts nothing RedGiant could show.
          ...(((e.payload.provider ?? "").startsWith("import:") ||
            e.payload.provider === "acp") && {
            imported: true,
          }),
        });
        if (e.payload.stepLimit) {
          limited = items.at(-1) as Extract<ChatItem, { kind: "assistant" }>;
          limited.stepLimit = true;
        }
        if (e.sessionId)
          for (const w of widgets)
            items.push({
              kind: "widget",
              key: `${key}w${w.index}`,
              sessionId: e.sessionId,
              seq: e.seq,
              index: w.index,
              title: w.title,
            });
        break;
      }
      // A conversation brought in from ChatGPT or Claude (G36.7): said once, at its top.
      case "session.imported": {
        const source =
          e.payload.source === "chatgpt"
            ? "ChatGPT"
            : e.payload.source === "claude"
              ? "Claude"
              : e.payload.source;
        const at = e.payload.updatedAt ?? e.payload.createdAt;
        items.push({
          kind: "notice",
          key,
          tone: "info",
          text: t("impChatNotice", {
            source,
            date:
              at && !Number.isNaN(Date.parse(at)) ? ` (${new Date(at).toLocaleDateString()})` : "",
          }),
        });
        break;
      }
      case "tool.call": {
        if (QUESTION_TOOLS.has(e.payload.tool)) break;
        const item = {
          kind: "tool" as const,
          key,
          callId: e.payload.callId,
          tool: e.payload.tool,
          input: e.payload.input,
        };
        tools.set(e.payload.callId, [...(tools.get(e.payload.callId) ?? []), item]);
        open.add(item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const same = tools.get(e.payload.callId) ?? [];
        const call = same.find((c) => !c.result) ?? same.at(-1);
        if (call) open.delete(call);
        if (call)
          call.result = {
            ok: e.payload.ok,
            output: e.payload.output,
            // What canvas_look drew for the agent (G36.12): the person sees what it saw.
            ...(call.tool === "canvas_look" &&
              e.payload.images?.length && { images: e.payload.images }),
          };
        break;
      }
      // A call made by the agent's program (run_script): shown like any other, marked so.
      case "script.call":
        items.push({
          kind: "tool",
          key,
          callId: key,
          tool: e.payload.name,
          input: e.payload.input,
          result: { ok: e.payload.ok, output: e.payload.output },
          viaScript: true,
        });
        break;
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
      case "variants.proposed":
        items.push({
          kind: "variants",
          key,
          sessionId: e.sessionId ?? "",
          proposalId: e.payload.proposalId,
          title: e.payload.title,
          count: e.payload.variants.length,
          chosen: null,
        });
        break;
      case "variants.answered": {
        const v = items.find(
          (i) => i.kind === "variants" && i.proposalId === e.payload?.proposalId,
        );
        if (v?.kind === "variants" && e.payload.choice) v.chosen = e.payload.variant;
        break;
      }
      case "file.sent":
        items.push({ kind: "file", key, ...e.payload });
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

/** The side questions «Intanto» of a conversation (G36.24), oldest first. Pure. */
export function asidesOf(events: Event[]): AsideView[] {
  const promoted = new Set(
    events.flatMap((e) => (e.type === "aside.promoted" && e.payload ? [e.payload.asideId] : [])),
  );
  return events.flatMap((e) =>
    e.type === "aside" && e.payload
      ? [
          {
            id: e.payload.id,
            seq: e.seq,
            at: e.ts,
            question: e.payload.question,
            answer: e.payload.answer,
            model: e.payload.model,
            costUsd: e.payload.costUsd,
            ...(e.payload.error && { error: e.payload.error }),
            promoted: promoted.has(e.payload.id),
          },
        ]
      : [],
  );
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
  /** The model request now running (2026-11-03): its phases for the progress line. */
  call?: ModelCall | undefined;
}

/**
 * One model request seen live: when it started, how far the prompt was read (local engines
 * report it), when the first word came and how much has been written since.
 */
export interface ModelCall {
  since: number;
  prefill?: { total: number; cached: number; processed: number; ms: number };
  firstToken?: number;
  chars: number;
  writing?: "text" | "thinking";
}

const newCall = (): ModelCall => ({ since: Date.now(), chars: 0 });

const sessions = new Map<string, Signal<SessionView>>();

export function sessionView(id: string): Signal<SessionView> {
  let s = sessions.get(id);
  if (!s) {
    s = signal<SessionView>({ events: [], text: "", thinking: "", state: "idle", synced: false });
    sessions.set(id, s);
  }
  return s;
}

/**
 * The events with one more, in the log's order (p3.5.4): one older than the last (what a follow
 * again brings after a gap) goes in its place, so the chat is the one a reload shows.
 */
export function withEvent(events: Event[], e: Event): Event[] {
  const last = events.at(-1);
  if (!last || last.seq < e.seq) return [...events, e];
  const at = events.findIndex((x) => x.seq > e.seq);
  return [...events.slice(0, at), e, ...events.slice(at)];
}

/**
 * The events with many more (a history), once each and in the log's order. The usual case, all
 * after the last one the view has, costs one copy.
 */
export function withEvents(events: Event[], more: Event[]): Event[] {
  if (more.length === 0) return events;
  const last = events.at(-1)?.seq ?? -1;
  let sorted = true;
  for (let i = 0; i < more.length; i++)
    if ((more[i] as Event).seq <= (i === 0 ? last : (more[i - 1] as Event).seq)) sorted = false;
  if (sorted) return events.length === 0 ? more : [...events, ...more];
  const bySeq = new Map<number, Event>();
  for (const e of events) bySeq.set(e.seq, e);
  for (const e of more) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
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
    // The editor (G37.1): one file's revisions, in the host's order.
    case "doc.opened":
    case "doc.changed":
    case "doc.ack":
    case "doc.rejected":
    case "doc.replaced":
    case "doc.presence":
    case "doc.proposals":
    case "doc.mode":
    case "doc.saved":
    case "doc.held":
      docMessage(m);
      return;
    // An agent looks at the canvas (G36.12): what it shows and where the person is, once.
    // After the moves and the tabs it just got (p3.5.6), never more than a moment later.
    case "canvas.query": {
      const requestId = m.requestId;
      const open = sideViews.value.filter((v) => v.type === "canvas").map((v) => v.id);
      void settled(open).then(() =>
        live?.send({ type: "canvas.state", requestId, state: canvasSnapshot() }),
      );
      return;
    }
    case "error":
      if (m.code === "unavailable")
        browserScreen.value = { ...browserScreen.value, unavailable: true };
      else lastError.value = tOptional(`err_${m.code}`, m.params ?? {}) ?? m.message;
      return;
    case "event": {
      const v = sessionView(m.sessionId);
      if (v.value.events.some((e) => e.seq === m.event.seq)) return;
      const done = m.event.type === "message.assistant";
      // Shown while the person watches: the canvas opens by itself (not when the log replays).
      if (v.value.synced) canvasEvent(m.sessionId, m.event);
      // A request ends with its message; while the turn runs, a user message or a tool's
      // result means the next request is being prepared.
      const next =
        v.value.state === "running" &&
        (m.event.type === "tool.result" || m.event.type === "message.user");
      v.value = {
        ...v.value,
        events: withEvent(v.value.events, m.event),
        ...(done && { text: "", thinking: "", call: undefined }),
        ...(next && { call: newCall() }),
        // The picture is in the tool's result now: the live preview goes.
        ...(m.event.type === "tool.result" && { drawing: undefined }),
      };
      return;
    }
    // An agent of the person's showed a file from a conversation this page does not follow
    // (p3.5.3): the canvas opens all the same (the server sends live events only).
    case "canvas.open":
      canvasEvent(m.sessionId, m.event);
      return;
    // One of the person's conversations started or stopped (p3.5.3), followed or not.
    // A conversation the list does not have (a task just handed over) is fetched at once; a
    // known one may have just taken a task or closed one (p3.5.4): fetched again for its title.
    case "session.activity": {
      const known = sessionRows.value.find((r) => r.id === m.sessionId);
      if (known)
        sessionRows.value = sessionRows.value.map((r) =>
          r.id === m.sessionId ? { ...r, running: m.state === "running" } : r,
        );
      if (!known || (m.state === "running") !== !!known.task) refreshSoon();
      // An agent made after the page loaded (one God just created and handed a task to,
      // p3.5.6): the team lines need it under its parent.
      if (!agents.value.some((a) => a.id === m.agentId)) refreshSoon(true);
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
      const c = v.value.call ?? newCall();
      const call: ModelCall = {
        ...c,
        firstToken: c.firstToken ?? Date.now(),
        chars: c.chars + m.text.length,
        writing: m.kind,
      };
      v.value =
        m.kind === "text"
          ? { ...v.value, text: v.value.text + m.text, call }
          : { ...v.value, thinking: v.value.thinking + m.text, call };
      return;
    }
    case "prefill": {
      const v = sessionView(m.sessionId);
      const { total, cached, processed, ms } = m;
      v.value = {
        ...v.value,
        call: { ...(v.value.call ?? newCall()), prefill: { total, cached, processed, ms } },
      };
      return;
    }
    case "session.state":
      if (m.state === "idle" && sessionView(m.sessionId).value.state === "running")
        notifyHidden(t("notifyDone"), m.sessionId);
      sessionView(m.sessionId).value = {
        ...sessionView(m.sessionId).value,
        state: m.state,
        call: m.state === "running" ? newCall() : undefined,
      };
      // A turn just ended: the plan's limits may have moved.
      if (m.state === "idle") void refreshLimits().catch(() => {});
      sessionRows.value = sessionRows.value.map((r) =>
        r.id === m.sessionId ? { ...r, running: m.state === "running" } : r,
      );
      return;
    case "session.compacting":
      sessionView(m.sessionId).value = { ...sessionView(m.sessionId).value, compacting: m.busy };
      return;
    // The stored history in one message (p3.5.4, as Officina's H14): one update, so one drawing
    // and one scroll, never one per event. Merged with what the view has (it is never emptied
    // first); a replay opens no canvas and rings nothing.
    case "session.history": {
      const v = sessionView(m.sessionId);
      v.value = {
        ...v.value,
        events: withEvents(v.value.events, m.events),
        synced: true,
        text: "",
        thinking: "",
        drawing: undefined,
      };
      return;
    }
    // Followed (again, after a reconnection): what was streaming before is stale (p3.5.4); what
    // comes next and the state that follows say where the conversation really is.
    case "session.synced":
      sessionView(m.sessionId).value = {
        ...sessionView(m.sessionId).value,
        synced: true,
        text: "",
        thinking: "",
        drawing: undefined,
      };
      return;
    case "permission.request":
      if (!approvals.value.some((r) => r.requestId === m.request.requestId)) {
        approvals.value = [...approvals.value, m.request];
        notifyHidden(t("notifyApproval", { name: m.request.agentName }));
      }
      return;
    case "permission.closed":
      approvals.value = approvals.value.filter((r) => r.requestId !== m.requestId);
      return;
    // An artifact's bridge call answered (3.6, G38.7): to the frame that asked.
    case "artifact.bridge.result":
      bridgeResult(m);
      return;
    case "question.request":
      if (!questions.value.some((q) => q.requestId === m.request.requestId)) {
        questions.value = [...questions.value, m.request];
        // A conversation the list does not have yet (a task just handed over): fetch it.
        if (!sessionRows.value.some((r) => r.id === m.request.sessionId)) refreshSoon();
        notifyHidden(t("notifyQuestion", { name: m.request.agentName }));
      }
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
    case "automation.notice":
      if (!notices.value.some((n) => n.runId === m.runId)) {
        notices.value = [
          { runId: m.runId, name: m.name, status: m.status, sessionId: m.sessionId, text: m.text },
          ...notices.value,
        ].slice(0, 50);
        notifyHidden(`${m.name}: ${m.text.slice(0, 200)}`, m.runId);
      }
      return;
    case "platform.changed":
      platformVersion.value++;
      // A project archived or restored (here, by God or on another page) moves at once.
      void refreshProjects().catch(() => {});
      return;
  }
}

// ---------- Global state ----------

export const token = signal<string | null>(localStorage.getItem("rg.token"));
export const status = signal<"online" | "offline" | "connecting">("offline");
/** The page was connected once: losing it now is news (p3.5.4, «Collegamento perso»). */
export const everOnline = signal(false);
/** The projects in use: every list and choice shows these. */
export const projects = signal<Project[]>([]);
/** Archived projects (2026-11-09): only in their own section, read only. */
export const archivedProjects = signal<Project[]>([]);
/** Whether a project is archived now (its conversations and files are read only). */
export const isArchived = (projectId: string | null | undefined) =>
  !!projectId && archivedProjects.value.some((p) => p.id === projectId);
/** The projects from the server, split into those in use and the archived ones. */
export async function refreshProjects(): Promise<void> {
  setProjects(await getApi().projects());
}
function setProjects(all: Project[]): void {
  projects.value = all.filter((p) => !p.archivedAt);
  archivedProjects.value = all.filter((p) => p.archivedAt);
}
export const agents = signal<Agent[]>([]);
export const approvals = signal<PermissionRequestInfo[]>([]);
/** Automation messages sent to the web page, newest first, until the person dismisses them. */
export const notices = signal<
  { runId: string; name: string; status: string; sessionId: string | null; text: string }[]
>([]);
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
  let all: Project[];
  [all, agents.value, approvals.value, budgets.value, platformInfo.value] = await Promise.all([
    a.projects(),
    a.agents(),
    a.approvals(),
    a.budgets(),
    a.platform(),
  ]);
  setProjects(all);
  // The rest in one round trip (3.5.11): awaited one after the other they were five more round
  // trips before the page showed (seconds on a slow phone network).
  await Promise.all([
    refreshConversations().catch(() => {}),
    a
      .chatAgentIdOf()
      .catch(() => ({ id: null }))
      .then((r) => {
        chatAgentId.value = r.id;
      }),
    refreshRooms(),
    refreshSubprojects(),
    refreshLimits(),
  ]);
}

export async function signIn(t: string): Promise<void> {
  api = new Api(t);
  await api.projects(); // throws on a wrong token
  localStorage.setItem("rg.token", t);
  token.value = t;
  live?.close();
  live = new Live(t, applyMessage, (s) => {
    status.value = s;
    if (s === "online") everOnline.value = true;
  });
  // Asked together with the rest (3.5.11).
  const setup = api.setup().catch(() => ({ config: { completed: true } }));
  await refresh();
  firstRun.value = !(await setup).config.completed;
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
  | { id: string; type: "assistant"; title: string; agentId: string | null }
  /** Every chat, as cards in folders, and the group chats (2026-11-03). */
  | { id: string; type: "chats"; title: string }
  /** The agents of one project, as a tree. */
  | { id: string; type: "agents"; title: string; projectId: string }
  /** An archived project, read only (2026-11-09): conversations, tasks, files; «Restore». */
  | { id: string; type: "archived"; title: string; projectId: string }
  /** A board of variants an agent published (G25.4), a page of its own as in Officina. */
  | { id: string; type: "tavola"; title: string; sessionId: string; proposalId: string };

/** What the area on the right shows, next to the chat. */
export type SideView =
  | { id: string; type: "terminal"; title: string; scope: string }
  /** The personal agents' browser, live (G24.14b). */
  | { id: string; type: "screen"; title: string }
  /** What an agent showed (G25.1). */
  | { id: string; type: "canvas"; title: string; target: CanvasTarget };

export type SettingsSection =
  | "general"
  | "setup"
  | "agents"
  | "memory"
  | "knowledge"
  | "automations"
  | "extensions"
  | "keychain"
  | "telegram"
  | "chats"
  | "budgets"
  | "subscriptions"
  | "code"
  | "remote"
  | "backup"
  | "platform"
  /** The common tools, switched on and off (G34.5). */
  | "tools"
  /** Import from other agents (G36.7). */
  | "import"
  /** Background commands' and bash's limits (G36.16). */
  | "commands"
  /** What reaches the person, their classifier and its decisions (G36.17). */
  | "requests"
  /** The projects: archive one, the archived ones and «Restore» (2026-11-09). */
  | "projects"
  /** Every artifact of the person: open, export, import, delete (3.5.9). */
  | "artifacts"
  /** External ACP agents as workers, and RedGiant inside editors (G38.6). */
  | "acp"
  /** The person's machines over SSH (G38.2). */
  | "machines";

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
/**
 * What the canvas showed survives a reload (G34.1): its tabs are kept in the page's storage
 * (titles and targets only; the files are read again through their links).
 */
const loadCanvas = (): { views: SideView[]; active: string | null } => {
  try {
    const saved = JSON.parse(localStorage.getItem("rg.canvas") ?? "") as {
      views: SideView[];
      active: string | null;
    };
    const kept = Array.isArray(saved.views) ? saved.views.filter((v) => v.type === "canvas") : [];
    // Ids as they are now (p3.5.4: an open copy's old tab joins its original's), each once.
    const views: SideView[] = [];
    const renamed = new Map<string, string>();
    for (const v of kept) {
      const id = v.type === "canvas" ? canvasViewId(v.target) : v.id;
      renamed.set(v.id, id);
      const at = views.findIndex((x) => x.id === id);
      if (at >= 0) views[at] = { ...v, id };
      else views.push({ ...v, id });
    }
    const active = saved.active ? (renamed.get(saved.active) ?? null) : null;
    return { views, active };
  } catch {
    return { views: [], active: null };
  }
};
const initialCanvas = loadCanvas();
/** Files and terminals open on the right (terminals never survive a reload: their shells are gone). */
export const sideViews = signal<SideView[]>(initialCanvas.views);
export const activeSide = signal<string | null>(
  initialCanvas.active ?? initialCanvas.views[0]?.id ?? null,
);
/** On a phone the area on the right covers the chat: put aside (not closed) to see the chat. */
export const sideAside = signal(initialCanvas.views.length > 0);

/**
 * The area's width next to the chat (p3.3.2): dragged on its divider, kept on this device. Null is
 * the normal width (half of the room); the area never gets narrower than `SIDE_MIN` and always
 * leaves the chat `CHAT_MIN`.
 */
export const SIDE_MIN = 300;
export const CHAT_MIN = 420;
export const loadSideWidth = (): number | null => {
  try {
    const n = Number(localStorage.getItem("rg.sideWidth"));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } catch {
    return null;
  }
};
export const sideWidth = signal<number | null>(loadSideWidth());
/** The area over the whole window (p3.3.2): the chat hidden, the tabs and «Back to chat» kept. */
export const sideMax = signal(false);

/** The width the area may take: at least `SIDE_MIN`, at most what leaves the chat its own. */
export function clampSideWidth(width: number, room: number): number {
  const most = Math.max(SIDE_MIN, room - CHAT_MIN);
  return Math.round(Math.min(most, Math.max(SIDE_MIN, width)));
}

/** Sets the area's width (clamped to the room it shares with the chat) and keeps it. */
export function setSideWidth(width: number, room: number): void {
  const w = clampSideWidth(width, room);
  sideWidth.value = w;
  try {
    localStorage.setItem("rg.sideWidth", String(w));
  } catch {
    // A full storage only forgets the width.
  }
}

/** Back to the normal width (a double click on the divider, or Enter on it). */
export function resetSideWidth(): void {
  sideWidth.value = null;
  try {
    localStorage.removeItem("rg.sideWidth");
  } catch {
    // nothing to forget
  }
}

/**
 * The divider with the keyboard: the arrows move it (Shift: further), Home and End take the
 * narrowest and widest area. The area is on the right, so the left arrow widens it. Null: a key
 * the divider leaves alone.
 */
export function sideWidthByKey(
  key: string,
  shift: boolean,
  width: number,
  room: number,
): number | null {
  const step = shift ? 120 : 24;
  if (key === "ArrowLeft") return clampSideWidth(width + step, room);
  if (key === "ArrowRight") return clampSideWidth(width - step, room);
  if (key === "Home") return clampSideWidth(SIDE_MIN, room);
  if (key === "End") return clampSideWidth(room, room);
  return null;
}

function persistCanvas(): void {
  const views = sideViews.value.filter((v) => v.type === "canvas");
  try {
    localStorage.setItem(
      "rg.canvas",
      JSON.stringify({
        views: views.slice(-12),
        active: views.some((v) => v.id === activeSide.value) ? activeSide.value : null,
      }),
    );
  } catch {
    // A full storage only loses the reopening.
  }
}
/** The project's file explorer on the right. */
export const explorerOpen = signal(localStorage.getItem("rg.explorer") === "1");
/** The phone's drawer with the left bar. */
export const drawerOpen = signal(false);

const persistTabs = () =>
  localStorage.setItem("rg.tabs", JSON.stringify({ tabs: tabs.value, active: activeTab.value }));

/** The advice on NVIDIA's «CUDA Sysmem Fallback» closed by the person (G32.1): shown once. */
export const sysmemAdviceClosed = signal(localStorage.getItem("rg.sysmemAdvice") === "1");

export function closeSysmemAdvice(): void {
  sysmemAdviceClosed.value = true;
  localStorage.setItem("rg.sysmemAdvice", "1");
}

export function toggleExplorer(open = !explorerOpen.value): void {
  explorerOpen.value = open;
  localStorage.setItem("rg.explorer", open ? "1" : "0");
}

/**
 * A credential waiting to be written in the keychain (G33.4): from a magic automation's need
 * (service and host filled in) or from a secret the person was about to send in a chat (its value
 * too, kept only here in the page until saved or dropped).
 */
export const vaultDraft = signal<{
  service?: string;
  name?: string;
  hosts?: string[];
  value?: string;
} | null>(null);

/** Opens the keychain with a credential to add, already filled in. */
export function openVaultDraft(d: NonNullable<typeof vaultDraft.value>): void {
  vaultDraft.value = d;
  openTab({ id: "settings", type: "settings", title: "", section: "keychain" });
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
  if (req.type === "terminal" || req.type === "screen") {
    if (!sideViews.value.some((v) => v.id === req.id)) sideViews.value = [...sideViews.value, req];
    activeSide.value = req.id;
    sideAside.value = false;
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
  forgetTab(id);
  const index = sideViews.value.findIndex((x) => x.id === id);
  sideViews.value = sideViews.value.filter((x) => x.id !== id);
  if (activeSide.value === id)
    activeSide.value = sideViews.value[Math.min(index, sideViews.value.length - 1)]?.id ?? null;
  // The last tab closed: the chat comes back, never an empty window.
  if (sideViews.value.length === 0) sideMax.value = false;
  persistCanvas();
}

/** A canvas tab's id: one tab per file (wherever it opens) or per port and page. */
/** A tab's id: an open copy shares its original's (p3.5.4, one tab per document). */
export function canvasViewId(target: CanvasTarget): string {
  return target.kind === "file"
    ? `canvas:${target.scope}:${copyOriginal(target.path) ?? target.path}`
    : `canvas:${target.agentId}:${target.port}:${target.path ?? ""}`;
}

/**
 * Opens (or brings forward) what an agent showed, in the area on the right (G25.1). `keep`: a
 * tab already open stays as it is (an agent moving in it, G36.12), only brought forward.
 */
export function openCanvas(title: string, target: CanvasTarget, keep = false): string {
  const id = canvasViewId(target);
  // An open copy is shown in its original's tab, under the original's name (p3.5.4).
  const original = target.kind === "file" ? copyOriginal(target.path) : undefined;
  if (original) title = original.split(/[\\/]/).pop() ?? title;
  const view: SideView = { id, type: "canvas", title, target };
  const was = sideViews.value.find((v) => v.id === id);
  const open = !!was;
  // The tab gets another file (an open copy in its original's tab): its old place goes.
  if (!open) tabOpened(id);
  else if (
    !keep &&
    was.type === "canvas" &&
    was.target.kind === "file" &&
    target.kind === "file" &&
    was.target.path !== target.path
  )
    forgetPlace(id);
  if (!(open && keep))
    sideViews.value = open
      ? sideViews.value.map((v) => (v.id === id ? view : v))
      : [...sideViews.value, view];
  activeSide.value = id;
  sideAside.value = false;
  persistCanvas();
  return id;
}

/**
 * A tab's file replaced by another in the same tab, without bringing it forward (p3.5.12: an
 * original shown through its open copy, found once the tab asked). Nothing when it is closed.
 */
export function retargetCanvas(id: string, target: CanvasTarget): void {
  const was = sideViews.value.find((v) => v.id === id);
  if (!was || was.type !== "canvas") return;
  if (was.target.kind === "file" && target.kind === "file" && was.target.path === target.path)
    return;
  forgetPlace(id);
  sideViews.value = sideViews.value.map((v) => (v.id === id ? { ...was, target } : v));
  persistCanvas();
}

/** What the canvas shows now, for an agent that looks (G36.12): tabs, the active one, places. */
export function canvasSnapshot(): CanvasState {
  const views = sideViews.value.filter(
    (v): v is Extract<SideView, { type: "canvas" }> => v.type === "canvas",
  );
  const active = views.find((v) => v.id === activeSide.value);
  const narrow = coversNow();
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  return {
    visible: !!active && !hidden && !(narrow && sideAside.value),
    tabs: views.slice(-50).map((v) => {
      const place = placeOf(v.id);
      const kind = kindOfTab(v.id);
      return {
        title: v.title,
        target: v.target,
        active: v.id === active?.id,
        ...(kind && { kind }),
        ...(place && {
          place: {
            ...place,
            ...(place.selection && { selection: place.selection.slice(0, 2000) }),
          },
        }),
      };
    }),
  };
}

/**
 * Opens a knowledge citation (G36.4) at its point: a file in the Canvas at its page or line, a
 * web page in a new window of the browser.
 */
export async function openCitation(chunkId: string): Promise<void> {
  const r = await getApi().knowledgeOpen(chunkId);
  if ("url" in r) window.open(r.url, "_blank", "noopener,noreferrer");
  else if ("chat" in r)
    openSession({ id: r.chat.sessionId, agentId: r.chat.agentId, title: r.title });
  else if ("text" in r) citationNote.value = { title: r.title, text: r.text };
  else openCanvas(r.title, r.target);
}

/** A cited mail's text (G36.6): it lives in the mailbox, so it is shown in a window. */
export const citationNote = signal<{ title: string; text: string } | null>(null);

/**
 * A citation in an answer (`#kb:<piece>`, made by renderAnswer from the agent's sources) opens
 * its file at the page or line instead of following the address.
 */
if (typeof document !== "undefined")
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='#kb:']");
    if (!a) return;
    e.preventDefault();
    const id = (a.getAttribute("href") ?? "").slice(4);
    if (/^\d+$/.test(id)) void openCitation(id).catch(() => {});
  });

/** Opens a board of variants as a page of its own (G25.4). */
export function openBoard(sessionId: string, proposalId: string, title: string): void {
  openTab({ id: `tavola:${proposalId}`, type: "tavola", title, sessionId, proposalId });
}

/** The scope the explorer shows: the active conversation's project, or God's platform. */
export function currentScope(): {
  scope: string;
  title: string;
  focus?: string;
  /** An archived project's files: shown, never changed (2026-11-09). */
  readOnly?: boolean;
} {
  const tab = tabs.value.find((x) => x.id === activeTab.value);
  const projectOf = (id: string | null | undefined) =>
    projects.value.find((p) => p.id === id) ?? archivedProjects.value.find((p) => p.id === id);
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
  else if (tab?.type === "board" || tab?.type === "inspector" || tab?.type === "archived")
    projectId = tab.projectId;
  const project = projectOf(projectId ?? undefined);
  // A subproject's agent: the explorer opens on its folder (G24.13).
  const sub = agent?.subprojectId
    ? subprojects.value.find((x) => x.id === agent.subprojectId)
    : undefined;
  return project
    ? {
        scope: `project:${project.id}`,
        title: project.name,
        ...(sub && { focus: sub.dir }),
        ...(project.archivedAt && { readOnly: true }),
      }
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
  /** Its folder, if the person put it in one. */
  folder?: string | null;
  /** The conversation it goes on from (G36.23). */
  forkedFrom?: string | null;
  /** The title of the task it works on, while one is open (p3.5.4). */
  task?: string | null;
}

export const sessionRows = signal<SessionRow[]>([]);
/** The Chat's agent (2026-11-03): its conversations are the chats. */
export const chatAgentId = signal<string | null>(null);
export const chatRows = signal<import("./api.js").ChatSummary[]>([]);

export async function refreshConversations(): Promise<void> {
  const a = getApi();
  [sessionRows.value, chatRows.value] = await Promise.all([
    a.sessions() as Promise<SessionRow[]>,
    a.chats(),
  ]);
}

/** The conversations again, once for a burst of news about ones the list does not have. */
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshAgentsToo = false;
function refreshSoon(withAgents = false): void {
  if (withAgents) refreshAgentsToo = true;
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    const alsoAgents = refreshAgentsToo;
    refreshAgentsToo = false;
    void refreshConversations().catch(() => {});
    if (alsoAgents)
      void getApi()
        .agents()
        .then((list) => {
          agents.value = list;
        })
        .catch(() => {});
  }, 250);
}

/** Canvas events already acted on (the followed and the owner-wide copy may both arrive). */
const canvasSeen = new Set<string>();
/** An agent shows a file or acts on the canvas (G34.1, G36.12): its tab opens, once. */
function canvasEvent(sessionId: string, e: Event): void {
  if (e.type !== "canvas.show" && e.type !== "canvas.act") return;
  if (!e.payload) return;
  const key = `${sessionId}:${e.seq}`;
  if (canvasSeen.has(key)) return;
  canvasSeen.add(key);
  if (canvasSeen.size > 500) canvasSeen.delete(canvasSeen.values().next().value as string);
  if (e.type === "canvas.show") openCanvas(e.payload.title, e.payload.target);
  else order(openCanvas(e.payload.title, e.payload.target, true), e.payload.do);
}

/**
 * Opens a conversation by its id (the bell's and the requests' «apri», p3.5.3): from the list
 * when it is there, fetched again when it is not (a task handed over after the page loaded),
 * opened with the agent the request names otherwise. One that cannot be found says so.
 */
export async function openSessionById(sessionId: string, agentId?: string): Promise<boolean> {
  let row = sessionRows.value.find((r) => r.id === sessionId);
  if (!row) {
    await refreshConversations().catch(() => {});
    row = sessionRows.value.find((r) => r.id === sessionId);
  }
  if (row) {
    openSession(row);
    return true;
  }
  if (agentId && agents.value.some((a) => a.id === agentId)) {
    openSession({ id: sessionId, agentId, title: null });
    return true;
  }
  lastError.value = t("sessionNotFound");
  return false;
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

/**
 * A project's name clicked in the left bar (p3.5.4): its orchestrator's latest conversation
 * (pinned or not, never an archived one) opens, or a new one starts when there is none.
 */
export async function openOrchestrator(agent: Agent): Promise<void> {
  const latest = sessionRows.value
    .filter((r) => r.agentId === agent.id && !r.archived)
    .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))[0];
  if (latest) openSession(latest);
  else await newSession(agent);
}

/** Opens the latest conversation with an agent, or starts one. */
export async function openAgent(agent: Agent, fresh = false): Promise<void> {
  const a = getApi();
  // Demi-God and God: the conversation the chats use, so it goes on wherever the person writes.
  const shared = !fresh && (agent.kind === "demigod" || agent.kind === "god");
  const existing = fresh || shared ? [] : await a.sessions(agent.id);
  const sessionId = shared
    ? (await a.workSession(agent.id)).sessionId
    : (existing.at(-1)?.id ?? (await a.startSession(agent.id)).sessionId);
  openTab({
    id: `chat:${sessionId}`,
    type: "chat",
    title: agent.name,
    sessionId,
    agentId: agent.id,
  });
}

/**
 * Agents whose job changed a lot (G36.14): their instructions editor offers to have God rewrite
 * them for the new job. Only offered, never done by itself; cleared when answered.
 */
export const promptRewriteOffer = signal<Record<string, true>>({});
export function offerPromptRewrite(agentId: string, on: boolean): void {
  const { [agentId]: _was, ...rest } = promptRewriteOffer.value;
  promptRewriteOffer.value = on ? { ...rest, [agentId]: true } : rest;
}

// ---------- Sub-agents' tabs (p3.3.1, as Officina shows them) ----------

/** A sub-agent started from a conversation: its tab there. */
export interface SubTab {
  childSessionId: string;
  childAgentId: string;
  callId?: string | undefined;
  via: string;
  title: string;
  task: string;
  /** Its part of its conversation: the events after this one (a work conversation is reused). */
  fromSeq: number;
  startedAt: string;
  endedAt?: string | undefined;
  /** undefined while no end is recorded (working, or died with a restart). */
  ended?: "done" | "failed" | "stopped" | undefined;
  summary?: string | undefined;
  closed: boolean;
}

/** The tabs of a conversation's sub-agents, from its events (pure). A new task reopens a tab. */
export function subagentTabs(events: Event[]): SubTab[] {
  const tabs = new Map<string, SubTab>();
  for (const e of events) {
    if (e.payload === null) continue;
    if (e.type === "subagent.started") {
      const p = e.payload;
      // The same conversation given work again (a persistent agent): the tab follows the newest.
      tabs.delete(p.childSessionId);
      tabs.set(p.childSessionId, {
        childSessionId: p.childSessionId,
        childAgentId: p.childAgentId,
        callId: p.callId,
        via: p.via,
        title: p.title,
        task: p.task,
        // A brand-new conversation is all its own; a reused one from this task on.
        fromSeq: p.via.startsWith("run_subagent") ? 0 : e.seq,
        startedAt: e.ts,
        closed: false,
      });
    } else if (e.type === "subagent.ended") {
      const tab = tabs.get(e.payload.childSessionId);
      if (tab) {
        tab.ended = e.payload.status;
        tab.endedAt = e.ts;
        tab.summary = e.payload.summary;
      }
    } else if (e.type === "subagent.closed") {
      const tab = tabs.get(e.payload.childSessionId);
      if (tab) tab.closed = true;
    }
  }
  return [...tabs.values()];
}

/** What a tab's dot says: working, finished, failed, or stopped (also: died with a restart). */
export function subStatus(
  tab: SubTab,
  childRunning: boolean,
  parentRunning: boolean,
): "running" | "done" | "failed" | "stopped" {
  if (tab.ended) return tab.ended;
  return childRunning || parentRunning ? "running" : "stopped";
}

/** The last event of each sub-agent's conversation the person has seen (its "new" mark). */
export const subSeen = signal<Record<string, number>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem("rg.subSeen") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  })(),
);
export function markSubSeen(childSessionId: string, seq: number): void {
  if ((subSeen.value[childSessionId] ?? 0) >= seq) return;
  subSeen.value = { ...subSeen.value, [childSessionId]: seq };
  try {
    localStorage.setItem("rg.subSeen", JSON.stringify(subSeen.value));
  } catch {}
}

/** Which tab is open in each conversation, level by level (the sub-agents' sessions). */
export const subPath = signal<Record<string, string[]>>({});
export function openSubPath(rootSessionId: string, path: string[]): void {
  subPath.value = { ...subPath.value, [rootSessionId]: path };
}

// ---------- Background commands (p3.3.1) ----------

/** A background command as the strip shows it. */
export interface CommandRow {
  id: string;
  command: string;
  by: string;
  cwd: string;
  path: string;
  startedAt: string;
  endedAt?: string | undefined;
  status: "running" | "done" | "failed" | "stopped" | "interrupted";
  exitCode: number | null;
  closed: boolean;
}

/** The background commands of a conversation, from its events (pure). */
export function commandRows(events: Event[]): CommandRow[] {
  const rows = new Map<string, CommandRow>();
  for (const e of events) {
    if (e.payload === null) continue;
    if (e.type === "command.started")
      rows.set(e.payload.id, {
        id: e.payload.id,
        command: e.payload.command,
        by: e.payload.by,
        cwd: e.payload.cwd,
        path: e.payload.path,
        startedAt: e.ts,
        status: "running",
        exitCode: null,
        closed: false,
      });
    else if (e.type === "command.ended") {
      const r = rows.get(e.payload.id);
      if (r)
        Object.assign(r, { status: e.payload.status, exitCode: e.payload.exitCode, endedAt: e.ts });
    } else if (e.type === "command.closed") {
      const r = rows.get(e.payload.id);
      if (r) r.closed = true;
    }
  }
  return [...rows.values()];
}

/** The strip reduced to one line, or open (remembered on this device). */
export const commandStripMin = signal(
  typeof localStorage !== "undefined" && localStorage.getItem("rg.cmdStrip") === "min",
);
export function setCommandStripMin(min: boolean): void {
  commandStripMin.value = min;
  try {
    localStorage.setItem("rg.cmdStrip", min ? "min" : "open");
  } catch {}
}

// ---------- The editor (G37.1) ----------

/** What the editor's shell shows of one open file: the panel «Modifiche», who is in it, the rule. */
export interface DocView {
  status: "loading" | "ready";
  revision: number;
  /** The latest first. */
  changes: DocChange[];
  proposals: DocProposal[];
  presence: DocPresence[];
  /** When the presence was told (an agent's «sta modificando» fades a minute after). */
  presenceAt: number;
  mode: AgentEditMode;
  modeOwn: boolean;
  /** The agents whose own rule is «come proposte» (when the file has no rule of its own). */
  agentsPropose?: string[] | undefined;
  /** The last refusal of something the person asked (an undo, a proposal), with the host's words. */
  refusal?: { clientId: string; code: string; reason: string; conflict?: number } | undefined;
  /** The last save the host told (G37.3; every family since p3.5.1: «Salvato»). */
  saved?:
    | { revision: number; error?: string | undefined; waitsFor?: string | undefined }
    | undefined;
  /** The revision the file opened at: what is on disk until a save says otherwise. */
  opened?: number | undefined;
  /** Ctrl+S asked, the host has not answered yet (p3.5.1). */
  saving?: boolean | undefined;
  /** The file changed on disk from outside the editor (p3.5.1): told until the person closes it. */
  outside?: { revision: number; ts: string } | undefined;
  /**
   * The page found it no longer matched the host and read the file again (p3.5.7): said until the
   * person closes it; `lost`, the person's unconfirmed typing was let go with it.
   */
  resynced?: { at: number; lost: boolean } | undefined;
  /**
   * An agent's edit stopped because of the person (p3.5.4): typing there now (`busy`) or having
   * changed the same place (`conflict`). Shown a moment, or until closed.
   */
  held?:
    | {
        who: string;
        name?: string | undefined;
        code: "busy" | "conflict";
        line?: number | undefined;
        at: number;
      }
    | undefined;
}

export const emptyDocView = (): DocView => ({
  status: "loading",
  revision: 0,
  changes: [],
  proposals: [],
  presence: [],
  presenceAt: 0,
  mode: "now",
  modeOwn: false,
});

type DocMessage = Extract<
  ServerMessage,
  {
    type:
      | "doc.opened"
      | "doc.changed"
      | "doc.ack"
      | "doc.rejected"
      | "doc.replaced"
      | "doc.presence"
      | "doc.proposals"
      | "doc.mode"
      | "doc.saved"
      | "doc.held";
  }
>;

const withChange = (list: DocChange[], c: DocChange): DocChange[] => {
  const undone = new Set(c.undoOf ?? []);
  // An undo taken back (a redo, p3.5.6) gives its own targets back, as the host does.
  const back = new Map<number, number>();
  for (const y of list)
    if (undone.has(y.revision)) for (const x of y.undoOf ?? []) back.set(x, y.revision);
  const marked = undone.size
    ? list.map((x) => {
        if (undone.has(x.revision)) return { ...x, undoneBy: c.revision };
        if (x.undoneBy !== undefined && back.get(x.revision) === x.undoneBy) {
          const { undoneBy: _back, ...rest } = x;
          return rest;
        }
        return x;
      })
    : list;
  return [c, ...marked.filter((x) => x.revision !== c.revision)].slice(0, 300);
};

/** How long an agent counts as editing a file after the host last said so (its own minute). */
export const AGENT_EDITING_MS = 60_000;

/** Whether an agent is editing the file now («… sta modificando», p3.5.6: highlights stay). */
export const agentEditingNow = (
  v: Pick<DocView, "presence" | "presenceAt">,
  now = Date.now(),
): boolean =>
  now - v.presenceAt < AGENT_EDITING_MS && v.presence.some((p) => p.who !== PERSON && p.editing);

// ---- the agents' changes highlighted now (p3.5.6) ----

/**
 * The revisions an editor shows highlighted now, per file: the shell offers «Annulla questa
 * modifica» on each while it lasts (the person's test of 3.5.5: the highlight was there, nothing
 * to undo it with).
 */
const docMarks = new Map<string, Signal<number[]>>();
export function markedChanges(file: DocFile): Signal<number[]> {
  const key = docKey(file);
  let s = docMarks.get(key);
  if (!s) {
    s = signal([]);
    docMarks.set(key, s);
  }
  return s;
}
export function markChange(file: DocFile, revision: number): void {
  const s = markedChanges(file);
  if (!s.value.includes(revision)) s.value = [...s.value, revision].slice(-50);
}
export function unmarkChange(file: DocFile, revision?: number): void {
  const s = markedChanges(file);
  const next = revision === undefined ? [] : s.value.filter((r) => r !== revision);
  if (next.length !== s.value.length) s.value = next;
}

/**
 * The highlights held in a file's editors, told when one of its changes is undone (p3.5.7, the
 * person's test of 3.5.6: after «Annulla questa modifica» the others lost their highlight): each
 * counts its time again, so every remaining change of the turn stays highlighted while the person
 * goes through them.
 */
const markKeepers = new Map<string, Set<() => void>>();
export function onKeepMarks(file: DocFile, keep: () => void): () => void {
  const key = docKey(file);
  let set = markKeepers.get(key);
  if (!set) {
    set = new Set();
    markKeepers.set(key, set);
  }
  set.add(keep);
  return () => {
    set.delete(keep);
    if (set.size === 0 && markKeepers.get(key) === set) markKeepers.delete(key);
  };
}
export function keepMarks(file: DocFile): void {
  for (const keep of markKeepers.get(docKey(file)) ?? []) keep();
}

/** One message of the host applied to a file's view (pure: tested as a table). */
export function reduceDoc(v: DocView, m: DocMessage): DocView {
  switch (m.type) {
    case "doc.opened":
      return {
        status: "ready",
        revision: m.revision,
        changes: m.changes,
        proposals: m.proposals,
        presence: m.presence,
        presenceAt: Date.now(),
        mode: m.mode,
        modeOwn: m.modeOwn,
        agentsPropose: m.agentsPropose,
        opened: m.revision,
        // Read again because the page had drifted (p3.5.7): still said after the new text.
        ...(v.resynced && { resynced: v.resynced }),
      };
    case "doc.changed":
      return { ...v, revision: m.revision, changes: withChange(v.changes, m.change) };
    case "doc.replaced":
      return {
        ...v,
        revision: m.revision,
        changes: withChange(v.changes, m.change),
        outside: { revision: m.revision, ts: m.change.ts },
        // What is shown is the disk now.
        saved: { revision: m.revision },
      };
    case "doc.ack":
      return {
        ...v,
        revision: Math.max(v.revision, m.revision),
        ...(m.change && { changes: withChange(v.changes, m.change) }),
      };
    case "doc.rejected":
      return {
        ...v,
        refusal: {
          clientId: m.clientId,
          code: m.code,
          reason: m.reason,
          ...(m.conflict !== undefined && { conflict: m.conflict }),
        },
      };
    case "doc.presence":
      return { ...v, presence: m.presence, presenceAt: Date.now() };
    case "doc.proposals":
      return { ...v, proposals: m.proposals };
    case "doc.mode":
      return { ...v, mode: m.mode, modeOwn: m.modeOwn, agentsPropose: m.agentsPropose };
    case "doc.held":
      return {
        ...v,
        held: {
          who: m.who,
          ...(m.name && { name: m.name }),
          code: m.code,
          ...(m.line !== undefined && { line: m.line }),
          at: Date.now(),
        },
      };
    case "doc.saved":
      return {
        ...v,
        saving: false,
        saved: {
          revision: m.revision,
          ...(m.error && { error: m.error }),
          ...(m.waitsFor && { waitsFor: m.waitsFor }),
        },
      };
  }
}

/** The open editor of a file: it is told the revisions to apply to its text. */
export interface DocPeer {
  opened(snapshot: DocSnapshot, revision: number): void;
  changed(m: Extract<ServerMessage, { type: "doc.changed" }>): void;
  ack(m: Extract<ServerMessage, { type: "doc.ack" }>): void;
  rejected(m: Extract<ServerMessage, { type: "doc.rejected" }>): void;
  replaced(m: Extract<ServerMessage, { type: "doc.replaced" }>): void;
}

const docViews = new Map<string, Signal<DocView>>();
const docPeers = new Map<string, DocPeer>();

export function docView(file: DocFile): Signal<DocView> {
  const key = docKey(file);
  let v = docViews.get(key);
  if (!v) {
    v = signal(emptyDocView());
    docViews.set(key, v);
  }
  return v;
}

function docMessage(m: DocMessage): void {
  const v = docView(m.file);
  v.value = reduceDoc(v.value, m);
  if ((m.type === "doc.changed" || m.type === "doc.ack") && m.change?.undoOf?.length)
    keepMarks(m.file);
  const peer = docPeers.get(docKey(m.file));
  if (!peer) return;
  if (m.type === "doc.opened") peer.opened(m.snapshot, m.revision);
  else if (m.type === "doc.changed") peer.changed(m);
  else if (m.type === "doc.ack") peer.ack(m);
  else if (m.type === "doc.rejected") peer.rejected(m);
  else if (m.type === "doc.replaced") peer.replaced(m);
}

/** Opens a file in the editor: the host sends it, then every change; the function closes it. */
export function openDoc(file: DocFile, peer: DocPeer): () => void {
  const key = docKey(file);
  docPeers.set(key, peer);
  docView(file).value = emptyDocView();
  live?.send({ type: "doc.open", file });
  return () => {
    if (docPeers.get(key) === peer) docPeers.delete(key);
    live?.send({ type: "doc.close", file });
  };
}

/** A message about an open file (operations, undo, presence, a proposal's answer). */
export function sendDoc(m: Extract<ClientMessage, { file: DocFile }>): void {
  live?.send(m);
}

/**
 * Ctrl+S (p3.5.1): the host writes the file now. `send: false` when the editor sends it itself a
 * moment later (its last keystrokes still in flight): the indicator says «Salvataggio…» at once.
 */
export function saveDoc(file: DocFile, send = true): void {
  const v = docView(file);
  v.value = { ...v.value, saving: true };
  if (send) live?.send({ type: "doc.save", file });
  watchSave(file, 0);
}

/** How long «Salvataggio…» waits for the host's answer before asking again (p3.5.3). */
export const SAVE_WATCH_MS = 6000;
const saveWatch = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * «Salvataggio…» never stays forever (p3.5.3, the person's test on Windows: the file was saved,
 * the bar never said «Salvato»): with no answer the save is asked once more (an acknowledgement
 * the editor waited for may have been lost), then the bar goes back to what the revisions say.
 */
function watchSave(file: DocFile, tries: number): void {
  const key = docKey(file);
  const was = saveWatch.get(key);
  if (was) clearTimeout(was);
  saveWatch.set(
    key,
    setTimeout(() => {
      saveWatch.delete(key);
      const v = docView(file);
      if (!v.value.saving) return;
      if (tries === 0) {
        live?.send({ type: "doc.save", file });
        watchSave(file, 1);
      } else v.value = { ...v.value, saving: false };
    }, SAVE_WATCH_MS),
  );
}

/** The notice of a refusal (a conflict, a proposal that cannot apply), closed by the person. */
export function dismissRefusal(file: DocFile): void {
  const v = docView(file);
  if (v.value.refusal && v.value.refusal.clientId !== "open")
    v.value = { ...v.value, refusal: undefined };
}

/** How long the notice of an agent stopped by the person stays (p3.5.4). */
export const HELD_NOTICE_MS = 12_000;

/** The notice of an agent stopped by the person, closed (by them, or after a moment). */
export function dismissHeld(file: DocFile, at?: number): void {
  const v = docView(file);
  if (v.value.held && (at === undefined || v.value.held.at === at))
    v.value = { ...v.value, held: undefined };
}

/** The notice of a change from outside, closed by the person. */
/** The editor read the file again because it no longer matched the host (p3.5.7). */
export function docResynced(file: DocFile, lost: boolean): void {
  const v = docView(file);
  v.value = { ...v.value, resynced: { at: Date.now(), lost: lost || !!v.value.resynced?.lost } };
}

export function dismissResynced(file: DocFile): void {
  const v = docView(file);
  v.value = { ...v.value, resynced: undefined };
}

export function dismissOutside(file: DocFile): void {
  const v = docView(file);
  v.value = { ...v.value, outside: undefined };
}

/** The person's rule for the agents' edits of one file (Settings keep it, with its history). */
export async function setDocMode(file: DocFile, mode: AgentEditMode | "default"): Promise<void> {
  const a = getApi();
  const { settings } = await a.editorSettings();
  const files = { ...settings.files };
  if (mode === "default") delete files[docKey(file)];
  else files[docKey(file)] = mode;
  await a.setEditorSettings({ ...settings, files });
}

// ---- The full document editor coming down (p3.5.7) ----

/** Where the page's one document editor is (OfficeEditor's phases), for the line under the head. */
export type OfficeLoadPhase =
  | { at: "checking" }
  | { at: "server"; job: string }
  | { at: "browser"; done: number; total: number }
  | { at: "opening" }
  | { at: "ready" }
  | { at: "fallback" };

export interface OfficeLoad {
  at: OfficeLoadPhase["at"];
  /** The server's download, as a job (its progress has speed and time left). */
  job?: string;
  /** Into this browser: amounts, speed and time left, measured here. */
  progress?: JobProgress;
  /** When and from where the copy into this browser was measured. */
  since?: { at: number; done: number };
  /** The editor came down in this page: «downloaded» stays until the person closes it. */
  downloaded?: boolean;
}

/** A copy into the browser this short came from its storage, not over the network. */
const FROM_STORAGE_MS = 1500;

/**
 * The editor's next state, pure (p3.5.7, the person's test of 3.5.6: «about 51 MB the first time»
 * vanished as «Edit» opened the copy, before it could be read, and the copy into the browser had
 * a bar without speed or time left): speed and time left measured from the first amount seen, and
 * a real download (on the server, or a copy that took time) remembered once it is over.
 */
export function officeLoadStep(
  prev: OfficeLoad | undefined,
  ph: OfficeLoadPhase,
  now: number,
): OfficeLoad {
  const kept = prev?.downloaded ? { downloaded: true } : {};
  if (ph.at === "server") return { ...kept, at: "server", job: ph.job };
  if (ph.at === "browser") {
    const since =
      prev?.at === "browser" && prev.since ? prev.since : { at: now, done: Math.max(0, ph.done) };
    const seconds = (now - since.at) / 1000;
    const total = ph.total > 1 ? ph.total : null;
    const rate = seconds >= 0.5 && ph.done > since.done ? (ph.done - since.done) / seconds : null;
    return {
      ...kept,
      at: "browser",
      since,
      ...(prev?.job && { job: prev.job }),
      progress: {
        done: ph.done,
        total,
        rate,
        secondsLeft: rate && total ? Math.max(0, (total - ph.done) / rate) : null,
      },
    };
  }
  const came =
    prev?.at === "server" ||
    (prev?.at === "browser" && !!prev.job) ||
    (prev?.at === "browser" && !!prev.since && now - prev.since.at >= FROM_STORAGE_MS);
  if (ph.at === "fallback") return { at: "fallback" };
  return { at: ph.at, ...((prev?.downloaded || came) && { downloaded: true }) };
}

export const officeLoad = signal<OfficeLoad | undefined>(undefined);

/** The editor's phase, told by the tab that holds it. */
export function setOfficeLoad(ph: OfficeLoadPhase): void {
  officeLoad.value = officeLoadStep(officeLoad.value, ph, Date.now());
}

/** The person closed the «downloaded» line. */
export function dismissOfficeDownloaded(): void {
  const v = officeLoad.value;
  if (v?.downloaded) officeLoad.value = { ...v, downloaded: false };
}
