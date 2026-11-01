import { useEffect, useState } from "preact/hooks";
import type { Proposal } from "../api.js";
import { t } from "../i18n.js";
import { IconClose } from "../icons.js";
import { agents, approvals, attempt, getApi, openSession, openTab, sessionRows } from "../state.js";
import { PermissionCard } from "./Chat.js";

/**
 * Everything that waits for the human or is running now (Officina's bell): permission requests,
 * extensions proposed by agents, the conversations at work.
 */
export function Bell({ close }: { close: () => void }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const reload = () =>
    void attempt(() => getApi().proposals("pending")).then((p) => p && setProposals(p));
  useEffect(reload, []);
  const running = sessionRows.value.filter((r) => r.running);
  const name = (agentId: string) => agents.value.find((a) => a.id === agentId)?.name ?? agentId;
  return (
    <aside class="panel">
      <div class="panel-head">
        {t("waitingForYou")}
        <button type="button" class="icon-button" title={t("close")} onClick={close}>
          <IconClose size={18} />
        </button>
      </div>
      <h3>
        {t("permissions")} ({approvals.value.length})
      </h3>
      {approvals.value.length === 0 ? (
        <div class="dim">{t("noApprovals")}</div>
      ) : (
        approvals.value.map((r) => <PermissionCard key={r.requestId} r={r} />)
      )}
      <h3>
        {t("proposals")} ({proposals.length})
      </h3>
      {proposals.length === 0 ? (
        <div class="dim">{t("noProposals")}</div>
      ) : (
        proposals.map((p) => (
          <div key={p.id} class="card">
            <div class="card-head">
              <span class="chip">{p.kind}</span>
              <strong>{p.name}</strong>
              <button
                type="button"
                class="link"
                onClick={() => {
                  openTab({
                    id: "settings",
                    type: "settings",
                    title: t("settings"),
                    section: "extensions",
                  });
                  close();
                }}
              >
                {t("open")}
              </button>
            </div>
            <div class="dim">
              {p.input.spec?.description ?? p.input.description ?? ""} · {t("by")} {name(p.author)}
            </div>
            <div class="row" style={{ marginTop: "6px" }}>
              <button
                type="button"
                class="primary"
                onClick={() =>
                  void attempt(() => getApi().decideExtension(p.id, "approve")).then(reload)
                }
              >
                {t("approve")}
              </button>
              <button
                type="button"
                class="danger"
                onClick={() =>
                  void attempt(() => getApi().decideExtension(p.id, "reject")).then(reload)
                }
              >
                {t("reject")}
              </button>
            </div>
          </div>
        ))
      )}
      <h3>
        {t("workingNow")} ({running.length})
      </h3>
      {running.length === 0 ? (
        <div class="dim">{t("nothingRunning")}</div>
      ) : (
        running.map((r) => (
          <div key={r.id} class="live-row">
            <span class="dot running" />
            <button
              type="button"
              class="link"
              onClick={() => {
                openSession(r);
                close();
              }}
            >
              {name(r.agentId)}
            </button>
            <span class="dim">{r.title ?? ""}</span>
          </div>
        ))
      )}
    </aside>
  );
}
