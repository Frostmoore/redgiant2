// @vitest-environment jsdom
// G33.4: the keychain's page (no value ever on it until asked, with a confirmation), a secret held
// back before it leaves a chat, the magic automation that cannot be approved while something it
// needs is missing, the summary's default from the server, and no check marks.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const VALUE = "rk_live_Zq81mXv3PdQw7Tn2LbYc";
const entry = {
  id: "key_1",
  name: "revolut_api",
  service: "Revolut Business",
  brand: "revolut",
  category: "bank",
  tags: ["lavoro"],
  username: "",
  url: "",
  hosts: ["b2b.revolut.com"],
  notes: "",
  expires: new Date(Date.now() + 5 * 86400000).toISOString(),
  ask: "session",
  allow: { allAgents: true, agents: [], tools: [], automations: [] },
  inject: { header: "Authorization", format: "Bearer {value}" },
  length: VALUE.length,
  createdAt: "2026-11-07T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
  lastUsedAt: null,
  uses: 0,
};
const magic: Record<string, unknown> = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "vault")
          return Promise.resolve({
            ready: true,
            protection: "file",
            entries: [entry],
            system: [
              {
                id: "setup:telegram",
                service: "Telegram",
                category: "api",
                section: "telegram",
                what: "bot token",
                kind: "chat",
              },
            ],
            uses: [],
            proxy: false,
          });
        if (name === "revealVault") return Promise.resolve({ value: VALUE });
        if (name === "installed" || name === "automations") return Promise.resolve([]);
        if (name === "compactionDefaults") return Promise.resolve({ at: 0.8, keep: 0.12 });
        if (name === "getMagic") return Promise.resolve(magic);
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

// The conversation itself is not under test here (it needs the live connection).
vi.mock("../src/components/Chat.js", () => ({ Chat: () => null }));

const { Keychain, generatePassword } = await import("../src/components/Keychain.js");
const { Composer } = await import("../src/components/Composer.js");
const { MagicChat } = await import("../src/components/MagicAutomation.js");
const { CompactionSettings } = await import("../src/components/CompactionSettings.js");

const CHECK = 'path[d="M20 6L9 17l-5-5"]';

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
});
afterEach(() => cleanup());

describe("the keychain page (G33.4)", () => {
  it("lists credentials without their values, warns before they expire, shows the system's keys", async () => {
    const r = render(<Keychain />);
    await waitFor(() => expect(r.getAllByText("Revolut Business").length).toBeGreaterThan(0));
    expect(r.container.textContent).not.toContain(VALUE);
    expect(r.container.textContent).toContain("Scade tra 5 giorni");
    expect(r.getByText("Telegram")).toBeTruthy();
    expect(r.container.querySelector(CHECK)).toBeNull();
  });

  it("shows a value only after the person confirms, and never asks the server before", async () => {
    const r = render(<Keychain />);
    await waitFor(() => r.getAllByText("Revolut Business"));
    fireEvent.click(r.container.querySelector(".kc-item") as HTMLElement);
    await waitFor(() => r.getByText("Mostra"));
    expect(calls.some(([n]) => n === "revealVault")).toBe(false);
    fireEvent.click(r.getByText("Mostra"));
    await waitFor(() => r.getByText("Mostrare il segreto?"));
    expect(calls.some(([n]) => n === "revealVault")).toBe(false);
    const buttons = r.getAllByText("Mostra");
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(r.container.textContent).toContain(VALUE));
    expect(calls).toContainEqual(["revealVault", ["key_1"]]);
  });

  it("makes passwords from the browser's randomness, of the asked length and kind", () => {
    const a = generatePassword(32, "symbols");
    expect(a).toHaveLength(32);
    expect(generatePassword(32, "symbols")).not.toBe(a);
    expect(generatePassword(6, "digits")).toMatch(/^\d{6}$/);
    expect(generatePassword(20, "letters")).toMatch(/^[A-Za-z0-9]{20}$/);
  });
});

describe("a secret in a chat (G33.4)", () => {
  it("is held back with the way to the keychain, or sent without it", async () => {
    const sent: string[] = [];
    const r = render(
      <Composer
        onSend={async (text) => void sent.push(text)}
        running={false}
        placeholder="Scrivi"
        lang="it-IT"
        queues={false}
      />,
    );
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: `la chiave è ${VALUE}` } });
    fireEvent.click(r.container.querySelector("button.send") as HTMLElement);
    await waitFor(() => r.getByText("Questo messaggio contiene un segreto"));
    expect(sent).toEqual([]);
    expect(r.getByText("Mettilo nel portachiavi")).toBeTruthy();
    fireEvent.click(r.getByText("Invia senza"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).not.toContain(VALUE);
    expect(sent[0]).toContain("[secret removed]");
  });

  it("lets plain talk about passwords through", async () => {
    const sent: string[] = [];
    const r = render(
      <Composer
        onSend={async (text) => void sent.push(text)}
        running={false}
        placeholder="Scrivi"
        lang="it-IT"
        queues={false}
      />,
    );
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "uso un password manager" } });
    fireEvent.click(r.container.querySelector("button.send") as HTMLElement);
    await waitFor(() => expect(sent).toEqual(["uso un password manager"]));
  });
});

