import { describe, expect, it } from "vitest";
import {
  type Action,
  type AgentNode,
  approvalChain,
  can,
  canKnowledge,
  type KnowledgeAction,
  type KnowledgeTarget,
} from "../src/index.js";

const n = (
  id: string,
  kind: AgentNode["kind"],
  parentId: string | null,
  projectId: string | null,
  ownerId = "me",
  subprojectId: string | null = null,
  projects: string[] = [],
): AgentNode => ({
  id,
  name: id,
  kind,
  parentId,
  projectId,
  ownerId,
  subprojectId,
  projects,
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
  // Subprojects of p1 (G24.13): s1 and s2.
  n("A4", "agent", "O1", "p1", "me", "s1"),
  n("A5", "agent", "O1", "p1", "me", "s2"),
  n("S4", "subagent", "A4", "p1", "me", "s1"),
  n("I2", "inspector", "G", "p1", "me", "s1"),
  n("P2", "assistant", "G", null),
  // Assigned to other projects (2026-11-03): an assistant to p1, an agent of p2 to p1 too.
  n("P3", "assistant", "G", null, "me", null, ["p1"]),
  n("A6", "agent", "O2", "p2", "me", null, ["p1"]),
  n("X", "god", null, null, "someone-else"),
  // An archived project (2026-11-09): p9, with its orchestrator, an agent, its sub-agent and
  // its inspector; and an agent of p2 assigned to it.
  { ...n("O9", "orchestrator", "G", "p9"), archived: true },
  { ...n("A9", "agent", "O9", "p9"), archived: true },
  { ...n("S9", "subagent", "A9", "p9"), archived: true },
  { ...n("I9", "inspector", "G", "p9"), archived: true },
  n("A7", "agent", "O2", "p2", "me", null, ["p9"]),
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
O1 message  A4 yes | O1 stop     A5 yes | O1 read   S4 yes | I1 read   A4 yes | I1 read A5 yes | A4 message S4 yes
A4 message  A5 no  | A4 read     A5 no  | A5 read   S4 no  | I2 read   A4 yes | I2 read S4 yes | I2 read A5 no | I2 read A1 no
G  join      A1 no  | O1 join     A1 no  | P1 join   P2 no  | I1 join    I1 no  | A1 join A1 no
G  configure P1 yes | G  stop     P1 yes | O1 message P1 no  | O1 read   P1 no  | I1 read P1 no | A1 message P1 no | D message P1 no
O1 read      P3 yes | O1 message  P3 yes | O1 stop    P3 no  | O1 configure P3 no | O1 spawn P3 no | O2 message P3 no | I1 read P3 yes | A1 message P3 no
O1 message   A6 yes | O1 read     A6 yes | O1 stop    A6 no  | O2 message A6 yes | O2 stop A6 yes | I1 read A6 yes | A1 message A6 no
G  tools     A1 no  | G  tools     G  no  | G  tools    P1 no  | O1 tools   A1 no  | O1 tools O1 no | A1 tools S1 no | P1 tools P1 no | I1 tools A1 no | D tools G no
G  read      A9 yes | G  read     O9 yes | G  message  O9 no  | G  message A9 no  | G  spawn O9 no | G  stop A9 no | G  configure O9 no | G approve A9 no
O9 read      A9 yes | O9 message  A9 no  | O9 stop    A9 no  | O9 spawn   O9 no  | O9 message G no | O9 read O9 yes | O9 configure A9 no
A9 read      S9 yes | A9 message  S9 no  | A9 spawn   A9 no  | A9 read    A9 yes | S9 read S9 yes | S9 message A9 no
I9 read      A9 yes | I9 read     S9 yes | I9 message A9 no  | I1 read    A9 no  | O1 read A9 no
O2 message   A7 yes | O2 stop     A7 yes | O9 message A7 no  | O9 read    A7 yes | I9 read A7 yes | P1 message O9 no
G  model     O1 yes | G  model     A1 yes | G  model    P1 yes | G  model   S1 yes | G  model G no | G model X no | G model A9 no
O1 model     A1 yes | O1 model     A4 yes | O1 model   S1 yes | O1 model  O1 no  | O1 model A3 no | O1 model A6 no | O1 model P3 no | O2 model A6 yes
A1 model     S1 no  | A1 model     A1 no  | S1 model   S1 no  | I1 model  A1 no  | D model G no | P1 model P2 no | P1 model P1 no | O9 model A9 no
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

  it("lets the human add their own agents to a group chat, never Demi-God or a sub-agent", () => {
    const me = { type: "human" as const, ownerId: "me" };
    for (const id of ["G", "O1", "A1", "I1", "P1"])
      expect(can(me, "join", byId.get(id) as AgentNode, resolve)).toBe(true);
    for (const id of ["D", "S1", "X"])
      expect(can(me, "join", byId.get(id) as AgentNode, resolve)).toBe(false);
  });

  it("lets only the human choose an agent's tools (G34.5), and only for their own agents", () => {
    const me = { type: "human" as const, ownerId: "me" };
    for (const id of ["G", "D", "O1", "A1", "S1", "I1", "P1"])
      expect(can(me, "tools", byId.get(id) as AgentNode, resolve)).toBe(true);
    expect(can(me, "tools", byId.get("X") as AgentNode, resolve)).toBe(false);
  });

  it("lets the human only read and stop the agents of an archived project", () => {
    const me = { type: "human" as const, ownerId: "me" };
    const want: Record<Action, boolean> = {
      read: true,
      stop: true,
      message: false,
      spawn: false,
      configure: false,
      approve: false,
      join: false,
      tools: false,
      model: false,
    };
    for (const id of ["O9", "A9", "S9", "I9"])
      for (const [action, ok] of Object.entries(want))
        expect(
          can(me, action as Action, byId.get(id) as AgentNode, resolve),
          `${action} ${id}`,
        ).toBe(ok);
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

// The knowledge (3.5.3, «Gli agenti possono creare tutto da sé»): who makes a collection for whom
// ("make": every agent, a project, one agent), and whose files it may read into one ("source": a
// project, God's folder, the assistants' desk). Folders elsewhere on the computer are the guardian's.
// "read" (p3.5.4): whose collections it searches by their scope; God every one of the person's,
// as it acts with their authority (the 3.5.3 test: «No collection you can read is called that»).
const KNOWLEDGE_TABLE = `
G  make   all yes | G  make   p1 yes | G  make   A1 yes | G  make   G  yes | G  make P1 yes
O1 make   p1  yes | O1 make   p2 no  | O1 make   all no | O1 make   O1 yes | O1 make A1 yes | O1 make A3 no | O1 make P1 no
A1 make   p1  yes | A1 make   A1 yes | A1 make   all no | A1 make   A2 no  | A1 make p2 no  | A1 make S1 no
A4 make   p1  yes | A6 make   p1 yes | A6 make   p2 yes | A6 make   p3 no
P1 make   P1  yes | P1 make   all no | P1 make   p1 no  | P1 make   P2 no  | P3 make p1 yes
S1 make   S1  no  | S1 make   p1 no  | D  make   all no | D  make   D  no  | I1 make p1 no  | I1 make I1 no
G  source platform yes | G source assistants yes | G source p1 yes | G source p2 yes
O1 source p1 yes | O1 source p2 no | O1 source platform no | O1 source assistants no
A1 source p1 yes | A1 source p2 no | A6 source p1 yes | A6 source p2 yes | A1 source platform no
P1 source assistants yes | P1 source p1 no | P1 source platform no | P3 source p1 yes
S1 source p1 no | D source platform no | I1 source p1 no
G  make   p9 no  | G  source p9 no | G  make A9 no | A7 make p9 no | A7 source p9 no | O9 make O9 no | O9 make p9 no
G  read   all yes | G  read   p1 yes | G  read   p2 yes | G  read   p9 yes | G  read A1 yes | G  read O1 yes | G read P1 yes | G read X no
O1 read   all yes | O1 read   p1 yes | O1 read   p2 no  | O1 read   O1 yes | O1 read A1 no | O1 read G no
A1 read   all yes | A1 read   p1 yes | A1 read   p2 no  | A1 read   A1 yes | A1 read A2 no | A6 read p1 yes | A6 read p2 yes
S1 read   all yes | S1 read   p1 yes | S1 read   p2 no  | I1 read   p1 yes | I1 read p2 no | D read all yes | D read p1 no
P1 read   all yes | P1 read   P1 yes | P1 read   p1 no  | P3 read   p1 yes | P1 read P2 no
O9 read   p9 yes | A9 read   p9 yes | A7 read   p9 yes | O9 read   all yes
`
  .trim()
  .split(/\s*[|\n]\s*/)
  .map((row) => row.trim().split(/\s+/) as [string, KnowledgeAction, string, "yes" | "no"]);

const knowledgeTarget = (id: string): KnowledgeTarget => {
  if (id === "all") return { kind: "all" };
  if (id === "platform" || id === "assistants") return { kind: id };
  const a = byId.get(id);
  return a
    ? { kind: "agent", agent: a }
    : { kind: "project", projectId: id, ...(id === "p9" && { archived: true }) };
};

describe("knowledge scope table (3.5.3)", () => {
  it.each(KNOWLEDGE_TABLE)("%s %s %s → %s", (actor, action, target, expected) => {
    expect(canKnowledge(agent(actor), action, knowledgeTarget(target))).toBe(expected === "yes");
  });

  it("lets the person make anything", () => {
    const me = { type: "human" as const, ownerId: "me" };
    for (const t of ["all", "p1", "A1", "platform"])
      for (const action of ["make", "source"] as const)
        if (action === "make" ? t !== "platform" : t !== "all" && t !== "A1")
          expect(canKnowledge(me, action, knowledgeTarget(t))).toBe(true);
    // An archived project's collections (2026-11-09): the person still may, from the page (no
    // file of the project changes); no agent does.
    expect(canKnowledge(me, "make", knowledgeTarget("p9"))).toBe(true);
    expect(canKnowledge(me, "source", knowledgeTarget("p9"))).toBe(true);
    // Another owner's agent is never a target.
    expect(canKnowledge(me, "make", knowledgeTarget("X"))).toBe(false);
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
