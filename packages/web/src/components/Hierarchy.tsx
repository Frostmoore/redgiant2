// The agents page (2026-11-03, chosen on the board "RedGiant: la pagina degli agenti"): two views
// the person switches between, a tree (an org chart: God on top, the personal agents, each
// project in its own frame) and cards grouped by where they work. Clicking an agent opens all
// its settings in a panel: docked on the right beside the tree, a drawer over the cards; on a
// phone always a drawer that slides away with the finger.
import { useRef, useState } from "preact/hooks";
import type { Agent, Budget } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { IconCheck, IconClose, IconPlus } from "../icons.js";
import { agents, attempt, budgets, getApi, openAgent, projects, refresh } from "../state.js";
import { useSwipeAway } from "../swipe.js";
import { AgentWizard } from "./AgentWizard.js";
import { LimitEditor } from "./Budgets.js";
import { CompactionSettings } from "./CompactionSettings.js";
import { modelName } from "./ModelMenu.js";
import { ModelSelect, useModels } from "./ModelSelect.js";
import { NotesEditor } from "./NotesEditor.js";

const CHILDREN: Record<Agent["kind"], Agent["kind"][]> = {
  god: ["demigod", "orchestrator", "inspector", "assistant"],
  demigod: [],
  orchestrator: ["agent"],
  agent: ["subagent"],
  subagent: [],
  inspector: [],
  assistant: [],
};
const MODES = ["auto", "manual", "plan", "readonly"] as const;
type View = "tree" | "cards";
type PanelTab = "general" | "model" | "limits" | "behaviour" | "memory";

const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("") || "?";
const canAddUnder = (a: Agent) =>
  a.status === "active" && CHILDREN[a.kind].some((k) => k !== "subagent");
const projectName = (id: string | null) =>
  (id && projects.value.find((p) => p.id === id)?.name) || id || "";

