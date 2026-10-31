import type { Pool, PoolClient } from "pg";

/** Minimal SQL access used by the event store; implemented for `pg` here and PGlite in tests. */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

const fromPoolClient = (c: PoolClient): SqlClient => ({
  async query<T>(text: string, params?: unknown[]) {
    return (await c.query(text, params)).rows as T[];
  },
  transaction: (fn) => fn(fromPoolClient(c)),
});

/** Wraps a `pg` connection pool. */
export function pgPoolClient(pool: Pool): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rows as T[];
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn(fromPoolClient(c));
        await c.query("COMMIT");
        return result;
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
    },
  };
}
