// Archiving a whole project (2026-11-09, the person: «Non posso archiviare i progetti interi»).
// The window that says what stops before it does (never the browser's confirm), the list of the
// archived projects with «Restore», the read-only view of one, the line that takes the composer's
// place in its conversations, and the Settings page with every project.
import { useEffect, useState } from "preact/hooks";
import type { Project, ProjectTask, ProjectWork } from "../api.js";
import { t } from "../i18n.js";
import { IconArchive, IconBox, IconChat, IconFolder, IconList, IconRestore } from "../icons.js";
import {
  agents,
  archivedProjects,
  getApi,
  openSession,
  openTab,
  projects,
  refreshConversations,
  refreshProjects,
  sessionRows,
  toggleExplorer,
} from "../state.js";
import { explain } from "./Brain.js";
import { Acts, Box, Head, Row, Sub, WzPage } from "./SettingsKit.js";
import { Modal } from "./ui.js";

const day = (iso: string | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })
    : "";

/** Opens an archived project, read only, in a tab of its own. */
export function openArchived(p: Project): void {
  openTab({ id: `archived:${p.id}`, type: "archived", title: p.name, projectId: p.id });
}

/** Restores a project with one click: everything as it was (the server puts it back). */
export async function restoreProject(p: Project): Promise<string | undefined> {
  try {
    await getApi().restoreProject(p.id);
    await refreshProjects();
    await refreshConversations().catch(() => {});
    return undefined;
  } catch (err) {
    return explain(err);
  }
}

/**
 * «Archive»: first who is working and which automations will pause, then the person's yes in our
 * window. Nothing is deleted; the project moves to «Archived».
 */
