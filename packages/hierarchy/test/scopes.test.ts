import { describe, expect, it } from "vitest";
import { type Action, type AgentNode, approvalChain, can } from "../src/index.js";

const n = (
  id: string,
  kind: AgentNode["kind"],
  parentId: string | null,
  projectId: string | null,
  ownerId = "me",
): AgentNode => ({
  id,
  name: id,
  kind,
  parentId,
  projectId,
  ownerId,
});
const tree = [
  n("G", "god", null, null),
  n("D", "demigod", "G", null),
  n("O1", "orchestrator", "G", "p1"),
  n("O2", "orchestrator", "G", "p2"),
  n("A1", "agent", "O1", "p1"),
  n("A2", "agent", "O1", "p1"),
  n("A3", "agent", "O2", "p2"),
  n("S1", "subagent", "A1", "p1"),
  n("S2", "subagent", "A2", "p1"),
  n("I1", "inspector", "G", "p1"),
  n("P1", "assistant", "G", null),
  n("P2", "assistant", "G", null),
  n("X", "god", null, null, "someone-else"),
];
const byId = new Map(tree.map((a) => [a.id, a]));
const resolve = (id: string) => byId.get(id);
const agent = (id: string) => ({ type: "agent" as const, agent: byId.get(id) as AgentNode });

// actor action target expected — the scope table of plan §5.2, one row per case.
const TABLE = `
G  read      A3 yes | G  message  S1 yes | G  spawn  O1 yes | G  spawn  S1 no  | G  stop  G  no  | G  configure A1 yes | G configure G no | G read X no
D  message   G  yes | D  read     G  yes | D  message O1 no | D  read   A1 no  | D  spawn D  no  | D  stop  A1 no
O1 read      A1 yes | O1 message  S1 yes | O1 stop   A2 yes | O1 spawn  A1 no  | O1 spawn O1 yes | O1 read A3 no | O1 message O2 no | O1 configure A1 no | O1 read G no
A1 read      S1 yes | A1 message  S1 yes | A1 stop   S1 yes | A1 read   S2 no  | A1 message A2 no | A1 spawn A1 yes | A1 stop O1 no | A1 read A1 yes
S1 read      S1 yes | S1 spawn    S1 no  | S1 message A1 no | S1 read   A1 no
I1 read      A1 yes | I1 read     S2 yes | I1 message A1 no | I1 stop   A1 no  | I1 read A3 no | I1 spawn I1 no
P1 read      P1 yes | P1 read     P2 yes | P1 message P2 yes | P1 stop   P2 no  | P1 configure P2 no | P1 spawn P1 no
P1 message   G  yes | P1 read     G  no  | P1 read    A1 no  | P1 message O1 no | P1 read I1 no | P1 stop P1 no
G  configure P1 yes | G  stop     P1 yes | O1 message P1 no  | O1 read   P1 no  | I1 read P1 no | A1 message P1 no | D message P1 no
`
  .trim()
  .split(/\s*[|\n]\s*/)
  .map((row) => row.trim().split(/\s+/) as [string, Action, string, "yes" | "no"]);

describe("scope table", () => {
  it.each(TABLE)("%s %s %s → %s", (actor, action, target, expected) => {
    expect(can(agent(actor), action, byId.get(target) as AgentNode, resolve)).toBe(
      expected === "yes",
    );
  });

  it("lets the human do everything on their own agents only", () => {
    expect(
      can({ type: "human", ownerId: "me" }, "configure", byId.get("G") as AgentNode, resolve),
    ).toBe(true);
    expect(can({ type: "human", ownerId: "me" }, "read", byId.get("X") as AgentNode, resolve)).toBe(
      false,
    );
  });
});

describe("approvalChain", () => {
  it("goes up the parents, skips Demi-God, ends with the human", () => {
    expect(
      approvalChain(byId.get("S1") as AgentNode, resolve).map((a) => a?.id ?? "human"),
    ).toEqual(["A1", "O1", "G", "human"]);
    expect(approvalChain(byId.get("G") as AgentNode, resolve).map((a) => a?.id ?? "human")).toEqual(
      ["human"],
    );
  });
});
