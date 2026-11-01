import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import {
  IconArchive,
  IconBoard,
  IconChat,
  IconChevron,
  IconCrown,
  IconEye,
  IconPin,
  IconPlus,
  IconSettings,
  IconTree,
} from "../icons.js";
import {
  activeTab,
  agents,
  attempt,
  chatRows,
  getApi,
  newSession,
  openSession,
  openTab,
  projects,
  refresh,
  refreshConversations,
  type SessionRow,
  sessionRows,
} from "../state.js";

const SHOWN = 8;

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
};

/** One conversation: open it, pin it, archive it (the log is never touched). */
function SessionLine({ row }: { row: SessionRow }) {
  const active = activeTab.value === `chat:${row.id}`;
  const update = (change: { pinned?: boolean; archived?: boolean }) =>
    void attempt(() => getApi().updateSession(row.id, change)).then(refreshConversations);
  return (
    <div class={`session-row ${active ? "active" : ""}`}>
      <button type="button" class="open" onClick={() => openSession(row)}>
        {row.running && <span class="dot running" />}
        {row.pinned && (
          <span class="pinned">
            <IconPin size={11} filled />
          </span>
        )}
        <span class="title">{row.title ?? t("newConversation")}</span>
        <span class="date">{shortDate(row.lastAt ?? row.createdAt)}</span>
      </button>
      <span class="row-actions">
        <button
          type="button"
          class="icon-button"
          title={row.pinned ? t("unpin") : t("pin")}
          aria-pressed={row.pinned}
          onClick={() => update({ pinned: !row.pinned })}
        >
          <IconPin filled={row.pinned} />
        </button>
        <button
          type="button"
          class="icon-button"
          title={row.archived ? t("unarchive") : t("archive")}
          onClick={() => update({ archived: !row.archived })}
        >
          <IconArchive />
        </button>
      </span>
    </div>
  );
}

/** An agent's conversations: pinned first, then the latest; archived ones on request. */
function Sessions({ agent }: { agent: Agent }) {
  const [all, setAll] = useState(false);
  const [archived, setArchived] = useState(false);
  const rows = sessionRows.value
    .filter((r) => r.agentId === agent.id && r.archived === archived)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt),
    );
  const shown = all ? rows : rows.slice(0, SHOWN);
  const archivedCount = sessionRows.value.filter(
    (r) => r.agentId === agent.id && r.archived,
  ).length;
  return (
    <div class="sessions">
      <button type="button" class="new" onClick={() => void attempt(() => newSession(agent))}>
        <IconPlus /> {t("newConversation")}
      </button>
      {shown.map((r) => (
        <SessionLine key={r.id} row={r} />
      ))}
      {rows.length > SHOWN && (
        <button type="button" class="more" onClick={() => setAll(!all)}>
          {all ? t("showLess") : t("showAll", { n: String(rows.length) })}
        </button>
      )}
      {(archivedCount > 0 || archived) && (
        <button type="button" class="more" onClick={() => setArchived(!archived)}>
          {archived ? t("backToConversations") : t("archivedN", { n: String(archivedCount) })}
        </button>
      )}
    </div>
  );
}

