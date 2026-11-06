// "Safety and spending" (G24.4), as the person's prototype has it (2026-11-06): four decisions,
// each a card with its question and a choice in one row. The guardian; who says yes to risky
// actions (three ready choices, a switch per danger in a window); a spending limit only when
// something is paid per use; the skills the agents write. Then how long conversations are kept.
// The agents work on this computer in the project's folder: the guardian watches what leaves it.
import { useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { danger, t } from "../i18n.js";
import { IconApprove, IconBook, IconClock, IconShield, IconWallet } from "../icons.js";
import { getApi } from "../state.js";
import { num, PRESETS, type Preset, paysPerUse, presetOf } from "../wizard.js";
import { explain } from "./Brain.js";
import { Modal } from "./ui.js";

const RETENTION = ["forever", "365", "90", "30"] as const;
const BUDGETS = ["20", "50", "100", ""] as const;

/** A row of choices, one lit. */
function Seg<T extends string>({
  options,
  value,
  onChange,
  vertical,
}: {
  options: [T, string][];
  value: T | null;
  onChange: (v: T) => void;
  vertical?: boolean;
}) {
  return (
    <div class={`wz-seg${vertical ? " v" : ""}`}>
      {options.map(([v, label]) => (
        <button
          type="button"
          key={v}
          class={value === v ? "on" : ""}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Card({
  icon,
  title,
  q,
  children,
}: {
  icon: preact.JSX.Element;
  title: string;
  q: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class="wz-scard">
      <div class="wz-scard-hd">
        <span class="wz-scard-av">{icon}</span>
        <div>
          <h3>{title}</h3>
          <div class="wz-scard-q">{q}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

export function Safety({
  s,
  register,
}: {
  s: SetupState;
  /** Gives the wizard the saving to do when Next is pressed. */
  register: (save: () => Promise<boolean>) => void;
}) {
  const [humanOnly, setHumanOnly] = useState<string[]>(s.policy.humanOnly);
  const [guardian, setGuardian] = useState<"ask" | "auto">(s.policy.guardian ?? "ask");
  const [skills, setSkills] = useState<"ask" | "auto">(s.policy.skills ?? "ask");
  const [budget, setBudget] = useState(s.budgetUsd?.toString() ?? "");
  const [retention, setRetention] = useState<string>(
    s.config.retentionDays ? String(s.config.retentionDays) : "forever",
  );
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string>();
  const preset = presetOf(humanOnly);
  // The ready choice the switches start from, to go back to it.
  const [base, setBase] = useState<Preset>(preset ?? "balanced");
  const paid = paysPerUse(s) === true;
  const limit = Number(budget.replace(",", "."));
  register(async () => {
    setError(undefined);
    try {
      await getApi().setupSafety({
        guardian,
        skills,
        humanOnly,
        budgetUsd: paid && budget.trim() && limit > 0 ? limit : null,
        retentionDays: retention === "forever" ? null : Number(retention),
      });
      return true;
    } catch (err) {
      setError(explain(err));
      return false;
    }
  });
  const pick = (p: Preset) => {
    setBase(p);
    setHumanOnly([...PRESETS[p]]);
  };
  const dangers = s.policy.dangers;
  return (
    <>
      <div class="wz-safe">
        <Card icon={<IconShield size={22} />} title={t("guardianTitle")} q={t("wzGuardQ")}>
          <Seg
            options={[
              ["ask", t("wzGuardAsk")],
              ["auto", t("wzGuardAuto")],
            ]}
            value={guardian}
            onChange={setGuardian}
          />
          <p class="wz-say">{guardian === "ask" ? t("guardianAskText") : t("guardianAutoText")}</p>
        </Card>

        <Card icon={<IconApprove size={22} />} title={t("wzApprTitle")} q={t("wzApprQ")}>
          <Seg
            options={[
              ["careful", t("safetyCareful")],
              ["balanced", t("safetyBalanced")],
              ["free", t("safetyFree")],
            ]}
            value={preset ?? null}
            onChange={pick}
          />
          <p class="wz-say">
            {preset
              ? t(
                  preset === "careful"
                    ? "safetyCarefulText"
                    : preset === "balanced"
                      ? "safetyBalancedText"
                      : "safetyFreeText",
                )
              : t("wzApprCustom", {
                  n: String(humanOnly.length),
                  of: String(dangers.length),
                })}{" "}
            <button type="button" class="wz-link inl" onClick={() => setCustom(true)}>
              {t("safetyPersonalize")}
            </button>
          </p>
        </Card>

        <Card
          icon={<IconWallet size={22} />}
          title={t("wzBudgetTitle")}
          q={paid ? t("wzBudgetQ") : t("wzBudgetQFree")}
        >
          {paid ? (
            <>
              <div class="wz-money">
                {BUDGETS.map((v) => (
                  <button
                    type="button"
                    key={v}
                    class={`wz-chip${budget === v ? " on" : ""}`}
                    aria-pressed={budget === v}
                    onClick={() => setBudget(v)}
                  >
                    {v ? `$${v}` : t("safetyNoLimit")}
                  </button>
                ))}
                <input
                  class="wz-field wz-money-in"
                  inputmode="decimal"
                  enterkeyhint="done"
                  aria-label={t("wzBudgetOther")}
                  placeholder={t("wzBudgetOther")}
                  value={BUDGETS.includes(budget as never) ? "" : budget}
                  onInput={(e) =>
                    setBudget((e.target as HTMLInputElement).value.replace(/[^\d.,]/g, ""))
                  }
                />
              </div>
              <p class="wz-say">
                {budget.trim() && limit > 0
                  ? t("wzBudgetSay", { usd: num(limit, 2) })
                  : t("wzBudgetNone")}
              </p>
            </>
          ) : (
            <p class="wz-say first">{t("safetyNothingPaid")}</p>
          )}
        </Card>

        <Card icon={<IconBook size={22} />} title={t("wzSkillsTitle")} q={t("wzSkillsQ")}>
          <Seg
            vertical
            options={[
              ["ask", t("skillsAsk")],
              ["auto", t("skillsAuto")],
            ]}
            value={skills}
            onChange={setSkills}
          />
          <p class="wz-say">
            {skills === "ask" ? t("skillsAskText") : t("skillsAutoText")} {t("wzSkillsTools")}
          </p>
        </Card>
      </div>
      <div class="wz-strip">
        <div>
          <IconShield size={22} />
          <span>{t("wzWhereAgents")}</span>
        </div>
        <div class="wz-strip-ret">
          <IconClock size={22} />
          <div>
            <span>{t("wzKeepFor")}</span>
            <div class="wz-chips">
              {RETENTION.map((r) => (
                <button
                  type="button"
                  key={r}
                  class={`wz-chip${retention === r ? " on" : ""}`}
                  aria-pressed={retention === r}
                  onClick={() => setRetention(r)}
                >
                  {t(`safetyKeep_${r}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error && <p class="notice error">{error}</p>}
      {custom && (
        <Modal title={t("wzCustomTitle")} onClose={() => setCustom(false)}>
          <p class="wz-lead2">{t("wzCustomLead", { god: s.names.god ?? "God" })}</p>
          <div class="wz-toggles">
            {dangers.map((d) => {
              const on = humanOnly.includes(d.id);
              const w = danger(d.id);
              return (
                <div class="wz-tr" key={d.id}>
                  <div>
                    <b>{w.name}</b>
                    <small>{w.hint}</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={w.name}
                    class={`wz-switch${on ? " on" : ""}`}
                    onClick={() =>
                      setHumanOnly(on ? humanOnly.filter((x) => x !== d.id) : [...humanOnly, d.id])
                    }
                  />
                </div>
              );
            })}
          </div>
          <div class="wz-acts">
            <button type="button" class="wz-btn quiet" onClick={() => pick(base)}>
              {t("wzBackTo", { preset: t(`wzPreset_${base}`) })}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => setCustom(false)}>
              {t("wzDoneBtn")}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