export function ArchiveProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: (archived: boolean) => void;
}) {
  const [work, setWork] = useState<ProjectWork>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void getApi()
      .projectWork(project.id)
      .then(setWork, (err) => setError(explain(err)));
  }, [project.id]);
  const n = work?.working.length ?? 0;
  const autos = work?.automations ?? [];
  const archive = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().archiveProject(project.id);
      await refreshProjects();
      await refreshConversations().catch(() => {});
      onClose(true);
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("paAskTitle", { name: project.name })}
      icon={
        <span class="pa-ico">
          <IconArchive size={20} />
        </span>
      }
      onClose={() => onClose(false)}
      foot={
        <Acts>
          <button type="button" class="wz-btn" disabled={busy} onClick={() => onClose(false)}>
            {t("cancel")}
          </button>
          <button
            type="button"
            class="wz-btn primary"
            disabled={busy || !work}
            onClick={() => void archive()}
          >
            {n > 0 ? t("paStopAndArchive") : t("paArchive")}
          </button>
        </Acts>
      }
    >
      <div class="wz-panel-in pa-ask">
        <p class="wz-lead2">{t("paAskLead")}</p>
        {!work && !error && <p class="dim">{t("loading")}</p>}
        {work &&
          (n > 0 ? (
            <div class="notice warn pa-working" role="alert">
              <b>{n === 1 ? t("paWorkingOne") : t("paWorkingN", { n: String(n) })}</b>
              <ul>
                {work.working.map((w) => (
                  <li key={w.sessionId}>
                    {w.agentName}
                    {w.title ? <span class="dim"> · {w.title}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p class="pa-line">{t("paNobody")}</p>
          ))}
        {work && autos.length > 0 && (
          <p class="pa-line">
            {autos.length === 1
              ? t("paAutosOne", { names: autos.map((a) => a.name).join(", ") })
              : t("paAutosN", {
                  n: String(autos.length),
                  names: autos.map((a) => a.name).join(", "),
                })}
          </p>
        )}
        <ul class="pa-facts">
          <li>{t("paFactTasks")}</li>
          <li>{t("paFactSandbox")}</li>
          <li>{t("paFactNobody")}</li>
          <li>{t("paFactRestore")}</li>
        </ul>
        {error && <p class="notice error">{error}</p>}
      </div>
    </Modal>
  );
}

/** The archived projects, each with «Open» (read only) and «Restore». */
export function ArchivedList({ compact }: { compact?: boolean }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const list = archivedProjects.value;
  if (list.length === 0) return <p class="dim pa-empty">{t("paNoneArchived")}</p>;
  return (
    <div class={`pa-list${compact ? " compact" : ""}`}>
      {list.map((p) => (
        <div key={p.id} class="pa-item">
          <button type="button" class="pa-open" onClick={() => openArchived(p)}>
            <IconArchive size={compact ? 13 : 16} />
            <span class="pa-name">{p.name}</span>
            {!compact && <small class="dim">{t("paArchivedOn", { day: day(p.archivedAt) })}</small>}
          </button>
          <button
            type="button"
            class={compact ? "icon-button" : "wz-btn"}
            title={t("paRestore")}
            disabled={busy === p.id}
            onClick={() => {
              setBusy(p.id);
              void restoreProject(p).then((e) => {
                setError(e);
                setBusy(undefined);
              });
            }}
          >
            <IconRestore size={compact ? 14 : 16} />
            {!compact && ` ${t("paRestore")}`}
          </button>
        </div>
      ))}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}

/** Where the composer was, in a conversation of an archived project. */
export function ArchivedNotice({ projectId }: { projectId: string }) {
  const p = archivedProjects.value.find((x) => x.id === projectId);
  const [error, setError] = useState<string>();
  if (!p) return null;
  return (
    <div class="pa-notice" role="status">
      <span class="pa-badge">
        <IconArchive size={13} /> {t("paBadge")}
      </span>
      <span class="pa-notice-text">{t("paChatReadOnly", { name: p.name })}</span>
      <button
        type="button"
        class="wz-btn primary small"
        onClick={() => void restoreProject(p).then(setError)}
      >
        {t("paRestore")}
      </button>
      {error && <span class="notice error">{error}</span>}
    </div>
  );
}

const OUTCOME: Record<ProjectTask["outcome"], () => string> = {
  open: () => t("paTaskOpen"),
  verified: () => t("paTaskVerified"),
  not_testable: () => t("paTaskNotTestable"),
  abandoned: () => t("paTaskAbandoned"),
};

/** An archived project, read only: its conversations, its tasks, its files; «Restore». */
export function ArchivedProjectView({ projectId }: { projectId: string }) {
  const p = archivedProjects.value.find((x) => x.id === projectId);
  const back = projects.value.find((x) => x.id === projectId);
  const [tasks, setTasks] = useState<ProjectTask[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void getApi()
      .projectTasks(projectId)
      .then(setTasks, () => setTasks([]));
  }, [projectId]);
  if (!p)
    return (
      <WzPage>
        <Head q={back?.name ?? projectId} lead={back ? t("paBackInUse") : t("paGone")} />
      </WzPage>
    );
  const team = new Set(agents.value.filter((a) => a.projectId === projectId).map((a) => a.id));
  const rows = sessionRows.value
    .filter((r) => r.projectId === projectId || team.has(r.agentId))
    .sort((a, b) => ((a.lastAt ?? a.createdAt) < (b.lastAt ?? b.createdAt) ? 1 : -1));
  const name = (id: string) => agents.value.find((a) => a.id === id)?.name ?? id;
  return (
    <WzPage class="pa-view">
      <div class="pa-head">
        <span class="pa-badge">
          <IconArchive size={13} /> {t("paBadge")}
        </span>
        <small class="dim">{t("paArchivedOn", { day: day(p.archivedAt) })}</small>
      </div>
      <Head q={p.name} lead={t("paViewLead")} />
      <div class="pa-acts">
        <button
          type="button"
          class="wz-btn primary"
          onClick={() => void restoreProject(p).then(setError)}
        >
          <IconRestore size={16} /> {t("paRestore")}
        </button>
        <button type="button" class="wz-btn" onClick={() => toggleExplorer(true)}>
          <IconFolder size={16} /> {t("paShowFiles")}
        </button>
      </div>
      {error && <p class="notice error">{error}</p>}

      <Sub title={t("paConversations")} />
      <Box>
        {rows.length === 0 && <p class="dim">{t("paNoConversations")}</p>}
        {rows.map((r) => (
          <button key={r.id} type="button" class="pa-row" onClick={() => openSession(r)}>
            <IconChat size={15} />
            <span class="pa-row-main">
              <b>{r.title ?? t("newChat")}</b>
              <small class="dim">{name(r.agentId)}</small>
            </span>
          </button>
        ))}
      </Box>

      <Sub title={t("paTasks")} />
      <Box>
        {!tasks && <p class="dim">{t("loading")}</p>}
        {tasks?.length === 0 && <p class="dim">{t("paNoTasks")}</p>}
        {tasks?.map((x) => (
          <div key={x.id} class="pa-row static">
            <IconList size={15} />
            <span class="pa-row-main">
              <b>{x.title}</b>
              <small class="dim">{x.agentName}</small>
            </span>
            <span class={`pa-pill ${x.outcome}`}>{OUTCOME[x.outcome]()}</span>
          </div>
        ))}
      </Box>
      <p class="dim pa-files">{t("paFilesNote")}</p>
    </WzPage>
  );
}

/** Settings > Projects: archive one; the archived ones, with «Restore». */
export function ProjectsPage() {
  const [asking, setAsking] = useState<Project>();
  return (
    <WzPage
      after={
        asking && <ArchiveProjectDialog project={asking} onClose={() => setAsking(undefined)} />
      }
    >
      <Head q={t("paPageQ")} lead={t("paPageLead")} />
      <Sub title={t("paInUse")} />
      <Box>
        {projects.value.length === 0 && <p class="dim">{t("noProjects")}</p>}
        {projects.value.map((p) => (
          <Row
            key={p.id}
            title={
              <span class="pa-title">
                <IconBox size={15} /> {p.name}
              </span>
            }
            help={<code>{p.path}</code>}
          >
            <button type="button" class="wz-btn" onClick={() => setAsking(p)}>
              <IconArchive size={16} /> {t("paArchive")}
            </button>
          </Row>
        ))}
      </Box>
      <Sub title={t("paArchivedTitle")} lead={t("paArchivedLead")} />
      <Box>
        <ArchivedList />
      </Box>
    </WzPage>
  );
}
