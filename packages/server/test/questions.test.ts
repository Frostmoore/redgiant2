import { type Event, PLAN_APPROVE } from "@redgiant/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

async function god(server: Server, mode?: "plan") {
  const r = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
    ...(mode && { mode }),
  });
  const session = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
    agentId: r.body.id,
  });
  return { agentId: r.body.id, sessionId: session.body.sessionId };
}

const toolResult = (server: Server, sessionId: string) =>
  server.core
    .history("me", sessionId)
    .then((es: Event[]) => es.flatMap((e) => (e.type === "tool.result" ? [e.payload.output] : [])));

describe("questions to the human", () => {
  it("asks with choices, takes the human's answer and gives it back to the agent", async () => {
    s = await startServer([
      {
        toolCalls: [
          {
            name: "ask_user",
            input: {
              questions: [
                {
                  question: "Which database?",
                  header: "Database",
                  options: [{ label: "Postgres" }, { label: "SQLite", description: "one file" }],
                },
                {
                  question: "Which extras?",
                  options: [{ label: "Auth" }, { label: "Search" }, { label: "Admin" }],
                  multi_select: true,
                },
              ],
            },
          },
        ],
      },
      { text: "Noted." },
    ]);
    const g = await god(s);
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: g.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: g.sessionId, text: "start a project" });
    const req = await c.waitFor("question.request");
    expect(req.request).toMatchObject({
      sessionId: g.sessionId,
      agentName: "God",
      questions: [
        { question: "Which database?", header: "Database", multiSelect: false },
        { question: "Which extras?", multiSelect: true },
      ],
    });
    // A second client connecting now sees the open question too.
    const late = await wsClient(s.url);
    expect((await late.waitFor("question.request")).request.requestId).toBe(req.request.requestId);
    // Malformed answers are refused; a free-text answer is fine.
    c.send({ type: "question.answer", requestId: req.request.requestId, answers: [["Postgres"]] });
    expect((await c.waitFor("error")).code).toBe("not_found");
    c.send({
      type: "question.answer",
      requestId: req.request.requestId,
      answers: [["Postgres"], ["Auth", "Something else entirely"]],
    });
    await late.waitFor("question.closed");
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    expect(await toolResult(s, g.sessionId)).toEqual([
      "Which database?\n-> Postgres\n\nWhich extras?\n-> Auth; Something else entirely",
    ]);
    const types = (await s.core.history("me", g.sessionId)).map((e) => e.type);
    expect(types).toContain("question.asked");
    expect(types).toContain("question.answered");
    c.close();
    late.close();
  });

  it("an interrupted turn leaves the question unanswered, never answered for the human", async () => {
    s = await startServer([
      {
        toolCalls: [
          {
            name: "ask_user",
            input: {
              questions: [{ question: "A or B?", options: [{ label: "A" }, { label: "B" }] }],
            },
          },
        ],
      },
      { text: "ok" },
    ]);
    const g = await god(s);
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: g.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: g.sessionId, text: "go" });
    await c.waitFor("question.request");
    c.send({ type: "session.interrupt", sessionId: g.sessionId });
    await c.waitFor("question.closed");
    // The answer (none) is logged after the question closes: wait for that event itself.
    await c.waitFor("event", (m) => m.event.type === "question.answered");
    const answered = (await s.core.history("me", g.sessionId)).find(
      (e) => e.type === "question.answered",
    );
    expect(answered?.payload).toMatchObject({ answers: null, by: "nobody" });
    c.close();
  });

  it("an approved plan takes the agent out of plan mode, as an undoable change", async () => {
    s = await startServer([
      { toolCalls: [{ name: "propose_plan", input: { plan: "1. Read\n2. Write" } }] },
      { toolCalls: [{ name: "write_file", input: { path: "a.txt", content: "x" } }] },
      { text: "Done." },
    ]);
    const g = await god(s, "plan");
    const c = await wsClient(s.url);
    c.send({ type: "session.follow", sessionId: g.sessionId });
    await c.waitFor("session.synced");
    c.send({ type: "session.send", sessionId: g.sessionId, text: "plan it" });
    const req = await c.waitFor("question.request");
    expect(req.request.plan).toBe("1. Read\n2. Write");
    c.send({
      type: "question.answer",
      requestId: req.request.requestId,
      answers: [[PLAN_APPROVE]],
    });
    await c.waitFor(
      "event",
      (m) => m.event.type === "message.assistant" && m.event.payload?.stopReason === "end_turn",
    );
    expect(s.core.registry.get(g.agentId)?.mode).toBe("auto");
    const results = await toolResult(s, g.sessionId);
    expect(results[0]).toMatch(/approved the plan/);
    expect(results[1]).not.toMatch(/plan mode/);
    const changes = await s.api<{ change: string; before: unknown }[]>(
      "GET",
      "/api/platform/changes",
    );
    expect(changes.body[0]).toMatchObject({ change: "God: mode", before: { mode: "plan" } });
    c.close();
  });

  it("is not offered outside plan mode, and only to the agents the human talks with", async () => {
    s = await startServer([
      { toolCalls: [{ name: "propose_plan", input: { plan: "x" } }] },
      { text: "ok" },
    ]);
    const g = await god(s);
    await (await s.core.send("me", g.sessionId, "go")).done;
    expect(await toolResult(s, g.sessionId)).toEqual(["You are not in plan mode: just carry on."]);
    const started = (await s.core.history("me", g.sessionId))[0];
    const names = (started?.payload as { tools: string[] } | undefined)?.tools;
    expect(names).toEqual(expect.arrayContaining(["ask_user", "propose_plan"]));
  });
});
