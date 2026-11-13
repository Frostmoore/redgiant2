// Nodes (G39.4): this RedGiant paired with others. What is kept where:
//  - the machine's identity (an ed25519 private key) in the keychain (`node:identity`, G36.20),
//    held in memory while the server runs, never in a file in clear, an event or an answer;
//  - the pairs (the parent, the children: name, public key, fingerprint, address), the grants on
//    this machine and the person's placements in rg_settings ("nodes"): nothing secret.
//
// Links: a node dials its parent (it works behind a NAT, through Tailscale or a proxy) and keeps
// the link up, reconnecting with growing pauses. Over the links travel envelopes signed by the
// machine that wrote them (end to end: a machine in between relays and cannot forge or change
// them), with a fresh id and a time (a replayed one is dropped). Every request is checked against
// the control grants by the machine that executes it (`nodeCan`), whatever the asking side did,
// and logged on both sides (`node.action`).
//
// A node that goes away: what was asked waits for it to come back (`waitMs`), then fails saying so;
// a request already sent is asked again after a reconnect with the same operation id, which the
// executing node never runs twice (it answers with the result it kept). Nothing is half-applied.
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { EventStore, SqlClient } from "@redgiant/events";
import {
  type AttachCheck,
  canAttach,
  type NodeAction,
  type NodeGraph,
  nodeCan,
  nodeRoute,
} from "@redgiant/hierarchy";
import {
  type NodeCapabilities,
  type NodeGrant,
  type NodePlacement,
  type NodeRight,
  type NodesState,
  type NodeStatus,
  type NodeView,
  PAIR_CODE_TRIES,
  PAIR_CODE_TTL_MS,
  type PairCode,
  type PendingPair,
} from "@redgiant/protocol";
import type WebSocket from "ws";
import type { Vault } from "../vault.js";
import {
  acceptNode,
  channelUrl,
  codeKey,
  codeProof,
  dialNode,
  fingerprintOf,
  identityFromPem,
  NodeChannelError,
  type NodeIdentity,
  newIdentity,
  type SecureLink,
  signWith,
  verifyWith,
} from "./channel.js";

const SETTING = "nodes";
const IDENTITY_KEY = "node:identity";
/** The code alphabet: no 0/O, 1/I. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CLOCK_SKEW_MS = 5 * 60_000;
const RESULTS_KEPT_MS = 10 * 60_000;

interface Peer {
  fingerprint: string;
  /** The public key (base64 of the 32 bytes). */
  key: string;
  name: string;
  pairedAt: string;
  sas: string;
  /** The person said yes on this side. */
  confirmed: boolean;
}

interface Stored {
  name?: string;
  parent?: Peer & { address: string };
  children: Peer[];
  grants: NodeGrant[];
  placements: NodePlacement[];
}

const empty = (): Stored => ({ children: [], grants: [], placements: [] });

export class NodeError extends Error {
  constructor(
    readonly code:
      | "vault"
      | "not-found"
      | "invalid"
      | "offline"
      | "forbidden"
      | "refused"
      | "lost"
      | "timeout"
      | ChannelCode,
    message: string,
  ) {
    super(message);
  }
}
type ChannelCode = NodeChannelError["code"];

/** What a request asks of another machine. */
export type NodeOp =
  | "status"
  | "exec"
  | "fs"
  | "models"
  | "complete"
  | "storage"
  | "grant.set"
  | "grant.revoke"
  | "unpair";

/** The rule each operation is checked with on the machine that executes it. */
const OP_ACTION: Record<NodeOp, NodeAction> = {
  status: "see",
  exec: "use",
  fs: "use",
  models: "use",
  complete: "use",
  storage: "use",
  "grant.set": "grant",
  "grant.revoke": "revoke",
  unpair: "unpair",
};

interface Envelope {
  t: "env";
  id: string;
  from: string;
  fromKey: string;
  to: string;
  ts: number;
  kind: "req" | "res" | "chunk";
  re?: string;
  op?: NodeOp;
  body: unknown;
  sig: string;
}

const signed = (e: Omit<Envelope, "sig" | "t">) =>
  Buffer.from(
    JSON.stringify([
      e.id,
      e.from,
      e.fromKey,
      e.to,
      e.ts,
      e.kind,
      e.re ?? null,
      e.op ?? null,
      e.body,
    ]),
    "utf8",
  );

/** Who asks, on the machine that executes: the requester and what it may do here. */
export interface NodeCaller {
  ownerId: string;
  from: string;
  fromName: string;
  rights: Set<NodeRight>;
  /** The operation's own id (the same when asked again after a reconnect). */
  opId: string;
  signal: AbortSignal;
  /** Sends a piece of a long answer (a model's stream). */
  chunk(body: unknown): void;
}

/** What this machine does for others (implemented by the server). */
export interface NodeHandlers {
  capabilities(ownerId: string): Promise<NodeCapabilities>;
  exec?(c: NodeCaller, body: unknown): Promise<unknown>;
  fs?(c: NodeCaller, body: unknown): Promise<unknown>;
  models?(c: NodeCaller): Promise<unknown>;
  complete?(c: NodeCaller, body: unknown): Promise<unknown>;
  storage?(c: NodeCaller, body: unknown): Promise<unknown>;
}

export interface NodesOptions {
  db: SqlClient;
  vault: () => Vault | undefined;
  store: EventStore;
  handlers: NodeHandlers;
  now?: () => Date;
  /** This machine's default name (its host name). */
  hostName?: string;
  /** Pauses between reconnections (ms), the last one repeated. */
  reconnectMs?: readonly number[];
  /** How long a request waits for an offline node to come back (default 20 s). */
  waitMs?: number;
  /** How often the children are asked how they are (default 15 s; 0: never by itself). */
  pollMs?: number;
  /** Tests: how a node's address is reached. */
  dial?: (address: string) => string;
}

interface LiveLink {
  link: SecureLink;
  ownerId: string;
  relation: "parent" | "child";
  since: string;
}

interface Pending {
  ownerId: string;
  env: Envelope;
  done: (body: unknown) => void;
  fail: (e: Error) => void;
  onChunk?: ((b: unknown) => void) | undefined;
  /** Resend after a reconnect (same operation id). */
  again: () => void;
  to: string;
}

interface Status {
  status: NodeStatus;
  reason?: string;
  lastSeen?: string;
  capabilities?: NodeCapabilities;
  grants?: NodeGrant[];
  children?: NodeView[];
}

