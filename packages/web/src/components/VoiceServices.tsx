// Settings › Voice (3.7.3): who writes down what the person says, and who reads the answers.
// Transcription is the server's (Telegram's voice notes use it too): whisper here or on another
// computer, any OpenAI-compatible service, or a provider in the cloud with a key already given
// (the chat's or the generation's) or one pasted here, kept in the keychain. Reading belongs to
// this device: the browser's voices, or a provider in the cloud through the server (the key never
// reaches the page). Every choice is one of our drawn cards; each part has its «Try».
import {
  type SpeechChoice,
  type TranscriptionChoice,
  VOICE_PROVIDERS,
  type VoicePrice,
  type VoiceProvider,
  type VoiceProviderId,
  voiceProvider,
  voicesForModel,
} from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { explain } from "../explain.js";
import { t } from "../i18n.js";
import { IconMic, IconSpeaker } from "../icons.js";
import { getApi, platformInfo } from "../state.js";
import { speak, speechProblem, tryTranscription, voicesFor } from "../voice/runtime.js";
import { setVoiceSettings, voiceSettings } from "../voice/settings.js";
import { Chips } from "./SettingsKit.js";
import { Choice, Field } from "./ui.js";

/** An indicative price in the person's words; nothing when it is not known. */
export function priceText(p: VoicePrice | undefined): string | undefined {
  if (!p) return undefined;
  const usd = `$${Number(p.usd.toPrecision(2))}`;
  return t(
    p.per === "minute" ? "vcPriceMinute" : p.per === "kchars" ? "vcPriceKchars" : "vcPriceMtokens",
    {
      usd,
    },
  );
}

const modelLabel = (m: { label: string; price?: VoicePrice; closes?: string }) => {
  const price = priceText(m.price);
  return price ? `${m.label} · ${price}` : m.label;
};

