import { useComputed } from "@preact/signals";
import { type AssistantPart, ownWords, type PermissionRequestInfo } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { duration, kTokens } from "../format.js";
import { danger, lang, t } from "../i18n.js";
import {
  IconAlert,
  IconArrowDown,
  IconAside,
  IconCanvas,
  IconChevron,
  IconClose,
  IconFile,
  IconInfo,
  IconLayers,
  IconShield,
  IconSpinner,
  IconStop,
  IconUsers,
} from "../icons.js";
import { renderAnswer, renderMarkdown, renderStreamingMarkdown } from "../markdown.js";
import {
  agents,
  approvals,
  attempt,
  buildItems,
  type ChatItem,
  getApi,
  getLive,
  inheritedModel,
  markSubSeen,
  openBoard,
  openCanvas,
  openSession,
  openSubPath,
  openTab,
  questions,
  refresh,
  refreshRooms,
  type SubTab,
  sessionRows,
  sessionView,
  subagentTabs,
  subPath,
  subSeen,
  subStatus,
} from "../state.js";
import { canvasKind } from "./Canvas.js";
import {
  AsidePanel,
  addQuote,
  ContinueHere,
  ForkMark,
  type QuoteDraft,
  QuoteDrafts,
  QuotePicker,
  QuoteRefs,
} from "./ChatTools.js";
import { CommandStrip } from "./CommandStrip.js";
import { Composer, packMessage } from "./Composer.js";
import { Images } from "./Images.js";
import { MetricsBar } from "./MetricsBar.js";
import { ModelMenu } from "./ModelMenu.js";
import { QuestionCard } from "./QuestionCard.js";
import { ToolRequestCard } from "./ToolRequestCard.js";
import { TurnProgress } from "./TurnProgress.js";
import { FileIcon } from "./viewers/FileIcon.js";