describe("a magic automation's proposal (G33.4)", () => {
  const proposal = (ready: boolean) => ({
    id: "magic_1",
    title: "Revolut",
    request: "x",
    sessionId: "s1",
    agentId: "g",
    status: "ready",
    automationId: null,
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    proposal: {
      yaml: "name: r\n",
      recipe: {
        name: "r",
        description: "Il conto",
        on: { cron: "0 3 * * *", timezone: "Europe/Rome" },
        agent: "god",
        instructions: "Leggi il conto",
        notify: { when: "always", to: ["web"] },
      },
      summary: "Ogni notte",
      needs: [
        {
          kind: "credential",
          what: "revolut_api",
          service: "Revolut",
          host: "b2b.revolut.com",
          why: "",
          ready,
        },
      ],
      at: "2026-11-07T00:00:00Z",
    },
  });

  it("cannot be approved while a credential is missing; the button opens the keychain's form", async () => {
    const r = render(
      <MagicChat
        m={proposal(false) as never}
        onClose={() => {}}
        onChange={() => {}}
        onCreated={() => {}}
      />,
    );
    const approve = r.getByText("Approva e crea") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(r.getByText("Prima di approvare, sistema quello che manca:")).toBeTruthy();
    fireEvent.click(r.getByText("Aggiungi al portachiavi"));
    await waitFor(() => r.getByText("Una nuova credenziale"));
    const inputs = r.container.querySelectorAll(".kc-window input");
    expect((inputs[0] as HTMLInputElement).value).toBe("Revolut");
    expect((inputs[1] as HTMLInputElement).value).toBe("revolut_api");
    cleanup();
    const ok = render(
      <MagicChat
        m={proposal(true) as never}
        onClose={() => {}}
        onChange={() => {}}
        onCreated={() => {}}
      />,
    );
    expect((ok.getByText("Approva e crea") as HTMLButtonElement).disabled).toBe(false);
    expect(ok.getByText("C'è tutto quello che serve.")).toBeTruthy();
  });
});

describe("the summary's slider (G33.4)", () => {
  it("starts from the server's default for the agent's model (12% on a local one)", async () => {
    const r = render(<CompactionSettings agent={{ id: "a", name: "A", kind: "agent" } as never} />);
    await waitFor(() => expect(r.getAllByText("l'ultimo 12%").length).toBeGreaterThan(0));
    expect(r.container.textContent).toContain("tenendo il 12%");
  });
});

describe("a long paste becomes a file (p3.3.1)", () => {
  const long = Array.from({ length: 60 }, (_, i) => `# line ${i}\n- item ${i}`).join("\n");
  const paste = (box: HTMLElement, text: string) =>
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => text } });

  it("shows a card with its preview, sends it as an attachment, and can go back to text", async () => {
    const sent: [string, unknown[]][] = [];
    const r = render(
      <Composer
        onSend={async (text, files) => void sent.push([text, files])}
        running={false}
        placeholder="Scrivi"
        lang="it-IT"
        queues={false}
      />,
    );
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    // A short paste stays text (the browser puts it in the box).
    paste(box, "breve");
    expect(r.container.querySelector("[data-testid=pasted]")).toBeNull();
    paste(box, long);
    const card = await waitFor(() => r.getByTestId("pasted"));
    expect(card.textContent).toMatch(/pasted-\d{4}-\d{2}-\d{2}-\d{6}\.md/);
    expect(card.textContent).toContain("120 righe");
    expect(card.textContent).toContain("# line 0");
    // Opened whole, then closed.
    fireEvent.click(card.querySelector(".pasted-open") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".pasted-full")?.textContent).toBe(long));
    fireEvent.click(r.getByText("Chiudi"));
    // Paste as text instead: the card goes, the text is in the box.
    fireEvent.click(r.getByText("Incolla come testo"));
    expect(r.container.querySelector("[data-testid=pasted]")).toBeNull();
    expect(box.value).toBe(long);
    // Pasted again and sent: it travels as an attachment.
    fireEvent.input(box, { target: { value: "guarda" } });
    paste(box, long);
    await waitFor(() => r.getByTestId("pasted"));
    fireEvent.click(r.container.querySelector("button.send") as HTMLElement);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.[0]).toBe("guarda");
    expect(sent[0]?.[1]).toEqual([expect.objectContaining({ kind: "pasted", content: long })]);
  });

  it("can be removed", async () => {
    const r = render(
      <Composer onSend={async () => {}} running={false} placeholder="Scrivi" lang="it-IT" />,
    );
    const box = r.container.querySelector("textarea") as HTMLTextAreaElement;
    paste(box, "x".repeat(2500));
    const card = await waitFor(() => r.getByTestId("pasted"));
    expect(card.textContent).toMatch(/\.txt/);
    fireEvent.click(card.querySelector(".icon-button") as HTMLElement);
    expect(r.container.querySelector("[data-testid=pasted]")).toBeNull();
  });
});
