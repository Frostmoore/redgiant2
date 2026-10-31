import { z } from "zod";
import { Event } from "./events.js";

/** Bumped on every breaking change of the client/server protocol. */
export const PROTOCOL_VERSION = 1;

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
  z.object({ type: z.literal("welcome"), protocolVersion: z.number().int() }),
  z.object({ type: z.literal("event"), sessionId: z.string(), event: Event }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
