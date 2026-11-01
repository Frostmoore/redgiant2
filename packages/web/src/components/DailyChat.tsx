import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatEntry, ChatSummary } from "../api.js";
import { t } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { attempt, getApi } from "../state.js";
import { MetricsBar } from "./MetricsBar.js";

const MAX_FILE = 200_000;

function ToolChip({ name, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as { query?: string; url?: string };
  return (
    <span class="chip muted">
      {name === "web_search" ? `🔎 ${i.query ?? ""}` : `📄 ${i.url ?? name}`}
    </span>
  );
}

function Entry({ e }: { e: ChatEntry }) {
  const m = e.message;
  if (m.role === "user") {
    // Tool results are for the model; the chips on the answer say what was done.
    if (e.shown === null) return null;
    return <div class="dc-user">{e.shown}</div>;
  }
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const thinking = m.parts.flatMap((p) => (p.type === "thinking" ? [p.text] : [])).join("");
  const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
  return (
    <div class="dc-assistant">
      {thinking && (
        <details class="thinking">
          <summary>{t("thinking")}</summary>
          <pre>{thinking}</pre>
        </details>
      )}
      {calls.length > 0 && (
        <div class="row wrap">
          {calls.map((c) => (
            <ToolChip key={c.callId} name={c.name} input={c.input} />
          ))}
        </div>
      )}
      {text && <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />}
      {e.metrics && text && (
        <MetricsBar
          m={e.metrics}
          {...(e.costUsd !== null && { costUsd: e.costUsd })}
          {...(e.model && { model: e.model })}
        />
      )}
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [prompt, setPrompt] = useState("");
  useEffect(() => {
    void attempt(() => getApi().chatSettings()).then((s) => {
      if (!s) return;
      setModel(s.model ? `${s.model.provider}/${s.model.model}` : "");
      setEffort(s.model?.effort ?? "");
      setPrompt(s.systemPrompt ?? "");
    });
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    const [provider = "", ...rest] = model.trim().split("/");
    const ok = await attempt(() =>
      getApi().setChatSettings({
        ...(provider &&
          rest.length > 0 && {
            model: { provider, model: rest.join("/"), ...(effort && { effort }) },
          }),
        ...(prompt.trim() && { systemPrompt: prompt.trim() }),
      }),
    );
    if (ok !== undefined) onClose();
  };
  return (
    <form class="form dc-settings" onSubmit={(e) => void save(e)}>
      <label>
        {t("model")}
        <input
          placeholder="anthropic/claude-sonnet-5-5"
          value={model}
          onInput={(e) => setModel((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("effort")}
        <select value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}>
          <option value="">—</option>
          {["low", "medium", "high", "max"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>
      <label class="wide">
        {t("systemPrompt")}
        <textarea
          rows={4}
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="row">
        <button type="submit" class="primary">
          {t("save")}
        </button>
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** The inspector's own settings: alerts and a daily summary on Telegram. */
function InspectorSettings({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [alerts, setAlerts] = useState(false);
  const [hour, setHour] = useState("");
  useEffect(() => {
    void attempt(() => getApi().inspectorSettings(projectId)).then((s) => {
      if (!s) return;
      setAlerts(s.alerts ?? false);
      setHour(s.summaryHour?.toString() ?? "");
    });
  }, [projectId]);
  const save = async (e: Event) => {
    e.preventDefault();
    const ok = await attempt(() =>
      getApi().setInspectorSettings(projectId, {
        alerts,
        ...(hour !== "" && { summaryHour: Number(hour) }),
      }),
    );
    if (ok !== undefined) onClose();
  };
  return (
    <form class="form dc-settings" onSubmit={(e) => void save(e)}>
      <label class="wide row">
        <input
          type="checkbox"
          checked={alerts}
          onChange={(e) => setAlerts((e.target as HTMLInputElement).checked)}
        />
        {t("inspectorAlerts")}
      </label>
      <label>
        {t("inspectorSummary")}
        <select value={hour} onChange={(e) => setHour((e.target as HTMLSelectElement).value)}>
          <option value="">—</option>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={String(h)}>
              {String(h).padStart(2, "0")}:00
            </option>
          ))}
        </select>
      </label>
      <div class="row">
        <button type="submit" class="primary">
          {t("save")}
        </button>
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * The daily chat (an assistant with web search, outside the agents' hierarchy and log) or,
 * with a project, that project's inspector (it only reads).
 */
export function DailyChat({ projectId }: { projectId?: string } = {}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [live, setLive] = useState<{
    text: string;
    thinking: string;
    tools: { name: string; input: unknown }[];
  } | null>(null);
  const [settings, setSettings] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const reload = () => void attempt(() => getApi().chats(projectId)).then((l) => l && setChats(l));
  useEffect(reload, [projectId]);
  useEffect(() => {
    if (open) void attempt(() => getApi().chat(open)).then((e) => e && setEntries(e));
    else setEntries([]);
  }, [open]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [entries, live]);

  const attach = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const picked = await Promise.all(
      [...(input.files ?? [])].map(async (f) => ({
        name: f.name,
        content: (await f.text()).slice(0, MAX_FILE),
      })),
    );
    setFiles([...files, ...picked].slice(0, 10));
    input.value = "";
  };

  const send = async () => {
    if (!text.trim() || live) return;
    let id = open;
    if (!id) {
      const created = await attempt(() => getApi().createChat(projectId));
      if (!created) return;
      id = created.id;
      setOpen(id);
    }
    const message = text;
    const attachments = files;
    setText("");
    setFiles([]);
    setLive({ text: "", thinking: "", tools: [] });
    await attempt(() =>
      getApi().sendChat(id as string, message, attachments, (ev) => {
        if (ev.type === "entry") {
          setEntries((es) => [...es, ev.entry]);
          if (ev.entry.message.role === "assistant") setLive({ text: "", thinking: "", tools: [] });
        } else if (ev.type === "delta") {
          setLive(
            (l) =>
              l &&
              (ev.kind === "text"
                ? { ...l, text: l.text + ev.text }
                : { ...l, thinking: l.thinking + ev.text }),
          );
        } else if (ev.type === "tool") {
          setLive((l) => l && { ...l, tools: [...l.tools, { name: ev.name, input: ev.input }] });
        } else if (ev.type === "error") {
          throw new Error(ev.error);
        }
      }),
    );
    setLive(null);
    reload();
  };

  return (
    <div class="board dailychat">
      <aside class="board-list">
        <div class="row">
          <button type="button" class="primary" onClick={() => setOpen(null)}>
            + {t("newChat")}
          </button>
          <div class="spacer" />
          <button
            type="button"
            class="tiny"
            title={t("settings")}
            onClick={() => setSettings(!settings)}
          >
            ⚙
          </button>
        </div>
        {chats.map((c) => (
          <button
            type="button"
            key={c.id}
            class={`thread-item${open === c.id ? " selected" : ""}`}
            onClick={() => setOpen(c.id)}
          >
            <strong>{c.title}</strong>
            <span class="dim">{new Date(c.updatedAt).toLocaleString()}</span>
          </button>
        ))}
      </aside>
      <section class="board-thread dc-thread">
        {settings &&
          (projectId ? (
            <InspectorSettings projectId={projectId} onClose={() => setSettings(false)} />
          ) : (
            <Settings onClose={() => setSettings(false)} />
          ))}
        {open && (
          <header class="row">
            <div class="spacer" />
            <button
              type="button"
              class="tiny danger"
              onClick={() => {
                if (!confirm(t("deleteChatConfirm"))) return;
                void attempt(() => getApi().deleteChat(open)).then(() => {
                  setOpen(null);
                  reload();
                });
              }}
            >
              {t("delete")}
            </button>
          </header>
        )}
        <div class="dc-messages">
          {!open && entries.length === 0 && !live && (
            <div class="empty logo-empty">{t(projectId ? "inspectorHint" : "chatHint")}</div>
          )}
          {entries.map((e) => (
            <Entry key={e.id} e={e} />
          ))}
          {live && (
            <div class="dc-assistant live">
              {live.thinking && !live.text && <div class="dim">{t("thinking")}…</div>}
              {live.tools.length > 0 && (
                <div class="row wrap">
                  {live.tools.map((x, i) => (
                    <ToolChip key={`${x.name}-${i}`} name={x.name} input={x.input} />
                  ))}
                </div>
              )}
              {live.text ? (
                <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.text) }} />
              ) : (
                <div class="dim">…</div>
              )}
            </div>
          )}
          <div ref={bottom} />
        </div>
        {files.length > 0 && (
          <div class="row wrap">
            {files.map((f) => (
              <button
                type="button"
                key={f.name}
                class="chip"
                title={t("remove")}
                onClick={() => setFiles(files.filter((x) => x !== f))}
              >
                📎 {f.name} ✕
              </button>
            ))}
          </div>
        )}
        <form
          class="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label class="tiny attach" title={t("attach")}>
            📎
            <input type="file" multiple hidden onChange={(e) => void attach(e)} />
          </label>
          <textarea
            rows={2}
            value={text}
            placeholder={t("chatPlaceholder")}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="submit" class="primary" disabled={!!live}>
            {t("send")}
          </button>
        </form>
      </section>
    </div>
  );
}
