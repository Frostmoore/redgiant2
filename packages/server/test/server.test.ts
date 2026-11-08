import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { OTHER, startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

/** God → orchestrator → agent, with a project. */
async function tree(server: Server, mode: "auto" | "manual" = "auto") {
  const { api } = server;
  const project = await api<{ id: string }>("POST", "/api/projects", { name: "Demo Project" });
  const god = await api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const orch = await api<{ id: string }>("POST", "/api/agents", {
    kind: "orchestrator",
    parentId: god.body.id,
    projectId: "demo-project",
    name: "Orchestrator",
  });
  const agent = await api<{ id: string }>("POST", "/api/agents", {
    kind: "agent",
    parentId: orch.body.id,
    name: "Coder",
    mode,
  });
  return { project: project.body.id, god: god.body.id, orch: orch.body.id, agent: agent.body.id };
}

describe("HTTP API", () => {
  it("serves health and OpenAPI without a token and refuses everything else", async () => {
    s = await startServer([]);
    expect(await (await fetch(`${s.url}/api/health`)).json()).toEqual({
      ok: true,
      protocolVersion: 2,
    });
    const doc = (await (await fetch(`${s.url}/api/openapi.json`)).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/api/projects",
        "/api/agents",
        "/api/sessions/{id}/messages",
        "/api/permissions/{id}",
      ]),
    );
    expect((await fetch(`${s.url}/api/projects`)).status).toBe(401);
    expect((await s.api("GET", "/api/projects", undefined, "wrong-token-xxxxxxxxxx")).status).toBe(
      401,
    );
  });

  it("creates projects and agents, and reports rule violations as 400", async () => {
    s = await startServer([]);
    const t = await tree(s);
    expect(t.project).toBe("demo-project");
    expect((await s.api<unknown[]>("GET", "/api/agents?projectId=demo-project")).body).toHaveLength(
      2,
    );
    const dup = await s.api<{ error: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "Again",
    });
    expect(dup).toEqual({ status: 400, body: { error: "There is already a god" } });
    const bad = await s.api<{ error: string }>("POST", "/api/agents", {
      kind: "wizard",
      parentId: null,
      name: "x",
    });
    expect(bad.status).toBe(400);
  });

  it("keeps owners apart", async () => {
    s = await startServer([{ text: "hi" }]);
    const t = await tree(s);
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    expect((await s.api("GET", "/api/agents", undefined, OTHER)).body).toEqual([]);
    expect(
      (await s.api("GET", `/api/sessions/${body.sessionId}/events`, undefined, OTHER)).status,
    ).toBe(404);
    expect((await s.api("POST", "/api/sessions", { agentId: t.agent }, OTHER)).status).toBe(404);
  });
});

