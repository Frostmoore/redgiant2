// Settings > Requests to you (G36.17, the person: «devo poter settare un tempo limite per le
// richieste a me e anche scegliere di non farmele proprio arrivare»; 2026-11-07: «Se le richieste
// sono attive devono arrivare ovunque, se non sono attive non devono arrivare da nessuna parte.
// Quelle speciali devono arrivare dovunque»). How agents' requests reach the person (approvals,
// questions, plans, tools, keys): everywhere (this page and every linked chat) with a time limit,
// or nowhere ("don't ask me anything") and the classifier decides. The truly dangerous requests
// (G36.17b, the person: «Solo le richieste VERAMENTE pericolose devono arrivare a me sempre e
// ovunque… Git push è attività ordinaria») are listed in plain words with examples: they reach
// the person everywhere in both modes; everyday work (a push, a message, a deploy, a key used for
// its site) is not on the list. Every decision taken without the person is listed after, with its
// reason. Saved as configuration: in the history, undoable.
import {
  type CriticalId,
  criticalWords,
  type RequestSettings,
  type UnattendedDecision,
} from "@redgiant/protocol";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { danger, lang, t } from "../i18n.js";
import {
  IconAlert,
  IconBell,
  IconClock,
  IconKey,
  IconMonitor,
  IconShield,
  IconTrash,
  IconWallet,
} from "../icons.js";
import { getApi, openSessionById } from "../state.js";
import { explain } from "./Brain.js";
import { spanWords } from "./CommandLimits.js";
import { modelName } from "./ModelMenu.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { Chips, Head, SCard, Seg, Sub, WzPage } from "./SettingsKit.js";

const MIN = 60_000;
const TIMES = [5 * MIN, 15 * MIN, 60 * MIN, 24 * 60 * MIN, null] as const;
const NONE = "none";

type Loaded = Awaited<ReturnType<ReturnType<typeof getApi>["requestSettings"]>>;

/** When, in the person's words and language. */
const when = (iso: string) =>
  new Date(iso).toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A drawn icon for each truly dangerous kind, so the list reads at a glance. */
const CRITICAL_ICONS: Record<CriticalId, (p: { size?: number }) => JSX.Element> = {
  "critical-system": IconMonitor,
  "critical-delete": IconTrash,
  "critical-secret": IconKey,
  "critical-payment": IconWallet,
  "critical-protections": IconShield,
};

