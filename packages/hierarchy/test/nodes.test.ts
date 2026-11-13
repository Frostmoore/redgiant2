// The rules of nodes (G39.4) as a table: the tree (who paired with whom) and control (who may
// command whom) are separate. Control is only ever a grant the person gave; being a parent or an
// ancestor gives none by itself. The user's home is the example: Severino with Rig, Monnezza and
// Coder as nodes, Rig controlling Severino and all the others.
import { describe, expect, it } from "vitest";
import {
  canAttach,
  type NodeAction,
  type NodeGrantRule,
  type NodeGraph,
  nodeCan,
  nodeRoute,
  subtreeOf,
} from "../src/index.js";

// S = Severino (the principal), R = Rig, M = Monnezza, C = Coder; X is a node of Monnezza; Z is
// a machine of another tree.
const graph: NodeGraph = { parentOf: { S: null, R: "S", M: "S", C: "S", X: "M", Z: null } };

/** What pairing gives by default (the person can switch both off before confirming). */
const pairing: NodeGrantRule[] = [
  { controller: "S", target: "R", rights: ["use", "admin"] },
  { controller: "S", target: "M", rights: ["use", "admin"] },
  { controller: "S", target: "C", rights: ["use"] },
  { controller: "M", target: "X", rights: ["use"] },
];
/** The user's choice: Rig commands Severino and every other machine. */
const rigRules: NodeGrantRule[] = [
  { controller: "R", target: "S", rights: ["use", "admin"] },
  { controller: "R", target: "M", rights: ["use"] },
  { controller: "R", target: "C", rights: ["use"] },
  { controller: "R", target: "X", rights: ["use"] },
];

type Row = [string, NodeGrantRule[], string, string, NodeAction, boolean];
const table: Row[] = [
  // A machine is always its own: its person decides everything there.
  ["itself", [], "R", "R", "use", true],
  ["itself admin", [], "M", "M", "grant", true],
  // Seeing: the principal sees the whole tree; a child sees its parent; no one sees a stranger.
  ["parent sees child", [], "S", "R", "see", true],
  ["root sees grandchild", [], "S", "X", "see", true],
  ["child sees its parent", [], "R", "S", "see", true],
  ["sibling does not see sibling", [], "R", "M", "see", false],
  ["a grant lets one see", rigRules, "R", "M", "see", true],
  ["other tree not seen", pairing, "S", "Z", "see", false],
  // Control is never implicit: a parent without a grant cannot use its child.
  ["parent without grant", [], "S", "R", "use", false],
  ["parent with pairing grant", pairing, "S", "R", "use", true],
  ["grandparent: no grant on grandchild", pairing, "S", "X", "use", false],
  ["child cannot use parent by default", pairing, "R", "S", "use", false],
  ["child cannot use sibling by default", pairing, "R", "M", "use", false],
  // The user's example: Rig, a child of Severino, controls Severino and all the others.
  ["Rig uses Severino", [...pairing, ...rigRules], "R", "S", "use", true],
  ["Rig uses Monnezza", [...pairing, ...rigRules], "R", "M", "use", true],
  ["Rig uses Monnezza's node", [...pairing, ...rigRules], "R", "X", "use", true],
  ["Rig manages Severino", [...pairing, ...rigRules], "R", "S", "grant", true],
  ["Rig does not manage Monnezza", [...pairing, ...rigRules], "R", "M", "grant", false],
  // A grant names one machine: it does not reach that machine's nodes.
  [
    "grant on M does not reach X",
    [{ controller: "R", target: "M", rights: ["use", "admin"] }],
    "R",
    "X",
    "use",
    false,
  ],
  // Admin includes use; use alone does not include admin.
  [
    "admin implies use",
    [{ controller: "C", target: "M", rights: ["admin"] }],
    "C",
    "M",
    "use",
    true,
  ],
  ["use is not admin", pairing, "S", "C", "grant", false],
  ["admin may grant", pairing, "S", "M", "grant", true],
  // Revoking: the machine itself, whoever manages it.
  ["target revokes", pairing, "R", "R", "revoke", true],
  ["admin revokes", pairing, "S", "M", "revoke", true],
  ["use-only cannot revoke", pairing, "S", "C", "revoke", false],
  // Unpairing: either end of a pair, nobody else.
  ["child unpairs from parent", [], "R", "S", "unpair", true],
  ["parent unpairs child", [], "S", "R", "unpair", true],
  ["grandparent cannot unpair grandchild", pairing, "S", "X", "unpair", false],
  ["sibling cannot unpair", rigRules, "R", "M", "unpair", false],
  // Unknown machines: nothing.
  ["unknown actor", pairing, "Q", "S", "use", false],
  ["unknown target", pairing, "S", "Q", "see", false],
];

describe("nodeCan (G39.4)", () => {
  it.each(table)("%s", (_name, grants, actor, target, action, expected) => {
    expect(nodeCan(graph, grants, actor, target, action)).toBe(expected);
  });

  it("a grant one gives up: its own controller may revoke it", () => {
    const g: NodeGrantRule = { controller: "R", target: "C", rights: ["use"] };
    expect(nodeCan(graph, [g], "R", "C", "revoke", g)).toBe(true);
    expect(nodeCan(graph, [g], "M", "C", "revoke", g)).toBe(false);
  });
});

describe("the tree (G39.4)", () => {
  it("routes along the tree: down into the subtree that holds the target, else up", () => {
    expect(nodeRoute(graph, "S", "X")).toBe("M");
    expect(nodeRoute(graph, "M", "X")).toBe("X");
    expect(nodeRoute(graph, "R", "X")).toBe("S");
    expect(nodeRoute(graph, "X", "R")).toBe("M");
    expect(nodeRoute(graph, "R", "R")).toBe("R");
    // No way to another tree.
    expect(nodeRoute(graph, "S", "Z")).toBeNull();
    expect(nodeRoute(graph, "R", "Q")).toBeNull();
  });

  it("the subtree of a machine", () => {
    expect(subtreeOf(graph, "S").sort()).toEqual(["C", "M", "R", "S", "X"]);
    expect(subtreeOf(graph, "M").sort()).toEqual(["M", "X"]);
    expect(subtreeOf(graph, "Q")).toEqual([]);
  });

  type AttachRow = [string, string, string, ReturnType<typeof canAttach>];
  const attach: AttachRow[] = [
    ["a new machine under the principal", "S", "N", { ok: true }],
    ["a node under a node", "X", "N", { ok: true }],
    ["itself", "S", "S", { ok: false, reason: "self" }],
    // A machine already in a tree has its parent: unpair it first.
    ["already has a parent", "M", "R", { ok: false, reason: "has-parent" }],
    // No loops: an ancestor cannot become a node of its own descendant.
    ["an ancestor under its descendant", "X", "S", { ok: false, reason: "cycle" }],
    ["a root of another tree", "S", "Z", { ok: true }],
  ];
  it.each(attach)("attach: %s", (_n, parent, child, expected) => {
    expect(canAttach(graph, parent, child)).toEqual(expected);
  });
});
