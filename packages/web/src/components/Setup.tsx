import { useEffect, useState } from "preact/hooks";
import type { Agent, SetupState } from "../api.js";
import { lang, setLang, t } from "../i18n.js";
import { attempt, getApi, refresh } from "../state.js";
import { Brain, explain } from "./Brain.js";
import { GitCode } from "./GitCode.js";
import { hardwareText, LocalModels } from "./LocalModels.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { RemoteAccess } from "./RemoteAccess.js";
import { Safety } from "./Safety.js";
import { TelegramLink } from "./TelegramLink.js";
import { Choice, Step } from "./ui.js";

/** The wizard's steps; the advanced installation adds where the code lives (G24.5). */
type StepKey =
  | "wzWelcome"
  | "wzMode"
  | "wzBrain"
  | "wzLocal"
  | "wzNames"
  | "wzAssign"
  | "wzTelegram"
  | "wzCode"
  | "wzRemote"
  | "wzSafety"
  | "wzDone";
const stepsFor = (s: SetupState): StepKey[] => [
  "wzWelcome",
  "wzMode",
  "wzBrain",
  "wzLocal",
  "wzNames",
  "wzAssign",
  "wzTelegram",
  ...(s.config.mode === "advanced" ? (["wzCode", "wzRemote"] as const) : []),
  "wzSafety",
  "wzDone",
];

const gb = (n: number) => `${n.toFixed(1)} GB`;

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as children.
    <label>
      {label}
      {children}
    </label>
  );
}

/** "How should RedGiant think?": a subscription, a key or a local model; more any time later. */
function BrainStep({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  return (
    <Step title={t("wzBrain")} purpose={t("brainPurpose")}>
      <p class="notice">{t("wzBrainMore")}</p>
      <Brain s={s} reload={reload} wizard />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

/** The strongest model connected, as a first suggestion: Opus when Claude is there. */
const suggested = (models: { provider: string; model: string; effort: boolean }[]): Spec | null => {
  const order = ["claude-subscription", "anthropic", "chatgpt-subscription", "openai"];
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : order.length);
  const sorted = [...models].sort((a, b) => rank(a.provider) - rank(b.provider));
  const first = sorted[0];
  if (!first) return null;
  const best = sorted.find((m) => m.provider === first.provider && /opus/i.test(m.model)) ?? first;
  return { provider: best.provider, model: best.model, ...(best.effort && { effort: "medium" }) };
};

/**
 * "Who uses which model": God, Demi-God (who answers on Telegram), the chat, and the agents made
 * later. Each can be changed later: Settings, Agents (and the chat's own settings).
 */
function AssignStep({ s, next }: { s: SetupState; next: () => void }) {
  const models = useModels();
  const [who, setWho] = useState<{ god?: Agent; demigod?: Agent }>();
  const [god, setGod] = useState<Spec | null>(null);
  const [demigod, setDemigod] = useState<Spec | null>(null);
  const [chat, setChat] = useState<Spec | null>(null);
  const [others, setOthers] = useState<Spec | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!models) return;
    void Promise.all([getApi().agents(), getApi().chatSettings()]).then(
      ([list, c]) => {
        const g = list.find((a) => a.kind === "god" && a.status === "active");
        const d = list.find((a) => a.kind === "demigod" && a.status === "active");
        setWho({ ...(g && { god: g }), ...(d && { demigod: d }) });
        const base = s.config.defaultModel ?? suggested(models);
        setGod(g?.model ?? base);
        setDemigod(d?.model ?? base);
        setChat(c.model ?? base);
        setOthers(s.config.defaultModel ?? base);
      },
      () => setWho({}),
    );
  }, [models]);
  if (!models || !who) return <div class="empty">…</div>;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (who.god) await getApi().configureAgent(who.god.id, { model: god });
      if (who.demigod) await getApi().configureAgent(who.demigod.id, { model: demigod });
      await getApi().setChatSettings({ model: chat });
      // The default is tried with a real question before it is kept.
      if (others) await getApi().setupModels({ defaultModel: others });
      next();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  };
  return (
    <Step title={t("wzAssign")} purpose={t("wzAssignPurpose")}>
      {models.length === 0 ? (
        <p class="notice warn">{t("brainNoModel")}</p>
      ) : (
        <div class="form">
          {who.god && (
            <Field label={who.god.name}>
              <ModelSelect models={models} value={god} onChange={setGod} label={who.god.name} />
              <span class="ui-help">{t("wzAssignGod")}</span>
            </Field>
          )}
          {who.demigod && (
            <Field label={`${who.demigod.name} (Telegram)`}>
              <ModelSelect
                models={models}
                value={demigod}
                onChange={setDemigod}
                label={who.demigod.name}
              />
              <span class="ui-help">{t("wzAssignDemigod")}</span>
            </Field>
          )}
          <Field label={t("chat")}>
            <ModelSelect models={models} value={chat} onChange={setChat} label={t("chat")} />
            <span class="ui-help">{t("wzAssignChat")}</span>
          </Field>
          <Field label={t("wzAssignOthers")}>
            <ModelSelect
              models={models}
              value={others}
              onChange={setOthers}
              label={t("wzAssignOthers")}
            />
            <span class="ui-help">{t("wzAssignOthersHelp")}</span>
          </Field>
        </div>
      )}
      {error && <p class="notice error">{error}</p>}
      <div class="row">
        <button
          type="button"
          class="primary"
          disabled={busy || models.length === 0 || !god || !chat || !others}
          onClick={() => void save()}
        >
          {busy ? t("wzTrying") : t("wzSaveNext")}
        </button>
        {models.length === 0 && (
          <button type="button" onClick={next}>
            {t("wzNext")}
          </button>
        )}
      </div>
    </Step>
  );
}

