// Settings › Voice (G38.4): hands-free voice on this device. Every choice is the device's own
// (kept in the browser): the wake word (the person's own since 3.7.3) and how sensitive it is,
// the language, who reads the answers and how loud, the follow-up window, speaking over the
// answer, and where what is said goes. Who writes down what is said is the server's choice, made
// here too (3.7.3: the red line's link opened a generic page). The limits of phones are said
// plainly.
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { explain } from "../explain.js";
import { t } from "../i18n.js";
import { getApi, platformInfo, sessionRows } from "../state.js";
import { prepareWakeWord, startHandsFree, wakeModel } from "../voice/runtime.js";
import {
  currentWake,
  MAX_VOLUME,
  MIN_VOLUME,
  setVoiceSettings,
  voiceSettings,
} from "../voice/settings.js";
import { customWake, spokenWake, WAKE_EXAMPLES, wakeLabel, wakeProblem } from "../voice/wake.js";
import { Box, Chips, Head, Seg, Slider, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { JobView, Progress } from "./ui.js";
import { ReaderPicker, TranscriptionPicker } from "./VoiceServices.js";

/** Where the transcription's part starts: the red line's link scrolls there. */
export const VOICE_STT_ID = "vc-stt";

function WakeModelView() {
  const m = wakeModel.value;
  const lang = voiceSettings.value.lang;
  if (m.state === "server") return <JobView job={m.job} />;
  if (m.state === "page")
    return (
      <div class="vc-model">
        <span>{t("voiceModelPage")}</span>
        <Progress progress={m.progress} />
      </div>
    );
  if (m.state === "loading") return <p class="ui-help">{t("voiceModelLoading")}</p>;
  if (m.state === "ready")
    return <p class="notice ok">{t("voiceModelReady", { wake: currentWake() })}</p>;
  return (
    <div class="vc-model">
      {m.state === "error" && (
        <p class="notice error">{t("voiceModelError", { error: m.message })}</p>
      )}
      <p class="ui-help">{t("voiceModelAbout")}</p>
      <div class="st-acts">
        <button type="button" class="wz-btn" onClick={() => void prepareWakeWord(lang)}>
          {t("voiceModelGet")}
        </button>
      </div>
    </div>
  );
}

/**
 * The wake word of one's own (3.7.3): written, checked against the words the language's model
 * knows (on the server, which has the model), then used; «Ehi RedGiant» stays the default.
 */
function WakeWordField() {
  const s = voiceSettings.value;
  const lang = s.lang;
  const own = s.wakeWords[lang];
  const [text, setText] = useState(wakeLabel(lang, own));
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(wakeLabel(lang, voiceSettings.value.wakeWords[lang]));
    setResult(undefined);
  }, [lang]);
  const use = async (value: string) => {
    setResult(undefined);
    const problem = wakeProblem(lang, value);
    if (problem) {
      setResult({ ok: false, text: t(`vcWakeProblem_${problem}` as "vcWakeProblem_empty") });
      return;
    }
    if (!customWake(lang, value)) {
      const { [lang]: _gone, ...rest } = voiceSettings.value.wakeWords;
      setVoiceSettings({ wakeWords: rest });
      setText(wakeLabel(lang, undefined));
      setResult({ ok: true, text: t("vcWakeSaved", { wake: wakeLabel(lang, undefined) }) });
      return;
    }
    setBusy(true);
    try {
      const check = await getApi().wakeWords(lang, spokenWake(value).split(" "));
      if (!check.ready) {
        setResult({ ok: false, text: t("vcWakeNeedsModel") });
        return;
      }
      if (check.missing.length > 0) {
        setResult({
          ok: false,
          text: t("vcWakeUnknown", {
            words: check.missing.map((w) => `«${w}»`).join(", "),
            lang: t(lang === "it" ? "vcLangIt" : "vcLangEn"),
          }),
        });
        return;
      }
      setVoiceSettings({ wakeWords: { ...voiceSettings.value.wakeWords, [lang]: value.trim() } });
      setResult({ ok: true, text: t("vcWakeSaved", { wake: value.trim() }) });
    } catch (err) {
      setResult({ ok: false, text: explain(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="vc-wakeword">
      <form
        class="vc-wake-form"
        onSubmit={(e) => {
          e.preventDefault();
          void use(text);
        }}
      >
        <label class="ui-field">
          <span class="ui-label">{t("vcWakeWord")}</span>
          <input
            value={text}
            maxLength={40}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
          />
        </label>
        <button type="submit" class="primary" disabled={busy}>
          {t("vcWakeUse")}
        </button>
      </form>
      <p class="vc-label">{t("vcWakeExamples")}</p>
      <Chips
        wrap
        options={WAKE_EXAMPLES[lang].map((w) => ({ id: w, label: w }))}
        value={[wakeLabel(lang, own)]}
        onChange={([w]) => {
          if (!w) return;
          setText(w);
          void use(w);
        }}
      />
      {result && <p class={`notice ${result.ok ? "ok" : "error"}`}>{result.text}</p>}
      <p class="ui-help">{t("vcWakeWordHelp")}</p>
    </div>
  );
}

export function VoiceSettingsPage() {
  const s = voiceSettings.value;
  const transcription = platformInfo.value?.voice === true;
  const [setup, setSetup] = useState<SetupState | null>(null);
  const load = () => {
    // Signed out (a test, a lost session): the page still shows this device's settings.
    try {
      void getApi()
        .setup()
        .then(setSetup, () => {});
    } catch {
      setSetup(null);
    }
  };
  useEffect(load, []);
  const recent = [...sessionRows.value]
    .filter((r) => !r.archived)
    .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    .slice(0, 8);
  const pct = Math.round(s.sensitivity * 4) + 1;
  const wake = currentWake();
  return (
    <WzPage>
      <Head eyebrow={t("voiceTitle")} q={t("vcQ")} lead={t("vcLead", { wake })} />
      {!transcription && (
        <p class="notice error">
          {t("vcNoTranscription")}{" "}
          <button
            type="button"
            class="link"
            onClick={() =>
              document
                .getElementById(VOICE_STT_ID)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {t("vcChooseTranscription")}
          </button>
        </p>
      )}
      <SwitchRow
        title={t("vcEnabled")}
        help={t("vcEnabledHelp")}
        on={s.enabled}
        onChange={(on) => {
          setVoiceSettings({ enabled: on });
          // Switched on by a tap: the browser lets the page make sound from now on.
          if (on) void startHandsFree();
        }}
      />

      <Sub title={t("vcWakeTitle")} lead={t("vcWakeLead", { wake })} />
      <SwitchRow
        title={t("vcWake", { wake })}
        help={t("vcWakeHelp")}
        on={s.wake}
        onChange={(on) => setVoiceSettings({ wake: on })}
      />
      {s.wake && <WakeModelView />}
      <WakeWordField />
      <Slider
        label={t("vcSensitivity")}
        value={pct}
        min={1}
        max={5}
        step={1}
        format={(v) => t(`vcSens${v}` as "vcSens1")}
        onChange={(v) => setVoiceSettings({ sensitivity: (v - 1) / 4 })}
        help={t("vcSensitivityHelp")}
      />

      <Sub title={t("vcLangTitle")} />
      <Seg
        label={t("vcLang")}
        value={s.lang}
        options={[
          ["it", t("vcLangIt")],
          ["en", t("vcLangEn")],
        ]}
        onChange={(lang) => setVoiceSettings({ lang, voice: null })}
      />

      <div id={VOICE_STT_ID} class="vc-anchor">
        <Sub title={t("vcSttTitle")} lead={t("vcSttLead")} />
      </div>
      {setup ? (
        <TranscriptionPicker s={setup} onSaved={load} />
      ) : (
        <p class="ui-help">{t("vcLoading")}</p>
      )}

      <Sub title={t("vcReaderTitle")} lead={t("vcReaderLead")} />
      <ReaderPicker s={setup} onSaved={load} />
      <Slider
        label={t("vcVolume")}
        value={s.volume}
        min={MIN_VOLUME}
        max={MAX_VOLUME}
        step={25}
        format={(v) => `${v}%`}
        onChange={(v) => setVoiceSettings({ volume: v })}
        help={t(s.reader.kind === "browser" ? "vcVolumeHelpBrowser" : "vcVolumeHelpCloud")}
      />

      <Sub title={t("vcTalkTitle")} />
      <Slider
        label={t("vcFollowup")}
        value={s.followupSec}
        min={0}
        max={20}
        step={1}
        format={(v) => (v === 0 ? t("vcFollowupOff") : t("vcSeconds", { n: String(v) }))}
        onChange={(v) => setVoiceSettings({ followupSec: v })}
        help={t("vcFollowupHelp")}
      />
      <SwitchRow
        title={t("vcBargeIn")}
        help={t("vcBargeInHelp")}
        on={s.bargeIn}
        onChange={(on) => setVoiceSettings({ bargeIn: on })}
      />
      <Seg
        label={t("vcTarget")}
        value={s.target.kind}
        options={[
          ["open", t("vcTargetOpen")],
          ["session", t("vcTargetFixed")],
        ]}
        onChange={(kind) => {
          if (kind === "open") setVoiceSettings({ target: { kind: "open" } });
          else {
            const first = recent[0];
            if (first)
              setVoiceSettings({
                target: { kind: "session", sessionId: first.id, title: first.title ?? "" },
              });
          }
        }}
      />
      {s.target.kind === "session" && (
        <Chips
          options={recent.map((r) => ({ id: r.id, label: r.title || t("newConversation") }))}
          value={[s.target.sessionId]}
          onChange={([id]) => {
            const row = recent.find((r) => r.id === id);
            if (row)
              setVoiceSettings({
                target: { kind: "session", sessionId: row.id, title: row.title ?? "" },
              });
          }}
        />
      )}

      <Sub title={t("vcLimitsTitle")} />
      <Box class="vc-limits">
        <p>{t("vcLimitPrivacy")}</p>
        <p>{t("vcLimitForeground")}</p>
        <p>{t("vcLimitIos")}</p>
        <p>{t("vcLimitSpeakers")}</p>
      </Box>
    </WzPage>
  );
}
