import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { agents, attempt, getApi, openAgent, projects, refresh } from "../state.js";
import { AgentWizard } from "./AgentWizard.js";
import { CompactionSettings } from "./CompactionSettings.js";
import { modelName } from "./ModelMenu.js";
import { ModelSelect, useModels } from "./ModelSelect.js";

const CHILDREN: Record<Agent["kind"], Agent["kind"][]> = {
  god: ["demigod", "orchestrator", "inspector", "assistant"],
  demigod: [],
  orchestrator: ["agent"],
  agent: ["subagent"],
  subagent: [],
  inspector: [],
  assistant: [],
};

function NewAgentForm({ parent, onDone }: { parent: Agent | null; onDone: () => void }) {
  const kinds = parent
    ? CHILDREN[parent.kind].filter((k) => k !== "subagent")
    : (["god"] as Agent["kind"][]);
  const [kind, setKind] = useState<Agent["kind"]>(kinds[0] ?? "god");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [project, setProject] = useState(projects.value[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("auto");
  const submit = async (e: Event) => {
    e.preventDefault();
    const [provider, ...rest] = model.split("/");
    const created = await attempt(() =>
      getApi().createAgent({
        kind,
        name,
        parentId: parent?.id ?? null,
        ...(role && { role }),
        ...((kind === "orchestrator" || kind === "inspector") && { projectId: project }),
        ...(provider &&
          rest.length > 0 && {
            model: { provider, model: rest.join("/"), ...(effort && { effort }) },
          }),
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
      <label>
        {t("name")}
        <input
          required
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("role")}
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
      <label>
        {t("model")}
        <input
          placeholder="anthropic/claude-opus-5-5"
          value={model}
          onInput={(e) => setModel((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("effort")}
        <select value={effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}>
          <option value="">–</option>
          {(["low", "medium", "high", "max"] as const).map((x) => (
            <option key={x} value={x}>
              {t(`effort_${x}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("mode")}
        <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value)}>
          {(["auto", "manual", "plan", "readonly"] as const).map((x) => (
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

/** An agent's own model, chosen here; none: the one above it (or the default) is used. */
function AgentModel({ agent }: { agent: Agent }) {
  const models = useModels();
  const [saved, setSaved] = useState(false);
  if (!models) return null;
  return (
    <div class="agent-model">
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

/** Assigns an agent to other projects (2026-11-03): it then sits under their orchestrators. */
function AgentProjects({ agent }: { agent: Agent }) {
  const others = projects.value.filter((p) => p.id !== agent.projectId);
  const mine = new Set(agent.projects ?? []);
  const save = (next: Set<string>) =>
    void attempt(() => getApi().configureAgent(agent.id, { projects: [...next] })).then(refresh);
  if (others.length === 0) return <p class="ui-help">{t("assignNoProjects")}</p>;
  return (
    <div class="agent-projects">
      <span class="ui-help">{t("assignHelp", { name: agent.name })}</span>
      {others.map((p) => (
        <label key={p.id} class="row">
          <input
            type="checkbox"
            checked={mine.has(p.id)}
            onChange={(e) => {
              const next = new Set(mine);
              if ((e.target as HTMLInputElement).checked) next.add(p.id);
              else next.delete(p.id);
              save(next);
            }}
          />
          {p.name}
        </label>
      ))}
    </div>
  );
}

function Node({ agent, depth }: { agent: Agent; depth: number }) {
  const [adding, setAdding] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const canAssign =
    (agent.kind === "agent" || agent.kind === "assistant") && agent.status === "active";
  const children = agents.value.filter((a) => a.parentId === agent.id);
  const canAdd = CHILDREN[agent.kind].some((k) => k !== "subagent") && agent.status === "active";
  return (
    <div class="node" style={{ marginLeft: `${depth * 18}px` }}>
      <div class={`node-row ${agent.status}`}>
        <span class={`kind ${agent.kind}`}>{t(`kind_${agent.kind}`)}</span>
        <button type="button" class="link" onClick={() => void attempt(() => openAgent(agent))}>
          {agent.name}
        </button>
        {agent.role && <span class="dim">{agent.role}</span>}
        {agent.status === "active" ? (
          <button
            type="button"
            class={`chip ${agent.model ? "" : "muted"}`}
            title={t("agentModelChange")}
            onClick={() => setChoosing(!choosing)}
          >
            {agent.model ? modelName(agent.model.model) : t("agentModelNone")}
            {agent.model?.effort ? ` · ${t(`effort_${agent.model.effort}` as never)}` : ""}
          </button>
        ) : (
          agent.model && <span class="chip">{modelName(agent.model.model)}</span>
        )}
        {agent.mode && (
          <span class="chip">{tOptional(`agentMode_${agent.mode}`) ?? agent.mode}</span>
        )}
        {agent.status === "stopped" && <span class="chip muted">{t("stopped")}</span>}
        {canAssign && (
          <button
            type="button"
            class="tiny"
            title={t("assignTitle")}
            onClick={() => setAssigning(!assigning)}
          >
            {t("assignButton")}
            {(agent.projects?.length ?? 0) > 0 ? ` · ${agent.projects?.length}` : ""}
          </button>
        )}
        {agent.status === "active" && agent.kind !== "demigod" && (
          <button type="button" class="tiny" onClick={() => setTuning(!tuning)}>
            {t("compactSettings")}
          </button>
        )}
        {canAdd && (
          <button type="button" onClick={() => setAdding(!adding)}>
            +
          </button>
        )}
        {agent.status === "active" && agent.kind !== "god" && (
          <button
            type="button"
            class="danger"
            onClick={() => void attempt(() => getApi().stopAgent(agent.id)).then(refresh)}
          >
            {t("stop")}
          </button>
        )}
      </div>
      {adding && <NewAgentForm parent={agent} onDone={() => setAdding(false)} />}
      {choosing && <AgentModel agent={agent} />}
      {assigning && <AgentProjects agent={agent} />}
      {tuning && <CompactionSettings agent={agent} />}
      {children.map((c) => (
        <Node key={c.id} agent={c} depth={depth + 1} />
      ))}
    </div>
  );
}

/** The agent tree: open conversations, create agents step by step, stop agents. */
/** The agents of one project only: its tree, from its orchestrator (and its inspector) down. */
export function ProjectAgents({ projectId }: { projectId: string }) {
  const mine = agents.value.filter((a) => a.projectId === projectId);
  const ids = new Set(mine.map((a) => a.id));
  const roots = mine.filter((a) => !a.parentId || !ids.has(a.parentId));
  const name = projects.value.find((p) => p.id === projectId)?.name ?? projectId;
  // Agents of other places assigned here: under the orchestrator, who gives them tasks.
  const assigned = agents.value.filter(
    (a) => a.status === "active" && a.projectId !== projectId && a.projects?.includes(projectId),
  );
  const candidates = agents.value.filter(
    (a) =>
      a.status === "active" &&
      (a.kind === "agent" || a.kind === "assistant") &&
      a.projectId !== projectId &&
      !a.projects?.includes(projectId),
  );
  const assign = (a: Agent, on: boolean) => {
    const next = new Set(a.projects ?? []);
    if (on) next.add(projectId);
    else next.delete(projectId);
    void attempt(() => getApi().configureAgent(a.id, { projects: [...next] })).then(refresh);
  };
  const assignedBlock = (
    <AssignedUnder assigned={assigned} candidates={candidates} assign={assign} />
  );
  return (
    <div class="hierarchy settings-section">
      <h2>{t("agentsOf", { project: name })}</h2>
      <p class="ui-purpose">{t("projectAgentsPurpose")}</p>
      {roots.length === 0 && <p class="empty">{t("noOrchestrator")}</p>}
      {roots.map((a) => (
        <div key={a.id}>
          <Node agent={a} depth={0} />
          {a.kind === "orchestrator" && assignedBlock}
        </div>
      ))}
      {!roots.some((a) => a.kind === "orchestrator") && assignedBlock}
    </div>
  );
}

/** The agents assigned to a project, right under its orchestrator, and how to add one. */
function AssignedUnder({
  assigned,
  candidates,
  assign,
}: {
  assigned: Agent[];
  candidates: Agent[];
  assign: (a: Agent, on: boolean) => void;
}) {
  return (
    <div class="assigned" style={{ marginLeft: "18px" }}>
      {assigned.map((a) => (
        <div key={a.id} class="assigned-agent">
          <span class="chip">{t("assignedChip")}</span>
          <Node agent={a} depth={0} />
          <button type="button" class="link tiny" onClick={() => assign(a, false)}>
            {t("assignRemove")}
          </button>
        </div>
      ))}
      {candidates.length > 0 && (
        <select
          aria-label={t("assignHere")}
          value=""
          onChange={(e) => {
            const a = candidates.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (a) assign(a, true);
          }}
        >
          <option value="">{t("assignHere")}</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.role ? ` — ${a.role}` : ""}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function Hierarchy() {
  const [creatingGod, setCreatingGod] = useState(false);
  const [wizard, setWizard] = useState(false);
  const roots = agents.value.filter((a) => a.parentId === null);
  return (
    <div class="hierarchy">
      <p class="ui-purpose">{t("agentsPurpose")}</p>
      {wizard ? (
        <AgentWizard onDone={() => setWizard(false)} />
      ) : (
        roots.length > 0 && (
          <div>
            <button type="button" class="primary" onClick={() => setWizard(true)}>
              {t("agentNew")}
            </button>
          </div>
        )
      )}
      {roots.length === 0 && !creatingGod && (
        <div class="empty">
          <p>{t("createGodFirst")}</p>
          <button type="button" class="primary" onClick={() => setCreatingGod(true)}>
            {t("createGod")}
          </button>
        </div>
      )}
      {creatingGod && <NewAgentForm parent={null} onDone={() => setCreatingGod(false)} />}
      {roots.map((a) => (
        <Node key={a.id} agent={a} depth={0} />
      ))}
    </div>
  );
}
