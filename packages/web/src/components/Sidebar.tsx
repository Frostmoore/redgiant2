import { useEffect, useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { roleText, t } from "../i18n.js";
import {
  IconArchive,
  IconBoard,
  IconBox,
  IconBranch,
  IconChat,
  IconChevron,
  IconCrown,
  IconDownload,
  IconEye,
  IconFolder,
  IconPin,
  IconPlus,
  IconSettings,
  IconTree,
  IconUser,
} from "../icons.js";
import {
  activeTab,
  agents,
  attempt,
  chatAgentId,
  getApi,
  newSession,
  openSession,
  openTab,
  projects,
  refresh,
  refreshConversations,
  refreshSubprojects,
  type SessionRow,
  sessionRows,
  subprojects,
} from "../state.js";
import { assistantState } from "./Assistants.js";
import { askConfirm } from "./dialogs.js";
import { FolderMenu } from "./FolderMenu.js";

const SHOWN = 8;

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
};

/** A folder of conversations, open until the person closes it. */
function Folder({ name, children }: { name: string; children: preact.ComponentChildren }) {
  const [open, setOpen] = useState(true);
  return (
    <div class="conv-folder">
      <button type="button" class="conv-folder-head" onClick={() => setOpen(!open)}>
        <IconChevron open={open} />
        <IconFolder size={13} />
        <span>{name}</span>
      </button>
      {open && <div class="conv-folder-body">{children}</div>}
    </div>
  );
}

