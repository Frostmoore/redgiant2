// @vitest-environment jsdom
// Hands-free voice (G38.4): Settings › Voice and the indicator in the top bar, in both languages.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang } from "../src/i18n.js";

const started = vi.fn(async () => {});
const prepared = vi.fn(async (_lang: string) => {});
vi.mock("../src/voice/runtime.js", async (orig) => ({
  ...(await orig<typeof import("../src/voice/runtime.js")>()),
  startHandsFree: () => started(),
  prepareWakeWord: (l: string) => prepared(l),
  installVoice: () => {},
  voicesFor: () => [
    { voiceURI: "it-1", name: "Alice", lang: "it-IT", default: true },
    { voiceURI: "it-2", name: "Luca", lang: "it-IT", default: false },
  ],
}));

/** The server as the Voice page sees it: the setup, the wake words' check, the keys. */
const calls: { what: string; body?: unknown }[] = [];
let missingWords: string[] = [];
const setupState = () => ({
  config: { transcription: undefined as unknown },
  secretsSet: { keys: ["openai"], voice: ["openai"], transcription: false },
  locked: {},
});
let setup = setupState();
const fakeApi = {
  setup: async () => setup,
  setupModels: async (b: unknown) => {
    calls.push({ what: "models", body: b });
  },
  setupVoiceKey: async (provider: string, key: string) => {
    calls.push({ what: `key:${provider}`, body: key });
  },
  wakeWords: async (_lang: string, words: string[]) => {
    calls.push({ what: "words", body: words });
    return { ready: true, missing: missingWords };
  },
  mediaVoices: async () => [{ id: "v1", label: "Rachel" }],
};
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { VoiceSettingsPage, VOICE_STT_ID } = await import("../src/components/VoiceSettings.js");
const { VoiceIndicator, voiceLook } = await import("../src/components/VoiceIndicator.js");
const { voiceSettings, setVoiceSettings, defaultVoiceSettings } = await import(
  "../src/voice/settings.js"
);
const { voiceController, wakeModel, micState, voicePaused } = await import(
  "../src/voice/runtime.js"
);

beforeEach(() => {
  lang.value = "it";
  localStorage.clear();
  voiceSettings.value = defaultVoiceSettings("it");
  wakeModel.value = { state: "none" };
  micState.value = "closed";
  voicePaused.value = false;
  voiceController().dispatch({ type: "off" });
  calls.length = 0;
  missingWords = [];
  setup = setupState();
});
afterEach(() => {
  cleanup();
  started.mockClear();
  prepared.mockClear();
});

