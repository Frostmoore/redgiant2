import { z } from "zod";
import { Event } from "./events.js";
import { ImagePart } from "./messages.js";
import { Answers, QuestionRequestInfo } from "./questions.js";

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
  z.object({
    type: z.literal("session.send"),
    sessionId: z.string(),
    text: z.string(),
    images: z.array(ImagePart).max(10).optional(),
  }),
  z.object({ type: z.literal("session.interrupt"), sessionId: z.string() }),
  z.object({ type: z.literal("question.answer"), requestId: z.string(), answers: Answers }),
  z.object({
    type: z.literal("permission.resolve"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean().default(false),
  }),
  // The personal agents' browser (G24.14b): its screen, and the person's hands on it.
  z.object({ type: z.literal("browser.watch") }),
  z.object({ type: z.literal("browser.unwatch") }),
  z.object({ type: z.literal("browser.control"), take: z.boolean() }),
  z.object({ type: z.literal("browser.goto"), url: z.string().min(1).max(2000) }),
  z.object({
    type: z.literal("browser.input"),
    event: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("click"),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      }),
      z.object({
        kind: z.literal("scroll"),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        dy: z.number().min(-5000).max(5000),
      }),
      z.object({ kind: z.literal("text"), text: z.string().max(2000) }),
      z.object({ kind: z.literal("key"), key: z.string().min(1).max(40) }),
    ]),
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
  /** A summary of the conversation is being made while the person waits (G24.14). */
  z.object({ type: z.literal("session.compacting"), sessionId: z.string(), busy: z.boolean() }),
  /** A request that waits for the human; answered with `permission.resolve`. */
  z.object({ type: z.literal("permission.request"), request: PermissionRequestInfo }),
  z.object({
    type: z.literal("permission.closed"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
  }),
  /** generate_image at work: steps and blurry-to-sharp previews (base64 PNG), not persisted. */
  z.object({
    type: z.literal("image.progress"),
    sessionId: z.string(),
    percent: z.number(),
    preview: z.string().optional(),
  }),
  /** A question or plan that waits for the human; answered with `question.answer`. */
  z.object({ type: z.literal("question.request"), request: QuestionRequestInfo }),
  z.object({ type: z.literal("question.closed"), requestId: z.string() }),
  /** Something changed on a board (new post, status): clients reload what they show. */
  z.object({
    type: z.literal("board.changed"),
    projectId: z.string().nullable(),
    threadId: z.string(),
  }),
  /** An automation was edited or one of its runs started or ended: clients reload the list. */
  z.object({ type: z.literal("automations.changed"), automationId: z.string() }),
  /** The agents' browser (G24.14b): a frame of its screen (JPEG, base64), and who drives it. */
  z.object({
    type: z.literal("browser.frame"),
    data: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    type: z.literal("browser.state"),
    control: z.enum(["agents", "person"]),
    url: z.string(),
  }),
  /** A group chat changed: a message, a member, someone started or finished answering. */
  z.object({ type: z.literal("room.changed"), roomId: z.string() }),
  /** A platform change was recorded or moved to another stage. */
  z.object({ type: z.literal("platform.changed"), changeId: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
