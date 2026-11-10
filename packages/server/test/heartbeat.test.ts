// p3.5.4 (a page left with stale spinners): the page's heartbeat is answered at once, also while
// a slow message of the same connection is handled, and a page that reconnects follows a
// conversation from the last event it has, with the conversation's state again.
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

describe("the page's heartbeat (p3.5.4)", () => {
  it("answers ping with pong, and follows from afterSeq", async () => {
    s = await startServer(() => ({ text: "Done." }));
    const server = s;
    const god = await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    const page = await wsClient(server.url);
    await page.waitFor("welcome");
    page.send({ type: "ping" });
    await page.waitFor("pong");

    // A conversation with a turn in it, followed whole.
    page.send({ type: "session.follow", sessionId: body.sessionId });
    await page.waitFor("session.synced", (m) => m.sessionId === body.sessionId);
    page.send({ type: "session.send", sessionId: body.sessionId, text: "Hi" });
    await page.waitFor(
      "event",
      (m) => m.sessionId === body.sessionId && m.event.type === "message.assistant",
    );
    const seqs = page.messages.flatMap((m) =>
      m.type === "event" && m.sessionId === body.sessionId ? [m.event.seq] : [],
    );
    const mid = seqs[Math.floor(seqs.length / 2)] as number;
    page.close();

    // The same page connects again and has the events up to `mid`.
    const again = await wsClient(server.url);
    await again.waitFor("welcome");
    again.send({ type: "session.follow", sessionId: body.sessionId, afterSeq: mid });
    const synced = await again.waitFor("session.synced", (m) => m.sessionId === body.sessionId);
    await again.waitFor("session.state", (m) => m.sessionId === body.sessionId);
    const replayed = again.messages.flatMap((m) =>
      m.type === "event" && m.sessionId === body.sessionId ? [m.event.seq] : [],
    );
    expect(replayed).toEqual(seqs.filter((x) => x > mid));
    expect(synced.lastSeq).toBe(seqs.at(-1));
    // Nothing new since the last event: none sent, and the same last number.
    const third = await wsClient(server.url);
    await third.waitFor("welcome");
    third.send({ type: "session.follow", sessionId: body.sessionId, afterSeq: seqs.at(-1) });
    const none = await third.waitFor("session.synced");
    expect(none.lastSeq).toBe(seqs.at(-1));
    expect(third.messages.some((m) => m.type === "event")).toBe(false);
    again.close();
    third.close();
  });
});