/** The daily chat's conversations. */
function DailyChats() {
  const rows = chatRows.value.slice(0, SHOWN);
  return (
    <div class="sessions">
      <button
        type="button"
        class="new"
        onClick={() =>
          openTab({
            id: `daily:new:${Date.now()}`,
            type: "dailychat",
            title: t("newChat"),
            chatId: null,
          })
        }
      >
        <IconPlus /> {t("newChat")}
      </button>
      {rows.map((c) => (
        <div
          key={c.id}
          class={`session-row ${activeTab.value === `daily:${c.id}` ? "active" : ""}`}
        >
          <button
            type="button"
            class="open"
            onClick={() =>
              openTab({ id: `daily:${c.id}`, type: "dailychat", title: c.title, chatId: c.id })
            }
          >
            <span class="title">{c.title}</span>
            <span class="date">{shortDate(c.updatedAt)}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** A top entry (God, the daily chat): its name, unfold its conversations, start a new one. */
function Entry({
  icon,
  name,
  open,
  toggle,
  onNew,
  extra,
}: {
  icon: preact.ComponentChildren;
  name: string;
  open: boolean;
  toggle: () => void;
  onNew: () => void;
  extra?: preact.ComponentChildren;
}) {
  return (
    <div class="bar-row">
      <button type="button" class="bar-item strong" onClick={toggle} aria-expanded={open}>
        {icon}
        <span class="name">{name}</span>
      </button>
      <button
        type="button"
        class="round"
        title={open ? t("collapse") : t("expand")}
        onClick={toggle}
      >
        <IconChevron open={open} />
      </button>
      <button type="button" class="round" title={t("newConversation")} onClick={onNew}>
        <IconPlus />
      </button>
      {extra}
    </div>
  );
}

/**
 * The left bar, as in Officina: only conversations and settings. God and the daily chat on
 * top, then the projects with their orchestrator's conversations.
 */
export function Sidebar() {
  const [open, setOpen] = useState<Set<string>>(new Set(["god"]));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };
  const god = agents.value.find((a) => a.kind === "god");
  const create = async (e: Event) => {
    e.preventDefault();
    const project = await attempt(() => getApi().createProject(name.trim()));
    if (!project) return;
    // Every project gets its orchestrator under God.
    if (god)
      await attempt(() =>
        getApi().createAgent({
          kind: "orchestrator",
          parentId: god.id,
          projectId: project.id,
          name: `${project.name}`,
        }),
      );
    setName("");
    setAdding(false);
    await refresh();
    setOpen(new Set([...open, `p:${project.id}`]));
  };
  return (
    <nav class="bar">
      {god && (
        <>
          <Entry
            icon={<IconCrown />}
            name={god.name}
            open={open.has("god")}
            toggle={() => toggle("god")}
            onNew={() => void attempt(() => newSession(god))}
          />
          {open.has("god") && <Sessions agent={god} />}
        </>
      )}
      <Entry
        icon={<IconChat />}
        name={t("dailyChat")}
        open={open.has("daily")}
        toggle={() => toggle("daily")}
        onNew={() =>
          openTab({
            id: `daily:new:${Date.now()}`,
            type: "dailychat",
            title: t("newChat"),
            chatId: null,
          })
        }
        extra={
          <button
            type="button"
            class="round"
            title={t("settings")}
            onClick={() => openTab({ id: "settings", type: "settings", title: t("settings") })}
          >
            <IconSettings />
          </button>
        }
      />
      {open.has("daily") && <DailyChats />}

      <div class="bar-title">
        {t("projects")}
        <button type="button" class="add" onClick={() => setAdding(!adding)}>
          <IconPlus size={12} /> {t("newShort")}
        </button>
      </div>
      {adding && (
        <form class="new-project" onSubmit={(e) => void create(e)}>
          <input
            required
            placeholder={t("projectName")}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <div class="row">
            <button type="submit" class="primary" disabled={!name.trim()}>
              {t("create")}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      )}
      {projects.value.length === 0 && !adding && <div class="empty">{t("noProjects")}</div>}
      {projects.value.map((p) => {
        const key = `p:${p.id}`;
        const orchestrator = agents.value.find(
          (a) => a.kind === "orchestrator" && a.projectId === p.id,
        );
        const running = sessionRows.value.some((r) => r.projectId === p.id && r.running);
        return (
          <div key={p.id}>
            <div class="bar-row">
              <button
                type="button"
                class="bar-item"
                onClick={() => toggle(key)}
                aria-expanded={open.has(key)}
              >
                <IconChevron open={open.has(key)} />
                <span class="name">{p.name}</span>
                {running && <span class="dot running" />}
              </button>
              <span class="project-actions">
                <button
                  type="button"
                  class="icon-button"
                  title={t("board")}
                  onClick={() =>
                    openTab({
                      id: `board:${p.id}`,
                      type: "board",
                      title: `${t("board")} · ${p.name}`,
                      projectId: p.id,
                    })
                  }
                >
                  <IconBoard />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  title={t("inspector")}
                  onClick={() =>
                    openTab({
                      id: `inspector:${p.id}`,
                      type: "inspector",
                      title: `${t("inspector")} · ${p.name}`,
                      projectId: p.id,
                    })
                  }
                >
                  <IconEye />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  title={t("agentsOf", { project: p.name })}
                  onClick={() =>
                    openTab({
                      id: "settings",
                      type: "settings",
                      title: t("settings"),
                      section: "agents",
                    })
                  }
                >
                  <IconTree size={14} />
                </button>
              </span>
            </div>
            {open.has(key) &&
              (orchestrator ? (
                <Sessions agent={orchestrator} />
              ) : (
                <div class="sessions">
                  <span class="dim">{t("noOrchestrator")}</span>
                </div>
              ))}
          </div>
        );
      })}
    </nav>
  );
}