/** One conversation: open it, pin it, archive it (the log is never touched). */
function SessionLine({ row, folders }: { row: SessionRow; folders: string[] }) {
  const active = activeTab.value === `chat:${row.id}`;
  const origin = row.forkedFrom
    ? sessionRows.value.find((r) => r.id === row.forkedFrom)
    : undefined;
  const update = (change: { pinned?: boolean; archived?: boolean; folder?: string | null }) =>
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
      {origin && (
        // A conversation that goes on from another one (G36.23): the way back, one click.
        <button
          type="button"
          class="fork-of"
          title={t("forkBack", { title: origin.title ?? t("newConversation") })}
          onClick={() => openSession(origin)}
        >
          <IconBranch size={11} />
          <span>{t("forkOf", { title: origin.title ?? t("newConversation") })}</span>
        </button>
      )}
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
        <FolderMenu
          current={row.folder ?? null}
          folders={folders}
          onPick={(folder) => update({ folder })}
        />
        <button
          type="button"
          class="icon-button"
          title={row.archived ? t("unarchive") : t("archive")}
          onClick={() => update({ archived: !row.archived })}
        >
          <IconArchive />
        </button>
        <button
          type="button"
          class="icon-button"
          title={t("exportMd")}
          onClick={() =>
            void attempt(() => getApi().exportSession(row.id)).then((r) => {
              if (!r) return;
              const a = document.createElement("a");
              a.href = URL.createObjectURL(r.blob);
              a.download = r.name;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            })
          }
        >
          <IconDownload size={13} />
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
  const loose = rows.filter((r) => !r.folder);
  const folders = [...new Set(rows.flatMap((r) => (r.folder ? [r.folder] : [])))].sort();
  const shown = all ? loose : loose.slice(0, SHOWN);
  const archivedCount = sessionRows.value.filter(
    (r) => r.agentId === agent.id && r.archived,
  ).length;
  return (
    <div class="sessions">
      <button type="button" class="new" onClick={() => void attempt(() => newSession(agent))}>
        <IconPlus /> {t("newConversation")}
      </button>
      {folders.map((f) => (
        <Folder key={f} name={f}>
          {rows
            .filter((r) => r.folder === f)
            .map((r) => (
              <SessionLine key={r.id} row={r} folders={folders} />
            ))}
        </Folder>
      ))}
      {shown.map((r) => (
        <SessionLine key={r.id} row={r} folders={folders} />
      ))}
      {loose.length > SHOWN && (
        <button type="button" class="more" onClick={() => setAll(!all)}>
          {all ? t("showLess") : t("showAll", { n: String(loose.length) })}
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
 * The personal assistants (G24.11): each with its state (free, at work, waiting for you), its
 * conversations, and its page; "+ new" makes one step by step.
 */
function Assistants({ open, toggle }: { open: Set<string>; toggle: (key: string) => void }) {
  // The Chat's agent has its own green button: not among the personal agents.
  const list = agents.value.filter(
    (a) => a.kind === "assistant" && a.status === "active" && a.id !== chatAgentId.value,
  );
  const page = (agentId: string | null, title: string) =>
    openTab({ id: `assistant:${agentId ?? "new"}`, type: "assistant", title, agentId });
  return (
    <>
      <button type="button" class="bar-new" onClick={() => page(null, t("asstNewTitle"))}>
        <IconPlus size={13} /> {t("asstNewTitle")}
      </button>
      {list.length === 0 && (
        <button type="button" class="bar-hint" onClick={() => page(null, t("asstNewTitle"))}>
          {t("asstEmpty")}
        </button>
      )}
      {list.map((a) => {
        const key = `a:${a.id}`;
        const state = assistantState(a);
        return (
          <div key={a.id}>
            <div class="bar-row">
              <button
                type="button"
                class="bar-item"
                onClick={() => toggle(key)}
                aria-expanded={open.has(key)}
                title={roleText(a.role) ?? ""}
              >
                <IconChevron open={open.has(key)} />
                <IconUser size={14} />
                <span class="name">{a.name}</span>
                {state !== "free" && (
                  <span
                    class={`dot ${state === "working" ? "running" : "waiting"}`}
                    title={t(`asstState_${state}`)}
                  />
                )}
              </button>
              <span class="project-actions">
                <button
                  type="button"
                  class="icon-button"
                  title={t("asstPage")}
                  onClick={() => page(a.id, a.name)}
                >
                  <IconSettings size={14} />
                </button>
                <button
                  type="button"
                  class="icon-button"
                  title={t("newConversation")}
                  onClick={() => void attempt(() => newSession(a))}
                >
                  <IconPlus size={14} />
                </button>
              </span>
            </div>
            {open.has(key) && <Sessions agent={a} />}
          </div>
        );
      })}
    </>
  );
}

/**
 * A project's subprojects (G24.13), under it: each with its agents' conversations; the
 * explorer opens on its folder from them. "+ subproject" makes one, in a new or existing folder.
 */
function Subprojects({
  projectId,
  open,
  toggle,
}: {
  projectId: string;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [image, setImage] = useState("");
  /** An existing project to bring in (G24.14c); "" = a new subproject. */
  const [from, setFrom] = useState("");
  const list = subprojects.value.filter((s) => s.projectId === projectId);
  const others = projects.value.filter((p) => p.id !== projectId);
  const create = async (e: Event) => {
    e.preventDefault();
    if (from && !(await askConfirm(t("subAdoptConfirm")))) return;
    const made = await attempt(() =>
      from
        ? getApi().adoptProject(projectId, from, dir.trim() || undefined)
        : getApi().createSubproject(projectId, name.trim(), dir.trim() || undefined),
    );
    if (!made) return;
    if (image.trim())
      await attempt(() => getApi().setSubprojectImage(projectId, made.id, image.trim()));
    setName("");
    setDir("");
    setImage("");
    setFrom("");
    setAdding(false);
    await refresh();
    await refreshSubprojects();
  };
  return (
    <div class="subprojects">
      {list.map((s) => {
        const key = `s:${s.id}`;
        const team = agents.value.filter((a) => a.subprojectId === s.id && a.status === "active");
        return (
          <div key={s.id}>
            <div class="bar-row">
              <button
                type="button"
                class="bar-item sub"
                onClick={() => toggle(key)}
                aria-expanded={open.has(key)}
                title={`${s.dir}/`}
              >
                <IconChevron open={open.has(key)} />
                <IconFolder size={14} />
                <span class="name">{s.name}</span>
              </button>
            </div>
            {open.has(key) &&
              (team.length === 0 ? (
                <div class="sessions">
                  <span class="dim">{t("subNoAgents")}</span>
                </div>
              ) : (
                team.map((a) => (
                  <div key={a.id} class="sub-agent">
                    <div class="dim sub-agent-name">{a.name}</div>
                    <Sessions agent={a} />
                  </div>
                ))
              ))}
          </div>
        );
      })}
      {adding ? (
        <form class="new-project" onSubmit={(e) => void create(e)}>
          {others.length > 0 && (
            <select
              aria-label={t("subFrom")}
              value={from}
              onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t("subNewOne")}</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("subBringIn", { name: p.name })}
                </option>
              ))}
            </select>
          )}
          {!from && (
            <input
              required
              placeholder={t("subName")}
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          )}
          <input
            placeholder={t("subDir")}
            title={t("subDirHelp")}
            value={dir}
            onInput={(e) => setDir((e.target as HTMLInputElement).value)}
          />
          <input
            placeholder={t("subImage")}
            title={t("subImageHelp")}
            value={image}
            onInput={(e) => setImage((e.target as HTMLInputElement).value)}
          />
          <div class="row">
            <button type="submit" class="primary" disabled={!from && !name.trim()}>
              {t("create")}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" class="bar-hint" onClick={() => setAdding(true)}>
          <IconPlus size={11} /> {t("subNew")}
        </button>
      )}
    </div>
  );
}

