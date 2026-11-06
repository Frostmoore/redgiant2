// @vitest-environment jsdom
// The mailbox lives with the automations (2026-11-07): a square in Settings > Automations and a
// line under the «On an email» trigger, both opening the same window. Connecting it from the
// editor keeps the draft; Escape closes only the window on top.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: string[] = [];
let mailbox: { configured: boolean; host?: string; user?: string } = { configured: false };

const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push(name);
        if (name === "automations") return Promise.resolve([]);
        if (name === "emailSettings") return Promise.resolve(mailbox);
        if (name === "setEmailSettings") {
          const a = args[0] as { host: string; user: string };
          mailbox = { configured: true, host: a.host, user: a.user };
          return Promise.resolve({});
        }
        if (name === "removeEmailSettings") {
          mailbox = { configured: false };
          return Promise.resolve({});
        }
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { Automations } = await import("../src/components/Automations.js");

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  mailbox = { configured: false };
});
afterEach(cleanup);

const input = (root: ParentNode, label: string) => {
  const field = [...root.querySelectorAll(".ui-field")].find((f) => f.textContent?.includes(label));
  return field?.querySelector("input") as HTMLInputElement;
};

describe("The mailbox, with the automations", () => {
  it("is a square on the Automations page that opens its window", async () => {
    const r = render(<Automations />);
    await waitFor(() => expect(r.getByText("Casella email")).toBeTruthy());
    const tile = r.getByText("Casella email").closest(".wz-tile") as HTMLElement;
    expect(tile.classList.contains("on")).toBe(false);
    expect(tile.textContent).toContain("Non collegata");
    fireEvent.click(tile);
    await waitFor(() => expect(document.querySelector(".email-settings")).not.toBeNull());
    const win = document.querySelector(".ui-modal") as HTMLElement;
    fireEvent.input(input(win, "Server di posta"), { target: { value: "imap.example.com" } });
    fireEvent.input(input(win, "Indirizzo"), { target: { value: "me@example.com" } });
    fireEvent.input(input(win, "Password per le app"), { target: { value: "secret" } });
    fireEvent.click(r.getByText("Collega la casella"));
    await waitFor(() => expect(calls).toContain("setEmailSettings"));
    await waitFor(() => expect(document.body.textContent).toContain("Leggo me@example.com"));
    // Port and encryption are still there, under the advanced part; so is disconnecting.
    expect(document.body.textContent).toContain("Porta");
    expect(document.body.textContent).toContain("Cifrata da subito");
    fireEvent.click(r.getByText("Rimuovi"));
    await waitFor(() => expect(calls).toContain("removeEmailSettings"));
    fireEvent.click(document.querySelector(".ui-modal-x") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".email-settings")).toBeNull());
  });

  it("is lit with its address once connected", async () => {
    mailbox = { configured: true, host: "imap.example.com", user: "me@example.com" };
    const r = render(<Automations />);
    await waitFor(() => expect(r.getByText("me@example.com")).toBeTruthy());
    const tile = r.getByText("Casella email").closest(".wz-tile") as HTMLElement;
    expect(tile.classList.contains("on")).toBe(true);
  });

  it("asks for it under the email trigger and keeps the draft while it is connected", async () => {
    const r = render(<Automations />);
    await waitFor(() => expect(r.getByText("Nuova automazione")).toBeTruthy());
    fireEvent.click(r.getByText("Nuova automazione"));
    await waitFor(() => expect(document.querySelector(".aw-editor")).not.toBeNull());
    const title = input(document, "Come si chiama");
    fireEvent.input(title, { target: { value: "Fatture" } });
    fireEvent.click(r.getByText("A una email"));
    await waitFor(() => expect(document.body.textContent).toContain("Prima collega la casella"));
    fireEvent.click(r.getByText("Collega la casella email"));
    await waitFor(() => expect(document.querySelector(".email-settings")).not.toBeNull());
    expect(document.querySelectorAll(".ui-modal")).toHaveLength(2);
    // Escape closes the mailbox's window only: the automation being written stays.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".email-settings")).toBeNull());
    expect(document.querySelectorAll(".ui-modal")).toHaveLength(1);
    expect(input(document, "Come si chiama").value).toBe("Fatture");
    mailbox = { configured: true, host: "imap.example.com", user: "me@example.com" };
    fireEvent.click(r.getByText("Collega la casella email"));
    await waitFor(() => expect(document.querySelectorAll(".ui-modal")).toHaveLength(2));
    const xs = document.querySelectorAll(".ui-modal-x");
    fireEvent.click(xs[xs.length - 1] as HTMLElement);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Guarda me@example.com su imap.example.com"),
    );
    expect(input(document, "Come si chiama").value).toBe("Fatture");
  });
});
