// The agents page (2026-11-03, chosen on the board "RedGiant: la pagina degli agenti"): two views
// the person switches between, a tree (an org chart: God on top, the personal agents, each
// project in its own frame) and cards grouped by where they work. Clicking an agent opens all
// its settings in a centred window like every other (2026-11-07; a sheet from below on a
// phone; before, a panel docked on the right or a drawer). Drawn as the wizard since 2026-11-06
// (the person: «tutte le pagine delle impostazioni con lo stesso stile del wizard»): a big
// heading, segments, a switch, nodes and cards lit by border and background (never a check
// mark), and the forms to create an agent in the wizard's windows.
import { useState } from "preact/hooks";
import type { Agent, Budget } from "../api.js";
import { roleText, t, tOptional } from "../i18n.js";
import { IconPlus } from "../icons.js";
import {
  agents,
  attempt,
  budgets,
  getApi,
  offerPromptRewrite,
  openAgent,
  projects,
  refresh,
} from "../state.js";
import { substantialChange } from "../word-diff.js";
import { AgentMemory } from "./AgentMemory.js";
import { AgentTools } from "./AgentTools.js";
import { AgentWizard } from "./AgentWizard.js";
import { LimitEditor } from "./Budgets.js";
import { modelName } from "./ModelMenu.js";
import { ModelSelect, useModels } from "./ModelSelect.js";
import { PromptEditor } from "./PromptEditor.js";
import { Acts, Head, Seg, Switch } from "./SettingsKit.js";
import { Modal } from "./ui.js";

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
type PanelTab = "general" | "model" | "limits" | "behaviour" | "memory" | "tools";

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
    <form class="st-form" onSubmit={(e) => void submit(e)}>
      {kinds.length > 1 && (
        <label class="st-field">
          <span class="wz-lb">{t("kind")}</span>
          <select
            class="wz-field"
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
      <label class="st-field">
        <span class="wz-lb">{t("name")}</span>
        <input
          class="wz-field"
          required
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label class="st-field">
        <span class="wz-lb">{t("agentWhatItDoes")}</span>
        <input
          class="wz-field"
          value={role}
          onInput={(e) => setRole((e.target as HTMLInputElement).value)}
        />
      </label>
      {(kind === "orchestrator" || kind === "inspector") && (
        <label class="st-field">
          <span class="wz-lb">{t("projects")}</span>
          <select
            class="wz-field"
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
        <div class="st-field">
          <span class="wz-lb">{t("model")}</span>
          <ModelSelect
            models={models}
            value={model ?? null}
            label={t("model")}
            empty={kind === "god" ? t("agentModelDefault") : t("agentModelInherit")}
            onChange={setModel}
          />
        </div>
      )}
      <label class="st-field">
        <span class="wz-lb">{t("mode")}</span>
        <select
          class="wz-field"
          value={mode}
          onChange={(e) => setMode((e.target as HTMLSelectElement).value)}
        >
          {MODES.map((x) => (
            <option key={x} value={x}>
              {t(`agentMode_${x}`)}
            </option>
          ))}
        </select>
      </label>
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onDone}>
          {t("cancel")}
        </button>
        <button type="submit" class="wz-btn primary">
          {t("create")}
        </button>
      </Acts>
    </form>
  );
}

