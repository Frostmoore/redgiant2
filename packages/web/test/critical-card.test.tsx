// @vitest-environment jsdom
// p3.5.4: a truly dangerous request (G36.17b) is recognised at a glance, in the chat and in the
// bell: red, a drawn danger icon, a title and what happens in words. One click still decides
// (the person: «va bene rosse, ma non in due step sennò diventa un incubo»).
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const sent: Record<string, unknown>[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getLive: () => ({ send: (m: Record<string, unknown>) => sent.push(m) }),
  getApi: () => new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
}));

const state = await import("../src/state.js");
const { Bell } = await import("../src/components/Bell.js");
const { Chat } = await import("../src/components/Chat.js");
const { agents, approvals, questions, sessionRows, sessionView, sideViews, tabs } = state;

const redaction: PermissionRequestInfo = {
  requestId: "p1",
  agentId: "orch",
  agentName: "Orch",
  projectId: null,
  tool: "canvas_edit",
  input: { path: "modulo.pdf", ops: [{ op: "redact", page: 1, find: "Mario Rossi" }] },
  reasons: [
    "truly dangerous: redacts modulo.pdf: what is under the areas leaves the file for good",
  ],
  danger: ["critical-delete"],
  critical: [{ id: "critical-delete", action: "redact", target: "modulo.pdf" }],
  createdAt: "2026-11-10T10:00:00.000Z",
  sessionId: "sess_a",
};
const ordinary: PermissionRequestInfo = {
  ...redaction,
  requestId: "p2",
  tool: "bash",
  input: { command: "npm install" },
  reasons: ["runs a command"],
  danger: [],
  critical: undefined,
};

beforeEach(() => {
  lang.value = "it";
  sent.length = 0;
  tabs.value = [];
  sideViews.value = [];
  questions.value = [];
  sessionRows.value = [];
  approvals.value = [redaction, ordinary];
  agents.value = [{ id: "orch", name: "Orch", kind: "orchestrator" }] as never;
  sessionView("sess_a").value = {
    events: [],
    text: "",
    thinking: "",
    state: "running",
    synced: true,
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

function checkCards(root: Element) {
  const cards = [...root.querySelectorAll<HTMLElement>(".permission")];
  expect(cards).toHaveLength(2);
  const red = cards.filter((c) => c.classList.contains("permission-critical"));
  expect(red).toHaveLength(1);
  const card = red[0] as HTMLElement;
  // The title, with a drawn icon (an svg, no emoji).
  const head = card.querySelector(".critical-head") as HTMLElement;
  expect(head.getAttribute("role")).toBe("alert");
  expect(head.textContent).toBe("Pericolo: azione che non si può annullare");
  expect(head.querySelector("svg")).toBeTruthy();
  expect(card.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  // What happens, built from the kind and the call's arguments.
  expect(card.querySelector(".critical-what li")?.textContent).toBe(
    "Toglie per sempre il testo e le immagini sotto le aree scelte da modulo.pdf",
  );
  // Two choices: «Consenti» in full red and «Nega»; nothing for this chat or always.
  const buttons = [...card.querySelectorAll<HTMLButtonElement>(".permission-actions button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Consenti", "Nega", "Nega e spiega perché"]);
  expect(buttons[0]?.classList.contains("critical-yes")).toBe(true);
  // The ordinary card stays as it was.
  const plain = cards.find((c) => c !== card) as HTMLElement;
  expect(plain.querySelector(".critical-head")).toBeNull();
  expect(plain.querySelector(".critical-yes")).toBeNull();
  return buttons;
}

describe("the red card of a truly dangerous request (p3.5.4)", () => {
  it("stands out in the chat, and one click allows it", () => {
    const { container } = render(<Chat sessionId="sess_a" agentId="orch" />);
    const [allow] = checkCards(container);
    fireEvent.click(allow as HTMLElement);
    expect(sent.filter((m) => m.type === "permission.resolve")).toEqual([
      {
        type: "permission.resolve",
        requestId: "p1",
        decision: "allow",
        remember: false,
        scope: "once",
      },
    ]);
  });

  it("stands out in the bell too", () => {
    const { container } = render(<Bell close={() => {}} />);
    checkCards(container);
  });

  it("speaks English too, and an older request without details still says its kind", () => {
    lang.value = "en";
    approvals.value = [{ ...redaction, critical: undefined }];
    const { container } = render(<Bell close={() => {}} />);
    expect(container.querySelector(".critical-head")?.textContent).toBe(
      "Danger: an action that cannot be undone",
    );
    expect(container.querySelector(".critical-what li")?.textContent).toMatch(
      /Deletions that skip the recycle bin/,
    );
  });
});
