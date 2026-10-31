import { useComputed } from "@preact/signals";
import type { AssistantPart } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { buildItems, type ChatItem, getLive, sessionView } from "../state.js";
import { MetricsBar } from "./MetricsBar.js";

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

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <div class="msg user">{item.text}</div>;
    case "assistant":
      return (
        <div class="msg assistant">
          <Parts parts={item.parts} />
          <MetricsBar m={item.metrics} costUsd={item.costUsd} model={item.model} />
        </div>
      );
    case "tool": {
      const input = JSON.stringify(item.input, null, 2);
      return (
        <details class={`tool ${item.result ? (item.result.ok ? "ok" : "fail") : "pending"}`}>
          <summary>
            <span class="tool-name">⚙ {item.tool}</span>{" "}
            <code>
              {input.length > 120
                ? `${input.replace(/\s+/g, " ").slice(0, 120)}…`
                : input.replace(/\s+/g, " ")}
            </code>
          </summary>
          <pre>{input}</pre>
          {item.result && (
            <>
              <div class="dim">{t("result")}</div>
              <pre>{item.result.output}</pre>
            </>
          )}
        </details>
      );
    }
    case "notice":
      return <div class={`notice ${item.tone}`}>{item.text}</div>;
  }
}

/** A live conversation with one agent. */
export function Chat({ sessionId }: { sessionId: string }) {
  const view = sessionView(sessionId);
  const items = useComputed(() => buildItems(view.value.events));
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const live = getLive();
    live.send({ type: "session.follow", sessionId });
    return () => live.send({ type: "session.unfollow", sessionId });
  }, [sessionId]);

  // Follow the bottom while the user is near it.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200)
      el.scrollTop = el.scrollHeight;
  });

  const v = view.value;
  const send = () => {
    const text = draft.trim();
    if (!text || v.state === "running") return;
    getLive().send({ type: "session.send", sessionId, text });
    setDraft("");
  };

  return (
    <div class="chat">
      <div class="chat-scroll" ref={scroller}>
        {items.value.map((item) => (
          <Item key={item.key} item={item} />
        ))}
        {(v.thinking || v.text) && (
          <div class="msg assistant streaming">
            {v.thinking && (
              <details class="thinking" open>
                <summary>{t("thinking")}</summary>
                <div class="md">{v.thinking}</div>
              </details>
            )}
            {v.text && (
              <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.text) }} />
            )}
          </div>
        )}
      </div>
      <div class="composer">
        <span class={`dot ${v.state}`} title={t(v.state === "running" ? "working" : "idle")} />
        <textarea
          value={draft}
          placeholder={t("messagePlaceholder")}
          rows={2}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {v.state === "running" ? (
          <button
            type="button"
            class="danger"
            onClick={() => getLive().send({ type: "session.interrupt", sessionId })}
          >
            {t("interrupt")}
          </button>
        ) : (
          <button type="button" class="primary" onClick={send} disabled={!draft.trim()}>
            {t("send")}
          </button>
        )}
      </div>
    </div>
  );
}
