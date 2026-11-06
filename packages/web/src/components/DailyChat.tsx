import type { ImagePart } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatEntry, ChatSummary } from "../api.js";
import { lang, t } from "../i18n.js";
import {
  IconChat,
  IconEye,
  IconFile,
  IconSearch,
  IconSettings,
  IconTrash,
  IconUsers,
} from "../icons.js";
import { renderAnswer, renderStreamingMarkdown } from "../markdown.js";
import {
  attempt,
  closeTab,
  getApi,
  openTab,
  refreshConversations,
  refreshRooms,
} from "../state.js";
import { type Attachment, Composer } from "./Composer.js";
import { Images } from "./Images.js";
import { MetricsBar } from "./MetricsBar.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { PromptEditor } from "./PromptEditor.js";
import { joinable } from "./Room.js";
import { Pick } from "./ui.js";

/** The chat has no workspace: text files and images travel with the message, nothing else. */
const chatAttachments = (files: Attachment[]) =>
  files.flatMap((f): ({ name: string; content: string } | ImagePart)[] =>
    f.kind === "text"
      ? [{ name: f.name, content: f.content }]
      : f.kind === "image"
        ? [{ type: "image" as const, mediaType: f.mediaType, data: f.data, name: f.name }]
        : [{ name: f.name, content: `(${t("notSent")})` }],
  );

function ToolChip({ name, input }: { name: string; input: unknown }) {
  const i = (input ?? {}) as { query?: string; url?: string };
  return (
    <span class="chip muted">
      {name === "web_search" ? <IconSearch size={12} /> : <IconFile size={12} />}
      {name === "web_search" ? (i.query ?? "") : (i.url ?? name)}
    </span>
  );
}

