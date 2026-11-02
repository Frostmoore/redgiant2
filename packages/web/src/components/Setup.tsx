import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { danger, lang, setLang, t } from "../i18n.js";
import { attempt, getApi, platformInfo, refresh } from "../state.js";
import { Brain, DefaultModel } from "./Brain.js";
import { hardwareText, LocalModels } from "./LocalModels.js";
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

function Telegram({ s, next }: { s: SetupState; next: () => void }) {
  const [token, setToken] = useState("");
  const [bot, setBot] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; link: string } | null>(null);
  const connect = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() => getApi().setupTelegram(token.trim()));
    if (r) {
      setBot(r.username);
      const p = await attempt(() => getApi().telegramPair());
      if (p) setCode({ code: p.code, link: p.link });
    }
  };
  return (
    <div class="form">
      <p class="wide dim">{t("wzTelegramHint")}</p>
      {s.locked.telegram ? (
        <p class="wide notice">{t("wzLocked")}</p>
      ) : (
        <form class="row wide" onSubmit={(e) => void connect(e)}>
          <input
            type="password"
            autocomplete="off"
            placeholder={s.secretsSet.telegram ? t("wzAlreadySet") : "123456:ABC…"}
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
          />
          <button type="submit">{t("wzConnect")}</button>
        </form>
      )}
      {bot && code && (
        <div class="wide notice ok">
          {t("wzPairNow", { bot })}{" "}
          <a href={code.link} target="_blank" rel="noreferrer">
            {code.link}
          </a>
          <pre>/start {code.code}</pre>
        </div>
      )}
      <div class="row wide">
        <button type="button" class="primary" onClick={next}>
          {bot || s.secretsSet.telegram ? t("wzNext") : t("wzSkip")}
        </button>
      </div>
    </div>
  );
}

function Safety({ s, next }: { s: SetupState; next: () => void }) {
  const [humanOnly, setHumanOnly] = useState<string[]>(s.policy.humanOnly);
  const [budget, setBudget] = useState(s.budgetUsd?.toString() ?? "");
  const [retention, setRetention] = useState(s.config.retentionDays?.toString() ?? "");
  const save = async (e: Event) => {
    e.preventDefault();
    const r = await attempt(() =>
      getApi().setupSafety({
        humanOnly,
        budgetUsd: budget.trim() ? Number(budget) : null,
        retentionDays: retention.trim() ? Number(retention) : null,
      }),
    );
    if (r !== undefined) next();
  };
  return (
    <form class="form" onSubmit={(e) => void save(e)}>
      <p class="wide dim">{t("wzSafetyHint")}</p>
      <div class="wide wz-checks">
        {s.policy.dangers.map((d) => (
          <label key={d.id} class="row">
            <input
              type="checkbox"
              checked={humanOnly.includes(d.id)}
              onChange={(e) =>
                setHumanOnly(
                  (e.target as HTMLInputElement).checked
                    ? [...humanOnly, d.id]
                    : humanOnly.filter((x) => x !== d.id),
                )
              }
            />
            {danger(d.id).name}
          </label>
        ))}
      </div>
      <Field label={t("wzBudget")}>
        <input
          type="number"
          min="1"
          step="1"
          value={budget}
          onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
        />
      </Field>
      <Field label={t("wzRetention")}>
        <input
          type="number"
          min="1"
          step="1"
          placeholder={t("wzForever")}
          value={retention}
          onInput={(e) => setRetention((e.target as HTMLInputElement).value)}
        />
      </Field>
      <p class="wide dim">{t("wzSandbox", { kind: platformInfo.value?.sandbox ?? "?" })}</p>
      <div class="row wide">
        <button type="submit" class="primary">
          {t("wzSaveNext")}
        </button>
      </div>
    </form>
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
        {step !== 1 && step !== 2 && <h2>{t(STEPS[step] ?? "wzWelcome")}</h2>}
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
        {step === 4 && <Telegram s={s} next={next} />}
        {step === 5 && <Safety s={s} next={next} />}
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