function NewAgentForm({ parent, onDone }: { parent: Agent | null; onDone: () => void }) {
  const kinds = parent
    ? CHILDREN[parent.kind].filter((k) => k !== "subagent")
    : (["god"] as Agent["kind"][]);
  const models = useModels();
  const [kind, setKind] = useState<Agent["kind"]>(kinds[0] ?? "god");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [project, setProject] = useState(parent?.projectId ?? projects.value[0]?.id ?? "");
  const [model, setModel] = useState<Agent["model"] | null>(null);
  const [mode, setMode] = useState("auto");
  const submit = async (e: Event) => {
    e.preventDefault();
    const created = await attempt(() =>
      getApi().createAgent({
        kind,
        name,
        parentId: parent?.id ?? null,
        ...(role && { role }),
        ...((kind === "orchestrator" || kind === "inspector") && { projectId: project }),
        ...(model && { model }),
        mode,
      }),
    );
    if (created) {
      await refresh();
      onDone();
    }
  };
  return (
    <form class="form" onSubmit={(e) => void submit(e)}>
      {kinds.length > 1 && (
        <label>
          {t("kind")}
          <select
            value={kind}
            onChange={(e) => setKind((e.target as HTMLSelectElement).value as Agent["kind"])}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("name")}
        <input
          required
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("agentWhatItDoes")}
        <input value={role} onInput={(e) => setRole((e.target as HTMLInputElement).value)} />
      </label>
      {(kind === "orchestrator" || kind === "inspector") && (
        <label>
          {t("projects")}
          <select
            value={project}
            onChange={(e) => setProject((e.target as HTMLSelectElement).value)}
          >
            {projects.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {models && (
        <div class="field">
          {t("model")}
          <ModelSelect
            models={models}
            value={model ?? null}
            label={t("model")}
            empty={kind === "god" ? t("agentModelDefault") : t("agentModelInherit")}
            onChange={setModel}
          />
        </div>
      )}
      <label>
        {t("mode")}
        <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)}>
          {MODES.map((x) => (
            <option key={x} value={x}>
              {t(`agentMode_${x}`)}
            </option>
          ))}
        </select>
      </label>
      <div class="row">
        <button type="submit" class="primary">
          {t("create")}
        </button>
        <button type="button" onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** Name, what it does and its instructions; for working agents, the projects it also works for. */
function GeneralTab({ agent }: { agent: Agent }) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role ?? "");
  const [prompt, setPrompt] = useState(agent.systemPrompt ?? "");
  const [saved, setSaved] = useState(false);
  const changed =
    name.trim() !== agent.name ||
    role.trim() !== (agent.role ?? "") ||
    prompt !== (agent.systemPrompt ?? "");
  const save = async () => {
    const ok = await attempt(() =>
      getApi().configureAgent(agent.id, {
        ...(name.trim() && name.trim() !== agent.name && { name: name.trim() }),
        ...(role.trim() && role.trim() !== (agent.role ?? "") && { role: role.trim() }),
        ...(prompt !== (agent.systemPrompt ?? "") && { systemPrompt: prompt }),
      }),
    );
    if (ok) {
      await refresh();
      setSaved(true);
    }
  };
  const assignable = agent.kind === "agent" || agent.kind === "assistant";
  const assign = (id: string, on: boolean) => {
    const next = new Set(agent.projects ?? []);
    if (on) next.add(id);
    else next.delete(id);
    void attempt(() => getApi().configureAgent(agent.id, { projects: [...next] })).then(refresh);
  };
  return (
    <div class="form stack">
      <label>
        {t("name")}
        <input
          value={name}
          onInput={(e) => {
            setName((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
        />
      </label>
      <label>
        {t("agentWhatItDoes")}
        <span class="ui-help">{t("agentWhatItDoesHelp")}</span>
        <textarea
          rows={3}
          value={role}
          onInput={(e) => {
            setRole((e.target as HTMLTextAreaElement).value);
            setSaved(false);
          }}
        />
      </label>
      <label>
        {t("agentInstructions")}
        <span class="ui-help">{t("agentInstructionsHelp")}</span>
        <textarea
          rows={7}
          value={prompt}
          onInput={(e) => {
            setPrompt((e.target as HTMLTextAreaElement).value);
            setSaved(false);
          }}
        />
      </label>
      <div class="row">
        <button type="button" class="primary" disabled={!changed} onClick={() => void save()}>
          {t("save")}
        </button>
        {saved && <span class="notice ok">{t("agentSaved")}</span>}
      </div>
      {assignable && projects.value.length > 0 && (
        <fieldset class="agent-projects">
          <legend>{t("asstProjects")}</legend>
          <span class="ui-help">{t("asstProjectsHelp", { name: agent.name })}</span>
          <div class="pick-grid">
            {projects.value
              .filter((p) => p.id !== agent.projectId)
              .map((p) => (
                <button
                  type="button"
                  key={p.id}
                  class={`pick-tile ${agent.projects?.includes(p.id) ? "on" : ""}`}
                  aria-pressed={agent.projects?.includes(p.id) ?? false}
                  onClick={() => assign(p.id, !agent.projects?.includes(p.id))}
                >
                  <span class="pick-mark">
                    {agent.projects?.includes(p.id) && <IconCheck size={13} />}
                  </span>
                  <span>{p.name}</span>
                </button>
              ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

function ModelTab({ agent }: { agent: Agent }) {
  const models = useModels();
  const [saved, setSaved] = useState(false);
  if (!models) return <p class="dim">{t("loading")}</p>;
  return (
    <div class="form stack">
      <p class="ui-help">{agent.kind === "god" ? t("agentModelGodHelp") : t("agentModelHelp")}</p>
      <ModelSelect
        models={models}
        value={agent.model ?? null}
        empty={agent.kind === "god" ? t("agentModelDefault") : t("agentModelInherit")}
        label={`${t("model")}: ${agent.name}`}
        onChange={(m) =>
          void attempt(() => getApi().configureAgent(agent.id, { model: m })).then(async (r) => {
            if (r === undefined) return;
            await refresh();
            setSaved(true);
          })
        }
      />
      {saved && <span class="notice ok">{t("agentModelSaved")}</span>}
    </div>
  );
}

function LimitsTab({ agent }: { agent: Agent }) {
  const row: Budget = budgets.value.find((b) => b.scope === "agent" && b.id === agent.id) ?? {
    scope: "agent",
    id: agent.id,
    limit: {},
    used: { usd: 0, tokens: 0 },
  };
  return (
    <div class="form stack">
      <p class="ui-help">{t("agentLimitHelp")}</p>
      <div class="field">
        {t("agentSpent")}
        <strong>${row.used.usd.toFixed(2)}</strong>
      </div>
      <div class="field">
        {t("limit")}
        <LimitEditor row={row} onSaved={() => void refresh()} />
      </div>
    </div>
  );
}

function BehaviourTab({ agent }: { agent: Agent }) {
  const mode = agent.mode ?? "auto";
  const set = (m: string) =>
    void attempt(() => getApi().configureAgent(agent.id, { mode: m })).then(refresh);
  return (
    <div class="form stack">
      <p class="ui-help">{t("agentModeHelp")}</p>
      <div class="agent-modes">
        {MODES.map((m) => (
          <button
            type="button"
            key={m}
            class={mode === m ? "active" : ""}
            aria-pressed={mode === m}
            onClick={() => set(m)}
          >
            <strong>{t(`agentMode_${m}`)}</strong>
            <span class="ui-help">{t(`agentModeExplain_${m}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Everything that can change in an agent, in tabs; docked beside the tree or as a drawer. */
function AgentPanel({
  agent,
  overlay,
  onClose,
}: {
  agent: Agent;
  overlay: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("general");
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useSwipeAway(ref, "right", onClose);
  const active = agent.status === "active";
  const tabs: PanelTab[] =
    agent.kind === "demigod"
      ? ["general", "model", "limits", "behaviour"]
      : ["general", "model", "limits", "behaviour", "memory"];
  return (
    <>
      <button
        type="button"
        class={`agents-veil ${overlay ? "" : "docked"}`}
        aria-label={t("close")}
        onClick={onClose}
      />
      <aside
        ref={ref}
        class={`agent-panel ${overlay ? "overlay" : ""}`}
        aria-label={t("agentSettingsOf", { name: agent.name })}
      >
        <header class="agent-panel-head">
          <span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>
          <div class="agent-panel-title">
            <strong>{agent.name}</strong>
            <span class="dim">
              {t(`kind_${agent.kind}`)}
              {agent.projectId ? ` · ${projectName(agent.projectId)}` : ""}
            </span>
          </div>
          {!active && <span class="chip muted">{t("stopped")}</span>}
          <button type="button" class="icon-button" aria-label={t("close")} onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div class="agent-panel-tabs" role="tablist">
          {tabs.map((x) => (
            <button
              type="button"
              role="tab"
              key={x}
              aria-selected={tab === x}
              class={tab === x ? "active" : ""}
              onClick={() => setTab(x)}
            >
              {t(`agentTab_${x}`)}
            </button>
          ))}
        </div>
        <div class="agent-panel-body" key={`${agent.id}-${tab}`}>
          {tab === "general" && <GeneralTab agent={agent} />}
          {tab === "model" && <ModelTab agent={agent} />}
          {tab === "limits" && <LimitsTab agent={agent} />}
          {tab === "behaviour" && <BehaviourTab agent={agent} />}
          {tab === "memory" && (
            <div class="form stack">
              {/* What the agent remembers between conversations (2026-11-05), editable here. */}
              {agent.kind !== "demigod" && agent.kind !== "inspector" && (
                <NotesEditor
                  scope="self"
                  agentId={agent.id}
                  label={t("notesOwn", { name: agent.name })}
                  help={t("notesOwnHelp")}
                />
              )}
              {agent.projectId && (
                <NotesEditor
                  scope="project"
                  agentId={agent.id}
                  projectId={agent.projectId}
                  label={t("notesProject")}
                  help={t("notesProjectHelp")}
                />
              )}
              <p class="ui-help">{t("compactExplain")}</p>
              <CompactionSettings agent={agent} />
            </div>
          )}
          {adding && (
            <div class="agent-panel-add">
              <h4>{t("agentAddUnder", { name: agent.name })}</h4>
              <NewAgentForm parent={agent} onDone={() => setAdding(false)} />
            </div>
          )}
        </div>
        {active && (
          <footer class="agent-panel-foot">
            <button type="button" onClick={() => void attempt(() => openAgent(agent))}>
              {t("agentOpenChat")}
            </button>
            {canAddUnder(agent) && !adding && (
              <button type="button" class="row" onClick={() => setAdding(true)}>
                <IconPlus size={13} /> {t("agentAddShort")}
              </button>
            )}
            <span class="spacer" />
            {agent.kind !== "god" && (
              <button
                type="button"
                class="danger"
                onClick={() => {
                  if (confirm(t("agentStopConfirm", { name: agent.name })))
                    void attempt(() => getApi().stopAgent(agent.id)).then(refresh);
                }}
              >
                {t("stop")}
              </button>
            )}
          </footer>
        )}
      </aside>
    </>
  );
}

/** One agent in the tree. */
function OrgNode({
  agent,
  selected,
  select,
  assigned,
}: {
  agent: Agent;
  selected: string | null;
  select: (a: Agent) => void;
  assigned?: boolean;
}) {
  return (
    <button
      type="button"
      class={`org-node ${agent.kind} ${agent.status} ${selected === agent.id ? "selected" : ""} ${assigned ? "assigned" : ""}`}
      aria-pressed={selected === agent.id}
      onClick={() => select(agent)}
    >
      <span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>
      <span class="org-node-text">
        <strong>{agent.name}</strong>
        <span class="dim">
          {assigned ? t("assignedChip") : agent.role || t(`kind_${agent.kind}`)}
        </span>
      </span>
    </button>
  );
}

function Subtree({
  agent,
  list,
  selected,
  select,
  add,
}: {
  agent: Agent;
  list: Agent[];
  selected: string | null;
  select: (a: Agent) => void;
  add: (a: Agent) => void;
}) {
  const kids = list.filter(
    (a) => a.parentId === agent.id && a.kind !== "orchestrator" && a.kind !== "inspector",
  );
  // Agents of other places assigned to this project hang under its orchestrator, dashed.
  const assigned =
    agent.kind === "orchestrator"
      ? list.filter(
          (a) =>
            a.projectId !== agent.projectId &&
            agent.projectId !== null &&
            a.projects?.includes(agent.projectId),
        )
      : [];
  const plus = agent.kind === "orchestrator" && agent.status === "active";
  return (
    <>
      <OrgNode agent={agent} selected={selected} select={select} />
      {(kids.length > 0 || assigned.length > 0 || plus) && (
        <ul>
          {kids.map((k) => (
            <li key={k.id}>
              <Subtree agent={k} list={list} selected={selected} select={select} add={add} />
            </li>
          ))}
          {assigned.map((k) => (
            <li key={`as-${k.id}`}>
              <OrgNode agent={k} selected={selected} select={select} assigned />
            </li>
          ))}
          {plus && (
            <li>
              <button type="button" class="org-add" onClick={() => add(agent)}>
                <IconPlus size={13} /> {t("agentAddShort")}
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  );
}

/** A project's frame in the tree: its orchestrator's team and its inspector. */
function ProjectFrame(props: {
  projectId: string;
  list: Agent[];
  selected: string | null;
  select: (a: Agent) => void;
  add: (a: Agent) => void;
  framed: boolean;
}) {
  const leads = props.list.filter(
    (a) => a.projectId === props.projectId && (a.kind === "orchestrator" || a.kind === "inspector"),
  );
  const inner = (
    <ul>
      {leads.map((a) => (
        <li key={a.id}>
          <Subtree
            agent={a}
            list={props.list}
            selected={props.selected}
            select={props.select}
            add={props.add}
          />
        </li>
      ))}
    </ul>
  );
  if (!props.framed) return inner;
  return (
    <div class="org-project">
      <span class="org-project-name">{projectName(props.projectId)}</span>
      {leads.length ? inner : <p class="dim">{t("noOrchestrator")}</p>}
    </div>
  );
}

function TreeView({
  list,
  projectId,
  selected,
  select,
  add,
}: {
  list: Agent[];
  projectId: string | null;
  selected: string | null;
  select: (a: Agent) => void;
  add: (a: Agent) => void;
}) {
  if (projectId)
    return (
      <div class="org">
        <ProjectFrame
          projectId={projectId}
          list={list}
          selected={selected}
          select={select}
          add={add}
          framed={false}
        />
      </div>
    );
  const roots = list.filter((a) => a.parentId === null);
  const projectIds = [
    ...new Set(
      list
        .filter((a) => a.kind === "orchestrator" || a.kind === "inspector")
        .map((a) => a.projectId)
        .filter((p): p is string => !!p),
    ),
  ];
  return (
    <div class="org">
      <ul>
        {roots.map((root) => (
          <li key={root.id}>
            <OrgNode agent={root} selected={selected} select={select} />
            <ul>
              {/* Demi-God and the personal agents in one column: the tree stays narrow. */}
              {(() => {
                const near = list.filter(
                  (a) =>
                    a.parentId === root.id && a.kind !== "orchestrator" && a.kind !== "inspector",
                );
                return near.length > 0 ? (
                  <li key="near">
                    <div class="org-project org-group">
                      <span class="org-project-name">{t("agentsGroupNear")}</span>
                      <div class="org-stack">
                        {near.map((a) => (
                          <OrgNode key={a.id} agent={a} selected={selected} select={select} />
                        ))}
                      </div>
                    </div>
                  </li>
                ) : null;
              })()}
              {root.kind === "god" &&
                projectIds.map((p) => (
                  <li key={`p-${p}`}>
                    <ProjectFrame
                      projectId={p}
                      list={list}
                      selected={selected}
                      select={select}
                      add={add}
                      framed
                    />
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({
  agent,
  selected,
  select,
  assigned,
}: {
  agent: Agent;
  selected: string | null;
  select: (a: Agent) => void;
  assigned?: boolean;
}) {
  return (
    <button
      type="button"
      class={`agent-tile ${agent.status} ${selected === agent.id ? "selected" : ""} ${assigned ? "assigned" : ""}`}
      onClick={() => select(agent)}
    >
      <span class="agent-tile-head">
        <span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>
        <span class="agent-tile-name">
          <strong>{agent.name}</strong>
          <span class="dim">{assigned ? t("assignedChip") : t(`kind_${agent.kind}`)}</span>
        </span>
      </span>
      {agent.role && <span class="agent-tile-role">{agent.role}</span>}
      <span class="agent-tile-chips">
        <span class="chip">{agent.model ? modelName(agent.model.model) : t("agentModelNone")}</span>
        <span class="chip">{tOptional(`agentMode_${agent.mode ?? "auto"}`) ?? agent.mode}</span>
        {agent.status === "stopped" && <span class="chip muted">{t("stopped")}</span>}
      </span>
    </button>
  );
}

function CardsView({
  list,
  projectId,
  selected,
  select,
}: {
  list: Agent[];
  projectId: string | null;
  selected: string | null;
  select: (a: Agent) => void;
}) {
  const groups: { title: string; agents: Agent[]; assigned?: Agent[] }[] = [];
  if (!projectId) {
    groups.push({
      title: t("agentsGroupLead"),
      agents: list.filter((a) => a.kind === "god" || a.kind === "demigod"),
    });
    groups.push({
      title: t("agentsGroupPersonal"),
      agents: list.filter((a) => a.kind === "assistant"),
    });
  }
  const ids = projectId
    ? [projectId]
    : [...new Set(list.map((a) => a.projectId).filter((p): p is string => !!p))];
  for (const p of ids)
    groups.push({
      title: projectName(p),
      agents: list.filter((a) => a.projectId === p && a.kind !== "assistant"),
      assigned: list.filter((a) => a.projectId !== p && a.projects?.includes(p)),
    });
  return (
    <div class="agent-groups">
      {groups
        .filter((g) => g.agents.length || g.assigned?.length)
        .map((g) => (
          <section key={g.title} class="agent-group">
            <h3>{g.title}</h3>
            <div class="agent-tiles">
              {g.agents.map((a) => (
                <Card key={a.id} agent={a} selected={selected} select={select} />
              ))}
              {g.assigned?.map((a) => (
                <Card key={`as-${a.id}`} agent={a} selected={selected} select={select} assigned />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

const savedView = (): View =>
  localStorage.getItem("rg.agentsView") === "cards" ? "cards" : "tree";

/** The agents page; with a project, only that project's agents (its page in the left bar). */
function AgentsPage({ projectId = null }: { projectId?: string | null }) {
  const [view, setView] = useState<View>(savedView);
  const [filter, setFilter] = useState<string>("");
  const [showStopped, setShowStopped] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [creatingGod, setCreatingGod] = useState(false);
  const [addUnder, setAddUnder] = useState<Agent | null>(null);
  const scope = projectId ?? (filter || null);
  const all = agents.value.filter((a) => showStopped || a.status === "active");
  const list = scope
    ? all.filter((a) => a.projectId === scope || a.projects?.includes(scope))
    : all;
  const selected = agents.value.find((a) => a.id === selectedId) ?? null;
  const pickView = (v: View) => {
    setView(v);
    localStorage.setItem("rg.agentsView", v);
  };
  const select = (a: Agent) => setSelectedId(a.id === selectedId ? null : a.id);
  const hasGod = agents.value.some((a) => a.parentId === null);
  return (
    <div class={`agents-page settings-section view-${view}`}>
      <header class="agents-head">
        <div>
          <h2>{projectId ? t("agentsOf", { project: projectName(projectId) }) : t("agents")}</h2>
          <p class="ui-purpose">{projectId ? t("projectAgentsPurpose") : t("agentsPurpose")}</p>
        </div>
        <div class="agents-tools">
          <fieldset class="choice" aria-label={t("agentsView")}>
            {(["tree", "cards"] as const).map((v) => (
              <button
                type="button"
                key={v}
                class={view === v ? "active" : ""}
                aria-pressed={view === v}
                onClick={() => pickView(v)}
              >
                {t(`agentsView_${v}`)}
              </button>
            ))}
          </fieldset>
          {!projectId && projects.value.length > 0 && (
            <select
              aria-label={t("projects")}
              value={filter}
              onChange={(e) => setFilter((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t("agentsAllProjects")}</option>
              {projects.value.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            class={`pick-tile small ${showStopped ? "on" : ""}`}
            aria-pressed={showStopped}
            onClick={() => setShowStopped(!showStopped)}
          >
            <span class="pick-mark">{showStopped && <IconCheck size={12} />}</span>
            <span>{t("agentsShowStopped")}</span>
          </button>
          {hasGod && !projectId && (
            <button type="button" class="primary row" onClick={() => setWizard(true)}>
              <IconPlus size={13} /> {t("agentNew")}
            </button>
          )}
        </div>
      </header>
      {wizard && <AgentWizard onDone={() => setWizard(false)} />}
      {!hasGod && !creatingGod && (
        <div class="empty">
          <p>{t("createGodFirst")}</p>
          <button type="button" class="primary" onClick={() => setCreatingGod(true)}>
            {t("createGod")}
          </button>
        </div>
      )}
      {creatingGod && <NewAgentForm parent={null} onDone={() => setCreatingGod(false)} />}
      {addUnder && (
        <div class="agents-add">
          <h4>{t("agentAddUnder", { name: addUnder.name })}</h4>
          <NewAgentForm parent={addUnder} onDone={() => setAddUnder(null)} />
        </div>
      )}
      <div class={`agents-layout ${view === "tree" && selected ? "with-panel" : ""}`}>
        <div class="agents-main">
          {projectId && !list.some((a) => a.kind === "orchestrator") && (
            <p class="empty">{t("noOrchestrator")}</p>
          )}
          {view === "tree" ? (
            <TreeView
              list={list}
              projectId={scope}
              selected={selectedId}
              select={select}
              add={setAddUnder}
            />
          ) : (
            <CardsView list={list} projectId={scope} selected={selectedId} select={select} />
          )}
        </div>
        {selected && (
          <AgentPanel
            key={selected.id}
            agent={selected}
            overlay={view === "cards"}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

/** Settings, Agents. */
export function Hierarchy() {
  return <AgentsPage />;
}

/** The agents of one project only: its tree, from its orchestrator (and its inspector) down. */
export function ProjectAgents({ projectId }: { projectId: string }) {
  return <AgentsPage projectId={projectId} />;
}
