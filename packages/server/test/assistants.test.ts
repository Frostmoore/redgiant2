import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});
const here = dirname(fileURLToPath(import.meta.url));

const lastUserText = (req: CompletionRequest) => {
  const m = [...req.messages]
    .reverse()
    .find((x) => x.role === "user" && x.parts.some((p) => p.type === "text"));
  const p = m?.parts.find((x) => x.type === "text");
  return p?.type === "text" ? p.text : "";
};
const lastResult = (req: CompletionRequest) => {
  const last = req.messages.at(-1);
  const p = last?.role === "user" ? last.parts.find((x) => x.type === "tool_result") : undefined;
  return p?.type === "tool_result" ? p.content : undefined;
};

describe("personal assistants (G24.11)", () => {
  it("each sees only its services and the shared notes; God hands work over by job", async () => {
    const seen: { system: string; tools: string[] }[] = [];
    let secretary = "";
    s = await startServer((req) => {
      const tools = req.tools.map((t) => t.name);
      seen.push({ system: req.system ?? "", tools });
      const isAssistant = (req.system ?? "").includes("personal assistants");
      if (isAssistant) return { text: "Two appointments today: 9:00 dentist, 15:00 call." };
      // God: hands the diary to the secretary, then reports its answer.
      const r = lastResult(req);
      if (r === undefined && lastUserText(req).includes("diary"))
        return {
          toolCalls: [
            {
              name: "ask_assistant",
              input: { assistant_id: secretary, request: "What is on the diary today?" },
            },
          ],
        };
      return { text: r ? `From the secretary: ${r}` : "ok" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("PUT", "/api/extensions/mcp", {
      name: "echo",
      projectId: null,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [join(here, "../../extensions/test/mcp-server.mjs")],
      },
    });
    const a = await s.api<{ id: string; kind: string; connections: string[] }>(
      "POST",
      "/api/agents",
      {
        kind: "assistant",
        parentId: god.body.id,
        name: "Secretary",
        role: "Keeps my diary and my tasks in order.",
        connections: ["echo"],
      },
    );
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ kind: "assistant", connections: ["echo"] });
    secretary = a.body.id;
    const b = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "assistant",
      parentId: god.body.id,
      name: "Researcher",
      role: "Looks things up on the web.",
    });
    expect(
      (
        await s.api("PUT", "/api/files/content", {
          scope: "assistants",
          path: "memory/shared.md",
          content: "The user is called Marta and works as an architect.",
        })
      ).status,
    ).toBe(200);

    const talk = async (agentId: string, text: string) => {
      const sid = (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId }))?.body
        .sessionId as string;
      await (await (s as Server).core.send("me", sid, text)).done;
      return sid;
    };
    await talk(secretary, "hello");
    const sec = seen.at(-1);
    expect(sec?.system).toContain("Your job: Keeps my diary");
    expect(sec?.system).toContain("Marta");
    expect(sec?.tools).toEqual(
      expect.arrayContaining(["mcp__echo__shout", "request_connection", "ask_assistant"]),
    );
    await talk(b.body.id, "hello");
    expect(seen.at(-1)?.tools).not.toContain("mcp__echo__shout");
    expect(seen.at(-1)?.tools).toContain("request_connection");

    // God, the chief of staff, hands the diary to the secretary and answers in the same chat.
    const godSid = await talk(god.body.id, "What is on my diary today?");
    const events = await s.core.history("me", godSid);
    const answer = events.filter((e) => e.type === "message.assistant").at(-1)?.payload as {
      parts: { type: string; text?: string }[];
    };
    expect(answer.parts.find((p) => p.type === "text")?.text).toContain("9:00 dentist");
  });

  it("runs a routine that belongs to an assistant", async () => {
    s = await startServer((req) =>
      (req.system ?? "").includes("personal assistants")
        ? { text: "Morning summary: nothing due." }
        : { text: "ok" },
    );
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const a = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "assistant",
      parentId: god.body.id,
      name: "Secretary",
      role: "Keeps my diary.",
    });
    const created = await s.core.automations.create(
      "me",
      `name: morning\non:\n  cron: "0 8 * * 1-5"\nagent: ${a.body.id}\ninstructions: Give me the morning summary.\n`,
    );
    const { run, done } = await s.core.automations.runNow("me", created.automation.id);
    await done;
    const runs = await s.core.automations.runs("me", created.automation.id);
    expect(runs.find((r) => r.id === run.id)).toMatchObject({ status: "ok" });
    expect(runs.find((r) => r.id === run.id)?.summary).toContain("Morning summary");
  });
});
