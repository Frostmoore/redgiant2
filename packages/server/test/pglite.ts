import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { SqlClient } from "@redgiant/events";

/**
 * Real Postgres rejects a parameter the query never uses ("could not determine data type of
 * parameter $n"); PGlite accepts it. Tests reject it too, so it cannot reach production.
 */
function checkParams(text: string, params: unknown[] = []) {
  for (let i = 1; i <= params.length; i++) {
    if (!new RegExp(`\\$${i}(?!\\d)`).test(text))
      throw new Error(`Parameter $${i} is not used by the query: ${text.slice(0, 200)}`);
  }
}

/** In-process Postgres for tests: real SQL, triggers and locks, no server. */
export async function memoryDb(): Promise<{ db: SqlClient; pg: PGlite }> {
  const pg = await PGlite.create();
  const wrap = (q: PGlite | Transaction): SqlClient => ({
    async query<T>(text: string, params?: unknown[]) {
      checkParams(text, params);
      return (await q.query<T>(text, params)).rows;
    },
    transaction: (fn) =>
      "transaction" in q && q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q)),
  });
  return { db: wrap(pg), pg };
}
