// An agent's Tools tab (G34.5, the person: «Ovviamente devo poter scegliere agente per agente»): each
// of its tools as for every agent, always on for it, or off; the essential ones locked, with why.
// On top, what its tools weigh on every message now. New conversations only.
import type { AgentEditMode, AgentToolState, EditorSettings, ToolView } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { IconArrowRight, IconLock } from "../icons.js";
import { attempt, getApi, openTab } from "../state.js";
import { Seg } from "./SettingsKit.js";
import {
  aboutTokens,
  NewOnly,
  ToolGroups,
  ToolSearch,
  ToolText,
  toolName,
  useToolsView,
} from "./ToolsPage.js";

type Pick = "default" | AgentToolState;

/**
 * The rule for this agent's edits of files open in the Canvas (G37.1): right away (highlighted,
 * undoable) or as proposals the person accepts. A file's own choice, in its editor, wins.
 */
export function AgentEditRule({ agent }: { agent: Agent }) {
  const [s, setS] = useState<EditorSettings>();
  useEffect(() => {
    void getApi()
      .editorSettings()
      .then(
        (r) => setS(r.settings),
        () => {},
      );
  }, [agent.id]);
  if (!s) return null;
  const pick = (mode: AgentEditMode) => {
    const next = { ...s, agents: { ...s.agents } };
    if (mode === "now") delete next.agents[agent.id];
    else next.agents[agent.id] = mode;
    setS(next);
    void attempt(() => getApi().setEditorSettings(next));
  };
  return (
    <section class="tl-section tl-edit-rule">
      <h4>{t("stEditorTitle")}</h4>
      <p class="tl-lead">{t("stEditorLead")}</p>
      <Seg
        value={s.agents[agent.id] ?? "now"}
        label={t("stEditorTitle")}
        options={[
          ["now", t("docModeNow")],
          ["propose", t("docModePropose")],
        ]}
        onChange={pick}
      />
    </section>
  );
}

export function AgentTools({ agent }: { agent: Agent }) {
  const { view, setView, error, setError, load } = useToolsView(agent.id);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
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
          <AgentEditRule agent={agent} />
          <button
            type="button"
            class="wz-btn small tl-all"
            onClick={() =>
              openTab({ id: "settings", type: "settings", title: t("settings"), section: "tools" })
            }
          >
            {t("toolsOpenAll")} <IconArrowRight size={16} />
          </button>
          <ToolSearch q={q} onChange={setQ} />
          <ToolGroups
            entries={view.entries}
            q={q}
            row={(e) => (
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
            )}
          />
        </>
      )}
    </div>
  );
}
