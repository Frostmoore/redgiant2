// Email for the agents (G38.1) in the permission policy, as a table. Sending is a message: an
// ordinary request that only the person answers (`outgoing-mail`, never a parent agent), whatever
// the mode and the rules (only a deny rule or plan mode win). Searching and reading change nothing;
// saving attachments writes into the agent's workspace; moving and flagging are ordinary work.
import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN,
  DEFAULT_POLICY,
  type Decision,
  evaluate,
  OUTGOING_MAIL,
  type PolicySettings,
} from "../src/index.js";

const settings = (over: Partial<PolicySettings> = {}): PolicySettings => ({
  ...DEFAULT_POLICY,
  roots: ["/work/app"],
  home: "/home/ann",
  ...over,
});

type Row = [
  label: string,
  mode: "auto" | "manual" | "plan" | "readonly",
  tool: string,
  input: unknown,
  decision: Decision,
  danger: string[],
  over?: Partial<PolicySettings>,
];

const TABLE: Row[] = [
  [
    "sending, auto mode",
    "auto",
    "mail_send",
    { to: ["a@b.c"], body: "hi" },
    "ask",
    [OUTGOING_MAIL],
  ],
  ["sending a draft", "auto", "mail_send", { draft_id: 3 }, "ask", [OUTGOING_MAIL]],
  [
    "sending, a rule allows every tool",
    "auto",
    "mail_send",
    { to: ["a@b.c"], body: "hi" },
    "ask",
    [OUTGOING_MAIL],
    { rules: [{ tool: "*", decision: "allow" }] },
  ],
  [
    "sending, a rule allows mail_send",
    "auto",
    "mail_send",
    { to: ["a@b.c"], body: "hi" },
    "ask",
    [OUTGOING_MAIL],
    { rules: [{ tool: "mail_send", decision: "allow" }] },
  ],
  [
    "sending, a rule denies it",
    "auto",
    "mail_send",
    { to: ["a@b.c"], body: "hi" },
    "deny",
    [],
    { rules: [{ tool: "mail_send", decision: "deny" }] },
  ],
  ["sending in plan mode", "plan", "mail_send", { to: ["a@b.c"], body: "hi" }, "deny", []],
  ["sending in manual mode", "manual", "mail_send", { to: ["a@b.c"] }, "ask", [OUTGOING_MAIL]],
  ["searching", "auto", "mail_search", { query: "invoice" }, "allow", []],
  ["searching in plan mode", "plan", "mail_search", { from: "bank" }, "allow", []],
  ["reading", "readonly", "mail_read", { id: 4 }, "allow", []],
  [
    "reading and saving the attachments in plan mode",
    "plan",
    "mail_read",
    { id: 4, save_attachments: true },
    "deny",
    [],
  ],
  [
    "reading and saving the attachments",
    "auto",
    "mail_read",
    { id: 4, save_attachments: true },
    "allow",
    [],
  ],
  ["a draft", "auto", "mail_draft", { to: ["a@b.c"], body: "hi" }, "allow", []],
  ["a draft in manual mode", "manual", "mail_draft", { to: ["a@b.c"] }, "ask", []],
  ["archiving", "auto", "mail_move", { ids: [4], action: "archive" }, "allow", []],
  ["marking as read", "auto", "mail_move", { ids: [4], action: "read" }, "allow", []],
];

describe("email in the policy (G38.1): the table", () => {
  for (const [label, mode, tool, input, decision, danger, over] of TABLE)
    it(`${decision}: ${label}`, () => {
      const e = evaluate(mode, { callId: "c", name: tool, input }, settings(over));
      expect(e.decision).toBe(decision);
      expect(e.danger).toEqual(danger);
    });

  it("sending is the person's alone, whatever their human-only list says", () => {
    expect(ALWAYS_HUMAN).toContain(OUTGOING_MAIL);
    // Not on the Safety page's list: nobody switches it.
    expect(DEFAULT_POLICY.danger.map((d) => d.id)).not.toContain(OUTGOING_MAIL);
  });

  it("a keychain value in an email is truly dangerous: asked of the person, in red", () => {
    const e = evaluate(
      "auto",
      {
        callId: "c",
        name: "mail_send",
        input: { draft_id: 1, message: { to: ["a@b.c"], body: "the key: correct-horse-battery" } },
      },
      settings({ critical: { knownSecrets: () => ["correct-horse-battery"] } }),
    );
    expect(e.decision).toBe("ask");
    expect(e.critical).toEqual(["critical-secret"]);
    expect(e.danger).toEqual([OUTGOING_MAIL, "critical-secret"]);
  });

  it("the person reads what the request is about", () => {
    const e = evaluate("auto", { callId: "c", name: "mail_send", input: {} }, settings());
    expect(e.reasons).toEqual(["sends an email"]);
  });
});
