// 3.5.3 (collaudo della 3.5.1, punto 9a): «Trovare file sul computer» switched off in Settings >
// Tools was still used by God in a new conversation, and God had no request_tool. Every kind of
// agent that gets base tools must leave a switched-off tool out of a new conversation, record it in
// session.started.toolsOff and get request_tool; one agent's own choice must show on the page for
// every agent, and a sub-agent follows the choice made for its parent.
import type { Event, ToolsView } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const ROOM = { contextWindow: 65_536 };

async function everyone(server: Server) {
  const make = async (body: Record<string, unknown>) =>
    (await server.api<{ id: string }>("POST", "/api/agents", body)).body.id;
  const god = await make({ kind: "god", parentId: null, name: "God" });
  await server.api("POST", "/api/projects", { name: "P" });
  const orch = await make({ kind: "orchestrator", parentId: god, projectId: "p", name: "Lead" });
  const coder = await make({ kind: "agent", parentId: orch, name: "Coder" });
  const sub = await make({ kind: "subagent", parentId: coder, name: "Helper" });
  const assistant = await make({ kind: "assistant", parentId: god, name: "Mail" });
  const chat = (await server.core.chatAgent("me")).id;
  return { god, orch, coder, sub, assistant, chat };
}

/** A new conversation's first request: its tools, its system prompt and its start in the log. */
async function start(server: Server, agentId: string) {
  const sid = await server.core.startSession("me", agentId);
  await (await server.core.send("me", sid, "hi")).done;
  const req = server.provider.requests.at(-1);
  const events = (await server.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
  const started = events.find((e) => e.type === "session.started");
  return {
    tools: (req?.tools ?? []).map((t) => t.name),
    system: req?.system ?? "",
    toolsOff: (started?.payload as { toolsOff?: string[] } | undefined)?.toolsOff ?? [],
  };
}

describe("a tool switched off for every agent (3.5.3)", () => {
  it("is left out of every kind of agent's new conversation, which gets request_tool", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const ids = await everyone(s);
    expect((await s.api("PUT", "/api/tools", { off: ["find_files"] })).status).toBe(200);
    for (const [kind, id] of Object.entries(ids)) {
      const c = await start(s, id);
      expect(c.tools, kind).not.toContain("find_files");
      expect(c.tools, kind).toContain("request_tool");
      expect(c.toolsOff, kind).toEqual(["find_files"]);
      expect(c.system, kind).toContain("- find_files:");
      // Nothing in the prompt points to a tool it does not have.
      expect(c.system, kind).not.toContain("use glob and grep inside it, and find_files");
    }
  });

  it("God, from the HTTP API as the page does it: off, then asked for and switched back on", async () => {
    let step = 0;
    s = await startServer((req) => {
      step++;
      if (step === 1) {
        expect(req.tools.map((t) => t.name)).not.toContain("find_files");
        return {
          toolCalls: [{ name: "request_tool", input: { tool: "find_files", why: "find node" } }],
        };
      }
      return { text: "done" };
    }, ROOM);
    const { god } = await everyone(s);
    await s.api("PUT", "/api/tools", { off: ["find_files"] });
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god })).body
      .sessionId;
    // The person says yes for this conversation, from the page.
    const server = s;
    server.core.approvals.on("request", (owner, info) => {
      if (info.tool !== "request_tool") return;
      server.core.toolRequestScope(info.requestId, "session");
      server.core.approvals.decide(owner, info.requestId, "allow");
    });
    await (await s.core.send("me", sid, "where is node?")).done;
    expect((s.provider.requests.at(-1)?.tools ?? []).map((t) => t.name)).toContain("find_files");
  });

  it("an agent of a project, switched off for it alone, keeps it off and asks for it", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { god, coder, sub } = await everyone(s);
    await s.api("PUT", `/api/agents/${coder}/tools`, { tools: { find_files: "off" } });
    const c = await start(s, coder);
    expect(c.tools).not.toContain("find_files");
    expect(c.tools).toContain("request_tool");
    // Its sub-agent, made for one run, follows the choice made for it.
    const h = await start(s, sub);
    expect(h.tools).not.toContain("find_files");
    expect(h.toolsOff).toEqual(["find_files"]);
    // God was not touched: it has the tool, and nothing to ask for.
    const g = await start(s, god);
    expect(g.tools).toContain("find_files");
    expect(g.tools).not.toContain("request_tool");
  });

  it("says on the page for every agent when one agent keeps it on by its own choice", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { god } = await everyone(s);
    // As after «always for this agent» on an earlier request_tool.
    await s.api("PUT", `/api/agents/${god}/tools`, { tools: { find_files: "on" } });
    await s.api("PUT", "/api/tools", { off: ["find_files"] });
    const view = (await s.api<ToolsView>("GET", "/api/tools")).body;
    const entry = view.entries.find((e) => e.id === "find_files");
    expect(entry).toMatchObject({
      global: false,
      exceptions: [{ agentId: god, name: "God", state: "on" }],
    });
    expect((await start(s, god)).tools).toContain("find_files");
    // Back to the rule for everyone: off for God too.
    await s.api("PUT", `/api/agents/${god}/tools`, { tools: { find_files: "default" } });
    const again = (await s.api<ToolsView>("GET", "/api/tools")).body;
    expect(again.entries.find((e) => e.id === "find_files")?.exceptions).toBeUndefined();
    expect((await start(s, god)).tools).not.toContain("find_files");
  });
});
