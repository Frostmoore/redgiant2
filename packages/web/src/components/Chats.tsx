// Every chat (2026-11-03): opened from the green button in the left bar. The chats as cards, in
// their folders, a card to start a new one, and the group chats with several agents.
import { useEffect } from "preact/hooks";
import type { ChatSummary } from "../api.js";
import { t } from "../i18n.js";
import { IconChat, IconFolder, IconPlus, IconUsers } from "../icons.js";
import {
  attempt,
  chatRows,
  getApi,
  openTab,
  refresh,
  refreshConversations,
  rooms,
} from "../state.js";
import { FolderMenu } from "./FolderMenu.js";

const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

function ChatCard({ c, folders }: { c: ChatSummary; folders: string[] }) {
  return (
    <div class="chat-card">
      <button
        type="button"
        class="chat-card-open"
        onClick={() =>
          openTab({ id: `daily:${c.id}`, type: "dailychat", title: c.title, chatId: c.id })
        }
      >
        <IconChat size={16} />
        <strong>{c.title}</strong>
        <small>{when(c.updatedAt)}</small>
      </button>
      <FolderMenu
        current={c.folder ?? null}
        folders={folders}
        onPick={(f) =>
          void attempt(() => getApi().setChatFolder(c.id, f)).then(refreshConversations)
        }
      />
    </div>
  );
}

export function Chats() {
  useEffect(() => void refreshConversations().catch(() => {}), []);
  const all = chatRows.value;
  const folders = [...new Set(all.flatMap((c) => (c.folder ? [c.folder] : [])))].sort();
  const loose = all.filter((c) => !c.folder);
  const newChat = () =>
    openTab({
      id: `daily:new:${Date.now()}`,
      type: "dailychat",
      title: t("newChat"),
      chatId: null,
    });
  return (
    <div class="chats-page">
      <header>
        <h1>{t("dailyChat")}</h1>
        <p class="ui-help">{t("chatHint")}</p>
      </header>
      <div class="chat-grid">
        <button type="button" class="chat-card chat-card-new" onClick={newChat}>
          <IconPlus size={18} /> {t("newChat")}
        </button>
        {loose.map((c) => (
          <ChatCard key={c.id} c={c} folders={folders} />
        ))}
      </div>
      {folders.map((f) => (
        <section key={f} class="chats-folder">
          <h2>
            <IconFolder size={15} /> {f}
          </h2>
          <div class="chat-grid">
            {all
              .filter((c) => c.folder === f)
              .map((c) => (
                <ChatCard key={c.id} c={c} folders={folders} />
              ))}
          </div>
        </section>
      ))}
      <section class="chats-folder">
        <h2>
          <IconUsers size={15} /> {t("groups")}
        </h2>
        <p class="ui-help">{t("groupsEmpty")}</p>
        <div class="chat-grid">
          <button
            type="button"
            class="chat-card chat-card-new"
            onClick={() =>
              void attempt(() => getApi().createRoom({ members: [], title: t("groupNew") })).then(
                async (r) => {
                  if (!r) return;
                  await refresh();
                  openTab({ id: `room:${r.id}`, type: "room", title: r.title, roomId: r.id });
                },
              )
            }
          >
            <IconPlus size={18} /> {t("groupNew")}
          </button>
          {rooms.value.map((r) => (
            <div key={r.id} class="chat-card">
              <button
                type="button"
                class="chat-card-open"
                onClick={() =>
                  openTab({ id: `room:${r.id}`, type: "room", title: r.title, roomId: r.id })
                }
              >
                <IconUsers size={16} />
                <strong>{r.title}</strong>
                {r.answering.length > 0 && <span class="dot running" />}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
