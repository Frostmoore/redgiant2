// Personal assistants (G24.11), on the model of Grok Bot: each has a narrow job, the services it
// may use, its notes and its routines. God hands them work by their job; they hand work to each
// other. Created step by step from the "Agents" box in the left bar.

import type { Automation } from "@redgiant/protocol";
import { MCP_CATALOG } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Agent, McpEntry, McpStatus, ModelChoice } from "../api.js";
import { roleText, t } from "../i18n.js";
import { IconChat, IconMonitor, IconPlus } from "../icons.js";
import {
  agents,
  approvals,
  attempt,
  getApi,
  getLive,
  newSession,
  offerPromptRewrite,
  openAgent,
  openSession,
  openTab,
  projects,
  questions,
  refresh,
  sessionRows,
} from "../state.js";
import { substantialChange } from "../word-diff.js";
import { Editor, recipeWhen } from "./Automations.js";
import { explain, providerName } from "./Brain.js";
import { CompactionSettings } from "./CompactionSettings.js";
import { modelName } from "./ModelMenu.js";
import { NotesEditor } from "./NotesEditor.js";
import { PromptEditor } from "./PromptEditor.js";
import {
  DraftEstimate,
  DraftInstructions,
  type DraftOutcome,
  type DraftTarget,
} from "./PromptRefiner.js";
import { Advanced, Choice, Field, Modal, Toggle } from "./ui.js";

/** Ready jobs; the job text is the user's, in their language, so they can read and change it. */
const JOBS = ["secretary", "researcher", "social", "accounts", "tech", "custom"] as const;
type Job = (typeof JOBS)[number];

export type AssistantState = "working" | "waiting" | "free";

/** At work (a conversation running), waiting for you (an approval or a question), or free. */
export function assistantState(a: Agent): AssistantState {
  if (
    approvals.value.some((r) => r.agentId === a.id) ||
    questions.value.some((q) => q.agentId === a.id)
  )
    return "waiting";
  return sessionRows.value.some((r) => r.agentId === a.id && r.running) ? "working" : "free";
}

const serviceName = (name: string) => MCP_CATALOG.find((e) => e.id === name)?.name ?? name;

/** The services added for everyone (not for one project), and whether each works. */
function useServices(): { servers: McpEntry[]; status: McpStatus[] | undefined } {
  const [servers, setServers] = useState<McpEntry[]>([]);
  const [status, setStatus] = useState<McpStatus[]>();
  useEffect(() => {
    void getApi()
      .mcpServers()
      .then(
        (l) => setServers(l.filter((m) => m.project_id === null)),
        () => {},
      );
    void getApi()
      .mcpStatus()
      .then(setStatus, () => setStatus([]));
  }, []);
  return { servers, status };
}

