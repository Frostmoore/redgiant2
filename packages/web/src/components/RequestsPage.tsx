// Settings > Requests to you (G36.17, the person: «devo poter settare un tempo limite per le
// richieste a me e anche scegliere di non farmele proprio arrivare»). How agents' requests reach
// the person (approvals, questions, plans, tools, keys): asked on the chosen channels with a time
// limit, or "don't ask me anything" and the classifier decides. What the classifier never
// approves is listed; what it blocked waits in «To review»; every decision taken without the
// person is listed after, with its reason. Saved as configuration: in the history, undoable.
import type { RequestSettings, UnattendedDecision } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { PlatformChange } from "../api.js";
import { danger, lang, t } from "../i18n.js";
import { IconBell, IconChat, IconClock, IconShield } from "../icons.js";
import { getApi, openSession } from "../state.js";
import { explain } from "./Brain.js";
import { spanWords } from "./CommandLimits.js";
import { modelName } from "./ModelMenu.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { Chips, Head, SCard, Seg, Sub, SwitchRow, WzPage } from "./SettingsKit.js";

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

function Decision({ d, onSeen }: { d: UnattendedDecision; onSeen?: () => void }) {
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
      {(onSeen || d.sessionId) && (
        <div class="rq-acts">
          {d.sessionId && (
            <button
              type="button"
              class="wz-btn small quiet"
              onClick={() =>
                openSession({ id: d.sessionId as string, agentId: d.agentId, title: null })
              }
            >
              {t("rqOpenChat")}
            </button>
          )}
          {onSeen && (
            <button type="button" class="wz-btn small primary" onClick={onSeen}>
              {t("rqSeen")}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function RequestsPage() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [s, setS] = useState<RequestSettings>();
  const [review, setReview] = useState<UnattendedDecision[]>([]);
  const [all, setAll] = useState<UnattendedDecision[]>([]);
  const [saved, setSaved] = useState<PlatformChange | "undone">();
  const [error, setError] = useState<string>();
  const models = useModels();
  const load = async () => {
    try {
      const [r, rv, a] = await Promise.all([
        getApi().requestSettings(),
        getApi().unattended(true),
        getApi().unattended(),
      ]);
      setLoaded(r);
      setS(r.settings);
      setReview(rv);
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
  const seen = async (id: string) => {
    try {
      await getApi().unattendedSeen(id);
      setReview(review.filter((d) => d.id !== id));
    } catch (err) {
      setError(explain(err));
    }
  };
  const ask = s.mode === "ask";
  const usesClassifier = !ask || (s.timeoutMs !== null && s.afterTimeout === "classifier");
  const lightModel = loaded.defaultModel ? modelName(loaded.defaultModel.model) : t("rqNoModel");
  const noChannel = ask && !s.channels.web && !s.channels.chats;
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

        {ask && (
          <SCard icon={<IconClock size={22} />} title={t("rqTimeTitle")} q={t("rqTimeQ")}>
            <Chips
              options={TIMES.map((v) => ({
                id: v === null ? NONE : String(v),
                label: v === null ? t("cmdNoLimit") : spanWords(v),
              }))}
              value={[s.timeoutMs === null ? NONE : String(s.timeoutMs)]}
              onChange={([v]) => change({ timeoutMs: !v || v === NONE ? null : Number(v) })}
            />
            {s.timeoutMs === null ? (
              <p class="wz-say">{t("rqTimeNone")}</p>
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
        )}

        {ask && (
          <SCard icon={<IconChat size={22} />} title={t("rqWhereTitle")} q={t("rqWhereQ")}>
            <div class="rq-switches">
              <SwitchRow
                title={t("rqWhereWeb")}
                help={t("rqWhereWebHelp")}
                on={s.channels.web}
                onChange={(web) => change({ channels: { ...s.channels, web } })}
              />
              <SwitchRow
                title={t("rqWhereChats")}
                help={t("rqWhereChatsHelp")}
                on={s.channels.chats}
                onChange={(chats) => change({ channels: { ...s.channels, chats } })}
              />
            </div>
            {noChannel && <p class="cl-warn">{t("rqWhereNone")}</p>}
          </SCard>
        )}

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
            <p class="wz-lb">{t("rqNeverTitle")}</p>
            <ul class="rq-never">
              {loaded.humanOnly.map((id) => (
                <li key={id}>{danger(id).name}</li>
              ))}
              <li>{t("rqNeverKeychain")}</li>
            </ul>
          </SCard>
        )}
      </div>
      {error && <p class="notice error">{error}</p>}
      <div class="cl-acts">
        <button
          type="button"
          class="wz-btn primary"
          disabled={noChannel}
          onClick={() => void save()}
        >
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

      <Sub
        title={
          review.length ? t("rqReviewTitleN", { n: String(review.length) }) : t("rqReviewTitle")
        }
        lead={t("rqReviewLead")}
      />
      {review.length ? (
        <ul class="rq-list">
          {review.map((d) => (
            <Decision key={d.id} d={d} onSeen={() => void seen(d.id)} />
          ))}
        </ul>
      ) : (
        <p class="rq-empty">{t("rqReviewEmpty")}</p>
      )}

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