describe("Settings › Voice", () => {
  it("switches hands-free on from a tap and keeps it on this device", () => {
    const { getByRole, container } = render(<VoiceSettingsPage />);
    expect(container.textContent).toContain(dictionaries.it.vcQ);
    fireEvent.click(getByRole("switch", { name: dictionaries.it.vcEnabled }));
    expect(voiceSettings.value.enabled).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("rg.voice") ?? "{}")).toMatchObject({ enabled: true });
    // Our own controls, never the browser's check boxes.
    expect(container.querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
  });

  it("offers the model download with the wake word on, and a bar while it comes", async () => {
    const { getByText, container } = render(<VoiceSettingsPage />);
    fireEvent.click(getByText(dictionaries.it.voiceModelGet));
    expect(prepared).toHaveBeenCalledWith("it");
    wakeModel.value = {
      state: "page",
      progress: { done: 20e6, total: 50e6, rate: 5e6, secondsLeft: 6 },
    };
    await waitFor(() =>
      expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
        "40",
      ),
    );
    // Speed and time left, as every download shows.
    expect(container.textContent).toMatch(/\/s/);
    expect(container.textContent).toContain(dictionaries.it.uiLessThanMinute);
  });

  it("chooses the voice, the follow-up and the target conversation", () => {
    const { getByText, getByRole } = render(<VoiceSettingsPage />);
    fireEvent.click(getByText("Luca"));
    expect(voiceSettings.value.voice).toBe("it-2");
    fireEvent.click(getByRole("switch", { name: "Ascolta «Ehi RedGiant»" }));
    expect(voiceSettings.value.wake).toBe(false);
    fireEvent.click(getByText(dictionaries.it.vcLangEn));
    expect(voiceSettings.value).toMatchObject({ lang: "en", voice: null });
  });

  it("takes the red line's link straight to the transcription's choice", async () => {
    const { getByText, container } = render(<VoiceSettingsPage />);
    const target = container.querySelector(`#${VOICE_STT_ID}`) as HTMLElement;
    expect(target.textContent).toContain(dictionaries.it.vcSttTitle);
    const scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    fireEvent.click(getByText(dictionaries.it.vcChooseTranscription));
    expect(scrolled).toHaveBeenCalledTimes(1);
    // The choice is on this page: its cards are here, once the setup is read.
    await waitFor(() => expect(getByText("Groq")).toBeTruthy());
  });

  it("chooses a transcription service in the cloud with drawn cards, its key in the keychain", async () => {
    const { getByText, container, getByLabelText } = render(<VoiceSettingsPage />);
    await waitFor(() => expect(getByText("Groq")).toBeTruthy());
    fireEvent.click(getByText("Groq"));
    // Groq has no key yet: the field, and a link where to get one.
    expect(getByText(dictionaries.it.vcKeyGet.replace("{name}", "Groq"))).toBeTruthy();
    fireEvent.click(getByText(dictionaries.it.save));
    expect(container.textContent).toContain("Incolla prima la chiave di Groq.");
    expect(calls).toEqual([]);
    fireEvent.input(getByLabelText(/^Chiave di Groq/), {
      target: { value: "gsk_test_key_123" },
    });
    fireEvent.click(getByText(dictionaries.it.save));
    await waitFor(() =>
      expect(calls).toEqual([
        {
          what: "models",
          body: {
            transcription: {
              api: "cloud",
              url: "",
              provider: "groq",
              model: "whisper-large-v3-turbo",
              key: "gsk_test_key_123",
            },
          },
        },
      ]),
    );
    // OpenAI's key is the chat's: nothing to paste, the price is said.
    const stt = container.querySelectorAll(".vc-service")[0] as HTMLElement;
    fireEvent.click(
      [...stt.querySelectorAll("strong")].find((x) => x.textContent === "OpenAI") as Element,
    );
    expect(container.textContent).toContain("Usa la chiave di OpenAI che hai già dato");
    expect(container.textContent).toMatch(/GPT Transcribe · circa \$0\.0045 al minuto/);
    // Our controls only: no native select, check box or radio button.
    expect(container.querySelector("select, input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("chooses who reads the answers, and how loud", async () => {
    const { getByText, getByLabelText, container } = render(<VoiceSettingsPage />);
    await waitFor(() => expect(getByText("Groq")).toBeTruthy());
    expect(voiceSettings.value.volume).toBe(150);
    expect(container.textContent).toContain(dictionaries.it.vcVolumeHelpBrowser);
    const readers = container.querySelectorAll(".vc-service")[1] as HTMLElement;
    fireEvent.click(
      [...readers.querySelectorAll("strong")].find((x) => x.textContent === "OpenAI") as Element,
    );
    expect(voiceSettings.value.reader).toEqual({
      kind: "cloud",
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice: "marin",
    });
    fireEvent.click(getByText("Cedar"));
    expect(voiceSettings.value.reader).toMatchObject({ voice: "cedar" });
    fireEvent.click(getByText(/^TTS-1 ·/));
    // tts-1 does not know cedar: its first voice.
    expect(voiceSettings.value.reader).toMatchObject({ model: "tts-1", voice: "alloy" });
    expect(container.textContent).toContain(dictionaries.it.vcVolumeHelpCloud);
    fireEvent.input(getByLabelText(dictionaries.it.vcVolume), { target: { value: "200" } });
    expect(voiceSettings.value.volume).toBe(200);
    expect(JSON.parse(localStorage.getItem("rg.voice") ?? "{}")).toMatchObject({ volume: 200 });
    // ElevenLabs without a key: said, with the field to paste it.
    fireEvent.click(
      [...readers.querySelectorAll("strong")].find(
        (x) => x.textContent === "ElevenLabs",
      ) as Element,
    );
    expect(container.textContent).toContain("ElevenLabs non ha ancora una chiave");
    fireEvent.input(getByLabelText(/^Chiave di ElevenLabs/), {
      target: { value: "sk_eleven_123" },
    });
    fireEvent.click(getByText(dictionaries.it.vcKeySave));
    await waitFor(() =>
      expect(calls).toContainEqual({ what: "key:elevenlabs", body: "sk_eleven_123" }),
    );
  });

  it("changes the wake word after checking its words in the model", async () => {
    const { getByText, getByLabelText, container } = render(<VoiceSettingsPage />);
    const field = getByLabelText(dictionaries.it.vcWakeWord) as HTMLInputElement;
    expect(field.value).toBe("Ehi RedGiant");
    missingWords = ["zzxq"];
    fireEvent.input(field, { target: { value: "Ehi Zzxq" } });
    fireEvent.click(getByText(dictionaries.it.vcWakeUse));
    await waitFor(() =>
      expect(container.textContent).toContain("Il modello vocale Italiano non conosce «zzxq»"),
    );
    expect(voiceSettings.value.wakeWords).toEqual({});
    missingWords = [];
    fireEvent.click(getByText("Ciao computer"));
    await waitFor(() => expect(voiceSettings.value.wakeWords).toEqual({ it: "Ciao computer" }));
    expect(calls).toContainEqual({ what: "words", body: ["ciao", "computer"] });
    // The page names it everywhere.
    expect(container.textContent).toContain("Ascolta «Ciao computer»");
    expect(container.textContent).toContain("Di' «Ciao computer», chiedi");
    // Back to the default: nothing to check.
    fireEvent.click(getByText("Ehi RedGiant", { selector: "button" }));
    await waitFor(() => expect(voiceSettings.value.wakeWords).toEqual({}));
    fireEvent.input(field, { target: { value: "basta" } });
    fireEvent.click(getByText(dictionaries.it.vcWakeUse));
    await waitFor(() =>
      expect(container.textContent).toContain(dictionaries.it.vcWakeProblem_stopWord),
    );
  });

  it("says the limits plainly, in English too", () => {
    lang.value = "en";
    const { container } = render(<VoiceSettingsPage />);
    expect(container.textContent).toContain("iPhone");
    expect(container.textContent).toContain(dictionaries.en.vcLimitForeground);
  });
});

