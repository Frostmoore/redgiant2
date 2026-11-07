// An agent's Tools tab (G34.5, the person: «Ovviamente devo poter scegliere agente per agente»): each
// of its tools as for every agent, always on for it, or off; the essential ones locked, with why.
// On top, what its tools weigh on every message now. New conversations only.
import type { AgentToolState, ToolView } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { IconArrowRight, IconLock } from "../icons.js";
import { getApi, openTab } from "../state.js";
import { Seg } from "./SettingsKit.js";
import {
  aboutTokens,
  byGroup,
  GroupHead,
  NewOnly,
  ToolText,
  toolName,
  useToolsView,
} from "./ToolsPage.js";

type Pick = "default" | AgentToolState;

export function AgentTools({ agent }: { agent: Agent }) {
  const { view, setView, error, setError, load } = useToolsView(agent.id);
  const [busy, setBusy] = useState(false);
  const choose = async (e: ToolView, pick: Pick) => {
    if (!view || e.essential) return;
    const own = pick === "default" ? null : pick;
    const on = own === null ? e.global : own === "on";
    const entries = view.entries.map((x) => (x.id === e.id ? { ...x, own, on } : x));
    setView({
      ...view,
      entries,
      total: entries.filter((x) => x.on).reduce((n, x) => n + x.tokens, 0),
      saved: entries.filter((x) => !x.on).reduce((n, x) => n + x.tokens, 0),
    });
    setBusy(true);
    try {
      await getApi().setAgentTools(agent.id, { [e.id]: pick });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  };
  return (
    <div class="tl-agent">
      <p class="tl-lead">{t("toolsAgentLead")}</p>
      {error && <p class="tl-error">{t("toolsError", { error })}</p>}
      {!view && !error && <p class="tl-loading">{t("toolsLoading")}</p>}
      {view && (
        <>
          <div class="tl-sum">
            <div class="tl-sum-box">
              <b>{t("toolsAgentTotal", { name: agent.name, n: aboutTokens(view.total) })}</b>
              <span>
                {view.saved > 0
                  ? t("toolsSaved", { n: aboutTokens(view.saved) })
                  : t("toolsNoneSaved")}
              </span>
            </div>
          </div>
          <NewOnly />
          <button
            type="button"
            class="wz-btn small tl-all"
            onClick={() =>
              openTab({ id: "settings", type: "settings", title: t("settings"), section: "tools" })
            }
          >
            {t("toolsOpenAll")} <IconArrowRight size={16} />
          </button>
          {byGroup(view.entries).map(([group, entries]) => (
            <section class="tl-section" key={group}>
              <GroupHead group={group} />
              <div class="tl-list">
                {entries.map((e) => (
                  <div
                    key={e.id}
                    class={`tl-row tl-row-agent${e.on ? " on" : ""}${e.essential ? " locked" : ""}`}
                    data-tool={e.id}
                  >
                    <ToolText e={e} />
                    {e.essential ? (
                      <span class="tl-locked">
                        <IconLock size={16} /> {t("toolsLocked")}
                      </span>
                    ) : (
                      <div class={`tl-pick${busy ? " busy" : ""}`}>
                        <Seg<Pick>
                          label={toolName(e.id)}
                          value={e.own ?? "default"}
                          onChange={(p) => void choose(e, p)}
                          options={[
                            ["default", e.global ? t("toolsDefaultOn") : t("toolsDefaultOff")],
                            ["on", t("toolsAlways")],
                            ["off", t("toolsOff")],
                          ]}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
