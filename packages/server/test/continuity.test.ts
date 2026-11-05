import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("one conversation with Demi-God from every place (Hermes continuity)", () => {
  it("Telegram, the web and the CLI land in the same work session", async () => {
    s = await startServer(() => ({ text: "Noted." }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const demigod = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "demigod",
      parentId: god.body.id,
      name: "Demi-God",
    });
    // A message from a chat (Telegram, Discord…).
    expect(await s.core.askDemigod("me", 1, "from the phone")).toBe("Noted.");
    // The web and `redgiant chat --continue` ask for the work session: the same one.
    const web = await s.api<{ sessionId: string }>(
      "POST",
      `/api/agents/${demigod.body.id}/work-session`,
    );
    expect(web.status).toBe(200);
    const events = await s.core.store.list({ sessionId: web.body.sessionId });
    expect(
      events.some((e) => e.type === "message.user" && e.payload.text === "from the phone"),
    ).toBe(true);
    const again = await s.api<{ sessionId: string }>(
      "POST",
      `/api/agents/${demigod.body.id}/work-session`,
    );
    expect(again.body.sessionId).toBe(web.body.sessionId);
    // Someone else's agent is not found.
    const other = await s.api("POST", "/api/agents/agent_nobody/work-session");
    expect(other.status).toBe(404);
  });
});
