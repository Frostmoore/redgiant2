// @vitest-environment jsdom
import type { Job } from "@redgiant/protocol";
import { fireEvent, render } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Choice,
  Field,
  JobView,
  Progress,
  progressText,
  Step,
  Toggle,
  timeLeft,
} from "../src/components/ui.js";
import { lang } from "../src/i18n.js";

beforeEach(() => {
  lang.value = "it";
});

describe("ui pieces", () => {
  it("a step says what it is for and can be skipped", () => {
    let skipped = false;
    const r = render(
      <Step
        title="Telegram"
        purpose="Parla con RedGiant dal telefono."
        onSkip={() => (skipped = true)}
      >
        <p>corpo</p>
      </Step>,
    );
    expect(r.getByText("Parla con RedGiant dal telefono.")).toBeTruthy();
    fireEvent.click(r.getByText("Salta questo passo"));
    expect(skipped).toBe(true);
  });

  it("a field shows its help, or its error instead", () => {
    const r = render(
      <Field label="Chiave" help="La trovi nella console." error="Chiave rifiutata">
        <input />
      </Field>,
    );
    expect(r.queryByText("La trovi nella console.")).toBeNull();
    expect(r.getByRole("alert").textContent).toContain("Chiave rifiutata");
  });

  it("a switch has its words next to it and turns on and off", () => {
    let value = false;
    const r = render(
      <Toggle
        label="Cancellare cartelle intere"
        description="per esempio rm -rf"
        checked={value}
        onChange={(v) => (value = v)}
      />,
    );
    const sw = r.getByRole("switch", { name: "Cancellare cartelle intere" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(value).toBe(true);
  });

  it("cards pick one, or several", () => {
    const options = [
      { id: "a" as const, title: "Abbonamento Claude", description: "…" },
      { id: "b" as const, title: "Modello sul computer", description: "…" },
    ];
    let one: string[] = ["a"];
    const r1 = render(<Choice options={options} value={one} onChange={(v) => (one = v)} />);
    fireEvent.click(r1.getByRole("button", { name: /Modello sul computer/ }));
    expect(one).toEqual(["b"]);
    r1.unmount();
    let many: string[] = ["a"];
    const r2 = render(
      <Choice options={options} value={many} onChange={(v) => (many = v)} multiple />,
    );
    fireEvent.click(r2.getByRole("button", { name: /Modello sul computer/ }));
    expect(many).toEqual(["a", "b"]);
  });

  it("says amounts, speed and time left in words", () => {
    expect(timeLeft(30)).toBe("manca meno di un minuto");
    expect(timeLeft(4 * 60)).toBe("mancano circa 4 min");
    expect(timeLeft(80 * 60)).toBe("mancano circa 1 h 20 min");
    expect(
      progressText({
        done: 300 * 1_048_576,
        total: 719 * 1_048_576,
        rate: 2 * 1_048_576,
        secondsLeft: 210,
      }),
    ).toBe("300.0 MB di 719.0 MB · 2.0 MB/s · mancano circa 4 min");
    expect(progressText({ done: 1024, total: null, rate: null, secondsLeft: null })).toBe("1.0 KB");
    const r = render(
      <Progress progress={{ done: 50, total: 200, rate: null, secondsLeft: null }} unit="count" />,
    );
    expect(r.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  it("a failed job shows its steps, the error in plain words and the details", () => {
    const job: Job = {
      id: "j1",
      kind: "unknown-kind",
      vars: {},
      state: "failed",
      steps: [
        { id: "first", state: "done" },
        { id: "second", state: "failed" },
      ],
      error: { code: "nobody-knows", message: "llama.cpp: failed to load model" },
      startedAt: "2026-11-03T08:00:00.000Z",
      endedAt: "2026-11-03T08:01:00.000Z",
    };
    const r = render(<JobView job={job} />);
    expect(r.getAllByRole("listitem").map((li) => li.className)).toEqual(["done", "failed"]);
    expect(r.getByText(/Qualcosa non è andato/)).toBeTruthy();
    expect(r.getByText("llama.cpp: failed to load model")).toBeTruthy();
  });
});
