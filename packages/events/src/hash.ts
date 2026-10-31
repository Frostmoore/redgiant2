import { canonicalJson, sha256Hex } from "./canonical.js";

export interface HashedFields {
  id: string;
  seq: number;
  ts: string;
  ownerId: string;
  projectId: string | null;
  agentId: string | null;
  sessionId: string | null;
  type: string;
  payloadHash: string;
  prevHash: string | null;
}

export const payloadHashOf = (payloadJson: string) => sha256Hex(payloadJson);

/** Hash of an event: covers the envelope and the payload hash, never the payload itself. */
export function eventHash(f: HashedFields): string {
  return sha256Hex(
    canonicalJson({
      agentId: f.agentId,
      id: f.id,
      ownerId: f.ownerId,
      payloadHash: f.payloadHash,
      prevHash: f.prevHash,
      projectId: f.projectId,
      seq: f.seq,
      sessionId: f.sessionId,
      ts: f.ts,
      type: f.type,
    }),
  );
}