describe("the indicator", () => {
  it("is not there while hands-free is off", () => {
    const { container } = render(<VoiceIndicator />);
    expect(container.querySelector(".voice-ind")).toBeNull();
  });

  it("says what the microphone is doing, and pulses only while it listens", () => {
    setVoiceSettings({ enabled: true, wake: true });
    wakeModel.value = { state: "ready" };
    const c = voiceController();
    c.dispatch({ type: "start", wake: true });
    const { container, rerender } = render(<VoiceIndicator />);
    const ind = () => container.querySelector(".voice-ind") as HTMLElement;
    expect(ind().getAttribute("aria-label")).toContain("Sta ascoltando «Ehi RedGiant»");
    // A wake word of one's own: the indicator names it.
    setVoiceSettings({ wakeWords: { it: "Ciao computer" } });
    rerender(<VoiceIndicator />);
    expect(ind().getAttribute("aria-label")).toContain("Sta ascoltando «Ciao computer»");
    expect(ind().classList.contains("live")).toBe(true);
    // A drawn icon, never a character.
    expect(ind().querySelector("svg")).not.toBeNull();
    c.dispatch({ type: "wake" });
    rerender(<VoiceIndicator />);
    expect(ind().getAttribute("aria-label")).toContain(dictionaries.it.voiceListening);
    voicePaused.value = true;
    rerender(<VoiceIndicator />);
    expect(ind().getAttribute("aria-label")).toContain(dictionaries.it.voicePaused);
    expect(ind().classList.contains("live")).toBe(false);
  });

  it("opens its panel with «Talk now» and «Switch off»", () => {
    setVoiceSettings({ enabled: true, wake: false });
    voiceController().dispatch({ type: "start", wake: false });
    const { container, getByText } = render(<VoiceIndicator />);
    fireEvent.click(container.querySelector(".voice-ind") as HTMLElement);
    expect(getByText(dictionaries.it.voiceTalk)).toBeTruthy();
    fireEvent.click(getByText(dictionaries.it.voiceSwitchOff));
    expect(voiceSettings.value.enabled).toBe(false);
  });

  it("has words for every phase", () => {
    const base = { wake: true, paused: false, mic: "open", model: "ready" };
    const phases = [
      "idle",
      "wake",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "followup",
    ] as const;
    const labels = phases.map((p) => voiceLook(p, base).label);
    for (const l of labels) expect(l).toBeTruthy();
    expect(voiceLook("idle", { ...base, mic: "denied" }).label).toBe(
      dictionaries.it.voiceMicDenied,
    );
    expect(voiceLook("idle", { ...base, wake: false }).live).toBe(false);
    // The sound still asleep (a reload, a phone): it asks for a tap, it does not claim to listen.
    const asleep = voiceLook("idle", { ...base, asleep: true });
    expect([asleep.label, asleep.live]).toEqual([dictionaries.it.voiceTapToWake, false]);
  });
});
