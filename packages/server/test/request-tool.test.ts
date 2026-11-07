// Asking for a switched-off tool (G36.15): the agent sees it by name, asks with request_tool, the
// person answers like any approval. Yes for this conversation adds it to the running session (one
// session.tools_added event, the prefix rebuilt once); "always" also changes the agent's tools in
// the history; a no, or no answer in time, leaves it off. Resuming from the log keeps it all.
import type { Event, PermissionRequestInfo } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformChange } from "../src/index.js";
import { switchedOffSection } from "../src/request-tool.js";
import { startServer } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const ROOM = { contextWindow: 65_536 };
const names = (r: CompletionRequest | undefined) => (r?.tools ?? []).map((t) => t.name);
const resultOf = (r: CompletionRequest | undefined) =>
  r?.messages
    .at(-1)
    ?.parts.flatMap((p) => (p.type === "tool_result" ? [p.content] : []))
    .join("") ?? "";

/** The model asks for fetch, then (after the answer) says what it saw; later turns just answer. */
function script(): (req: CompletionRequest, i: number) => FakeTurn {
  return (req) => {
    const last = req.messages.at(-1);
    const fromTool = last?.parts.some((p) => p.type === "tool_result");
    const said = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
    if (!fromTool && said.includes("need the web"))
      return {
        toolCalls: [{ name: "request_tool", input: { tool: "fetch", why: "to read the page" } }],
      };
    return { text: "done" };
  };
}

async function setup(server: Server) {
  const god = (
    await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    })
  ).body.id;
  await server.api("PUT", `/api/agents/${god}/tools`, { tools: { fetch: "off" } });
  const sid = (await server.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god }))
    .body.sessionId;
  return { god, sid };
}

/** Answers every request_tool as the person would, from the web page. */
function answer(server: Server, decision: "allow" | "deny", scope?: "session" | "always") {
  const seen: PermissionRequestInfo[] = [];
  server.core.approvals.on("request", (owner, info) => {
    seen.push(info);
    if (info.tool !== "request_tool") return;
    server.core.toolRequestScope(info.requestId, scope);
    server.core.approvals.decide(
      owner,
      info.requestId,
      decision,
      decision === "deny" ? "not now" : undefined,
    );
  });
  return seen;
}

describe("request_tool (G36.15)", () => {
  it("lists switched-off tools by name with a short line, and how to ask", () => {
    const tool = (name: string, description: string) =>
      ({ def: { name, description, inputSchema: {} }, run: async () => "" }) as never;
    const text = switchedOffSection(
      ["fetch", "browser_open", "browser_click"],
      [
        tool("fetch", "Fetches a web page as text. Use it for pages you know."),
        tool("browser_open", "Opens a real browser on a page. It is slow."),
        tool("browser_click", "Clicks."),
      ],
    );
    expect(text).toContain("- browser: Opens a real browser on a page.");
    expect(text).toContain("- fetch: Fetches a web page as text.");
    expect(text).not.toContain("Use it for pages");
    expect(text).toContain("request_tool");
  });

  it("switches it on for this conversation after a yes, once, and keeps it after a rebuild", async () => {
    s = await startServer(script(), ROOM);
    const { god, sid } = await setup(s);
    const seen = answer(s, "allow", "session");
    await (await s.core.send("me", sid, "I need the web")).done;
    const reqs = s.provider.requests;
    expect(names(reqs[0])).not.toContain("fetch");
    expect(names(reqs[0])).toContain("request_tool");
    expect(reqs[0]?.system).toContain("- fetch: ");
    expect(seen.find((r) => r.tool === "request_tool")).toMatchObject({
      agentName: "God",
      input: { tool: "fetch", why: "to read the page" },
      sessionId: sid,
    });
    // The next step of the same turn has it, sorted with the others; the system prompt is the same.
    expect(names(reqs[1])).toContain("fetch");
    expect(names(reqs[1])).toEqual([...names(reqs[1])].sort());
    expect(reqs[1]?.system).toBe(reqs[0]?.system);
    expect(resultOf(reqs[1])).toContain("fetch is on");

    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    const added = events.filter((e) => e.type === "session.tools_added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({
      tools: ["fetch"],
      entry: "fetch",
      why: "to read the page",
      scope: "session",
    });
    // Only this conversation: the agent's own choice is unchanged.
    expect((await s.core.toolChoices.get("me")).agents[god]).toEqual({ fetch: "off" });

    // Rebuilt from the log, as after a restart: same tools, same system prompt.
    const tools = names(reqs.at(-1));
    s.core.agentModelChanged(god);
    await (await s.core.send("me", sid, "go on")).done;
    expect(names(s.provider.requests.at(-1))).toEqual(tools);
    expect(s.provider.requests.at(-1)?.system).toBe(reqs[0]?.system);

    // A new conversation starts without it again.
    const fresh = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god }))
      .body.sessionId;
    await (await s.core.send("me", fresh, "hello")).done;
    expect(names(s.provider.requests.at(-1))).not.toContain("fetch");
  });

  it("keeps it on for the agent when the person says always, as an undoable change", async () => {
    s = await startServer(script(), ROOM);
    const { god, sid } = await setup(s);
    answer(s, "allow", "always");
    await (await s.core.send("me", sid, "I need the web")).done;
    expect(names(s.provider.requests[1])).toContain("fetch");
    expect((await s.core.toolChoices.get("me")).agents[god]).toBeUndefined();
    const changes = (await s.api<PlatformChange[]>("GET", "/api/platform/changes")).body;
    expect(changes[0]).toMatchObject({
      change: "Tools of God",
      target: `tools:${god}`,
      by: "human",
    });
    const fresh = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god }))
      .body.sessionId;
    await (await s.core.send("me", fresh, "hello")).done;
    expect(names(s.provider.requests.at(-1))).toContain("fetch");
  });

  it("leaves it off after a no, and when nobody answers in time", async () => {
    s = await startServer(script(), ROOM);
    const { sid } = await setup(s);
    answer(s, "deny");
    await (await s.core.send("me", sid, "I need the web")).done;
    expect(names(s.provider.requests[1])).not.toContain("fetch");
    expect(resultOf(s.provider.requests[1])).toContain("did not switch fetch on: not now");

    s.core.approvals.removeAllListeners("request");
    s.core.requestToolTimeoutMs = 30;
    await (await s.core.send("me", sid, "I need the web")).done;
    const last = s.provider.requests.at(-1);
    expect(names(last)).not.toContain("fetch");
    expect(resultOf(last)).toContain("did not switch fetch on");
    expect(s.core.approvals.list("me")).toHaveLength(0);
    const events = (await s.api<Event[]>("GET", `/api/sessions/${sid}/events`)).body;
    expect(events.some((e) => e.type === "session.tools_added")).toBe(false);
  });

  it("says what is off when asked for a tool that is not", async () => {
    s = await startServer(
      (req) =>
        req.messages.at(-1)?.parts.some((p) => p.type === "tool_result")
          ? { text: "ok" }
          : { toolCalls: [{ name: "request_tool", input: { tool: "blender3", why: "x" } }] },
      ROOM,
    );
    const { sid } = await setup(s);
    await (await s.core.send("me", sid, "go")).done;
    expect(resultOf(s.provider.requests[1])).toContain("Switched off: fetch");
  });
});

