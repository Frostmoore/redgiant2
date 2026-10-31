import { randomUUID } from "node:crypto";
import type { EventStore, SqlClient } from "@redgiant/events";
import {
  type AgentSpec,
  LOCAL_OWNER_ID,
  type ModelSpec,
  type PermissionMode,
} from "@redgiant/protocol";
import { type Actor, type AgentNode, CHILD_KINDS, can } from "./scopes.js";

export interface AgentRecord extends AgentSpec {
  ownerId: string;
  status: "active" | "stopped";
}

export interface NewAgent {
  kind: AgentSpec["kind"];
  parentId: string | null;
  projectId?: string | null;
  persistent?: boolean;
  name: string;
  role?: string;
  systemPrompt?: string;
  model?: ModelSpec;
  mode?: PermissionMode;
}

export class HierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HierarchyError";
  }
}

interface Row {
  id: string;
  owner_id: string;
  kind: AgentSpec["kind"];
  parent_id: string | null;
  project_id: string | null;
  persistent: boolean;
  name: string;
  role: string | null;
  system_prompt: string | null;
  model: string | null;
  mode: PermissionMode | null;
  status: "active" | "stopped";
}

export async function migrateHierarchy(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_agents (
      id            text PRIMARY KEY,
      owner_id      text NOT NULL,
      kind          text NOT NULL,
      parent_id     text REFERENCES rg_agents(id),
      project_id    text,
      persistent    boolean NOT NULL,
      name          text NOT NULL,
      role          text,
      system_prompt text,
      model         text,
      mode          text,
      status        text NOT NULL DEFAULT 'active',
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  // One God and one Demi-God per owner, one orchestrator and one inspector per project.
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rg_agents_one_god ON rg_agents (owner_id, kind) WHERE kind IN ('god', 'demigod') AND status = 'active'",
  );
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rg_agents_one_per_project ON rg_agents (owner_id, project_id, kind) WHERE kind IN ('orchestrator', 'inspector') AND status = 'active'",
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_budgets (
      scope      text NOT NULL,
      key        text NOT NULL,
      limit_usd  double precision,
      limit_tok  bigint,
      spent_usd  double precision NOT NULL DEFAULT 0,
      spent_tok  bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, key)
    )`);
}

const fromRow = (r: Row): AgentRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  kind: r.kind,
  parentId: r.parent_id,
  projectId: r.project_id,
  persistent: r.persistent,
  name: r.name,
  ...(r.role !== null && { role: r.role }),
  ...(r.system_prompt !== null && { systemPrompt: r.system_prompt }),
  ...(r.model !== null && { model: JSON.parse(r.model) as ModelSpec }),
  ...(r.mode !== null && { mode: r.mode }),
  status: r.status,
});

/**
 * The agent tree of every owner. Creation and stopping are checked against the scope rules
 * and recorded in the event log.
 */
export class AgentRegistry {
  private cache = new Map<string, AgentRecord>();

  constructor(
    private readonly db: SqlClient,
    private readonly store: EventStore,
  ) {}

  /** Loads every agent into memory (the tree is small). */
  async load(): Promise<void> {
    const rows = await this.db.query<Row>("SELECT * FROM rg_agents");
    this.cache = new Map(rows.map((r) => [r.id, fromRow(r)]));
  }

  get(id: string): AgentRecord | undefined {
    return this.cache.get(id);
  }

  /** Lookup for scope checks. */
  readonly resolve = (id: string): AgentNode | undefined => this.cache.get(id);

  list(
    filter: { ownerId?: string; projectId?: string; parentId?: string; activeOnly?: boolean } = {},
  ): AgentRecord[] {
    return [...this.cache.values()].filter(
      (a) =>
        (filter.ownerId === undefined || a.ownerId === filter.ownerId) &&
        (filter.projectId === undefined || a.projectId === filter.projectId) &&
        (filter.parentId === undefined || a.parentId === filter.parentId) &&
        (!filter.activeOnly || a.status === "active"),
    );
  }

  /** Creates an agent on behalf of `actor` (the human, or the agent that spawns it). */
  async create(actor: Actor, input: NewAgent): Promise<AgentRecord> {
    const ownerId = actor.type === "human" ? actor.ownerId : actor.agent.ownerId;
    const parent = input.parentId ? this.cache.get(input.parentId) : undefined;
    if (input.parentId && !parent) throw new HierarchyError(`Unknown parent "${input.parentId}"`);
    if (parent && parent.status !== "active")
      throw new HierarchyError("The parent agent is stopped");
    if (parent && parent.ownerId !== ownerId)
      throw new HierarchyError("The parent belongs to another owner");

    if (input.kind === "god") {
      if (parent) throw new HierarchyError("God has no parent");
      if (actor.type !== "human") throw new HierarchyError("Only the human can create God");
    } else {
      if (!parent) throw new HierarchyError(`A ${input.kind} needs a parent`);
      if (!CHILD_KINDS[parent.kind].includes(input.kind)) {
        throw new HierarchyError(`A ${parent.kind} cannot have a ${input.kind} below it`);
      }
      if (!can(actor, "spawn", parent, this.resolve)) {
        throw new HierarchyError(`Not allowed to create agents under "${parent.name}"`);
      }
    }

    const needsProject = ["orchestrator", "agent", "subagent", "inspector"].includes(input.kind);
    const projectId = needsProject ? (input.projectId ?? parent?.projectId ?? null) : null;
    if (needsProject && !projectId)
      throw new HierarchyError(`A ${input.kind} belongs to a project`);
    if (parent?.projectId && projectId !== parent.projectId) {
      throw new HierarchyError("A child must belong to its parent's project");
    }
    const persistent = input.kind === "subagent" ? false : (input.persistent ?? true);

    const record: AgentRecord = {
      id: `${input.kind}_${randomUUID().slice(0, 8)}`,
      ownerId,
      kind: input.kind,
      parentId: input.parentId,
      projectId,
      persistent,
      name: input.name,
      ...(input.role !== undefined && { role: input.role }),
      ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.mode !== undefined && { mode: input.mode }),
      status: "active",
    };
    try {
      await this.db.query(
        `INSERT INTO rg_agents (id, owner_id, kind, parent_id, project_id, persistent, name, role, system_prompt, model, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          ownerId,
          record.kind,
          record.parentId,
          projectId,
          persistent,
          record.name,
          input.role ?? null,
          input.systemPrompt ?? null,
          input.model ? JSON.stringify(input.model) : null,
          input.mode ?? null,
        ],
      );
    } catch (err) {
      if (/unique/i.test(String(err))) {
        throw new HierarchyError(
          input.kind === "god" || input.kind === "demigod"
            ? `There is already a ${input.kind}`
            : `The project already has an ${input.kind}`,
        );
      }
      throw err;
    }
    this.cache.set(record.id, record);
    const { status: _s, ownerId: _o, ...spec } = record;
    await this.store.append({
      ownerId,
      projectId,
      agentId: actor.type === "agent" ? actor.agent.id : null,
      body: { type: "agent.spawned", payload: { agent: spec } },
    });
    return record;
  }

  /** Stops an agent and, recursively, everything below it. */
  async stop(actor: Actor, id: string, reason: string): Promise<string[]> {
    const target = this.cache.get(id);
    if (!target) throw new HierarchyError(`Unknown agent "${id}"`);
    if (!can(actor, "stop", target, this.resolve))
      throw new HierarchyError(`Not allowed to stop "${target.name}"`);
    const stopped: string[] = [];
    const walk = async (a: AgentRecord) => {
      for (const child of this.list({ parentId: a.id, activeOnly: true })) await walk(child);
      if (a.status === "stopped") return;
      await this.db.query("UPDATE rg_agents SET status = 'stopped' WHERE id = $1", [a.id]);
      a.status = "stopped";
      stopped.push(a.id);
      await this.store.append({
        ownerId: a.ownerId,
        projectId: a.projectId,
        agentId: a.id,
        body: { type: "agent.stopped", payload: { agentId: a.id, reason } },
      });
    };
    await walk(target);
    return stopped;
  }

  /** Changes model, mode or prompt; only God (not on itself) and the human may. */
  async configure(
    actor: Actor,
    id: string,
    change: { model?: ModelSpec; mode?: PermissionMode; systemPrompt?: string },
  ): Promise<AgentRecord> {
    const target = this.cache.get(id);
    if (!target) throw new HierarchyError(`Unknown agent "${id}"`);
    if (!can(actor, "configure", target, this.resolve))
      throw new HierarchyError(`Not allowed to configure "${target.name}"`);
    await this.db.query(
      "UPDATE rg_agents SET model = COALESCE($2, model), mode = COALESCE($3, mode), system_prompt = COALESCE($4, system_prompt) WHERE id = $1",
      [
        id,
        change.model ? JSON.stringify(change.model) : null,
        change.mode ?? null,
        change.systemPrompt ?? null,
      ],
    );
    const updated = { ...target, ...change };
    this.cache.set(id, updated);
    return updated;
  }

  /** Effective model of an agent: its own fields, the missing ones inherited up the tree (RD13). */
  effectiveModel(id: string): ModelSpec | undefined {
    const chain: AgentRecord[] = [];
    let cur = this.cache.get(id);
    while (cur) {
      chain.push(cur);
      cur = cur.parentId ? this.cache.get(cur.parentId) : undefined;
    }
    let merged: Partial<ModelSpec> = {};
    for (const a of chain.reverse()) if (a.model) merged = { ...merged, ...a.model };
    return merged.provider && merged.model ? (merged as ModelSpec) : undefined;
  }
}

export { LOCAL_OWNER_ID };
