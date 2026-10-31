import type { SqlClient } from "./sql.js";

/**
 * Creates the event table. The trigger makes the log append-only at the database level:
 * DELETE is refused, and UPDATE is allowed only to erase a payload (payload -> NULL,
 * erased -> true) with every other column unchanged.
 */
export async function migrate(db: SqlClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rg_events (
      seq          bigint PRIMARY KEY,
      id           text NOT NULL UNIQUE,
      ts           text NOT NULL,
      owner_id     text NOT NULL,
      project_id   text,
      agent_id     text,
      session_id   text,
      type         text NOT NULL,
      payload      text,
      payload_hash text NOT NULL,
      prev_hash    text,
      hash         text NOT NULL,
      erased       boolean NOT NULL DEFAULT false
    )`);
  await db.query("CREATE INDEX IF NOT EXISTS rg_events_session ON rg_events (session_id, seq)");
  await db.query("CREATE INDEX IF NOT EXISTS rg_events_project ON rg_events (project_id, seq)");
  await db.query(`
    CREATE OR REPLACE FUNCTION rg_events_guard() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'rg_events is append-only: DELETE refused';
      END IF;
      IF NEW.payload IS NOT NULL OR NEW.erased IS NOT TRUE
         OR (NEW.seq, NEW.id, NEW.ts, NEW.owner_id, NEW.project_id, NEW.agent_id, NEW.session_id,
             NEW.type, NEW.payload_hash, NEW.prev_hash, NEW.hash)
            IS DISTINCT FROM
            (OLD.seq, OLD.id, OLD.ts, OLD.owner_id, OLD.project_id, OLD.agent_id, OLD.session_id,
             OLD.type, OLD.payload_hash, OLD.prev_hash, OLD.hash) THEN
        RAISE EXCEPTION 'rg_events is append-only: only erasing a payload is allowed';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  await db.query("DROP TRIGGER IF EXISTS rg_events_guard ON rg_events");
  await db.query(
    "CREATE TRIGGER rg_events_guard BEFORE UPDATE OR DELETE ON rg_events FOR EACH ROW EXECUTE FUNCTION rg_events_guard()",
  );
}
