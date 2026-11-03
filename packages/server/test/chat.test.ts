import type { CompletionRequest } from "@redgiant/providers";
import type { WebSearchProvider } from "@redgiant/tools";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEntry } from "../src/index.js";
import { startServer, TOKEN } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const search: WebSearchProvider = {
  async search(query) {
    return [
      { title: `About ${query}`, url: "https://example.org/rome", snippet: "Rome: 21 °C, sunny." },
    ];
  },
};

/** The assistant searches once, then answers citing the source. */
const brain = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const result = last?.parts.find((p) => p.type === "tool_result");
  if (result?.type === "tool_result")
    return {
      text: `It is 21 °C and sunny [1].\n\nSources:\n[1] ${result.content.split("\n")[1]?.trim()}`,
    };
  return {
    thinking: "I need today's weather.",
    toolCalls: [{ name: "web_search", input: { query: "weather Rome today" } }],
  };
};

async function send(chatId: string, text: string, attachments: unknown[] = []) {
  const r = await fetch(`${s?.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ text, attachments }),
  });
  const body = await r.text();
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)?.[1],
      data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null") as Record<string, unknown>,
    }));
}

describe("the daily chat", () => {
  it("searches the web, cites its sources, streams and keeps an ordinary history", async () => {
    s = await startServer(brain, {}, { search });
    const chat = (await s.api<{ id: string; title: string }>("POST", "/api/chats")).body;
    const events = await send(chat.id, "Che tempo fa a Roma?", [
      { name: "note.txt", content: "I am going out at 5." },
    ]);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("delta");
    expect(kinds).toContain("tool");
    expect(kinds.at(-1)).toBe("done");
    expect(events.find((e) => e.event === "tool")?.data).toMatchObject({
      name: "web_search",
      input: { query: "weather Rome today" },
    });

    const entries = (await s.api<ChatEntry[]>("GET", `/api/chats/${chat.id}`)).body;
    // user, assistant (search), tool results, assistant (answer)
    expect(entries.map((e) => e.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries[0]?.shown).toBe("Che tempo fa a Roma?");
    const sent = entries[0]?.message.parts[0];
    expect(sent?.type === "text" && sent.text).toMatch(/^Date: \d{4}-\d{2}-\d{2}\n\nChe tempo/);
    expect(sent?.type === "text" && sent.text).toContain('<attachment name="note.txt">');
    const answer = entries[3]?.message.parts.find((p) => p.type === "text");
    expect(answer?.type === "text" && answer.text).toMatch(
      /\[1\][\s\S]*https:\/\/example\.org\/rome/,
    );
    expect(entries[3]?.metrics).toBeTruthy();
    // The chat is titled after its first message.
    expect((await s.api<{ title: string }[]>("GET", "/api/chats")).body[0]?.title).toBe(
      "Che tempo fa a Roma?",
    );
    // Outside the full-log policy: nothing about the chat is in the event log.
    expect(await s.core.store.list({})).toEqual([]);

    // Its own model and prompt, and gone for good when deleted.
    await s.api("PUT", "/api/chat/settings", {
      model: { provider: "fake", model: "chat-model", effort: "low" },
      systemPrompt: "Be terse.",
    });
    await send(chat.id, "E domani?");
    const req = s.provider.requests.at(-1);
    expect([req?.model, req?.effort, req?.system]).toEqual(["chat-model", "low", "Be terse."]);
    expect((await s.api("DELETE", `/api/chats/${chat.id}`)).status).toBe(200);
    expect((await s.api("GET", `/api/chats/${chat.id}`)).status).toBe(404);
    expect((await s.api<unknown[]>("GET", "/api/chats")).body).toEqual([]);
  });

  it("keeps each owner's chats to themselves", async () => {
    s = await startServer(brain, {}, { search });
    const chat = (await s.api<{ id: string }>("POST", "/api/chats")).body;
    expect(
      (await s.api("GET", `/api/chats/${chat.id}`, undefined, "other-token-0123456789")).status,
    ).toBe(404);
  });
});

describe("the Chat as an agent (2026-11-03)", () => {
  it("is made once under God, with every tool, and follows the chat's settings", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: "Ciao!" };
    });
    expect((await s.api("GET", "/api/chat/agent")).status).toBe(400);
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const a = await s.api<{ id: string; kind: string; name: string; parentId: string }>(
      "GET",
      "/api/chat/agent",
    );
    expect(a.body).toMatchObject({ kind: "assistant", name: "Chat", parentId: god.body.id });
    expect((await s.api<{ id: string }>("GET", "/api/chat/agent")).body.id).toBe(a.body.id);

    const { sessionId } = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: a.body.id })
    ).body;
    const me = s.core.registry.get(a.body.id)?.ownerId as string;
    await (await s.core.send(me, sessionId, "Ciao")).done;
    const tools = seen.at(-1)?.tools.map((t) => t.name) ?? [];
    for (const name of ["write_file", "bash", "show", "publish_board", "send_file", "web_search"])
      expect(tools).toContain(name);
    expect(seen.at(-1)?.system).toContain("every tool");

    await s.api("PUT", "/api/chat/settings", { systemPrompt: "Be brief." });
    expect(s.core.registry.get(a.body.id)?.systemPrompt).toBe("Be brief.");
  });
});
