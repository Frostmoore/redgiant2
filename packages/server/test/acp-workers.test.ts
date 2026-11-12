import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event } from "@redgiant/protocol";
import type { CompletionRequest } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

/** A fake ACP agent program (never a real external agent, never a model). */
const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

async function setup(script: Parameters<typeof startServer>[0] = { text: "ok" }) {
  s = await startServer(script);
  const api = s.api;
  const project = (
    await api<{ id: string; path: string }>("POST", "/api/projects", { name: "Demo" })
  ).body;
  const god = (
    await api<{ id: string }>("POST", "/api/agents", { kind: "god", name: "God", parentId: null })
  ).body;
  const orch = (
    await api<{ id: string }>("POST", "/api/agents", {
      kind: "orchestrator",
      name: "Orch",
      parentId: god.id,
      projectId: project.id,
    })
  ).body;
  const worker = await api<{ agentId: string; error?: string }>("POST", "/api/acp/workers", {
    name: "Fake",
    projectId: project.id,
    command: process.execPath,
    args: [FAKE],
    env: { FOO: "bar" },
  });
  expect([worker.status, worker.body.error]).toEqual([201, undefined]);
  return { api, project, god, orch, workerId: worker.body.agentId };
}

/** Follows a conversation and sends one message; resolves with the turn's end. */
async function turn(
  server: Server,
  sessionId: string,
  text: string,
  during?: (ws: Awaited<ReturnType<typeof wsClient>>) => Promise<void>,
) {
  const ws = await wsClient(server.url);
  ws.send({ type: "session.follow", sessionId });
  await ws.waitFor("session.synced", (m) => m.sessionId === sessionId);
  let running = false;
  const idle = ws.waitFor(
    "session.state",
    (m) => {
      if (m.sessionId !== sessionId) return false;
      if (m.state === "running") running = true;
      return running && m.state === "idle";
    },
    30_000,
  );
  ws.send({ type: "session.send", sessionId, text });
  await during?.(ws);
  const end = await idle;
  return { ws, stopReason: end.stopReason };
}

const events = async (server: Server, sessionId: string) =>
  (await server.api<Event[]>("GET", `/api/sessions/${sessionId}/events`)).body;
const said = (list: Event[]) =>
  list
    .flatMap((e) =>
      e.type === "message.assistant" && e.payload
        ? e.payload.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))
        : [],
    )
    .join("");

