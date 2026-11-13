// @vitest-environment jsdom
// RedGiant OS in Settings › System (G39.1): Wi-Fi (join with a password that leaves the page at
// once, forget only after our window), HTTPS (the redirect only after this device reached https
// with the certificate trusted), updates (apply and restart only after our window), and nothing
// at all where the installation is not RedGiant OS. No native checkboxes, radios or dialogs.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const wifi = {
  available: true,
  device: "wlan0",
  state: "connected",
  connected: "Casa",
  networks: [
    { ssid: "Casa", security: "psk", signal: 90, connected: true, known: true },
    { ssid: "Vicino", security: "psk", signal: 35, connected: false, known: false },
  ],
  known: ["Casa"],
  wired: true,
  address: "192.168.1.31",
};
const https = {
  available: true,
  on: true,
  ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  fingerprint: "AA:BB:CC",
  until: "Dec 14 00:00:00 2027 GMT",
  names: ["redgiant.local", "192.168.1.20"],
  redirect: false,
  viaLocal: false,
  inFront: null,
};
const updates = {
  available: true,
  update: {
    state: "available",
    installed: "3.7.0",
    latest: "3.7.1",
    gate: "normal",
    note: null,
    step: null,
    checkedAt: null,
  },
  running: false,
  security: {
    lastRun: "2026-11-12T06:00:00.000Z",
    result: "success",
    upgraded: 3,
    rebootRequired: true,
    packages: ["linux-image-amd64"],
  },
};
let answers: Record<string, unknown> = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name in answers) return Promise.resolve(answers[name]);
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refresh: () => Promise.resolve(),
}));

const { OsNetworkSection, OsUpdatesSection, WifiPanel, HttpsPanel, OsUpdatesPanel } = await import(
  "../src/components/OsSystem.js"
);
const { Dialogs } = await import("../src/components/dialogs.js");
const NATIVE = 'input[type="checkbox"], input[type="radio"]';
const fetches: string[] = [];
let trusted = false;

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  fetches.length = 0;
  trusted = false;
  answers = {
    setupWifi: wifi,
    setupHttps: https,
    setupOsUpdates: updates,
    setupWifiConnect: { state: "connected", wifi },
    setSetupHttps: { ...https, redirect: true },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetches.push(url);
      if (String(url).startsWith("https://") && !trusted) throw new TypeError("certificate");
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("not RedGiant OS", () => {
  it("shows nothing at all", async () => {
    answers = {
      setupWifi: { available: false, why: "no_helper" },
      setupHttps: { available: false },
      setupOsUpdates: { available: false, update: null, running: false, security: null },
    };
    const r = render(
      <>
        <OsNetworkSection />
        <OsUpdatesSection />
      </>,
    );
    await waitFor(() => expect(calls.filter(([n]) => n.startsWith("setup")).length).toBe(3));
    await new Promise((d) => setTimeout(d, 0));
    expect(r.container.textContent).toBe("");
  });
});

describe("Wi-Fi", () => {
  it("joins a network; the password leaves the field at once", async () => {
    const r = render(<WifiPanel initial={wifi as never} />);
    expect(r.container.textContent).toContain("Collegata a «Casa» (192.168.1.31)");
    expect(r.container.textContent).toContain("il Wi-Fi resta di riserva");
    fireEvent.click(r.getByText("Vicino"));
    const field = r.container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(field, { target: { value: "una password" } });
    fireEvent.click(r.getByText("Collegati"));
    await waitFor(() => r.getByText(/Collegata a «Vicino»/));
    expect(calls.find(([n]) => n === "setupWifiConnect")?.[1]).toEqual([
      "Vicino",
      "una password",
      false,
    ]);
    expect(r.container.querySelector('input[type="password"]')).toBeNull();
    expect(r.container.querySelectorAll(NATIVE)).toHaveLength(0);
  });

  it("forgets only after our window", async () => {
    const r = render(
      <>
        <WifiPanel initial={wifi as never} />
        <Dialogs />
      </>,
    );
    fireEvent.click(r.getByLabelText("Dimentica"));
    await waitFor(() => r.getByText("Dimenticare «Casa»?"));
    fireEvent.click(r.getByText("Annulla"));
    await new Promise((d) => setTimeout(d, 0));
    expect(calls.some(([n]) => n === "setupWifiForget")).toBe(false);
  });

  it("says why when the machine has no Wi-Fi", () => {
    const r = render(<WifiPanel initial={{ available: false, why: "no_wifi" }} />);
    expect(r.container.textContent).toContain("non ha una scheda Wi-Fi");
  });
});

describe("HTTPS in the local network", () => {
  it("offers the certificate, and keeps http while this device does not trust it", async () => {
    const r = render(<HttpsPanel initial={https as never} />);
    expect(r.container.textContent).toContain("https://redgiant.local");
    expect(r.container.textContent).toContain("AA:BB:CC");
    const a = r.getByText("Scarica il certificato").closest("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("/redgiant-ca.crt");
    fireEvent.click(r.getByText("Prova questo dispositivo"));
    await waitFor(() => r.getByText(/non si fida ancora del certificato/));
    expect(calls.some(([n]) => n === "setSetupHttps")).toBe(false);
  });

  it("turns the redirect on once https answered with the certificate trusted", async () => {
    trusted = true;
    const r = render(<HttpsPanel initial={https as never} />);
    fireEvent.click(r.getByText("Prova questo dispositivo"));
    await waitFor(() => r.getByText(/Questo dispositivo si fida/));
    expect(fetches.some((u) => u.startsWith("https://") && u.endsWith("/api/health"))).toBe(true);
    expect(calls.find(([n]) => n === "setSetupHttps")?.[1]).toEqual([
      { redirect: true, trusted: true },
    ]);
  });

  it("says when another HTTPS is already in front, and offers no redirect", () => {
    const r = render(<HttpsPanel initial={{ ...https, inFront: "tailscale" } as never} />);
    expect(r.container.textContent).toContain("attraverso tailscale");
    expect(r.queryByText("Prova questo dispositivo")).toBeNull();
  });
});

describe("updates", () => {
  it("updates and restarts only after our window, in plain words", async () => {
    const r = render(
      <>
        <OsUpdatesPanel initial={updates as never} />
        <Dialogs />
      </>,
    );
    expect(r.container.textContent).toContain("RedGiant 3.7.1 è pronto da installare");
    expect(r.container.textContent).toContain("chiede un riavvio");
    fireEvent.click(r.getByText("Riavvia ora"));
    await waitFor(() => r.getByText("Riavviare la macchina adesso?"));
    expect(r.container.textContent).toContain("gli agenti al lavoro vengono interrotti");
    fireEvent.click(r.getByText("Annulla"));
    await new Promise((d) => setTimeout(d, 0));
    expect(calls.some(([n]) => n === "setupReboot")).toBe(false);
    fireEvent.click(r.getByText("Aggiorna alla 3.7.1"));
    await waitFor(() => r.getByText("Aggiornare RedGiant alla 3.7.1?"));
    fireEvent.click(r.getByText("Aggiorna ora"));
    await waitFor(() => expect(calls.find(([n]) => n === "updateAct")?.[1]).toEqual(["update"]));
  });

  it("never offers to apply a breaking release in place", () => {
    const r = render(
      <OsUpdatesPanel
        initial={
          {
            ...updates,
            update: { ...updates.update, state: "breaking", gate: "breaking" },
          } as never
        }
      />,
    );
    expect(r.queryByText(/Aggiorna alla/)).toBeNull();
    expect(r.container.textContent).toContain("non si installa sopra");
  });
});
