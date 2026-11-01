import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

type Row = {
  id: string;
  title: string | null;
  pinned: boolean;
  archived: boolean;
  lastAt: string | null;
};

describe("the list of conversations", () => {
  it("titles sessions after their first message, pins and archives them, and searches them", async () => {
    s = await startServer(() => ({ text: "The checkout total is computed in cart.py." }));
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "Where is the 100% checkout total?\nDetails follow.")).done;
    await (await s.core.send("me", sid, "Thanks")).done;
    let [row] = (await s.api<Row[]>("GET", "/api/sessions")).body;
    expect(row).toMatchObject({
      title: "Where is the 100% checkout total?",
      pinned: false,
      archived: false,
    });
    expect(row?.lastAt).toBeTruthy();

    await s.api("PATCH", `/api/sessions/${sid}`, { pinned: true, title: "Checkout" });
    await s.api("PATCH", `/api/sessions/${sid}`, { archived: true });
    [row] = (await s.api<Row[]>("GET", "/api/sessions")).body;
    expect(row).toMatchObject({ title: "Checkout", pinned: true, archived: true });
    // Archiving hides a conversation from the list, never from the log.
    expect((await s.core.history("me", sid)).length).toBeGreaterThan(0);
    expect((await s.api("PATCH", "/api/sessions/sess_nope", { pinned: true })).status).toBe(404);

    const chat = (await s.api<{ id: string }>("POST", "/api/chats")).body;
    await s.core.chat.send("me", chat.id, "Remind me about the checkout tomorrow", [], () => {});
    const hits = (
      await s.api<{ kind: string; id: string; excerpt: string }[]>("GET", "/api/search?q=checkout")
    ).body;
    expect(hits.map((h) => h.kind).sort()).toEqual([
      "chat",
      "chat",
      "session",
      "session",
      "session",
    ]);
    expect(hits.find((h) => h.kind === "session")?.excerpt).toMatch(/checkout/i);
    // LIKE wildcards are matched literally.
    expect((await s.api<unknown[]>("GET", "/api/search?q=100%25")).body).toHaveLength(1);
    expect(
      (await s.api<unknown[]>("GET", "/api/search?q=checkout", undefined, "other-token-0123456789"))
        .body,
    ).toEqual([]);
  });
});
