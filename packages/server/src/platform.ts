import { randomUUID } from "node:crypto";
import type { Tool } from "@redgiant/agent";
import type { AutomationService } from "@redgiant/automations";
import type { EventStore, SqlClient } from "@redgiant/events";
import {
  type AgentRecord,
  type AgentRegistry,
  DEFAULT_DANGER_RULES,
  DEFAULT_POLICY,
  type PermissionRule,
  type PersistentBudget,
  type PolicySettings,
} from "@redgiant/hierarchy";
import { Effort, type ModelSpec, PermissionMode } from "@redgiant/protocol";
import { z } from "zod";

/** The part of the permission policy the user (or God, with the user's approval) can change. */
export const PlatformPolicy = z.object({
  rules: z
    .array(
      z.object({
        tool: z.string().min(1),
        match: z.string().optional(),
        decision: z.enum(["allow", "ask", "deny"]),
      }),
    )
    .default([]),
  /** Danger ids only the human may approve (default: DEFAULT_POLICY.humanOnly). */
  humanOnly: z.array(z.string()).optional(),
  /** Danger rules switched off. */
  disabledDanger: z.array(z.string()).default([]),
});
export type PlatformPolicy = z.infer<typeof PlatformPolicy>;

export type ChangeStage =
  | "proposed"
  | "tested"
  | "failed"
  | "promoted"
  | "rolled_back"
  | "discarded"
  | "undone";

export interface PlatformChange {
  id: string;
  ownerId: string;
  kind: "config" | "code";
  change: string;
  stage: ChangeStage;
  target: string | null;
  before: unknown;
  after: unknown;
  detail: string | null;
  by: string;
  createdAt: string;
  updatedAt: string;
}

