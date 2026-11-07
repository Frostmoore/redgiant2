import type { AgentKind } from "@redgiant/protocol";

/** What the hierarchy needs to know about an agent. */
export interface AgentNode {
  id: string;
  name: string;
  kind: AgentKind;
  parentId: string | null;
  projectId: string | null;
  ownerId: string;
  /** The subproject it works in (G24.13), inside its project; none for the project's own agents. */
  subprojectId?: string | null | undefined;
  /**
   * Other projects it is assigned to (2026-11-03): it sits under their orchestrators too, who
   * give it tasks there; it stays where it was created.
   */
  projects?: readonly string[] | undefined;
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
  | "approve"
  /**
   * Add the target to a group chat (G24.12). Only the human does it, never for Demi-God (a
   * spokesperson) or a sub-agent (it lives for one task). Joining gives no new access: what
   * the others write reaches it as data.
   */
  | "join"
  /**
   * Choose which tools the target gets (G34.5): switching them off or on. Only the human does it,
   * for their own agents; no agent, not even God, chooses another's tools (nor its own).
   */
  | "tools";

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
 * - Orchestrator: the agents of its own project, and those assigned to it (read and give tasks
 *   only: they are stopped and configured where they were created).
 * - Agent: its own tasks and its sub-agents.
 * - Sub-agent: only its own task; cannot spawn (RD11).
 * - Inspector: reads its project (every subproject), or only its subproject; never acts (RD30).
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
  if (actor.type === "human")
    return (
      actor.ownerId === target.ownerId &&
      (action !== "join" || (target.kind !== "demigod" && target.kind !== "subagent"))
    );
  const a = actor.agent;
  if (action === "join" || action === "tools") return false;
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
      const assigned = a.projectId !== null && (target.projects?.includes(a.projectId) ?? false);
      if (assigned && !inProject) return action === "read" || action === "message";
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
      // The project's inspector reads every subproject; a subproject's inspector only its own.
      if (action !== "read" || a.projectId === null) return false;
      // An agent assigned to the project is read by the project's inspector too.
      if (!a.subprojectId && target.projects?.includes(a.projectId)) return true;
      return (
        target.projectId !== null &&
        target.projectId === a.projectId &&
        (!a.subprojectId || target.subprojectId === a.subprojectId)
      );
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
