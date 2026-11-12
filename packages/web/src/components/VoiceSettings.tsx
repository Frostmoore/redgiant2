// Settings › Voice (G38.4): hands-free voice on this device. Every choice is the device's own
// (kept in the browser): the wake word and how sensitive it is, the language and the voice, the
// follow-up window, speaking over the answer, and where what is said goes. The limits of phones
// are said plainly.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconMic, IconSpeaker } from "../icons.js";
import { openTab, platformInfo, sessionRows } from "../state.js";
import { prepareWakeWord, speak, startHandsFree, voicesFor, wakeModel } from "../voice/runtime.js";
import { setVoiceSettings, voiceSettings } from "../voice/settings.js";
import { Box, Chips, Head, Seg, Slider, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { JobView, Progress } from "./ui.js";

/** The voices load late in some browsers: the list follows them. */
function useVoices(lang: "it" | "en") {
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
  if (m.state === "ready") return <p class="notice ok">{t("voiceModelReady")}</p>;
  return (
    <div class="vc-model">
      {m.state === "error" && (
        <p class="notice error">{t("voiceModelError", { error: m.message })}</p>
      )}
      <p class="ui-help">{t("voiceModelAbout")}</p>
      <button type="button" class="wz-btn" onClick={() => void prepareWakeWord(lang)}>
        {t("voiceModelGet")}
      </button>
    </div>
  );
}

export function VoiceSettingsPage() {
  const s = voiceSettings.value;
  const voices = useVoices(s.lang);
  const transcription = platformInfo.value?.voice === true;
  const recent = [...sessionRows.value]
    .filter((r) => !r.archived)
    .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    .slice(0, 8);
  const pct = Math.round(s.sensitivity * 4) + 1;
  return (
    <WzPage>
      <Head eyebrow={t("voiceTitle")} q={t("vcQ")} lead={t("vcLead")} />
      {!transcription && (
        <p class="notice error">
          {t("vcNoTranscription")}{" "}
          <button
            type="button"
            class="link"
            onClick={() =>
              openTab({ id: "settings", type: "settings", title: t("settings"), section: "setup" })
            }
          >
            {t("openSetup")}
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

      <Sub title={t("vcWakeTitle")} lead={t("vcWakeLead")} />
      <SwitchRow
        title={t("vcWake")}
        help={t("vcWakeHelp")}
        on={s.wake}
        onChange={(on) => setVoiceSettings({ wake: on })}
      />
      {s.wake && <WakeModelView />}
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

      <Sub title={t("vcVoiceTitle")} />
      <Seg
        label={t("vcLang")}
        value={s.lang}
        options={[
          ["it", t("vcLangIt")],
          ["en", t("vcLangEn")],
        ]}
        onChange={(lang) => setVoiceSettings({ lang, voice: null })}
      />
      {voices.length > 0 ? (
        <Chips
          options={voices.map((v) => ({ id: v.voiceURI, label: v.name }))}
          value={[s.voice ?? voices[0]?.voiceURI ?? ""]}
          onChange={([v]) => setVoiceSettings({ voice: v ?? null })}
        />
      ) : (
        <p class="ui-help">{t("vcNoVoices")}</p>
      )}
      <button type="button" class="wz-btn" onClick={() => void speak(t("vcSample"))}>
        <IconSpeaker size={16} /> {t("vcTry")}
      </button>

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
        <p>
          <IconMic size={16} /> {t("vcLimitPrivacy")}
        </p>
        <p>{t("vcLimitForeground")}</p>
        <p>{t("vcLimitIos")}</p>
        <p>{t("vcLimitSpeakers")}</p>
      </Box>
    </WzPage>
  );
}
