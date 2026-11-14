// @vitest-environment jsdom
// Reading the answers (3.7.3): the browser's voice at the volume chosen (1 at most), the cloud's
// audio through a gain with a limiter, interrupted by «stop» or by speaking over it, and a failure
// read with the browser's voice and said in the person's words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { dictionaries, lang } from "../src/i18n.js";

const asked: { choice: unknown; text: string }[] = [];
let fail: Error | undefined;
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => ({
    speech: async (choice: unknown, text: string) => {
      asked.push({ choice, text });
      if (fail) throw fail;
      return new ArrayBuffer(8);
    },
  }),
}));

/** Web Audio as far as the page uses it: every node written down. */
const nodes: { kind: string; value?: number; stopped?: boolean; onended?: (() => void) | null }[] =
  [];
class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  sampleRate = 48000;
  addEventListener() {}
  resume = async () => {};
  decodeAudioData = async () => ({ duration: 1 });
  createGain() {
    const n = { kind: "gain", gain: { value: 1 }, connect: (x: unknown) => x };
    nodes.push(n as never);
    return n;
  }
  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    const n = {
      kind: "limiter",
      threshold: p(),
      knee: p(),
      ratio: p(),
      attack: p(),
      release: p(),
      connect: (x: unknown) => x,
    };
    nodes.push(n as never);
    return n;
  }
  createBufferSource() {
    const n = {
      kind: "source",
      buffer: null as unknown,
      onended: null as (() => void) | null,
      stopped: false,
      connect: (x: unknown) => x,
      start() {},
      stop() {
        this.stopped = true;
        this.onended?.();
      },
    };
    nodes.push(n);
    return n;
  }
}
const spoken: { text: string; volume: number }[] = [];
class FakeUtterance {
  volume = 1;
  lang = "";
  voice: unknown;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [],
    cancel: () => {},
    speak: (u: FakeUtterance) => {
      spoken.push({ text: u.text, volume: u.volume });
      queueMicrotask(() => u.onend?.());
    },
  });
  nodes.length = 0;
  spoken.length = 0;
  asked.length = 0;
  fail = undefined;
  lang.value = "it";
});
afterEach(() => vi.unstubAllGlobals());

const { speak, speechProblem, voiceController } = await import("../src/voice/runtime.js");
const { setVoiceSettings } = await import("../src/voice/settings.js");
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("reading the answers", () => {
  it("reads with the browser's voice at the volume chosen, 1 at most", async () => {
    setVoiceSettings({ reader: { kind: "browser" }, volume: 50 });
    await speak("Ciao.");
    setVoiceSettings({ volume: 200 });
    await speak("Ancora.");
    expect(spoken).toEqual([
      { text: "Ciao.", volume: 0.5 },
      { text: "Ancora.", volume: 1 },
    ]);
  });

  it("plays the cloud's audio louder through a limiter, and stops when hushed", async () => {
    setVoiceSettings({
      reader: { kind: "cloud", provider: "openai", model: "gpt-4o-mini-tts", voice: "cedar" },
      volume: 200,
    });
    const reading = speak("Sono le tre.");
    await flush();
    await flush();
    expect(asked).toEqual([
      {
        choice: { provider: "openai", model: "gpt-4o-mini-tts", voice: "cedar" },
        text: "Sono le tre.",
      },
    ]);
    expect(nodes.find((n) => n.kind === "gain")).toMatchObject({ gain: { value: 2 } });
    expect(nodes.some((n) => n.kind === "limiter")).toBe(true);
    // «Stop» (or speaking over it): the controller hushes, the audio stops, the reading ends.
    voiceController().dispatch({ type: "start", wake: false });
    const source = nodes.find((n) => n.kind === "source");
    // The controller's hush port is the runtime's hush.
    (voiceController() as unknown as { ports: { hush: () => void } }).ports.hush();
    await reading;
    expect(source?.stopped).toBe(true);
    expect(spoken).toEqual([]);
  });

  it("reads with the browser's voice when the cloud fails, and says why in Italian", async () => {
    setVoiceSettings({
      reader: { kind: "cloud", provider: "elevenlabs", model: "eleven_v4", voice: "v1" },
      volume: 150,
    });
    fail = new ApiError(400, "ElevenLabs has no key yet", "voice_no_key", { name: "ElevenLabs" });
    await speak("Fatto.");
    expect(spoken).toEqual([{ text: "Fatto.", volume: 1 }]);
    expect(speechProblem.value).toBe(
      dictionaries.it.err_voice_no_key.replace("{name}", "ElevenLabs"),
    );
  });
});
