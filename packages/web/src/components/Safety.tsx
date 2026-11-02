// "Safety and spending" (G24.4): who says yes to risky actions, in three ready choices with a
// sentence each and a switch per danger for those who want to choose; a spending limit only
// when something is paid per use; how long the conversations' details are kept.
import { DANGER_IDS } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { danger, t } from "../i18n.js";
import { getApi, platformInfo } from "../state.js";
import { explain } from "./Brain.js";
import { Advanced, Choice, Field, Toggle } from "./ui.js";

/** The dangers only the human approves, for each ready choice. */
const PRESETS = {
  careful: [...DANGER_IDS],
  balanced: [
    "git-push",
    "git-history",
    "privilege",
    "disk",
    "deploy",
    "database-drop",
    "secrets-files",
    "platform",
  ],
  free: ["platform", "secrets-files"],
} as const;
type Preset = keyof typeof PRESETS;

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

const RETENTION = ["forever", "365", "90", "30"] as const;

export function Safety({ s, next }: { s: SetupState; next: () => void }) {
  const [humanOnly, setHumanOnly] = useState<string[]>(s.policy.humanOnly);
  const [budget, setBudget] = useState(s.budgetUsd?.toString() ?? "");
  const [retention, setRetention] = useState<string>(
    s.config.retentionDays ? String(s.config.retentionDays) : "forever",
  );
  const [error, setError] = useState<string>();
  const preset = (Object.keys(PRESETS) as Preset[]).find((p) => same(PRESETS[p], humanOnly));
  // Paid per use: a key of a provider (subscriptions and local models cost nothing more).
  const paid = s.secretsSet.keys.length > 0 || s.locked.anthropic === true;
  const save = async () => {
    setError(undefined);
    try {
      await getApi().setupSafety({
        humanOnly,
        budgetUsd: paid && budget.trim() ? Number(budget) : null,
        retentionDays: retention === "forever" ? null : Number(retention),
      });
      next();
    } catch (err) {
      setError(explain(err));
    }
  };
  return (
    <div class="safety">
      <h3>{t("safetyWho")}</h3>
      <p class="ui-help">{t("safetyWhoHint")}</p>
      <Choice<Preset>
        value={preset ? [preset] : []}
        onChange={([p]) => p && setHumanOnly([...PRESETS[p]])}
        options={[
          {
            id: "careful",
            title: t("safetyCareful"),
            description: t("safetyCarefulText"),
            badge: t("lmRecommended"),
          },
          { id: "balanced", title: t("safetyBalanced"), description: t("safetyBalancedText") },
          { id: "free", title: t("safetyFree"), description: t("safetyFreeText") },
        ]}
      />
      {!preset && <p class="ui-help">{t("safetyCustom")}</p>}
      <Advanced label={t("safetyPersonalize")}>
        <p class="ui-help">{t("safetyPersonalizeHint")}</p>
        {s.policy.dangers.map((d) => (
          <Toggle
            key={d.id}
            label={danger(d.id).name}
            description={danger(d.id).hint}
            checked={humanOnly.includes(d.id)}
            onChange={(on) =>
              setHumanOnly(on ? [...humanOnly, d.id] : humanOnly.filter((x) => x !== d.id))
            }
          />
        ))}
      </Advanced>

      <h3>{t("safetySpending")}</h3>
      {paid ? (
        <div class="form">
          <Field label={t("safetyBudget")} help={t("safetyBudgetHelp")}>
            <input
              type="number"
              min="1"
              step="1"
              placeholder={t("safetyNoLimit")}
              value={budget}
              onInput={(e) => setBudget((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
      ) : (
        <p class="ui-help">{t("safetyNothingPaid")}</p>
      )}

      <h3>{t("safetyHistory")}</h3>
      <div class="form">
        <Field label={t("safetyRetention")} help={t("safetyRetentionHelp")}>
          <select
            value={retention}
            onChange={(e) => setRetention((e.target as HTMLSelectElement).value)}
          >
            {RETENTION.map((r) => (
              <option key={r} value={r}>
                {t(`safetyKeep_${r}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p class={`notice ${platformInfo.value?.sandbox === "docker" ? "ok" : "warn"}`}>
        {platformInfo.value?.sandbox === "docker"
          ? t("safetySandboxDocker")
          : t("safetySandboxHost")}
      </p>
      <div class="row">
        <button type="button" class="primary" onClick={() => void save()}>
          {t("wzSaveNext")}
        </button>
      </div>
      {error && <p class="notice error">{error}</p>}
    </div>
  );
}
