import type { Automation, AutomationRun } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, automationsVersion, getApi, openTab } from "../state.js";

const STATUSES: AutomationRun["status"][] = ["running", "ok", "failed", "timeout", "skipped"];
const TRIGGERS: AutomationRun["trigger"][] = ["cron", "webhook", "manual", "missed"];
const statusLabel = (s: AutomationRun["status"]) =>
  t("runStatus").split(",")[STATUSES.indexOf(s)] ?? s;
const triggerLabel = (s: AutomationRun["trigger"]) =>
  t("runTriggers").split(",")[TRIGGERS.indexOf(s)] ?? s;
const chipClass = (s: AutomationRun["status"]) =>
  s === "ok" ? "resolved" : s === "running" || s === "skipped" ? "" : "blocked";
const when = (iso: string) => new Date(iso).toLocaleString();

const template = () => `name: morning-digest
description: What happened yesterday, every weekday morning
on:
  cron: "0 8 * * 1-5"
  timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
  webhook: false
# god, orchestrator (with project:), or an agent's name
agent: god
# model: anthropic/claude-sonnet-5-5
# effort: low
instructions: |
  Summarise what happened yesterday on every project: finished tasks, open problems,
  decisions on the board. Keep it short.
session: new
timeoutMinutes: 30
missed: skip
notify:
  when: always
`;

/** The agent a recipe talks to, as the server resolves it (for opening its sessions). */
function agentOf(a: Automation): string {
  const r = a.recipe;
  const want = r.agent.toLowerCase();
  const pool = agents.value.filter((x) => r.project === null || x.projectId === r.project);
  const found =
    want === "god" || want === "orchestrator"
      ? pool.find((x) => x.kind === want)
      : pool.find((x) => x.id === r.agent || x.name.toLowerCase() === want);
  return found?.id ?? "";
}

function Runs({ a }: { a: Automation }) {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const version = automationsVersion.value;
  useEffect(() => {
    void attempt(() => getApi().automationRuns(a.id)).then((r) => r && setRuns(r));
  }, [a.id, version]);
  if (runs.length === 0) return <div class="empty">{t("noRuns")}</div>;
  return (
    <div class="posts">
      {runs.map((r) => (
        <article
          key={r.id}
          class={`post ${r.status === "ok" ? "result" : r.status === "running" || r.status === "skipped" ? "" : "blocker"}`}
        >
          <div class="post-head">
            <span class={`status-chip ${chipClass(r.status)}`}>{statusLabel(r.status)}</span>
            <span class="kind-badge">{triggerLabel(r.trigger)}</span>
            <span class="dim">
              {when(r.startedAt)}
              {r.finishedAt &&
                ` · ${Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000))} s`}
            </span>
            <div class="spacer" />
            {r.sessionId && (
              <button
                type="button"
                class="tiny"
                onClick={() =>
                  openTab({
                    id: `chat:${r.sessionId}`,
                    type: "chat",
                    title: `⏰ ${a.name}`,
                    sessionId: r.sessionId ?? "",
                    agentId: agentOf(a),
                  })
                }
              >
                {t("openSession")}
              </button>
            )}
          </div>
          {r.summary && (
            <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary) }} />
          )}
        </article>
      ))}
    </div>
  );
}

/** Recipes (YAML) run by an agent on a schedule or a webhook, with their history. */
export function Automations() {
  const [list, setList] = useState<Automation[]>([]);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [yaml, setYaml] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const version = automationsVersion.value;
  const current = list.find((a) => a.id === open);

  const reload = () => void attempt(() => getApi().automations()).then((l) => l && setList(l));
  useEffect(reload, [version]);
  useEffect(() => {
    setSecret(null);
    setYaml(open === "new" ? template() : (list.find((a) => a.id === open)?.yaml ?? ""));
    // Only when another automation is opened: edits in progress survive live updates.
  }, [open]);

  const save = async () => {
    const r = await attempt(() =>
      current ? getApi().updateAutomation(current.id, yaml) : getApi().createAutomation(yaml),
    );
    if (!r) return;
    reload();
    setOpen(r.automation.id);
    // After setOpen: the secret is shown once, for the automation just saved.
    setTimeout(() => setSecret(r.webhookSecret ?? null), 0);
  };
  const hookUrl = current ? `${location.origin}/api/automations/${current.id}/hook` : "";

  return (
    <div class="board automations">
      <aside class="board-list">
        <button type="button" class="primary" onClick={() => setOpen("new")}>
          + {t("newAutomation")}
        </button>
        {list.length === 0 ? (
          <div class="empty">{t("noAutomations")}</div>
        ) : (
          list.map((a) => (
            <button
              type="button"
              key={a.id}
              class={`thread-item${open === a.id ? " selected" : ""}`}
              onClick={() => setOpen(a.id)}
            >
              <span class="row">
                <span class={`status-chip ${a.enabled ? "resolved" : ""}`}>
                  {a.enabled ? t("enabled") : t("disabled")}
                </span>
                {a.lastRun && (
                  <span class={`status-chip ${chipClass(a.lastRun.status)}`}>
                    {statusLabel(a.lastRun.status)}
                  </span>
                )}
              </span>
              <strong>{a.name}</strong>
              <span class="dim">
                {a.recipe.on.cron ? <code>{a.recipe.on.cron}</code> : t("neverScheduled")}
                {a.nextRunAt && ` · ${t("nextRun")} ${when(a.nextRunAt)}`}
              </span>
            </button>
          ))
        )}
      </aside>
      <section class="board-thread">
        {open === null ? (
          <div class="empty logo-empty">{t("automations")}</div>
        ) : (
          <>
            <header class="row">
              <h3>{current?.name ?? t("newAutomation")}</h3>
              <div class="spacer" />
              {current && (
                <>
                  <button
                    type="button"
                    onClick={() => void attempt(() => getApi().runAutomation(current.id))}
                  >
                    ▶ {t("runNow")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void attempt(() =>
                        getApi().enableAutomation(current.id, !current.enabled),
                      ).then(reload)
                    }
                  >
                    {current.enabled ? t("disable") : t("enable")}
                  </button>
                  <button
                    type="button"
                    class="danger"
                    onClick={() => {
                      if (!confirm(t("deleteAutomationConfirm"))) return;
                      void attempt(() => getApi().deleteAutomation(current.id)).then(() => {
                        setOpen(null);
                        reload();
                      });
                    }}
                  >
                    {t("delete")}
                  </button>
                </>
              )}
            </header>
            <textarea
              class="code recipe"
              spellcheck={false}
              rows={18}
              value={yaml}
              onInput={(e) => setYaml((e.target as HTMLTextAreaElement).value)}
            />
            <div class="row">
              <button type="button" class="primary" onClick={() => void save()}>
                {current ? t("save") : t("create")}
              </button>
            </div>
            {current?.recipe.on.webhook && (
              <div class="notice">
                {t("webhookUrl")}: <code>POST {hookUrl}</code>{" "}
                <button
                  type="button"
                  class="tiny"
                  onClick={() =>
                    void attempt(() => getApi().rotateAutomationSecret(current.id)).then(
                      (r) => r && setSecret(r.webhookSecret),
                    )
                  }
                >
                  {t("newSecret")}
                </button>
                {secret && (
                  <div>
                    {t("webhookSecretOnce")} <code>{secret}</code>
                  </div>
                )}
              </div>
            )}
            {current && (
              <>
                <h4>{t("runs")}</h4>
                <Runs a={current} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
