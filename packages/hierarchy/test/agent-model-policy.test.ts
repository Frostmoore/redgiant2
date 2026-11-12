// Changing another agent's model (G38.9, decision «Il modello degli agenti lo sceglie la persona")
// in the permission policy, as a table: always an ordinary request that only the person answers
// (`agent-model`, never a parent agent), whatever the mode and the rules (only a deny rule or plan
// mode win).
import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL,
  ALWAYS_HUMAN,
  DEFAULT_POLICY,
  type Decision,
  evaluate,
  type PolicySettings,
} from "../src/index.js";

const settings = (over: Partial<PolicySettings> = {}): PolicySettings => ({
  ...DEFAULT_POLICY,
  roots: ["/work/app"],
  ...over,
});

const input = { agent_id: "a1", provider: "anthropic", model: "claude-x" };

const TABLE: [
  string,
  "auto" | "manual" | "plan" | "readonly",
  Decision,
  string[],
  Partial<PolicySettings>?,
][] = [
  ["auto mode", "auto", "ask", [AGENT_MODEL]],
  ["manual mode", "manual", "ask", [AGENT_MODEL]],
  [
    "a rule allows every tool",
    "auto",
    "ask",
    [AGENT_MODEL],
    { rules: [{ tool: "*", decision: "allow" }] },
  ],
  [
    "a rule allows it",
    "auto",
    "ask",
    [AGENT_MODEL],
    { rules: [{ tool: "set_agent_model", decision: "allow" }] },
  ],
  [
    "a rule denies it",
    "auto",
    "deny",
    [],
    { rules: [{ tool: "set_agent_model", decision: "deny" }] },
  ],
  ["plan mode", "plan", "deny", []],
  ["read-only mode", "readonly", "deny", []],
];

describe("set_agent_model in the policy (G38.9): the table", () => {
  for (const [label, mode, decision, danger, over] of TABLE)
    it(`${decision}: ${label}`, () => {
      const e = evaluate(mode, { callId: "c", name: "set_agent_model", input }, settings(over));
      expect(e.decision).toBe(decision);
      expect(e.danger).toEqual(danger);
    });

  it("is the person's alone, whatever their human-only list says, and not on the Safety page", () => {
    expect(ALWAYS_HUMAN).toContain(AGENT_MODEL);
    expect(DEFAULT_POLICY.danger.map((d) => d.id)).not.toContain(AGENT_MODEL);
  });

  it("says what the request is about", () => {
    const e = evaluate("auto", { callId: "c", name: "set_agent_model", input }, settings());
    expect(e.reasons).toEqual(["changes another agent's model"]);
  });
});
