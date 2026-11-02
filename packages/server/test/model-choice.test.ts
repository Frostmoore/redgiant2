import type { ServerMessage } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const answered = (seen: ServerMessage[]) =>
  seen.some(
    (m) =>
      m.type === "event" &&
      m.event.type === "message.assistant" &&
      JSON.stringify(m.event.payload).includes("Hello from"),
  );

describe("choosing models (decision 2026-11-02)", () => {
  it("opens a conversation without any model; the one chosen in its menu answers", async () => {
    s = await startServer((req) => ({ text: `Hello from ${req.model}` }));
    const core = s.core;
    core.setDefaultModel(undefined);
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const started = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    expect(started.status).toBe(201);
    const id = started.body.sessionId;
    const me = core.registry.get(god.body.id)?.ownerId as string;
    const seen: ServerMessage[] = [];
    const stop = await core.follow(me, id, (m) => seen.push(m));
    expect(seen.map((m) => m.type)).toEqual(["session.synced", "session.state"]);
    // Writing before a model is chosen says what to do.
    await expect(core.send(me, id, "hi")).rejects.toMatchObject({ code: "no_model" });
    // The model chosen in the conversation's menu is the one that answers, and the follower sees it.
    await core.setSessionModel(me, id, { provider: "fake", model: "chosen" });
    const { done } = await core.send(me, id, "hi");
    await done;
    expect(answered(seen)).toBe(true);
    expect(JSON.stringify(seen)).toContain("Hello from chosen");
    stop();
  });

  it("gives an agent its own model from the settings, used by its open conversations next", async () => {
    s = await startServer((req) => ({ text: `Hello from ${req.model}` }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { sessionId } = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body;
    const me = s.core.registry.get(god.body.id)?.ownerId as string;
    await (await s.core.send(me, sessionId, "one")).done;
    const seen: ServerMessage[] = [];
    const stop = await s.core.follow(me, sessionId, (m) => seen.push(m));
    const set = await s.api<{ model?: { model: string } }>("PATCH", `/api/agents/${god.body.id}`, {
      model: { provider: "fake", model: "opus" },
    });
    expect(set.body.model?.model).toBe("opus");
    await (await s.core.send(me, sessionId, "two")).done;
    expect(JSON.stringify(seen)).toContain("Hello from opus");
    // null: back to the default model.
    const back = await s.api<{ model?: unknown }>("PATCH", `/api/agents/${god.body.id}`, {
      model: null,
    });
    expect(back.body.model).toBeUndefined();
    stop();
  });

  it("changes the chat's model alone, keeping its instructions", async () => {
    s = await startServer(() => ({ text: "ok" }));
    await s.api("PUT", "/api/chat/settings", { systemPrompt: "Be brief." });
    await s.api("PUT", "/api/chat/settings", { model: { provider: "fake", model: "opus" } });
    expect((await s.api("GET", "/api/chat/settings")).body).toEqual({
      systemPrompt: "Be brief.",
      model: { provider: "fake", model: "opus" },
    });
    await s.api("PUT", "/api/chat/settings", { model: null });
    expect((await s.api("GET", "/api/chat/settings")).body).toEqual({ systemPrompt: "Be brief." });
  });
});