/** Name and what it does; for working agents, the projects it also works for. */
function GeneralTab({ agent }: { agent: Agent }) {
  const [name, setName] = useState(agent.name);
  // A built-in description is shown, and kept, in the interface's language.
  const shownRole = roleText(agent.role) ?? "";
  const [role, setRole] = useState(shownRole);
  const [saved, setSaved] = useState(false);
  const changed = name.trim() !== agent.name || role.trim() !== shownRole;
  const save = async () => {
    const ok = await attempt(() =>
      getApi().configureAgent(agent.id, {
        ...(name.trim() && name.trim() !== agent.name && { name: name.trim() }),
        ...(role.trim() && role.trim() !== shownRole && { role: role.trim() }),
      }),
    );
    if (ok) {
      // A new job (G36.14): offer to have God rewrite its instructions.
      if (role.trim() && substantialChange(shownRole, role.trim()))
        offerPromptRewrite(agent.id, true);
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
    <div class="st-form">
      <label class="st-field">
        <span class="wz-lb">{t("name")}</span>
        <input
          class="wz-field"
          value={name}
          onInput={(e) => {
            setName((e.target as HTMLInputElement).value);
            setSaved(false);
          }}
        />
      </label>
      <label class="st-field">
        <span class="wz-lb">{t("agentWhatItDoes")}</span>
        <span class="ui-help">{t("agentWhatItDoesHelp")}</span>
        <textarea
          class="wz-field"
          rows={3}
          value={role}
          onInput={(e) => {
            setRole((e.target as HTMLTextAreaElement).value);
            setSaved(false);
          }}
        />
      </label>
      <div class="st-save">
        {saved && <span class="st-on">{t("agentSaved")}</span>}
        <button
          type="button"
          class="wz-btn small primary"
          disabled={!changed}
          onClick={() => void save()}
        >
          {t("save")}
        </button>
      </div>
      {assignable && projects.value.length > 0 && (
        <fieldset class="st-field st-projects">
          <legend class="wz-lb">{t("asstProjects")}</legend>
          <span class="ui-help">{t("asstProjectsHelp", { name: agent.name })}</span>
          <div class="wz-chips">
            {projects.value
              .filter((p) => p.id !== agent.projectId)
              .map((p) => (
                <button
                  type="button"
                  key={p.id}
                  class={`wz-chip ${agent.projects?.includes(p.id) ? "on" : ""}`}
                  aria-pressed={agent.projects?.includes(p.id) ?? false}
                  onClick={() => assign(p.id, !agent.projects?.includes(p.id))}
                >
                  {p.name}
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
    <div class="st-form">
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
      {saved && <span class="st-on">{t("agentModelSaved")}</span>}
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
    <div class="st-form">
      <p class="ui-help">{t("agentLimitHelp")}</p>
      <div class="st-field">
        <span class="wz-lb">{t("agentSpent")}</span>
        <strong class="st-big">${row.used.usd.toFixed(2)}</strong>
      </div>
      <div class="st-field">
        <span class="wz-lb">{t("limit")}</span>
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
    <div class="st-form">
      <p class="ui-help">{t("agentModeHelp")}</p>
      <div class="wz-opt">
        {MODES.map((m) => (
          <button
            type="button"
            key={m}
            class={mode === m ? "on" : ""}
            aria-pressed={mode === m}
            onClick={() => set(m)}
          >
            <b>{t(`agentMode_${m}`)}</b>
            <small>{t(`agentModeExplain_${m}`)}</small>
          </button>
        ))}
      </div>
      {/* Its instructions, built-in or its own, always shown (2026-11-06). */}
      <PromptEditor
        key={`${agent.id}-${agent.name}-${agent.role ?? ""}`}
        load={() => getApi().agentPrompt(agent.id)}
        save={(text) => getApi().setAgentPrompt(agent.id, text)}
        target={{ agentId: agent.id }}
        help={t("agentInstructionsHelp")}
      />
    </div>
  );
}

/**
 * Everything that can change in an agent, in tabs, in a centred window like every other (2026-11-07,
 * the person: «facci una modale, e uniforma l'interfaccia col resto delle modali»); a sheet from
 * below on a phone. Its buttons stay in the window's bottom bar.
 */
function AgentPanel({
  agent,
  onClose,
  onAdd,
}: {
  agent: Agent;
  onClose: () => void;
  /** Opens the window to add an agent under this one. */
  onAdd: (a: Agent) => void;
}) {
  const [tab, setTab] = useState<PanelTab>("general");
  const active = agent.status === "active";
  const tabs: PanelTab[] =
    agent.kind === "demigod"
      ? ["general", "model", "limits", "behaviour", "tools"]
      : ["general", "model", "limits", "behaviour", "memory", "tools"];
  const foot = active ? (
    <>
      {agent.kind !== "god" && (
        <button
          type="button"
          class="wz-btn quiet st-danger"
          onClick={() => {
            if (confirm(t("agentStopConfirm", { name: agent.name })))
              void attempt(() => getApi().stopAgent(agent.id)).then(refresh);
          }}
        >
          {t("stop")}
        </button>
      )}
      <span class="spacer" />
      {canAddUnder(agent) && (
        <button type="button" class="wz-btn" onClick={() => onAdd(agent)}>
          <IconPlus size={16} /> {t("agentAddShort")}
        </button>
      )}
      <button
        type="button"
        class="wz-btn primary"
        onClick={() => void attempt(() => openAgent(agent))}
      >
        {t("agentOpenChat")}
      </button>
    </>
  ) : undefined;
  return (
    <Modal
      wide
      class="agent-panel-modal"
      title={agent.name}
      icon={<span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>}
      sub={
        <>
          {t(`kind_${agent.kind}`)}
          {agent.projectId ? ` · ${projectName(agent.projectId)}` : ""}
          {!active && <span class="chip muted">{t("stopped")}</span>}
        </>
      }
      onClose={onClose}
      foot={foot}
    >
      <div
        class="agent-panel-tabs wz-seg st-tabs"
        role="tablist"
        aria-label={t("agentSettingsOf", { name: agent.name })}
      >
        {tabs.map((x) => (
          <button
            type="button"
            role="tab"
            key={x}
            aria-selected={tab === x}
            class={tab === x ? "on" : ""}
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
        {tab === "memory" && <AgentMemory agent={agent} />}
        {tab === "tools" && <AgentTools agent={agent} />}
      </div>
    </Modal>
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
      title={roleText(agent.role)}
      onClick={() => select(agent)}
    >
      <span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>
      <span class="org-node-text">
        <strong>{agent.name}</strong>
        <span class="dim">
          {assigned ? t("assignedChip") : roleText(agent.role) || t(`kind_${agent.kind}`)}
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
      title={roleText(agent.role)}
      onClick={() => select(agent)}
    >
      <span class="agent-tile-head">
        <span class={`agent-avatar ${agent.kind}`}>{initials(agent.name)}</span>
        <span class="agent-tile-name">
          <strong>{agent.name}</strong>
          <span class="dim">{assigned ? t("assignedChip") : t(`kind_${agent.kind}`)}</span>
        </span>
      </span>
      {agent.role && <span class="agent-tile-role">{roleText(agent.role)}</span>}
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
    <div class={`agents-page settings-section wz-look st-page st-agents view-${view}`}>
      <header class="agents-head">
        {projectId ? (
          <Head
            eyebrow={t("agents")}
            q={t("agentsOf", { project: projectName(projectId) })}
            lead={t("projectAgentsPurpose")}
          />
        ) : (
          <Head eyebrow={t("agents")} q={t("stAgQ")} lead={t("agentsPurpose")} />
        )}
        <div class="agents-tools">
          <Seg
            label={t("agentsView")}
            value={view}
            onChange={pickView}
            options={(["tree", "cards"] as const).map((v) => [v, t(`agentsView_${v}`)] as const)}
          />
          {!projectId && projects.value.length > 0 && (
            <select
              class="wz-field st-filter"
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
          <span class="st-inline-switch">
            <Switch
              small
              on={showStopped}
              onChange={setShowStopped}
              label={t("agentsShowStopped")}
            />
            <span aria-hidden="true">{t("agentsShowStopped")}</span>
          </span>
          {hasGod && !projectId && (
            <button type="button" class="wz-btn small primary" onClick={() => setWizard(true)}>
              <IconPlus size={16} /> {t("agentNew")}
            </button>
          )}
        </div>
      </header>
      {/* Before the other windows: «Agent under it» opens on top of it. */}
      {selected && (
        <AgentPanel
          key={selected.id}
          agent={selected}
          onClose={() => setSelectedId(null)}
          onAdd={setAddUnder}
        />
      )}
      {wizard && (
        <Modal wide title={t("agentNew")} onClose={() => setWizard(false)}>
          <div class="wz-panel-in st-agent-wizard">
            <AgentWizard onDone={() => setWizard(false)} />
          </div>
        </Modal>
      )}
      {!hasGod && !creatingGod && (
        <div class="wz-card st-empty">
          <p class="wz-lead2">{t("createGodFirst")}</p>
          <button type="button" class="wz-btn primary" onClick={() => setCreatingGod(true)}>
            {t("createGod")}
          </button>
        </div>
      )}
      {creatingGod && (
        <Modal title={t("createGod")} onClose={() => setCreatingGod(false)}>
          <div class="wz-panel-in">
            <NewAgentForm parent={null} onDone={() => setCreatingGod(false)} />
          </div>
        </Modal>
      )}
      {addUnder && (
        <Modal
          title={t("agentAddUnder", { name: addUnder.name })}
          onClose={() => setAddUnder(null)}
        >
          <div class="wz-panel-in">
            <NewAgentForm parent={addUnder} onDone={() => setAddUnder(null)} />
          </div>
        </Modal>
      )}
      <div class="agents-layout">
        <div class="agents-main">
          {projectId && !list.some((a) => a.kind === "orchestrator") && (
            <p class="wz-center dim">{t("noOrchestrator")}</p>
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
