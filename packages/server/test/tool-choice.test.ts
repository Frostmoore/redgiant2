// The tools page (G34.5): the person switches common tools off for every agent or agent by agent;
// essential tools never go; a conversation keeps the set it started with; every change is in the
// history with what it replaced, and undoable.
import type { Event, ToolsView } from "@redgiant/protocol";
import { invalidToolIds, TOOL_CATALOG, toolEntryOf, toolsSwitchedOff } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformChange } from "../src/index.js";
import { toolChars, toolsView } from "../src/tool-choice.js";
import { OTHER, startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

// Room for every tool's description: the fake model's 8192 tokens would summarise mid-turn.
const ROOM = { contextWindow: 65_536 };

async function team(server: Server) {
  const god = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  await server.api("POST", "/api/projects", { name: "P" });
  const orch = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: god.body.id,
    projectId: "p",
    name: "Orchestra",
  });
  const coder = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "agent",
    parentId: orch.body.id,
    name: "Coder",
  });
  return { god: god.body.id, orch: orch.body.id, coder: coder.body.id };
}

const newSession = async (server: Server, agentId: string) =>
  (await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId })).body.sessionId;

/** The tool names of the latest request the model received. */
const lastTools = (server: Server) =>
  (server.provider.requests.at(-1)?.tools ?? []).map((t) => t.name);

describe("the catalog (G34.5)", () => {
  it("maps tools to entries, families included, and leaves MCP and custom tools out", () => {
    expect(toolEntryOf("read_file")?.id).toBe("read_file");
    expect(toolEntryOf("browser_click")?.id).toBe("browser");
    expect(toolEntryOf("platform_code_start")?.id).toBe("platform_code");
    expect(toolEntryOf("run_subagents")?.id).toBe("subagents");
    expect(toolEntryOf("board_post")?.id).toBe("board");
    expect(toolEntryOf("publish_board")?.id).toBe("publish_board");
    expect(toolEntryOf("show")?.id).toBe("show");
    expect(toolEntryOf("github__create_issue")).toBeUndefined();
    expect(new Set(TOOL_CATALOG.map((e) => e.id)).size).toBe(TOOL_CATALOG.length);
  });

  it("never switches an essential tool off, whatever the choice", () => {
    const choice = {
      off: ["web_search", "complete_task"],
      agents: { a: { delegate: "off" as const, fetch: "off" as const, web_search: "on" as const } },
    };
    const names = ["complete_task", "delegate", "fetch", "web_search", "mcp__x", "read_file"];
    expect(toolsSwitchedOff(choice, "a", names)).toEqual(["fetch"]);
    expect(toolsSwitchedOff(choice, "b", names)).toEqual(["web_search"]);
    expect(invalidToolIds(["complete_task", "nope", "fetch"])).toEqual({
      unknown: ["nope"],
      essential: ["complete_task"],
    });
  });

  it("weighs each entry by its tools' definitions, and totals what is on", () => {
    const measured = new Map([
      ["fetch", 350],
      ["web_search", 700],
      ["browser_open", 100],
      ["browser_click", 250],
      ["read_file", 35],
      ["mcp__x", 9999],
    ]);
    const v = toolsView({ off: ["web_search"], agents: { a: { fetch: "off" } } }, measured, null);
    expect(v.entries.map((e) => [e.id, e.chars, e.tokens, e.global])).toEqual([
      ["read_file", 35, 10, true],
      ["fetch", 350, 100, true],
      ["web_search", 700, 200, false],
      ["browser", 350, 100, true],
    ]);
    expect(v.total).toBe(210);
    expect(v.saved).toBe(200);
    const a = toolsView({ off: ["web_search"], agents: { a: { fetch: "off" } } }, measured, "a");
    expect(a.entries.find((e) => e.id === "fetch")).toMatchObject({ own: "off", on: false });
    expect(a.entries.find((e) => e.id === "read_file")).toMatchObject({ own: null, on: true });
    expect(a.total).toBe(110);
    expect(a.saved).toBe(300);
    expect(toolChars({ def: { name: "x", description: "d", inputSchema: {} } })).toBe(
      JSON.stringify({ name: "x", description: "d", input_schema: {} }).length,
    );
  });
});