describe("the tools an agent starts with, chosen by its creator (G36.14)", () => {
  it("switches off what God says its job does not need, never an essential one, undoably", async () => {
    let created = "";
    s = await startServer((req) => {
      const last = req.messages.at(-1);
      const r = last?.parts.find((p) => p.type === "tool_result");
      if (r && r.type === "tool_result") {
        created = r.content;
        return { text: "made" };
      }
      return {
        toolCalls: [
          {
            name: "create_agent",
            input: {
              kind: "assistant",
              name: "Mail",
              role: "Writes my emails",
              tools_off: [
                { tool: "browser", why: "emails only" },
                { tool: "blender", why: "no 3D" },
                { tool: "read_file", why: "not needed" },
                { tool: "nope", why: "x" },
              ],
            },
          },
        ],
      };
    }, ROOM);
    const god = (
      await s.api<{ id: string }>("POST", "/api/agents", {
        kind: "god",
        parentId: null,
        name: "God",
      })
    ).body.id;
    const sid = (await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god })).body
      .sessionId;
    await (await s.core.send("me", sid, "make me a mail assistant")).done;
    const mail = s.core.registry.list({ ownerId: "me" }).find((a) => a.name === "Mail");
    expect(mail).toBeDefined();
    const id = mail?.id ?? "";
    expect((await s.core.toolChoices.get("me")).agents[id]).toEqual({
      browser: "off",
      blender: "off",
    });
    expect(created).toContain("Switched off for it: browser (emails only); blender (no 3D)");
    expect(created).toContain("Not switched off (unknown or essential): read_file, nope");
    const changes = (await s.api<PlatformChange[]>("GET", "/api/platform/changes")).body;
    const c = changes.find((x) => x.target === `tools:${id}`);
    expect(c).toMatchObject({ by: god });
    expect(c?.change).toContain("chosen when it was created");
    // The person sees it on the agent's Tools tab, and can take it back.
    const view = (
      await s.api<{ entries: { id: string; own: string | null }[] }>(
        "GET",
        `/api/tools?agentId=${id}`,
      )
    ).body;
    expect(view.entries.find((e) => e.id === "blender")?.own).toBe("off");
    expect((await s.api("POST", `/api/platform/changes/${c?.id}/undo`)).status).toBe(200);
    expect((await s.core.toolChoices.get("me")).agents[id]).toBeUndefined();
    // Only for an agent it has just made under itself.
    await expect(
      s.core.toolsAtCreation("me", "someone", id, [{ tool: "fetch", why: "x" }]),
    ).rejects.toThrow();
  });
});
