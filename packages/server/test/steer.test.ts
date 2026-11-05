import { rebuildHistory } from "@redgiant/agent";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("a message written while the agent works (2026-11-05, as in Officina)", () => {
  it("joins the turn after the tool results, in the message the model reads next", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      const last = req.messages.at(-1);
      if (last?.parts.some((p) => p.type === "tool_result")) return { text: "Done, and noted." };
      return { toolCalls: [{ name: "bash", input: { command: "sleep 1; echo slow" } }] };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    const first = await s.core.send("me", sid, "run the slow thing");
    await new Promise((r) => setTimeout(r, 300));
    const second = await s.core.send("me", sid, "also check the logs", {
      queue: true,
      steer: true,
    });
    expect(second.queued).toBe(true);
    await first.done;
    // It ends with the turn it joined: no turn of its own.
    expect((await second.done).stopReason).toBe("end_turn");
    expect(seen).toHaveLength(2);
    const parts = seen[1]?.messages.at(-1)?.parts ?? [];
    expect(parts.map((p) => p.type)).toEqual(["tool_result", "text"]);
    expect(parts[1]).toMatchObject({ text: "also check the logs" });
    // The log says the same when the conversation is read again.
    const events = await s.core.history("me", sid);
    const rebuilt = rebuildHistory(events);
    const withResults = rebuilt.find((h) => h.message.parts.some((p) => p.type === "tool_result"));
    expect(withResults?.message.parts.map((p) => p.type)).toEqual(["tool_result", "text"]);
  });
});
