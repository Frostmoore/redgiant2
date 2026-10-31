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

const toolNames = (req: CompletionRequest) => req.tools.map((t) => t.name);
const results = (req: CompletionRequest) =>
  req.messages.flatMap((m) =>
    m.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : [])),
  );

describe("extensions end to end", () => {
  it("an agent's tool exists for no one until the user approves it", async () => {
    const seen: string[][] = [];
    s = await startServer((req) => {
      seen.push(toolNames(req));
      const done = results(req);
      const last = req.messages.at(-1);
      const asked =
        last?.role === "user" && last.parts[0]?.type === "text" ? last.parts[0].text : "";
      if (asked === "build it" && done.length === 0) {
        return {
          toolCalls: [
            {
              name: "propose_extension",
              input: {
                kind: "tool",
                name: "word-count",
                description: "Counts the words of a text",
                input_schema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
                command: "node count.mjs",
                files: {
                  "count.mjs":
                    "import { readFileSync } from 'node:fs';\nconsole.log(JSON.parse(readFileSync(process.argv[2], 'utf8')).text.split(/\\s+/).length);\n",
                },
                tests: [{ input: { text: "a b c" }, expectStdoutContains: "3" }],
              },
            },
          ],
        };
      }
      if (asked === "use it" && done.length === 0)
        return { toolCalls: [{ name: "word-count", input: { text: "one two three four five" } }] };
      return { text: done.at(-1) ?? "ok" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    await s.api("POST", "/api/projects", { name: "X" });
    const orch = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      parentId: god.body.id,
      projectId: "x",
      name: "O",
    });
    const start = async () =>
      (await s?.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: orch.body.id }))
        ?.body.sessionId ?? "";

    await (await s.core.send("me", await start(), "build it")).done;
    const [pending] = (
      await s.api<{ id: string; status: string; report: { passed: boolean }[] }[]>(
        "GET",
        "/api/extensions/proposals?status=pending",
      )
    ).body;
    expect(pending?.report.every((r) => r.passed)).toBe(true);

    // Before approval: a new session does not have the tool.
    await (await s.core.send("me", await start(), "hello")).done;
    expect(seen.at(-1)).not.toContain("word-count");

    expect(
      (
        await s.api("POST", `/api/extensions/proposals/${pending?.id}/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(200);
    const sid = await start();
    await (await s.core.send("me", sid, "use it")).done;
    expect(seen.at(-1)).toContain("word-count");
    const used = (await s.core.store.list({ sessionId: sid })).find(
      (e) => e.type === "tool.result",
    );
    expect((used?.payload as { output: string } | undefined)?.output.trim()).toBe("5");
  });

  it("puts approved skills in the prompt and MCP servers' tools in the agents' hands", async () => {
    const seen: CompletionRequest[] = [];
    s = await startServer((req) => {
      seen.push(req);
      return { text: "ok" };
    });
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const skill = await s.api<{ status: string }>("POST", "/api/extensions/proposals", {
      projectId: null,
      input: {
        kind: "skill",
        name: "tone",
        description: "House tone of voice",
        body: "Friendly and direct.",
        untestableReason: "Tone is judged by reading it.",
      },
    });
    expect(skill.body.status).toBe("installed");
    expect(
      (
        await s.api("PUT", "/api/extensions/mcp", {
          name: "echo",
          projectId: null,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [join(here, "../../extensions/test/mcp-server.mjs")],
          },
        })
      ).status,
    ).toBe(200);
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;
    await (await s.core.send("me", sid, "hi")).done;
    const req = seen.at(-1);
    expect(req?.system).toMatch(/## Skills[\s\S]*- tone: House tone of voice/);
    expect(req?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["skill_load", "skill_file", "mcp__echo__shout", "propose_extension"]),
    );
  });
});
