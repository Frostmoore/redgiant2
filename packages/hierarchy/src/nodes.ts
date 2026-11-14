// The rules of nodes (G39.4), pure and tested as a table (`test/nodes.test.ts`: change the table
// first). Two separate things:
//  - the tree: who paired with whom (a machine has at most one parent, no loops). It decides how
//    messages travel and who sees whom (a parent sees its whole subtree, a child its parent);
//  - control: who may command whom. Only a grant the person gave says so, kept by the machine it
//    is about (`target`); being a parent or an ancestor gives none by itself. Pairing proposes the
//    parent's grant (switched on), which the person confirms or switches off: explicit, visible
//    and revocable on that machine. A grant names one machine and does not reach its nodes.
// Every remote action is checked with these rules on the side that asks and again on the machine
// that executes it (that one with its own list of grants).
import type { NodeRight } from "@redgiant/protocol";

/** The tree, by fingerprint: each machine's parent (null: a root). */
export interface NodeGraph {
  parentOf: Readonly<Record<string, string | null>>;
}

/** A grant: `controller` may act on `target` with these rights. */
export interface NodeGrantRule {
  controller: string;
  target: string;
  rights: readonly NodeRight[];
}

/**
 * - `see`: its name, status and capabilities;
 * - `use`: its capabilities (commands in a sandbox there, its models, its storage);
 * - `grant`: give or change who may command it;
 * - `revoke`: take a grant away;
 * - `unpair`: break the pair between two machines.
 */
export type NodeAction = "see" | "use" | "grant" | "revoke" | "unpair";

const known = (g: NodeGraph, id: string) => Object.hasOwn(g.parentOf, id);

/** The ancestors of a machine, nearest first. */
export function ancestorsOf(g: NodeGraph, id: string): string[] {
  const out: string[] = [];
  let at = g.parentOf[id] ?? null;
  while (at && !out.includes(at) && at !== id) {
    out.push(at);
    at = g.parentOf[at] ?? null;
  }
  return out;
}

/** A machine and everything under it (empty when unknown). */
export function subtreeOf(g: NodeGraph, id: string): string[] {
  if (!known(g, id)) return [];
  return Object.keys(g.parentOf).filter((x) => x === id || ancestorsOf(g, x).includes(id));
}

function rightsOf(grants: readonly NodeGrantRule[], actor: string, target: string): Set<NodeRight> {
  const out = new Set<NodeRight>();
  for (const r of grants)
    if (r.controller === actor && r.target === target) for (const x of r.rights) out.add(x);
  // Who manages a machine may also use it.
  if (out.has("admin")) out.add("use");
  return out;
}

/**
 * Whether `actor` may do `action` on `target`. `grant` is the grant a `revoke` is about: its own
 * controller may always give it up.
 */
export function nodeCan(
  g: NodeGraph,
  grants: readonly NodeGrantRule[],
  actor: string,
  target: string,
  action: NodeAction,
  grant?: NodeGrantRule,
): boolean {
  if (!known(g, actor) || !known(g, target)) return false;
  if (actor === target) return true;
  const rights = rightsOf(grants, actor, target);
  switch (action) {
    case "see":
      return (
        ancestorsOf(g, target).includes(actor) || g.parentOf[actor] === target || rights.size > 0
      );
    case "use":
      return rights.has("use");
    case "grant":
      return rights.has("admin");
    case "revoke":
      return rights.has("admin") || (grant !== undefined && grant.controller === actor);
    case "unpair":
      return g.parentOf[actor] === target || g.parentOf[target] === actor;
  }
}

/**
 * The next machine on the way from `self` to `target`: down into the child whose subtree holds
 * it, otherwise up to the parent; null when the target is in no tree `self` belongs to.
 */
export function nodeRoute(g: NodeGraph, self: string, target: string): string | null {
  if (!known(g, self) || !known(g, target)) return null;
  if (self === target) return self;
  const up = ancestorsOf(g, target);
  if (up.includes(self)) {
    // The ancestor of the target just below self.
    const i = up.indexOf(self);
    return i === 0 ? target : (up[i - 1] as string);
  }
  const mine = ancestorsOf(g, self);
  const rootOf = (x: string, a: string[]) => a.at(-1) ?? x;
  if (rootOf(self, mine) !== rootOf(target, up)) return null;
  return g.parentOf[self] ?? null;
}

export type AttachCheck = { ok: true } | { ok: false; reason: "self" | "has-parent" | "cycle" };

/** Whether `child` may become a node of `parent`: one parent each, no loops. */
export function canAttach(g: NodeGraph, parent: string, child: string): AttachCheck {
  if (parent === child) return { ok: false, reason: "self" };
  if (known(g, child) && ancestorsOf(g, parent).includes(child))
    return { ok: false, reason: "cycle" };
  if (g.parentOf[child]) return { ok: false, reason: "has-parent" };
  return { ok: true };
}

/** Where a node runs another machine's commands, and whether its guardian reads them first. */
export type NodeCommandsCheck =
  | { ok: true; where: "container" | "machine"; guardian: boolean }
  | { ok: false; reason: "no-right" | "no-container" };

/**
 * Whether a node runs the commands of a machine with these `rights` on it (p3.7.2). A sandbox is
 * a real container or nothing: reading a command's text cannot confine it (any program reads and
 * writes where it likes). So:
 *  - in a container, «use» runs there with the guardian (writes outside its folder refused), and
 *    who manages the machine runs there without it;
 *  - without one (Windows or macOS without Docker, metal), only who manages the machine runs
 *    commands, on the machine itself; «use» alone is refused (files and storage stay confined to
 *    the asker's folder by real path checks, and models are lent as usual).
 */
export function nodeCommands(
  rights: ReadonlySet<NodeRight>,
  container: boolean,
): NodeCommandsCheck {
  const admin = rights.has("admin");
  if (!admin && !rights.has("use")) return { ok: false, reason: "no-right" };
  if (container) return { ok: true, where: "container", guardian: !admin };
  return admin
    ? { ok: true, where: "machine", guardian: false }
    : { ok: false, reason: "no-container" };
}