/** A picture from the workspace inside the chat (generate_image's result); a click opens it. */
function WorkspaceImage({ scope, path }: { scope: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    void attempt(() => getApi().download(scope, path)).then((blob) => {
      if (cancelled) return;
      if (!blob) return setFailed(true);
      made = URL.createObjectURL(
        // An SVG shown as an image runs no script; the right type makes it display.
        path.toLowerCase().endsWith(".svg") ? new Blob([blob], { type: "image/svg+xml" }) : blob,
      );
      setUrl(made);
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [scope, path]);
  if (failed) return <div class="dim">{path}</div>;
  if (!url) return <div class="drawing-frame" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" class="generated">
      <img src={url} alt={path} />
    </a>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Parts({ parts }: { parts: AssistantPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.type === "thinking" ? (
          p.text ? (
            <details class="thinking" key={i}>
              <summary>{t("thinking")}</summary>
              <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />
            </details>
          ) : null
        ) : p.type === "text" ? (
          <div class="md" key={i} dangerouslySetInnerHTML={{ __html: renderAnswer(p.text) }} />
        ) : null,
      )}
    </>
  );
}

/** A tool call in one line (name and a summary of its input); its input and result unfold. */
/** Where an agent's files are, for the pictures it draws: its project, or God's platform. */
const scopeOf = (agentId: string) => {
  const projectId = agents.value.find((a) => a.id === agentId)?.projectId;
  return projectId ? `project:${projectId}` : "platform";
};

/**
 * The agent's list of steps (update_todos, 2026-11-05), pinned above the composer: the latest
 * list of the conversation, until every step is done and the agent has stopped.
 */
function Todos({ items, running }: { items: ChatItem[]; running: boolean }) {
  const [folded, setFolded] = useState(false);
  const last = [...items]
    .reverse()
    .find((i) => i.kind === "tool" && i.tool === "update_todos" && i.result?.ok);
  const todos =
    last?.kind === "tool"
      ? ((last.input as { todos?: { content: string; status: string }[] }).todos ?? [])
      : [];
  const done = todos.filter((x) => x.status === "completed").length;
  if (todos.length === 0 || (done === todos.length && !running)) return null;
  return (
    <div class="todos">
      <button
        type="button"
        class="todos-head"
        onClick={() => setFolded(!folded)}
        aria-expanded={!folded}
      >
        <IconChevron size={12} open={!folded} />
        {t("todosTitle", { done: String(done), all: String(todos.length) })}
      </button>
      {!folded && (
        <ol>
          {todos.map((x, i) => (
            <li key={i} class={x.status}>
              <span class="todo-mark">
                {x.status === "completed" ? (
                  <i class="todo-dot done" />
                ) : x.status === "in_progress" ? (
                  <IconSpinner size={12} />
                ) : (
                  <i class="todo-dot" />
                )}
              </span>
              {x.content}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A message of the person's, with "Edit": the edited text goes to a copy of the conversation up
 * to that point (2026-11-05, as LibreChat, Zed and Claude Code's /branch); the original stays.
 */
function UserItem({
  item,
  agentId,
  sessionId,
  actions,
}: {
  item: Extract<ChatItem, { kind: "user" }>;
  agentId: string;
  sessionId: string;
  actions?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const seq = Number(item.key.replace(/^e/, ""));
  const fork = async (text: string) => {
    const r = await attempt(() => getApi().forkSession(sessionId, { beforeSeq: seq }));
    if (!r) return;
    openSession({ id: r.sessionId, agentId, title: null });
    getLive().send({ type: "session.send", sessionId: r.sessionId, text });
    setEditing(null);
  };
  if (editing !== null)
    return (
      <form
        class="bubble user editing"
        onSubmit={(e) => {
          e.preventDefault();
          if (editing.trim()) void fork(editing.trim());
        }}
      >
        <textarea
          value={editing}
          rows={3}
          onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)}
        />
        <div class="row">
          <span class="ui-help">{t("editForks")}</span>
          <div class="spacer" />
          <button type="button" class="link" onClick={() => setEditing(null)}>
            {t("cancel")}
          </button>
          <button type="submit" class="primary" disabled={!editing.trim()}>
            {t("editSend")}
          </button>
        </div>
      </form>
    );
  return (
    <>
      {item.from && <div class="from">{item.from}</div>}
      <div class="bubble user">
        {item.quotes && <QuoteRefs quotes={item.quotes} />}
        <Images images={item.images} />
        {splitAttachments(item.text).text}
        {splitAttachments(item.text).files.length > 0 && (
          <div class="attachments">
            {splitAttachments(item.text).files.map((f) =>
              f.path ? (
                // Saved in the workspace (a pasted text, a file): it opens in the canvas.
                <button
                  key={f.name}
                  type="button"
                  class="attachment openable"
                  title={t("attachmentOpen")}
                  onClick={() => {
                    const projectId = agents.value.find((a) => a.id === agentId)?.projectId;
                    openCanvas(f.name, {
                      kind: "file",
                      scope: projectId ? `project:${projectId}` : "platform",
                      path: f.path as string,
                    });
                  }}
                >
                  <IconFile size={13} />
                  <span>{f.name}</span>
                </button>
              ) : (
                <span key={f.name} class="attachment">
                  <IconFile size={13} />
                  <span>{f.name}</span>
                </span>
              ),
            )}
          </div>
        )}
      </div>
      <div class="time">{time(item.ts)}</div>
      {actions && Number.isFinite(seq) && (
        <div class="msg-actions user-actions">
          {!item.from && (
            <button
              type="button"
              class="link msg-action"
              onClick={() => setEditing(splitAttachments(item.text).text)}
            >
              {t("editMessage")}
            </button>
          )}
          <ContinueHere sessionId={sessionId} agentId={agentId} seq={seq} />
        </div>
      )}
    </>
  );
}

function ToolLine({
  item,
  agentId,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  agentId: string;
}) {
  const [open, setOpen] = useState(false);
  const input = item.input as Record<string, unknown> | undefined;
  const summary =
    typeof input === "object" && input
      ? String(
          input.command ??
            input.path ??
            input.pattern ??
            input.query ??
            input.url ??
            JSON.stringify(input),
        )
      : "";
  const state = !item.result ? "running" : item.result.ok ? "done" : "failed";
  const picture = item.result?.output.match(/^Saved (images\/\S+\.png)/)?.[1];
  // What a file tool changed (2026-11-05): its diff, shown at once, and how many lines.
  const diff = item.result?.output.match(/```diff\n([\s\S]*?)```/)?.[1];
  const added = diff?.split("\n").filter((l) => l.startsWith("+")).length ?? 0;
  const removed = diff?.split("\n").filter((l) => l.startsWith("-")).length ?? 0;
  // Sub-agents' conversations, even once they are stopped (their reports end with this line).
  const talks = [...(item.result?.output.matchAll(/^Conversation: (\S+) \((\S+)\)$/gm) ?? [])];
  return (
    <div class={`tool ${state}${item.viaScript ? " via-script" : ""}`}>
      <button type="button" class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="mark">
          {/* Done is a green dot, failed a red X (no check marks, 2026-11-07). */}
          {state === "running" ? (
            <IconSpinner />
          ) : state === "done" ? (
            <i class="tool-dot" />
          ) : (
            <IconClose />
          )}
        </span>
        <span class="tname">{item.tool}</span>
        {item.viaScript && <span class="tvia">{t("viaScript")}</span>}
        <span class="tsum">{summary.replace(/\s+/g, " ").slice(0, 140)}</span>
        {diff && (
          <span class="tdiff">
            <span class="plus">+{added}</span> <span class="minus">-{removed}</span>
          </span>
        )}
      </button>
      {item.result?.images && (
        <div class="tool-seen">
          <span class="dim">{t("toolSeen")}</span>
          <Images images={item.result.images} />
        </div>
      )}
      {diff && (
        <div
          class="md tool-diff"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(`\`\`\`diff\n${diff}\`\`\``) }}
        />
      )}
      {open && (
        <>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre>{item.result.output}</pre>}
        </>
      )}
      {talks.length > 0 && (
        <div class="row tool-links">
          {talks.map(([, sessionId, subId]) => (
            <button
              type="button"
              class="link"
              key={sessionId}
              onClick={() =>
                openSession({
                  id: sessionId ?? "",
                  agentId: subId ?? "",
                  title: agents.value.find((a) => a.id === subId)?.name ?? null,
                })
              }
            >
              {t("openSubagentChat", {
                name: agents.value.find((a) => a.id === subId)?.name ?? t("kind_subagent"),
              })}
            </button>
          ))}
        </div>
      )}
      {item.tool === "generate_image" && item.result?.ok && picture && (
        <WorkspaceImage scope={scopeOf(agentId)} path={picture} />
      )}
    </div>
  );
}

/** A request waiting for the human, inside the conversation it belongs to. */
export function PermissionCard({ r }: { r: PermissionRequestInfo }) {
  // A switched-off tool asked back (G36.15) has its own words and choices.
  if (r.tool === "request_tool") return <ToolRequestCard r={r} />;
  return <ToolPermission r={r} />;
}

function ToolPermission({ r }: { r: PermissionRequestInfo }) {
  const [all, setAll] = useState(false);
  // Denied with words the agent reads (2026-11-05).
  const [why, setWhy] = useState<string | null>(null);
  const input = JSON.stringify(r.input, null, 2);
  const resolve = (
    decision: "allow" | "deny",
    scope: "once" | "session" | "always" = "once",
    reason?: string,
  ) =>
    getLive().send({
      type: "permission.resolve",
      requestId: r.requestId,
      decision,
      remember: scope === "always",
      scope,
      ...(reason?.trim() && { reason: reason.trim() }),
    });
  return (
    <div class="permission">
      <div class="row">
        <IconShield />
        <strong>
          {r.agentName} {t("wants")} {r.tool}
        </strong>
      </div>
      <pre style={all ? { maxHeight: "none" } : undefined}>{input}</pre>
      {input.split("\n").length > 8 && (
        <button type="button" class="link" onClick={() => setAll(!all)}>
          {all ? t("showLess") : t("showAllInput")}
        </button>
      )}
      <div class="dim">
        {t("because")}: {r.reasons.join("; ")}
        {r.danger.length > 0 && (
          <span class="chip danger">{r.danger.map((d) => danger(d).name).join(", ")}</span>
        )}
      </div>
      <div class="permission-actions" style={{ marginTop: "8px" }}>
        <button type="button" class="yes" onClick={() => resolve("allow")}>
          {t("allow")}
        </button>
        {r.danger.length === 0 && r.sessionId && (
          <button
            type="button"
            class="always"
            title={t("thisChatHint", { tool: r.tool })}
            onClick={() => resolve("allow", "session")}
          >
            {t("thisChat")}
          </button>
        )}
        {r.danger.length === 0 && (
          <button
            type="button"
            class="always"
            title={t("alwaysHint", { tool: r.tool })}
            onClick={() => resolve("allow", "always")}
          >
            {t("always")}
          </button>
        )}
        <button type="button" class="no" onClick={() => resolve("deny")}>
          {t("deny")}
        </button>
        {why === null && (
          <button type="button" class="link" onClick={() => setWhy("")}>
            {t("denyWhy")}
          </button>
        )}
      </div>
      {why !== null && (
        <form
          class="row permission-why"
          onSubmit={(e) => {
            e.preventDefault();
            resolve("deny", "once", why);
          }}
        >
          <input
            value={why}
            placeholder={t("denyWhyPlaceholder")}
            onInput={(e) => setWhy((e.target as HTMLInputElement).value)}
          />
          <button type="submit" class="no" disabled={!why.trim()}>
            {t("deny")}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * The attachments travel inside the text; the bubble shows their names instead, and those saved
 * in the workspace (`path`) open in the canvas.
 */
export const splitAttachments = (text: string) => {
  const cut = text.search(/\n\n<attachment name="/);
  if (cut < 0) return { text, files: [] as { name: string; path?: string }[] };
  const files = [
    ...text.slice(cut).matchAll(/<attachment name="([^"]*)"(?: path="([^"]*)")?/g),
  ].map((m) => ({ name: m[1] ?? "", ...(m[2] && { path: m[2] }) }));
  return { text: text.slice(0, cut), files };
};

/** "The conversation was summarised here" (G24.14): the summary opens; a manual one undoes. */
function CompactionMark({
  item,
  sessionId,
}: {
  item: Extract<ChatItem, { kind: "compaction" }>;
  sessionId: string;
}) {
  return (
    <details class={`compaction-mark${item.undone ? " undone" : ""}`}>
      <summary>
        <IconLayers size={13} />{" "}
        {item.undone ? t("compactionUndone") : t(`compaction_${item.reason}`)}
        {item.undoable && (
          <button
            type="button"
            class="tiny"
            onClick={(e) => {
              e.preventDefault();
              // The "undone" event arrives live and marks this summary.
              void attempt(() => getApi().undoCompaction(sessionId));
            }}
          >
            {t("undo")}
          </button>
        )}
      </summary>
      <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.summary) }} />
    </details>
  );
}

function Item({
  item,
  agentId,
  sessionId,
  actions,
}: {
  item: ChatItem;
  agentId: string;
  sessionId: string;
  /** The conversation's own view: quotes, «Continua da qui», «Modifica» (not a sub-agent's tab). */
  actions?: boolean;
}) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} agentId={agentId} sessionId={sessionId} actions={actions} />;
    case "assistant":
      return (
        <>
          <div class="bubble assistant" data-seq={item.seq} data-at={item.ts}>
            <Parts parts={item.parts} />
            {!item.imported && (
              <MetricsBar
                m={item.metrics}
                costUsd={item.costUsd}
                model={item.model}
                compactAt={agents.value.find((a) => a.id === agentId)?.compaction?.at ?? 0.8}
              />
            )}
          </div>
          {actions && item.parts.some((p) => p.type === "text" && p.text.trim()) && (
            <div class="msg-actions">
              <ContinueHere sessionId={sessionId} agentId={agentId} seq={item.seq} />
            </div>
          )}
        </>
      );
    case "fork":
      return (
        <ForkMark
          fromSessionId={item.fromSessionId}
          fromTitle={item.fromTitle}
          how={item.how}
          agentId={agentId}
        />
      );
    case "tool":
      return <ToolLine item={item} agentId={agentId} />;
    case "question":
      return (
        <QuestionCard
          requestId={item.requestId}
          questions={item.questions}
          plan={item.plan}
          answers={item.answers}
          open={
            item.answers === undefined &&
            questions.value.some((q) => q.requestId === item.requestId)
          }
        />
      );
    case "compaction":
      return <CompactionMark item={item} sessionId={sessionId} />;
    case "cache":
      return (
        <div class="notice warn">
          <IconAlert size={13} />
          {t("cacheMissed", { cached: kTokens(item.cached), expected: kTokens(item.expected) })}
        </div>
      );
    case "file":
      return <FileCard item={item} />;
    case "variants":
      return (
        <button
          type="button"
          class="canvas-card"
          title={t("boardOpen")}
          onClick={() => openBoard(item.sessionId, item.proposalId, item.title)}
        >
          <IconCanvas size={16} />
          <span>
            <strong>{item.title}</strong>
            <span class="dim">
              {item.chosen === null
                ? t("boardWaiting", { n: String(item.count) })
                : t("boardDone", { n: String(item.chosen) })}
            </span>
          </span>
        </button>
      );
    case "canvas": {
      // A line in the agent's message (G34.1): «Opened <file> in the canvas», pressed to see it again.
      const [before, after] = t("canvasOpened", { name: "\u0000" }).split("\u0000");
      return (
        <button
          type="button"
          class="canvas-line"
          title={t("canvasShown")}
          onClick={() => openCanvas(item.title, item.target)}
        >
          {item.target.kind === "file" ? (
            <FileIcon name={item.target.path} size={15} />
          ) : (
            <IconCanvas size={15} />
          )}
          <span>
            {before}
            <strong>{item.title}</strong>
            {after}
          </span>
        </button>
      );
    }
    case "notice":
      return (
        <div class={`notice ${item.tone}`}>
          {item.tone === "error" || item.tone === "warn" ? (
            <IconAlert size={13} />
          ) : (
            <IconInfo size={13} />
          )}
          {item.text}
        </div>
      );
  }
}

const MODES = ["manual", "auto", "plan", "readonly"] as const;

/** A live conversation with one agent. */
/** A file an agent sent (G25.2): pictures, videos and sounds in place; anything opens or saves. */
function FileCard({ item }: { item: Extract<ChatItem, { kind: "file" }> }) {
  const kind = canvasKind({ kind: "file", scope: item.scope, path: item.path });
  const inline = kind === "image" || kind === "video" || kind === "audio";
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!inline) return;
    void getApi()
      .canvasLink({ kind: "file", scope: item.scope, path: item.path })
      .then(
        (r) => setUrl(r.url),
        () => {},
      );
  }, [item.scope, item.path]);
  const save = async () => {
    const blob = await attempt(() => getApi().download(item.scope, item.path));
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  return (
    <div class="file-card">
      {url && kind === "image" && (
        <button
          type="button"
          class="file-card-image"
          title={t("canvasOpen")}
          onClick={() =>
            openCanvas(item.name, { kind: "file", scope: item.scope, path: item.path })
          }
        >
          <img src={url} alt={item.caption ?? item.name} />
        </button>
      )}
      {url && kind === "video" && (
        // biome-ignore lint/a11y/useMediaCaption: agents' videos come without captions.
        <video src={url} controls />
      )}
      {url && kind === "audio" && (
        // biome-ignore lint/a11y/useMediaCaption: agents' sounds come without captions.
        <audio src={url} controls />
      )}
      {item.caption && <p>{item.caption}</p>}
      <div class="row file-card-row">
        <IconFile size={14} />
        <span class="file-card-name" title={item.path}>
          {item.name}
        </span>
        <span class="dim">{formatBytes(item.size)}</span>
        <div class="spacer" />
        <button
          type="button"
          class="tiny"
          onClick={() =>
            openCanvas(item.name, { kind: "file", scope: item.scope, path: item.path })
          }
        >
          {t("canvasOpen")}
        </button>
        <button type="button" class="tiny" onClick={() => void save()}>
          {t("fileSave")}
        </button>
      </div>
    </div>
  );
}

/** A size in words people read: 312 KB, 4.2 MB. */
const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

/**
 * A conversation with its sub-agents (p3.3.1, as Officina shows them): when it started any, a
 * row of tabs on top, «Main agent» and one per sub-agent; a sub-agent with sub-agents of its own
 * opens another row under it, and so on. Without sub-agents, just the conversation.
 */
export function Chat({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const view = sessionView(sessionId);
  const tabs = useComputed(() => subagentTabs(view.value.events));
  const path = subPath.value[sessionId] ?? [];
  if (path.length === 0 && !tabs.value.some((x) => !x.closed))
    return <MainChat sessionId={sessionId} agentId={agentId} />;
  // Each level: the conversation whose tabs it shows, and the tab chosen in it. A chosen
  // sub-agent with sub-agents of its own adds the next level (row) under it.
  type Level = { session: string; agentId: string; tabs: SubTab[]; chosen?: SubTab };
  const levels: Level[] = [{ session: sessionId, agentId, tabs: tabs.value }];
  for (const id of path) {
    const level = levels.at(-1) as Level;
    const tab = level.tabs.find((x) => x.childSessionId === id && !x.closed);
    if (!tab) break;
    level.chosen = tab;
    const below = subagentTabs(sessionView(tab.childSessionId).value.events);
    if (!below.some((x) => !x.closed)) break;
    levels.push({ session: tab.childSessionId, agentId: tab.childAgentId, tabs: below });
  }
  const chosen = levels.filter((l) => l.chosen);
  const open = chosen.at(-1);
  return (
    <div class="chat sub-host">
      <SubRows root={sessionId} rootAgent={agentId} levels={levels} />
      {open?.chosen ? (
        <SubagentView
          key={open.chosen.childSessionId}
          tab={open.chosen}
          parentSession={open.session}
          parentAgent={open.agentId}
          depth={chosen.length}
        />
      ) : (
        <MainChat sessionId={sessionId} agentId={agentId} />
      )}
    </div>
  );
}

/** Follows the conversations behind the visible tabs: their state and their new messages. */
function useFollowAll(ids: string[]) {
  const key = ids.join(",");
  useEffect(() => {
    const live = getLive();
    for (const id of ids) live.send({ type: "session.follow", sessionId: id });
    return () => {
      for (const id of ids) live.send({ type: "session.unfollow", sessionId: id });
    };
  }, [key]);
}

const agentName = (id: string) => agents.value.find((a) => a.id === id)?.name ?? "";
/** A request belongs to the sub-agent's conversation (its agent's only when it names none). */
const asksIn = (tab: SubTab) =>
  approvals.value.filter((r) =>
    r.sessionId ? r.sessionId === tab.childSessionId : r.agentId === tab.childAgentId,
  );
const asks = (tab: SubTab) => asksIn(tab).length > 0;

/** The rows of tabs, one per level, with the path in words above the conversation shown. */
function SubRows({
  root,
  rootAgent,
  levels,
}: {
  root: string;
  rootAgent: string;
  levels: { session: string; agentId: string; tabs: SubTab[]; chosen?: SubTab }[];
}) {
  const path = subPath.value[root] ?? [];
  useFollowAll(levels.flatMap((l) => l.tabs.filter((x) => !x.closed).map((x) => x.childSessionId)));
  const askers = levels.flatMap((l, i) =>
    l.tabs
      .filter((x) => !x.closed && x.childSessionId !== path[i] && asks(x))
      .map((x) => ({ tab: x, level: i })),
  );
  return (
    <div class="sub-rows">
      {levels.map((l, i) => (
        <div class="sub-row" role="tablist" key={l.session} aria-label={t("subRow")}>
          <button
            type="button"
            role="tab"
            aria-selected={!l.chosen}
            class={`sub-tab sub-main ${!l.chosen ? "on" : ""}`}
            onClick={() => openSubPath(root, path.slice(0, i))}
          >
            <span class="sub-tab-title">
              {i === 0 ? t("subMain") : t("subOwn", { name: agentName(l.agentId) })}
            </span>
          </button>
          {l.tabs
            .filter((x) => !x.closed)
            .map((x) => (
              <SubTabButton
                key={x.childSessionId}
                tab={x}
                parent={l.session}
                on={l.chosen?.childSessionId === x.childSessionId}
                select={() => openSubPath(root, [...path.slice(0, i), x.childSessionId])}
                closed={() => {
                  if (l.chosen?.childSessionId === x.childSessionId)
                    openSubPath(root, path.slice(0, i));
                }}
              />
            ))}
        </div>
      ))}
      {path.length > 0 && (
        <nav class="sub-crumbs" aria-label={t("subPath")}>
          <button type="button" class="link" onClick={() => openSubPath(root, [])}>
            {agentName(rootAgent) || t("subMain")}
          </button>
          {levels
            .filter((l) => l.chosen)
            .map((l, i) => {
              const tab = l.chosen;
              return (
                <span key={tab?.childSessionId} class="sub-crumb">
                  <IconChevron open={false} size={12} />
                  <button
                    type="button"
                    class="link"
                    onClick={() => openSubPath(root, path.slice(0, i + 1))}
                  >
                    {tab?.title ?? ""}
                  </button>
                </span>
              );
            })}
        </nav>
      )}
      {askers.map(({ tab, level }) => (
        <div class="notice warn sub-asks-line" key={tab.childSessionId}>
          <IconShield size={13} />
          <span>{t("subAsks", { name: tab.title })}</span>
          <button
            type="button"
            class="link"
            onClick={() => openSubPath(root, [...path.slice(0, level), tab.childSessionId])}
          >
            {t("subOpenTab")}
          </button>
        </div>
      ))}
    </div>
  );
}

/** One sub-agent's tab: its task, a dot for its state, «new», «waits for your yes», and «x». */
function SubTabButton({
  tab,
  parent,
  on,
  select,
  closed,
}: {
  tab: SubTab;
  parent: string;
  on: boolean;
  select: () => void;
  closed: () => void;
}) {
  const child = sessionView(tab.childSessionId).value;
  const status = subStatus(
    tab,
    child.state === "running",
    sessionView(parent).value.state === "running",
  );
  const lastSeq = child.events.at(-1)?.seq ?? 0;
  const fresh = !on && lastSeq > (subSeen.value[tab.childSessionId] ?? tab.fromSeq);
  const waiting = asks(tab);
  const from = agentName(tab.childAgentId);
  return (
    <div
      class={`sub-tab ${on ? "on" : ""} ${status}`}
      title={`${tab.title}${from ? ` (${from})` : ""} · ${t(`subStatus_${status}`)}`}
    >
      <button type="button" role="tab" aria-selected={on} class="sub-tab-main" onClick={select}>
        <span role="img" class={`sub-dot ${status}`} aria-label={t(`subStatus_${status}`)} />
        <span class="sub-tab-title">{tab.title}</span>
        {fresh && (
          <span role="img" class="sub-new" aria-label={t("subFresh")} title={t("subFresh")} />
        )}
        {waiting && (
          <span role="img" class="sub-waits" title={t("subWaits")} aria-label={t("subWaits")}>
            <IconShield size={12} />
          </span>
        )}
      </button>
      {status !== "running" && (
        <button
          type="button"
          class="sub-tab-x"
          title={t("subClose")}
          aria-label={t("subClose")}
          onClick={() => {
            getLive().send({
              type: "subagent.close",
              sessionId: parent,
              childSessionId: tab.childSessionId,
            });
            closed();
          }}
        >
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * A sub-agent's tab: the task it was given, its conversation with the chat's own pieces, and
 * instead of the composer a bar with its time, tools, tokens and «Stop» (nobody writes to it:
 * it takes orders from the agent that started it).
 */
function SubagentView({
  tab,
  parentSession,
  parentAgent,
  depth,
}: {
  tab: SubTab;
  parentSession: string;
  parentAgent: string;
  depth: number;
}) {
  const view = sessionView(tab.childSessionId);
  const mine = useComputed(() => view.value.events.filter((e) => e.seq > tab.fromSeq));
  const items = useComputed(() => buildItems(mine.value));
  const v = view.value;
  const status = subStatus(
    tab,
    v.state === "running",
    sessionView(parentSession).value.state === "running",
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => {
    const live = getLive();
    live.send({ type: "session.follow", sessionId: tab.childSessionId });
    return () => live.send({ type: "session.unfollow", sessionId: tab.childSessionId });
  }, [tab.childSessionId]);
  const lastSeq = v.events.at(-1)?.seq ?? 0;
  useEffect(() => markSubSeen(tab.childSessionId, lastSeq), [lastSeq, tab.childSessionId]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160)
      el.scrollTop = el.scrollHeight;
  });
  const tools = items.value.filter((i) => i.kind === "tool").length;
  const tokens = mine.value.reduce(
    (n, e) =>
      e.type === "message.assistant" && e.payload
        ? n + e.payload.metrics.inputTokens + e.payload.metrics.outputTokens
        : n,
    0,
  );
  const end = tab.endedAt ? Date.parse(tab.endedAt) : status === "running" ? now : undefined;
  const ms = end !== undefined ? end - Date.parse(tab.startedAt) : undefined;
  const waiting = asksIn(tab);
  const from = agentName(parentAgent);
  return (
    <div class="chat sub-view" data-depth={depth}>
      <CommandStrip sessionId={tab.childSessionId} />
      <div class="chat-body">
        <div class="chat-scroll" ref={scroller}>
          <details class="sub-task" open={tab.task.length < 600}>
            <summary>
              <strong>{from ? t("subTaskFrom", { name: from }) : t("subTask")}</strong>
              <span class="dim">{tab.title}</span>
            </summary>
            <div class="sub-task-text">{tab.task}</div>
          </details>
          {items.value.map((item) => (
            <Item
              key={item.key}
              item={item}
              agentId={tab.childAgentId}
              sessionId={tab.childSessionId}
            />
          ))}
          {status === "running" && v.call && <TurnProgress call={v.call} />}
          {(v.thinking || v.text) && (
            <div class="bubble assistant streaming">
              {v.text ? (
                <div
                  class="md"
                  dangerouslySetInnerHTML={{ __html: renderStreamingMarkdown(v.text) }}
                />
              ) : (
                <div class="dim">{v.thinking.slice(-2000)}</div>
              )}
            </div>
          )}
          {tab.summary && status !== "running" && (
            <div class={`notice ${status === "done" ? "ok" : "error"}`}>
              <IconInfo size={13} />
              <span>{t(`subEnded_${status}`)}</span>
            </div>
          )}
          {!tab.ended && status === "stopped" && (
            <div class="notice warn">
              <IconAlert size={13} />
              <span>{t("subInterrupted")}</span>
            </div>
          )}
          {waiting.map((r) => (
            <PermissionCard key={r.requestId} r={r} />
          ))}
        </div>
      </div>
      <div class="sub-bar" aria-live="polite">
        <span class={`sub-dot ${status}`} />
        <strong>{t(`subStatus_${status}`)}</strong>
        <span class="dim">{t("subTime", { time: duration(ms) })}</span>
        <span class="dim">{t("subTools", { n: String(tools) })}</span>
        <span class="dim">{t("subTokens", { n: kTokens(tokens) })}</span>
        <div class="spacer" />
        <span class="dim sub-no-write">{t("subNoWrite")}</span>
        {status === "running" && (
          <button
            type="button"
            class="wz-btn sub-stop"
            onClick={() =>
              getLive().send({ type: "session.interrupt", sessionId: tab.childSessionId })
            }
          >
            <IconStop size={13} />
            {t("subStop")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The conversation itself (the main agent's, or the only one). */
function MainChat({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const view = sessionView(sessionId);
  const items = useComputed(() => buildItems(view.value.events));
  // Sent while the agent works (2026-11-05, as in Officina): shown at once, until the log has it.
  const [pending, setPending] = useState<{ key: string; text: string; match: string }[]>([]);
  useEffect(() => setPending([]), [sessionId]);
  useEffect(() => {
    if (pending.length === 0) return;
    const said = new Set(
      items.value.flatMap((i) => (i.kind === "user" ? [i.text.trim()] : [])).slice(-20),
    );
    const left = pending.filter((p) => !said.has(p.match.trim()));
    if (left.length !== pending.length) setPending(left);
  }, [items.value]);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const agent = agents.value.find((a) => a.id === agentId);
  const waiting = approvals.value.filter((r) => r.agentId === agentId);
  // Passages being answered (G36.22) and the «Intanto» panel (G36.24), per conversation.
  const [drafts, setDrafts] = useState<QuoteDraft[]>([]);
  const [asideOpen, setAsideOpen] = useState(false);
  useEffect(() => {
    setDrafts([]);
    setAsideOpen(false);
  }, [sessionId]);

  useEffect(() => {
    const live = getLive();
    live.send({ type: "session.follow", sessionId });
    return () => live.send({ type: "session.unfollow", sessionId });
  }, [sessionId]);

  // Follow the bottom while the user is near it.
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  });

  const v = view.value;
  const mode = agent?.mode ?? "auto";
  const own = sessionRows.value.find((r) => r.id === sessionId)?.model ?? undefined;
  const model = own ?? agent?.model ?? inheritedModel(agentId);
  return (
    <div class="chat">
      <CommandStrip sessionId={sessionId} />
      <div class="chat-body" ref={body}>
        <QuotePicker
          scroller={scroller}
          body={body}
          onPick={(q) => setDrafts((d) => addQuote(d, q))}
        />
        <div
          class="chat-scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget as HTMLDivElement;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
          }}
        >
          {items.value.length === 0 && !v.text && (
            <div class="empty">{t("startConversation", { name: agent?.name ?? "" })}</div>
          )}
          {items.value.map((item) => (
            <Item key={item.key} item={item} agentId={agentId} sessionId={sessionId} actions />
          ))}
          {v.drawing && (
            <div class="drawing">
              {v.drawing.preview ? (
                <img src={`data:image/png;base64,${v.drawing.preview}`} alt="" />
              ) : (
                <div class="drawing-frame" />
              )}
              <div class="drawing-bar">
                <span style={{ width: `${v.drawing.percent}%` }} />
              </div>
              <div class="dim">{t("drawing", { percent: String(v.drawing.percent) })}</div>
            </div>
          )}
          {v.compacting && (
            <div class="bubble assistant streaming">
              <div class="dim">{t("compacting")}</div>
            </div>
          )}
          {v.state === "running" && v.call && !v.compacting && <TurnProgress call={v.call} />}
          {(v.thinking || v.text) && (
            <div class="bubble assistant streaming">
              {/* The reasoning as it comes (2026-11-05), folded away once the answer starts. */}
              {v.thinking && !v.text && (
                <details class="thinking live" open>
                  <summary>{t("thinking")}…</summary>
                  <div class="dim">{v.thinking.slice(-4000)}</div>
                </details>
              )}
              {v.text && (
                <div
                  class="md"
                  dangerouslySetInnerHTML={{ __html: renderStreamingMarkdown(v.text) }}
                />
              )}
            </div>
          )}
          {pending.map((p) => (
            <div key={p.key} class="bubble user pending" title={t("sentWhileWorking")}>
              {p.text}
              {/* Taken back while it still waits (2026-11-05, as in Zed and Cursor). */}
              <button
                type="button"
                class="pending-x"
                title={t("unqueue")}
                aria-label={t("unqueue")}
                onClick={() => {
                  getLive().send({ type: "session.unqueue", sessionId, clientId: p.key });
                  setPending((list) => list.filter((x) => x.key !== p.key));
                }}
              >
                <IconClose size={12} />
              </button>
            </div>
          ))}
          {waiting.map((r) => (
            <PermissionCard key={r.requestId} r={r} />
          ))}
        </div>
        {!atBottom && (
          <button
            type="button"
            class="to-bottom"
            title={t("toBottom")}
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            <IconArrowDown />
          </button>
        )}
        {asideOpen && (
          <AsidePanel
            sessionId={sessionId}
            running={v.state === "running"}
            onClose={() => setAsideOpen(false)}
          />
        )}
      </div>
      <Todos items={items.value} running={v.state === "running"} />
      <Composer
        top={<QuoteDrafts drafts={drafts} onChange={setDrafts} />}
        ready={drafts.length > 0}
        lang={lang.value}
        placeholder={
          v.state === "running"
            ? t("writeWhileWorking", { name: agent?.name ?? "" })
            : t("writeTo", { name: agent?.name ?? "" })
        }
        running={v.state === "running"}
        queues
        onSend={async (text, files) => {
          // Other files land in the workspace the agent works in: its project's, or God's.
          const scope = agent?.projectId ? `project:${agent.projectId}` : "platform";
          const msg = await packMessage(text, files, (path, data) =>
            getApi().write(scope, path, data, "base64"),
          );
          const clientId = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
          const clean = drafts.map(({ key: _key, reply, ...q }) =>
            reply?.trim() ? { ...q, reply: reply.trim() } : q,
          );
          getLive().send({
            type: "session.send",
            sessionId,
            text: msg.text,
            ...(msg.images.length ? { images: msg.images } : {}),
            ...(clean.length ? { quotes: clean } : {}),
            clientId,
          });
          setDrafts([]);
          if (v.state === "running")
            setPending((p) => [
              ...p,
              { key: clientId, text: ownWords(msg.text, clean), match: msg.text },
            ]);
        }}
        onStop={() => getLive().send({ type: "session.interrupt", sessionId })}
        chips={
          agent && (
            <>
              <button
                type="button"
                class={`mode mode-${mode}`}
                title={t("modeHint")}
                onClick={() => {
                  const next =
                    MODES[(MODES.indexOf(mode as (typeof MODES)[number]) + 1) % MODES.length];
                  void attempt(() => getApi().configureAgent(agent.id, { mode: next })).then(
                    refresh,
                  );
                }}
              >
                <IconShield size={13} /> <span class="mode-name">{t(`mode_${mode}` as never)}</span>
              </button>
              <ModelMenu
                sessionId={sessionId}
                current={model}
                own={own !== undefined}
                disabled={v.state === "running"}
              />
              {items.value.some((i) => i.kind === "assistant") && (
                <button
                  type="button"
                  class={`mode${asideOpen ? " on" : ""}`}
                  title={t("asideHint")}
                  aria-pressed={asideOpen}
                  onClick={() => setAsideOpen(!asideOpen)}
                >
                  <IconAside size={13} /> <span class="mode-name">{t("asideChip")}</span>
                </button>
              )}
              {items.value.length > 2 && (
                <button
                  type="button"
                  class="mode"
                  title={t("compactNowHint")}
                  disabled={v.state === "running"}
                  onClick={() => {
                    const keep = prompt(t("compactNowAsk"));
                    if (keep === null) return;
                    getLive().send({
                      type: "session.send",
                      sessionId,
                      text: `/compact ${keep}`.trim(),
                    });
                  }}
                >
                  <IconLayers size={13} /> <span class="mode-name">{t("compactNow")}</span>
                </button>
              )}
              {agent.kind !== "demigod" && agent.kind !== "subagent" && (
                <button
                  type="button"
                  class="mode"
                  title={t("roomFromChatHint")}
                  disabled={v.state === "running"}
                  onClick={() =>
                    // This conversation becomes a group chat: its agent leads, nothing is lost.
                    void attempt(() =>
                      getApi().createRoom({ members: [], from: { agentId: agent.id, sessionId } }),
                    ).then(async (r) => {
                      if (!r) return;
                      await refreshRooms();
                      openTab({ id: `room:${r.id}`, type: "room", title: r.title, roomId: r.id });
                    })
                  }
                >
                  <IconUsers size={13} /> <span class="mode-name">{t("roomFromChat")}</span>
                </button>
              )}
            </>
          )
        }
      />
    </div>
  );
}
