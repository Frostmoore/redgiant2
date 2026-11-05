import { z } from "zod";
import { AgentSpec } from "./agents.js";
import { AutomationRunStatus, AutomationTrigger } from "./automations.js";
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
    payload: z.object({ sessionId: z.string(), system: z.string(), tools: z.array(z.string()) }),
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
  z.object({
    type: z.literal("canvas.show"),
    payload: z.object({
      title: z.string(),
      target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("file"), scope: z.string(), path: z.string() }),
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
  z.object({
    type: z.literal("task.opened"),
    payload: z.object({ taskId: z.string(), title: z.string() }),
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
