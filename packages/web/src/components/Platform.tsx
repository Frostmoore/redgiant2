// The history of changes (G24.10): every change to the settings, made by the person or by God,
// written as sentences and undoable; God's code changes explained apart, with "Promote" once
// their tests pass. The raw data stays under "Technical details".
import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { codeStageText, describeChange, type Names } from "../changes.js";
import { t } from "../i18n.js";
import { agents, attempt, getApi, platformInfo, platformVersion, projects } from "../state.js";
import { Advanced } from "./ui.js";

const names: Names = {
  agent: (id) => agents.value.find((a) => a.id === id)?.name ?? id,
  project: (id) => projects.value.find((p) => p.id === id)?.name ?? id,
};
const who = (id: string) =>
  id === "human"
    ? t("you")
    : id === "supervisor"
      ? t("supervisorName")
      : (agents.value.find((a) => a.id === id)?.name ?? id);
const json = (v: unknown) => (v === undefined || v === null ? "—" : JSON.stringify(v, null, 2));
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ConfigChange({ c, onDone }: { c: PlatformChange; onDone: () => void }) {
  const canUndo = c.stage === "promoted" && c.before !== undefined;
  return (
    <article class={`history-item${c.stage === "undone" ? " undone" : ""}`}>
      <div class="history-text">
        {describeChange(c, names).map((line) => (
          <div key={line}>{line}</div>
        ))}
        <div class="dim">
          {who(c.by)} · {when(c.createdAt)}
          {c.stage === "undone" && ` · ${t("historyUndone")}`}
        </div>
      </div>
      {canUndo && (
        <button
          type="button"
          class="tiny"
          onClick={() => void attempt(() => getApi().undoChange(c.id)).then(onDone)}
        >
          {t("undo")}
        </button>
      )}
      <Advanced label={t("historyTechnical")}>
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
        {c.detail && <pre>{c.detail}</pre>}
      </Advanced>
    </article>
  );
}

function CodeChange({
  c,
  supervised,
  onDone,
}: {
  c: PlatformChange;
  supervised: boolean;
  onDone: () => void;
}) {
  const open = ["proposed", "tested", "failed", "rolled_back"].includes(c.stage);
  const bad = c.stage === "failed" || c.stage === "rolled_back";
  return (
    <article class={`history-item code${bad ? " bad" : ""}`}>
      <div class="history-text">
        <div>{describeChange(c, names)[0]}</div>
        <div class={bad ? "notice error" : c.stage === "tested" ? "notice ok" : "dim"}>
          {codeStageText(c.stage)}
        </div>
        <div class="dim">
          {who(c.by)} · {when(c.updatedAt)}
        </div>
      </div>
      {open && (
        <div class="row">
          {c.stage === "tested" && supervised && (
            <button
              type="button"
              class="tiny primary"
              onClick={() => {
                if (confirm(t("historyPromoteConfirm")))
                  void attempt(() => getApi().promoteChange(c.id)).then(onDone);
              }}
            >
              {t("historyPromote")}
            </button>
          )}
          <button
            type="button"
            class="tiny danger"
            onClick={() => void attempt(() => getApi().discardChange(c.id)).then(onDone)}
          >
            {t("discard")}
          </button>
        </div>
      )}
      {c.stage === "tested" && !supervised && <p class="ui-help">{t("notSupervised")}</p>}
      {c.detail && (
        <Advanced label={t("historyTechnical")}>
          <pre>{c.detail}</pre>
        </Advanced>
      )}
    </article>
  );
}

/** Every change to the settings and to RedGiant's code, newest first. */
export function Platform() {
  const [changes, setChanges] = useState<PlatformChange[]>([]);
  const [version, setVersion] = useState(0);
  const pushed = platformVersion.value;
  useEffect(() => {
    void attempt(() => getApi().platformChanges()).then((l) => l && setChanges(l));
    void attempt(() => getApi().platform()).then((p) => {
      if (p) platformInfo.value = p;
    });
  }, [pushed, version]);
  const reload = () => setVersion((v) => v + 1);
  const info = platformInfo.value;
  const code = changes.filter((c) => c.kind === "code");
  const config = changes.filter((c) => c.kind === "config");
  return (
    <div class="platform history">
      <p class="ui-help">{t("historyIntro")}</p>
      {code.length > 0 && (
        <>
          <h3>{t("historyCode")}</h3>
          <p class="ui-help">{t("historyCodeHelp")}</p>
          {code.map((c) => (
            <CodeChange key={c.id} c={c} supervised={info?.supervised ?? false} onDone={reload} />
          ))}
        </>
      )}
      <h3>{t("historySettings")}</h3>
      {config.length === 0 ? (
        <div class="empty">{t("noChanges")}</div>
      ) : (
        config.map((c) => <ConfigChange key={c.id} c={c} onDone={reload} />)
      )}
      {info && (
        <Advanced label={t("historyTechnical")}>
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
          {info.releases.length > 0 && (
            <>
              <h4>{t("releases")}</h4>
              {info.releases.map((r) => (
                <div key={`${r.commit}-${r.at}`} class="row">
                  <span class={`chip ${r.result === "promoted" ? "ok" : "danger"}`}>
                    {codeStageText(r.result)}
                  </span>
                  <code>{r.commit.slice(0, 8)}</code>
                  <span class="dim">{when(r.at)}</span>
                  {r.reason && <span class="dim">{r.reason.split("\n")[0]}</span>}
                </div>
              ))}
            </>
          )}
        </Advanced>
      )}
    </div>
  );
}
