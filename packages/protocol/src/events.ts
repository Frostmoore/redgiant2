import { z } from "zod";
import { AgentSpec } from "./agents.js";
import { AutomationRunStatus, AutomationTrigger } from "./automations.js";
import { CanvasDo, CanvasTargetSchema } from "./canvas.js";
import { MAX_NOTES, MAX_QUOTES, MessageQuote } from "./chat-tools.js";
import { DocDecidedPayload, DocOpsPayload, DocProposedPayload, DocReplacedPayload } from "./doc.js";
import { AssistantPart, ImagePart, NativeContent, StopReason } from "./messages.js";
import { MessageMetrics } from "./metrics.js";
import { Answers, Question } from "./questions.js";

/** Hex-encoded SHA-256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Owner used while RedGiant runs single-user; every record still carries an owner id. */
export const LOCAL_OWNER_ID = "local";

const text = z.object({ text: z.string() });

/** Typed payloads, discriminated by `type`. */
export const EventBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    payload: z.object({
      sessionId: z.string(),
      system: z.string(),
      tools: z.array(z.string()),
      /** Tools the person had switched off when it started (G34.5): resuming keeps them off. */
      toolsOff: z.array(z.string()).optional(),
    }),
  }),
  /**
   * Tools switched back on in a running conversation (G36.15): the agent asked with request_tool and
   * the person said yes. The one exception to a fixed tool set: the prefix is rebuilt once, here,
   * like a compaction; resuming the conversation gives it the same tools.
   */
  z.object({
    type: z.literal("session.tools_added"),
    payload: z.object({
      tools: z.array(z.string()),
      /** The catalog entry the person switched on. */
      entry: z.string(),
      why: z.string(),
      /** "session": this conversation only; "agent": from now on for this agent too. */
      scope: z.enum(["session", "agent"]),
    }),
  }),
  /** A flat-subscription engine's own conversation id (G21): resuming continues it. */
  z.object({
    type: z.literal("engine.session"),
    payload: z.object({ engine: z.string(), id: z.string() }),
  }),
  z.object({
    type: z.literal("session.ended"),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({
    type: z.literal("hook.blocked"),
    payload: z.object({ hook: z.string(), callId: z.string().optional(), reason: z.string() }),
  }),
  z.object({
    type: z.literal("message.user"),
    payload: z.object({
      text: z.string(),
      images: z.array(ImagePart).optional(),
      /** Who wrote it when not the user: an agent's id, "automation:<name>", "telegram"… */
      from: z.string().optional(),
      /**
       * Sent while the agent worked (2026-11-05, as in Officina and Claude Code): it joins the
       * turn after the tool results, in the same message the model reads next.
       */
      steer: z.boolean().optional(),
      /**
       * Passages of earlier messages it answers (G36.22): the model reads them as a block before
       * the text (`quotedText`); the history before it never changes.
       */
      quotes: z.array(MessageQuote).max(MAX_QUOTES).optional(),
      /**
       * Lines from RedGiant the model reads after the text (G37.1: «the person changed notes.txt
       * while you were away»); the page shows them apart from the person's words.
       */
      notes: z.array(z.string().max(2000)).max(MAX_NOTES).optional(),
    }),
  }),
  z.object({ type: z.literal("message.assistant.delta"), payload: text }),
  z.object({
    type: z.literal("message.assistant"),
    payload: z.object({
      parts: z.array(AssistantPart),
      native: NativeContent.optional(),
      stopReason: StopReason,
      /** Why the provider refused (safety classifiers), when it says. */
      stopDetails: z
        .object({ category: z.string().nullable(), explanation: z.string().nullable() })
        .optional(),
      provider: z.string(),
      model: z.string(),
      metrics: MessageMetrics,
      costUsd: z.number().nonnegative(),
      /** A model the catalog does not know (3.5.4): `costUsd` is 0 because the price is unknown. */
      costUnknown: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool.call"),
    payload: z.object({ callId: z.string(), tool: z.string(), input: z.unknown() }),
  }),
  z.object({
    type: z.literal("tool.result"),
    payload: z.object({
      callId: z.string(),
      ok: z.boolean(),
      output: z.string(),
      /** Pictures the tool returned (a screenshot), for models that see (G24.14c). */
      images: z.array(ImagePart).optional(),
      /**
       * The output ends with RedGiant's reminder of the agent's open list of steps (3.5.6): already
       * in `output`, marked so a resumed session counts the next calls from the same point.
       */
      reminder: z.enum(["todos"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("permission.requested"),
    payload: z.object({
      requestId: z.string(),
      callId: z.string(),
      reason: z.string(),
      askedTo: z.string(),
    }),
  }),
  z.object({
    type: z.literal("permission.resolved"),
    payload: z.object({
      requestId: z.string(),
      decision: z.enum(["allow", "deny", "escalate"]),
      by: z.string(),
      /**
       * Where the person answered (p3.5.4): "web", a chat platform ("telegram", "whatsapp"…),
       * "timeout". Absent in older logs and when an agent or the classifier decided.
       */
      via: z.string().optional(),
    }),
  }),
  /**
   * A request decided without the person (G36.17): by their classifier, or because the time ran
   * out. "blocked" and `review` only in older logs (special requests now reach the person).
   */
  z.object({
    type: z.literal("request.unattended"),
    payload: z.object({
      decisionId: z.string(),
      requestId: z.string(),
      kind: z.string(),
      what: z.string(),
      decision: z.enum(["allow", "deny", "answered", "blocked"]),
      by: z.enum(["classifier", "timeout"]),
      reason: z.string(),
      model: z.string().optional(),
      review: z.boolean().optional(),
    }),
  }),
  /** An agent asked the human (ask_user) or proposed a plan (propose_plan). */
  z.object({
    type: z.literal("question.asked"),
    payload: z.object({
      requestId: z.string(),
      questions: z.array(Question),
      plan: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("question.answered"),
    payload: z.object({
      requestId: z.string(),
      /** null: nobody answered (the turn was interrupted). */
      answers: Answers.nullable(),
      by: z.string(),
      /** Where the person answered (p3.5.4), like `permission.resolved`; absent in older logs. */
      via: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("compaction"),
    payload: z.object({
      summary: z.string(),
      fromSeq: z.number().int(),
      toSeq: z.number().int(),
      /** G24.14: why (ahead of time, by the person, or because the window was full). */
      reason: z.enum(["auto", "manual", "emergency"]).optional(),
      /** The kept turns lost their reasoning (it belonged to the summarised conversation). */
      stripped: z.boolean().optional(),
    }),
  }),
  /** A subscription's engine summarised its own conversation (RedGiant's history is untouched). */
  z.object({
    type: z.literal("engine.compacted"),
    payload: z.object({
      engine: z.string(),
      trigger: z.string(),
      preTokens: z.number().optional(),
    }),
  }),
  /**
   * A call that should have been read from the cache was not (G24.14): what it reused against
   * what the previous call had computed.
   */
  z.object({
    type: z.literal("cache.missed"),
    payload: z.object({ expected: z.number(), cached: z.number(), provider: z.string() }),
  }),
  /**
   * Something an agent made, shown in the canvas (G25.1): a file or folder of a workspace, or a
   * program serving on a port of the agent's container. Not part of the model's history.
   */
  /**
   * A sub-agent at work for this conversation (p3.3.1, as Officina shows them: a tab per
   * sub-agent): run_subagent(s), delegate, ask_assistant. Written in the PARENT session; the
   * sub-agent's own conversation is `childSessionId`, its part of it the events after this one.
   */
  z.object({
    type: z.literal("subagent.started"),
    payload: z.object({
      childSessionId: z.string(),
      childAgentId: z.string(),
      /** The tool call that started it. */
      callId: z.string().optional(),
      via: z.string(),
      title: z.string(),
      /** The task it was given (cut at 20,000 characters). */
      task: z.string(),
    }),
  }),
  z.object({
    type: z.literal("subagent.ended"),
    payload: z.object({
      childSessionId: z.string(),
      status: z.enum(["done", "failed", "stopped"]),
      summary: z.string().optional(),
    }),
  }),
  /**
   * A background command (p3.3.1): started by bash with background, in the conversation that
   * started it. `file` is its log on the server (every line with its time and stream).
   */
  z.object({
    type: z.literal("command.started"),
    payload: z.object({
      id: z.string(),
      command: z.string(),
      file: z.string(),
      path: z.string(),
      cwd: z.string(),
      by: z.string(),
      callId: z.string().optional(),
      pid: z.number().int().optional(),
    }),
  }),
  z.object({
    type: z.literal("command.ended"),
    payload: z.object({
      id: z.string(),
      status: z.enum(["done", "failed", "stopped", "interrupted"]),
      exitCode: z.number().int().nullable(),
    }),
  }),
  /** Taken off the strip by the person: stays off on every device and after a restart. */
  z.object({
    type: z.literal("command.closed"),
    payload: z.object({ id: z.string() }),
  }),
  /** The person closed its tab: closed stays closed (reloads, other devices, restarts). */
  z.object({
    type: z.literal("subagent.closed"),
    payload: z.object({ childSessionId: z.string() }),
  }),
  z.object({
    type: z.literal("canvas.show"),
    payload: z.object({
      title: z.string(),
      target: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("file"),
          scope: z.string(),
          path: z.string(),
          /** Where to open it (G36.4, a citation): a PDF's page, a text's line. */
          at: z
            .object({
              page: z.number().int().positive().optional(),
              line: z.number().int().positive().optional(),
            })
            .optional(),
        }),
        z.object({
          kind: z.literal("port"),
          agentId: z.string(),
          port: z.number().int(),
          path: z.string().optional(),
        }),
      ]),
    }),
  }),
  /**
   * An agent moved the person's canvas (G36.12): opened a tab, went to a page, a line or a time,
   * selected, zoomed, played or paused. The page follows it live; nothing is edited.
   */
  z.object({
    type: z.literal("canvas.act"),
    payload: z.object({ title: z.string(), target: CanvasTargetSchema, do: CanvasDo }),
  }),
  /**
   * The editor (G37.1): one revision of a file, by the person or an agent, in the file's own
   * stream (`docStreamId`). Applied in order, the stream rebuilds the file from its last snapshot.
   */
  z.object({ type: z.literal("doc.ops"), payload: DocOpsPayload }),
  /** The file changed on disk from outside the editor: the host starts again from it (G37.1). */
  z.object({ type: z.literal("doc.replaced"), payload: DocReplacedPayload }),
  /** An agent's edit kept as a proposal for the person (G37.1, the rule «come proposte»). */
  z.object({ type: z.literal("doc.proposed"), payload: DocProposedPayload }),
  z.object({ type: z.literal("doc.decided"), payload: DocDecidedPayload }),
  /**
   * A board ("tavola", G25.4, as in Officina): 1 to 8 HTML pages side by side for the person to
   * choose from or comment on. The pages are copied when it is published; what the person says
   * goes back to the agent as a message.
   */
  z.object({
    type: z.literal("variants.proposed"),
    payload: z.object({
      proposalId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      variants: z.array(
        z.object({ title: z.string(), note: z.string().optional(), bytes: z.number().int() }),
      ),
    }),
  }),
  /** The person chose a variant (1-based) or commented on one, or on the whole board (null). */
  z.object({
    type: z.literal("variants.answered"),
    payload: z.object({
      proposalId: z.string(),
      variant: z.number().int().nullable(),
      choice: z.boolean(),
      comment: z.string().optional(),
    }),
  }),
  /**
   * A tool called by a program the agent ran (run_script, 2026-11-05): in the log and the page,
   * never in the model's history (the program's output is what the model read).
   */
  z.object({
    type: z.literal("script.call"),
    payload: z.object({
      name: z.string(),
      input: z.unknown(),
      ok: z.boolean(),
      output: z.string(),
    }),
  }),
  /** A file an agent sent to the person (G25.2): shown in the chat, and on Telegram there. */
  z.object({
    type: z.literal("file.sent"),
    payload: z.object({
      scope: z.string(),
      path: z.string(),
      name: z.string(),
      size: z.number().int(),
      mime: z.string(),
      caption: z.string().optional(),
    }),
  }),
  /** A compaction undone by the person: the whole history comes back (nothing was deleted). */
  z.object({
    type: z.literal("compaction.undone"),
    payload: z.object({ compactionSeq: z.number().int() }),
  }),
  z.object({ type: z.literal("agent.spawned"), payload: z.object({ agent: AgentSpec }) }),
  z.object({
    type: z.literal("agent.stopped"),
    payload: z.object({ agentId: z.string(), reason: z.string() }),
  }),
  /**
   * A whole project archived (2026-11-09): nothing is deleted. The turns it interrupted, the
   * automations it paused (they come back as they were) and whether its sandbox was stopped.
   */
  z.object({
    type: z.literal("project.archived"),
    payload: z.object({
      projectId: z.string(),
      by: z.string(),
      interrupted: z.array(z.string()),
      paused: z.array(z.string()),
      sandboxes: z.array(z.string()),
    }),
  }),
  /** An archived project back as it was: the automations it had paused run again. */
  z.object({
    type: z.literal("project.restored"),
    payload: z.object({ projectId: z.string(), by: z.string(), resumed: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal("task.opened"),
    payload: z.object({
      taskId: z.string(),
      title: z.string(),
      /** Handed to the backup model after this task was given up on (2026-11-05). */
      escalatedFrom: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("task.verified"),
    payload: z.object({ taskId: z.string(), verifier: z.string(), passed: z.boolean() }),
  }),
  z.object({
    type: z.literal("task.closed"),
    payload: z.discriminatedUnion("outcome", [
      z.object({ taskId: z.string(), outcome: z.literal("verified") }),
      // A task may close without a verifier only by stating why it is not testable.
      z.object({
        taskId: z.string(),
        outcome: z.literal("not_testable"),
        justification: z.string().min(1),
      }),
      z.object({ taskId: z.string(), outcome: z.literal("abandoned"), reason: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal("board.post"),
    payload: z.object({
      threadId: z.string(),
      postId: z.string(),
      kind: z.enum(["task", "result", "question", "decision", "blocker", "note"]),
      author: z.string(),
      body: z.string(),
    }),
  }),
  z.object({
    type: z.literal("board.status"),
    payload: z.object({
      threadId: z.string(),
      status: z.enum(["open", "resolved", "blocked"]),
      by: z.string(),
    }),
  }),
  z.object({
    type: z.literal("budget.exceeded"),
    payload: z.object({
      scope: z.enum(["agent", "project", "global"]),
      limit: z.number(),
      used: z.number(),
    }),
  }),
  /**
   * God (or the supervisor) changed the platform (RD9): configuration takes effect at once and
   * keeps what it replaced; code goes through proposed → tested → promoted, or rolls back.
   */
  z.object({
    type: z.literal("platform.changed"),
    payload: z.object({
      changeId: z.string(),
      kind: z.enum(["config", "code"]),
      /** One line for people: what changed. */
      change: z.string(),
      stage: z.enum([
        "proposed",
        "tested",
        "failed",
        "promoted",
        "rolled_back",
        "discarded",
        "undone",
      ]),
      target: z.string().optional(),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
      detail: z.string().optional(),
      by: z.string(),
    }),
  }),
  /** A change made by the human through the file explorer (agents' changes are tool calls). */
  z.object({
    type: z.literal("workspace.changed"),
    payload: z.object({
      scope: z.string(),
      action: z.enum(["write", "mkdir", "rename", "delete"]),
      path: z.string(),
      to: z.string().optional(),
      by: z.string(),
    }),
  }),
  z.object({
    type: z.literal("terminal.opened"),
    payload: z.object({ terminalId: z.string(), scope: z.string(), by: z.string() }),
  }),
  z.object({
    type: z.literal("terminal.closed"),
    payload: z.object({ terminalId: z.string(), exitCode: z.number().int().nullable() }),
  }),
  z.object({
    type: z.literal("extension.proposed"),
    payload: z.object({
      proposalId: z.string(),
      kind: z.enum(["tool", "skill"]),
      name: z.string(),
      author: z.string(),
      status: z.enum(["failed", "pending", "installed"]),
    }),
  }),
  z.object({
    type: z.literal("extension.decided"),
    payload: z.object({
      proposalId: z.string(),
      decision: z.enum(["approve", "reject"]),
      by: z.string(),
    }),
  }),
  /** An automation started (status `running`) or ended; `skipped` when the previous run was still going. */
  z.object({
    type: z.literal("automation.run"),
    payload: z.object({
      automationId: z.string(),
      name: z.string(),
      runId: z.string(),
      trigger: AutomationTrigger,
      status: AutomationRunStatus,
    }),
  }),
  // Group chats (G24.12): the room's own log, under the room's id as its session.
  z.object({
    type: z.literal("room.message"),
    payload: z.object({
      /** "human", an agent's id, "system" (the room's own notes) or "context" (an earlier chat). */
      from: z.string(),
      name: z.string(),
      text: z.string(),
      /** Pictures the person attached (G24.14c). */
      images: z.array(ImagePart).optional(),
    }),
  }),
  z.object({
    type: z.literal("room.member"),
    payload: z.object({
      agentId: z.string(),
      name: z.string(),
      change: z.enum(["added", "removed"]),
    }),
  }),
  /**
   * The shared memory about the person (G33.2): one entry added, edited or removed. The envelope's
   * session and agent say where it came from; `undoOf` is the change it takes back.
   */
  z.object({
    type: z.literal("memory.changed"),
    payload: z.object({
      memoryId: z.string(),
      action: z.enum(["added", "edited", "removed"]),
      /** The entry's text after the change (for `removed`, the text that went). */
      text: z.string(),
      /** The text before an edit. */
      before: z.string().optional(),
      /** "human", "auto" (learned from a conversation), "import" or the agent's id. */
      by: z.string(),
      undoOf: z.number().int().optional(),
    }),
  }),
  /**
   * A memory forgotten for good (G33.2): the text of its `memory.changed` events was erased; this
   * event keeps no text.
   */
  z.object({
    type: z.literal("memory.forgotten"),
    payload: z.object({ memoryId: z.string(), by: z.string() }),
  }),
  /** The shared memory learns by itself from the conversations, or not (G33.2). */
  z.object({
    type: z.literal("memory.settings"),
    payload: z.object({ auto: z.boolean(), by: z.string() }),
  }),
  /**
   * A conversation brought in from another assistant (G36.7, ChatGPT or Claude): the messages
   * after it are the original ones, in order; the conversation goes on from there.
   */
  /**
   * The first event of a conversation that goes on from another one (G36.23): its history is the
   * origin's events up to `throughSeq` (resolved with `sessionLog`), then its own. Nothing is
   * copied, so the prefix and its cache are the origin's, and the origin stays as it was.
   */
  z.object({
    type: z.literal("session.forked"),
    payload: z.object({
      fromSessionId: z.string(),
      throughSeq: z.number().int(),
      /** The origin's title when it was forked, for the link in the list. */
      fromTitle: z.string().optional(),
      /** "continue": «Continua da qui»; "edit": a message of the person's edited and sent again. */
      how: z.enum(["continue", "edit"]).optional(),
    }),
  }),
  /**
   * A side question «Intanto» (G36.24) and its answer: a separate request with the conversation's
   * prefix and no tools. Recorded for the history of asides and their cost; `rebuildHistory`
   * never reads it, so it never enters the conversation nor the memory.
   */
  z.object({
    type: z.literal("aside"),
    payload: z.object({
      id: z.string(),
      question: z.string(),
      answer: z.string(),
      provider: z.string(),
      model: z.string(),
      metrics: MessageMetrics.optional(),
      costUsd: z.number().nonnegative(),
      error: z.string().optional(),
    }),
  }),
  /** «Porta nella chat»: the aside became a normal message and its answer (G36.24). */
  z.object({
    type: z.literal("aside.promoted"),
    payload: z.object({ asideId: z.string() }),
  }),
  z.object({
    type: z.literal("session.imported"),
    payload: z.object({
      source: z.string(),
      title: z.string(),
      /** The other assistant's id of the conversation: imported twice is noticed. */
      originalId: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      messages: z.number().int().nonnegative(),
      importId: z.string().optional(),
    }),
  }),
  /**
   * What happened to the knowledge (G36): collections and sources added or removed, an index
   * started, ready, swapped in or retired, the model changed. Never the vectors or the texts:
   * those are derived data, rebuilt from the sources.
   */
  z.object({
    type: z.literal("knowledge.changed"),
    payload: z.object({
      action: z.enum([
        "collection.created",
        "collection.changed",
        "collection.removed",
        "source.added",
        "source.removed",
        "index.started",
        "index.ready",
        "index.failed",
        "index.retired",
        "settings.changed",
        "access.changed",
        "vectors.restored",
      ]),
      collectionId: z.string().optional(),
      sourceId: z.string().optional(),
      indexId: z.number().int().optional(),
      /** Short facts for the record: a name, a model, counts. */
      detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      /** "human" or an agent's id. */
      by: z.string(),
    }),
  }),
  z.object({
    type: z.literal("redaction"),
    payload: z.object({ targetSeq: z.number().int(), reason: z.string() }),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody["type"];

/**
 * Envelope common to every event in the append-only log.
 *
 * `hash` covers the envelope and `payloadHash`, not the payload itself: a payload can be
 * erased (e.g. a data-protection request) without breaking the chain, and the erasure is
 * itself recorded as a `redaction` event.
 */
export const EventEnvelope = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  ownerId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  agentId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
  payloadHash: Sha256Hex,
  prevHash: Sha256Hex.nullable(),
  hash: Sha256Hex,
  /** True when the payload has been erased; `payload` is then `null`. */
  erased: z.boolean().default(false),
});

export const Event = z.intersection(
  EventEnvelope,
  z.union([EventBody, z.object({ type: z.string(), payload: z.null() })]),
);
export type Event = z.infer<typeof Event>;
