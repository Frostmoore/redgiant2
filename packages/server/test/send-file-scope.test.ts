// send_file beyond the agent's own workspace (p3.7.2): God sends a project's file by its full
// path, as the knowledge table's "source" lets it read every project; an agent without the
// project (an assistant) is told there is no such file, and nothing is sent.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

const textOf = (req: CompletionRequest | undefined) =>
  req?.messages
    .at(-1)
    ?.parts.flatMap((p) =>
      p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : [],
    )
    .join("\n") ?? "";

function script(req: CompletionRequest): FakeTurn {
  const last = req.messages.at(-1);
  if (last?.parts.some((p) => p.type === "tool_result")) return { text: `RESULT: ${textOf(req)}` };
  const m = textOf(req).match(/^CALL (\w+) ([\s\S]+)$/);
  if (m?.[1] && m[2]) return { toolCalls: [{ name: m[1], input: JSON.parse(m[2]) }] };
  return { text: "ok" };
}

describe("send_file of a project's file", () => {
  it("God sends it by its full path; an assistant without the project cannot", async () => {
    s = await startServer(script);
    const project = (
      await s.api<{ id: string; path: string }>("POST", "/api/projects", { name: "Collaudo" })
    ).body;
    await mkdir(project.path, { recursive: true });
    const file = join(project.path, "prova.txt");
    await writeFile(file, "ciao");
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      })
    ).body.id;
    const session = async (agentId: string) =>
      (await (s as Server).api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body
        .sessionId;
    const godSid = await session(god);
    await (await s.core.send("me", godSid, `CALL send_file ${JSON.stringify({ path: file })}`))
      .done;
    expect(textOf(s.provider.requests.at(-1))).toContain("Sent prova.txt to the person");
    const sent = await s.core.store.list({ types: ["file.sent"] });
    expect(sent.map((e) => e.payload)).toEqual([
      {
        scope: `project:${project.id}`,
        path: "prova.txt",
        name: "prova.txt",
        size: 4,
        mime: "text/plain",
      },
    ]);

    // The everyday Chat is an assistant: it sees no project.
    const chat = (await s.api<{ id: string }>("GET", "/api/chat/agent")).body.id;
    const chatSid = await session(chat);
    await (await s.core.send("me", chatSid, `CALL send_file ${JSON.stringify({ path: file })}`))
      .done;
    expect(textOf(s.provider.requests.at(-1))).toContain(
      `There is no file "${file}" in your workspace or in a project you may read.`,
    );
    expect(await s.core.store.list({ types: ["file.sent"] })).toHaveLength(1);
  });
});
