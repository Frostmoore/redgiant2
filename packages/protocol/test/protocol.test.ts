import { describe, expect, it } from "vitest";
import {
  ClientMessage,
  Event,
  LOCAL_OWNER_ID,
  MessageMetrics,
  ModelSpec,
  PROTOCOL_VERSION,
  ServerMessage,
} from "../src/index.js";

const HASH = "a".repeat(64);

const envelope = {
  id: "evt_1",
  seq: 0,
  ts: "2026-10-31T10:00:00.000Z",
  ownerId: LOCAL_OWNER_ID,
  projectId: "proj_1",
  agentId: "agent_1",
  sessionId: "sess_1",
  payloadHash: HASH,
  prevHash: null,
  hash: HASH,
};

describe("ModelSpec", () => {
  it("accepts a nested fallback chain", () => {
    const spec = ModelSpec.parse({
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
      fallback: { provider: "local", model: "gemma-4", fallback: { provider: "x", model: "y" } },
    });
    expect(spec.fallback?.fallback?.model).toBe("y");
  });

  it("rejects an unknown effort", () => {
    expect(ModelSpec.safeParse({ provider: "p", model: "m", effort: "extreme" }).success).toBe(
      false,
    );
  });
});

describe("MessageMetrics", () => {
  it("defaults cache counters to zero", () => {
    const m = MessageMetrics.parse({
      startedAt: "2026-10-31T10:00:00.000Z",
      inputTokens: 1200,
      outputTokens: 80,
      contextUsed: 1280,
      contextWindow: 32768,
      source: "client",
    });
    expect(m.cachedReadTokens).toBe(0);
    expect(m.cacheWriteTokens).toBe(0);
  });

  it("rejects negative token counts", () => {
    expect(
      MessageMetrics.safeParse({
        startedAt: "2026-10-31T10:00:00.000Z",
        inputTokens: -1,
        outputTokens: 0,
        contextUsed: 0,
        contextWindow: 1,
        source: "server",
      }).success,
    ).toBe(false);
  });
});

describe("Event", () => {
  it("parses a typed event with its envelope", () => {
    const e = Event.parse({ ...envelope, type: "message.user", payload: { text: "ciao" } });
    expect(e.type).toBe("message.user");
  });

  it("says where the person answered, and reads older logs without it (p3.5.4)", () => {
    const resolved = (extra: object) =>
      Event.safeParse({
        ...envelope,
        type: "permission.resolved",
        payload: { requestId: "r1", decision: "allow", by: "human", ...extra },
      });
    expect(resolved({}).success).toBe(true);
    const e = resolved({ via: "telegram" });
    expect(e.success && e.data.type === "permission.resolved" && e.data.payload.via).toBe(
      "telegram",
    );
    expect(resolved({ via: 3 }).success).toBe(false);
    const answered = Event.safeParse({
      ...envelope,
      type: "question.answered",
      payload: { requestId: "q1", answers: [["Blu"]], by: "human", via: "web" },
    });
    expect(answered.success).toBe(true);
  });

  it("rejects a payload that does not match its type", () => {
    expect(Event.safeParse({ ...envelope, type: "message.user", payload: {} }).success).toBe(false);
  });

  it("rejects a malformed hash", () => {
    expect(
      Event.safeParse({ ...envelope, hash: "xyz", type: "message.user", payload: { text: "" } })
        .success,
    ).toBe(false);
  });

  it("accepts an erased payload as null, for any type", () => {
    const e = Event.parse({ ...envelope, erased: true, type: "message.user", payload: null });
    expect(e.erased).toBe(true);
  });

  it("parses an assistant message with parts, native content and metrics", () => {
    const e = Event.safeParse({
      ...envelope,
      type: "message.assistant",
      payload: {
        parts: [
          { type: "text", text: "ok" },
          {
            type: "tool_call",
            callId: "c",
            name: "read",
            input: { path: "a" },
            rawInput: '{"path":"a"}',
          },
        ],
        native: { provider: "anthropic", model: "claude-opus-5-5", content: [] },
        stopReason: "tool_use",
        provider: "anthropic",
        model: "claude-opus-5-5",
        metrics: {
          startedAt: "2026-10-31T10:00:00.000Z",
          inputTokens: 1,
          outputTokens: 1,
          contextUsed: 2,
          contextWindow: 10,
          source: "client",
        },
        costUsd: 0,
      },
    });
    expect(e.success).toBe(true);
  });

  it("requires a justification to close a task as not testable", () => {
    const base = { ...envelope, type: "task.closed" };
    expect(
      Event.safeParse({ ...base, payload: { taskId: "t1", outcome: "not_testable" } }).success,
    ).toBe(false);
    expect(
      Event.safeParse({
        ...base,
        payload: { taskId: "t1", outcome: "not_testable", justification: "visual review only" },
      }).success,
    ).toBe(true);
  });
});

describe("wire messages", () => {
  it("round-trips a welcome and an event", () => {
    expect(
      ServerMessage.parse({ type: "welcome", protocolVersion: PROTOCOL_VERSION, ownerId: "local" })
        .type,
    ).toBe("welcome");
    const msg = ServerMessage.parse({
      type: "event",
      sessionId: "s1",
      event: {
        ...envelope,
        type: "session.started",
        payload: { sessionId: "s1", system: "", tools: [] },
      },
    });
    expect(msg.type).toBe("event");
  });

  it("defaults remember to false on permission decisions", () => {
    const m = ClientMessage.parse({
      type: "permission.resolve",
      requestId: "r1",
      decision: "allow",
    });
    expect(m.type === "permission.resolve" && m.remember).toBe(false);
  });
});
