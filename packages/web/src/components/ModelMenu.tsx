import { useEffect, useRef, useState } from "preact/hooks";
import type { ModelChoice } from "../api.js";
import { t } from "../i18n.js";
import { IconCheck, IconChevron } from "../icons.js";
import { attempt, getApi, refreshConversations } from "../state.js";

type Model = { provider: string; model: string; effort?: string };
const EFFORTS = ["low", "medium", "high", "max"] as const;

/**
 * The composer's model chip, as in Officina: pick the conversation's model and effort; the
 * next message uses them. "The agent's" goes back to what the agent is configured with.
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
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    if (!models) void attempt(() => getApi().models()).then((m) => setModels(m ?? []));
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = async (m: Model | null) => {
    setOpen(false);
    await attempt(() => getApi().updateSession(sessionId, { model: m }));
    await refreshConversations().catch(() => {});
  };
  const supportsEffort = (m: Model | undefined) =>
    m !== undefined &&
    (models?.find((x) => x.provider === m.provider && x.model === m.model)?.effort ?? true);

  return (
    <div class="model-menu" ref={box}>
      <button
        type="button"
        class={`model ${own ? "own" : ""}`}
        title={t("modelHint")}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current ? current.model : t("noModel")}
        {current?.effort ? ` · ${t(`effort_${current.effort}` as never)}` : ""}
        <IconChevron open={open} size={11} />
      </button>
      {open && (
        <div class="menu" role="menu">
          {models === null && <div class="dim menu-note">{t("loading")}</div>}
          {models?.length === 0 && <div class="dim menu-note">{t("noModels")}</div>}
          {[...new Set(models?.map((m) => m.provider) ?? [])].map((provider) => (
            <div key={provider}>
              <div class="menu-title">{provider}</div>
              {models
                ?.filter((m) => m.provider === provider)
                .map((m) => {
                  const on = current?.provider === m.provider && current.model === m.model;
                  return (
                    <button
                      key={m.model}
                      type="button"
                      role="menuitem"
                      class={on ? "on" : ""}
                      onClick={() =>
                        void choose({
                          provider: m.provider,
                          model: m.model,
                          ...(m.effort && { effort: current?.effort ?? "medium" }),
                        })
                      }
                    >
                      <span class="mark">{on && <IconCheck size={12} />}</span>
                      {m.model}
                    </button>
                  );
                })}
            </div>
          ))}
          {current && supportsEffort(current) && (
            <>
              <div class="menu-title">{t("effort")}</div>
              <div class="menu-row">
                {EFFORTS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    class={`pill ${current.effort === e ? "on" : ""}`}
                    onClick={() => void choose({ ...current, effort: e })}
                  >
                    {t(`effort_${e}` as never)}
                  </button>
                ))}
              </div>
            </>
          )}
          {own && (
            <button type="button" role="menuitem" class="reset" onClick={() => void choose(null)}>
              {t("agentsModel")}
            </button>
          )}
          <div class="dim menu-note">{t("modelChangeNote")}</div>
        </div>
      )}
    </div>
  );
}
