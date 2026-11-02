import type { AgentKind } from "@redgiant/protocol";

/** What the hierarchy needs to know about an agent. */
export interface AgentNode {
  id: string;
  name: string;
  kind: AgentKind;
  parentId: string | null;
  projectId: string | null;
  ownerId: string;
}

/** The human owner acts as itself; agents act through their node. */
export type Actor = { type: "human"; ownerId: string } | { type: "agent"; agent: AgentNode };

export type Action =
  /** Read state, transcript and log of the target. */
  | "read"
  /** Send a message / task to the target. */
  | "message"
  /** Create a child under the target (target = the future parent). */
  | "spawn"
  | "stop"
  /** Change mode, rules or budget of the target. */
  | "configure"
  /** Decide on a permission request raised by the target. */
  | "approve";

/** Lookup used to walk up the tree. */
export type Resolve = (id: string) => AgentNode | undefined;

export function ancestors(node: AgentNode, resolve: Resolve): AgentNode[] {
  const out: AgentNode[] = [];
  const seen = new Set<string>([node.id]);
  let cur = node.parentId ? resolve(node.parentId) : undefined;
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? resolve(cur.parentId) : undefined;
  }
  return out;
}

const isAncestor = (maybe: AgentNode, of: AgentNode, resolve: Resolve) =>
  ancestors(of, resolve).some((a) => a.id === maybe.id);

/**
 * The scope table (plan §5.2):
 * - God: platform and every project of its owner.
 * - Demi-God: talks to God only; does nothing else.
 * - Orchestrator: the agents of its own project.
 * - Agent: its own tasks and its sub-agents.
 * - Sub-agent: only its own task; cannot spawn (RD11).
 * - Inspector: reads its project; never acts on anyone (RD30).
 * - Assistant: a personal agent (G24.11); reads and messages the other assistants (hand-offs),
 *   messages God; sees no project and creates nobody.
 * Changing permissions ("configure") is reserved to God and the human; nobody configures
 * God but the human.
 */
export function can(
  actor: Actor,
  action: Action,
  target: AgentNode,
  // Today every rule is decided by direct parentage and project; kept for deeper trees.
  _resolve: Resolve,
): boolean {
  if (actor.type === "human") return actor.ownerId === target.ownerId;
  const a = actor.agent;
  if (a.ownerId !== target.ownerId) return false;
  const self = a.id === target.id;

  switch (a.kind) {
    case "god":
      if (action === "configure" && target.kind === "god") return false;
      if (action === "stop" && self) return false;
      if (action === "spawn") return target.kind !== "subagent" && target.kind !== "inspector";
      return true;
    case "demigod":
      return (action === "message" || action === "read") && target.kind === "god";
    case "orchestrator": {
      if (self) return action === "read" || action === "spawn";
      const inProject = target.projectId !== null && target.projectId === a.projectId;
      if (!inProject || (target.kind !== "agent" && target.kind !== "subagent")) return false;
      if (action === "configure") return false;
      // Children are created by their parent (or by God and the human), never by a grandparent.
      if (action === "spawn") return false;
      return true;
    }
    case "agent": {
      if (self) return action === "read" || action === "spawn";
      const child = target.kind === "subagent" && target.parentId === a.id;
      return child && action !== "configure" && action !== "spawn";
    }
    case "subagent":
      return self && action === "read";
    case "inspector":
      return action === "read" && target.projectId !== null && target.projectId === a.projectId;
    case "assistant":
      if (target.kind === "god") return action === "message";
      if (target.kind !== "assistant") return false;
      return action === "read" || (action === "message" && !self);
  }
}

/** Kinds a parent may create below itself. */
export const CHILD_KINDS: Record<AgentKind, AgentKind[]> = {
  god: ["demigod", "orchestrator", "inspector", "assistant"],
  demigod: [],
  orchestrator: ["agent"],
  agent: ["subagent"],
  subagent: [],
  inspector: [],
  assistant: [],
};

/**
 * Who answers a permission request raised by `requester`, in order: the parents up the tree,
 * then the human (`null`). An Inspector never asks (it cannot act).
 */
export function approvalChain(requester: AgentNode, resolve: Resolve): (AgentNode | null)[] {
  return [...ancestors(requester, resolve).filter((a) => a.kind !== "demigod"), null];
}

export { isAncestor };
