// @vitest-environment jsdom
import { DANGER_IDS, type Job } from "@redgiant/protocol";
import { fireEvent, render } from "@testing-library/preact";
import { beforeEach, describe, expect, it } from "vitest";
import type { SetupState } from "../src/api.js";
import { fromCron, toCron, whenWords } from "../src/components/Automations.js";
import {
  hardwareText,
  MoePrefetchSwitch,
  placeModel,
  roomTiers,
  SysmemAdvice,
} from "../src/components/LocalModels.js";
import { Safety } from "../src/components/Safety.js";
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
import { sysmemAdviceClosed } from "../src/state.js";

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

  it("says what this computer can run, for every kind of graphics card", () => {
    const hw = (
      gpus: {
        name: string;
        vramGb: number;
        vendor: "nvidia" | "amd" | "intel" | "other";
        integrated: boolean;
      }[],
      kind: "gpu" | "gpu-unknown" | "igpu" | "cpu",
      engine: "cpu" | "cuda" | "vulkan",
      vramGb = 0,
      maxModelGb = 6,
    ) => ({
      os: "linux",
      cpu: "x",
      cores: 8,
      ramGb: 32,
      diskFreeGb: 100,
      gpus,
      dockerGpu: false,
      gpuAccess: "" as const,
      windowsEngine: false,
      suggestion: { engine, kind, vramGb, maxModelGb },
    });
    const rtx = {
      name: "NVIDIA GeForce RTX 4080 SUPER",
      vramGb: 16,
      vendor: "nvidia" as const,
      integrated: false,
    };
    expect(hardwareText(hw([rtx], "gpu", "cuda", 16, 12.8))).toBe(
      "NVIDIA GeForce RTX 4080 SUPER con 16 GB di memoria video: ci girano veloci modelli fino a circa 12.8 GB.",
    );
    const radeon = {
      name: "AMD Radeon RX 7800 XT",
      vramGb: 16,
      vendor: "amd" as const,
      integrated: false,
    };
    expect(hardwareText(hw([radeon], "cpu", "cpu"))).toMatch(
      /^Qui il motore non riesce a raggiungere/,
    );
    const iris = { name: "Intel Iris Xe", vramGb: 0, vendor: "intel" as const, integrated: true };
    expect(hardwareText(hw([iris], "igpu", "vulkan", 0, 8))).toMatch(/^Una scheda video integrata/);
    expect(hardwareText(hw([], "cpu", "cpu"))).toMatch(/^Nessuna scheda video da usare/);
  });

  it("safety: four cards, ready choices, a switch per danger in a window, spending only when paid", () => {
    const state = (keys: string[], humanOnly: string[]) =>
      ({
        config: { completed: false },
        secretsSet: { keys, server: false, telegram: false },
        locked: {},
        names: { god: null, demigod: null, godPrompt: null },
        policy: { humanOnly, disabledDanger: [], dangers: DANGER_IDS.map((id) => ({ id })) },
        budgetUsd: null,
      }) as unknown as SetupState;
    const balanced = [
      "git-push",
      "git-history",
      "privilege",
      "disk",
      "deploy",
      "database-drop",
      "secrets-files",
      "platform",
    ];
    let save: (() => Promise<boolean>) | undefined;
    const r = render(<Safety s={state([], balanced)} register={(f) => (save = f)} />);
    const button = (name: RegExp | string) => r.getByRole("button", { name });
    expect(button(/^Equilibrata$/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/^Mi chiede$/).getAttribute("aria-pressed")).toBe("true");
    // Nothing paid per use: no spending limit to ask for.
    expect(r.getByText(/niente si paga a consumo/)).toBeTruthy();
    expect(r.queryByRole("textbox", { name: "altro" })).toBeNull();
    fireEvent.click(button(/^Prudente$/));
    expect(button(/^Prudente$/).getAttribute("aria-pressed")).toBe("true");
    // The switches are in a window, one per danger.
    expect(r.container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    fireEvent.click(button(/^Personalizza$/));
    const switches = [...r.container.querySelectorAll('[role="switch"]')];
    expect(switches).toHaveLength(DANGER_IDS.length);
    expect(switches.every((x) => x.getAttribute("aria-checked") === "true")).toBe(true);
    // One switch off: none of the ready choices any more.
    fireEvent.click(switches[0] as Element);
    expect(r.getByText(/Una scelta tua/)).toBeTruthy();
    fireEvent.click(button(/^Torna a Prudente$/));
    expect(r.queryByText(/Una scelta tua/)).toBeNull();
    // The wizard saves it when Next is pressed.
    expect(typeof save).toBe("function");
    r.unmount();
    const paid = render(<Safety s={state(["anthropic"], balanced)} register={() => {}} />);
    expect(paid.getByText(/Quanto può spendere RedGiant/)).toBeTruthy();
    fireEvent.click(paid.getByRole("button", { name: "$50" }));
    expect(paid.getByText(/Arrivato a \$50/)).toBeTruthy();
  });

  it("automations: choices in words become a schedule and come back from it", () => {
    const cases = [
      [{ kind: "daily", time: "08:30" }, "30 8 * * *", "Ogni giorno alle 08:30"],
      [{ kind: "weekdays", time: "08:00" }, "0 8 * * 1-5", "Dal lunedì al venerdì alle 08:00"],
      [
        { kind: "weekly", time: "17:00", days: [5, 1] },
        "0 17 * * 1,5",
        "Ogni settimana il lunedì, venerdì alle 17:00",
      ],
      [{ kind: "monthly", time: "09:00", day: 1 }, "0 9 1 * *", "Ogni mese il giorno 1 alle 09:00"],
      [{ kind: "hours", every: 3 }, "0 */3 * * *", "Ogni 3 ore"],
    ] as const;
    for (const [when, cron, words] of cases) {
      expect(toCron(when as never)).toBe(cron);
      const back = fromCron(cron, false);
      expect(toCron(back)).toBe(cron);
      expect(whenWords(back)).toBe(words);
    }
    expect(toCron({ kind: "webhook" })).toBeNull();
    expect(fromCron(undefined, true)).toEqual({ kind: "webhook" });
    // A schedule the form does not know stays as it is, said as such.
    expect(fromCron("*/7 1-3 * 2 *", false)).toEqual({ kind: "custom", cron: "*/7 1-3 * 2 *" });
  });
});

