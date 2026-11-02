// Web search, voice messages and pictures (Settings, General): out of the wizard since G24.2,
// because most people never change them. Each field says what it is for.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { t } from "../i18n.js";
import { getApi } from "../state.js";
import { explain } from "./Brain.js";
import { Field } from "./ui.js";

export function Services() {
  const [s, setS] = useState<SetupState | null>(null);
  useEffect(() => {
    void getApi()
      .setup()
      .then(setS, () => {});
  }, []);
  return s ? <ServicesForm s={s} /> : null;
}

function ServicesForm({ s }: { s: SetupState }) {
  const [searx, setSearx] = useState(s.config.searxngUrl ?? "");
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
        ...(!s.locked.search && { searxngUrl: searx.trim() || null }),
        ...(!s.locked.images &&
          (imagesKey || imagesModel !== (s.config.imagesModel ?? "")) && {
            images: {
              ...(imagesKey && { key: imagesKey }),
              ...(imagesModel.trim() && { model: imagesModel.trim() }),
            },
          }),
        ...(!s.locked.voice && {
          transcription: voiceUrl.trim()
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
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    }
    setBusy(false);
  };
  return (
    <form class="services" onSubmit={(e) => void save(e)}>
      <h2>{t("servicesTitle")}</h2>
      <p class="ui-help">{t("servicesHint")}</p>
      <div class="brain-panel">
        <h3>{t("servicesSearch")}</h3>
        <Field
          label={t("servicesSearchUrl")}
          help={s.locked.search ? t("wzLocked") : t("servicesSearchHelp")}
        >
          <input
            placeholder="http://searxng:8080"
            disabled={s.locked.search}
            value={searx}
            onInput={(e) => setSearx((e.target as HTMLInputElement).value)}
          />
        </Field>
      </div>
      <div class="brain-panel">
        <h3>{t("servicesVoice")}</h3>
        <p class="ui-help">{t("servicesVoiceHelp")}</p>
        <div class="form">
          <Field label={t("servicesVoiceService")}>
            <select
              disabled={s.locked.voice}
              value={voiceApi}
              onChange={(e) =>
                setVoiceApi((e.target as HTMLSelectElement).value as "whisper-asr" | "openai")
              }
            >
              <option value="whisper-asr">whisper-asr-webservice</option>
              <option value="openai">{t("wzVoiceOpenai")}</option>
            </select>
          </Field>
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
        </div>
      </div>
      <div class="brain-panel">
        <h3>{t("servicesImages")}</h3>
        <p class="ui-help">{t("servicesImagesHelp")}</p>
        <div class="form">
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
        </div>
      </div>
      <div class="row">
        <button type="submit" class="primary" disabled={busy}>
          {t("save")}
        </button>
      </div>
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
    </form>
  );
}
