import { rebuildHistory } from "@redgiant/agent";
import type { Event } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { telegramQuotes } from "@redgiant/telegram";
import { afterEach, describe, expect, it } from "vitest";
import { fakeTelegram } from "./fake-telegram.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
let tg: Awaited<ReturnType<typeof fakeTelegram>> | undefined;
afterEach(async () => {
  await s?.close();
  await tg?.close();
  s = undefined;
  tg = undefined;
});

const textOf = (m: CompletionRequest["messages"][number] | undefined) =>
  (m?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

async function god(server: Server) {
  const g = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const sid = (
    await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: g.body.id })
  ).body.sessionId;
  return { agentId: g.body.id, sid };
}

const userTexts = (events: Event[]) =>
  events.flatMap((e) => (e.type === "message.user" && e.payload ? [e.payload.text] : []));

describe("replying to a passage (G36.22)", () => {
  it("sends the quotes with the message: a block before the reply, the prefix unchanged", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: seen.length === 1 ? "Plan: first A, then B." : "Then only B." };
    });
    const { sid } = await god(s);
    await (await s.core.send("me", sid, "what is the plan?")).done;
    const answer = (await s.core.history("me", sid)).find((e) => e.type === "message.assistant");
    await (
      await s.core.send("me", sid, "", {
        watch: true,
        quotes: [{ seq: answer?.seq ?? 0, at: answer?.ts ?? "", text: "first A", reply: "skip A" }],
      })
    ).done;
    expect(seen[1]?.messages.slice(0, seen[0]?.messages.length)).toEqual(seen[0]?.messages);
    const said = textOf(seen[1]?.messages.at(-1));
    expect(said).toContain(`(event ${answer?.seq})`);
    expect(said).toMatch(/They received the whole message[\s\S]*> first A\n\nskip A$/);
    const events = await s.core.history("me", sid);
    expect(rebuildHistory(events).at(-2)?.message).toEqual(seen[1]?.messages.at(-1));
    // The list names the conversation after the person's own words, never the quote.
    const row = (await s.core.listSessions("me")).find((r) => r.id === sid);
    expect(row?.title).toBe("what is the plan?");
  });

  it("turns a Telegram reply with a quote into the same thing", async () => {
    expect(
      telegramQuotes({
        reply_to_message: { from: { is_bot: true }, text: "One. Two.", date: 1_700_000_000 },
        quote: { text: "Two.", position: 5 },
      }),
    ).toEqual([{ text: "Two.", at: "2023-11-14T22:13:20.000Z", start: 5, end: 9 }]);
    // A reply to the person's own message is not a quote.
    expect(telegramQuotes({ reply_to_message: { from: { is_bot: false }, text: "mine" } })).toBe(
      undefined,
    );
    const seen: CompletionRequest[] = [];
    tg = await fakeTelegram();
    s = await startServer(
      (req) => {
        seen.push(req);
        return { text: "ok" };
      },
      {},
      {},
      undefined,
      tg.apiRoot,
    );
    const g = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/agents", { kind: "demigod", parentId: g.body.id, name: "Demi-God" });
    const { body } = await s.api<{ code: string }>("POST", "/api/telegram/pair");
    await s.gateway?.handleUpdate(tg.text(4242, `/start ${body.code}`) as never);
    const update = tg.reply(4242, "not this one", 7) as {
      message: Record<string, unknown> & { reply_to_message: Record<string, unknown> };
    };
    update.message.reply_to_message.from = { id: 1, is_bot: true, first_name: "RedGiant" };
    update.message.reply_to_message.text = "Option one. Option two.";
    update.message.quote = { text: "Option two.", position: 12 };
    await s.gateway?.handleUpdate(update as never);
    await s.gateway?.idle();
    const said = textOf(seen.at(-1)?.messages.at(-1));
    expect(said).toMatch(/They received the whole message[\s\S]*> Option two\.\n\nnot this one/);
  });
});

