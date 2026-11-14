// @vitest-environment jsdom
// Hands-free voice (G38.4): the state machine as a table, the VAD on synthetic audio, what the
// voice reads of an answer, the wake-word phrases, and a whole conversation through fake ports.
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { explain } from "../src/explain.js";
import { dictionaries, lang } from "../src/i18n.js";
import { VoiceController, type VoicePorts } from "../src/voice/controller.js";
import {
  initialVoice,
  isStopPhrase,
  stepVoice,
  type VoiceEvent,
  type VoicePhase,
  type VoiceState,
} from "../src/voice/machine.js";
import { loadVoiceSettings } from "../src/voice/settings.js";
import {
  chunksForVoice,
  plainSpeech,
  speakable,
  stripVoiceHint,
  VOICE_HINT,
  withVoiceHint,
} from "../src/voice/speakable.js";
import { downsample, encodeWav, ratioFor, rms, Vad } from "../src/voice/vad.js";
import {
  classifyHeard,
  customWake,
  minConfFor,
  spokenWake,
  WAKE_EXAMPLES,
  wakeGrammar,
  wakeLabel,
  wakeProblem,
} from "../src/voice/wake.js";

const at = (phase: VoicePhase, wake = true): VoiceState => ({ phase, wake });

describe("the conversation by voice, as a table", () => {
  const rows: [VoicePhase, VoiceEvent, VoicePhase, string[]][] = [
    ["off", { type: "start", wake: true }, "idle", []],
    ["off", { type: "wake" }, "off", []],
    ["idle", { type: "wake" }, "wake", ["chime", "record"]],
    ["idle", { type: "speechStart" }, "idle", []],
    ["idle", { type: "stop" }, "idle", []],
    ["wake", { type: "ready" }, "listening", ["timer:listen"]],
    ["listening", { type: "speechStart" }, "listening", ["cancelTimer"]],
    ["listening", { type: "speechEnd" }, "transcribing", ["cancelTimer", "transcribe"]],
    ["listening", { type: "silence" }, "idle", ["discard"]],
    ["transcribing", { type: "transcribed", text: "che ore sono?" }, "thinking", ["send"]],
    ["transcribing", { type: "transcribed", text: "  " }, "idle", []],
    ["transcribing", { type: "transcribed", text: "Basta, grazie." }, "idle", []],
    ["thinking", { type: "answer", text: "Sono le tre." }, "speaking", ["speak"]],
    ["thinking", { type: "answer", text: "" }, "followup", ["record", "timer:followup"]],
    ["thinking", { type: "stop" }, "idle", ["cancelTimer", "abandon"]],
    ["speaking", { type: "spoken" }, "followup", ["record", "timer:followup"]],
    ["speaking", { type: "bargeIn" }, "listening", ["hush", "record", "timer:listen"]],
    ["speaking", { type: "wake" }, "listening", ["hush", "record", "timer:listen"]],
    ["speaking", { type: "stopWord" }, "idle", ["cancelTimer", "hush"]],
    ["followup", { type: "speechStart" }, "listening", ["cancelTimer"]],
    ["followup", { type: "wake" }, "listening", ["chime", "timer:listen"]],
    ["followup", { type: "followupOver" }, "idle", ["discard"]],
    ["followup", { type: "stopWord" }, "idle", ["cancelTimer", "discard"]],
    ["listening", { type: "failed", error: "x" }, "idle", ["cancelTimer", "discard"]],
    ["speaking", { type: "off" }, "off", ["cancelTimer", "hush"]],
  ];
  it.each(rows)("%s + %o → %s", (from, ev, to, fx) => {
    const { state, effects } = stepVoice(at(from), ev);
    expect(state.phase).toBe(to);
    expect(effects.map((e) => (e.do === "timer" ? `timer:${e.which}` : e.do))).toEqual(fx);
  });

  it("goes the whole way round and remembers what it heard", () => {
    let s = initialVoice();
    const kinds: VoicePhase[] = [];
    const events: VoiceEvent[] = [
      { type: "start", wake: true },
      { type: "wake" },
      { type: "ready" },
      { type: "speechStart" },
      { type: "speechEnd" },
      { type: "transcribed", text: "accendi la luce" },
      { type: "answer", text: "Fatto." },
      { type: "spoken" },
      { type: "followupOver" },
    ];
    for (const e of events) {
      s = stepVoice(s, e).state;
      kinds.push(s.phase);
    }
    expect(kinds).toEqual([
      "idle",
      "wake",
      "listening",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "followup",
      "idle",
    ]);
    expect(s.heard).toBe("accendi la luce");
  });

  it("keeps the error until the next turn starts", () => {
    const failed = stepVoice(at("thinking"), { type: "failed", error: "offline" }).state;
    expect(failed).toMatchObject({ phase: "idle", error: "offline" });
    expect(stepVoice(failed, { type: "wake" }).state.error).toBeUndefined();
  });

  it("tells a request to stop from a sentence that says stop", () => {
    for (const s of [
      "stop",
      "Basta!",
      "ok basta grazie",
      "basta così",
      "That's all, thanks",
      "enough",
    ])
      expect(isStopPhrase(s), s).toBe(true);
    for (const s of ["stop the server", "basta con questi errori, sistemali", "fine tuning", ""])
      expect(isStopPhrase(s), s).toBe(false);
  });
});

