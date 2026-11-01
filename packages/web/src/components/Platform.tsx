import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { t } from "../i18n.js";
import { agents, attempt, getApi, platformInfo, platformVersion } from "../state.js";

const STAGES: PlatformChange["stage"][] = [
  "proposed",
  "tested",
  "failed",
  "promoted",
  "rolled_back",
  "discarded",
  "undone",
];
const stageLabel = (s: PlatformChange["stage"]) =>
  t("changeStages").split(",")[STAGES.indexOf(s)] ?? s;
const stageClass = (s: PlatformChange["stage"]) =>
  s === "promoted" || s === "tested"
    ? "resolved"
    : s === "failed" || s === "rolled_back"
      ? "blocked"
      : "";
const who = (id: string) =>
  id === "human"
    ? t("you")
    : id === "supervisor"
      ? t("supervisorName")
      : (agents.value.find((a) => a.id === id)?.name ?? id);
const json = (v: unknown) => (v === undefined || v === null ? "—" : JSON.stringify(v, null, 2));

function ChangeCard({ c }: { c: PlatformChange }) {
  const canUndo = c.kind === "config" && c.stage === "promoted" && c.before !== null;
  const canDiscard =
    c.kind === "code" && ["proposed", "tested", "failed", "rolled_back"].includes(c.stage);
  return (
    <article class={`post ${c.stage === "failed" || c.stage === "rolled_back" ? "blocker" : ""}`}>
      <div class="post-head">
        <span class={`status-chip ${stageClass(c.stage)}`}>{stageLabel(c.stage)}</span>
        <span class="kind-badge">{c.kind === "code" ? t("code") : t("configuration")}</span>
        <strong>{c.change}</strong>
        <span class="dim">
          {who(c.by)} · {new Date(c.updatedAt).toLocaleString()}
        </span>
        <div class="spacer" />
        {canUndo && (
          <button
            type="button"
            class="tiny"
            onClick={() => void attempt(() => getApi().undoChange(c.id))}
          >
            {t("undo")}
          </button>
        )}
        {canDiscard && (
          <button
            type="button"
            class="tiny danger"
            onClick={() => void attempt(() => getApi().discardChange(c.id))}
          >
            {t("discard")}
          </button>
        )}
      </div>
      {c.kind === "config" && c.before !== undefined && (
        <div class="change-diff">
          <div>
            <span class="dim">{t("before")}</span>
            <pre>{json(c.before)}</pre>
          </div>
          <div>
            <span class="dim">{t("after")}</span>
            <pre>{json(c.after)}</pre>
          </div>
        </div>
      )}
      {c.detail && (
        <details>
          <summary>{t("details")}</summary>
          <pre>{c.detail}</pre>
        </details>
      )}
    </article>
  );
}

/** How the platform runs, God's changes to it (undo, discard) and the supervisor's releases. */
export function Platform() {
  const [changes, setChanges] = useState<PlatformChange[]>([]);
  const version = platformVersion.value;
  useEffect(() => {
    void attempt(() => getApi().platformChanges()).then((l) => l && setChanges(l));
    void attempt(() => getApi().platform()).then((p) => {
      if (p) platformInfo.value = p;
    });
  }, [version]);
  const info = platformInfo.value;
  return (
    <div class="platform">
      {info && (
        <div class="platform-status">
          <span class={`chip ${info.sandbox === "host" ? "danger" : ""}`}>
            {t("sandbox")}: {info.sandbox}
          </span>
          {info.metal && <span class="chip danger">{t("metal")}</span>}
          <span class={`chip ${info.supervised ? "" : "muted"}`}>
            {info.supervised ? t("supervised") : t("notSupervised")}
          </span>
          {info.lastGood && (
            <span class="chip muted">
              {t("lastGood")}: <code>{info.lastGood.slice(0, 8)}</code>
            </span>
          )}
        </div>
      )}
      <h4>{t("platformChanges")}</h4>
      {changes.length === 0 ? (
        <div class="empty">{t("noChanges")}</div>
      ) : (
        <div class="posts">
          {changes.map((c) => (
            <ChangeCard key={c.id} c={c} />
          ))}
        </div>
      )}
      {info && info.releases.length > 0 && (
        <>
          <h4>{t("releases")}</h4>
          <div class="posts">
            {info.releases.map((r) => (
              <div key={`${r.commit}-${r.at}`} class="post-head">
                <span class={`status-chip ${r.result === "promoted" ? "resolved" : "blocked"}`}>
                  {stageLabel(r.result)}
                </span>
                <code>{r.commit.slice(0, 8)}</code>
                <span class="dim">{new Date(r.at).toLocaleString()}</span>
                {r.reason && <span class="dim">{r.reason.split("\n")[0]}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