/** Which services an assistant may use: a switch for each, the way to add more below. */
function Connections({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { servers, status } = useServices();
  return (
    <div class="asst-connections">
      {servers.length === 0 && <p class="dim">{t("asstNoServices")}</p>}
      {servers.map((m) => {
        const s = status?.find((x) => x.name === m.name);
        return (
          <Toggle
            key={m.name}
            label={serviceName(m.name)}
            description={
              !s
                ? t("extChecking")
                : s.state === "connected"
                  ? t("extWorks", { n: String(s.tools) })
                  : s.state === "login"
                    ? t("extNeedsLogin")
                    : t("extBroken")
            }
            checked={value.includes(m.name)}
            onChange={(on) => onChange(on ? [...value, m.name] : value.filter((x) => x !== m.name))}
          />
        );
      })}
      <button
        type="button"
        class="link"
        onClick={() =>
          openTab({ id: "settings", type: "settings", title: t("settings"), section: "extensions" })
        }
      >
        {t("asstAddService")}
      </button>
    </div>
  );
}

/** A new assistant, step by step: its job, its services, its brain, how much it does alone. */
export function AssistantWizard({ onDone }: { onDone: (a?: Agent) => void }) {
  const god = agents.value.find((a) => a.kind === "god");
  const [job, setJob] = useState<Job>("secretary");
  const [name, setName] = useState(t("asstJob_secretary"));
  const [named, setNamed] = useState(false);
  const [role, setRole] = useState(t("asstJobText_secretary"));
  const [connections, setConnections] = useState<string[]>([]);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [error, setError] = useState<string>();
  // The last step (G36.14): God writes its instructions and proposes its tools.
  const [step, setStep] = useState<"form" | "instructions">("form");
  const [outcome, setOutcome] = useState<DraftOutcome | null>(null);
  useEffect(() => {
    void getApi()
      .models()
      .then(setModels, () => {});
  }, []);
  const pick = (j: Job) => {
    setJob(j);
    setRole(j === "custom" ? "" : t(`asstJobText_${j as Exclude<Job, "custom">}`));
    if (!named) setName(j === "custom" ? "" : t(`asstJob_${j}`));
  };
  const create = async () => {
    setError(undefined);
    const [provider, ...rest] = model.split("/");
    try {
      if (!god) throw new Error(t("asstNoGod"));
      const a = await getApi().createAgent({
        kind: "assistant",
        parentId: god.id,
        name: name.trim(),
        role: role.trim(),
        connections,
        mode,
        ...(provider && rest.length > 0 && { model: { provider, model: rest.join("/") } }),
      });
      if (outcome?.text.trim()) await getApi().setAgentPrompt(a.id, outcome.text);
      const off = (outcome?.tools ?? []).filter((x) => !x.on);
      if (off.length > 0)
        await getApi().setAgentTools(
          a.id,
          Object.fromEntries(off.map((x) => [x.id, "off" as const])),
        );
      await refresh();
      onDone(a);
    } catch (err) {
      setError(explain(err));
    }
  };
  const askGod = async () => {
    if (!god) return;
    const { sessionId } = await getApi().startSession(god.id);
    getLive().send({ type: "session.send", sessionId, text: t("asstAskGodMessage") });
    openSession({ id: sessionId, agentId: god.id, title: null });
    onDone();
  };
  const providers = [...new Set(models.map((m) => m.provider))];
  const draft: DraftTarget = {
    kind: "assistant",
    name: name.trim(),
    ...(role.trim() && { role: role.trim() }),
    mode,
    ...(model && { model }),
  };
  if (step === "instructions")
    return (
      <div class="ui-step asst-wizard">
        <h2>{t("asstNewTitle")}</h2>
        <h3>{t("draftTitle")}</h3>
        <DraftInstructions draft={draft} fallback={(base) => base} onChange={setOutcome} />
        <div class="row">
          <button type="button" class="primary" disabled={!outcome} onClick={() => void create()}>
            {t("asstCreate")}
          </button>
          <button type="button" onClick={() => setStep("form")}>
            {t("wzBack")}
          </button>
        </div>
        {error && <p class="notice error">{error}</p>}
      </div>
    );
  return (
    <div class="ui-step asst-wizard">
      <h2>{t("asstNewTitle")}</h2>
      <p class="ui-purpose">{t("asstNewPurpose")}</p>
      <h3>{t("asstStep1")}</h3>
      <Choice<Job>
        value={[job]}
        onChange={([j]) => j && pick(j)}
        options={JOBS.map((j) => ({
          id: j,
          title: t(`asstJob_${j}`),
          description: t(`asstJobHint_${j}`),
        }))}
      />
      <div class="asst-fields">
        <Field label={t("asstName")}>
          <input
            value={name}
            onInput={(e) => {
              setNamed(true);
              setName((e.target as HTMLInputElement).value);
            }}
          />
        </Field>
        <Field label={t("asstRole")} help={t("asstRoleHelp")}>
          <textarea
            rows={3}
            value={role}
            onInput={(e) => setRole((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
      </div>
      <h3>{t("asstStep2")}</h3>
      <p class="ui-help">{t("asstStep2Help")}</p>
      <Connections value={connections} onChange={setConnections} />
      <h3>{t("asstStep3")}</h3>
      <Choice<"auto" | "manual">
        value={[mode]}
        onChange={([m]) => m && setMode(m)}
        options={(["auto", "manual"] as const).map((m) => ({
          id: m,
          title: t(`asstMode_${m}`),
          description: t(`asstModeText_${m}`),
          ...(m === "auto" && { badge: t("lmRecommended") }),
        }))}
      />
      <Advanced label={t("asstBrain")}>
        <Field label={t("asstBrain")} help={t("agentStep4Help")}>
          <select value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
            <option value="">{t("asstSameAsGod")}</option>
            {providers.map((p) => (
              <optgroup key={p} label={providerName(p)}>
                {models
                  .filter((m) => m.provider === p)
                  .map((m) => (
                    <option key={m.model} value={`${m.provider}/${m.model}`}>
                      {modelName(m.model)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </Field>
      </Advanced>
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={!name.trim() || !role.trim() || !god}
          onClick={() => {
            setOutcome(null);
            setStep("instructions");
          }}
        >
          {t("draftNext", { god: god?.name ?? "God" })}
        </button>
        <button type="button" onClick={() => onDone()}>
          {t("cancel")}
        </button>
      </div>
      {name.trim() && role.trim() && <DraftEstimate draft={draft} />}
      {error && <p class="notice error">{error}</p>}
      <p class="ui-help">
        {t("asstOrAskGod")}{" "}
        <button type="button" class="link" onClick={() => void attempt(askGod)}>
          {t("asstAskGod")}
        </button>
      </p>
    </div>
  );
}

/** Which skills an agent uses (G24.14c): a switch each; all on means every skill, new ones too. */
function SkillSwitches({ agent }: { agent: Agent }) {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void getApi()
      .installed()
      .then(
        (l) => setSkills(l.filter((x) => x.kind === "skill" && x.scope === "platform")),
        () => {},
      );
  }, []);
  if (skills.length === 0) return null;
  const on = (name: string) => !agent.skills || agent.skills.includes(name);
  const toggle = async (name: string, want: boolean) => {
    const current = skills.map((s) => s.name).filter(on);
    const next = want ? [...new Set([...current, name])] : current.filter((n) => n !== name);
    const all = next.length === skills.length;
    const ok = await attempt(() =>
      getApi().configureAgent(agent.id, { skills: all ? null : next }),
    );
    if (ok) {
      setSaved(true);
      await refresh();
    }
  };
  return (
    <div class="asst-connections">
      {skills.map((s) => (
        <Toggle
          key={s.name}
          label={s.name}
          description={s.description}
          checked={on(s.name)}
          onChange={(v) => void toggle(s.name, v)}
        />
      ))}
      {saved && <span class="ui-help">{t("asstSavedNewChats")}</span>}
    </div>
  );
}

/** A note file on the assistants' shared desk: read it, change it, save it. */

/** One assistant: talk to it, its job, its services, its notes, its routines. */
export function AssistantPage({ agentId }: { agentId: string | null }) {
  const [creating, setCreating] = useState(agentId === null);
  const [id, setId] = useState(agentId);
  const a = agents.value.find((x) => x.id === id);
  const [role, setRole] = useState(roleText(a?.role) ?? "");
  const [connections, setConnections] = useState<string[]>(a?.connections ?? []);
  const [routines, setRoutines] = useState<Automation[]>([]);
  const [newRoutine, setNewRoutine] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setRole(roleText(a?.role) ?? "");
    setConnections(a?.connections ?? []);
    setSaved(false);
  }, [a?.id]);
  const loadRoutines = () =>
    void getApi()
      .automations()
      .then(
        (l) => setRoutines(l.filter((r) => r.recipe.agent === a?.id || r.recipe.agent === a?.name)),
        () => {},
      );
  useEffect(loadRoutines, [a?.id]);
  if (creating)
    return (
      <div class="asst-page">
        <AssistantWizard
          onDone={(made) => {
            setCreating(false);
            if (made) setId(made.id);
          }}
        />
      </div>
    );
  if (!a) return <div class="empty">{t("asstGone")}</div>;
  const state = assistantState(a);
  const save = async () => {
    const was = roleText(a.role) ?? "";
    const ok = await attempt(() =>
      getApi().configureAgent(a.id, { role: role.trim(), connections }),
    );
    if (ok) {
      // A new job (G36.14): offer to have God rewrite its instructions.
      if (substantialChange(was, role.trim())) offerPromptRewrite(a.id, true);
      await refresh();
      setSaved(true);
    }
  };
  const changed =
    role.trim() !== (roleText(a.role) ?? "") ||
    JSON.stringify([...connections].sort()) !== JSON.stringify([...(a.connections ?? [])].sort());
  return (
    <div class="asst-page">
      <header class="row">
        <h2>{a.name}</h2>
        <span class={`chip ${state === "waiting" ? "warn" : state === "working" ? "ok" : ""}`}>
          {t(`asstState_${state}`)}
        </span>
        <div class="spacer" />
        <button type="button" class="primary" onClick={() => void attempt(() => openAgent(a))}>
          <IconChat size={14} /> {t("asstTalk")}
        </button>
        <button type="button" onClick={() => void attempt(() => newSession(a))}>
          <IconPlus size={14} /> {t("newConversation")}
        </button>
        <button
          type="button"
          title={t("screenShared")}
          onClick={() => openTab({ id: "screen", type: "screen", title: t("screenTitle") })}
        >
          <IconMonitor size={14} /> {t("screenOpen")}
        </button>
      </header>

      <h3>{t("asstJobTitle")}</h3>
      <Field label={t("asstRole")} help={t("asstRoleHelp")}>
        <textarea
          rows={3}
          value={role}
          onInput={(e) => {
            setSaved(false);
            setRole((e.target as HTMLTextAreaElement).value);
          }}
        />
      </Field>

      <h3>{t("asstServices")}</h3>
      <p class="ui-help">{t("asstServicesHelp")}</p>
      <Connections
        value={connections}
        onChange={(v) => {
          setSaved(false);
          setConnections(v);
        }}
      />
      <div class="row">
        <button type="button" class="primary" disabled={!changed} onClick={() => void save()}>
          {t("save")}
        </button>
        {saved && !changed && <span class="ui-help">{t("asstSavedNewChats")}</span>}
      </div>

      <h3>{t("asstInstructions")}</h3>
      <PromptEditor
        key={`${a.id}-${a.name}-${a.role ?? ""}`}
        load={() => getApi().agentPrompt(a.id)}
        save={(text) => getApi().setAgentPrompt(a.id, text)}
        target={{ agentId: a.id }}
        label={t("agentInstructions")}
        help={t("agentInstructionsHelp")}
      />

      <h3>{t("asstRoutines")}</h3>
      <p class="ui-help">{t("asstRoutinesHelp")}</p>
      {routines.map((r) => (
        <div key={r.id} class="node-row">
          <strong>{r.recipe.description || r.name}</strong>
          <span class="dim">{recipeWhen(r)}</span>
          <span class={`chip ${r.enabled ? "ok" : ""}`}>
            {r.enabled ? t("enabled") : t("disabled")}
          </span>
        </div>
      ))}
      <button type="button" onClick={() => setNewRoutine(true)}>
        <IconPlus size={14} /> {t("asstNewRoutine")}
      </button>
      {/* The same window as Settings, Automations (drawn as the wizard), with this assistant
          already chosen as who does it. */}
      {newRoutine && (
        <div class="wz-look">
          <Modal wide title={t("asstNewRoutine")} onClose={() => setNewRoutine(false)}>
            <Editor
              current={undefined}
              who={`p:${a.id}`}
              onCancel={() => setNewRoutine(false)}
              onSaved={() => {
                setNewRoutine(false);
                loadRoutines();
              }}
            />
          </Modal>
        </div>
      )}

      <h3>{t("asstProjects")}</h3>
      <p class="ui-help">{t("asstProjectsHelp", { name: a.name })}</p>
      {projects.value.length === 0 ? (
        <p class="ui-help">{t("assignNoProjects")}</p>
      ) : (
        <Choice<string>
          multiple
          value={a.projects ?? []}
          onChange={(next) =>
            void attempt(() => getApi().configureAgent(a.id, { projects: next })).then(refresh)
          }
          options={projects.value.map((p) => ({
            id: p.id,
            title: p.name,
            description: t("asstProjectCard"),
          }))}
        />
      )}

      <h3>{t("asstMemory")}</h3>
      <NotesEditor
        scope="self"
        agentId={a.id}
        label={t("asstOwnNotes", { name: a.name })}
        help={t("asstOwnNotesHelp")}
      />
      <NotesEditor scope="user" label={t("asstShared")} help={t("asstSharedHelp")} />

      <h3>{t("asstSkills")}</h3>
      <p class="ui-help">{t("asstSkillsHelp")}</p>
      <SkillSwitches agent={a} />

      <Advanced>
        <h3>{t("compactTitle")}</h3>
        <p class="ui-help">{t("compactExplain")}</p>
        <CompactionSettings agent={a} />
        <button
          type="button"
          class="danger"
          onClick={() => {
            if (!confirm(t("asstStopConfirm", { name: a.name }))) return;
            void attempt(() => getApi().stopAgent(a.id)).then(refresh);
          }}
        >
          {t("asstStop")}
        </button>
      </Advanced>
    </div>
  );
}
