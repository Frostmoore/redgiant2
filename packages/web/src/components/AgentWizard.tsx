// A new project agent, step by step (G24.7): what it should do (ready roles, or in one's own
// words), in which project, its name, which brain, how much it may do alone. The technical form
// stays under "Advanced" in the tree. Then the last step (G36.14): God writes its instructions from
// the built-in ones and what was chosen here, and proposes its tools; the person reads, changes, creates.
import { useEffect, useState } from "preact/hooks";
import type { ModelChoice } from "../api.js";
import { t } from "../i18n.js";
import { agents, getApi, projects, refresh, subprojects } from "../state.js";
import { explain, providerName } from "./Brain.js";
import { modelName } from "./ModelMenu.js";
import {
  DraftEstimate,
  DraftInstructions,
  type DraftOutcome,
  type DraftTarget,
  godName,
} from "./PromptRefiner.js";
import { Advanced, Choice, Field } from "./ui.js";

/** Ready roles; their instructions are for the model, so in English like every prompt. */
const ROLES = {
  coder:
    "Write and change the project's code. Run its tests before saying you are done, and keep commits small and clear.",
  reviewer:
    "Review changes for bugs, risks and unclear code. Report each finding with file and line and why it matters; do not change code unless asked.",
  researcher:
    "Look things up on the web and in the project's files. Report what you find with its sources, and say what you could not confirm.",
  writer:
    "Write and keep the documentation, READMEs and texts clear, correct and up to date with the code.",
  tester:
    "Write and run tests, reproduce reported bugs and describe them with the steps to see them.",
  custom: "",
} as const;
type Role = keyof typeof ROLES;

const MODES = ["auto", "manual", "plan", "readonly"] as const;
type Mode = (typeof MODES)[number];

export function AgentWizard({ onDone }: { onDone: () => void }) {
  const [role, setRole] = useState<Role>("coder");
  const [own, setOwn] = useState("");
  const [project, setProject] = useState(projects.value[0]?.id ?? "");
  const [sub, setSub] = useState("");
  const [name, setName] = useState(t("agentRole_coder"));
  const [named, setNamed] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [mode, setMode] = useState<Mode>("auto");
  const [step, setStep] = useState<"form" | "instructions">("form");
  const [outcome, setOutcome] = useState<DraftOutcome | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void getApi()
      .models()
      .then(setModels, () => {});
  }, []);
  const pick = (r: Role) => {
    setRole(r);
    if (!named) setName(r === "custom" ? "" : t(`agentRole_${r}`));
  };
  const lead = agents.value.find((a) => a.kind === "orchestrator" && a.projectId === project);
  if (projects.value.length === 0) return <p class="notice warn">{t("agentNeedsProject")}</p>;
  const job = role === "custom" ? own.trim() : ROLES[role];
  const draft: DraftTarget = {
    kind: "agent",
    name: name.trim(),
    ...(job && { role: job }),
    ...(project && { projectId: project }),
    mode,
    ...(model && { model }),
  };
  const create = async () => {
    setError(undefined);
    const [provider, ...rest] = model.split("/");
    try {
      if (!lead) throw new Error(t("noOrchestrator"));
      const a = await getApi().createAgent({
        kind: "agent",
        parentId: lead.id,
        projectId: project,
        ...(sub && { subprojectId: sub }),
        name: name.trim(),
        role: role === "custom" ? own.trim().slice(0, 120) : t(`agentRole_${role}`),
        ...(provider && rest.length > 0 && { model: { provider, model: rest.join("/"), effort } }),
        mode,
      });
      // Its instructions as kept (placeholders for the names), and the tools it starts without.
      if (outcome?.text.trim()) await getApi().setAgentPrompt(a.id, outcome.text);
      const off = (outcome?.tools ?? []).filter((x) => !x.on);
      if (off.length > 0)
        await getApi().setAgentTools(
          a.id,
          Object.fromEntries(off.map((x) => [x.id, "off" as const])),
        );
      await refresh();
      onDone();
    } catch (err) {
      setError(explain(err));
    }
  };
  if (step === "instructions")
    return (
      <div class="ui-step agent-wizard">
        <h3>{t("draftTitle")}</h3>
        <DraftInstructions
          draft={draft}
          fallback={(base) => (job ? `${base}\n\n${job}` : base)}
          onChange={setOutcome}
        />
        <div class="row">
          <button type="button" class="primary" disabled={!outcome} onClick={() => void create()}>
            {t("agentCreate")}
          </button>
          <button type="button" onClick={() => setStep("form")}>
            {t("wzBack")}
          </button>
        </div>
        {error && <p class="notice error">{error}</p>}
      </div>
    );
  const providers = [...new Set(models.map((m) => m.provider))];
  return (
    <div class="ui-step agent-wizard">
      <h3>{t("agentStep1")}</h3>
      <Choice<Role>
        value={[role]}
        onChange={([r]) => r && pick(r)}
        options={(Object.keys(ROLES) as Role[]).map((r) => ({
          id: r,
          title: t(`agentRole_${r}`),
          description: t(`agentRoleText_${r}`),
        }))}
      />
      {role === "custom" && (
        <Field label={t("agentOwnWords")} help={t("agentOwnWordsHelp")}>
          <textarea
            rows={3}
            value={own}
            onInput={(e) => setOwn((e.target as HTMLTextAreaElement).value)}
          />
        </Field>
      )}
      <div class="form">
        <Field label={t("agentStep2")} help={t("agentStep2Help")}>
          <select
            value={project}
            onChange={(e) => {
              setProject((e.target as HTMLSelectElement).value);
              setSub("");
            }}
          >
            {projects.value.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {subprojects.value.some((s) => s.projectId === project) && (
          <Field label={t("agentWhere")} help={t("agentWhereHelp")}>
            <select value={sub} onChange={(e) => setSub((e.target as HTMLSelectElement).value)}>
              <option value="">{t("agentWholeProject")}</option>
              {subprojects.value
                .filter((s) => s.projectId === project)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.dir}/)
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label={t("agentStep3")}>
          <input
            value={name}
            onInput={(e) => {
              setNamed(true);
              setName((e.target as HTMLInputElement).value);
            }}
          />
        </Field>
        <Field label={t("agentStep4")} help={t("agentStep4Help")}>
          <select value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
            <option value="">{t("agentSameAsLead")}</option>
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
        {model && (
          <Field label={t("effort")} help={t("brainEffortHelp")}>
            <select
              value={effort}
              onChange={(e) => setEffort((e.target as HTMLSelectElement).value)}
            >
              {(["low", "medium", "high", "max"] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`effort_${x}`)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <h3>{t("agentStep5")}</h3>
      <Choice<Mode>
        value={[mode]}
        onChange={([m]) => m && setMode(m)}
        options={MODES.map((m) => ({
          id: m,
          title: t(`agentMode_${m}`),
          description: t(`agentModeText_${m}`),
          ...(m === "auto" && { badge: t("lmRecommended") }),
        }))}
      />
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={!name.trim() || (role === "custom" && !own.trim()) || !lead}
          onClick={() => {
            setOutcome(null);
            setStep("instructions");
          }}
        >
          {t("draftNext", { god: godName() })}
        </button>
        <button type="button" onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
      {name.trim() && <DraftEstimate draft={draft} />}
      {!lead && <p class="notice warn">{t("noOrchestrator")}</p>}
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}