export async function migratePlatform(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_settings (
      owner_id text NOT NULL,
      key      text NOT NULL,
      value    jsonb NOT NULL,
      PRIMARY KEY (owner_id, key)
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_platform_changes (
      id         text PRIMARY KEY,
      owner_id   text NOT NULL,
      kind       text NOT NULL,
      change     text NOT NULL,
      stage      text NOT NULL,
      target     text,
      before     jsonb,
      after      jsonb,
      detail     text,
      by_whom    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/** Tools that modify a workspace: in metal mode God asks the human for each of them. */
const MODIFYING_BASE_TOOLS = ["bash", "write_file", "edit_file"];

/** Per-owner policies, cached (the broker asks for them synchronously on every call). */
export class PolicyStore {
  private readonly cache = new Map<string, PlatformPolicy>();

  constructor(private readonly db: SqlClient) {}

  async load(): Promise<void> {
    const rows = await this.db.query<{ owner_id: string; value: unknown }>(
      "SELECT owner_id, value FROM rg_settings WHERE key = 'policy'",
    );
    for (const r of rows) {
      const v = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
      this.cache.set(r.owner_id, PlatformPolicy.parse(v));
    }
  }

  get(ownerId: string): PlatformPolicy {
    return this.cache.get(ownerId) ?? { rules: [], disabledDanger: [] };
  }

  async set(ownerId: string, policy: PlatformPolicy): Promise<void> {
    const p = PlatformPolicy.parse(policy);
    await this.db.query(
      `INSERT INTO rg_settings (owner_id, key, value) VALUES ($1, 'policy', $2)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [ownerId, JSON.stringify(p)],
    );
    this.cache.set(ownerId, p);
  }

  /** The settings the broker applies to an agent. */
  settingsFor(agent: AgentRecord, metal: boolean): PolicySettings {
    const p = this.get(agent.ownerId);
    const rules: PermissionRule[] = [
      // On the real system every change God makes is the human's call (G14.3).
      ...(metal && agent.kind === "god"
        ? MODIFYING_BASE_TOOLS.map((tool) => ({ tool, decision: "ask" as const }))
        : []),
      ...p.rules.map((r) => ({
        tool: r.tool,
        decision: r.decision,
        ...(r.match !== undefined && { match: r.match }),
      })),
    ];
    return {
      ...DEFAULT_POLICY,
      rules,
      danger: DEFAULT_DANGER_RULES.map((r) =>
        p.disabledDanger.includes(r.id) ? { ...r, enabled: false } : r,
      ),
      humanOnly: p.humanOnly ?? DEFAULT_POLICY.humanOnly,
    };
  }
}

interface ChangeRow {
  id: string;
  owner_id: string;
  kind: "config" | "code";
  change: string;
  stage: ChangeStage;
  target: string | null;
  before: unknown;
  after: unknown;
  detail: string | null;
  by_whom: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const parseJson = (v: unknown) => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);
const toChange = (r: ChangeRow): PlatformChange => ({
  id: r.id,
  ownerId: r.owner_id,
  kind: r.kind,
  change: r.change,
  stage: r.stage,
  target: r.target,
  before: parseJson(r.before),
  after: parseJson(r.after),
  detail: r.detail,
  by: r.by_whom,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

/** Every platform change, in a table (for the UI and undo) and in the event log. */
export class PlatformChanges {
  private readonly listeners = new Set<(ownerId: string, id: string) => void>();

  constructor(
    private readonly db: SqlClient,
    private readonly store: EventStore,
  ) {}

  onChange(l: (ownerId: string, id: string) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async record(
    ownerId: string,
    c: {
      id?: string;
      kind: "config" | "code";
      change: string;
      stage: ChangeStage;
      target?: string;
      before?: unknown;
      after?: unknown;
      detail?: string;
      by: string;
    },
  ): Promise<PlatformChange> {
    const id = c.id ?? `chg_${randomUUID().slice(0, 12)}`;
    await this.db.query(
      `INSERT INTO rg_platform_changes (id, owner_id, kind, change, stage, target, before, after, detail, by_whom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET stage = EXCLUDED.stage, detail = COALESCE(EXCLUDED.detail, rg_platform_changes.detail),
         after = COALESCE(EXCLUDED.after, rg_platform_changes.after), updated_at = now()`,
      [
        id,
        ownerId,
        c.kind,
        c.change,
        c.stage,
        c.target ?? null,
        c.before === undefined ? null : JSON.stringify(c.before),
        c.after === undefined ? null : JSON.stringify(c.after),
        c.detail ?? null,
        c.by,
      ],
    );
    await this.store.append({
      ownerId,
      body: {
        type: "platform.changed",
        payload: {
          changeId: id,
          kind: c.kind,
          change: c.change,
          stage: c.stage,
          by: c.by,
          ...(c.target !== undefined && { target: c.target }),
          ...(c.before !== undefined && { before: c.before }),
          ...(c.after !== undefined && { after: c.after }),
          ...(c.detail !== undefined && { detail: c.detail }),
        },
      },
    });
    for (const l of this.listeners) l(ownerId, id);
    return (await this.get(ownerId, id)) as PlatformChange;
  }

  async get(ownerId: string, id: string): Promise<PlatformChange | undefined> {
    const [r] = await this.db.query<ChangeRow>(
      "SELECT * FROM rg_platform_changes WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    return r ? toChange(r) : undefined;
  }

  async list(ownerId: string, limit = 100): Promise<PlatformChange[]> {
    const rows = await this.db.query<ChangeRow>(
      "SELECT * FROM rg_platform_changes WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [ownerId, limit],
    );
    return rows.map(toChange);
  }
}

/** What the configuration changes need from the core. */
export interface ConfigHost {
  registry: AgentRegistry;
  budget: PersistentBudget;
  automations: AutomationService;
  policies: PolicyStore;
  changes: PlatformChanges;
  /** Throws when the model does not answer a one-line request. */
  trialModel(ownerId: string, spec: ModelSpec): Promise<void>;
}

type AgentConfig = {
  model?: ModelSpec | null;
  mode?: PermissionMode | null;
  systemPrompt?: string | null;
};
type BudgetTarget = { scope: "global" | "project" | "agent"; id: string };
type BudgetLimit = { usd?: number; tokens?: number };
type AutomationAction =
  | { action: "create"; yaml: string }
  | { action: "update"; id: string; yaml: string }
  | { action: "enable" | "disable" | "delete" | "run"; id: string };

export class ConfigError extends Error {}

/**
 * Configuration changes (G14.1): they take effect at once, keep what they replaced and can
 * be undone. A new model is tried with a real request before it is applied.
 */
export class PlatformConfig {
  constructor(private readonly h: ConfigHost) {}

  async configureAgent(
    ownerId: string,
    by: string,
    agentId: string,
    change: AgentConfig,
  ): Promise<PlatformChange> {
    const agent = this.h.registry.get(agentId);
    if (!agent || agent.ownerId !== ownerId) throw new ConfigError(`Unknown agent "${agentId}"`);
    if (change.model) await this.h.trialModel(ownerId, change.model);
    const pick = (a: AgentRecord): AgentConfig => {
      const out: AgentConfig = {};
      for (const k of Object.keys(change) as (keyof AgentConfig)[])
        Object.assign(out, { [k]: a[k] ?? null });
      return out;
    };
    const before = pick(agent);
    const updated = await this.h.registry.configure({ type: "human", ownerId }, agentId, change);
    const what = Object.keys(change).join(", ");
    return this.h.changes.record(ownerId, {
      kind: "config",
      change: `${agent.name}: ${what}`,
      stage: "promoted",
      target: `agent:${agentId}`,
      before,
      after: pick(updated),
      by,
    });
  }

  async setBudget(
    ownerId: string,
    by: string,
    target: BudgetTarget,
    limit: BudgetLimit,
  ): Promise<PlatformChange> {
    const [current] = (
      await this.h.budget.listFor(
        ownerId,
        target.scope === "project" ? [target.id] : [],
        target.scope === "agent" ? [target.id] : [],
      )
    ).filter((b) => b.scope === target.scope && b.id === target.id);
    await this.h.budget.setLimit(target, limit);
    return this.h.changes.record(ownerId, {
      kind: "config",
      change: `Budget ${target.scope}${target.scope === "global" ? "" : ` ${target.id}`}`,
      stage: "promoted",
      target: `budget:${target.scope}:${target.id}`,
      before: current?.limit ?? {},
      after: limit,
      by,
    });
  }

  async automation(ownerId: string, by: string, a: AutomationAction): Promise<PlatformChange> {
    const autos = this.h.automations;
    if (a.action === "run") {
      const { run, done } = await autos.runNow(ownerId, a.id);
      done.catch(() => {});
      return this.h.changes.record(ownerId, {
        kind: "config",
        change: `Automation run started (${run.id})`,
        stage: "promoted",
        target: `automation:${a.id}`,
        by,
      });
    }
    if (a.action === "create") {
      const { automation } = await autos.create(ownerId, a.yaml);
      return this.h.changes.record(ownerId, {
        kind: "config",
        change: `Automation ${automation.name} created`,
        stage: "promoted",
        target: `automation:${automation.id}`,
        before: null,
        after: { yaml: a.yaml, enabled: true },
        by,
      });
    }
    const old = await autos.get(ownerId, a.id);
    const before = { yaml: old.yaml, enabled: old.enabled };
    let after: { yaml: string; enabled: boolean } | null;
    if (a.action === "update") {
      await autos.update(ownerId, a.id, a.yaml);
      after = { yaml: a.yaml, enabled: old.enabled };
    } else if (a.action === "delete") {
      await autos.remove(ownerId, a.id);
      after = null;
    } else {
      await autos.setEnabled(ownerId, a.id, a.action === "enable");
      after = { yaml: old.yaml, enabled: a.action === "enable" };
    }
    return this.h.changes.record(ownerId, {
      kind: "config",
      change: `Automation ${old.name}: ${a.action}`,
      stage: "promoted",
      target: `automation:${a.id}`,
      before,
      after,
      by,
    });
  }

  async setPolicy(ownerId: string, by: string, policy: PlatformPolicy): Promise<PlatformChange> {
    const before = this.h.policies.get(ownerId);
    await this.h.policies.set(ownerId, policy);
    return this.h.changes.record(ownerId, {
      kind: "config",
      change: "Permission policy",
      stage: "promoted",
      target: "policy",
      before,
      after: this.h.policies.get(ownerId),
      by,
    });
  }

  /** Puts back what a configuration change replaced; recorded as a change of its own. */
  async undo(ownerId: string, by: string, changeId: string): Promise<PlatformChange> {
    const c = await this.h.changes.get(ownerId, changeId);
    if (!c) throw new ConfigError(`Unknown change "${changeId}"`);
    if (c.kind !== "config" || !c.target || c.stage !== "promoted" || c.before === undefined)
      throw new ConfigError("Only applied configuration changes can be undone");
    const [type, ...rest] = c.target.split(":");
    let done: PlatformChange;
    if (type === "agent") {
      done = await this.configureAgent(ownerId, by, rest.join(":"), c.before as AgentConfig);
    } else if (type === "budget") {
      const [scope, id] = rest as [BudgetTarget["scope"], string];
      done = await this.setBudget(ownerId, by, { scope, id }, c.before as BudgetLimit);
    } else if (type === "policy") {
      done = await this.setPolicy(ownerId, by, c.before as PlatformPolicy);
    } else if (type === "automation") {
      const id = rest.join(":");
      const before = c.before as { yaml: string; enabled: boolean } | null;
      const after = c.after as { yaml: string; enabled: boolean } | null;
      if (before === null) done = await this.automation(ownerId, by, { action: "delete", id });
      else if (after === null)
        done = await this.automation(ownerId, by, { action: "create", yaml: before.yaml });
      else if (before.yaml !== after.yaml)
        done = await this.automation(ownerId, by, { action: "update", id, yaml: before.yaml });
      else
        done = await this.automation(ownerId, by, {
          action: before.enabled ? "enable" : "disable",
          id,
        });
    } else {
      throw new ConfigError(`Cannot undo "${c.target}"`);
    }
    await this.h.changes.record(ownerId, {
      id: c.id,
      kind: c.kind,
      change: c.change,
      stage: "undone",
      detail: `Undone by ${done.id}`,
      by,
    });
    return done;
  }
}

const parseModel = (ref: string, effort?: Effort): ModelSpec => {
  const [provider = "", ...rest] = ref.split("/");
  if (!provider || rest.length === 0) throw new ConfigError('model must be "provider/model"');
  return { provider, model: rest.join("/"), ...(effort && { effort }) };
};

const ConfigureInput = z.object({
  agent_id: z.string(),
  model: z.string().nullable().optional(),
  effort: Effort.optional(),
  mode: PermissionMode.optional(),
  system_prompt: z.string().min(1).nullable().optional(),
});

const show = (c: PlatformChange) =>
  `${c.id} ${c.stage}: ${c.change}${c.before !== undefined ? `\nbefore: ${JSON.stringify(c.before)}` : ""}${c.after !== undefined ? `\nafter: ${JSON.stringify(c.after)}` : ""}`;

/** God's tools on the platform's configuration (G14.1). Every modifying one asks the human (RD27). */
export function platformConfigTools(
  self: AgentRecord,
  config: PlatformConfig,
  host: ConfigHost & { status(ownerId: string): Promise<string> },
): Tool[] {
  if (self.kind !== "god") return [];
  const owner = self.ownerId;
  const by = self.id;
  return [
    {
      def: {
        name: "platform_status",
        description:
          "The state of the platform: version, sandbox, agents with their effective models and modes, budgets, automations, permission policy, code changes in progress.",
        inputSchema: { type: "object", properties: {} },
      },
      schema: z.object({}),
      run: () => host.status(owner),
    } as Tool,
    {
      def: {
        name: "platform_changes",
        description:
          "The latest platform changes (configuration and code), newest first, with ids for platform_undo.",
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
      },
      schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
      async run({ limit }) {
        const list = await host.changes.list(owner, limit ?? 20);
        return list.length === 0
          ? "No changes yet."
          : list
              .map((c) => `${c.id}\t${c.kind}\t${c.stage}\t${c.createdAt}\t${c.change}`)
              .join("\n");
      },
    } as Tool,
    {
      def: {
        name: "platform_configure_agent",
        description:
          "Change an agent's model (provider/model, tried with a real request first), effort, permission mode or system prompt. Works on yourself too. null puts back the inherited model or the default prompt.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string" },
            model: { type: ["string", "null"], description: "provider/model, or null to inherit" },
            effort: { type: "string", enum: Effort.options },
            mode: { type: "string", enum: PermissionMode.options },
            system_prompt: { type: ["string", "null"] },
          },
          required: ["agent_id"],
        },
      },
      schema: ConfigureInput,
      async run(i: z.infer<typeof ConfigureInput>) {
        const agent = host.registry.get(i.agent_id);
        const change: AgentConfig = {};
        if (i.model !== undefined)
          change.model = i.model === null ? null : parseModel(i.model, i.effort);
        else if (i.effort) {
          const current = host.registry.effectiveModel(i.agent_id);
          if (!current) throw new ConfigError("No model to set the effort of; give a model too");
          change.model = { ...(agent?.model ?? current), effort: i.effort };
        }
        if (i.mode) change.mode = i.mode;
        if (i.system_prompt !== undefined) change.systemPrompt = i.system_prompt;
        if (Object.keys(change).length === 0) return "Nothing to change.";
        const c = await config.configureAgent(owner, by, i.agent_id, change);
        return `${show(c)}\nIt applies to new sessions.`;
      },
    } as Tool,
    {
      def: {
        name: "platform_set_budget",
        description:
          "Set a spending limit (USD and/or tokens) for everything (global), a project or an agent. Omit both to remove the limit.",
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["global", "project", "agent"] },
            id: { type: "string", description: "project or agent id (not for global)" },
            usd: { type: "number" },
            tokens: { type: "integer" },
          },
          required: ["scope"],
        },
      },
      schema: z.object({
        scope: z.enum(["global", "project", "agent"]),
        id: z.string().optional(),
        usd: z.number().positive().optional(),
        tokens: z.number().int().positive().optional(),
      }),
      async run({ scope, id, usd, tokens }) {
        if (scope !== "global" && !id) throw new ConfigError(`A ${scope} budget needs an id`);
        const c = await config.setBudget(
          owner,
          by,
          { scope, id: scope === "global" ? owner : (id as string) },
          { ...(usd !== undefined && { usd }), ...(tokens !== undefined && { tokens }) },
        );
        return show(c);
      },
    } as Tool,
    {
      def: {
        name: "platform_automation",
        description:
          "Create, update, enable, disable, delete or run an automation. A recipe is YAML: name, on (cron + timezone, or at: a date and time for once, webhook), agent, project, model, effort, instructions, session, timeoutMinutes, missed, notify.when. For a plain reminder use `reminder: <text>` instead of instructions: it is sent as written, with no agent and no cost.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "update", "enable", "disable", "delete", "run"],
            },
            id: { type: "string" },
            yaml: { type: "string" },
          },
          required: ["action"],
        },
      },
      schema: z.object({
        action: z.enum(["create", "update", "enable", "disable", "delete", "run"]),
        id: z.string().optional(),
        yaml: z.string().optional(),
      }),
      async run({ action, id, yaml }) {
        if ((action === "create" || action === "update") && !yaml)
          throw new ConfigError(`${action} needs the recipe's yaml`);
        if (action !== "create" && !id)
          throw new ConfigError(`${action} needs the automation's id`);
        const a = (
          action === "create"
            ? { action, yaml }
            : action === "update"
              ? { action, id, yaml }
              : { action, id }
        ) as AutomationAction;
        return show(await config.automation(owner, by, a));
      },
    } as Tool,
    {
      def: {
        name: "platform_policy",
        description:
          "Replace the permission policy: rules (tool, optional regex match on the input, allow/ask/deny), humanOnly (danger ids only the human may approve) and disabledDanger. Read the current one with platform_status first.",
        inputSchema: {
          type: "object",
          properties: {
            rules: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  match: { type: "string" },
                  decision: { type: "string", enum: ["allow", "ask", "deny"] },
                },
                required: ["tool", "decision"],
              },
            },
            humanOnly: { type: "array", items: { type: "string" } },
            disabledDanger: { type: "array", items: { type: "string" } },
          },
        },
      },
      schema: PlatformPolicy,
      run: async (p: PlatformPolicy) => show(await config.setPolicy(owner, by, p)),
    } as Tool,
    {
      def: {
        name: "platform_undo",
        description:
          "Undo a configuration change by id (see platform_changes): what it replaced comes back.",
        inputSchema: {
          type: "object",
          properties: { change_id: { type: "string" } },
          required: ["change_id"],
        },
      },
      schema: z.object({ change_id: z.string() }),
      run: async ({ change_id }) => show(await config.undo(owner, by, change_id)),
    } as Tool,
  ];
}