describe("tools switched off (G34.5)", () => {
  it("leaves them out of new conversations, records them at the start and says so", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { coder } = await team(s);
    const put = await s.api<PlatformChange>("PUT", "/api/tools", { off: ["web_search", "fetch"] });
    expect(put.status).toBe(200);
    const sid = await newSession(s, coder);
    await (await s.core.send("me", sid, "hi")).done;
    const tools = lastTools(s);
    expect(tools).not.toContain("web_search");
    expect(tools).not.toContain("fetch");
    // Essential and other tools stay, still sorted by name.
    for (const t of ["read_file", "bash", "complete_task", "conversation_history", "show_file"])
      expect(tools).toContain(t);
    expect(tools).toEqual([...tools].sort());
    expect(s.provider.requests.at(-1)?.system).toContain("switched these tools off for you");
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    const started = events.find((e) => e.type === "session.started");
    expect(started?.payload).toMatchObject({ toolsOff: ["fetch", "web_search"] });
  });

  it("keeps an open conversation's tools as they were, also when it is rebuilt", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { coder } = await team(s);
    const open = await newSession(s, coder);
    await (await s.core.send("me", open, "first")).done;
    const before = lastTools(s);
    expect(before).toContain("web_search");
    await s.api("PUT", "/api/tools", { off: ["web_search"] });
    await (await s.core.send("me", open, "second")).done;
    expect(lastTools(s)).toEqual(before);
    // Rebuilt from the log (a model change drops it from memory): still the same set.
    s.core.agentModelChanged(coder);
    await (await s.core.send("me", open, "third")).done;
    expect(lastTools(s)).toEqual(before);
    // The other way round: started with it off, switched back on, it stays off.
    const later = await newSession(s, coder);
    await (await s.core.send("me", later, "hi")).done;
    expect(lastTools(s)).not.toContain("web_search");
    const system = s.provider.requests.at(-1)?.system;
    await s.api("PUT", "/api/tools", { off: [] });
    s.core.agentModelChanged(coder);
    await (await s.core.send("me", later, "again")).done;
    expect(lastTools(s)).not.toContain("web_search");
    expect(s.provider.requests.at(-1)?.system).toBe(system);
    // A new one gets it again.
    const fresh = await newSession(s, coder);
    await (await s.core.send("me", fresh, "hi")).done;
    expect(lastTools(s)).toContain("web_search");
  });

  it("lets one agent differ from the rule for everyone", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { god, coder } = await team(s);
    await s.api("PUT", "/api/tools", { off: ["web_search"] });
    const own = await s.api("PUT", `/api/agents/${coder}/tools`, {
      tools: { web_search: "on", show_file: "off" },
    });
    expect(own.status).toBe(200);
    const c = await newSession(s, coder);
    await (await s.core.send("me", c, "hi")).done;
    expect(lastTools(s)).toContain("web_search");
    expect(lastTools(s)).not.toContain("show_file");
    const g = await newSession(s, god);
    await (await s.core.send("me", g, "hi")).done;
    expect(lastTools(s)).not.toContain("web_search");
    expect(lastTools(s)).toContain("show_file");
    // Back to the rule for everyone.
    await s.api("PUT", `/api/agents/${coder}/tools`, { tools: { web_search: "default" } });
    const v = (await s.api<ToolsView>("GET", `/api/tools?agentId=${coder}`)).body;
    expect(v.entries.find((e) => e.id === "web_search")).toMatchObject({ own: null, on: false });
    expect(v.entries.find((e) => e.id === "show_file")).toMatchObject({ own: "off", on: false });
  });

  it("refuses essential and unknown tools, also through the API", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { coder } = await team(s);
    const essential = await s.api<{ error: string }>("PUT", "/api/tools", {
      off: ["complete_task"],
    });
    expect(essential.status).toBe(400);
    expect(essential.body.error).toContain("essential");
    for (const id of ["delegate", "read_file", "ask_user", "conversation_history"])
      expect(
        (await s.api("PUT", `/api/agents/${coder}/tools`, { tools: { [id]: "off" } })).status,
      ).toBe(400);
    expect((await s.api("PUT", "/api/tools", { off: ["no_such_tool"] })).status).toBe(400);
    expect((await s.api("PUT", "/api/tools", { off: "fetch" })).status).toBe(400);
    expect(
      (await s.api("PUT", `/api/agents/${coder}/tools`, { tools: { fetch: "maybe" } })).status,
    ).toBe(400);
    // Nothing was kept.
    expect(await s.core.toolChoices.get("me")).toEqual({ off: [], agents: {} });
  });

  it("is the person's alone: not another owner's, not an agent's", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { god, coder } = await team(s);
    expect(
      (await s.api("PUT", `/api/agents/${coder}/tools`, { tools: { fetch: "off" } }, OTHER)).status,
    ).toBe(404);
    await expect(s.core.config.setTools("me", god, { off: ["fetch"], agents: {} })).rejects.toThrow(
      "Only the person",
    );
    expect(await s.core.toolChoices.get("me")).toEqual({ off: [], agents: {} });
  });

  it("weighs each agent's tools with what it gets, and every agent's on the page", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { god, coder } = await team(s);
    await s.api("PUT", "/api/tools", { off: ["web_search"] });
    const all = (await s.api<ToolsView>("GET", "/api/tools")).body;
    const ids = all.entries.map((e) => e.id);
    // God's platform tools and the agents' complete_task are both on the page.
    expect(ids).toContain("platform_mcp");
    expect(ids).toContain("complete_task");
    const ws = all.entries.find((e) => e.id === "web_search");
    expect(ws).toMatchObject({ global: false, essential: false });
    expect(ws?.tokens).toBe(Math.ceil((ws?.chars ?? 0) / 3.5));
    expect(all.entries.find((e) => e.id === "complete_task")).toMatchObject({
      essential: true,
      global: true,
    });
    expect(all.saved).toBe(ws?.tokens);
    // One agent: only its own tools, measured as the model receives them.
    const mine = (await s.api<ToolsView>("GET", `/api/tools?agentId=${coder}`)).body;
    expect(mine.entries.map((e) => e.id)).not.toContain("platform_mcp");
    const sid = await newSession(s, coder);
    await (await s.core.send("me", sid, "hi")).done;
    const sent = s.provider.requests.at(-1)?.tools ?? [];
    const fetchDef = sent.find((t) => t.name === "fetch");
    expect(mine.entries.find((e) => e.id === "fetch")?.chars).toBe(
      toolChars({ def: fetchDef as never }),
    );
    // What the agent gets now is exactly what is on in its view (outside the catalog: none here).
    const onNames = mine.entries.filter((e) => e.on).flatMap((e) => e.tools);
    expect(sent.map((t) => t.name).sort()).toEqual(onNames.sort());
    expect(mine.total).toBe(mine.entries.filter((e) => e.on).reduce((n, e) => n + e.tokens, 0));
    expect((await s.api("GET", "/api/tools?agentId=nobody")).status).toBe(404);
    expect((await s.api<ToolsView>("GET", `/api/tools?agentId=${god}`)).status).toBe(200);
  });

  it("records every change with what it replaced, and undoes only the part it touched", async () => {
    s = await startServer(() => ({ text: "ok" }), ROOM);
    const { coder } = await team(s);
    const g = (await s.api<PlatformChange>("PUT", "/api/tools", { off: ["fetch"] })).body;
    expect(g).toMatchObject({
      kind: "config",
      target: "tools",
      before: { off: [], agents: {} },
      after: { off: ["fetch"], agents: {} },
      by: "human",
    });
    const a = (
      await s.api<PlatformChange>("PUT", `/api/agents/${coder}/tools`, {
        tools: { fetch: "on", browser: "off" },
      })
    ).body;
    expect(a.target).toBe(`tools:${coder}`);
    expect(a.change).toBe("Tools of Coder");
    const history = (await s.api<PlatformChange[]>("GET", "/api/platform/changes")).body;
    expect(history.map((c) => c.id)).toEqual(expect.arrayContaining([g.id, a.id]));
    // Undoing the rule for everyone keeps the agent's exceptions.
    const u = await s.api<PlatformChange>("POST", `/api/platform/changes/${g.id}/undo`);
    expect(u.status).toBe(200);
    expect(await s.core.toolChoices.get("me")).toEqual({
      off: [],
      agents: { [coder]: { fetch: "on", browser: "off" } },
    });
    // Undoing the agent's change brings back its empty exceptions, not the old rule.
    await s.api("PUT", "/api/tools", { off: ["web_search"] });
    await s.api("POST", `/api/platform/changes/${a.id}/undo`);
    expect(await s.core.toolChoices.get("me")).toEqual({ off: ["web_search"], agents: {} });
    const undone = (await s.api<PlatformChange[]>("GET", "/api/platform/changes")).body.find(
      (c) => c.id === g.id,
    );
    expect(undone?.stage).toBe("undone");
  });
});
