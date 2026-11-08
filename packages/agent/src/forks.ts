import type { EventStore } from "@redgiant/events";
import type { Event } from "@redgiant/protocol";

/** Forks of forks are followed this deep, no further (a loop in the log cannot hang a resume). */
const MAX_DEPTH = 32;

/**
 * Every event of a conversation as its history sees it (G36.23): a conversation that goes on from
 * another one starts with `session.forked`, and its history is the origin's events up to the
 * point, then its own. Event numbers grow across the whole log, so the result stays in order and
 * the origin's compactions keep pointing at the right events.
 */
export async function sessionLog(
  store: Pick<EventStore, "list">,
  sessionId: string,
  depth = 0,
): Promise<Event[]> {
  const own = await store.list({ sessionId });
  const head = own.find((e) => e.type !== "redaction");
  if (head?.type !== "session.forked" || !head.payload || depth >= MAX_DEPTH) return own;
  const through = head.payload.throughSeq;
  const origin = (await sessionLog(store, head.payload.fromSessionId, depth + 1)).filter(
    (e) => e.seq <= through,
  );
  return [...origin, ...own];
}

/**
 * Where a «Continua da qui» from the message at `seq` cuts (G36.23): that message and what belongs
 * to it — its tool calls, their results, the person's words that joined them — up to the next
 * message of the model or of the person, or a summary. The new conversation never starts in the
 * middle of a call.
 */
export function forkPoint(events: readonly Event[], seq: number): number {
  let through = seq;
  for (const e of events) {
    if (e.seq <= seq) continue;
    if (e.type === "message.assistant" || e.type === "compaction") break;
    if (e.type === "message.user" && !(e.payload?.steer === true)) break;
    through = e.seq;
  }
  return through;
}
