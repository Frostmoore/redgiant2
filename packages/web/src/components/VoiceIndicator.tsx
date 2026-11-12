// Hands-free voice (G38.4): the indicator in the top bar. While hands-free is on it is always
// there and says what the page is doing with the microphone: listening for the wake word,
// listening to the person, thinking, speaking, paused behind another page. Never silently.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import {
  IconAlert,
  IconMic,
  IconSettings,
  IconSpeaker,
  IconSpinner,
  IconStop,
  IconWave,
} from "../icons.js";
import { openTab } from "../state.js";
import type { VoicePhase } from "../voice/machine.js";
import {
  installVoice,
  micState,
  stopTalking,
  talkNow,
  voiceController,
  voicePaused,
  wakeModel,
} from "../voice/runtime.js";
import { setVoiceSettings, voiceSettings } from "../voice/settings.js";
import { JobView, Progress } from "./ui.js";

/** The indicator's look for a moment: its icon, its words, whether the microphone is live. */
export function voiceLook(
  phase: VoicePhase,
  o: { wake: boolean; paused: boolean; mic: string; model: string },
): { icon: JSX.Element; label: string; live: boolean; tone: string } {
  if (o.mic === "denied")
    return {
      icon: <IconAlert size={16} />,
      label: t("voiceMicDenied"),
      live: false,
      tone: "error",
    };
  if (o.paused)
    return { icon: <IconMic size={16} />, label: t("voicePaused"), live: false, tone: "dim" };
  switch (phase) {
    case "wake":
    case "listening":
      return { icon: <IconMic size={16} />, label: t("voiceListening"), live: true, tone: "hot" };
    case "followup":
      return { icon: <IconMic size={16} />, label: t("voiceFollowup"), live: true, tone: "hot" };
    case "transcribing":
      return {
        icon: <IconSpinner size={16} />,
        label: t("voiceTranscribing"),
        live: false,
        tone: "busy",
      };
    case "thinking":
      return {
        icon: <IconSpinner size={16} />,
        label: t("voiceThinking"),
        live: false,
        tone: "busy",
      };
    case "speaking":
      return {
        icon: <IconSpeaker size={16} />,
        label: t("voiceSpeaking"),
        live: true,
        tone: "busy",
      };
    default:
      if (o.wake && o.model === "ready")
        return { icon: <IconWave size={16} />, label: t("voiceWaiting"), live: true, tone: "on" };
      if (o.wake)
        return {
          icon: <IconSpinner size={16} />,
          label: t("voicePreparing"),
          live: false,
          tone: "dim",
        };
      return { icon: <IconMic size={16} />, label: t("voiceTapToTalk"), live: false, tone: "dim" };
  }
}

export function VoiceIndicator() {
  const [open, setOpen] = useState(false);
  useEffect(() => installVoice(), []);
  const s = voiceSettings.value;
  if (!s.enabled) return null;
  const state = voiceController().state.value;
  const model = wakeModel.value;
  const look = voiceLook(state.phase, {
    wake: s.wake,
    paused: voicePaused.value,
    mic: micState.value,
    model: model.state,
  });
  const busy = state.phase !== "idle" && state.phase !== "off";
  return (
    <span class="voice-ind-wrap">
      <button
        type="button"
        class={`voice-ind ${look.tone}${look.live ? " live" : ""}`}
        aria-label={`${t("voiceTitle")}: ${look.label}`}
        title={look.label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {look.icon}
        <span class="voice-ind-label">{look.label}</span>
      </button>
      {open && (
        <div class="voice-pop" role="dialog" aria-label={t("voiceTitle")}>
          <p class="voice-pop-state">
            <b>{look.label}</b>
            {s.wake && state.phase === "idle" && model.state === "ready" && (
              <span class="ui-help">{t("voiceWaitingHelp")}</span>
            )}
          </p>
          {state.heard && <p class="voice-heard">«{state.heard}»</p>}
          {state.error && <p class="notice error">{state.error}</p>}
          {model.state === "server" && <JobView job={model.job} />}
          {model.state === "page" && <Progress progress={model.progress} />}
          {model.state === "error" && (
            <p class="notice error">{t("voiceModelError", { error: model.message })}</p>
          )}
          <div class="voice-pop-acts">
            {busy ? (
              <button type="button" class="wz-btn" onClick={() => stopTalking()}>
                <IconStop /> {t("voiceStop")}
              </button>
            ) : (
              <button type="button" class="wz-btn primary" onClick={() => void talkNow()}>
                <IconMic size={16} /> {t("voiceTalk")}
              </button>
            )}
            <button
              type="button"
              class="wz-btn"
              onClick={() => {
                setOpen(false);
                setVoiceSettings({ enabled: false });
              }}
            >
              {t("voiceSwitchOff")}
            </button>
            <button
              type="button"
              class="icon-button"
              title={t("voiceSettings")}
              aria-label={t("voiceSettings")}
              onClick={() => {
                setOpen(false);
                openTab({
                  id: "settings",
                  type: "settings",
                  title: t("settings"),
                  section: "voice",
                });
              }}
            >
              <IconSettings size={16} />
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
