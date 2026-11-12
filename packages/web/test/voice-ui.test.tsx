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

const { VoiceSettingsPage } = await import("../src/components/VoiceSettings.js");
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
    fireEvent.click(getByRole("switch", { name: dictionaries.it.vcWake }));
    expect(voiceSettings.value.wake).toBe(false);
    fireEvent.click(getByText(dictionaries.it.vcLangEn));
    expect(voiceSettings.value).toMatchObject({ lang: "en", voice: null });
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
    expect(ind().getAttribute("aria-label")).toContain(dictionaries.it.voiceWaiting);
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
  });
});
