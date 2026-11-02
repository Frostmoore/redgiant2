import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { lang, setLang, t } from "../i18n.js";
import { attempt, getApi, refresh } from "../state.js";
import { Brain, DefaultModel } from "./Brain.js";
import { hardwareText, LocalModels } from "./LocalModels.js";
import { Safety } from "./Safety.js";
import { TelegramLink } from "./TelegramLink.js";
import { Step } from "./ui.js";

const STEPS = [
  "wzWelcome",
  "wzBrain",
  "wzLocal",
  "wzNames",
  "wzTelegram",
  "wzSafety",
  "wzDone",
] as const;

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

/** "How should RedGiant think?": any of the ways, or none; then the default model. */
function BrainStep({ s, next, reload }: { s: SetupState; next: () => void; reload: () => void }) {
  return (
    <Step title={t("wzBrain")} purpose={t("brainPurpose")}>
      <Brain s={s} reload={reload} wizard />
      <DefaultModel s={s} onSaved={reload} />
      <div class="row">
        <button type="button" class="primary" onClick={next}>
          {t("wzNext")}
        </button>
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
  const [step, setStep] = useState(0);
  const reload = () => void attempt(() => getApi().setup()).then((x) => x && setS(x));
  useEffect(reload, []);
  if (!s) return <div class="empty">…</div>;
  const next = () => {
    reload();
    setStep((n) => Math.min(n + 1, STEPS.length - 1));
  };
  const h = s.hardware;
  return (
    <div class="setup">
      <ol class="wz-steps">
        {STEPS.map((k, i) => (
          <li key={k} class={i === step ? "on" : i < step ? "done" : ""}>
            <button type="button" class="tiny" onClick={() => setStep(i)}>
              {t(k)}
            </button>
          </li>
        ))}
      </ol>
      <section class="wz-body">
        {/* Steps built from Step carry their own title. */}
        {![1, 2, 4, 5].includes(step) && <h2>{t(STEPS[step] ?? "wzWelcome")}</h2>}
        {step === 0 && (
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
        {step === 1 && <BrainStep s={s} next={next} reload={reload} />}
        {step === 2 && <LocalStep s={s} next={next} reload={reload} />}
        {step === 3 && <Names s={s} next={next} />}
        {step === 4 && <TelegramStep s={s} next={next} reload={reload} />}
        {step === 5 && <SafetyStep s={s} next={next} />}
        {step === 6 && (
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
