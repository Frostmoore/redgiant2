// Web search, voice messages and pictures (Settings, General): out of the wizard since G24.2,
// because most people never change them. Each field says what it is for; since 2026-11-06 each
// service has its own window there (a square of the wizard).
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { attempt, getApi } from "../state.js";
import { explain } from "./Brain.js";
import { SearchSettings } from "./SearchSettings.js";
import { Acts } from "./SettingsKit.js";
import { Field, JobView, useJob } from "./ui.js";

/**
 * RedGiant's own search engine (SearXNG in Docker, 2026-11-03): one button, the steps with
 * their bar, then every agent and the Chat can search the web, local models too.
 */
export function OwnSearch({ s, onChange }: { s: SetupState; onChange: (url: string) => void }) {
  const [jobId, setJobId] = useState<string>();
  const [on, setOn] = useState(!!s.config.searxngManaged);
  const job = useJob(jobId);
  useEffect(() => {
    if (job?.state === "done") {
      setOn(true);
      void getApi()
        .setup()
        .then(
          (x) => onChange(x.config.searxngUrl ?? ""),
          () => {},
        );
    }
  }, [job?.state]);
  if (!s.canRunSearch) return null;
  return (
    <div class="own-search">
      <p class="ui-help">{on ? t("ownSearchOn") : t("ownSearchHint")}</p>
      {job?.state !== "running" &&
        (on ? (
          <button
            type="button"
            onClick={() =>
              void attempt(() => getApi().stopSearch()).then(() => {
                setOn(false);
                onChange("");
              })
            }
          >
            {t("ownSearchStop")}
          </button>
        ) : (
          <button
            type="button"
            class="primary"
            onClick={() =>
              void attempt(() => getApi().startSearch()).then((j) => j && setJobId(j.id))
            }
          >
            {t("ownSearchStart")}
          </button>
        ))}
      {job && job.state !== "done" && <JobView job={job} />}
    </div>
  );
}

/**
 * One of the services (Settings, General, 2026-11-06): web search, voice messages or pictures,
 * each in its own window; voice and pictures are saved alone, the others left as they are.
 */
export function ServicePanel({
  s,
  part,
  onSaved,
}: {
  s: SetupState;
  part: "search" | "voice" | "images";
  onSaved: () => void;
}) {
  const [voiceApi, setVoiceApi] = useState(s.config.transcription?.api ?? "whisper-asr");
  const [voiceUrl, setVoiceUrl] = useState(s.config.transcription?.url ?? "");
  const [voiceModel, setVoiceModel] = useState(s.config.transcription?.model ?? "");
  const [voiceKey, setVoiceKey] = useState("");
  const [imagesKey, setImagesKey] = useState("");
  const [imagesModel, setImagesModel] = useState(s.config.imagesModel ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setResult(undefined);
    try {
      await getApi().setupModels({
        ...(part === "images" &&
          !s.locked.images &&
          (imagesKey || imagesModel !== (s.config.imagesModel ?? "")) && {
            images: {
              ...(imagesKey && { key: imagesKey }),
              ...(imagesModel.trim() && { model: imagesModel.trim() }),
            },
          }),
        ...(part === "voice" &&
          !s.locked.voice && {
            transcription:
              voiceApi === "local"
                ? { api: "local", url: "" }
                : voiceUrl.trim()
                  ? {
                      api: voiceApi,
                      url: voiceUrl.trim(),
                      ...(voiceModel.trim() && { model: voiceModel.trim() }),
                      ...(voiceKey && { key: voiceKey }),
                    }
                  : null,
          }),
      });
      setResult({ ok: true, text: t("saved") });
      onSaved();
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  if (part === "search")
    return (
      <div class="services">
        <p class="wz-lead2">{t("stGenSearchText")}</p>
        <OwnSearch s={s} onChange={onSaved} />
        <SearchSettings s={s} onSaved={onSaved} />
      </div>
    );
  const locked = part === "voice" ? s.locked.voice : s.locked.images;
  return (
    <form class="services" onSubmit={(e) => void save(e)}>
      {part === "voice" ? (
        <>
          <p class="wz-lead2">{t("servicesVoiceHelp")}</p>
          <Field label={t("servicesVoiceService")}>
            <select
              disabled={s.locked.voice}
              value={voiceApi}
              onChange={(e) =>
                setVoiceApi(
                  (e.target as HTMLSelectElement).value as "whisper-asr" | "openai" | "local",
                )
              }
            >
              <option value="local">{t("voiceLocal")}</option>
              <option value="whisper-asr">whisper-asr-webservice</option>
              <option value="openai">{t("wzVoiceOpenai")}</option>
            </select>
          </Field>
          {voiceApi === "local" && <p class="ui-help">{t("voiceLocalHint")}</p>}
          {voiceApi !== "local" && (
            <Field label={t("servicesVoiceUrl")} help={s.locked.voice ? t("wzLocked") : undefined}>
              <input
                placeholder={
                  voiceApi === "openai" ? "https://api.openai.com/v1" : "http://whisper-asr:9000"
                }
                disabled={s.locked.voice}
                value={voiceUrl}
                onInput={(e) => setVoiceUrl((e.target as HTMLInputElement).value)}
              />
            </Field>
          )}
          {voiceApi === "openai" && (
            <>
              <Field label={t("wzVoiceModel")}>
                <input
                  placeholder="whisper-1"
                  disabled={s.locked.voice}
                  value={voiceModel}
                  onInput={(e) => setVoiceModel((e.target as HTMLInputElement).value)}
                />
              </Field>
              <Field
                label={t("wzVoiceKey")}
                help={s.secretsSet.transcription ? t("wzAlreadySet") : undefined}
              >
                <input
                  type="password"
                  autocomplete="off"
                  disabled={s.locked.voice}
                  value={voiceKey}
                  onInput={(e) => setVoiceKey((e.target as HTMLInputElement).value)}
                />
              </Field>
            </>
          )}
        </>
      ) : (
        <>
          <p class="wz-lead2">{t("servicesImagesHelp")}</p>
          <Field
            label={t("wzImagesKey")}
            help={s.secretsSet.images ? t("wzAlreadySet") : undefined}
          >
            <input
              type="password"
              autocomplete="off"
              placeholder="sk-…"
              disabled={s.locked.images}
              value={imagesKey}
              onInput={(e) => setImagesKey((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field label={t("wzImagesModel")}>
            <input
              placeholder="gpt-image-2.5-flare"
              disabled={s.locked.images}
              value={imagesModel}
              onInput={(e) => setImagesModel((e.target as HTMLInputElement).value)}
            />
          </Field>
        </>
      )}
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
      <Acts>
        <button type="submit" class="wz-btn primary" disabled={busy || locked}>
          {t("save")}
        </button>
      </Acts>
    </form>
  );
}
