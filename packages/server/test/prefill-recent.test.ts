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
  async prefill(request: CompletionRequest): Promise<void> {
    this.prefilled.push(request);
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
});
