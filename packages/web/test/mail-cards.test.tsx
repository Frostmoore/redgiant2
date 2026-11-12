// @vitest-environment jsdom
// Email for the agents (G38.1) on the page: the request to send shows the email field by field
// (the real recipient, the text whole) and never «always»; a search shows senders and subjects; a
// message read shows its headers, attachments and text as plain text; a mailbox opens to the agents
// with our own switch.
import {
  formatMailList,
  formatMailMessage,
  type Mailbox,
  type PermissionRequestInfo,
} from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: () => {} }),
  getApi: () =>
    new Proxy(
      {},
      {
        get:
          (_, name: string) =>
          (...args: unknown[]) => {
            calls.push([name, args]);
            return Promise.resolve({});
          },
      },
    ) as never,
}));

const state = await import("../src/state.js");
const { PermissionCard } = await import("../src/components/Chat.js");
const { MailToolCard, mailSummary } = await import("../src/components/MailCards.js");
const { MailboxEditor } = await import("../src/components/EmailSettings.js");

const send: PermissionRequestInfo = {
  requestId: "m1",
  agentId: "desk",
  agentName: "Desk",
  projectId: null,
  tool: "mail_send",
  input: {
    to: ["payouts@evil.example"],
    subject: "Invoices",
    body: "Here they are.",
    message: {
      mailbox: "Lavoro",
      from: "marta@example.test",
      to: ["payouts@evil.example"],
      cc: [],
      bcc: ["hidden@evil.example"],
      subject: "Invoices",
      body: "Here they are.\n<img src=x onerror=alert(1)>",
      attachments: [{ name: "fatture.zip", size: 2_400_000 }],
    },
  },
  reasons: ["sends an email"],
  danger: ["outgoing-mail"],
  createdAt: "2026-11-12T10:00:00.000Z",
  sessionId: "s1",
};

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  state.agents.value = [{ id: "desk", name: "Desk", kind: "assistant" }] as never;
});
afterEach(() => cleanup());

