import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { redgiantAgent } from "@redgiant/acp";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, TOKEN } from "../../server/test/helpers.js";
import { RedGiantClient } from "../src/index.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
let closeEditor: (() => void) | undefined;
afterEach(async () => {
  closeEditor?.();
  closeEditor = undefined;
  await s?.close();
  s = undefined;
}, 60_000);

/** What the fake editor saw, and how it answers. */
interface Editor {
  updates: acp.SessionUpdate[];
  permissions: acp.RequestPermissionRequest[];
  reads: string[];
  writes: { path: string; content: string }[];
  answer: (r: acp.RequestPermissionRequest) => acp.RequestPermissionResponse;
  buffers: Map<string, string>;
}

/**
 * A fake ACP client (the editor) talking to `redgiant-acp` over in-process stdio, the bridge
 * talking to a real RedGiant server whose models are a FakeProvider.
 */
async function editorOn(server: Server, o: { fs?: boolean; agentId?: string } = {}) {
  const ed: Editor = {
    updates: [],
    permissions: [],
    reads: [],
    writes: [],
    buffers: new Map(),
    answer: (r) => ({ outcome: { outcome: "selected", optionId: r.options[0]?.optionId ?? "" } }),
  };
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const bridge = redgiantAgent({
    link: new RedGiantClient(server.url, TOKEN),
    ...(o.agentId && { agentId: o.agentId }),
  }).connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
  const conn = acp
    .client({ name: "fake-editor" })
    .onNotification("session/update", (ctx) => {
      ed.updates.push(ctx.params.update);
    })
    .onRequest("session/request_permission", (ctx) => {
      ed.permissions.push(ctx.params);
      return ed.answer(ctx.params);
    })
    .onRequest("fs/read_text_file", (ctx) => {
      ed.reads.push(ctx.params.path);
      const b = ed.buffers.get(ctx.params.path);
      if (b === undefined) throw acp.RequestError.resourceNotFound(ctx.params.path);
      return { content: b };
    })
    .onRequest("fs/write_text_file", (ctx) => {
      ed.writes.push({ path: ctx.params.path, content: ctx.params.content });
      ed.buffers.set(ctx.params.path, ctx.params.content);
      return {};
    })
    .connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
  closeEditor = () => {
    conn.close();
    bridge.close();
  };
  const init = await conn.agent.request("initialize", {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: o.fs ? { fs: { readTextFile: true, writeTextFile: true } } : {},
  });
  return { ed, agent: conn.agent, init };
}

const textOf = (updates: acp.SessionUpdate[], kind = "agent_message_chunk") =>
  updates
    .flatMap((u) => (u.sessionUpdate === kind && u.content.type === "text" ? [u.content.text] : []))
    .join("");

const lastIsTool = (req: CompletionRequest) =>
  req.messages.at(-1)?.parts.some((p) => p.type === "tool_result") === true;
const call = (name: string, input: unknown): FakeTurn => ({ toolCalls: [{ name, input }] });

async function people(server: Server, mode?: string) {
  const project = (
    await server.api<{ id: string; path: string }>("POST", "/api/projects", { name: "Shop" })
  ).body;
  const god = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      name: "God",
      parentId: null,
    })
  ).body;
  const orch = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      name: "Orch",
      parentId: god.id,
      projectId: project.id,
      ...(mode && { mode }),
    })
  ).body;
  return { project, god, orch };
}