function Entry({ e }: { e: ChatEntry }) {
  const m = e.message;
  if (m.role === "user") {
    // Tool results are for the model; the chips on the answer say what was done.
    if (e.shown === null) return null;
    return (
      <div class="bubble user">
        <Images images={m.parts.flatMap((p) => (p.type === "image" ? [p] : []))} />
        {e.shown}
      </div>
    );
  }
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const thinking = m.parts.flatMap((p) => (p.type === "thinking" ? [p.text] : [])).join("");
  const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
  return (
    <div class="bubble assistant">
      {thinking && (
        <details class="thinking">
          <summary>{t("thinking")}</summary>
          <div class="md">{thinking}</div>
        </details>
      )}
      {calls.length > 0 && (
        <div class="row wrap">
          {calls.map((c) => (
            <ToolChip key={c.callId} name={c.name} input={c.input} />
          ))}
        </div>
      )}
      {text && <div class="md" dangerouslySetInnerHTML={{ __html: renderAnswer(text) }} />}
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

/** The chat's model, chosen right in the chat: the next message uses it. */
function ChatModel() {
  const models = useModels();
  const [model, setModel] = useState<Spec | null>(null);
  useEffect(() => {
    void getApi()
      .chatSettings()
      .then(
        (s) => setModel(s.model ?? null),
        () => {},
      );
  }, []);
  if (!models || models.length === 0) return null;
  return (
    <ModelSelect
      models={models}
      value={model}
      empty={t("agentModelDefault")}
      label={t("model")}
      onChange={(m) =>
        void attempt(() => getApi().setChatSettings({ model: m })).then((r) => {
          if (r !== undefined) setModel(m);
        })
      }
    />
  );
}

/** The chat's model (kept at once) and its instructions (saved on their own, 2026-11-06). */
function Settings({ onClose }: { onClose: () => void }) {
  const models = useModels();
  const [model, setModel] = useState<Spec | null>(null);
  useEffect(() => {
    void attempt(() => getApi().chatSettings()).then((s) => {
      if (s) setModel(s.model ?? null);
    });
  }, []);
  return (
    <div class="form dc-settings">
      {models && (
        <div class="wide">
          {t("model")}
          <ModelSelect
            models={models}
            value={model}
            onChange={(m) =>
              void attempt(() => getApi().setChatSettings({ model: m })).then((r) => {
                if (r !== undefined) setModel(m);
              })
            }
            empty={t("agentModelDefault")}
          />
        </div>
      )}
      <div class="wide">
        <PromptEditor
          load={() => getApi().chatPrompt()}
          save={(text) => getApi().setChatPrompt(text)}
          label={t("chatInstructions")}
          rows={8}
        />
      </div>
      <div class="row">
        <button type="button" onClick={onClose}>
          {t("close")}
        </button>
      </div>
    </div>
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
      <Pick small on={alerts} onChange={(v) => setAlerts(v)}>
        {t("inspectorAlerts")}
      </Pick>
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
 * One conversation of the daily chat (an assistant with web search, outside the agents'
 * hierarchy and log) or, with a project, of that project's inspector (it only reads).
 */
export function DailyChat({
  chatId = null,
  projectId,
  tabId,
}: {
  chatId?: string | null;
  projectId?: string;
  tabId?: string;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [open, setOpen] = useState<string | null>(chatId);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [live, setLive] = useState<{
    text: string;
    thinking: string;
    tools: { name: string; input: unknown }[];
  } | null>(null);
  const [settings, setSettings] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  /** This chat goes on as a group (G24.14c): the chosen agent gets it as earlier context. */
  const toGroup = async (agentId: string) => {
    const transcript = entries
      .map((e) => {
        const text = e.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        return text ? `${e.message.role === "user" ? "User" : "Assistant"}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    const r = await attempt(() =>
      getApi().createRoom({ members: [agentId], ...(transcript && { context: transcript }) }),
    );
    if (!r) return;
    await refreshRooms();
    setGrouping(false);
    openTab({ id: `room:${r.id}`, type: "room", title: r.title, roomId: r.id });
  };

  const reload = () => {
    if (projectId) void attempt(() => getApi().chats(projectId)).then((l) => l && setChats(l));
    else void refreshConversations().catch(() => {});
  };
  useEffect(reload, [projectId]);
  useEffect(() => {
    if (open) void attempt(() => getApi().chat(open)).then((e) => e && setEntries(e));
    else setEntries([]);
  }, [open]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [entries, live]);

  const send = async (text: string, attachments: Attachment[]) => {
    if (live) return;
    let id = open;
    if (!id) {
      const created = await attempt(() => getApi().createChat(projectId));
      if (!created) return;
      id = created.id;
      setOpen(id);
      // A new daily chat becomes a tab of its own, named after its first message.
      if (!projectId && tabId) {
        closeTab(tabId);
        openTab({ id: `daily:${id}`, type: "dailychat", title: text.slice(0, 40), chatId: id });
      }
    }
    setLive({ text: "", thinking: "", tools: [] });
    await attempt(() =>
      getApi().sendChat(id as string, text, chatAttachments(attachments), (ev) => {
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
    <div class="chat dailychat">
      <div class="chat-head">
        {projectId && (
          <select
            value={open ?? ""}
            onChange={(e) => setOpen((e.target as HTMLSelectElement).value || null)}
            aria-label={t("conversations")}
          >
            <option value="">{t("newChat")}</option>
            {chats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title} · {new Date(c.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
        <div class="spacer" />
        {!projectId && <ChatModel />}
        {grouping ? (
          <select
            aria-label={t("roomAdd")}
            value=""
            onChange={(e) => {
              const id = (e.target as HTMLSelectElement).value;
              if (id) void toGroup(id);
            }}
            onBlur={() => setGrouping(false)}
          >
            <option value="">{t("roomPick")}</option>
            {joinable([]).map((o) => (
              <option key={o.id} value={o.id}>
                {o.group} · {o.label}
              </option>
            ))}
          </select>
        ) : (
          entries.length > 0 && (
            <button
              type="button"
              class="icon-button"
              title={t("chatToGroup")}
              onClick={() => setGrouping(true)}
            >
              <IconUsers size={15} />
            </button>
          )
        )}
        <button
          type="button"
          class="icon-button"
          title={t("settings")}
          onClick={() => setSettings(!settings)}
        >
          <IconSettings size={15} />
        </button>
        {open && (
          <button
            type="button"
            class="icon-button"
            title={t("delete")}
            onClick={() => {
              if (!confirm(t("deleteChatConfirm"))) return;
              void attempt(() => getApi().deleteChat(open)).then(() => {
                setOpen(null);
                reload();
                if (!projectId && tabId) closeTab(tabId);
              });
            }}
          >
            <IconTrash size={15} />
          </button>
        )}
      </div>
      {settings &&
        (projectId ? (
          <InspectorSettings projectId={projectId} onClose={() => setSettings(false)} />
        ) : (
          <Settings onClose={() => setSettings(false)} />
        ))}
      <div class="chat-body">
        <div class="chat-scroll">
          {!open && entries.length === 0 && !live && (
            <div class="welcome">
              {projectId ? <IconEye size={40} /> : <IconChat size={40} />}
              <p>{t(projectId ? "inspectorHint" : "chatHint")}</p>
            </div>
          )}
          {entries.map((e) => (
            <Entry key={e.id} e={e} />
          ))}
          {live && (
            <div class="bubble assistant streaming">
              {live.thinking && !live.text && <div class="dim">{t("thinking")}…</div>}
              {live.tools.length > 0 && (
                <div class="row wrap">
                  {live.tools.map((x, i) => (
                    <ToolChip key={`${x.name}-${i}`} name={x.name} input={x.input} />
                  ))}
                </div>
              )}
              {live.text ? (
                <div
                  class="md"
                  dangerouslySetInnerHTML={{ __html: renderStreamingMarkdown(live.text) }}
                />
              ) : (
                <div class="dim">…</div>
              )}
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <Composer
        lang={lang.value}
        placeholder={t(projectId ? "askInspector" : "chatPlaceholder")}
        running={live !== null}
        onSend={(text, files) => void send(text, files)}
      />
    </div>
  );
}