describe("the request to send an email (G38.1)", () => {
  it("shows who it goes to and what it says, whole, and no «always»", () => {
    const { container } = render(<PermissionCard r={send} />);
    const card = container.querySelector(".permission") as HTMLElement;
    expect(card.querySelector(".permission-what")?.textContent).toBe(
      "Invia un'email a payouts@evil.example, hidden@evil.example con oggetto «Invoices», 1 allegato, dalla casella «Lavoro»",
    );
    const mail = card.querySelector(".mail-request") as HTMLElement;
    const rows = [...mail.querySelectorAll(".mail-request-row")].map((r) => r.textContent);
    expect(rows).toEqual([
      "Damarta@example.test (Lavoro)",
      "Apayouts@evil.example",
      "Ccnhidden@evil.example",
      "OggettoInvoices",
      "Allegatifatture.zip (2,3 MB)",
    ]);
    // The text whole, as text: nothing in it becomes HTML.
    const body = mail.querySelector(".mail-request-body") as HTMLElement;
    expect(body.textContent).toBe("Here they are.\n<img src=x onerror=alert(1)>");
    expect(mail.querySelector("img")).toBeNull();
    expect(card.querySelector(".permission-because")?.textContent).toBe("Inviare un'email");
    const labels = [...card.querySelectorAll(".permission-actions button")].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain("Sempre");
    expect(labels).not.toContain("In questa chat");
    expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("speaks English too", () => {
    lang.value = "en";
    const { container } = render(<PermissionCard r={send} />);
    expect(container.querySelector(".mail-request-title")?.textContent).toBe(
      "The email, as it would leave",
    );
    expect(container.querySelector(".mail-request-to dt")?.textContent).toBe("To");
  });
});

describe("the mail tools' cards (G38.1)", () => {
  const list = formatMailList(
    { mailbox: "Lavoro", address: "marta@example.test", folder: "INBOX" },
    2,
    [
      {
        id: 7,
        date: "2026-11-12 09:10",
        from: "Anna Rossi <anna@team.example>",
        subject: "Lunedì alle 10?",
        unread: true,
        attachments: 0,
      },
      {
        id: 3,
        date: "2026-11-02 10:00",
        from: "billing@bank.example",
        subject: "Fattura di novembre",
        unread: false,
        attachments: 1,
      },
    ],
  );

  it("a search: senders, subjects, unread in bold, attachments drawn", () => {
    const { container } = render(<MailToolCard tool="mail_search" output={list} />);
    const rows = [...container.querySelectorAll(".mail-list li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains("unread")).toBe(true);
    expect(rows[0]?.querySelector(".mail-from")?.textContent).toBe("Anna Rossi");
    expect(rows[0]?.querySelector(".mail-subject")?.textContent).toBe("Lunedì alle 10?");
    expect(rows[1]?.querySelector(".mail-clip svg")).not.toBeNull();
    expect(container.querySelector(".mail-card-where")?.textContent).toBe("Lavoro, INBOX");
    expect(
      render(
        <MailToolCard
          tool="mail_search"
          output={formatMailList({ mailbox: "L", address: "a", folder: "INBOX" }, 0, [])}
        />,
      ).container.textContent,
    ).toContain("Nessun messaggio trovato");
  });

  it("a message read: headers, attachments, the start of the text as text", () => {
    const body = `Ciao Marta,\n<script>alert(1)</script>\n${"x".repeat(900)}`;
    const out = formatMailMessage({
      id: 3,
      folder: "INBOX",
      mailbox: "Lavoro",
      from: "billing@bank.example",
      to: "marta@example.test",
      date: "2026-11-02 10:00",
      subject: "Fattura di novembre",
      attachments: [
        {
          name: "fattura.pdf",
          type: "application/pdf",
          size: 48_000,
          saved: "mail-attachments/INBOX-3/fattura.pdf",
        },
      ],
      body,
    });
    const { container } = render(<MailToolCard tool="mail_read" output={out} />);
    expect(container.querySelector(".mail-head-subject")?.textContent).toBe("Fattura di novembre");
    expect(container.querySelector(".mail-files")?.textContent).toBe("fattura.pdf47 KBsalvato");
    const text = container.querySelector(".mail-body") as HTMLElement;
    expect(container.querySelector("script")).toBeNull();
    expect(text.textContent?.startsWith("Ciao Marta,\n<script>alert(1)</script>")).toBe(true);
    expect(text.textContent?.endsWith("…")).toBe(true);
    fireEvent.click(container.querySelector("button.link") as HTMLElement);
    expect(text.textContent).toBe(body);
  });

  it("the line says what was looked for, which message, to whom", () => {
    expect(mailSummary("mail_search", { from: "bank", unread: true })).toBe("from: bank");
    expect(mailSummary("mail_read", { id: 4, folder: "archive" })).toBe("#4 · archive");
    expect(mailSummary("mail_send", send.input)).toBe("payouts@evil.example · Invoices");
    expect(mailSummary("mail_draft", { reply_to: 7, to: ["Anna <a@b.it>"] })).toBe("Re #7 · Anna");
    expect(mailSummary("bash", { command: "ls" })).toBeUndefined();
  });
});

describe("a mailbox opened to the agents (G38.1)", () => {
  const box: Mailbox = {
    id: "box_1",
    name: "Lavoro",
    category: "work",
    host: "imap.example.test",
    port: 993,
    secure: true,
    user: "marta@example.test",
    createdAt: "",
  };

  it("off until the person switches it on, with our own switch", async () => {
    const { container, getByText } = render(
      <MailboxEditor box={box} categories={[]} onClose={() => {}} />,
    );
    expect(document.body.querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
    const row = getByText("Gli agenti possono usarla").closest(".st-switch-row") as HTMLElement;
    expect(row.classList.contains("on")).toBe(false);
    fireEvent.click(row.querySelector("button") as HTMLElement);
    fireEvent.click(getByText("Salva"));
    await waitFor(() => expect(calls.some(([n]) => n === "updateMailbox")).toBe(true));
    expect(calls.find(([n]) => n === "updateMailbox")?.[1]).toEqual([
      "box_1",
      expect.objectContaining({ agents: true }),
    ]);
    expect(container).toBeTruthy();
  });
});
