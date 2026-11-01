import { randomUUID } from "node:crypto";
import { type Event, type EventBody, LOCAL_OWNER_ID } from "@redgiant/protocol";
import { canonicalJson } from "./canonical.js";
import { eventHash, payloadHashOf } from "./hash.js";
import type { Redactor } from "./redact.js";
import type { SqlClient } from "./sql.js";
import { type VerifyResult, verifyEvents } from "./verify.js";

export interface AppendInput {
  ownerId?: string;
  projectId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  body: EventBody;
}

export interface EventFilter {
  sessionId?: string;
  projectId?: string;
  /** Only these event types. */
  types?: string[];
  fromSeq?: number;
  limit?: number;
}

interface Row {
  seq: string | number;
  id: string;
  ts: string;
  owner_id: string;
  project_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  type: string;
  payload: string | null;
  payload_hash: string;
  prev_hash: string | null;
  hash: string;
  erased: boolean;
}

/** Arbitrary constant for the advisory lock that serialises appends. */
const APPEND_LOCK = 0x52474c47;

export interface EventStoreOptions {
  redactor?: Redactor;
  now?: () => Date;
  newId?: () => string;
}

/** The append-only, hash-chained event log. Single global chain across all owners. */
export class EventStore {
  private readonly listeners = new Set<(e: Event) => void>();

  constructor(
    private readonly db: SqlClient,
    private readonly options: EventStoreOptions = {},
  ) {}

  /** Called after every committed append (in-process fan-out to live clients). */
  subscribe(listener: (e: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async append(input: AppendInput): Promise<Event> {
    const body = this.options.redactor
      ? this.options.redactor.redact(input.body).value
      : input.body;
    // Round-trip through JSON so the stored text and the hashed text are the same.
    const payload = JSON.parse(JSON.stringify(body.payload)) as unknown;
    const payloadJson = canonicalJson(payload);

    const event = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [APPEND_LOCK]);
      const [head] = await tx.query<{ seq: string | number; hash: string }>(
        "SELECT seq, hash FROM rg_events ORDER BY seq DESC LIMIT 1",
      );
      const fields = {
        id: this.options.newId?.() ?? randomUUID(),
        seq: head ? Number(head.seq) + 1 : 0,
        ts: (this.options.now?.() ?? new Date()).toISOString(),
        ownerId: input.ownerId ?? LOCAL_OWNER_ID,
        projectId: input.projectId ?? null,
        agentId: input.agentId ?? null,
        sessionId: input.sessionId ?? null,
        type: body.type,
        payloadHash: payloadHashOf(payloadJson),
        prevHash: head?.hash ?? null,
      };
      const hash = eventHash(fields);
      await tx.query(
        `INSERT INTO rg_events (seq, id, ts, owner_id, project_id, agent_id, session_id, type, payload, payload_hash, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          fields.seq,
          fields.id,
          fields.ts,
          fields.ownerId,
          fields.projectId,
          fields.agentId,
          fields.sessionId,
          fields.type,
          payloadJson,
          fields.payloadHash,
          fields.prevHash,
          hash,
        ],
      );
      return { ...fields, hash, erased: false, payload } as Event;
    });
    for (const l of this.listeners) l(event);
    return event;
  }

  async list(filter: EventFilter = {}): Promise<Event[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.sessionId !== undefined)
      where.push(`session_id = $${params.push(filter.sessionId)}`);
    if (filter.projectId !== undefined)
      where.push(`project_id = $${params.push(filter.projectId)}`);
    if (filter.fromSeq !== undefined) where.push(`seq >= $${params.push(filter.fromSeq)}`);
    if (filter.types !== undefined) where.push(`type = ANY($${params.push(filter.types)})`);
    const limit = filter.limit !== undefined ? ` LIMIT $${params.push(filter.limit)}` : "";
    const rows = await this.db.query<Row>(
      `SELECT * FROM rg_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq${limit}`,
      params,
    );
    return rows.map(fromRow);
  }

  /** Verifies the whole chain (or a filtered slice of it). */
  async verify(filter: EventFilter = {}): Promise<VerifyResult> {
    return verifyEvents(await this.list(filter));
  }

  /**
   * Erases the payload of one event (e.g. a data-protection request) and records the
   * erasure. The chain stays verifiable because hashes cover the payload hash only.
   */
  async erase(seq: number, reason: string, by: { ownerId?: string } = {}): Promise<Event> {
    const [row] = await this.db.query<Row>("SELECT * FROM rg_events WHERE seq = $1", [seq]);
    if (!row) throw new Error(`No event with seq ${seq}`);
    await this.db.query("UPDATE rg_events SET payload = NULL, erased = true WHERE seq = $1", [seq]);
    return this.append({
      ownerId: by.ownerId ?? row.owner_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      body: { type: "redaction", payload: { targetSeq: seq, reason } },
    });
  }

  /**
   * Retention: erases the payloads of every event older than `before` (the chain stays
   * verifiable) and records it with one `redaction` event. Returns how many were erased.
   */
  async eraseBefore(before: Date, reason: string, ownerId = "local"): Promise<number> {
    const rows = await this.db.query<{ seq: string | number }>(
      "UPDATE rg_events SET payload = NULL, erased = true WHERE ts < $1 AND NOT erased AND type <> 'redaction' RETURNING seq",
      [before.toISOString()],
    );
    if (rows.length === 0) return 0;
    const last = Math.max(...rows.map((r) => Number(r.seq)));
    await this.append({
      ownerId,
      body: {
        type: "redaction",
        payload: { targetSeq: last, reason: `${reason} (${rows.length} events)` },
      },
    });
    return rows.length;
  }

  /** JSON Lines export, verifiable offline with `verifyEvents`. */
  async *exportJsonl(filter: EventFilter = {}): AsyncGenerator<string> {
    for (const e of await this.list(filter)) yield `${JSON.stringify(e)}\n`;
  }
}

function fromRow(r: Row): Event {
  return {
    seq: Number(r.seq),
    id: r.id,
    ts: r.ts,
    ownerId: r.owner_id,
    projectId: r.project_id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    type: r.type,
    payload: r.payload === null ? null : JSON.parse(r.payload),
    payloadHash: r.payload_hash,
    prevHash: r.prev_hash,
    hash: r.hash,
    erased: r.erased,
  } as Event;
}
