// @vitest-environment jsdom
// G38.3: the magic integration's window. «Approve and install» is off while something is missing
// (a key, a failing test, an undeclared host) and on when nothing is; the key goes from its own
// window straight to the server, never shown again; a key already there is given only after the
// person confirms; the Extensions page has both magic buttons; no native inputs for choices.
import type { MagicExtension } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const SECRET = "ntk_live_Q7mX2pV9sR4tW8yZ3bC6";

const pkg = (o: Partial<MagicExtension> = {}): MagicExtension => ({
  id: "magicx_1",
  kind: "integration",
  title: "Le mie note",
  request: "Collegami a Notes",
  sessionId: "s1",
  agentId: "god",
  status: "ready",
  proposal: {
    name: "notes",
    title: "Le mie note",
    summary: "Legge le tue note dal servizio Notes.",
    hosts: ["api.notes.test"],
    credentials: [
      {
        name: "notes_api",
        service: "Notes",
        hosts: ["api.notes.test"],
        header: "Authorization",
        format: "Bearer {value}",
        why: "per leggere le note",
      },
    ],
    parts: [
      {
        kind: "tool",
        name: "notes-list",
        description: "Elenca le note.",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        command: "node list.mjs",
        files: { "list.mjs": "console.log(1)" },
        proposalId: "prop_1",
        status: "failed",
        tests: [{ name: "test 1", passed: false, detail: "exit 2\nnotes_api is not given" }],
      },
    ],
    at: "2026-11-12T00:00:00Z",
  },
  checks: [
    {
      kind: "credential",
      what: "notes_api",
      ok: false,
      service: "Notes",
      hosts: ["api.notes.test"],
      exists: false,
      detail: "missing",
    },
    { kind: "test", what: "notes-list", ok: false, detail: "test 1" },
  ],
  canApprove: false,
  installed: [],
  createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z",
  ...o,
});

const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (["proposals", "installed", "mcpServers", "mcpStatus", "magicExts"].includes(name))
          return Promise.resolve([]);
        if (name === "setup") return Promise.resolve({ config: {}, secretsSet: {} });
        return Promise.resolve(pkg());
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));
vi.mock("../src/components/Chat.js", () => ({ Chat: () => null }));

const { MagicExtChat } = await import("../src/components/MagicExtension.js");
const { Extensions } = await import("../src/components/Extensions.js");
const { asking } = await import("../src/components/dialogs.js");

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  asking.value = [];
});
afterEach(() => cleanup());

const approveButton = (r: ReturnType<typeof render>) =>
  r.getByText("Approva e installa") as HTMLButtonElement;

describe("the magic integration's window (G38.3)", () => {
  it("keeps «Approva e installa» off while a key and a test are missing", () => {
    const r = render(<MagicExtChat m={pkg()} onClose={() => {}} onChange={() => {}} />);
    expect(approveButton(r).disabled).toBe(true);
    expect(r.getByText("Prima di installarla manca questo:")).toBeTruthy();
    expect(r.getByText("La chiave per Notes")).toBeTruthy();
    expect(r.getByText("Il test di notes-list")).toBeTruthy();
    // What it is: its tool, its arguments, where it goes.
    expect(r.getByText("notes-list")).toBeTruthy();
    expect(r.container.textContent).toContain("q");
    expect(r.container.textContent).toContain("api.notes.test");
  });

  it("is off for an undeclared host and while the tests run again", () => {
    const host = render(
      <MagicExtChat
        m={pkg({
          checks: [
            { kind: "host", what: "elsewhere.example.org", ok: false, detail: "undeclared" },
          ],
        })}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(host.getByText("L'indirizzo elsewhere.example.org")).toBeTruthy();
    expect(approveButton(host).disabled).toBe(true);
    cleanup();
    const testing = render(
      <MagicExtChat
        m={pkg({ status: "testing", checks: [] })}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(testing.getByText("I test girano di nuovo nella sandbox…")).toBeTruthy();
    expect(approveButton(testing).disabled).toBe(true);
  });

  it("is on when nothing is missing, and only the person's click installs", async () => {
    const r = render(
      <MagicExtChat
        m={pkg({ checks: [{ kind: "test", what: "notes-list", ok: true }], canApprove: true })}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(approveButton(r).disabled).toBe(false);
    fireEvent.click(approveButton(r));
    await waitFor(() => expect(calls.some(([n]) => n === "approveMagicExt")).toBe(true));
  });

  it("adds the key from its own window, straight to the server", async () => {
    const r = render(<MagicExtChat m={pkg()} onClose={() => {}} onChange={() => {}} />);
    fireEvent.click(r.getByText("Aggiungi al portachiavi"));
    await waitFor(() => r.getByText("Chiave per Notes"));
    const input = r.container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(input, { target: { value: SECRET } });
    fireEvent.click(r.getByText("Salva nel Portachiavi"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "addMagicExtCredential")?.[1]).toEqual([
        "magicx_1",
        "notes_api",
        SECRET,
      ]),
    );
    await waitFor(() => expect(r.queryByText("Chiave per Notes")).toBeNull());
    expect(r.container.textContent).not.toContain(SECRET);
  });

  it("gives a key already in the keychain only after the person confirms", async () => {
    const r = render(
      <MagicExtChat
        m={pkg({
          checks: [
            {
              kind: "credential",
              what: "notes_api",
              ok: false,
              service: "Notes",
              hosts: ["api.notes.test"],
              exists: true,
              detail: "not-bound",
            },
          ],
        })}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    fireEvent.click(r.getByText("Dalla a questi strumenti"));
    await waitFor(() => expect(asking.value.length).toBe(1));
    expect(calls.some(([n]) => n === "bindMagicExtCredential")).toBe(false);
    asking.value[0]?.done(true as never);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "bindMagicExtCredential")?.[1]).toEqual([
        "magicx_1",
        "notes_api",
      ]),
    );
  });

  it("an installed package changes through God and uninstalls after a confirmation", async () => {
    const r = render(
      <MagicExtChat
        m={pkg({ status: "done", installed: ["notes-list"], checks: [] })}
        onClose={() => {}}
        onChange={() => {}}
      />,
    );
    expect(
      r.getByText("Installata: ogni agente ha questi strumenti dalla sua prossima conversazione."),
    ).toBeTruthy();
    fireEvent.click(r.getByText("Disinstalla"));
    await waitFor(() => expect(asking.value.length).toBe(1));
    asking.value[0]?.done(true as never);
    await waitFor(() => expect(calls.some(([n]) => n === "uninstallMagicExt")).toBe(true));
  });

  it("the Extensions page has both magic buttons", async () => {
    const r = render(<Extensions />);
    expect(r.getByText("Integrazione magica")).toBeTruthy();
    expect(r.getByText("Estensione magica")).toBeTruthy();
    fireEvent.click(r.getByText("Integrazione magica"));
    await waitFor(() => r.getByText("Quale servizio, e per farci cosa?"));
    expect(r.container.querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
  });
});