describe("redgiant-acp: RedGiant as an agent inside editors (G38.6)", () => {
  it("streams a turn to the editor: thinking, text, a tool call and its result", async () => {
    s = await startServer((req) =>
      lastIsTool(req)
        ? { text: "It says hi." }
        : { thinking: "Let me read it.", ...call("read_file", { path: "hello.txt" }) },
    );
    const { god } = await people(s);
    // God's folder is the platform's.
    await mkdir(s.core.platformPath("me"), { recursive: true });
    await writeFile(join(s.core.platformPath("me"), "hello.txt"), "hi");
    const { ed, agent, init } = await editorOn(s);
    expect(init.agentInfo?.name).toBe("redgiant");
    expect(init.agentCapabilities?.loadSession).toBe(true);
    // A folder that is no project: God.
    const { sessionId } = await agent.request("session/new", {
      cwd: "/somewhere/else",
      mcpServers: [],
    });
    const sessions = (await s.api<{ id: string; agentId: string }[]>("GET", "/api/sessions")).body;
    expect(sessions.find((x) => x.id === sessionId)?.agentId).toBe(god.id);
    const r = await agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "What does hello.txt say?" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(textOf(ed.updates, "agent_thought_chunk")).toContain("Let me read it.");
    expect(textOf(ed.updates)).toContain("It says hi.");
    const tool = ed.updates.find((u) => u.sessionUpdate === "tool_call");
    expect(tool).toMatchObject({
      kind: "read",
      status: "in_progress",
      title: "read_file: hello.txt",
    });
    const done = ed.updates.find((u) => u.sessionUpdate === "tool_call_update");
    expect(done).toMatchObject({ status: "completed" });
  });

  it("asks the editor what RedGiant asks the person; the editor's answer counts as theirs", async () => {
    s = await startServer((req) =>
      lastIsTool(req) ? { text: "Done." } : call("bash", { command: "echo from-bash" }),
    );
    const { project, orch } = await people(s, "manual");
    const { ed, agent } = await editorOn(s);
    // The editor shows the project's folder: its orchestrator answers.
    const { sessionId } = await agent.request("session/new", { cwd: project.path, mcpServers: [] });
    const sessions = (await s.api<{ id: string; agentId: string }[]>("GET", "/api/sessions")).body;
    expect(sessions.find((x) => x.id === sessionId)?.agentId).toBe(orch.id);
    const r = await agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(r.stopReason).toBe("end_turn");
    expect(ed.permissions).toHaveLength(1);
    expect(ed.permissions[0]?.toolCall.title).toMatch(/Orch: bash: echo from-bash/);
    expect(ed.permissions[0]?.options.map((x) => x.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    const result = ed.updates.find((u) => u.sessionUpdate === "tool_call_update");
    expect(result).toMatchObject({ status: "completed" });
    const events = (
      await s.api<{ type: string; payload: { via?: string; by?: string } }[]>(
        "GET",
        `/api/sessions/${sessionId}/events`,
      )
    ).body;
    const resolved = events.find(
      (e) => e.type === "permission.resolved" && e.payload.by === "human",
    );
    expect(resolved?.payload.via).toBe("editor");
  });

  it("a no in the editor is a no: the tool does not run", async () => {
    s = await startServer((req) =>
      lastIsTool(req) ? { text: "Understood." } : call("bash", { command: "echo nope > no.txt" }),
    );
    const { project } = await people(s, "manual");
    const { ed, agent } = await editorOn(s);
    ed.answer = () => ({ outcome: { outcome: "selected", optionId: "deny" } });
    const { sessionId } = await agent.request("session/new", { cwd: project.path, mcpServers: [] });
    await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(ed.updates.find((u) => u.sessionUpdate === "tool_call_update")).toMatchObject({
      status: "failed",
    });
    await expect(readFile(join(project.path, "no.txt"), "utf8")).rejects.toThrow();
  });

  it("reads and writes the open project's files through the editor (its unsaved buffers)", async () => {
    s = await startServer((req) => {
      const results = req.messages.filter((m) =>
        m.parts.some((p) => p.type === "tool_result"),
      ).length;
      if (results === 0) return call("read_file", { path: "notes.txt" });
      if (results === 1) return call("write_file", { path: "notes.txt", content: "rewritten" });
      return { text: "ok" };
    });
    const { project } = await people(s);
    await writeFile(join(project.path, "notes.txt"), "ON DISK");
    const { ed, agent } = await editorOn(s, { fs: true });
    const abs = join(project.path, "notes.txt");
    ed.buffers.set(abs, "UNSAVED IN THE EDITOR");
    const { sessionId } = await agent.request("session/new", { cwd: project.path, mcpServers: [] });
    await agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "edit notes" }],
    });
    // read_file, then write_file reading what it replaces (its diff): both from the editor.
    expect(ed.reads).toEqual([abs, abs]);
    const read = (s.provider.requests[1]?.messages.at(-1)?.parts ?? []).flatMap((p) =>
      p.type === "tool_result" ? [p.content] : [],
    );
    expect(read.join("")).toContain("UNSAVED IN THE EDITOR");
    expect(ed.writes).toEqual([{ path: abs, content: "rewritten" }]);
    // The editor saves when the person wants: the disk is untouched.
    expect(await readFile(abs, "utf8")).toBe("ON DISK");
  });

  it("an editor without files, or on another folder, leaves the files on the disk", async () => {
    s = await startServer((req) =>
      lastIsTool(req) ? { text: "ok" } : call("read_file", { path: "notes.txt" }),
    );
    const { project } = await people(s);
    await writeFile(join(project.path, "notes.txt"), "ON DISK");
    const { ed, agent } = await editorOn(s, { fs: false });
    const { sessionId } = await agent.request("session/new", { cwd: project.path, mcpServers: [] });
    await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "read" }] });
    expect(ed.reads).toEqual([]);
    expect(JSON.stringify(s.provider.requests.at(-1)?.messages.at(-1))).toContain("ON DISK");
  });

  it("cancels: session/cancel stops RedGiant's turn and the prompt ends as cancelled", async () => {
    s = await startServer((req) =>
      lastIsTool(req)
        ? { text: "stopped" }
        : call("bash", { command: `node -e "setTimeout(() => {}, 30000)"` }),
    );
    const { ed, agent } = await editorOn(s);
    await people(s);
    const { sessionId } = await agent.request("session/new", { cwd: "/elsewhere", mcpServers: [] });
    const pending = agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    for (let i = 0; i < 100 && !ed.updates.some((u) => u.sessionUpdate === "tool_call"); i++)
      await new Promise((r) => setTimeout(r, 50));
    await agent.notify("session/cancel", { sessionId });
    expect((await pending).stopReason).toBe("cancelled");
  });

  it("loads an earlier conversation and replays it; «@name» chooses another agent", async () => {
    s = await startServer(() => ({ text: "Hello there." }));
    const { orch } = await people(s);
    const first = await editorOn(s);
    const { sessionId } = await first.agent.request("session/new", { cwd: "/x", mcpServers: [] });
    await first.agent.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "@Orch hi" }],
    });
    // The first prompt chose the orchestrator: its conversation got the message without «@Orch».
    const mine = (
      await s.api<{ id: string; agentId: string }[]>("GET", `/api/sessions?agentId=${orch.id}`)
    ).body;
    expect(mine).toHaveLength(1);
    const orchEvents = (
      await s.api<{ type: string; payload: { text?: string } }[]>(
        "GET",
        `/api/sessions/${mine[0]?.id}/events`,
      )
    ).body;
    expect(orchEvents.find((e) => e.type === "message.user")?.payload.text).toBe("hi");
    expect(textOf(first.ed.updates)).toContain("Hello there.");
    closeEditor?.();

    // Another editor window opens the orchestrator's conversation again.
    const second = await editorOn(s);
    await second.agent.request("session/load", {
      sessionId: mine[0]?.id ?? "",
      cwd: "/x",
      mcpServers: [],
    });
    expect(textOf(second.ed.updates, "user_message_chunk")).toBe("hi");
    expect(textOf(second.ed.updates)).toBe("Hello there.");
  });
});
