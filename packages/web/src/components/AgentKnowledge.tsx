// An agent's Knowledge tab (G36.5): every collection, whether this agent reads it by the
// collection's own «for whom», and the person's choice for this agent on top: as the collection
// says, always, or never. It takes effect in the agent's next conversation.
import type { KnowledgeAgentCollection } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { t } from "../i18n.js";
import { IconArrowRight, IconInfo } from "../icons.js";
import { getApi, openTab } from "../state.js";
import { scopeWords } from "./Knowledge.js";
import { Seg } from "./SettingsKit.js";

type Pick = "default" | "on" | "off";

export function AgentKnowledge({ agent }: { agent: Agent }) {
  const [list, setList] = useState<KnowledgeAgentCollection[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void getApi()
      .agentKnowledge(agent.id)
      .then((r) => setList(r.collections))
      .catch((err) => setError((err as Error).message));
  }, [agent.id]);
  const choose = async (c: KnowledgeAgentCollection, pick: Pick) => {
    const own = pick === "default" ? null : pick;
    setList((l) =>
      l?.map((x) => (x.id === c.id ? { ...x, own, on: own ? own === "on" : x.byScope } : x)),
    );
    try {
      setList((await getApi().setAgentKnowledge(agent.id, c.id, own)).collections);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const reads = list?.filter((c) => c.on).length ?? 0;
  return (
    <div class="kb-agent">
      <p class="tl-lead">{t("kbAgentLead", { name: agent.name })}</p>
      {error && <p class="tl-error">{error}</p>}
      {!list && !error && <p class="tl-loading">{t("kbLoading")}</p>}
      {list && (
        <>
          <div class="tl-sum">
            <div class="tl-sum-box">
              <b>
                {reads === 0
                  ? t("kbAgentNone", { name: agent.name })
                  : t("kbAgentReads", { name: agent.name, n: String(reads) })}
              </b>
              <span>{t("kbAgentTool")}</span>
            </div>
          </div>
          <p class="tl-note">
            <IconInfo size={18} /> {t("kbAgentNewOnly")}
          </p>
          <button
            type="button"
            class="wz-btn small tl-all"
            onClick={() =>
              openTab({
                id: "settings",
                type: "settings",
                title: t("settings"),
                section: "knowledge",
              })
            }
          >
            {t("kbAgentOpenAll")} <IconArrowRight size={16} />
          </button>
          {list.length === 0 && <p class="kb-dim">{t("kbNoCols")}</p>}
          <div class="tl-list">
            {list.map((c) => (
              <div
                key={c.id}
                class={`tl-row tl-row-agent${c.on ? " on" : ""}`}
                data-collection={c.id}
              >
                <div class="tl-text">
                  <b>{c.name}</b>
                  <span>{scopeWords(c.scope)}</span>
                  <small class="tl-weight">
                    {t("kbAgentPieces", { n: c.chunks.toLocaleString() })}
                  </small>
                </div>
                <div class="tl-pick">
                  <Seg<Pick>
                    label={c.name}
                    value={c.own ?? "default"}
                    onChange={(p) => void choose(c, p)}
                    options={[
                      ["default", c.byScope ? t("kbAgentByScopeYes") : t("kbAgentByScopeNo")],
                      ["on", t("kbAgentAlways")],
                      ["off", t("kbAgentNever")],
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