describe("live sessions", () => {
  it("streams deltas and events, and the session outlives the client", async () => {
    s = await startServer([{ text: "Hello from the agent" }, { text: "Second answer" }]);
    const t = await tree(s);
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    c.send({ type: "session.follow", sessionId: body.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: body.sessionId, text: "hi" });
    const final = await c.waitFor("event", (m) => m.event.type === "message.assistant");
    const deltas = c.messages.flatMap((m) => (m.type === "delta" ? [m.text] : [])).join("");
    expect(deltas).toBe("Hello from the agent");
    expect(
      final.event.type === "message.assistant" && final.event.payload?.metrics.contextWindow,
    ).toBeGreaterThan(0);
    await c.waitFor(
      "session.state",
      (m) =>
        m.state === "idle" &&
        c.messages.some((x) => x.type === "session.state" && x.state === "running"),
    );
    c.close();

    // Without any client the agent still works; a new client gets the full history, no duplicates.
    expect(
      (await s.api("POST", `/api/sessions/${body.sessionId}/messages`, { text: "again" })).status,
    ).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    const c2 = await wsClient(s.url);
    c2.send({ type: "session.follow", sessionId: body.sessionId });
    const synced = await c2.waitFor("session.synced");
    const events = c2.messages.flatMap((m) => (m.type === "event" ? [m.event as Event] : []));
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "message.user",
      "message.assistant",
      "message.user",
      "message.assistant",
    ]);
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    expect(synced.lastSeq).toBe(events.at(-1)?.seq);
    c2.close();
  });

  it("asks the human through the live channel and continues after approval", async () => {
    s = await startServer([
      { toolCalls: [{ name: "write_file", input: { path: "hello.txt", content: "hi\n" } }] },
      { text: "File written." },
    ]);
    const t = await tree(s, "manual");
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: body.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: body.sessionId, text: "write the file" });
    const req = await c.waitFor("permission.request");
    expect(req.request).toMatchObject({
      agentId: t.agent,
      agentName: "Coder",
      tool: "write_file",
      reasons: ["manual mode"],
    });
    expect((await s.api<unknown[]>("GET", "/api/permissions")).body).toHaveLength(1);
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "allow",
      remember: false,
    });
    await c.waitFor("permission.closed");
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    // The agent wrote in its own worktree.
    expect(
      await readFile(
        join(
          s.dir,
          "workspaces",
          "me",
          "demo-project",
          ".worktrees",
          t.agent.toLowerCase(),
          "hello.txt",
        ),
        "utf8",
      ),
    ).toBe("hi\n");
    const asked = c.messages
      .filter((m) => m.type === "event" && m.event.type === "permission.requested")
      .map((m) => m.type === "event" && (m.event.payload as { askedTo: string }).askedTo);
    expect(asked).toEqual([t.orch, t.god, "human"]);
    expect((await s.api<{ ok: boolean }>("GET", "/api/log/verify")).body.ok).toBe(true);
    c.close();
  });

  it("the guardian asks the human, and only the human, before an agent writes outside its project (2.0)", async () => {
    const target = "/srv/redgiant-guardian-test.txt";
    s = await startServer([
      { toolCalls: [{ name: "write_file", input: { path: target, content: "out\n" } }] },
      { text: "Not written." },
    ]);
    // Auto mode: inside the project nothing would ask; outside it the human decides.
    const t = await tree(s, "auto");
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: body.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: body.sessionId, text: "write outside" });
    const req = await c.waitFor("permission.request");
    // On Windows the same path reads C:\srv\redgiant-guardian-test.txt.
    expect(req.request.reasons[0]).toMatch(
      /writes outside the project: .*srv.redgiant-guardian-test\.txt/,
    );
    c.send({
      type: "permission.resolve",
      requestId: req.request.requestId,
      decision: "deny",
      remember: false,
    });
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    await expect(readFile(target, "utf8")).rejects.toThrow();
    const asked = c.messages
      .filter((m) => m.type === "event" && m.event.type === "permission.requested")
      .map((m) => m.type === "event" && (m.event.payload as { askedTo: string }).askedTo);
    expect(asked).toEqual(["human"]);
    c.close();
  });

  it("queues a second message written while busy, and interrupts (G24.14f)", async () => {
    s = await startServer([{ text: "word ".repeat(200) }, { text: "Read it." }], {
      tick: () => new Promise((r) => setTimeout(r, 5)),
    });
    const t = await tree(s);
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    expect(
      (await s.api("POST", `/api/sessions/${body.sessionId}/messages`, { text: "go" })).status,
    ).toBe(202);
    // Not refused: it waits in line and is read right after the turn running now.
    expect(
      (await s.api("POST", `/api/sessions/${body.sessionId}/messages`, { text: "again" })).status,
    ).toBe(202);
    expect(
      (await s.api<{ interrupted: boolean }>("POST", `/api/sessions/${body.sessionId}/interrupt`))
        .body,
    ).toEqual({ interrupted: true });
    await new Promise((r) => setTimeout(r, 300));
    const events = (await s.api<Event[]>("GET", `/api/sessions/${body.sessionId}/events`)).body;
    const said = events.flatMap((e) =>
      e.type === "message.user" && e.payload
        ? [`user:${e.payload.text}`]
        : e.type === "message.assistant" && e.payload
          ? [`assistant:${e.payload.stopReason}`]
          : [],
    );
    expect(said).toEqual(["user:go", "assistant:aborted", "user:again", "assistant:end_turn"]);
  });

  it("closes connections that do not authenticate", async () => {
    s = await startServer([]);
    const c = await wsClient(s.url, "wrong-token-xxxxxxxxxxx");
    await new Promise((r) => setTimeout(r, 200));
    expect(c.closed()?.code).toBe(4003);
  });
});

describe("the steps of a turn (G36.15)", () => {
  it("follows the person's setting over the server's, and says why a turn stopped", async () => {
    // Always one more tool call: only the step limit ends the turn (then a closing summary).
    s = await startServer(
      (req) =>
        req.messages
          .at(-1)
          ?.parts.some((p) => p.type === "text" && p.text.includes("limit of steps"))
          ? { text: "Where I got to." }
          : { toolCalls: [{ name: "write_file", input: { path: "a.txt", content: "x" } }] },
      {},
      { maxTurns: 7 },
    );
    const t = await tree(s);
    const settings = await s.api<{ serverMaxTurns: number; settings: { maxTurns?: number } }>(
      "GET",
      "/api/settings/commands",
    );
    expect(settings.body.serverMaxTurns).toBe(7);
    expect(settings.body.settings.maxTurns).toBeUndefined();
    const { body } = await s.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: t.agent,
    });
    const c = await wsClient(s.url);
    await c.waitFor("welcome");
    c.send({ type: "session.follow", sessionId: body.sessionId });
    await c.waitFor("session.synced");
    const calls = () => s?.provider.requests.length ?? 0;
    const turn = async () => {
      const before = calls();
      const seen = c.messages.length;
      c.send({ type: "session.send", sessionId: body.sessionId, text: "go" });
      // The state sent on follow ("idle") can arrive after the send: wait for this turn to run first.
      const running = await c.waitFor(
        "session.state",
        (m) => m.state === "running" && c.messages.indexOf(m) >= seen,
      );
      const idle = await c.waitFor(
        "session.state",
        (m) => m.state === "idle" && c.messages.indexOf(m) > c.messages.indexOf(running),
      );
      return { calls: calls() - before, stopReason: idle.stopReason };
    };
    // The server's limit (REDGIANT_MAX_TURNS): 7 steps and the closing summary.
    expect(await turn()).toEqual({ calls: 8, stopReason: "max_turns" });
    // The person's, from Settings > Commands: the live conversation follows it at once.
    const put = await s.api("PUT", "/api/settings/commands", {
      ...settings.body.settings,
      maxTurns: 5,
    });
    expect(put.status).toBe(200);
    expect(await turn()).toEqual({ calls: 6, stopReason: "max_turns" });
    expect(
      (await s.api("PUT", "/api/settings/commands", { ...settings.body.settings, maxTurns: 2 }))
        .status,
    ).toBe(400);
    c.close();
  });
});
