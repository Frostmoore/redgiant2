import { z } from "zod";
import { AgentSpec } from "./agents.js";
import { AutomationRunStatus, AutomationTrigger } from "./automations.js";
import { AssistantPart, NativeContent, StopReason } from "./messages.js";
import { MessageMetrics } from "./metrics.js";

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
  z.object({
    type: z.literal("session.ended"),
    payload: z.object({ reason: z.string() }),
  }),
  z.object({
    type: z.literal("hook.blocked"),
    payload: z.object({ hook: z.string(), callId: z.string().optional(), reason: z.string() }),
  }),
  z.object({ type: z.literal("message.user"), payload: text }),
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
    payload: z.object({ callId: z.string(), ok: z.boolean(), output: z.string() }),
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
  z.object({
    type: z.literal("compaction"),
    payload: z.object({ summary: z.string(), fromSeq: z.number().int(), toSeq: z.number().int() }),
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