/**
 * The left bar, as in Officina: only conversations and settings. God and the daily chat on
 * top, then the projects with their orchestrator's conversations.
 */
/**
 * Access from outside home not set up (2026-11-03): a notice that asks for it, with a way to
 * the settings page and a way to hide it for good.
 */
function RemoteNotice() {
  const [missing, setMissing] = useState(false);
  const [hidden, setHidden] = useState(localStorage.getItem("rg.remoteNotice") === "hidden");
  useEffect(() => {
    if (hidden) return;
    void getApi()
      .setup()
      .then(
        (s) => setMissing(!s.config.remote),
        () => {},
      );
  }, [hidden]);
  if (hidden || !missing) return null;
  return (
    <div class="bar-notice" role="note">
      <p>{t("remoteNotice")}</p>
      <div class="row">
        <button
          type="button"
          class="primary tiny"
          onClick={() =>
            openTab({ id: "settings", type: "settings", title: t("settings"), section: "remote" })
          }
        >
          {t("remoteNoticeSet")}
        </button>
        <button
          type="button"
          class="link tiny"
          onClick={() => {
            localStorage.setItem("rg.remoteNotice", "hidden");
            setHidden(true);
          }}
        >
          {t("remoteNoticeHide")}
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [open, setOpen] = useState<Set<string>>(new Set(["god"]));
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  /** Which big button is chosen: the projects or the personal agents. */
  const [section, setSectionState] = useState<"projects" | "agents">(
    localStorage.getItem("rg.barSection") === "agents" ? "agents" : "projects",
  );
  const setSection = (x: "projects" | "agents") => {
    localStorage.setItem("rg.barSection", x);
    setSectionState(x);
  };
  const toggle = (key: string) => {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpen(next);
  };
  const god = agents.value.find((a) => a.kind === "god");
  const assistants = agents.value.filter(
    (a) => a.kind === "assistant" && a.status === "active" && a.id !== chatAgentId.value,
  );
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
        <div class="bar-god">
          <Entry
            icon={<IconCrown />}
            name={god.name}
            open={open.has("god")}
            toggle={() => toggle("god")}
            onNew={() => void attempt(() => newSession(god))}
          />
          {open.has("god") && <Sessions agent={god} />}
        </div>
      )}

      <div class="bar-big">
        <button
          type="button"
          class={section === "projects" ? "on" : ""}
          aria-pressed={section === "projects"}
          onClick={() => setSection("projects")}
        >
          <IconBox size={18} />
          <span>{t("projects")}</span>
          <small>{t("barProjectsN", { n: String(projects.value.length) })}</small>
        </button>
        <button
          type="button"
          class={section === "agents" ? "on" : ""}
          aria-pressed={section === "agents"}
          onClick={() => setSection("agents")}
        >
          <IconUser size={18} />
          <span>{t("assistants")}</span>
          <small>
            {assistants.length > 0 ? assistants.map((a) => a.name).join(", ") : t("barAgentsNone")}
          </small>
        </button>
      </div>

      <div class="bar-list">
        {section === "agents" ? (
          <Assistants open={open} toggle={toggle} />
        ) : (
          <>
            <button type="button" class="bar-new" onClick={() => setAdding(!adding)}>
              <IconPlus size={13} /> {t("projectNew")}
            </button>
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
                            id: `agents:${p.id}`,
                            type: "agents",
                            title: t("agentsOf", { project: p.name }),
                            projectId: p.id,
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
                  {open.has(key) && <Subprojects projectId={p.id} open={open} toggle={toggle} />}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div class="bar-foot">
        <RemoteNotice />
        {/* The chats: a floating green button that opens every chat, as cards in folders. */}
        <button
          type="button"
          class="bar-chat"
          onClick={() => openTab({ id: "chats", type: "chats", title: t("dailyChat") })}
        >
          <IconChat size={16} /> {t("dailyChat")}
        </button>
        <button
          type="button"
          class="bar-settings"
          onClick={() => openTab({ id: "settings", type: "settings", title: t("settings") })}
        >
          <IconSettings /> {t("settings")}
        </button>
      </div>
    </nav>
  );
}
