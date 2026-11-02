import { keyProvider, OWN_SERVER_ID } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { ModelChoice } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi, refreshConversations } from "../state.js";

type Model = { provider: string; model: string; effort?: string };
const EFFORTS = ["low", "medium", "high", "max"] as const;
const AGENTS = "";

/** A model's name as people say it: claude-opus-5-5 → Opus 5.5; other ids stay as they are. */
export function modelName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
  if (!m) return id;
  const family = (m[1] ?? "").charAt(0).toUpperCase() + (m[1] ?? "").slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** How a model is reached, in a word next to its name. */
export const via = (provider: string) =>
  provider.endsWith("-subscription")
    ? t("viaSubscription")
    : provider === "local" || provider === OWN_SERVER_ID
      ? t("viaLocal")
      : keyProvider(provider)
        ? "API"
        : provider;

/** The models the server offers, shared by every composer; asked again when a menu is opened. */
let cache: Promise<ModelChoice[]> | undefined;
const loadModels = (fresh = false) => {
  if (fresh) cache = undefined;
  cache ??= getApi()
    .models()
    .catch(() => {
      cache = undefined;
      return [];
    });
  return cache;
};

/**
 * The composer's model and effort, as in Officina: two native menus (the phone opens its own
 * picker). The next message uses them; "the agent's" goes back to what the agent is set to.
 */
export function ModelMenu({
  sessionId,
  current,
  own,
  disabled,
}: {
  sessionId: string;
  /** What the conversation uses now (its own or the agent's). */
  current: Model | undefined;
  /** True when the conversation has its own model. */
  own: boolean;
  disabled: boolean;
}) {
  const [models, setModels] = useState<ModelChoice[]>([]);
  useEffect(() => void loadModels().then(setModels), []);

  const choose = async (m: Model | null) => {
    await attempt(() => getApi().updateSession(sessionId, { model: m }));
    await refreshConversations().catch(() => {});
  };
  const key = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;
  const known = current && models.some((m) => key(m) === key(current));
  const effortOk =
    current !== undefined &&
    (models.find((m) => key(m) === key(current))?.effort ?? current.effort !== undefined);

  return (
    <>
      <select
        class={`model ${own ? "own" : ""}`}
        aria-label={t("model")}
        title={t("modelHint")}
        disabled={disabled}
        // A way of thinking connected meanwhile shows up as soon as the menu is opened.
        onFocus={() => void loadModels(true).then(setModels)}
        value={own && current ? key(current) : AGENTS}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === AGENTS) return void choose(null);
          const [provider = "", ...rest] = v.split("/");
          const m = models.find((x) => key(x) === v);
          void choose({
            provider,
            model: rest.join("/"),
            ...(m?.effort && { effort: current?.effort ?? "medium" }),
          });
        }}
      >
        <option value={AGENTS}>
          {!current ? t("modelPick") : own ? t("agentsModel") : modelName(current.model)}
        </option>
        {own && current && !known && (
          <option value={key(current)}>{modelName(current.model)}</option>
        )}
        {models.map((m) => (
          <option key={key(m)} value={key(m)}>
            {modelName(m.model)}
            {models.some((x) => x.provider !== m.provider) ? ` · ${via(m.provider)}` : ""}
          </option>
        ))}
      </select>
      {current && effortOk && (
        <select
          class="model effort"
          aria-label={t("effort")}
          title={t("effortHint")}
          disabled={disabled}
          value={current.effort ?? "medium"}
          onChange={(e) =>
            void choose({ ...current, effort: (e.target as HTMLSelectElement).value })
          }
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {t(`effort_${e}` as never)}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
