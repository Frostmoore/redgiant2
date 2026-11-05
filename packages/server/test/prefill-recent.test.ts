import type { CompletionRequest } from "@redgiant/providers";
import { FakeProvider } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** A local engine that records what it was asked to compute ahead. */
class LocalWithPrefill extends FakeProvider {
  readonly prefilled: CompletionRequest[] = [];
  readonly options: ({ onlyStart?: boolean } | undefined)[] = [];
  async prefill(
    request: CompletionRequest,
    _signal?: AbortSignal,
    o?: { onlyStart?: boolean },
  ): Promise<void> {
    this.prefilled.push(request);
    this.options.push(o);
  }
}

describe("conversations computed ahead after the engine starts (G24.14)", () => {
  it("prefills the latest conversations that use the local model, with their whole history", async () => {
    s = await startServer(() => ({ text: "OK" }));
    const local = new LocalWithPrefill(() => ({ text: "Ciao!" }), { id: "local" });
    s.core.providers.register(local);
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    // The local model is the agents' default (the engine page's «use for agents»).
    s.core.setDefaultModel({ provider: "local", model: "gpt-oss" });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", {
        agentId: god.body.id,
      })
    ).body.sessionId;
    await (await s.core.send("me", sid, "Ciao")).done;
    expect(await s.core.prefillRecent("me")).toBe(1);
    expect(local.prefilled).toHaveLength(1);
    const req = local.prefilled[0] as CompletionRequest;
    expect(req.cacheKey).toBe(sid);
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("computes ahead the start of a new conversation, recording nothing (2026-11-05)", async () => {
    s = await startServer(() => ({ text: "OK" }));
    const local = new LocalWithPrefill(() => ({ text: "Ciao!" }), { id: "local" });
    s.core.providers.register(local);
    s.core.setDefaultModel({ provider: "local", model: "glm" });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    // No conversation yet: God's start.
    expect(await s.core.prefillStarts("me")).toBe(1);
    const req = local.prefilled[0] as CompletionRequest;
    expect(req.cacheKey).toBe(`start_${god.body.id}`);
    expect(local.options[0]).toEqual({ onlyStart: true });
    expect(req.messages).toEqual([{ role: "user", parts: [{ type: "text", text: "." }] }]);
    // The same system and tools a new conversation of God gets.
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "Ciao")).done;
    const started = (await s.core.store.list({ sessionId: sid })).find(
      (e) => e.type === "session.started",
    );
    const system = started?.type === "session.started" ? started.payload?.system : undefined;
    expect(system).toBeDefined();
    expect(req.system).toBe(system);
    // Nothing of the preview in the list or in the log.
    expect((await s.core.listSessions("me")).map((r) => r.id)).toEqual([sid]);
    expect(await s.core.store.list({ sessionId: `start_${god.body.id}` })).toEqual([]);
  });
});