/** A provider's key: the one already given (the chat's, the generation's, the voice's) or a field. */
function VoiceKey({
  p,
  linked,
  disabled,
  value,
  onInput,
}: {
  p: VoiceProvider;
  linked: boolean;
  disabled?: boolean | undefined;
  value: string;
  onInput: (key: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  if (linked && !changing)
    return (
      <div class="vc-key">
        <p class="notice ok">{t("vcKeyLinked", { name: p.name })}</p>
        {!disabled && (
          <button type="button" class="link" onClick={() => setChanging(true)}>
            {t("vcKeyChange")}
          </button>
        )}
      </div>
    );
  return (
    <div class="vc-key">
      <Field label={t("vcKeyLabel", { name: p.name })} help={t("vcKeyHelp")}>
        <input
          type="password"
          autocomplete="off"
          placeholder={p.keyExample}
          disabled={disabled}
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        />
      </Field>
      <a class="button" href={p.keyUrl} target="_blank" rel="noreferrer">
        {t("vcKeyGet", { name: p.name })}
      </a>
    </div>
  );
}

type SttKind = "local" | "remote" | "compatible" | VoiceProviderId;

const STT_CLOUD = VOICE_PROVIDERS.filter((p) => p.stt?.length);

function kindOf(c: TranscriptionChoice | undefined): SttKind | undefined {
  if (!c) return undefined;
  if (c.api === "local") return "local";
  if (c.api === "whisper-asr") return "remote";
  if (c.api === "openai") return "compatible";
  return c.provider;
}

/** Who writes down what is said (the server's choice): the cards, their fields, Save and Try. */
export function TranscriptionPicker({ s, onSaved }: { s: SetupState; onSaved: () => void }) {
  const saved = s.config.transcription;
  const locked = Boolean(s.locked.voice);
  const [kind, setKind] = useState<SttKind | undefined>(kindOf(saved));
  const [url, setUrl] = useState(saved && saved.api !== "local" ? saved.url : "");
  const [model, setModel] = useState(
    saved?.api === "cloud" || saved?.api === "openai" ? (saved.model ?? "") : "",
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const cloud = kind ? voiceProvider(kind) : undefined;
  const linked = (id: string) => s.secretsSet.voice?.includes(id) ?? false;
  const models = cloud?.stt ?? [];
  const chosenModel = models.find((m) => m.id === model) ?? models[0];

  const body = (): Record<string, unknown> | null => {
    if (kind === "local") return { api: "local", url: "" };
    if (kind === "remote") return { api: "whisper-asr", url: url.trim() };
    if (kind === "compatible")
      return {
        api: "openai",
        url: url.trim(),
        ...(model.trim() && { model: model.trim() }),
        ...(key.trim() && { key: key.trim() }),
      };
    if (cloud && chosenModel)
      return {
        api: "cloud",
        url: "",
        provider: cloud.id,
        model: chosenModel.id,
        ...(key.trim() && { key: key.trim() }),
      };
    return null;
  };
  const missing =
    (kind === "remote" || kind === "compatible") && !url.trim()
      ? t("vcSttNeedsUrl")
      : cloud && !linked(cloud.id) && key.trim().length < 8
        ? t("vcSttNeedsKey", { name: cloud.name })
        : undefined;

  const save = async (): Promise<boolean> => {
    setResult(undefined);
    const b = body();
    if (!b || missing) {
      if (missing) setResult({ ok: false, text: missing });
      return false;
    }
    setBusy(true);
    try {
      await getApi().setupModels({ transcription: b });
      setKey("");
      onSaved();
      // The page's «needs a service» line follows at once.
      const info = platformInfo.value;
      if (info) platformInfo.value = { ...info, voice: true };
      setResult({ ok: true, text: t("saved") });
      return true;
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const tryIt = async () => {
    if (!(await save())) return;
    setBusy(true);
    setResult({ ok: true, text: t("vcSttTrySpeak") });
    try {
      const heard = await tryTranscription(4);
      setResult(
        heard
          ? { ok: true, text: t("vcSttHeard", { text: heard }) }
          : { ok: false, text: t("vcSttHeardNothing") },
      );
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const options = [
    {
      id: "local" as SttKind,
      title: t("vcSttLocal"),
      description: t("vcSttLocalHelp"),
    },
    {
      id: "remote" as SttKind,
      title: t("vcSttRemote"),
      description: t("vcSttRemoteHelp"),
    },
    ...STT_CLOUD.map((p) => ({
      id: p.id as SttKind,
      title: p.name,
      description: t("vcSttCloudHelp", {
        models: (p.stt ?? []).map((m) => m.label).join(", "),
        price: priceText(p.stt?.[0]?.price) ?? "",
      }),
      ...(linked(p.id) && { badge: t("vcHasKey") }),
    })),
    {
      id: "compatible" as SttKind,
      title: t("vcSttCompatible"),
      description: t("vcSttCompatibleHelp"),
    },
  ];
  return (
    <div class="vc-service">
      {locked && <p class="notice">{t("wzLocked")}</p>}
      <Choice<SttKind>
        options={options}
        value={kind ? [kind] : []}
        onChange={([k]) => {
          if (locked || !k) return;
          setKind(k);
          setResult(undefined);
          setModel(voiceProvider(k)?.stt?.[0]?.id ?? "");
        }}
      />
      {kind === "local" && <p class="ui-help">{t("voiceLocalHint")}</p>}
      {(kind === "remote" || kind === "compatible") && (
        <Field label={t("servicesVoiceUrl")}>
          <input
            placeholder={
              kind === "remote" ? "http://192.168.1.20:9000" : "http://192.168.1.20:8000/v1"
            }
            disabled={locked}
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </Field>
      )}
      {kind === "compatible" && (
        <>
          <Field label={t("wzVoiceModel")}>
            <input
              placeholder="whisper-1"
              disabled={locked}
              value={model}
              onInput={(e) => setModel((e.target as HTMLInputElement).value)}
            />
          </Field>
          <Field
            label={t("wzVoiceKey")}
            help={s.secretsSet.transcription ? t("wzAlreadySet") : t("vcKeyHelp")}
          >
            <input
              type="password"
              autocomplete="off"
              disabled={locked}
              value={key}
              onInput={(e) => setKey((e.target as HTMLInputElement).value)}
            />
          </Field>
        </>
      )}
      {cloud && (
        <>
          <p class="vc-label">{t("vcModel")}</p>
          <Chips
            options={models.map((m) => ({ id: m.id, label: modelLabel(m) }))}
            value={chosenModel ? [chosenModel.id] : []}
            onChange={([m]) => !locked && m && setModel(m)}
          />
          {chosenModel?.closes && (
            <p class="ui-help">{t("vcModelCloses", { date: chosenModel.closes })}</p>
          )}
          <VoiceKey
            p={cloud}
            linked={linked(cloud.id)}
            disabled={locked}
            value={key}
            onInput={setKey}
          />
          <p class="ui-help">{t("vcCloudPrivacy", { name: cloud.name })}</p>
        </>
      )}
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
      {kind && !locked && (
        <div class="st-acts">
          <button type="button" class="wz-btn primary" disabled={busy} onClick={() => void save()}>
            {t("save")}
          </button>
          <button type="button" class="wz-btn" disabled={busy} onClick={() => void tryIt()}>
            <IconMic size={16} /> {t("vcSttTry")}
          </button>
        </div>
      )}
    </div>
  );
}

type ReaderKind = "browser" | VoiceProviderId;
const TTS_CLOUD = VOICE_PROVIDERS.filter((p) => p.tts?.length);

/** The browser's voices load late in some browsers: the list follows them. */
function useBrowserVoices(lang: "it" | "en") {
  const [voices, setVoices] = useState(() => voicesFor(lang));
  useEffect(() => {
    setVoices(voicesFor(lang));
    if (typeof speechSynthesis === "undefined") return;
    const again = () => setVoices(voicesFor(lang));
    speechSynthesis.addEventListener?.("voiceschanged", again);
    return () => speechSynthesis.removeEventListener?.("voiceschanged", again);
  }, [lang]);
  return voices;
}

/** Who reads the answers on this device (kept in the browser, like the rest of this page). */
export function ReaderPicker({ s, onSaved }: { s: SetupState | null; onSaved: () => void }) {
  const v = voiceSettings.value;
  const reader = v.reader;
  const browserVoices = useBrowserVoices(v.lang);
  const p = reader.kind === "cloud" ? voiceProvider(reader.provider) : undefined;
  const linked = (id: string) => s?.secretsSet.voice?.includes(id) ?? false;
  const [key, setKey] = useState("");
  const [keyResult, setKeyResult] = useState<{ ok: boolean; text: string }>();
  const [accountVoices, setAccountVoices] = useState<{ id: string; label: string }[]>();
  const ready = p ? linked(p.id) : true;
  useEffect(() => {
    if (p?.id !== "elevenlabs" || !ready) return setAccountVoices(undefined);
    void getApi()
      .mediaVoices("elevenlabs")
      .then(setAccountVoices, () => setAccountVoices([]));
  }, [p?.id, ready]);
  const choose = (r: SpeechChoice) => {
    speechProblem.value = undefined;
    setVoiceSettings({ reader: r });
  };
  const pick = (k: ReaderKind) => {
    if (k === "browser") return choose({ kind: "browser" });
    const q = voiceProvider(k);
    const first = q?.tts?.[0];
    if (!q || !first) return;
    const voice = voicesForModel(q, first.id)[0]?.id;
    choose({ kind: "cloud", provider: q.id, model: first.id, ...(voice && { voice }) });
  };
  const models = p?.tts ?? [];
  const cloud = reader.kind === "cloud" ? reader : undefined;
  const model = cloud ? models.find((m) => m.id === cloud.model) : undefined;
  const voices = p
    ? p.id === "elevenlabs"
      ? (accountVoices ?? [])
      : voicesForModel(p, cloud?.model ?? "")
    : [];
  const saveKey = async () => {
    if (!p) return;
    setKeyResult(undefined);
    try {
      await getApi().setupVoiceKey(p.id, key.trim());
      setKey("");
      setKeyResult({ ok: true, text: t("saved") });
      onSaved();
    } catch (err) {
      setKeyResult({ ok: false, text: explain(err) });
    }
  };
  return (
    <div class="vc-service">
      <Choice<ReaderKind>
        options={[
          { id: "browser", title: t("vcReaderBrowser"), description: t("vcReaderBrowserHelp") },
          ...TTS_CLOUD.map((q) => ({
            id: q.id as ReaderKind,
            title: q.name,
            description: t("vcReaderCloudHelp", {
              models: (q.tts ?? []).map((m) => m.label).join(", "),
            }),
            ...(linked(q.id) && { badge: t("vcHasKey") }),
          })),
        ]}
        value={[reader.kind === "cloud" ? reader.provider : "browser"]}
        onChange={([k]) => k && pick(k)}
      />
      {reader.kind === "browser" &&
        (browserVoices.length > 0 ? (
          <>
            <p class="vc-label">{t("vcVoice")}</p>
            <Chips
              options={browserVoices.map((x) => ({ id: x.voiceURI, label: x.name }))}
              value={[v.voice ?? browserVoices[0]?.voiceURI ?? ""]}
              onChange={([x]) => setVoiceSettings({ voice: x ?? null })}
            />
          </>
        ) : (
          <p class="ui-help">{t("vcNoVoices")}</p>
        ))}
      {p && cloud && (
        <>
          <p class="vc-label">{t("vcModel")}</p>
          <Chips
            options={models.map((m) => ({ id: m.id, label: modelLabel(m) }))}
            value={[cloud.model]}
            onChange={([m]) => {
              if (!m) return;
              const allowed = voicesForModel(p, m);
              const voice =
                p.id === "elevenlabs" || allowed.some((x) => x.id === cloud.voice)
                  ? cloud.voice
                  : allowed[0]?.id;
              choose({ kind: "cloud", provider: p.id, model: m, ...(voice && { voice }) });
            }}
          />
          {model?.closes && <p class="ui-help">{t("vcModelCloses", { date: model.closes })}</p>}
          {ready && voices.length > 0 && (
            <>
              <p class="vc-label">{t("vcVoice")}</p>
              <Chips
                options={voices}
                value={[cloud.voice ?? voices[0]?.id ?? ""]}
                onChange={([x]) => x && choose({ ...cloud, voice: x })}
              />
            </>
          )}
          {!ready && <p class="notice error">{t("vcReaderNeedsKey", { name: p.name })}</p>}
          <VoiceKey p={p} linked={ready} value={key} onInput={setKey} />
          {key.trim().length > 0 && (
            <div class="st-acts">
              <button
                type="button"
                class="wz-btn primary"
                disabled={key.trim().length < 8}
                onClick={() => void saveKey()}
              >
                {t("vcKeySave")}
              </button>
            </div>
          )}
          {keyResult && <p class={`notice ${keyResult.ok ? "ok" : "error"}`}>{keyResult.text}</p>}
        </>
      )}
      {speechProblem.value && (
        <p class="notice error">{t("vcReaderFailed", { error: speechProblem.value })}</p>
      )}
      <div class="st-acts">
        <button type="button" class="wz-btn" onClick={() => void speak(t("vcSample"))}>
          <IconSpeaker size={16} /> {t("vcTry")}
        </button>
      </div>
    </div>
  );
}
