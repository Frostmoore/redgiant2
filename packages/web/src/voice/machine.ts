// Hands-free voice (G38.4): the conversation by voice as a pure state machine. The page feeds it
// what happens (the wake word heard, speech starting and ending, the text, the answer, the voice
// done) and runs the effects it returns; nothing here touches the microphone or the network, so
// every path is tested as a table.
//
//   off → idle ⇄ (wake word) → wake → listening → transcribing → thinking → speaking → followup
//   followup: speech again → listening without the wake word; silence for the window → idle
//   speaking: the person speaks (barge-in) → listening; «stop»/«basta» anywhere → idle

export type VoicePhase =
  /** Hands-free is switched off on this device. */
  | "off"
  /** Waiting: for the wake word when it is on, else for a tap on «Speak». */
  | "idle"
  /** The wake word was just heard: the recording starts. */
  | "wake"
  /** Recording what the person says, until they stop speaking. */
  | "listening"
  | "transcribing"
  /** Sent: the agent is working on the answer. */
  | "thinking"
  | "speaking"
  /** A few seconds after the answer: speaking again needs no wake word. */
  | "followup";

export interface VoiceState {
  phase: VoicePhase;
  /** The wake word is listened for while idle. */
  wake: boolean;
  /** Something went wrong in the last turn, in words for the person. */
  error?: string;
  /** What was understood last, shown under the indicator. */
  heard?: string;
}

export type VoiceEvent =
  /** Hands-free switched on; `wake`: listen for the wake word while idle. */
  | { type: "start"; wake: boolean }
  /** The wake word heard, or «Speak» tapped. */
  | { type: "wake" }
  /** The microphone is recording. */
  | { type: "ready" }
  | { type: "speechStart" }
  | { type: "speechEnd" }
  /** Nothing said for the listening window. */
  | { type: "silence" }
  | { type: "transcribed"; text: string }
  | { type: "answer"; text: string }
  /** The voice finished reading. */
  | { type: "spoken" }
  /** The person spoke over the answer. */
  | { type: "bargeIn" }
  /** «stop», «basta», «enough» heard by the wake-word listener. */
  | { type: "stopWord" }
  | { type: "followupOver" }
  | { type: "failed"; error: string }
  /** The person stops this turn (the indicator's button). */
  | { type: "stop" }
  /** Hands-free switched off. */
  | { type: "off" };

export type VoiceEffect =
  /** A short sound: the wake word was heard. */
  | { do: "chime" }
  /** Start keeping what the microphone hears (with the moment before, so no word is cut). */
  | { do: "record" }
  /** Stop keeping it and transcribe what was kept. */
  | { do: "transcribe" }
  /** Throw away what was kept. */
  | { do: "discard" }
  | { do: "send"; text: string }
  | { do: "speak"; text: string }
  /** Stop the voice now. */
  | { do: "hush" }
  /** Forget the answer being waited for (the turn goes on in the conversation). */
  | { do: "abandon" }
  | { do: "timer"; which: "listen" | "followup" }
  | { do: "cancelTimer" };

export const initialVoice = (): VoiceState => ({ phase: "off", wake: false });

/** Words that end the conversation by voice, said alone (with a thank-you or an «ok» at most). */
const STOP_WORDS = [
  "stop",
  "basta",
  "fine",
  "finito",
  "smettila",
  "basta così",
  "ho finito",
  "enough",
  "that's all",
  "that is all",
  "stop it",
  "never mind",
  "lascia stare",
  "lascia perdere",
];
const FILLER = /\b(ok|okay|grazie|thanks|thank you|allora|va bene|redgiant|red giant|ehi|hey)\b/g;

/** The text is only a request to stop (not a sentence that happens to contain «stop»). */
export function isStopPhrase(text: string): boolean {
  const plain = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
  return STOP_WORDS.includes(plain);
}

/** The next state and what to do, for one event. */
export function stepVoice(
  s: VoiceState,
  e: VoiceEvent,
): { state: VoiceState; effects: VoiceEffect[] } {
  const go = (phase: VoicePhase, effects: VoiceEffect[] = [], extra: Partial<VoiceState> = {}) => {
    const { error: _e, ...rest } = s;
    return { state: { ...rest, ...extra, phase }, effects };
  };
  const stay = { state: s, effects: [] as VoiceEffect[] };
  // Back to waiting: everything running stops.
  const rest = (phase: "idle" | "off", extra: Partial<VoiceState> = {}) => {
    const effects: VoiceEffect[] = [{ do: "cancelTimer" }];
    if (s.phase === "listening" || s.phase === "followup" || s.phase === "wake")
      effects.push({ do: "discard" });
    if (s.phase === "speaking") effects.push({ do: "hush" });
    if (s.phase === "thinking") effects.push({ do: "abandon" });
    return go(phase, effects, extra);
  };

  if (e.type === "off") return s.phase === "off" ? stay : rest("off", { wake: false });
  if (e.type === "start")
    return s.phase === "off"
      ? go("idle", [], { wake: e.wake })
      : { state: { ...s, wake: e.wake }, effects: [] };
  if (s.phase === "off") return stay;
  if (e.type === "stop" || e.type === "stopWord") return s.phase === "idle" ? stay : rest("idle");
  if (e.type === "failed") return rest("idle", { error: e.error });

  switch (s.phase) {
    case "idle":
      if (e.type === "wake") return go("wake", [{ do: "chime" }, { do: "record" }]);
      return stay;
    case "wake":
      if (e.type === "ready") return go("listening", [{ do: "timer", which: "listen" }]);
      return stay;
    case "listening":
      if (e.type === "speechStart") return go("listening", [{ do: "cancelTimer" }]);
      if (e.type === "speechEnd")
        return go("transcribing", [{ do: "cancelTimer" }, { do: "transcribe" }]);
      if (e.type === "silence") return go("idle", [{ do: "discard" }]);
      return stay;
    case "transcribing":
      if (e.type === "transcribed") {
        const text = e.text.trim();
        // Nothing understood: back to waiting, quietly.
        if (!text) return go("idle", [], { heard: "" });
        if (isStopPhrase(text)) return go("idle", [], { heard: text });
        return go("thinking", [{ do: "send", text }], { heard: text });
      }
      return stay;
    case "thinking":
      if (e.type === "answer")
        return e.text.trim()
          ? go("speaking", [{ do: "speak", text: e.text }])
          : go("followup", [{ do: "record" }, { do: "timer", which: "followup" }]);
      return stay;
    case "speaking":
      if (e.type === "spoken")
        return go("followup", [{ do: "record" }, { do: "timer", which: "followup" }]);
      if (e.type === "bargeIn" || e.type === "wake")
        return go("listening", [
          { do: "hush" },
          { do: "record" },
          { do: "timer", which: "listen" },
        ]);
      return stay;
    case "followup":
      if (e.type === "speechStart") return go("listening", [{ do: "cancelTimer" }]);
      // The wake word said again in the window: a new request, as if it had just been heard.
      if (e.type === "wake")
        return go("listening", [{ do: "chime" }, { do: "timer", which: "listen" }]);
      if (e.type === "followupOver") return go("idle", [{ do: "discard" }]);
      return stay;
  }
  return stay;
}
