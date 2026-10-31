import type { Event } from "@redgiant/protocol";
import { canonicalJson } from "./canonical.js";
import { eventHash, payloadHashOf } from "./hash.js";

export type VerifyResult =
  | { ok: true; checked: number }
  | { ok: false; seq: number; reason: string };

/**
 * Checks payload hashes, event hashes and links. Works on any ordered slice of the log,
 * including an exported file; links are checked between consecutive sequence numbers.
 */
export function verifyEvents(events: Iterable<Event>): VerifyResult {
  let prev: Event | undefined;
  let checked = 0;
  for (const e of events) {
    if (
      !e.erased &&
      e.payload !== null &&
      payloadHashOf(canonicalJson(e.payload)) !== e.payloadHash
    ) {
      return { ok: false, seq: e.seq, reason: "payload does not match its hash" };
    }
    if (e.erased && e.payload !== null) {
      return { ok: false, seq: e.seq, reason: "erased event still has a payload" };
    }
    if (eventHash(e) !== e.hash) return { ok: false, seq: e.seq, reason: "event hash mismatch" };
    if (prev && e.seq === prev.seq + 1 && e.prevHash !== prev.hash) {
      return { ok: false, seq: e.seq, reason: "broken link to the previous event" };
    }
    if (prev && e.seq <= prev.seq)
      return { ok: false, seq: e.seq, reason: "sequence out of order" };
    if (e.seq === 0 && e.prevHash !== null)
      return { ok: false, seq: 0, reason: "first event has a previous hash" };
    prev = e;
    checked++;
  }
  return { ok: true, checked };
}
