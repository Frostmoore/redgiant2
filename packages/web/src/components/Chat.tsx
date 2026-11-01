import { useComputed } from "@preact/signals";
import type { AssistantPart, PermissionRequestInfo } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { lang, t } from "../i18n.js";
import {
  IconAlert,
  IconArrowDown,
  IconCheck,
  IconClose,
  IconInfo,
  IconShield,
  IconSpinner,
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
  refresh,
  sessionView,
} from "../state.js";
import { Composer, withAttachments } from "./Composer.js";
import { MetricsBar } from "./MetricsBar.js";

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
function ToolLine({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
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
        {r.danger.length > 0 && <span class="chip danger">{r.danger.join(", ")}</span>}
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

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <>
          <div class="bubble user">{item.text}</div>
          <div class="time">{time(item.ts)}</div>
        </>
      );
    case "assistant":
      return (
        <div class="bubble assistant">
          <Parts parts={item.parts} />
          <MetricsBar m={item.metrics} costUsd={item.costUsd} model={item.model} />
        </div>
      );
    case "tool":
      return <ToolLine item={item} />;
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
  const model = agent?.model ?? inheritedModel(agentId);
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
            <Item key={item.key} item={item} />
          ))}
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
        placeholder={t("writeTo", { name: agent?.name ?? "" })}
        running={v.state === "running"}
        onSend={(text, files) =>
          getLive().send({ type: "session.send", sessionId, text: withAttachments(text, files) })
        }
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
                <IconShield size={12} /> {t(`mode_${mode}` as never)}
              </button>
              {model && (
                <span class="model" title={t("modelHint")}>
                  {model.model}
                  {model.effort ? ` · ${model.effort}` : ""}
                </span>
              )}
            </>
          )
        }
      />
    </div>
  );
}

/** The model an agent inherits from its ancestors (RD13). */
function inheritedModel(agentId: string) {
  let a = agents.value.find((x) => x.id === agentId);
  while (a) {
    if (a.model) return a.model;
    a = agents.value.find((x) => x.id === a?.parentId);
  }
  return undefined;
}
