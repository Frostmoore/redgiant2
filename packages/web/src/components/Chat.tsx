import { useComputed } from "@preact/signals";
import type { AssistantPart, PermissionRequestInfo } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { kTokens } from "../format.js";
import { danger, lang, t } from "../i18n.js";
import {
  IconAlert,
  IconArrowDown,
  IconCheck,
  IconClose,
  IconFile,
  IconInfo,
  IconLayers,
  IconShield,
  IconSpinner,
  IconUsers,
} from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import {
  agents,
  approvals,
  attempt,
  buildItems,
  type ChatItem,
  getApi,
  getLive,
  inheritedModel,
  openTab,
  questions,
  refresh,
  refreshRooms,
  sessionRows,
  sessionView,
} from "../state.js";
import { Composer, packMessage } from "./Composer.js";
import { Images } from "./Images.js";
import { MetricsBar } from "./MetricsBar.js";
import { ModelMenu } from "./ModelMenu.js";
import { WorkspaceImage } from "./Preview.js";
import { QuestionCard } from "./QuestionCard.js";

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
          <div class="md" key={i} dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />
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
  return (
    <div class={`tool ${state}`}>
      <button type="button" class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="mark">
          {state === "running" ? <IconSpinner /> : state === "done" ? <IconCheck /> : <IconClose />}
        </span>
        <span class="tname">{item.tool}</span>
        <span class="tsum">{summary.replace(/\s+/g, " ").slice(0, 140)}</span>
      </button>
      {open && (
        <>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre>{item.result.output}</pre>}
        </>
      )}
      {item.tool === "generate_image" && item.result?.ok && picture && (
        <WorkspaceImage scope={scopeOf(agentId)} path={picture} />
      )}
    </div>
  );
}

/** A request waiting for the human, inside the conversation it belongs to. */
export function PermissionCard({ r }: { r: PermissionRequestInfo }) {
  const [all, setAll] = useState(false);
  const input = JSON.stringify(r.input, null, 2);
  const resolve = (decision: "allow" | "deny", remember = false) =>
    getLive().send({ type: "permission.resolve", requestId: r.requestId, decision, remember });
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
        {r.danger.length === 0 && (
          <button
            type="button"
            class="always"
            title={t("alwaysHint", { tool: r.tool })}
            onClick={() => resolve("allow", true)}
          >
            {t("always")}
          </button>
        )}
        <button type="button" class="no" onClick={() => resolve("deny")}>
          {t("deny")}
        </button>
      </div>
    </div>
  );
}

/** The attachments travel inside the text; the bubble shows their names instead. */
const splitAttachments = (text: string) => {
  const cut = text.search(/\n\n<attachment name="/);
  if (cut < 0) return { text, names: [] as string[] };
  const names = [...text.slice(cut).matchAll(/<attachment name="([^"]*)"/g)].map((m) => m[1] ?? "");
  return { text: text.slice(0, cut), names };
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
}: {
  item: ChatItem;
  agentId: string;
  sessionId: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        <>
          {item.from && <div class="from">{item.from}</div>}
          <div class="bubble user">
            <Images images={item.images} />
            {splitAttachments(item.text).text}
            {splitAttachments(item.text).names.length > 0 && (
              <div class="attachments">
                {splitAttachments(item.text).names.map((n) => (
                  <span key={n} class="attachment">
                    <IconFile size={13} />
                    <span>{n}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div class="time">{time(item.ts)}</div>
        </>
      );
    case "assistant":
      return (
        <div class="bubble assistant">
          <Parts parts={item.parts} />
          <MetricsBar
            m={item.metrics}
            costUsd={item.costUsd}
            model={item.model}
            compactAt={agents.value.find((a) => a.id === agentId)?.compaction?.at ?? 0.8}
          />
        </div>
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
export function Chat({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const view = sessionView(sessionId);
  const items = useComputed(() => buildItems(view.value.events));
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const agent = agents.value.find((a) => a.id === agentId);
  const waiting = approvals.value.filter((r) => r.agentId === agentId);

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
      <div class="chat-body">
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
            <Item key={item.key} item={item} agentId={agentId} sessionId={sessionId} />
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
          {(v.thinking || v.text) && (
            <div class="bubble assistant streaming">
              {v.thinking && !v.text && <div class="dim">{t("thinking")}…</div>}
              {v.text && (
                <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.text) }} />
              )}
            </div>
          )}
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
      </div>
      <Composer
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
          getLive().send({
            type: "session.send",
            sessionId,
            text: msg.text,
            ...(msg.images.length ? { images: msg.images } : {}),
          });
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