describe("external ACP agents as workers (G38.6)", () => {
  it("refuses secrets in its variables, and its program sees none of RedGiant's", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0000000000000000000000";
    process.env.REDGIANT_TOKEN = "server-token-never-for-agents";
    try {
      const { api, project, workerId } = await setup();
      for (const env of [
        { ANTHROPIC_API_KEY: "x" },
        { NOTE: "sk-ant-api03-abcdefghijklmnopqrstuv" },
        { REDGIANT_URL: "x" },
      ]) {
        const bad = await api<{ error: string }>("POST", "/api/acp/workers", {
          name: "Leaky",
          projectId: project.id,
          command: "node",
          args: [],
          env,
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/keychain|RedGiant's own/);
      }
      const list = (
        await api<{ workers: { agentId: string; env: Record<string, string> }[] }>(
          "GET",
          "/api/acp/workers",
        )
      ).body;
      expect(list.workers.map((w) => [w.agentId, w.env])).toEqual([[workerId, { FOO: "bar" }]]);
      const sid = (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: workerId }))
        .body.sessionId;
      const r = await turn(s as Server, sid, "env");
      expect(r.stopReason).toBe("end_turn");
      expect(said(await events(s as Server, sid))).toContain("FOO=bar leaked=none");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.REDGIANT_TOKEN;
    }
  });

  it("records its turn like a sub-agent's, serves files and commands in its folder, refuses the rest", async () => {
    const { api, workerId } = await setup();
    const sid = (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: workerId }))
      .body.sessionId;
    await turn(
      s as Server,
      sid,
      [
        "think Looking around",
        "tool t1 Search the code",
        "write notes.txt hello from fake",
        "read notes.txt",
        "read /etc/hostname",
        "write ../escape.txt nope",
        "run node -e console.log(6*7)",
        "say bye",
      ].join("\n"),
    );
    const list = await events(s as Server, sid);
    const text = said(list);
    expect(text).toContain("wrote notes.txt");
    expect(text).toContain("read: hello from fake");
    expect(text).toMatch(/refused: .*outside this agent's folder/);
    expect(text).toMatch(/exit 0: 42/);
    expect(text.match(/^refused:/gm)?.length).toBe(2);
    const calls = list.flatMap((e) =>
      e.type === "tool.call" && e.payload ? [e.payload.tool] : [],
    );
    expect(calls).toEqual(["acp_search"]);
    const results = list.filter((e) => e.type === "tool.result");
    expect(results.map((e) => e.payload && "ok" in e.payload && e.payload.ok)).toEqual([true]);
    expect(
      list.some(
        (e) =>
          e.type === "message.assistant" && e.payload?.parts.some((p) => p.type === "thinking"),
      ),
    ).toBe(true);
    expect(list.find((e) => e.type === "engine.session")?.payload).toMatchObject({ engine: "acp" });
    // Its folder is its own worktree of the project.
    expect(text).toMatch(/\.worktrees\/agent_/);
    const message = list.find((e) => e.type === "message.assistant");
    expect(message?.payload && "provider" in message.payload && message.payload.provider).toBe(
      "acp",
    );
  });

  it("routes its permission requests through the broker to the person, and stops with session/cancel", async () => {
    const { api, workerId } = await setup();
    const sid = (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: workerId }))
      .body.sessionId;
    const asked: string[] = [];
    await turn(s as Server, sid, "ask rm -rf build", async (ws) => {
      const req = await ws.waitFor("permission.request", () => true, 15_000);
      asked.push(`${req.request.tool} ${JSON.stringify(req.request.input)}`);
      ws.send({ type: "permission.resolve", requestId: req.request.requestId, decision: "deny" });
    });
    expect(asked).toEqual(['bash {"command":"rm -rf build","title":"rm -rf build"}']);
    let list = await events(s as Server, sid);
    expect(said(list)).toContain("permission: no");
    expect(list.filter((e) => e.type.startsWith("permission.")).map((e) => e.type)).toContain(
      "permission.resolved",
    );

    // Stopped while it works: session/cancel, the turn ends as aborted.
    const r = await turn(s as Server, sid, "hang", async (ws) => {
      await ws.waitFor("delta", (m) => m.sessionId === sid && m.text.includes("working"), 15_000);
      ws.send({ type: "session.interrupt", sessionId: sid });
    });
    expect(r.stopReason).toBe("aborted");
    // Afterwards it answers again, in the same conversation of the program.
    await turn(s as Server, sid, "say still here");
    list = await events(s as Server, sid);
    expect(said(list)).toContain("still here");
    const ids = new Set(
      list.filter((e) => e.type === "engine.session").map((e) => (e.payload as { id: string }).id),
    );
    expect(ids.size).toBe(1);
  });

  it("resumes its program's conversation with session/load, without recording the replay", async () => {
    const { api, workerId } = await setup();
    const sid = (await api<{ sessionId: string }>("POST", "/api/sessions", { agentId: workerId }))
      .body.sessionId;
    await turn(s as Server, sid, "say first");
    const first = (await events(s as Server, sid)).find((e) => e.type === "engine.session");
    // The person changes its settings: the conversation leaves memory, its program is closed.
    const up = await api("PUT", `/api/acp/workers/${workerId}`, {
      command: process.execPath,
      args: [FAKE],
      env: { FOO: "baz" },
    });
    expect(up.status).toBe(200);
    await turn(s as Server, sid, "env");
    const list = await events(s as Server, sid);
    expect(said(list)).toContain("FOO=baz");
    expect(said(list)).not.toContain("REPLAYED HISTORY");
    // The same conversation of the program: no second engine.session.
    expect(list.filter((e) => e.type === "engine.session").map((e) => e.payload)).toEqual([
      first?.payload,
    ]);
  });

  it("takes a task from its orchestrator and closes it with a verifier (RD17)", async () => {
    let workerId = "";
    const ctx = await setup((req: CompletionRequest) => {
      const last = req.messages.at(-1);
      const text =
        last?.parts
          .map((p) => ("text" in p ? p.text : "content" in p ? String(p.content) : ""))
          .join("") ?? "";
      if (text.includes("<task_report")) return { text: "Received." };
      if (req.messages.some((m) => m.parts.some((p) => p.type === "tool_result")))
        return { text: "Handed over." };
      return {
        toolCalls: [
          {
            name: "delegate",
            input: {
              agent_id: workerId,
              title: "Write out.txt",
              task: `write out.txt done\ndone node -e "require('fs').accessSync('out.txt')"`,
            },
          },
        ],
      };
    });
    workerId = ctx.workerId;
    const orchSession = (
      await ctx.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: ctx.orch.id })
    ).body.sessionId;
    await turn(s as Server, orchSession, "Get out.txt written by Fake");
    // The worker's turn and its report come after the orchestrator's turn ended.
    let closed: Event | undefined;
    for (let i = 0; i < 300 && !closed; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const all = (await (s as Server).api<Event[]>("GET", `/api/sessions/${orchSession}/events`))
        .body;
      const started = all.find((e) => e.type === "subagent.started");
      if (!started?.payload) continue;
      const child = (started.payload as { childSessionId: string }).childSessionId;
      closed = (await events(s as Server, child)).find((e) => e.type === "task.closed");
    }
    expect(closed?.payload).toMatchObject({ outcome: "verified" });
    const orchEvents = await events(s as Server, orchSession);
    const started = orchEvents.find((e) => e.type === "subagent.started");
    expect(started?.payload).toMatchObject({
      childAgentId: workerId,
      via: "delegate",
      title: "Write out.txt",
    });
    const child =
      (started?.payload as { childSessionId: string } | undefined)?.childSessionId ?? "";
    const childEvents = await events(s as Server, child);
    const verify = childEvents.find(
      (e) => e.type === "tool.call" && e.payload?.tool === "complete_task",
    );
    expect(verify?.payload).toMatchObject({
      input: { verify_command: `node -e "require('fs').accessSync('out.txt')"` },
    });
    // Written in its own worktree, not in the project's folder.
    const project = ctx.project.path;
    expect(existsSync(join(project, "out.txt"))).toBe(false);
  });

  it("tries a command in an empty folder of its own and says who answered", async () => {
    const { api } = await setup();
    const ok = await api<{ name: string; loadSession: boolean }>("POST", "/api/acp/try", {
      command: process.execPath,
      args: [FAKE],
      env: {},
    });
    expect(ok.body).toEqual({
      name: "Fake ACP agent",
      version: "0.0.1",
      loadSession: true,
      signIn: [],
    });
    const bad = await api<{ error: string }>("POST", "/api/acp/try", {
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      env: {},
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/ended \(exit 3\)|did not start/);
  });
});
