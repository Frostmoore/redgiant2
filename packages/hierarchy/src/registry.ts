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
  connections?: string[];
  subprojectId?: string;
  compaction?: { at?: number; keep?: number };
  skills?: string[];
  projects?: string[];
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
  connections: string | null;
  subproject_id: string | null;
  compaction: string | null;
  skills: string | null;
  projects: string | null;
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
  // The services an assistant may use (G24.11).
  await db.query("ALTER TABLE rg_agents ADD COLUMN IF NOT EXISTS connections text");
  // The subproject an agent works in (G24.13).
  await db.query("ALTER TABLE rg_agents ADD COLUMN IF NOT EXISTS subproject_id text");
  // How its conversations are summarised (G24.14c).
  await db.query("ALTER TABLE rg_agents ADD COLUMN IF NOT EXISTS compaction text");
  // Other projects it is assigned to (2026-11-03), under their orchestrators.
  await db.query("ALTER TABLE rg_agents ADD COLUMN IF NOT EXISTS projects text");
  // The skills an agent uses, when not all (G24.14c).
  await db.query("ALTER TABLE rg_agents ADD COLUMN IF NOT EXISTS skills text");
  // One God and one Demi-God per owner, one orchestrator and one inspector per project.
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rg_agents_one_god ON rg_agents (owner_id, kind) WHERE kind IN ('god', 'demigod') AND status = 'active'",
  );
  // G24.13: one inspector per project and one per subproject; one orchestrator per project.
  await db.query("DROP INDEX IF EXISTS rg_agents_one_per_project");
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS rg_agents_one_per_project_v2 ON rg_agents (owner_id, project_id, kind, (COALESCE(subproject_id, ''))) WHERE kind IN ('orchestrator', 'inspector') AND status = 'active'",
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
  // Spend per day (G24.10): what the counters above add up, for the month's chart.
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_spend_daily (
      owner_id text NOT NULL,
      day      text NOT NULL,
      scope    text NOT NULL,
      key      text NOT NULL,
      usd      double precision NOT NULL DEFAULT 0,
      tokens   bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_id, day, scope, key)
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
  ...(r.connections !== null && { connections: JSON.parse(r.connections) as string[] }),
  ...(r.subproject_id !== null && { subprojectId: r.subproject_id }),
  ...(r.skills !== null && { skills: JSON.parse(r.skills) as string[] }),
  ...(r.projects && { projects: JSON.parse(r.projects) as string[] }),
  ...(r.compaction !== null && {
    compaction: JSON.parse(r.compaction) as { at?: number; keep?: number },
  }),
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
    // A child works where its parent does; only project agents belong to a subproject.
    const subprojectId =
      parent?.subprojectId ??
      (["agent", "inspector"].includes(input.kind) ? input.subprojectId : undefined);
    if (parent?.subprojectId && input.subprojectId && input.subprojectId !== parent.subprojectId)
      throw new HierarchyError("A child works in its parent's subproject");

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
      ...(input.connections !== undefined && { connections: input.connections }),
      ...(subprojectId !== undefined && { subprojectId }),
      status: "active",
    };
    try {
      await this.db.query(
        `INSERT INTO rg_agents (id, owner_id, kind, parent_id, project_id, persistent, name, role, system_prompt, model, mode, connections, subproject_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
          input.connections ? JSON.stringify(input.connections) : null,
          subprojectId ?? null,
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

  /**
   * Changes model, mode or prompt; only God (not on itself) and the human may. `null` clears
   * a field (the model is inherited again, the prompt is the default one).
   */
  async configure(
    actor: Actor,
    id: string,
    change: {
      model?: ModelSpec | null;
      mode?: PermissionMode | null;
      systemPrompt?: string | null;
      connections?: string[] | null;
      role?: string | null;
      compaction?: { at?: number; keep?: number } | null;
      skills?: string[] | null;
      projects?: string[] | null;
    },
  ): Promise<AgentRecord> {
    const target = this.cache.get(id);
    if (!target) throw new HierarchyError(`Unknown agent "${id}"`);
    if (!can(actor, "configure", target, this.resolve))
      throw new HierarchyError(`Not allowed to configure "${target.name}"`);
    const columns = {
      model: "model",
      mode: "mode",
      systemPrompt: "system_prompt",
      connections: "connections",
      role: "role",
      compaction: "compaction",
      skills: "skills",
      projects: "projects",
    } as const;
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as [keyof typeof columns, string][]) {
      if (change[key] === undefined) continue;
      const v = change[key];
      params.push(
        (key === "model" ||
          key === "connections" ||
          key === "compaction" ||
          key === "skills" ||
          key === "projects") &&
          v !== null
          ? JSON.stringify(v)
          : v,
      );
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length > 0)
      await this.db.query(`UPDATE rg_agents SET ${sets.join(", ")} WHERE id = $1`, params);
    const updated: AgentRecord = { ...target };
    for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
      const v = change[key];
      if (v === undefined) continue;
      if (v === null) delete updated[key];
      else Object.assign(updated, { [key]: v });
    }
    this.cache.set(id, updated);
    return updated;
  }

  /**
   * Moves an agent to another project or subproject, or under another parent (G24.14c: a project
   * becoming a subproject of another). Only the human does it; the log records it.
   */
  async move(
    id: string,
    to: { projectId: string | null; subprojectId: string | null; parentId: string | null },
  ): Promise<AgentRecord> {
    const a = this.cache.get(id);
    if (!a) throw new HierarchyError(`Unknown agent "${id}"`);
    await this.db.query(
      "UPDATE rg_agents SET project_id = $2, subproject_id = $3, parent_id = $4 WHERE id = $1",
      [id, to.projectId, to.subprojectId, to.parentId],
    );
    const { subprojectId: _s, ...rest } = a;
    const moved: AgentRecord = {
      ...rest,
      projectId: to.projectId,
      parentId: to.parentId,
      ...(to.subprojectId && { subprojectId: to.subprojectId }),
    };
    this.cache.set(id, moved);
    return moved;
  }

  /** Renames an agent (the setup wizard names God and Demi-God). */
  async rename(id: string, name: string): Promise<AgentRecord> {
    const a = this.cache.get(id);
    if (!a) throw new HierarchyError(`Unknown agent "${id}"`);
    await this.db.query("UPDATE rg_agents SET name = $2 WHERE id = $1", [id, name]);
    const updated = { ...a, name };
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
