import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { IconPlus, IconSettings } from "../icons.js";
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

function Node({ agent, depth }: { agent: Agent; depth: number }) {
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<"model" | "settings" | null>(null);
  const children = agents.value.filter((a) => a.parentId === agent.id);
  const canAdd = CHILDREN[agent.kind].some((k) => k !== "subagent") && agent.status === "active";
  const active = agent.status === "active";
  const toggle = (p: "model" | "settings") => setPanel(panel === p ? null : p);
  return (
    <div class="node" style={{ marginLeft: `${depth * 22}px` }}>
      <div class={`agent-card ${agent.status}`}>
        <div class="agent-card-head">
          <span class={`kind ${agent.kind}`}>{t(`kind_${agent.kind}`)}</span>
          <button
            type="button"
            class="link agent-card-name"
            onClick={() => void attempt(() => openAgent(agent))}
          >
            {agent.name}
          </button>
          {agent.status === "stopped" && <span class="chip muted">{t("stopped")}</span>}
        </div>
        {agent.role && <p class="agent-card-role">{agent.role}</p>}
        {active && (
          <div class="agent-card-actions">
            <button
              type="button"
              aria-expanded={panel === "model"}
              title={t("agentModelChange")}
              onClick={() => toggle("model")}
            >
              {t("model")}:{" "}
              <strong>
                {agent.model ? modelName(agent.model.model) : t("agentModelNone")}
                {agent.model?.effort ? ` · ${t(`effort_${agent.model.effort}` as never)}` : ""}
              </strong>
            </button>
            {agent.kind !== "demigod" && (
              <button
                type="button"
                aria-expanded={panel === "settings"}
                onClick={() => toggle("settings")}
              >
                <IconSettings size={14} /> {t("agentSettings")}
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
          </div>
        )}
        {panel === "model" && <AgentModel agent={agent} />}
        {panel === "settings" && (
          <div class="agent-card-settings">
            <h4>{t("compactTitle")}</h4>
            <p class="ui-help">{t("compactExplain")}</p>
            <CompactionSettings agent={agent} />
          </div>
        )}
      </div>
      {children.map((c) => (
        <Node key={c.id} agent={c} depth={depth + 1} />
      ))}
      {canAdd &&
        (adding ? (
          <div style={{ marginLeft: "22px" }}>
            <NewAgentForm parent={agent} onDone={() => setAdding(false)} />
          </div>
        ) : (
          <button
            type="button"
            class="agent-add"
            style={{ marginLeft: "22px", width: "calc(100% - 22px)" }}
            onClick={() => setAdding(true)}
          >
            <IconPlus size={14} /> {t("agentAddUnder", { name: agent.name })}
          </button>
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
  const assign = (a: Agent, on: boolean) => {
    const next = new Set(a.projects ?? []);
    if (on) next.add(projectId);
    else next.delete(projectId);
    void attempt(() => getApi().configureAgent(a.id, { projects: [...next] })).then(refresh);
  };
  const assignedBlock = <AssignedUnder assigned={assigned} assign={assign} />;
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
  assign,
}: {
  assigned: Agent[];
  assign: (a: Agent, on: boolean) => void;
}) {
  if (assigned.length === 0) return null;
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
