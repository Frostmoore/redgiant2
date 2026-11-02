import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t, tOptional } from "../i18n.js";
import { agents, attempt, getApi, openAgent, projects, refresh } from "../state.js";
import { AgentWizard } from "./AgentWizard.js";

const CHILDREN: Record<Agent["kind"], Agent["kind"][]> = {
  god: ["demigod", "orchestrator", "inspector"],
  demigod: [],
  orchestrator: ["agent"],
  agent: ["subagent"],
  subagent: [],
  inspector: [],
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

function Node({ agent, depth }: { agent: Agent; depth: number }) {
  const [adding, setAdding] = useState(false);
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
        {agent.model && (
          <span class="chip">
            {agent.model.provider}/{agent.model.model}
            {agent.model.effort ? ` · ${agent.model.effort}` : ""}
          </span>
        )}
        {agent.mode && (
          <span class="chip">{tOptional(`agentMode_${agent.mode}`) ?? agent.mode}</span>
        )}
        {agent.status === "stopped" && <span class="chip muted">{t("stopped")}</span>}
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
      {children.map((c) => (
        <Node key={c.id} agent={c} depth={depth + 1} />
      ))}
    </div>
  );
}

/** The agent tree: open conversations, create agents step by step, stop agents. */
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