/** A model on this computer: the suggested ones, downloaded and started from here. */
function LocalStep({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  return (
    <Step title={t("wzLocal")} purpose={t("lmPurpose")} onSkip={next}>
      <LocalModels s={s} reload={reload} />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

function Names({ s, next }: { s: SetupState; next: () => void }) {
  const [god, setGod] = useState(s.names.god ?? "God");
  const [demigod, setDemigod] = useState(s.names.demigod ?? "Demi-God");
  const [prompt, setPrompt] = useState(s.names.godPrompt ?? "");
  const save = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() =>
      getApi().setupNames({
        god,
        demigod,
        language: lang.value,
        ...(prompt.trim() && { godPrompt: prompt.trim() }),
      }),
    );
    if (r !== undefined) next();
  };
  return (
    <form class="form" onSubmit={(e) => void save(e)}>
      <p class="wide dim">{t("wzNamesHint")}</p>
      <Field label={t("wzGodName")}>
        <input
          required
          maxLength={40}
          value={god}
          onInput={(e) => setGod((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzDemigodName")}>
        <input
          required
          maxLength={40}
          value={demigod}
          onInput={(e) => setDemigod((e.target as HTMLInputElement).value)}
        />
      </Field>
      <label class="wide">
        {t("wzGodPrompt")}
        <textarea
          rows={5}
          value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="row wide">
        <button type="submit" class="primary">
          {t("wzSaveNext")}
        </button>
      </div>
    </form>
  );
}

/** Standard (everything ready) or advanced (a code server, access from outside). */
function ModeStep({ s, next }: { s: SetupState; next: () => void }) {
  const [mode, setMode] = useState(s.config.mode ?? "standard");
  return (
    <Step title={t("wzMode")} purpose={t("modePurpose")}>
      <Choice<"standard" | "advanced">
        value={[mode]}
        onChange={([m]) => m && setMode(m)}
        options={[
          {
            id: "standard",
            title: t("modeStandard"),
            description: t("modeStandardText"),
            badge: t("lmRecommended"),
          },
          { id: "advanced", title: t("modeAdvanced"), description: t("modeAdvancedText") },
        ]}
      />
      <div class="row">
        <button
          type="button"
          class="primary"
          onClick={() => void attempt(() => getApi().setupMode(mode)).then(next)}
        >
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

function CodeStep({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  return (
    <Step title={t("wzCode")} purpose={t("gitPurpose")} onSkip={next}>
      <GitCode s={s} onChange={reload} />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

function RemoteStep({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  return (
    <Step title={t("wzRemote")} purpose={t("remotePurpose")} onSkip={next}>
      <RemoteAccess s={s} onChange={reload} />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

/** Telegram, step by step: a bot of one's own, then Start in Telegram (no code to type). */
function TelegramStep({
  s,
  next,
  reload,
}: {
  s: SetupState;
  next: () => void;
  reload: () => void;
}) {
  return (
    <Step title={t("wzTelegram")} purpose={t("tgPurpose")} onSkip={next}>
      <TelegramLink s={s} onChange={reload} />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
      </div>
    </Step>
  );
}

function SafetyStep({ s, next }: { s: SetupState; next: () => void }) {
  return (
    <Step title={t("wzSafety")} purpose={t("safetyPurpose")}>
      <Safety s={s} next={next} />
    </Step>
  );
}

/** The first-run wizard (G17): each step is applied and saved at once; it can be run again. */
export function Setup({ onDone }: { onDone?: () => void }) {
  const [s, setS] = useState<SetupState | null>(null);
  const [key, setKey] = useState<StepKey>("wzWelcome");
  const reload = () => void attempt(() => getApi().setup()).then((x) => x && setS(x));
  useEffect(reload, []);
  if (!s) return <div class="empty">…</div>;
  const steps = stepsFor(s);
  const step = Math.max(0, steps.indexOf(key));
  const next = () => {
    // The settings come back first: choosing "advanced" adds a step after this one.
    void attempt(() => getApi().setup()).then((x) => {
      if (!x) return;
      setS(x);
      const list = stepsFor(x);
      setKey(list[Math.min(list.indexOf(key) + 1, list.length - 1)] ?? "wzDone");
    });
  };
  const h = s.hardware;
  return (
    <div class="setup">
      <ol class="wz-steps">
        {steps.map((k, i) => (
          <li key={k} class={i === step ? "on" : i < step ? "done" : ""}>
            <button type="button" class="tiny" onClick={() => setKey(k)}>
              {t(k)}
            </button>
          </li>
        ))}
      </ol>
      <section class="wz-body">
        {/* Steps built from Step carry their own title. */}
        {(key === "wzWelcome" || key === "wzNames" || key === "wzDone") && <h2>{t(key)}</h2>}
        {key === "wzWelcome" && (
          <div class="form">
            <p class="wide">{t("wzWelcomeText")}</p>
            <Field label={t("wzLanguage")}>
              <select
                value={lang.value}
                onChange={(e) => setLang((e.target as HTMLSelectElement).value as "it" | "en")}
              >
                <option value="it">Italiano</option>
                <option value="en">English</option>
              </select>
            </Field>
            <div class="wide notice">
              <strong>{t("wzHardware")}</strong>
              <div>
                {h.cpu} · {h.cores} core · RAM {gb(h.ramGb)}
                {h.diskFreeGb !== null && ` · ${t("wzDiskFree")} ${gb(h.diskFreeGb)}`}
              </div>
              {h.gpus.map((g) => (
                <div key={g.name}>
                  GPU {g.name}
                  {g.vramGb > 0 && ` · ${gb(g.vramGb)}`}
                </div>
              ))}
              <div class="dim">{hardwareText(h)}</div>
            </div>
            <div class="row wide">
              <button type="button" class="primary" onClick={next}>
                {t("wzStart")}
              </button>
            </div>
          </div>
        )}
        {key === "wzMode" && <ModeStep s={s} next={next} />}
        {key === "wzBrain" && <BrainStep s={s} next={next} reload={reload} />}
        {key === "wzLocal" && <LocalStep s={s} next={next} reload={reload} />}
        {key === "wzNames" && <Names s={s} next={next} />}
        {key === "wzAssign" && <AssignStep s={s} next={next} />}
        {key === "wzTelegram" && <TelegramStep s={s} next={next} reload={reload} />}
        {key === "wzCode" && <CodeStep s={s} next={next} reload={reload} />}
        {key === "wzRemote" && <RemoteStep s={s} next={next} reload={reload} />}
        {key === "wzSafety" && <SafetyStep s={s} next={next} />}
        {key === "wzDone" && (
          <div class="form">
            <ul class="wide">
              <li>
                {t("wzDefaultModel")}:{" "}
                {s.config.defaultModel
                  ? `${s.config.defaultModel.provider}/${s.config.defaultModel.model}`
                  : "—"}
              </li>
              <li>
                {t("wzLocalModel")}: {s.config.engine?.model ?? "—"}
              </li>
              <li>
                {t("wzNames")}: {s.names.god ?? "—"} · {s.names.demigod ?? "—"}
              </li>
              <li>Telegram: {s.secretsSet.telegram || s.locked.telegram ? t("yes") : "—"}</li>
              <li>
                {t("wzBudget")}: {s.budgetUsd !== null ? `$${s.budgetUsd}` : "—"}
              </li>
            </ul>
            <p class="wide dim">{t("wzRunAgain")}</p>
            <div class="row wide">
              <button
                type="button"
                class="primary"
                onClick={() =>
                  void attempt(() => getApi().setupComplete()).then(async () => {
                    await attempt(refresh);
                    onDone?.();
                  })
                }
              >
                {t("wzFinish")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