/** Synthetic audio at 16 kHz: noise of a given height, or a voice-like tone with noise. */
const RATE = 16000;
function noise(seconds: number, height: number, seed = 1): Float32Array {
  let x = seed;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 2147483648 - 0.5) * 2 * height;
  });
}
function voice(seconds: number, height: number): Float32Array {
  const n = noise(seconds, height * 0.2, 7);
  return n.map(
    (v, i) =>
      v + Math.sin((2 * Math.PI * 180 * i) / RATE) * height * (0.6 + 0.4 * Math.sin(i / 900)),
  );
}
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Feeds audio in 4096-sample pieces (as a ScriptProcessor does); events with their time in ms. */
function run(vad: Vad, audio: Float32Array): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < audio.length; i += 4096) {
    const piece = audio.subarray(i, i + 4096);
    for (const e of vad.push(piece)) out.push([e, Math.round(((i + piece.length) / RATE) * 1000)]);
  }
  return out;
}

describe("where speech starts and ends (VAD)", () => {
  it("measures loudness", () => {
    expect(rms(new Float32Array(100))).toBe(0);
    expect(rms(Float32Array.from({ length: 100 }, () => 0.5))).toBeCloseTo(0.5);
    expect(ratioFor(0)).toBeGreaterThan(ratioFor(0.5));
    expect(ratioFor(0.5)).toBeGreaterThan(ratioFor(1));
  });

  it("finds a sentence in a quiet room, with its end after the pause", () => {
    const vad = new Vad({ sampleRate: RATE, endSilenceMs: 800 });
    const events = run(vad, join(noise(1, 0.002), voice(1.5, 0.2), noise(1.5, 0.002)));
    expect(events.map((e) => e[0])).toEqual(["start", "end"]);
    const [[, start], [, end]] = events as [[string, number], [string, number]];
    // Speech from 1.0 s: noticed after its 200 ms (plus one piece of audio at most).
    expect(start).toBeGreaterThanOrEqual(1200);
    expect(start).toBeLessThan(1500);
    // It ends at 2.5 s: the end comes after the 800 ms pause.
    expect(end).toBeGreaterThanOrEqual(3300);
    expect(end).toBeLessThan(3600);
  });

  it("does not take a click or a cough for speech", () => {
    const vad = new Vad({ sampleRate: RATE });
    expect(run(vad, join(noise(1, 0.002), voice(0.1, 0.3), noise(1, 0.002)))).toEqual([]);
  });

  it("learns a noisy room, and needs the voice above it", () => {
    const vad = new Vad({ sampleRate: RATE });
    // A fan: steady noise louder than a quiet voice in a silent room.
    expect(run(vad, noise(3, 0.03))).toEqual([]);
    expect(vad.floor).toBeGreaterThan(0.01);
    expect(run(vad, join(voice(1, 0.2), noise(1.5, 0.03))).map((e) => e[0])).toEqual([
      "start",
      "end",
    ]);
  });

  it("hears a soft voice only when sensitive", () => {
    const soft = join(noise(1, 0.01), voice(1.2, 0.03), noise(1.5, 0.01));
    expect(run(new Vad({ sampleRate: RATE, sensitivity: 0 }), soft)).toEqual([]);
    expect(run(new Vad({ sampleRate: RATE, sensitivity: 1 }), soft).map((e) => e[0])).toEqual([
      "start",
      "end",
    ]);
  });

  it("needs a louder voice to speak over the answer (boost)", () => {
    const talk = join(noise(1, 0.005), voice(1, 0.05), noise(1.2, 0.005));
    expect(run(new Vad({ sampleRate: RATE }), talk).map((e) => e[0])).toEqual(["start", "end"]);
    expect(run(new Vad({ sampleRate: RATE, boost: 3, sensitivity: 0.3 }), talk)).toEqual([]);
  });

  it("ends a speech that never pauses", () => {
    const vad = new Vad({ sampleRate: RATE, maxSpeechMs: 2000 });
    expect(run(vad, join(noise(0.5, 0.002), voice(4, 0.2))).map((e) => e[0])).toContain("end");
  });

  it("brings the microphone to 16 kHz and writes a WAV", () => {
    const at48 = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 20));
    expect(downsample(at48, 48000, 16000)).toHaveLength(16000);
    expect(downsample(at48, 16000, 16000)).toBe(at48);
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), 16000);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect([v.getUint32(24, true), v.getUint32(40, true)]).toEqual([16000, 8]);
    expect([v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([
      32767, -32767, 32767,
    ]);
  });
});

