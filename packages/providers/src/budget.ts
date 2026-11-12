import type { Usage } from "./types.js";

/** `artifact` (3.6, G38.7): the spending cap the person chose for one artifact's `ask`. */
export type BudgetScope = "agent" | "project" | "global" | "artifact";

export interface BudgetLimit {
  /** Maximum spend in USD; omit for no limit. */
  usd?: number | undefined;
  /** Maximum input + output tokens; omit for no limit. */
  tokens?: number | undefined;
}

export interface BudgetKey {
  scope: BudgetScope;
  id: string;
}

export interface Spend {
  usd: number;
  tokens: number;
}

export interface BudgetBreach {
  key: BudgetKey;
  limit: BudgetLimit;
  used: Spend;
}

const keyOf = (k: BudgetKey) => `${k.scope}:${k.id}`;

/** In-memory spend counters with limits per agent, project and globally. */
export class BudgetTracker {
  private readonly limits = new Map<string, BudgetLimit>();
  private readonly spent = new Map<string, Spend>();

  setLimit(key: BudgetKey, limit: BudgetLimit): void {
    this.limits.set(keyOf(key), limit);
  }

  used(key: BudgetKey): Spend {
    return this.spent.get(keyOf(key)) ?? { usd: 0, tokens: 0 };
  }

  /** Breaches that already hold for any of `keys`; check before starting a request. */
  check(keys: BudgetKey[]): BudgetBreach[] {
    return keys.flatMap((key) => {
      const limit = this.limits.get(keyOf(key));
      const used = this.used(key);
      if (!limit) return [];
      const over =
        (limit.usd !== undefined && used.usd >= limit.usd) ||
        (limit.tokens !== undefined && used.tokens >= limit.tokens);
      return over ? [{ key, limit, used }] : [];
    });
  }

  /** Adds one request's spend to every key and returns the breaches it caused or kept. */
  record(keys: BudgetKey[], usage: Usage, usd: number): BudgetBreach[] {
    const tokens = usage.inputTokens + usage.outputTokens;
    for (const key of keys) {
      const prev = this.used(key);
      this.spent.set(keyOf(key), { usd: prev.usd + usd, tokens: prev.tokens + tokens });
    }
    return this.check(keys);
  }
}