describe("going on in a new conversation (G36.23)", () => {
  it("points at the origin, keeps its prefix (summaries too) and leaves it as it was", async () => {
    const seen: CompletionRequest[] = [];
    let n = 0;
    s = await startServer((req) => {
      seen.push(req);
      const last = textOf(req.messages.at(-1));
      if (last.includes("Do not call any tool now")) return { text: "Summary: hello and more." };
      return { text: `answer ${++n}` };
    });
    const { sid } = await god(s);
    await (await s.core.send("me", sid, "first")).done;
    await (await s.core.send("me", sid, "/compact")).done;
    await (await s.core.send("me", sid, "second")).done;
    await (await s.core.send("me", sid, "third")).done;
    const origin = await s.core.history("me", sid);
    const second = origin.filter((e) => e.type === "message.assistant").at(-2);
    const r = await s.api<{ sessionId: string }>("POST", `/api/sessions/${sid}/fork`, {
      fromSeq: second?.seq,
    });
    expect(r.status).toBe(201);
    const branch = r.body.sessionId;
    const own = await s.core.store.list({ sessionId: branch });
    expect(own.map((e) => e.type)).toEqual(["session.forked"]);
    expect(own[0]?.payload).toMatchObject({
      fromSessionId: sid,
      throughSeq: second?.seq,
      how: "continue",
    });
    // The page shows the origin's part, then its own.
    expect(userTexts(await s.core.history("me", branch))).toEqual(["first", "second"]);
    const row = (await s.core.listSessions("me")).find((x) => x.id === branch);
    expect(row?.forked_from).toBe(sid);
    const before = seen.length;
    await (await s.core.send("me", branch, "branch message")).done;
    const req = seen[before];
    // The origin's request for "third" had this very prefix (summary included): its cache holds.
    const third = seen[before - 1];
    expect(req?.system).toBe(third?.system);
    expect(req?.tools).toEqual(third?.tools);
    expect(req?.messages.slice(0, -1)).toEqual(third?.messages.slice(0, -1));
    expect(textOf(req?.messages.at(-1))).toBe("branch message");
    expect(await s.core.history("me", sid)).toEqual(origin);
    // Rebuilt after a restart, the same history.
    expect(rebuildHistory(await s.core.history("me", branch)).map((h) => h.message)).toEqual([
      ...(req?.messages ?? []),
      { role: "assistant", parts: [{ type: "text", text: `answer ${n}` }] },
    ]);
  });

  it("edits a message: everything before it, nothing copied", async () => {
    let n = 0;
    s = await startServer(() => ({ text: `answer ${++n}` }));
    const { sid } = await god(s);
    await (await s.core.send("me", sid, "first")).done;
    await (await s.core.send("me", sid, "second")).done;
    const events = await s.core.history("me", sid);
    const second = events.filter((e) => e.type === "message.user")[1];
    const copy = await s.core.forkSession("me", sid, { beforeSeq: second?.seq ?? 0 });
    expect((await s.core.store.list({ sessionId: copy })).map((e) => e.type)).toEqual([
      "session.forked",
    ]);
    expect(userTexts(await s.core.history("me", copy))).toEqual(["first"]);
  });
});

describe("«Intanto» (G36.24)", () => {
  it("answers while the agent works, outside the conversation; «Porta nella chat» later", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      const last = textOf(req.messages.at(-1));
      if (last.includes("side question")) return { text: "It uses port 7703." };
      if (req.messages.at(-1)?.parts.some((p) => p.type === "tool_result"))
        return { text: "Done." };
      return { toolCalls: [{ name: "bash", input: { command: "sleep 1; echo slow" } }] };
    });
    const { sid } = await god(s);
    const turn = await s.core.send("me", sid, "run the slow thing");
    await new Promise((r) => setTimeout(r, 300));
    expect(s.core.isRunning(sid)).toBe(true);
    const r = await s.api<{ aside: { id: string; answer: string; question: string } }>(
      "POST",
      `/api/sessions/${sid}/aside`,
      { question: "which port?" },
    );
    expect(r.status).toBe(201);
    expect(r.body.aside).toMatchObject({ question: "which port?", answer: "It uses port 7703." });
    const asked = seen.find((q) => textOf(q.messages.at(-1)).includes("which port?"));
    // Same start as the turn running now; the call still running gets a placeholder.
    expect(asked?.system).toBe(seen[0]?.system);
    expect(asked?.tools).toEqual(seen[0]?.tools);
    expect(asked?.messages.slice(0, 2)).toEqual(seen[0]?.messages.concat(asked?.messages[1] ?? []));
    // Not while it works.
    const busy = await s.api("POST", `/api/sessions/${sid}/asides/${r.body.aside.id}/chat`);
    expect(busy.status).toBe(409);
    await turn.done;
    // The turn's next call has the real result and nothing of the side question.
    const after = seen.at(-1);
    expect(textOf(after?.messages.at(-1))).toBe("");
    expect(JSON.stringify(after?.messages)).toContain("slow");
    expect(JSON.stringify(after?.messages)).not.toContain("which port");
    const events = await s.core.history("me", sid);
    expect(events.filter((e) => e.type === "aside")).toHaveLength(1);
    expect(userTexts(events)).toEqual(["run the slow thing"]);
    expect(JSON.stringify(rebuildHistory(events))).not.toContain("7703");
    // Brought into the chat: a normal exchange at the end, once.
    const moved = await s.api("POST", `/api/sessions/${sid}/asides/${r.body.aside.id}/chat`);
    expect(moved.status).toBe(200);
    const again = await s.api("POST", `/api/sessions/${sid}/asides/${r.body.aside.id}/chat`);
    expect(again.status).toBe(400);
    const now = await s.core.history("me", sid);
    expect(userTexts(now)).toEqual(["run the slow thing", "which port?"]);
    const reply = now.filter((e) => e.type === "message.assistant").at(-1);
    expect(reply?.type === "message.assistant" && reply.payload?.costUsd).toBe(0);
  });
});