/** The truly dangerous requests, each with its words and examples in the person's language. */
function CriticalList({ ids }: { ids: CriticalId[] }) {
  return (
    <ul class="rq-critical">
      {ids.map((id) => {
        const w = criticalWords(lang.value, id);
        const Icon = CRITICAL_ICONS[id] ?? IconAlert;
        return (
          <li key={id}>
            <span class="rq-critical-ic" aria-hidden="true">
              <Icon size={18} />
            </span>
            <div class="rq-critical-tx">
              <b>{w.name}</b>
              <p>{w.hint}</p>
              <p class="rq-critical-eg">
                {t("rqCriticalExamples")} {w.examples.join("; ")}.
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Decision({ d }: { d: UnattendedDecision }) {
  return (
    <li class={`rq-item${d.decision === "blocked" ? " blocked" : ""}`}>
      <div class="rq-item-hd">
        <span class={`rq-pill ${d.decision}`}>{t(`rqDecision_${d.decision}`)}</span>
        <b class="rq-agent">{d.agentName}</b>
        <span class="rq-kind">{t(`rqKind_${d.kind}`)}</span>
        <span class="rq-when">{when(d.createdAt)}</span>
      </div>
      <p class="rq-what">{d.what}</p>
      {d.danger.length > 0 && (
        <p class="rq-danger">{d.danger.map((x) => danger(x).name).join(" · ")}</p>
      )}
      <p class="rq-why">
        <span class="rq-by">
          {d.by === "classifier"
            ? d.model
              ? t("rqByModel", { model: modelName(d.model.split("/").slice(1).join("/")) })
              : t("rqByClassifier")
            : t("rqByTimeout")}
        </span>{" "}
        {d.reason}
      </p>
      {d.sessionId && (
        <div class="rq-acts">
          <button
            type="button"
            class="wz-btn small quiet"
            onClick={() => void openSessionById(d.sessionId as string, d.agentId)}
          >
            {t("rqOpenChat")}
          </button>
        </div>
      )}
    </li>
  );
}

export function RequestsPage() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [s, setS] = useState<RequestSettings>();
  const [all, setAll] = useState<UnattendedDecision[]>([]);
  const [saved, setSaved] = useState<PlatformChange | "undone">();
  const [error, setError] = useState<string>();
  const models = useModels();
  const load = async () => {
    try {
      const [r, a] = await Promise.all([getApi().requestSettings(), getApi().unattended()]);
      setLoaded(r);
      setS(r.settings);
      setAll(a);
    } catch (err) {
      setError(explain(err));
    }
  };
  useEffect(() => void load(), []);
  if (!s || !loaded)
    return (
      <WzPage>
        <Head q={t("rqPageQ")} lead={t("rqPageLead")} />
        {error ? <p class="notice error">{error}</p> : <p class="dim">{t("loading")}</p>}
      </WzPage>
    );
  const change = (next: Partial<RequestSettings>) => {
    setSaved(undefined);
    setS({ ...s, ...next });
  };
  const save = async () => {
    setError(undefined);
    try {
      setSaved(await getApi().setRequestSettings(s));
    } catch (err) {
      setError(explain(err));
    }
  };
  const undo = async () => {
    if (!saved || saved === "undone") return;
    try {
      await getApi().undoChange(saved.id);
      setSaved("undone");
      await load();
    } catch (err) {
      setError(explain(err));
    }
  };
  const ask = s.mode === "ask";
  const usesClassifier = !ask || (s.timeoutMs !== null && s.afterTimeout === "classifier");
  const lightModel = loaded.defaultModel ? modelName(loaded.defaultModel.model) : t("rqNoModel");
  return (
    <WzPage class="rq-page">
      <Head q={t("rqPageQ")} lead={t("rqPageLead")} />
      <div class="wz-safe rq-cards">
        <SCard icon={<IconBell size={22} />} title={t("rqModeTitle")} q={t("rqModeQ")}>
          <Seg
            vertical
            options={[
              ["ask", t("rqModeAsk")],
              ["classifier", t("rqModeClassifier")],
            ]}
            value={s.mode}
            onChange={(mode) => change({ mode })}
          />
          <p class="wz-say">{ask ? t("rqModeAskText") : t("rqModeClassifierText")}</p>
          {!ask && <p class="cl-warn">{t("rqModeClassifierWarn")}</p>}
        </SCard>

        <SCard
          icon={<IconClock size={22} />}
          title={t("rqTimeTitle")}
          q={ask ? t("rqTimeQ") : t("rqTimeQSpecial")}
        >
          <Chips
            options={TIMES.map((v) => ({
              id: v === null ? NONE : String(v),
              label: v === null ? t("cmdNoLimit") : spanWords(v),
            }))}
            value={[s.timeoutMs === null ? NONE : String(s.timeoutMs)]}
            onChange={([v]) => change({ timeoutMs: !v || v === NONE ? null : Number(v) })}
          />
          {s.timeoutMs === null ? (
            <p class="wz-say">{ask ? t("rqTimeNone") : t("rqTimeNoneSpecial")}</p>
          ) : !ask ? (
            <p class="wz-say">{t("rqAfterSpecialText", { time: spanWords(s.timeoutMs) })}</p>
          ) : (
            <>
              <p class="wz-lb rq-after-q">{t("rqAfterQ", { time: spanWords(s.timeoutMs) })}</p>
              <Seg
                vertical
                options={[
                  ["no", t("rqAfterNo")],
                  ["classifier", t("rqAfterClassifier")],
                ]}
                value={s.afterTimeout}
                onChange={(afterTimeout) => change({ afterTimeout })}
              />
              <p class="wz-say">
                {s.afterTimeout === "no" ? t("rqAfterNoText") : t("rqAfterClassifierText")}
              </p>
            </>
          )}
        </SCard>

        <SCard icon={<IconAlert size={22} />} title={t("rqSpecialTitle")} q={t("rqSpecialQ")}>
          <p class="wz-say">{t("rqSpecialText")}</p>
          <CriticalList ids={loaded.critical} />
          <p class="wz-say rq-critical-not">{t("rqSpecialNot")}</p>
        </SCard>

        {usesClassifier && (
          <SCard
            icon={<IconShield size={22} />}
            title={t("rqClassifierTitle")}
            q={t("rqClassifierQ")}
          >
            <div class="st-field">
              <span class="wz-lb">{t("rqClassifierModel")}</span>
              {models ? (
                <ModelSelect
                  value={(s.classifierModel as Spec | undefined) ?? null}
                  onChange={(m) => {
                    const { classifierModel: _was, ...rest } = s;
                    setSaved(undefined);
                    setS(m ? { ...rest, classifierModel: m as never } : rest);
                  }}
                  empty={t("rqClassifierDefault", { model: lightModel })}
                  label={t("rqClassifierModel")}
                  models={models}
                />
              ) : (
                <span class="dim">{t("loading")}</span>
              )}
            </div>
            <p class="wz-say">{t("rqClassifierHow")}</p>
          </SCard>
        )}
      </div>
      {error && <p class="notice error">{error}</p>}
      <div class="cl-acts">
        <button type="button" class="wz-btn primary" onClick={() => void save()}>
          {t("save")}
        </button>
        {saved && saved !== "undone" && (
          <span class="cl-saved">
            {t("rqSaved")}{" "}
            <button type="button" class="wz-link inl" onClick={() => void undo()}>
              {t("cmdUndo")}
            </button>
          </span>
        )}
        {saved === "undone" && <span class="cl-saved">{t("cmdUndone")}</span>}
      </div>

      <Sub title={t("rqDoneTitle")} lead={t("rqDoneLead")} />
      {all.length ? (
        <ul class="rq-list">
          {all.slice(0, 50).map((d) => (
            <Decision key={d.id} d={d} />
          ))}
        </ul>
      ) : (
        <p class="rq-empty">{t("rqDoneEmpty")}</p>
      )}
    </WzPage>
  );
}
