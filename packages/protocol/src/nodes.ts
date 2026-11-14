// Nodes (G39.4): other RedGiant installations paired with this one. Pairing uses a one-time code
// the principal shows; the two machines exchange long-term ed25519 keys and pin each other's
// fingerprint, which the person compares on both sides (with a six-digit number both show) and
// confirms. Afterwards every link is a mutually authenticated, encrypted channel over a WebSocket
// (see `packages/server/src/nodes/channel.ts`). The machines form a tree; who may command whom is
// a separate grant the person gives, kept by the machine it is about. No secret ever crosses:
// a node's keys, its keychain and its providers' keys stay there.
import { z } from "zod";

/** `use`: its capabilities (sandbox commands, models, storage); `admin`: also who may command it. */
export const NodeRight = z.enum(["use", "admin"]);
export type NodeRight = z.infer<typeof NodeRight>;

/** A grant, kept by the machine it is about. Machines are named by fingerprint. */
export interface NodeGrant {
  id: string;
  controller: string;
  controllerName: string;
  target: string;
  targetName: string;
  rights: NodeRight[];
  grantedAt: string;
  /** Where the person gave it: on this machine, or from a machine that manages it. */
  grantedFrom: string;
}

/** The one-time code shown by the principal: short, uppercase, ten minutes. */
export const PAIR_CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_TRIES = 5;

export interface PairCode {
  code: string;
  expiresAt: string;
}

/** What the person types on the node: the principal's address and its code. */
export const PairBody = z.object({
  address: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .regex(/^(https?|wss?):\/\/[^\s]+$|^[^\s/:]+(:\d+)?$/),
  code: z.string().trim().toUpperCase().regex(PAIR_CODE),
  /** The name this machine shows to the other (default: its host name). */
  name: z.string().trim().min(1).max(40).optional(),
});
export type PairBody = z.infer<typeof PairBody>;

/** The person's yes on one side, with the rights the other side gets on this machine. */
export const PairConfirmBody = z.object({
  /** The fingerprint the person compared (a different one now is refused). */
  fingerprint: z.string().min(10).max(100),
  /** On the node: what the principal may do here (default: use and manage). */
  rights: z.array(NodeRight).max(2).optional(),
  /** The name the person gives the other machine here (default: the one it reports). */
  name: z.string().trim().max(40).optional(),
});

/** The person names a paired machine, here only (empty: the name it reports). */
export const NodeLabelBody = z.object({
  fingerprint: z.string().min(10).max(100),
  name: z.string().trim().max(40),
});

export const GrantBody = z.object({
  controller: z.string().min(10).max(100),
  target: z.string().min(10).max(100),
  rights: z.array(NodeRight).min(1).max(2),
});

export const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** What a node offers, measured there (G39.3 discovery), never guessed. */
export interface NodeCapabilities {
  /**
   * `container`: commands run in a real container there; without one only a machine that manages
   * it runs commands, on the machine itself (p3.7.2).
   */
  sandbox: { ok: boolean; kind?: string; container?: boolean; cpus?: number; memoryMb?: number };
  /** Its model providers (their keys stay there): id and the models one can pick. */
  models: { provider: string; models: string[] }[];
  storage: { ok: boolean; freeBytes?: number; totalBytes?: number };
  /** How busy it is now. */
  load?: { cpu?: number; memoryUsedPct?: number };
  system?: string;
}

export type NodeStatus = "online" | "offline" | "pending" | "connecting" | "refused";

/** One machine of the tree as the page shows it. */
export interface NodeView {
  fingerprint: string;
  name: string;
  /** How it is linked to this machine: its parent, a child, or further in the tree. */
  relation: "self" | "parent" | "child" | "tree";
  status: NodeStatus;
  /** Why it is not online, in English for the log (the page has its own words for the codes). */
  reason?: string;
  lastSeen?: string;
  pairedAt?: string;
  /** The address the node dials (for the parent link). */
  address?: string;
  capabilities?: NodeCapabilities;
  /** Who may command it (its own list, as it reported it). */
  grants: NodeGrant[];
  children: NodeView[];
}

/** A pair waiting for the person's yes on this side. */
export interface PendingPair {
  fingerprint: string;
  name: string;
  /** Six digits both machines show for the same pair. */
  sas: string;
  /** This side is the principal (a node asked) or the node (it asked). */
  side: "principal" | "node";
  at: string;
}

/** Where the person pinned things for a project or an agent (default: here). */
export interface NodePlacement {
  /** `project:<id>` or `agent:<id>`. */
  scope: string;
  /** The node (fingerprint) commands run on. */
  commands?: string;
  /** The node backups are copied to. */
  backups?: string;
}

export const PlacementBody = z.object({
  scope: z.string().regex(/^(project|agent):[A-Za-z0-9_-]{1,80}$/),
  commands: z.string().min(10).max(100).nullable().optional(),
  backups: z.string().min(10).max(100).nullable().optional(),
});

export interface NodesState {
  self: { fingerprint?: string; name: string; ready: boolean; reason?: string };
  tree: NodeView;
  /** The parent link, from this machine's point of view. */
  parent?: NodeView;
  pending: PendingPair[];
  /** Who may command this machine (its own list). */
  grants: NodeGrant[];
  placements: NodePlacement[];
  /** A code being shown (only on the page that asked for it). */
  code?: PairCode;
}

/** Short and readable: `SHA256:abcd…` keeps its first groups for the page. */
export function shortFingerprint(fp: string): string {
  const body = fp.replace(/^SHA256:/, "");
  return `SHA256:${body.slice(0, 16)}`;
}
