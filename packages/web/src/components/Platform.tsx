// The history of changes (G24.10): every change to the settings, made by the person or by God,
// written as sentences and undoable; God's code changes explained apart, with "Promote" once
// their tests pass. The raw data stays under "Technical details". Drawn as the wizard
// (2026-11-06): a big heading, each change a card, promoting asked in a centred window.
import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { codeStageText, describeChange, type Names } from "../changes.js";
import { t } from "../i18n.js";
import { IconGit, IconSettings } from "../icons.js";
import { agents, attempt, getApi, platformInfo, platformVersion, projects } from "../state.js";
import { Acts, Head, Sub, WzPage } from "./SettingsKit.js";
import { Advanced, Modal } from "./ui.js";

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
    <article class={`sb-change${c.stage === "undone" ? " undone" : ""}`}>
      <div class="sb-change-hd">
        <span class="sb-change-av">
          <IconSettings size={20} />
        </span>
        <div class="sb-change-text">
          {describeChange(c, names).map((line) => (
            <div key={line} class="sb-change-line">
              {line}
            </div>
          ))}
          <div class="dim sb-change-meta">
            {who(c.by)} · {when(c.createdAt)}
            {c.stage === "undone" && ` · ${t("historyUndone")}`}
          </div>
        </div>
        {canUndo && (
          <button
            type="button"
            class="wz-btn small"
            onClick={() => void attempt(() => getApi().undoChange(c.id)).then(onDone)}
          >
            {t("undo")}
          </button>
        )}
      </div>
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
  const [asking, setAsking] = useState(false);
  const open = ["proposed", "tested", "failed", "rolled_back"].includes(c.stage);
  const bad = c.stage === "failed" || c.stage === "rolled_back";
  return (
    <article class={`sb-change code${bad ? " bad" : ""}${c.stage === "tested" ? " ready" : ""}`}>
      <div class="sb-change-hd">
        <span class="sb-change-av">
          <IconGit size={20} />
        </span>
        <div class="sb-change-text">
          <div class="sb-change-line">{describeChange(c, names)[0]}</div>
          <div class={`sb-stage${bad ? " bad" : c.stage === "tested" ? " ok" : ""}`}>
            {codeStageText(c.stage)}
          </div>
          <div class="dim sb-change-meta">
            {who(c.by)} · {when(c.updatedAt)}
          </div>
        </div>
      </div>
      {open && (
        <div class="sb-change-acts">
          <button
            type="button"
            class="wz-btn small quiet"
            onClick={() => void attempt(() => getApi().discardChange(c.id)).then(onDone)}
          >
            {t("discard")}
          </button>
          {c.stage === "tested" && supervised && (
            <button type="button" class="wz-btn small primary" onClick={() => setAsking(true)}>
              {t("historyPromote")}
            </button>
          )}
        </div>
      )}
      {asking && (
        <Modal title={t("historyPromote")} onClose={() => setAsking(false)}>
          <p class="wz-lead2">{describeChange(c, names)[0]}</p>
          <p class="wz-lead2">{t("historyPromoteConfirm")}</p>
          <Acts>
            {/* Not «Annulla»: in Italian that is also the word for undoing a change. */}
            <button type="button" class="wz-btn" onClick={() => setAsking(false)}>
              {t("wzNotNow")}
            </button>
            <button
              type="button"
              class="wz-btn primary"
              onClick={() => {
                setAsking(false);
                void attempt(() => getApi().promoteChange(c.id)).then(onDone);
              }}
            >
              {t("historyPromote")}
            </button>
          </Acts>
        </Modal>
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
    <WzPage class="sb-platform">
      <Head eyebrow={t("platformView")} q={t("sbPlatformQ")} lead={t("historyIntro")} />
      {code.length > 0 && (
        <>
          <Sub title={t("historyCode")} lead={t("historyCodeHelp")} />
          <div class="sb-list">
            {code.map((c) => (
              <CodeChange key={c.id} c={c} supervised={info?.supervised ?? false} onDone={reload} />
            ))}
          </div>
        </>
      )}
      <Sub title={t("historySettings")} />
      {config.length === 0 ? (
        <p class="wz-subl">{t("noChanges")}</p>
      ) : (
        <div class="sb-list">
          {config.map((c) => (
            <ConfigChange key={c.id} c={c} onDone={reload} />
          ))}
        </div>
      )}
      {info && (
        <div class="sb-list sb-tech">
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
        </div>
      )}
    </WzPage>
  );
}
