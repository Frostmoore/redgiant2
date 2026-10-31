import { z } from "zod";
import { Event } from "./events.js";

/** Bumped on every breaking change of the client/server protocol. */
export const PROTOCOL_VERSION = 2;

/** A permission request shown to the human. */
export const PermissionRequestInfo = z.object({
  requestId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  tool: z.string(),
  input: z.unknown(),
  reasons: z.array(z.string()),
  danger: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type PermissionRequestInfo = z.infer<typeof PermissionRequestInfo>;

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocolVersion: z.number().int(), token: z.string() }),
  z.object({ type: z.literal("session.follow"), sessionId: z.string() }),
  z.object({ type: z.literal("session.unfollow"), sessionId: z.string() }),
  z.object({ type: z.literal("session.send"), sessionId: z.string(), text: z.string() }),
  z.object({ type: z.literal("session.interrupt"), sessionId: z.string() }),
  z.object({
    type: z.literal("permission.resolve"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean().default(false),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), protocolVersion: z.number().int(), ownerId: z.string() }),
  /** A persisted event of a followed session (history first, then live). */
  z.object({ type: z.literal("event"), sessionId: z.string(), event: Event }),
  /** Streaming text not yet persisted; the final message arrives as an event. */
  z.object({
    type: z.literal("delta"),
    sessionId: z.string(),
    kind: z.enum(["text", "thinking"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("session.state"),
    sessionId: z.string(),
    state: z.enum(["idle", "running"]),
  }),
  /** Sent after a follow, once the stored history has been replayed. */
  z.object({ type: z.literal("session.synced"), sessionId: z.string(), lastSeq: z.number().int() }),
  /** A request that waits for the human; answered with `permission.resolve`. */
  z.object({ type: z.literal("permission.request"), request: PermissionRequestInfo }),
  z.object({
    type: z.literal("permission.closed"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
  }),
  /** Something changed on a board (new post, status): clients reload what they show. */
  z.object({
    type: z.literal("board.changed"),
    projectId: z.string().nullable(),
    threadId: z.string(),
  }),
  /** An automation was edited or one of its runs started or ended: clients reload the list. */
  z.object({ type: z.literal("automations.changed"), automationId: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