describe("room for a local model (2026-11-04)", () => {
  const hw = (kind: "gpu" | "igpu", maxModelGb: number) =>
    ({
      ramGb: 64,
      freeRamGb: 30,
      suggestion: { engine: "cuda", kind, vramGb: kind === "gpu" ? 16 : 0, maxModelGb },
    }) as unknown as SetupState["hardware"];

  it("fills the card, then the RAM, then the SSD", () => {
    const tiers = roomTiers(hw("gpu", 12.8), 500);
    expect(tiers.map((x) => x.kind)).toEqual(["card", "ram", "ssd"]);
    const parts = placeModel(58.3, tiers);
    expect(parts.map((p) => p.kind)).toEqual(["card", "ram", "ssd"]);
    expect(parts[0]?.gb).toBe(12.8);
    expect(parts[1]?.gb).toBe(27);
    expect(parts[2]?.gb).toBeCloseTo(18.5);
  });

  it("memory shared with the processor is one tier; without SSD stream only memory counts", () => {
    expect(roomTiers(hw("igpu", 8), 500).map((x) => x.kind)).toEqual(["memory", "ssd"]);
    expect(roomTiers(hw("gpu", 12.8)).map((x) => x.kind)).toEqual(["card"]);
  });
});

describe("NVIDIA's Sysmem Fallback advice (G32.1)", () => {
  it("says where the setting is and closes for good", () => {
    sysmemAdviceClosed.value = false;
    const r = render(<SysmemAdvice />);
    expect(r.getByText(/Prefer No Sysmem Fallback/)).toBeTruthy();
    expect(r.getByText(/llama-server\.exe/)).toBeTruthy();
    expect(r.container.textContent).toMatch(/da 2 a 3,5 volte/);
    fireEvent.click(r.getByText("Ho capito"));
    expect(sysmemAdviceClosed.value).toBe(true);
    expect(localStorage.getItem("rg.sysmemAdvice")).toBe("1");
  });
});

describe("«next layer ahead» (G32.2)", () => {
  it("turns on, says what it downloads, and stays off where the version has no binaries", () => {
    const seen: boolean[] = [];
    const r = render(
      <MoePrefetchSwitch state="available" on={false} onChange={(v) => seen.push(v)} />,
    );
    expect(r.getByText("Strato dopo in anticipo")).toBeTruthy();
    expect(r.getByText("sperimentale")).toBeTruthy();
    expect(r.container.textContent).toMatch(/circa \d+ MB/);
    fireEvent.click(r.container.querySelector("[role=switch]") as HTMLButtonElement);
    expect(seen).toEqual([true]);
    r.unmount();
    const missing = render(
      <MoePrefetchSwitch state="missing" on={true} onChange={(v) => seen.push(v)} />,
    );
    const button = missing.container.querySelector("[role=switch]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(missing.getByText(/senza il motore modificato/)).toBeTruthy();
    missing.unmount();
    // With the engine in Docker it speaks of the patched image instead of the Windows zip.
    const docker = render(
      <MoePrefetchSwitch variant="cuda" state="missing" on={false} onChange={() => {}} />,
    );
    expect(docker.getByText(/L'immagine del motore modificato/)).toBeTruthy();
    expect(docker.container.textContent).toMatch(/runtime NVIDIA di Docker/);
    fireEvent.click(button);
    expect(seen).toEqual([true]);
  });
});
