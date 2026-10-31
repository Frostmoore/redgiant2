import type { EventStore, SqlClient } from "@redgiant/events";
import type { BudgetBreach, BudgetKey, BudgetLimit, Spend, Usage } from "@redgiant/providers";
import { type AgentNode, ancestors, type Resolve } from "./scopes.js";

/** Budget keys an agent's spend counts against: itself, every ancestor, its project, its owner. */
export function budgetKeys(agent: AgentNode, resolve: Resolve): BudgetKey[] {
  return [
    { scope: "agent", id: agent.id },
    ...ancestors(agent, resolve).map((a) => ({ scope: "agent" as const, id: a.id })),
    ...(agent.projectId ? [{ scope: "project" as const, id: agent.projectId }] : []),
    { scope: "global", id: agent.ownerId },
  ];
}

interface Row {
  scope: BudgetKey["scope"];
  key: string;
  limit_usd: number | null;
  limit_tok: string | number | null;
  spent_usd: number;
  spent_tok: string | number;
}

/** Spend counters and limits stored in Postgres (they survive restarts). */
export class PersistentBudget {
  constructor(
    private readonly db: SqlClient,
    private readonly store: EventStore,
  ) {}

  /** Every counter of an owner: its global key, its projects and its agents. */
  async listFor(
    ownerId: string,
    projectIds: string[],
    agentIds: string[],
  ): Promise<(BudgetKey & { limit: BudgetLimit; used: Spend })[]> {
    const rows = await this.db.query<Row>(
      "SELECT * FROM rg_budgets WHERE (scope = 'global' AND key = $1) OR (scope = 'project' AND key = ANY($2)) OR (scope = 'agent' AND key = ANY($3)) ORDER BY scope, key",
      [ownerId, projectIds, agentIds],
    );
    return rows.map((r) => ({
      scope: r.scope,
      id: r.key,
      limit: {
        ...(r.limit_usd !== null && { usd: r.limit_usd }),
        ...(r.limit_tok !== null && { tokens: Number(r.limit_tok) }),
      },
      used: { usd: r.spent_usd, tokens: Number(r.spent_tok) },
    }));
  }

  async setLimit(key: BudgetKey, limit: BudgetLimit): Promise<void> {
    await this.db.query(
      `INSERT INTO rg_budgets (scope, key, limit_usd, limit_tok) VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope, key) DO UPDATE SET limit_usd = EXCLUDED.limit_usd, limit_tok = EXCLUDED.limit_tok`,
      [key.scope, key.id, limit.usd ?? null, limit.tokens ?? null],
    );
  }

  async used(key: BudgetKey): Promise<Spend> {
    const [r] = await this.db.query<Row>("SELECT * FROM rg_budgets WHERE scope = $1 AND key = $2", [
      key.scope,
      key.id,
    ]);
    return r ? { usd: r.spent_usd, tokens: Number(r.spent_tok) } : { usd: 0, tokens: 0 };
  }

  async check(keys: BudgetKey[]): Promise<BudgetBreach[]> {
    const out: BudgetBreach[] = [];
    for (const key of keys) {
      const [r] = await this.db.query<Row>(
        "SELECT * FROM rg_budgets WHERE scope = $1 AND key = $2",
        [key.scope, key.id],
      );
      if (!r) continue;
      const used = { usd: r.spent_usd, tokens: Number(r.spent_tok) };
      const limit: BudgetLimit = {
        ...(r.limit_usd !== null && { usd: r.limit_usd }),
        ...(r.limit_tok !== null && { tokens: Number(r.limit_tok) }),
      };
      if (
        (limit.usd !== undefined && used.usd >= limit.usd) ||
        (limit.tokens !== undefined && used.tokens >= limit.tokens)
      ) {
        out.push({ key, limit, used });
      }
    }
    return out;
  }

  /**
   * Adds one request's spend to every key; logs `budget.exceeded` for each limit this
   * request crossed (once, not on every later request).
   */
  async record(
    keys: BudgetKey[],
    usage: Usage,
    usd: number,
    at: { ownerId: string; projectId: string | null; agentId: string | null },
  ): Promise<BudgetBreach[]> {
    const before = new Set((await this.check(keys)).map((b) => `${b.key.scope}:${b.key.id}`));
    const tokens = usage.inputTokens + usage.outputTokens;
    for (const key of keys) {
      await this.db.query(
        `INSERT INTO rg_budgets (scope, key, spent_usd, spent_tok) VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, key) DO UPDATE SET spent_usd = rg_budgets.spent_usd + EXCLUDED.spent_usd,
                                                 spent_tok = rg_budgets.spent_tok + EXCLUDED.spent_tok`,
        [key.scope, key.id, usd, tokens],
      );
    }
    const after = await this.check(keys);
    for (const b of after) {
      if (before.has(`${b.key.scope}:${b.key.id}`)) continue;
      const usdLimit = b.limit.usd !== undefined && b.used.usd >= b.limit.usd;
      await this.store.append({
        ...at,
        body: {
          type: "budget.exceeded",
          payload: {
            scope: b.key.scope,
            limit: usdLimit ? (b.limit.usd ?? 0) : (b.limit.tokens ?? 0),
            used: usdLimit ? b.used.usd : b.used.tokens,
          },
        },
      });
    }
    return after;
  }
}
