import { z } from "zod";
import { CanvasState } from "./canvas.js";
import { MAX_QUOTES, MessageQuote } from "./chat-tools.js";
import {
  AgentEditMode,
  DocChange,
  DocFamilyId,
  DocFile,
  DocOp,
  DocPresence,
  DocProposal,
  DocSnapshot,
} from "./doc.js";
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
  /** The conversation that asked, when there is one (allow for this conversation). */
  sessionId: z.string().optional(),
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
    /** The page's own id for it: a message still waiting can be taken back (2026-11-05). */
    clientId: z.string().max(80).optional(),
    /** Passages of earlier messages it answers (G36.22). */
    quotes: z.array(MessageQuote).max(MAX_QUOTES).optional(),
  }),
  z.object({ type: z.literal("session.interrupt"), sessionId: z.string() }),
  /** Background commands (p3.3.1): stop one (no confirmation), or take a finished one off the strip. */
  z.object({ type: z.literal("command.stop"), sessionId: z.string(), id: z.string() }),
  z.object({ type: z.literal("command.close"), sessionId: z.string(), id: z.string() }),
  /** Closes a finished sub-agent's tab in a conversation (p3.3.1): recorded, for every device. */
  z.object({
    type: z.literal("subagent.close"),
    sessionId: z.string(),
    childSessionId: z.string(),
  }),
  /** Takes back a message still waiting for the agent (sent while it worked). */
  z.object({ type: z.literal("session.unqueue"), sessionId: z.string(), clientId: z.string() }),
  z.object({ type: z.literal("question.answer"), requestId: z.string(), answers: Answers }),
  z.object({
    type: z.literal("permission.resolve"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]),
    remember: z.boolean().default(false),
    /** 2026-11-05: allow for this conversation only; "always" is the same as remember. */
    scope: z.enum(["once", "session", "always"]).optional(),
    /** Denied with words the agent reads ("not that file, the other one"). */
    reason: z.string().max(1000).optional(),
  }),
  /** The canvas as the page shows it (G36.12), answering a `canvas.query`. */
  z.object({ type: z.literal("canvas.state"), requestId: z.string().max(80), state: CanvasState }),
  // The personal agents' browser (G24.14b): its screen, and the person's hands on it.
  z.object({ type: z.literal("browser.watch") }),
  z.object({ type: z.literal("browser.unwatch") }),
  z.object({ type: z.literal("browser.control"), take: z.boolean() }),
  z.object({ type: z.literal("browser.goto"), url: z.string().min(1).max(2000) }),
  /** "Teach a task": start showing it to an agent, or stop and let it write the skill. */
  z.object({
    type: z.literal("browser.teach"),
    agentId: z.string(),
    start: z.boolean(),
    title: z.string().max(200).optional(),
  }),
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
  // The editor (G37.1): the page opens a file, sends the person's operations, takes back an
  // agent's change or a whole turn, says where the person is typing, answers a proposal.
  z.object({ type: z.literal("doc.open"), file: DocFile }),
  z.object({ type: z.literal("doc.close"), file: DocFile }),
  /** Ctrl+S (p3.5.1): the file is written now, not after the pause; `doc.saved` answers. */
  z.object({ type: z.literal("doc.save"), file: DocFile }),
  z.object({
    type: z.literal("doc.ops"),
    file: DocFile,
    /** The page's id for this batch: the answer (`doc.ack` or `doc.rejected`) carries it. */
    clientId: z.string().min(1).max(80),
    baseRevision: z.number().int().nonnegative(),
    ops: z.array(DocOp).min(1).max(1000),
    /** The person's gesture (a pause starts another). */
    groupId: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("doc.undo"),
    file: DocFile,
    clientId: z.string().min(1).max(80),
    /** «Annulla questa modifica»: one revision; with `toBefore`, back to before it (and all after). */
    revision: z.number().int().positive().optional(),
    toBefore: z.boolean().optional(),
    /** «Annulla tutto il turno». */
    groupId: z.string().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("doc.presence"),
    file: DocFile,
    editing: z.boolean(),
    /** The person's cursor or selection, in the document at `revision`. */
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    revision: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("doc.decide"),
    file: DocFile,
    clientId: z.string().min(1).max(80),
    proposalId: z.string().min(1).max(80),
    accept: z.boolean(),
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
  /**
   * The engine reading the prompt before it writes (local engines report it, 2026-11-03):
   * tokens in all, found in the cache, processed so far (cache included), milliseconds.
   */
  z.object({
    type: z.literal("prefill"),
    sessionId: z.string(),
    total: z.number(),
    cached: z.number(),
    processed: z.number(),
    ms: z.number(),
  }),
  z.object({
    type: z.literal("session.state"),
    sessionId: z.string(),
    state: z.enum(["idle", "running"]),
    /**
     * With "idle" after a turn (G36.15): why it stopped. "end_turn", "max_turns" (out of
     * steps), "budget", "max_tokens", "refusal", "aborted" (stopped), "error" (it failed).
     */
    stopReason: z.string().optional(),
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
    /** Where it was decided: "web", a chat platform, "timeout" (G36.17). */
    via: z.string().optional(),
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
  z.object({
    type: z.literal("question.closed"),
    requestId: z.string(),
    /** Where it was answered: "web", a chat platform, "timeout" (G36.17). */
    via: z.string().optional(),
  }),
  /** Something changed on a board (new post, status): clients reload what they show. */
  z.object({
    type: z.literal("board.changed"),
    projectId: z.string().nullable(),
    threadId: z.string(),
  }),
  /** An automation was edited or one of its runs started or ended: clients reload the list. */
  z.object({ type: z.literal("automations.changed"), automationId: z.string() }),
  /** An automation's message for the web page (`notify.to: [web]`). */
  z.object({
    type: z.literal("automation.notice"),
    automationId: z.string(),
    runId: z.string(),
    name: z.string(),
    status: z.string(),
    sessionId: z.string().nullable(),
    text: z.string(),
  }),
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
    /** The agent being taught a task, while the person shows it. */
    teaching: z.string().optional(),
  }),
  /** A group chat changed: a message, a member, someone started or finished answering. */
  z.object({ type: z.literal("room.changed"), roomId: z.string() }),
  /** A platform change was recorded or moved to another stage. */
  z.object({ type: z.literal("platform.changed"), changeId: z.string() }),
  /** An agent asks what the person's canvas shows (G36.12): the page answers `canvas.state`. */
  z.object({ type: z.literal("canvas.query"), requestId: z.string() }),
  // The editor (G37.1). Every message about one file reaches a page in the order the host applied
  // the revisions: `doc.changed` for others' revisions, `doc.ack` for the page's own.
  z.object({
    type: z.literal("doc.opened"),
    file: DocFile,
    family: DocFamilyId,
    revision: z.number().int().nonnegative(),
    snapshot: DocSnapshot,
    /** The panel «Modifiche»: the latest first. */
    changes: z.array(DocChange).max(500),
    proposals: z.array(DocProposal).max(200),
    presence: z.array(DocPresence).max(50),
    /** The rule for the agents' edits on this file, and whether it is the file's own choice. */
    mode: AgentEditMode,
    modeOwn: z.boolean(),
  }),
  z.object({
    type: z.literal("doc.changed"),
    file: DocFile,
    revision: z.number().int().positive(),
    ops: z.array(DocOp).min(1).max(1000),
    change: DocChange,
  }),
  z.object({
    type: z.literal("doc.ack"),
    file: DocFile,
    clientId: z.string(),
    revision: z.number().int().nonnegative(),
    /** The revision made (the panel «Modifiche» lists it; the page already has its text). */
    change: DocChange.optional(),
  }),
  z.object({
    type: z.literal("doc.rejected"),
    file: DocFile,
    clientId: z.string(),
    /** conflict (the same place changed meanwhile), busy (the person is typing there), stale,
     *  invalid, replaced (the file changed from outside), gone. */
    code: z.string().max(40),
    reason: z.string().max(2000),
    revision: z.number().int().nonnegative(),
    /** The later revision that touched the same place. */
    conflict: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("doc.replaced"),
    file: DocFile,
    revision: z.number().int().positive(),
    snapshot: DocSnapshot,
    change: DocChange,
  }),
  z.object({ type: z.literal("doc.presence"), file: DocFile, presence: z.array(DocPresence) }),
  z.object({
    type: z.literal("doc.proposals"),
    file: DocFile,
    proposals: z.array(DocProposal).max(200),
  }),
  z.object({
    type: z.literal("doc.mode"),
    file: DocFile,
    mode: AgentEditMode,
    modeOwn: z.boolean(),
  }),
  /**
   * The file was written up to a revision, or could not be (G37.3: a sheet's save needs
   * LibreOffice; the changes stay in the log and the save is tried again). Every family says it
   * (p3.5.1: the editor's «Salvato»).
   */
  z.object({
    type: z.literal("doc.saved"),
    file: DocFile,
    revision: z.number().int().nonnegative(),
    error: z.string().max(2000).optional(),
    /** A program the save waits for (it is coming down: the person sees its bar). */
    waitsFor: z.string().max(40).optional(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
