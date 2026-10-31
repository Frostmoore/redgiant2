import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { SqlClient } from "@redgiant/events";

/** In-process Postgres for tests: real SQL, triggers and locks, no server. */
export async function memoryDb(): Promise<{ db: SqlClient; pg: PGlite }> {
  const pg = await PGlite.create();
  const wrap = (q: PGlite | Transaction): SqlClient => ({
    async query<T>(text: string, params?: unknown[]) {
      return (await q.query<T>(text, params)).rows;
    },
    transaction: (fn) =>
      "transaction" in q && q instanceof PGlite ? q.transaction((tx) => fn(wrap(tx))) : fn(wrap(q)),
  });
  return { db: wrap(pg), pg };
}