/** The nodes of every person of this server. */
export class Nodes {
  private readonly cache = new Map<string, Stored>();
  private readonly identities = new Map<string, NodeIdentity>();
  private readonly links = new Map<string, LiveLink>();
  private readonly codes = new Map<
    string,
    { ownerId: string; code: string; expires: number; tries: number }
  >();
  private readonly seen = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly status = new Map<string, Status>();
  private readonly parentStatus = new Map<string, { status: NodeStatus; reason?: string }>();
  private readonly results = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly dialers = new Map<string, { stop: () => void }>();
  private readonly linkWaiters = new Set<() => void>();
  private readonly changes = new Set<(ownerId: string) => void>();
  private pollTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly o: NodesOptions) {}

  private now() {
    return (this.o.now ?? (() => new Date()))();
  }

  /** Told when something on the page changes (a node online, a pair asking for the yes). */
  onChange(l: (ownerId: string) => void): () => void {
    this.changes.add(l);
    return () => this.changes.delete(l);
  }

  private changed(ownerId: string) {
    for (const l of this.changes) l(ownerId);
  }

  // ------------------------------------------------------------------ what is kept

  private async load(ownerId: string): Promise<Stored> {
    const hit = this.cache.get(ownerId);
    if (hit) return hit;
    const [row] = await this.o.db.query<{ value: unknown }>(
      "SELECT value FROM rg_settings WHERE owner_id = $1 AND key = $2",
      [ownerId, SETTING],
    );
    const v = row ? (typeof row.value === "string" ? JSON.parse(row.value) : row.value) : undefined;
    const s: Stored = { ...empty(), ...(v && typeof v === "object" ? (v as Stored) : {}) };
    this.cache.set(ownerId, s);
    return s;
  }

  private async save(ownerId: string, s: Stored): Promise<void> {
    await this.o.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, SETTING, JSON.stringify(s)],
    );
    this.cache.set(ownerId, s);
    this.changed(ownerId);
  }

  /** The owners with nodes, from what is kept (at start). */
  private async owners(): Promise<string[]> {
    const rows = await this.o.db.query<{ owner_id: string }>(
      "SELECT owner_id FROM rg_settings WHERE key = $1",
      [SETTING],
    );
    return rows.map((r) => r.owner_id);
  }

  /** This machine's identity: made once, kept in the keychain. Throws when it is closed. */
  async identity(ownerId: string): Promise<NodeIdentity> {
    const hit = this.identities.get(ownerId);
    if (hit) return hit;
    const vault = this.o.vault();
    if (!vault?.ready)
      throw new NodeError(
        "vault",
        "The keychain is closed: this machine's node key lives only there. Open it in Settings > Keychain first.",
      );
    const pem = vault.systemValue(ownerId, IDENTITY_KEY);
    let id: NodeIdentity;
    if (pem) id = identityFromPem(pem);
    else {
      const made = newIdentity();
      await vault.setSystem(ownerId, IDENTITY_KEY, made.pem, {
        name: "redgiant-node-key",
        service: "RedGiant nodes",
        category: "server",
        hosts: [],
        section: "nodes",
        kind: "other",
        what: "this machine's node key (ed25519): proves to the paired machines that it is this one",
      });
      id = made.identity;
    }
    this.identities.set(ownerId, id);
    return id;
  }

  private async name(ownerId: string): Promise<string> {
    return (await this.load(ownerId)).name ?? (this.o.hostName ?? hostname()).slice(0, 40);
  }

  async setName(ownerId: string, name: string): Promise<void> {
    const s = await this.load(ownerId);
    const { name: _old, ...rest } = s;
    const clean = name.trim().slice(0, 40);
    await this.save(ownerId, clean ? { ...rest, name: clean } : rest);
  }

  // ------------------------------------------------------------------ the tree and the rules

  /** The tree as this machine knows it: its parent, its children and what they reported. */
  private graph(self: string, s: Stored, extra: string[] = []): NodeGraph {
    const parentOf: Record<string, string | null> = { [self]: s.parent?.fingerprint ?? null };
    if (s.parent) parentOf[s.parent.fingerprint] = null;
    const walk = (v: NodeView, parent: string) => {
      parentOf[v.fingerprint] = parent;
      for (const c of v.children) walk(c, v.fingerprint);
    };
    for (const c of s.children) {
      parentOf[c.fingerprint] = self;
      for (const g of this.status.get(c.fingerprint)?.children ?? []) walk(g, c.fingerprint);
    }
    // A machine not known here is elsewhere in the tree: the way to it goes up.
    for (const x of extra)
      if (!Object.hasOwn(parentOf, x)) parentOf[x] = s.parent?.fingerprint ?? null;
    return { parentOf };
  }

  /** What the asker may do here, by this machine's own grants. */
  private rightsHere(s: Stored, self: string, from: string): Set<NodeRight> {
    const out = new Set<NodeRight>();
    for (const g of s.grants)
      if (g.target === self && g.controller === from) for (const r of g.rights) out.add(r);
    if (out.has("admin")) out.add("use");
    return out;
  }

  // ------------------------------------------------------------------ pairing

  /** A one-time code for a new node (ten minutes, one use, a few wrong tries). */
  async newCode(ownerId: string): Promise<PairCode> {
    await this.identity(ownerId);
    for (const [k, c] of this.codes)
      if (c.ownerId === ownerId || c.expires < Date.now()) this.codes.delete(k);
    const pick = randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i++) code += ALPHABET[(pick[i] as number) % ALPHABET.length];
    code = `${code.slice(0, 4)}-${code.slice(4)}`;
    const expires = Date.now() + PAIR_CODE_TTL_MS;
    this.codes.set(code, { ownerId, code, expires, tries: 0 });
    return { code, expiresAt: new Date(expires).toISOString() };
  }

  cancelCode(ownerId: string): void {
    for (const [k, c] of this.codes) if (c.ownerId === ownerId) this.codes.delete(k);
  }

  /** Tests: a code's time running out. */
  expireCodes(): void {
    for (const c of this.codes.values()) c.expires = 0;
  }

  private async log(
    ownerId: string,
    p: {
      peer: string;
      peerName: string;
      side: "asked" | "served";
      kind: string;
      what: string;
      status: "done" | "failed" | "refused";
      durationMs?: number;
    },
    where: { projectId?: string | null; agentId?: string | null; sessionId?: string | null } = {},
  ) {
    await this.o.store
      .append({
        ownerId,
        ...where,
        body: {
          type: "node.action",
          payload: { ...p, what: p.what.slice(0, 2000) },
        },
      })
      .catch(() => {});
  }

  /**
   * On the node: pairs with the principal at `address` with its code. Both keys are exchanged;
   * nothing is pinned until the person confirms the fingerprint (and the six digits) here.
   */
  async pair(ownerId: string, address: string, code: string, name?: string): Promise<PendingPair> {
    const id = await this.identity(ownerId);
    const s = await this.load(ownerId);
    if (s.parent?.confirmed)
      throw new NodeError(
        "invalid",
        `This machine is already a node of "${s.parent.name}": unpair it first`,
      );
    if (name) s.name = name;
    const url = this.o.dial?.(address) ?? channelUrl(address);
    let d: Awaited<ReturnType<typeof dialNode>>;
    try {
      d = await dialNode({ url, identity: id, mode: "pair", code });
    } catch (err) {
      const e = err as NodeChannelError;
      await this.log(ownerId, {
        peer: e.seen ?? address,
        peerName: address,
        side: "asked",
        kind: "pair",
        what: e.message,
        status: "refused",
      });
      throw new NodeError(e.code ?? "unreachable", e.message);
    }
    const peerName = await this.helloOver(d.link, await this.name(ownerId));
    d.link.close(1000, "paired");
    if (s.children.some((c) => c.fingerprint === d.peer.fingerprint))
      throw new NodeError("invalid", "That machine is a node of this one: a loop is not possible");
    const at = this.now().toISOString();
    const next: Stored = {
      ...s,
      parent: {
        fingerprint: d.peer.fingerprint,
        key: d.peer.raw.toString("base64"),
        name: peerName,
        address,
        pairedAt: at,
        sas: d.sas,
        confirmed: false,
      },
    };
    await this.save(ownerId, next);
    await this.log(ownerId, {
      peer: d.peer.fingerprint,
      peerName,
      side: "asked",
      kind: "pair",
      what: `paired with ${peerName} at ${address}: waiting for the person's yes`,
      status: "done",
    });
    return { fingerprint: d.peer.fingerprint, name: peerName, sas: d.sas, side: "node", at };
  }

  /** The names, both ways, inside the new encrypted link. */
  private helloOver(link: SecureLink, mine: string): Promise<string> {
    return new Promise((ok, no) => {
      const timer = setTimeout(
        () => no(new NodeError("timeout", "No answer while pairing")),
        10_000,
      );
      link.onMessage((m) => {
        const x = m as { t?: string; name?: unknown };
        if (x.t !== "pair-hello") return;
        clearTimeout(timer);
        ok(typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 40) : "RedGiant");
      });
      link.send({ t: "pair-hello", name: mine });
    });
  }

  /** The person's yes on this side, after comparing the fingerprint (and the six digits). */
  async confirm(
    ownerId: string,
    fingerprint: string,
    rights: NodeRight[] = ["use", "admin"],
  ): Promise<void> {
    const s = await this.load(ownerId);
    const self = (await this.identity(ownerId)).fingerprint;
    const at = this.now().toISOString();
    if (s.parent && s.parent.fingerprint === fingerprint && !s.parent.confirmed) {
      const grants = s.grants.filter((g) => g.controller !== fingerprint);
      if (rights.length)
        grants.push({
          id: `grant_${randomUUID().slice(0, 8)}`,
          controller: fingerprint,
          controllerName: s.parent.name,
          target: self,
          targetName: await this.name(ownerId),
          rights: [...new Set(rights)],
          grantedAt: at,
          grantedFrom: self,
        });
      await this.save(ownerId, { ...s, parent: { ...s.parent, confirmed: true }, grants });
      await this.log(ownerId, {
        peer: fingerprint,
        peerName: s.parent.name,
        side: "asked",
        kind: "pair",
        what: `the person confirmed ${s.parent.name}; it may: ${rights.join(", ") || "nothing"}`,
        status: "done",
      });
      this.startDialer(ownerId);
      return;
    }
    const child = s.children.find((c) => c.fingerprint === fingerprint && !c.confirmed);
    if (!child) throw new NodeError("not-found", "There is no pair waiting with this fingerprint");
    await this.save(ownerId, {
      ...s,
      children: s.children.map((c) => (c === child ? { ...c, confirmed: true } : c)),
    });
    await this.log(ownerId, {
      peer: fingerprint,
      peerName: child.name,
      side: "served",
      kind: "pair",
      what: `the person confirmed the node ${child.name}`,
      status: "done",
    });
  }

  /** The person's no: the pair waiting goes. */
  async reject(ownerId: string, fingerprint: string): Promise<void> {
    const s = await this.load(ownerId);
    if (s.parent?.fingerprint === fingerprint && !s.parent.confirmed) {
      const { parent: _p, ...rest } = s;
      return this.save(ownerId, { ...rest, children: s.children });
    }
    await this.save(ownerId, {
      ...s,
      children: s.children.filter((c) => c.confirmed || c.fingerprint !== fingerprint),
    });
  }

  /** The listener's side of a pair: a code being shown, then a pair waiting for the yes. */
  private async pairProof(th: Buffer, proof: Buffer) {
    const live = [...this.codes.values()].filter((c) => c.expires > Date.now());
    if (!live.length) return { ok: false as const, code: "expired-code" as const };
    for (const c of live) {
      const key = await codeKey(c.code, th);
      const want = codeProof(key, "dialler", th);
      if (want.length === proof.length && want.equals(proof)) {
        // One use.
        this.codes.delete(c.code);
        return { ok: true as const, key, ownerId: c.ownerId };
      }
    }
    for (const c of live) {
      c.tries += 1;
      if (c.tries >= PAIR_CODE_TRIES) this.codes.delete(c.code);
    }
    return {
      ok: false as const,
      code: live.some((c) => c.tries >= PAIR_CODE_TRIES)
        ? ("too-many-tries" as const)
        : ("wrong-code" as const),
    };
  }

  // ------------------------------------------------------------------ links

  /** A socket that opened on `/nodes`: a node linking or pairing. */
  async accept(ws: WebSocket): Promise<void> {
    let owner: string | undefined;
    const owners = await this.owners();
    for (const c of this.codes.values()) if (!owners.includes(c.ownerId)) owners.push(c.ownerId);
    // Whose machine this is: the owner the peer is pinned for (link) or whose code it knows (pair).
    const pinnedBy = (fp: string) =>
      owners.find((ow) => {
        const s = this.cache.get(ow);
        return s?.children.some((c) => c.fingerprint === fp && c.confirmed) ?? false;
      });
    for (const ow of owners) await this.load(ow);
    // The identity answering: the first owner's, until the hello says more (one owner per
    // machine is the normal case; with more, the pinned one).
    const ids = await Promise.all(owners.map((ow) => this.identity(ow).catch(() => undefined)));
    const id = ids.find(Boolean);
    if (!id) {
      ws.close(4005, "Nodes are not ready here (keychain closed)");
      return;
    }
    let ownerOfCode: string | undefined;
    let acc: Awaited<ReturnType<typeof acceptNode>>;
    try {
      acc = await acceptNode(ws, {
        identity: id,
        known: (fp) => {
          owner = pinnedBy(fp);
          return owner !== undefined;
        },
        pairProof: async (th, proof) => {
          const r = await this.pairProof(th, proof);
          if (r.ok) ownerOfCode = r.ownerId;
          return r;
        },
      });
    } catch {
      return;
    }
    if (acc.mode === "pair") {
      const ownerId = ownerOfCode as string;
      const s = await this.load(ownerId);
      const self = (await this.identity(ownerId)).fingerprint;
      const peerName = await this.helloOver(acc.link, await this.name(ownerId)).catch(
        () => "RedGiant",
      );
      const check: AttachCheck = canAttach(this.graph(self, s), self, acc.peer.fingerprint);
      if (!check.ok || s.parent?.fingerprint === acc.peer.fingerprint) {
        acc.link.close(4006, "That machine cannot be a node here (a loop)");
        return;
      }
      acc.link.close(1000, "paired");
      const peer: Peer = {
        fingerprint: acc.peer.fingerprint,
        key: acc.peer.raw.toString("base64"),
        name: peerName,
        pairedAt: this.now().toISOString(),
        sas: acc.sas,
        confirmed: false,
      };
      await this.save(ownerId, {
        ...s,
        children: [...s.children.filter((c) => c.fingerprint !== peer.fingerprint), peer],
      });
      await this.log(ownerId, {
        peer: peer.fingerprint,
        peerName,
        side: "served",
        kind: "pair",
        what: `the node ${peerName} paired with the code: waiting for the person's yes`,
        status: "done",
      });
      return;
    }
    this.register(owner as string, acc.link, "child");
  }

  private register(ownerId: string, link: SecureLink, relation: "parent" | "child") {
    const fp = link.peer.fingerprint;
    this.links.get(fp)?.link.close(1000, "replaced");
    this.links.set(fp, { link, ownerId, relation, since: this.now().toISOString() });
    this.status.set(fp, {
      ...this.status.get(fp),
      status: "online",
      lastSeen: this.now().toISOString(),
    });
    if (relation === "parent") this.parentStatus.set(ownerId, { status: "online" });
    link.onMessage((m) => void this.receive(ownerId, link, m));
    link.onClose(() => {
      if (this.links.get(fp)?.link !== link) return;
      this.links.delete(fp);
      const st = this.status.get(fp);
      this.status.set(fp, { ...st, status: "offline", lastSeen: this.now().toISOString() });
      this.changed(ownerId);
    });
    for (const w of [...this.linkWaiters]) w();
    // What was waiting for this machine is asked again (same operation ids).
    for (const p of this.pending.values()) if (this.hopFor(p.ownerId, p.to) === fp) p.again();
    this.changed(ownerId);
    if (relation === "child") void this.poll(ownerId, fp);
  }

  /** The node's side: keep the link to the parent up while the pair stands. */
  private startDialer(ownerId: string) {
    if (this.dialers.has(ownerId) || this.stopped) return;
    let stop = false;
    let timer: NodeJS.Timeout | undefined;
    let current: SecureLink | undefined;
    const delays = this.o.reconnectMs ?? [1000, 2000, 5000, 10_000, 30_000];
    let attempt = 0;
    const tick = async () => {
      if (stop) return;
      const s = await this.load(ownerId);
      if (!s.parent?.confirmed) return this.dialers.delete(ownerId);
      this.parentStatus.set(ownerId, { status: "connecting" });
      try {
        const d = await dialNode({
          url: this.o.dial?.(s.parent.address) ?? channelUrl(s.parent.address),
          identity: await this.identity(ownerId),
          mode: "link",
          expect: s.parent.fingerprint,
        });
        if (stop) return d.link.close(1000, "stopped");
        attempt = 0;
        current = d.link;
        this.register(ownerId, d.link, "parent");
        d.link.onClose(() => {
          if (stop) return;
          this.parentStatus.set(ownerId, {
            status: "offline",
            reason: "The link closed: reconnecting",
          });
          timer = setTimeout(() => void tick(), delays[0] ?? 1000);
        });
      } catch (err) {
        const e = err as NodeChannelError;
        const refused = e.code === "fingerprint-changed";
        this.parentStatus.set(ownerId, {
          status: e.code === "unknown-peer" ? "pending" : refused ? "refused" : "offline",
          reason: e.message,
        });
        if (refused)
          await this.log(ownerId, {
            peer: e.seen ?? s.parent.fingerprint,
            peerName: s.parent.name,
            side: "asked",
            kind: "link",
            what: e.message,
            status: "refused",
          });
        this.changed(ownerId);
        const wait = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
        attempt += 1;
        if (!stop) timer = setTimeout(() => void tick(), wait);
      }
    };
    this.dialers.set(ownerId, {
      stop: () => {
        stop = true;
        if (timer) clearTimeout(timer);
        current?.close(1000, "stopped");
        this.dialers.delete(ownerId);
      },
    });
    void tick();
  }

  /** Starts the links kept (at the server's start) and the polls of the children. */
  async start(): Promise<void> {
    for (const ow of await this.owners()) {
      const s = await this.load(ow);
      if (s.parent?.confirmed) this.startDialer(ow);
    }
    const every = this.o.pollMs ?? 15_000;
    if (every > 0) {
      this.pollTimer = setInterval(() => {
        for (const [fp, l] of this.links) if (l.relation === "child") void this.poll(l.ownerId, fp);
      }, every);
      this.pollTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const d of [...this.dialers.values()]) d.stop();
    for (const l of [...this.links.values()]) l.link.close(1001, "server stopping");
    for (const p of [...this.pending.values()])
      p.fail(new NodeError("offline", "The server stopped"));
  }

  /** Tests: drops the link to a machine (as a cut cable would). */
  dropLink(fingerprint: string): void {
    this.links.get(fingerprint)?.link.socket.terminate();
  }

  /** Tests and the page: whether a machine is reachable now. */
  isOnline(fingerprint: string): boolean {
    return this.links.get(fingerprint)?.link.isOpen === true;
  }

  // ------------------------------------------------------------------ envelopes

  private hopFor(ownerId: string, to: string): string | null {
    const s = this.cache.get(ownerId);
    const id = this.identities.get(ownerId);
    if (!s || !id) return null;
    return nodeRoute(this.graph(id.fingerprint, s, [to]), id.fingerprint, to);
  }

  private async seal(
    ownerId: string,
    e: Omit<Envelope, "sig" | "t" | "from" | "fromKey" | "ts" | "id"> & { id?: string },
  ): Promise<Envelope> {
    const id = await this.identity(ownerId);
    const base = {
      id: e.id ?? randomUUID(),
      from: id.fingerprint,
      fromKey: id.raw.toString("base64"),
      to: e.to,
      ts: this.now().getTime(),
      kind: e.kind,
      ...(e.re && { re: e.re }),
      ...(e.op && { op: e.op }),
      body: e.body,
    };
    return { t: "env", ...base, sig: signWith(id, signed(base)).toString("base64") };
  }

  private forward(ownerId: string, env: Envelope): boolean {
    const hop = this.hopFor(ownerId, env.to);
    if (!hop) return false;
    const l = this.links.get(hop);
    return l?.link.send(env) ?? false;
  }

  /** A message on a link: an envelope for this machine, or one to pass on. */
  private async receive(ownerId: string, link: SecureLink, m: unknown) {
    const env = m as Envelope;
    if (env?.t !== "env" || typeof env.id !== "string") return;
    const raw = Buffer.from(String(env.fromKey), "base64");
    // Signed by the machine it says, recently, and only once.
    if (fingerprintOf(raw) !== env.from) return;
    if (!verifyWith(raw, signed(env), Buffer.from(String(env.sig), "base64"))) return;
    const nowMs = this.now().getTime();
    if (Math.abs(nowMs - Number(env.ts)) > CLOCK_SKEW_MS) return;
    for (const [k, until] of this.seen) if (until < nowMs) this.seen.delete(k);
    if (this.seen.has(env.id)) return;
    this.seen.set(env.id, nowMs + 2 * CLOCK_SKEW_MS);
    const s = await this.load(ownerId);
    const self = (await this.identity(ownerId)).fingerprint;
    this.status.set(link.peer.fingerprint, {
      ...this.status.get(link.peer.fingerprint),
      status: "online",
      lastSeen: this.now().toISOString(),
    });
    if (env.to !== self) {
      // Passed on along the tree; the machine it is for checks it again.
      this.forward(ownerId, env);
      return;
    }
    if (env.kind === "res" || env.kind === "chunk") {
      const p = env.re ? this.pending.get(env.re) : undefined;
      if (!p || p.to !== env.from) return;
      if (env.kind === "chunk") return p.onChunk?.(env.body);
      return p.done(env.body);
    }
    await this.serve(ownerId, s, self, env);
  }

  private async answer(ownerId: string, req: Envelope, kind: "res" | "chunk", body: unknown) {
    const env = await this.seal(ownerId, { to: req.from, kind, re: req.id, body });
    this.forward(ownerId, env);
  }

  /** A request for this machine: checked against its own grants, done, logged. */
  private async serve(ownerId: string, s: Stored, self: string, env: Envelope) {
    const op = env.op as NodeOp;
    const action = OP_ACTION[op];
    const body = (env.body ?? {}) as Record<string, unknown>;
    const fromName = this.nameOf(s, env.from);
    const t0 = Date.now();
    const reply = (
      r: { ok: true; value: unknown } | { ok: false; code: string; message: string },
    ) => this.answer(ownerId, env, "res", r);
    if (!action) return reply({ ok: false, code: "invalid", message: `Unknown operation ${op}` });
    const graph = this.graph(self, s, [env.from]);
    const grant = op === "grant.revoke" ? s.grants.find((g) => g.id === body.id) : undefined;
    if (!nodeCan(graph, s.grants, env.from, self, action, grant)) {
      await this.log(ownerId, {
        peer: env.from,
        peerName: fromName,
        side: "served",
        kind: op,
        what: `refused: ${fromName} may not ${action} this machine`,
        status: "refused",
      });
      return reply({
        ok: false,
        code: "forbidden",
        message: `${await this.name(ownerId)} refused: ${fromName} may not ${action === "use" ? "use" : action} this machine (the person decides who may command it, in Settings > Nodes there)`,
      });
    }
    const opId =
      typeof body.opId === "string" ? `${env.from}:${body.opId}` : `${env.from}:${env.id}`;
    const kept = this.results.get(opId);
    for (const [k, r] of this.results)
      if (r.at < Date.now() - RESULTS_KEPT_MS) this.results.delete(k);
    const ac = new AbortController();
    const caller: NodeCaller = {
      ownerId,
      from: env.from,
      fromName,
      rights: this.rightsHere(s, self, env.from),
      opId,
      signal: ac.signal,
      chunk: (b) => void this.answer(ownerId, env, "chunk", b),
    };
    // Asked again after a reconnect: the same operation is never run twice.
    const work = kept?.value ?? this.run(ownerId, s, self, op, caller, body);
    if (!kept && op !== "status") this.results.set(opId, { at: Date.now(), value: work });
    try {
      const value = await work;
      if (op !== "status" && op !== "fs")
        await this.log(ownerId, {
          peer: env.from,
          peerName: fromName,
          side: "served",
          kind: op,
          what: describe(op, body),
          status: "done",
          durationMs: Date.now() - t0,
        });
      await reply({ ok: true, value });
    } catch (err) {
      const e = err as NodeError;
      if (op !== "status")
        await this.log(ownerId, {
          peer: env.from,
          peerName: fromName,
          side: "served",
          kind: op,
          what: `${describe(op, body)}: ${e.message}`,
          status: e.code === "refused" || e.code === "forbidden" ? "refused" : "failed",
          durationMs: Date.now() - t0,
        });
      await reply({ ok: false, code: e.code ?? "error", message: e.message });
    }
  }

  private nameOf(s: Stored, fp: string): string {
    if (s.parent?.fingerprint === fp) return s.parent.name;
    const c = s.children.find((x) => x.fingerprint === fp);
    if (c) return c.name;
    for (const st of this.status.values()) {
      const found = findIn(st.children ?? [], fp);
      if (found) return found.name;
    }
    return s.grants.find((g) => g.controller === fp)?.controllerName ?? fp.slice(0, 15);
  }

  private async run(
    ownerId: string,
    s: Stored,
    self: string,
    op: NodeOp,
    c: NodeCaller,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const h = this.o.handlers;
    const need = <T>(f: T | undefined): T => {
      if (!f) throw new NodeError("refused", "This machine does not offer that");
      return f;
    };
    switch (op) {
      case "status":
        return this.report(ownerId);
      case "exec":
        return need(h.exec)(c, body);
      case "fs":
        return need(h.fs)(c, body);
      case "models":
        return need(h.models)(c);
      case "complete":
        return need(h.complete)(c, body);
      case "storage":
        return need(h.storage)(c, body);
      case "grant.set": {
        const controller = String(body.controller ?? "");
        const rights = (Array.isArray(body.rights) ? body.rights : []).filter(
          (r): r is NodeRight => r === "use" || r === "admin",
        );
        if (!controller || !rights.length)
          throw new NodeError("invalid", "A grant needs a machine and rights");
        return this.setGrantHere(
          ownerId,
          s,
          self,
          controller,
          String(body.controllerName ?? ""),
          rights,
          c.from,
        );
      }
      case "grant.revoke":
        return this.revokeHere(ownerId, String(body.id ?? ""), c.fromName);
      case "unpair":
        await this.forget(ownerId, c.from, `${c.fromName} unpaired`);
        return { ok: true };
    }
  }

  /** How this machine is, with its subtree as its children last reported. */
  async report(ownerId: string): Promise<NodeView> {
    const s = await this.load(ownerId);
    const id = await this.identity(ownerId);
    return {
      fingerprint: id.fingerprint,
      name: await this.name(ownerId),
      relation: "self",
      status: "online",
      lastSeen: this.now().toISOString(),
      capabilities: await this.o.handlers.capabilities(ownerId).catch(() => undefined as never),
      grants: s.grants,
      children: s.children.filter((c) => c.confirmed).map((c) => this.childView(c)),
    };
  }

  private childView(c: Peer): NodeView {
    const st = this.status.get(c.fingerprint);
    const online = this.isOnline(c.fingerprint);
    return {
      fingerprint: c.fingerprint,
      name: c.name,
      relation: "child",
      status: online ? "online" : "offline",
      ...(st?.lastSeen && { lastSeen: st.lastSeen }),
      pairedAt: c.pairedAt,
      ...(st?.capabilities && { capabilities: st.capabilities }),
      grants: st?.grants ?? [],
      children: (st?.children ?? []).map((x) => ({ ...x, relation: "tree" as const })),
    };
  }

  /** Asks a child how it is (its subtree included) and keeps the answer for the page and routes. */
  async poll(ownerId: string, fp: string): Promise<void> {
    try {
      const r = (await this.request(
        ownerId,
        fp,
        "status",
        {},
        { timeoutMs: 10_000, waitMs: 0 },
      )) as NodeView;
      const prev = this.status.get(fp);
      this.status.set(fp, {
        ...prev,
        status: "online",
        lastSeen: this.now().toISOString(),
        ...(r.capabilities && { capabilities: r.capabilities }),
        grants: r.grants ?? [],
        children: r.children ?? [],
      });
      const s = await this.load(ownerId);
      // The child's own name follows what it says.
      const c = s.children.find((x) => x.fingerprint === fp);
      if (c && r.name && r.name !== c.name)
        await this.save(ownerId, {
          ...s,
          children: s.children.map((x) => (x === c ? { ...c, name: r.name } : x)),
        });
      else this.changed(ownerId);
    } catch {}
  }

  /**
   * Asks another machine of the tree: signed, routed, checked there. Waits for an offline machine
   * up to `waitMs`, and asks again after a reconnect with the same operation id.
   */
  async request(
    ownerId: string,
    to: string,
    op: NodeOp,
    body: Record<string, unknown>,
    o: {
      timeoutMs?: number;
      waitMs?: number;
      signal?: AbortSignal | undefined;
      onChunk?: (b: unknown) => void;
      /** Not asked again after a reconnect (a model's stream: the caller retries). */
      once?: boolean;
      log?: {
        projectId?: string | null;
        agentId?: string | null;
        sessionId?: string | null;
        what: string;
      };
    } = {},
  ): Promise<unknown> {
    const s = await this.load(ownerId);
    const self = (await this.identity(ownerId)).fingerprint;
    if (to === self) throw new NodeError("invalid", "That is this machine");
    const peerName = this.nameOf(s, to);
    const opId = randomUUID();
    const waitMs = o.waitMs ?? this.o.waitMs ?? 20_000;
    const t0 = Date.now();
    const logIt = (status: "done" | "failed" | "refused", what: string) =>
      o.log &&
      this.log(
        ownerId,
        { peer: to, peerName, side: "asked", kind: op, what, status, durationMs: Date.now() - t0 },
        o.log,
      );
    // The machine must be reachable: wait a little for it (a reconnect), else say so.
    if (!(await this.reachable(ownerId, to, waitMs, o.signal))) {
      const e = new NodeError(
        "offline",
        `The node "${peerName}" is offline: nothing was sent to it. It is retried as soon as it is back; try again then.`,
      );
      await logIt("failed", `${o.log?.what ?? op}: offline, not sent`);
      throw e;
    }
    const value = await new Promise<unknown>((resolve, reject) => {
      let env: Envelope | undefined;
      let timer: NodeJS.Timeout | undefined;
      let lostTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) clearTimeout(timer);
        if (lostTimer) clearTimeout(lostTimer);
        if (env) this.pending.delete(env.id);
        o.signal?.removeEventListener("abort", onAbort);
        offClose?.();
      };
      const onAbort = () => {
        finish();
        reject(new NodeError("timeout", "Stopped"));
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let offClose: (() => void) | undefined;
      const send = async () => {
        const prev = env;
        env = await this.seal(ownerId, { to, kind: "req", op, body: { ...body, opId } });
        if (prev) this.pending.delete(prev.id);
        const p: Pending = {
          ownerId,
          env,
          to,
          onChunk: o.onChunk,
          done: (b) => {
            finish();
            const r = b as { ok?: boolean; value?: unknown; code?: string; message?: string };
            if (r?.ok) resolve(r.value);
            else
              reject(
                new NodeError((r?.code as NodeError["code"]) ?? "refused", r?.message ?? "Refused"),
              );
          },
          fail: (e) => {
            finish();
            reject(e);
          },
          again: () => {
            if (o.once) return;
            if (lostTimer) clearTimeout(lostTimer);
            void send();
          },
        };
        this.pending.set(env.id, p);
        offClose?.();
        const hop = this.hopFor(ownerId, to);
        const link = hop ? this.links.get(hop)?.link : undefined;
        offClose = link?.onClose(() => {
          if (o.once)
            return p.fail(
              new NodeError("lost", `The node "${peerName}" went offline while answering`),
            );
          // Kept until the machine is back (then asked again) or the wait is over.
          lostTimer = setTimeout(
            () =>
              p.fail(
                new NodeError(
                  "lost",
                  `The node "${peerName}" went offline while working and did not come back in ${Math.round(waitMs / 1000)} s: its result is not known here. Nothing is retried by itself; ask again when it is back.`,
                ),
              ),
            Math.max(waitMs, 1000),
          );
        });
        if (!link?.send(env)) offClose?.();
      };
      if (o.timeoutMs)
        timer = setTimeout(() => {
          finish();
          reject(
            new NodeError(
              "timeout",
              `The node "${peerName}" did not answer in ${Math.round((o.timeoutMs ?? 0) / 1000)} s`,
            ),
          );
        }, o.timeoutMs);
      void send();
    }).catch(async (err) => {
      const e = err as NodeError;
      await logIt(
        e.code === "forbidden" || e.code === "refused" ? "refused" : "failed",
        `${o.log?.what ?? op}: ${e.message}`,
      );
      throw err;
    });
    await logIt("done", o.log?.what ?? op);
    return value;
  }

  private async reachable(ownerId: string, to: string, waitMs: number, signal?: AbortSignal) {
    const ok = () => {
      const hop = this.hopFor(ownerId, to);
      return hop !== null && this.isOnline(hop);
    };
    if (ok()) return true;
    if (waitMs <= 0) return false;
    return await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(t);
        this.linkWaiters.delete(check);
        resolve(v);
      };
      const check = () => ok() && done(true);
      const t = setTimeout(() => done(ok()), waitMs);
      signal?.addEventListener("abort", () => done(false), { once: true });
      this.linkWaiters.add(check);
    });
  }

  // ------------------------------------------------------------------ grants and unpairing

  private async setGrantHere(
    ownerId: string,
    s: Stored,
    self: string,
    controller: string,
    controllerName: string,
    rights: NodeRight[],
    from: string,
  ): Promise<NodeGrant> {
    if (controller === self) throw new NodeError("invalid", "A machine always commands itself");
    const g: NodeGrant = {
      id: `grant_${randomUUID().slice(0, 8)}`,
      controller,
      controllerName: controllerName || this.nameOf(s, controller),
      target: self,
      targetName: await this.name(ownerId),
      rights: [...new Set(rights)],
      grantedAt: this.now().toISOString(),
      grantedFrom: from,
    };
    await this.save(ownerId, {
      ...s,
      grants: [...s.grants.filter((x) => x.controller !== controller), g],
    });
    return g;
  }

  private async revokeHere(ownerId: string, id: string, by: string): Promise<{ ok: true }> {
    const s = await this.load(ownerId);
    const g = s.grants.find((x) => x.id === id);
    if (!g) throw new NodeError("not-found", "There is no such grant here");
    await this.save(ownerId, { ...s, grants: s.grants.filter((x) => x.id !== id) });
    await this.log(ownerId, {
      peer: g.controller,
      peerName: g.controllerName,
      side: "served",
      kind: "grant.revoke",
      what: `${by} took away what ${g.controllerName} could do here (${g.rights.join(", ")})`,
      status: "done",
    });
    return { ok: true };
  }

  /**
   * The person gives `controller` rights on `target`: on this machine directly, or on another
   * one, which checks that this machine manages it.
   */
  async grant(
    ownerId: string,
    controller: string,
    target: string,
    rights: NodeRight[],
  ): Promise<NodeGrant> {
    const s = await this.load(ownerId);
    const self = (await this.identity(ownerId)).fingerprint;
    const g =
      target === self
        ? await this.setGrantHere(ownerId, s, self, controller, "", rights, self)
        : ((await this.request(ownerId, target, "grant.set", {
            controller,
            controllerName: this.nameOf(s, controller),
            rights,
          })) as NodeGrant);
    await this.log(ownerId, {
      peer: target,
      peerName: g.targetName,
      side: "asked",
      kind: "grant.set",
      what: `the person let ${g.controllerName} ${rights.join(" and ")} ${g.targetName}`,
      status: "done",
    });
    if (target !== self) void this.refreshAll(ownerId);
    return g;
  }

  async revoke(ownerId: string, target: string, grantId: string): Promise<void> {
    const self = (await this.identity(ownerId)).fingerprint;
    if (target === self) await this.revokeHere(ownerId, grantId, "the person");
    else {
      await this.request(ownerId, target, "grant.revoke", { id: grantId });
      void this.refreshAll(ownerId);
    }
  }

  private async refreshAll(ownerId: string) {
    for (const [fp, l] of this.links)
      if (l.ownerId === ownerId && l.relation === "child") await this.poll(ownerId, fp);
  }

  /** Unpairs from this side (the other side is told when it is reachable). */
  async unpair(ownerId: string, fingerprint: string): Promise<void> {
    const s = await this.load(ownerId);
    const isPeer =
      s.parent?.fingerprint === fingerprint ||
      s.children.some((c) => c.fingerprint === fingerprint);
    if (!isPeer) throw new NodeError("not-found", "This machine is not paired with that one");
    if (this.isOnline(fingerprint))
      await this.request(ownerId, fingerprint, "unpair", {}, { timeoutMs: 5000, waitMs: 0 }).catch(
        () => {},
      );
    await this.forget(ownerId, fingerprint, "the person unpaired");
  }

  private async forget(ownerId: string, fingerprint: string, why: string) {
    const s = await this.load(ownerId);
    const name = this.nameOf(s, fingerprint);
    const next: Stored = {
      ...s,
      children: s.children.filter((c) => c.fingerprint !== fingerprint),
      grants: s.grants.filter((g) => g.controller !== fingerprint),
      placements: s.placements
        .map((p): NodePlacement => {
          const out: NodePlacement = { scope: p.scope };
          if (p.commands && p.commands !== fingerprint) out.commands = p.commands;
          if (p.backups && p.backups !== fingerprint) out.backups = p.backups;
          return out;
        })
        .filter((p) => p.commands || p.backups),
    };
    if (s.parent?.fingerprint === fingerprint) {
      delete next.parent;
      this.dialers.get(ownerId)?.stop();
      this.parentStatus.delete(ownerId);
    }
    await this.save(ownerId, next);
    this.status.delete(fingerprint);
    // After the answer has left.
    setTimeout(() => this.links.get(fingerprint)?.link.close(4010, "unpaired"), 50).unref();
    await this.log(ownerId, {
      peer: fingerprint,
      peerName: name,
      side: "served",
      kind: "unpair",
      what: `${why}: ${name}`,
      status: "done",
    });
  }

  // ------------------------------------------------------------------ placements

  async setPlacement(
    ownerId: string,
    scope: string,
    p: { commands?: string | null | undefined; backups?: string | null | undefined },
  ): Promise<NodePlacement[]> {
    const s = await this.load(ownerId);
    const old = s.placements.find((x) => x.scope === scope) ?? { scope };
    const next: NodePlacement = { scope };
    const commands = p.commands === undefined ? old.commands : p.commands;
    const backups = p.backups === undefined ? old.backups : p.backups;
    const known = (fp: string) => this.allNodes(ownerId, s).some((n) => n.fingerprint === fp);
    if (commands) {
      if (!known(commands)) throw new NodeError("not-found", "Unknown node");
      next.commands = commands;
    }
    if (backups) {
      if (!known(backups)) throw new NodeError("not-found", "Unknown node");
      next.backups = backups;
    }
    const placements = s.placements.filter((x) => x.scope !== scope);
    if (next.commands || next.backups) placements.push(next);
    await this.save(ownerId, { ...s, placements });
    return placements;
  }

  /** Where the person pinned an agent's commands: the agent's choice first, then its project's. */
  async placementFor(
    ownerId: string,
    agentId: string,
    projectId?: string | null,
  ): Promise<{ commands?: string; backups?: string }> {
    const s = await this.load(ownerId);
    const a = s.placements.find((p) => p.scope === `agent:${agentId}`);
    const p = projectId ? s.placements.find((x) => x.scope === `project:${projectId}`) : undefined;
    const commands = a?.commands ?? p?.commands;
    const backups = a?.backups ?? p?.backups;
    return { ...(commands && { commands }), ...(backups && { backups }) };
  }

  // ------------------------------------------------------------------ what the page and tools see

  private allNodes(
    ownerId: string,
    s: Stored,
  ): { fingerprint: string; name: string; view?: NodeView }[] {
    const out: { fingerprint: string; name: string; view?: NodeView }[] = [];
    if (s.parent?.confirmed) out.push({ fingerprint: s.parent.fingerprint, name: s.parent.name });
    const walk = (v: NodeView) => {
      out.push({ fingerprint: v.fingerprint, name: v.name, view: v });
      for (const c of v.children) walk(c);
    };
    for (const c of s.children.filter((x) => x.confirmed)) walk(this.childView(c));
    void ownerId;
    return out;
  }

  /** The machines one can name (tools, menus): the parent, the children and their subtrees. */
  async known(
    ownerId: string,
  ): Promise<{ fingerprint: string; name: string; online: boolean; view?: NodeView }[]> {
    const s = await this.load(ownerId);
    return this.allNodes(ownerId, s).map((n) => ({
      ...n,
      online: n.view ? n.view.status === "online" : this.isOnline(n.fingerprint),
    }));
  }

  /** A node by name or fingerprint. */
  async find(ownerId: string, nameOrFp: string) {
    const all = await this.known(ownerId);
    return (
      all.find((n) => n.fingerprint === nameOrFp) ??
      all.find((n) => n.name === nameOrFp) ??
      all.find((n) => n.name.toLowerCase() === nameOrFp.toLowerCase())
    );
  }

  async state(ownerId: string): Promise<NodesState> {
    let ready = true;
    let reason: string | undefined;
    let fp: string | undefined;
    try {
      fp = (await this.identity(ownerId)).fingerprint;
    } catch (err) {
      ready = false;
      reason = (err as Error).message;
    }
    const s = await this.load(ownerId);
    const name = await this.name(ownerId);
    const pending: PendingPair[] = [];
    if (s.parent && !s.parent.confirmed)
      pending.push({
        fingerprint: s.parent.fingerprint,
        name: s.parent.name,
        sas: s.parent.sas,
        side: "node",
        at: s.parent.pairedAt,
      });
    for (const c of s.children.filter((x) => !x.confirmed))
      pending.push({
        fingerprint: c.fingerprint,
        name: c.name,
        sas: c.sas,
        side: "principal",
        at: c.pairedAt,
      });
    const tree: NodeView = {
      fingerprint: fp ?? "",
      name,
      relation: "self",
      status: "online",
      grants: s.grants,
      ...(ready && {
        capabilities: await this.o.handlers.capabilities(ownerId).catch(() => undefined as never),
      }),
      children: s.children.filter((c) => c.confirmed).map((c) => this.childView(c)),
    };
    const ps = this.parentStatus.get(ownerId);
    const parent: NodeView | undefined = s.parent?.confirmed
      ? {
          fingerprint: s.parent.fingerprint,
          name: s.parent.name,
          relation: "parent",
          status: this.isOnline(s.parent.fingerprint) ? "online" : (ps?.status ?? "offline"),
          ...(ps?.reason && !this.isOnline(s.parent.fingerprint) && { reason: ps.reason }),
          ...(this.status.get(s.parent.fingerprint)?.lastSeen && {
            lastSeen: this.status.get(s.parent.fingerprint)?.lastSeen as string,
          }),
          address: s.parent.address,
          pairedAt: s.parent.pairedAt,
          grants: [],
          children: [],
        }
      : undefined;
    const code = [...this.codes.values()].find(
      (c) => c.ownerId === ownerId && c.expires > Date.now(),
    );
    return {
      self: { ...(fp && { fingerprint: fp }), name, ready, ...(reason && { reason }) },
      tree,
      ...(parent && { parent }),
      pending,
      grants: s.grants,
      placements: s.placements,
      ...(code && { code: { code: code.code, expiresAt: new Date(code.expires).toISOString() } }),
    };
  }
}

function findIn(list: NodeView[], fp: string): NodeView | undefined {
  for (const v of list) {
    if (v.fingerprint === fp) return v;
    const c = findIn(v.children, fp);
    if (c) return c;
  }
  return undefined;
}

/** One line for the log: what was asked, never a secret (commands as written, file names). */
function describe(op: NodeOp, body: Record<string, unknown>): string {
  if (op === "exec")
    return `exec ${typeof body.command === "string" ? body.command : `${String(body.file ?? "")} ${(Array.isArray(body.args) ? body.args : []).join(" ")}`}`.slice(
      0,
      500,
    );
  if (op === "complete") return `model ${String(body.provider ?? "")}/${String(body.model ?? "")}`;
  if (op === "storage") return `storage ${String(body.action ?? "")} ${String(body.name ?? "")}`;
  if (op === "fs") return `files ${String(body.action ?? "")} ${String(body.path ?? "")}`;
  return op;
}
