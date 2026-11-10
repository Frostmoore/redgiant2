// One way to choose a model wherever one is chosen (G24.14d): the wizard, an agent's settings,
// the chat's settings. The models connected now, by name, with how each is reached; and the
// effort when the model has one.
import { useEffect, useState } from "preact/hooks";
import type { ModelChoice } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { modelName, modelNote, via } from "./ModelMenu.js";

const EFFORTS = ["low", "medium", "high", "max"] as const;

/** A model as the API gives it: provider, id and, when it has one, the effort. */
export type Spec = { provider: string; model: string; effort?: string };
const key = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;

/** The models connected now (asked again each time: one may have just been connected). */
export function useModels(): ModelChoice[] | undefined {
  const [models, setModels] = useState<ModelChoice[]>();
  useEffect(
    () =>
      void getApi()
        .models()
        .then(setModels, () => setModels([])),
    [],
  );
  return models;
}

export function ModelSelect({
  value,
  onChange,
  empty,
  label,
  models,
}: {
  value: Spec | null;
  onChange: (m: Spec | null) => void;
  /** What "no model of its own" means here (the default, the parent's…); absent: one is needed. */
  empty?: string;
  label?: string;
  models: ModelChoice[];
}) {
  const many = new Set(models.map((m) => m.provider)).size > 1;
  const known = value && models.some((m) => key(m) === key(value));
  const effort = value && models.find((m) => key(m) === key(value))?.effort;
  return (
    <div class="model-select">
      <select
        aria-label={label ?? t("model")}
        value={value ? key(value) : ""}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (!v) return onChange(null);
          const m = models.find((x) => key(x) === v);
          if (!m) return;
          onChange({
            provider: m.provider,
            model: m.model,
            ...(m.effort && { effort: value?.effort ?? "medium" }),
          });
        }}
      >
        {(empty !== undefined || !value) && <option value="">{empty ?? t("modelPick")}</option>}
        {value && !known && <option value={key(value)}>{modelName(value.model)}</option>}
        {models.map((m) => (
          <option key={key(m)} value={key(m)}>
            {modelName(m.model)}
            {many ? ` · ${via(m.provider)}` : ""}
            {modelNote(m)}
          </option>
        ))}
      </select>
      {value && effort && (
        <select
          aria-label={t("effort")}
          title={t("effortHint")}
          value={value.effort ?? "medium"}
          onChange={(e) => onChange({ ...value, effort: (e.target as HTMLSelectElement).value })}
        >
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {t(`effort_${x}` as never)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
