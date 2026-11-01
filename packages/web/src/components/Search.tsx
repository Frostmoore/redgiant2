import { useEffect, useRef, useState } from "preact/hooks";
import type { SearchHit } from "../api.js";
import { t } from "../i18n.js";
import { IconClose, IconSearch } from "../icons.js";
import { agents, attempt, getApi, openSession, openTab, projects } from "../state.js";

/** The excerpt with the words found in it marked (escaped text, never HTML from the server). */
function Marked({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Searches every conversation: agents' sessions, daily chats, inspectors. */
export function Search({ close }: { close: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const run = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() => getApi().search(q));
    if (r) setHits(r);
  };
  const where = (h: SearchHit) => {
    const project = projects.value.find((p) => p.id === h.projectId)?.name;
    if (h.kind === "chat") return t("dailyChat");
    if (h.kind === "inspector") return `${t("inspector")} · ${project ?? ""}`;
    const agent = agents.value.find((a) => a.id === h.agentId)?.name ?? "";
    return project ? `${project} · ${agent}` : agent;
  };
  const open = (h: SearchHit) => {
    if (h.kind === "session" && h.agentId)
      openSession({ id: h.id, agentId: h.agentId, title: h.title });
    else if (h.kind === "chat")
      openTab({ id: `daily:${h.id}`, type: "dailychat", title: h.title ?? "", chatId: h.id });
    else if (h.projectId)
      openTab({
        id: `inspector:${h.projectId}`,
        type: "inspector",
        title: t("inspector"),
        projectId: h.projectId,
      });
    close();
  };
  return (
    <div class="search" role="dialog" aria-label={t("searchConversations")}>
      <form class="search-bar" onSubmit={(e) => void run(e)}>
        <input
          ref={input}
          value={q}
          placeholder={t("searchConversations")}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Escape" && close()}
        />
        <button type="submit" class="primary" disabled={q.trim().length < 2}>
          <IconSearch size={15} />
        </button>
        <button type="button" class="icon-button" title={t("close")} onClick={close}>
          <IconClose size={18} />
        </button>
      </form>
      {hits !== null && (
        <div class="search-results">
          {hits.length === 0 ? (
            <div class="empty">{t("noResults")}</div>
          ) : (
            hits.map((h, i) => (
              <button type="button" key={`${h.id}-${i}`} class="hit" onClick={() => open(h)}>
                <div class="hit-head">
                  <strong>{h.title ?? t("newConversation")}</strong>
                  <span>{where(h)}</span>
                  <span class="date">{new Date(h.at).toLocaleString()}</span>
                </div>
                <div class="excerpt">
                  <Marked text={h.excerpt} q={q.trim()} />
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
