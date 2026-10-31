import { t } from "../i18n.js";
import { approvals, getLive } from "../state.js";

/** Requests that wait for the human; answering here answers everywhere. */
export function Approvals() {
  if (approvals.value.length === 0) return <div class="empty">{t("noApprovals")}</div>;
  return (
    <div class="approvals">
      {approvals.value.map((r) => (
        <div class="approval" key={r.requestId}>
          <div>
            <strong>{r.agentName}</strong> {t("wants")} <code>{r.tool}</code>
            {r.projectId && <span class="chip">{r.projectId}</span>}
          </div>
          <pre>{JSON.stringify(r.input, null, 2)}</pre>
          <div class="dim">
            {t("because")}: {r.reasons.join("; ")}
            {r.danger.length > 0 && <span class="chip danger">{r.danger.join(", ")}</span>}
          </div>
          <div class="row">
            <button
              type="button"
              class="primary"
              onClick={() =>
                getLive().send({
                  type: "permission.resolve",
                  requestId: r.requestId,
                  decision: "allow",
                  remember: false,
                })
              }
            >
              {t("allow")}
            </button>
            <button
              type="button"
              class="danger"
              onClick={() =>
                getLive().send({
                  type: "permission.resolve",
                  requestId: r.requestId,
                  decision: "deny",
                  remember: false,
                })
              }
            >
              {t("deny")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