describe("what the voice reads", () => {
  it("adds the note for the model at the end, and the chat hides it", () => {
    const sent = withVoiceHint("che tempo fa?");
    expect(sent.startsWith("che tempo fa?\n\n<voice-mode>")).toBe(true);
    expect(sent).toContain(VOICE_HINT);
    expect(stripVoiceHint(sent)).toBe("che tempo fa?");
    // Written by hand in the middle of a message: left as it is.
    expect(stripVoiceHint("a <voice-mode>x</voice-mode> b")).toBe("a <voice-mode>x</voice-mode> b");
  });

  it("reads the spoken version when there is one", () => {
    const md = "<spoken>Ho scritto lo script, è sullo schermo.</spoken>\n\n```bash\nrm -rf x\n```";
    expect(speakable(md, "Il resto è sullo schermo.")).toBe(
      "Ho scritto lo script, è sullo schermo.",
    );
  });

  it("leaves out code, tables, links and marks", () => {
    const md = [
      "## Risultato",
      "Ho trovato **tre** file in `src/`:",
      "- uno",
      "- [due](https://x.example/due)",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "```ts",
      "const x = 1;",
      "```",
      "Vedi https://example.com per altro",
    ].join("\n");
    expect(plainSpeech(md)).toBe(
      "Risultato. Ho trovato tre file in src/: uno. due. Vedi per altro.",
    );
  });

  it("cuts a long answer after whole sentences and says the rest is on screen", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Questa è la frase numero ${i + 1}.`).join(
      " ",
    );
    const said = speakable(long, "Il resto è sullo schermo.", 120);
    expect(said.length).toBeLessThan(170);
    expect(said).toMatch(/^Questa è la frase numero 1\. .*\d\. Il resto è sullo schermo\.$/);
  });

  it("splits for the browser's voice without breaking sentences", () => {
    const text = "Uno due tre. Quattro cinque. Sei.";
    expect(chunksForVoice(text, 20)).toEqual(["Uno due tre.", "Quattro cinque. Sei."]);
    const huge = `${"parola ".repeat(80)}.`;
    for (const c of chunksForVoice(huge, 100)) expect(c.length).toBeLessThanOrEqual(100);
  });
});

describe("the wake word (Vosk's grammar)", () => {
  it("listens for a few phrases only", () => {
    const g = JSON.parse(wakeGrammar("it")) as string[];
    expect(g).toContain("ehi red giant");
    expect(g).toContain("basta");
    expect(g.at(-1)).toBe("[unk]");
  });

  it("wakes on the phrase when sure enough, stops on a stop word", () => {
    const sure = [
      { word: "ehi", conf: 0.9 },
      { word: "red", conf: 0.92 },
      { word: "giant", conf: 0.88 },
    ];
    expect(classifyHeard("it", "ehi red giant", sure, minConfFor(0.5))).toBe("wake");
    const unsure = sure.map((w) => ({ ...w, conf: 0.6 }));
    expect(classifyHeard("it", "ehi red giant", unsure, minConfFor(0.5))).toBeUndefined();
    expect(classifyHeard("it", "ehi red giant", unsure, minConfFor(1))).toBe("wake");
    expect(classifyHeard("it", "basta", [{ word: "basta", conf: 1 }], 0.7)).toBe("stop");
    expect(classifyHeard("en", "[unk]", undefined, 0.7)).toBeUndefined();
    expect(classifyHeard("en", "", undefined, 0.7)).toBeUndefined();
  });
});

describe("a wake word of one's own", () => {
  it("is spelled as the model spells it, «RedGiant» as two words", () => {
    expect(spokenWake("  Ehi, RedGiant! ")).toBe("ehi red giant");
    expect(spokenWake("Ciao   Computer")).toBe("ciao computer");
    expect(customWake("it", "Ehi RedGiant")).toBeUndefined();
    expect(customWake("it", undefined)).toBeUndefined();
    expect(customWake("it", "Ciao computer")).toBe("ciao computer");
    expect(wakeLabel("it", undefined)).toBe("Ehi RedGiant");
    expect(wakeLabel("en", " Hey computer ")).toBe("Hey computer");
  });

  it("listens for that phrase only, with the stop words still there", () => {
    const g = JSON.parse(wakeGrammar("it", "Ciao computer")) as string[];
    expect(g).toEqual(["ciao computer", "stop", "basta", "basta così", "zitto", "[unk]"]);
    const sure = [
      { word: "ciao", conf: 0.9 },
      { word: "computer", conf: 0.9 },
    ];
    expect(classifyHeard("it", "ciao computer", sure, 0.75, "Ciao computer")).toBe("wake");
    // Every word must be sure, not only the name.
    expect(
      classifyHeard(
        "it",
        "ciao computer",
        [sure[0] as never, { word: "computer", conf: 0.5 }],
        0.75,
        "Ciao computer",
      ),
    ).toBeUndefined();
    // The default phrase no longer wakes it.
    expect(classifyHeard("it", "ehi red giant", undefined, 0.75, "Ciao computer")).toBeUndefined();
    expect(classifyHeard("it", "basta", [{ word: "basta", conf: 1 }], 0.7, "Ciao computer")).toBe(
      "stop",
    );
  });

  it("says what is wrong before asking the model", () => {
    expect(wakeProblem("it", " ")).toBe("empty");
    expect(wakeProblem("it", "uno due tre quattro cinque")).toBe("tooLong");
    expect(wakeProblem("it", "Basta")).toBe("stopWord");
    expect(wakeProblem("it", "Ehi")).toBe("short");
    expect(wakeProblem("it", "Ciao computer")).toBeUndefined();
    for (const l of ["it", "en"] as const)
      for (const w of WAKE_EXAMPLES[l]) expect(wakeProblem(l, w), w).toBeUndefined();
  });
});

describe("the voice's failures, in the person's language", () => {
  it("turns the server's codes into Italian or English, the provider named", () => {
    lang.value = "it";
    const none = new ApiError(
      400,
      "No transcription service: set one in Settings, Voice",
      "voice_no_service",
    );
    expect(explain(none)).toBe(dictionaries.it.err_voice_no_service);
    expect(explain(none)).not.toMatch(/transcription service/);
    const refused = new ApiError(502, "Groq refused the key", "voice_key_refused", {
      name: "Groq",
    });
    expect(explain(refused)).toBe(
      "Groq ha rifiutato la chiave: controllala in Impostazioni, Voce.",
    );
    lang.value = "en";
    expect(explain(refused)).toBe("Groq refused the key: check it in Settings, Voice.");
    const status = new ApiError(502, "x", "voice_service_error", { name: "OpenAI", status: "500" });
    expect(explain(status)).toBe("OpenAI answered with an error (500).");
    lang.value = "it";
  });
});

describe("settings on this device", () => {
  it("start from the defaults and clamp what was saved", () => {
    localStorage.removeItem("rg.voice");
    expect(loadVoiceSettings("it")).toMatchObject({
      enabled: false,
      wake: true,
      lang: "it",
      wakeWords: {},
      reader: { kind: "browser" },
      volume: 150,
    });
    localStorage.setItem(
      "rg.voice",
      JSON.stringify({
        enabled: true,
        sensitivity: 4,
        followupSec: 99,
        lang: "xx",
        target: { kind: "?" },
        volume: 900,
        wakeWords: { it: "Ciao computer", en: 3 },
        reader: { kind: "cloud", provider: "openai", model: "gone-model" },
      }),
    );
    expect(loadVoiceSettings("en")).toMatchObject({
      enabled: true,
      sensitivity: 1,
      followupSec: 30,
      lang: "en",
      target: { kind: "open" },
      volume: 200,
      wakeWords: { it: "Ciao computer" },
      // A model the provider closed: back to the browser's voice.
      reader: { kind: "browser" },
    });
    localStorage.setItem(
      "rg.voice",
      JSON.stringify({
        reader: { kind: "cloud", provider: "elevenlabs", model: "eleven_v4", voice: "v1" },
      }),
    );
    expect(loadVoiceSettings("it").reader).toEqual({
      kind: "cloud",
      provider: "elevenlabs",
      model: "eleven_v4",
      voice: "v1",
    });
    localStorage.removeItem("rg.voice");
  });
});

/** Fake ports: time moves only when the test says, every call is written down. */
function fakePorts(answer = "Sono le **tre**.") {
  const log: string[] = [];
  let timers: { fn: () => void; at: number; id: number }[] = [];
  let now = 0;
  let id = 0;
  let speaking: (() => void) | undefined;
  const ports: VoicePorts = {
    transcribe: async (wav) => {
      log.push(`transcribe:${wav.length > 44 ? "audio" : "empty"}`);
      return "che ore sono";
    },
    ask: async (text) => {
      log.push(`ask:${text}`);
      return answer;
    },
    speak: (text) => {
      log.push(`speak:${text}`);
      return new Promise((done) => {
        speaking = done;
      });
    },
    hush: () => {
      log.push("hush");
      speaking?.();
    },
    chime: () => log.push("chime"),
    more: () => "Il resto è sullo schermo.",
    setTimer: (fn, ms) => {
      timers.push({ fn, at: now + ms, id: ++id });
      return id;
    },
    clearTimer: (x) => {
      timers = timers.filter((t) => t.id !== x);
    },
  };
  return {
    ports,
    log,
    /** Ends the reading as the browser does at its end. */
    finishSpeaking: () => speaking?.(),
    tick: (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t);
        t.fn();
      }
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
function feed(c: VoiceController, audio: Float32Array) {
  for (let i = 0; i < audio.length; i += 2048) c.feed(audio.slice(i, i + 2048));
}

describe("a whole conversation through the controller", () => {
  const options = { sensitivity: () => 0.5, bargeIn: () => true, followupMs: () => 8000 };

  it("wake word → question → answer read → follow-up without the wake word → idle", async () => {
    const f = fakePorts();
    const c = new VoiceController(f.ports, options);
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(1, 0.002));
    c.heard("wake");
    expect(c.phase).toBe("listening");
    feed(c, join(voice(1.2, 0.2), noise(1.2, 0.002)));
    expect(c.phase).toBe("transcribing");
    await flush();
    await flush();
    expect(c.phase).toBe("speaking");
    expect(f.log).toEqual(["chime", "transcribe:audio", "ask:che ore sono", "speak:Sono le tre."]);
    f.finishSpeaking();
    await flush();
    expect(c.phase).toBe("followup");
    // A second question, no wake word.
    feed(c, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    await flush();
    expect(c.phase).toBe("speaking");
    expect(f.log.filter((l) => l.startsWith("ask:"))).toHaveLength(2);
    f.finishSpeaking();
    await flush();
    // Nothing more said: the window closes.
    f.tick(8000);
    expect(c.phase).toBe("idle");
  });

  it("speaking over the answer stops it and listens", async () => {
    const f = fakePorts("Una risposta lunga.");
    const c = new VoiceController(f.ports, options);
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(0.5, 0.002));
    c.heard("wake");
    feed(c, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    await flush();
    expect(c.phase).toBe("speaking");
    // A loud voice over it.
    feed(c, voice(0.6, 0.4));
    expect(f.log).toContain("hush");
    expect(c.phase).toBe("listening");
    feed(c, noise(1.2, 0.002));
    expect(c.phase).toBe("transcribing");
  });

  it("«basta» from the listener stops everything; a stop said as a request too", async () => {
    const f = fakePorts();
    const c = new VoiceController(f.ports, options);
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(0.5, 0.002));
    c.heard("wake");
    feed(c, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    await flush();
    c.heard("stop");
    expect(c.phase).toBe("idle");
    expect(f.log.at(-1)).toBe("hush");

    const g = fakePorts();
    g.ports.transcribe = async () => "basta grazie";
    const d = new VoiceController(g.ports, options);
    d.dispatch({ type: "start", wake: true });
    feed(d, noise(0.5, 0.002));
    d.heard("wake");
    feed(d, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    expect(d.phase).toBe("idle");
    expect(g.log.some((l) => l.startsWith("ask:"))).toBe(false);
  });

  it("nothing said after the wake word: back to waiting", () => {
    const f = fakePorts();
    const c = new VoiceController(f.ports, { ...options, listenMs: 5000 });
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(0.5, 0.002));
    c.heard("wake");
    feed(c, noise(2, 0.002));
    f.tick(5000);
    expect(c.phase).toBe("idle");
  });

  it("an answer that comes after «stop» is not read", async () => {
    const f = fakePorts();
    let release: (s: string) => void = () => {};
    f.ports.ask = () => new Promise((r) => (release = r));
    const c = new VoiceController(f.ports, options);
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(0.5, 0.002));
    c.heard("wake");
    feed(c, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    expect(c.phase).toBe("thinking");
    c.dispatch({ type: "stop" });
    release("tardi");
    await flush();
    expect(c.phase).toBe("idle");
    expect(f.log.some((l) => l.startsWith("speak:"))).toBe(false);
  });

  it("a failure is said in the state and the turn ends", async () => {
    const f = fakePorts();
    f.ports.transcribe = async () => {
      throw new Error("Nessun servizio di trascrizione");
    };
    const c = new VoiceController(f.ports, options);
    c.dispatch({ type: "start", wake: true });
    feed(c, noise(0.5, 0.002));
    c.heard("wake");
    feed(c, join(voice(1, 0.2), noise(1.2, 0.002)));
    await flush();
    expect(c.state.value).toMatchObject({
      phase: "idle",
      error: "Nessun servizio di trascrizione",
    });
  });
});
