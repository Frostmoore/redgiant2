// Hands-free voice (G38.4): a request said by voice reaches the agent like any message, marked
// `via: "voice"`, with the note for the model at its very end. Nothing before it changes (the
// prompt prefix stays the one the cache holds) and the answer comes back with its spoken version.
import type { CompletionRequest, Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

const HINT =
  "<voice-mode>The person is talking to you by voice, hands-free, and your answer will be read aloud.</voice-mode>";

const userText = (req: CompletionRequest) =>
  req.messages
    .filter((m) => m.role === "user")
    .map((m) =>
      m.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join(""),
    );

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("a request said by voice (G38.4)", () => {
  it("is marked, carries the note at its end, and the answer comes back whole", async () => {
    const s = await startServer((req) => {
      const last = userText(req).at(-1) ?? "";
      return last.includes("<voice-mode>")
        ? { text: "<spoken>Sono le tre.</spoken>\n\n| ora | fuso |\n|---|---|\n| 15:00 | CET |" }
        : { text: "Ciao!" };
    });
    close = s.close;
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    const id = body.sessionId;
    const page = await wsClient(s.url);
    await page.waitFor("welcome");
    page.send({ type: "session.follow", sessionId: id });
    await page.waitFor("session.synced", (m) => m.sessionId === id);

    const idle = async (count: number) => {
      const end = Date.now() + 10_000;
      while (
        page.messages.filter(
          (m) => m.type === "session.state" && m.sessionId === id && m.state === "idle",
        ).length < count
      ) {
        if (Date.now() > end) throw new Error("the turn did not end");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    page.send({ type: "session.send", sessionId: id, text: "ciao" });
    await idle(1);
    const said = `che ore sono?\n\n${HINT}`;
    page.send({ type: "session.send", sessionId: id, text: said, via: "voice", clientId: "v1" });
    await idle(2);

    const log = (await s.api<Event[]>("GET", `/api/sessions/${id}/events`)).body;
    const users = log.filter((e) => e.type === "message.user");
    expect(users.map((e) => e.type === "message.user" && e.payload?.via)).toEqual([
      undefined,
      "voice",
    ]);
    const answer = log.filter((e) => e.type === "message.assistant").at(-1);
    expect(answer?.type === "message.assistant" && answer.payload?.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("<spoken>Sono le tre.</spoken>"),
    });

    // What the model saw: the first turn as it was, then the request with the note last.
    const [first, second] = s.provider.requests;
    expect(userText(second as CompletionRequest).slice(0, -1)).toEqual(
      userText(first as CompletionRequest),
    );
    expect(
      userText(second as CompletionRequest)
        .at(-1)
        ?.endsWith(HINT),
    ).toBe(true);
    expect((second as CompletionRequest).system).toBe((first as CompletionRequest).system);
  });
});
