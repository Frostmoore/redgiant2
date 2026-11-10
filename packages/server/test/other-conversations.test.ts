// p3.5.3 (the person's test of 3.5.1 on Windows): God hands two tasks to an orchestrator; while
// the page shows the orchestrator's conversation, stuck on a command of the first task, the
// second task shows a file and asks something. The page must keep receiving that conversation's
// events, open the canvas also for a conversation it does not follow, and learn of
// conversations started after it loaded.
import type { ChatMessage, ServerMessage } from "@redgiant/protocol";
import type { CompletionRequest, FakeTurn } from "@redgiant/providers";
import { afterEach, describe, expect, it } from "vitest";
import { OTHER, startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  const server = s;
  s = undefined;
  await server?.close();
}, 60_000);

const textOf = (m: ChatMessage | undefined) =>
  m?.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_result" ? [p.content] : []))
    .join("\n") ?? "";

/** The last plain user message, and the tool results after it. */
function step(req: CompletionRequest): { asked: string; n: number; results: string[] } {
  const results: string[] = [];
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m?.role !== "user") continue;
    if (m.parts.every((p) => p.type === "tool_result")) results.unshift(textOf(m));
    else return { asked: textOf(m), n: results.length, results };
  }
  return { asked: "", n: results.length, results };
}
const call = (name: string, input: unknown): FakeTurn => ({ toolCalls: [{ name, input }] });
const idIn = (text: string, kind: string) =>
  text.match(new RegExp(`\\((${kind}_[0-9a-f]+)\\)`))?.[1] ?? "";
/** A command that stays a while (the LibreOffice window waiting for its OK). */
const HANG = `node -e "setTimeout(() => {}, 2500)"`;

function script(parallel: boolean) {
  return (req: CompletionRequest): FakeTurn => {
    const { asked, n, results } = step(req);
    const last = results.at(-1) ?? "";
    if (req.system.startsWith("You are God")) {
      if (asked.includes("<task_report")) return { text: "Noted." };
      if (n === 0) return call("create_project", { name: "Collaudo" });
      if (n === 1)
        return call("create_agent", {
          kind: "orchestrator",
          name: "Orch",
          role: "Runs the test",
          project_id: "collaudo",
        });
      const orch = idIn(results[1] ?? "", "orchestrator");
      const first = { agent_id: orch, title: "Alpha", task: "Run the long command" };
      const second = { agent_id: orch, title: "Beta", task: "Show app.py and ask" };
      // Both at once (one turn with two calls, as God did), or one after the other.
      if (parallel && n === 2)
        return {
          toolCalls: [
            { name: "delegate", input: first },
            { name: "delegate", input: second },
          ],
        };
      if (!parallel && n === 2) return call("delegate", first);
      if (!parallel && n === 3) return call("delegate", second);
      return { text: "Handed over." };
    }
    if (req.system.startsWith("You are the orchestrator")) {
      // Each task's own steps: the last task message says which.
      // The task's message, or a reminder that names it.
      const beta = asked.includes("«Beta»") || asked.includes('("Beta")');
      const task_id = asked.match(/(task_[0-9a-f]+)/)?.[1];
      if (!beta) {
        if (n === 0) return call("bash", { command: HANG });
        if (n === 1) return call("complete_task", { task_id, verify_command: "node -e 0" });
        return { text: "Alpha done." };
      }
      if (n === 0) return call("write_file", { path: "app.py", content: "print('hi')\n" });
      if (n === 1) return call("show_file", { path: "app.py" });
      if (n === 2)
        return call("ask_user", {
          questions: [
            {
              question: "Do you see app.py in the canvas?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        });
      if (n === 3) return call("complete_task", { task_id, verify_command: "node -e 0" });
      return { text: `Beta done: ${last.slice(0, 40)}` };
    }
    return { text: "ok" };
  };
}

async function run(parallel: boolean, follow = true) {
  s = await startServer(script(parallel), { contextWindow: 65_536 });
  const server = s;
  const god = await server.api<{ id: string }>("POST", "/api/agents", {
    kind: "god",
    parentId: null,
    name: "God",
  });
  const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
    agentId: god.body.id,
  });
  // The person's page: God's chat open; the orchestrator's conversation opened as soon as it
  // starts (it did not exist when the page loaded: the list never had it).
  const page = await wsClient(server.url);
  const other = await wsClient(server.url, OTHER);
  page.send({ type: "session.follow", sessionId: body.sessionId });
  await page.waitFor("session.synced");
  // Whatever asks permission is allowed, as the person would.
  const allow = setInterval(() => {
    for (const m of page.messages.splice(0))
      if (m.type === "permission.request")
        page.send({
          type: "permission.resolve",
          requestId: m.request.requestId,
          decision: "allow",
        });
      else seen.push(m);
  }, 20);
  const seen: ServerMessage[] = [];
  const waitSeen = async <T extends ServerMessage["type"]>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ms = 15_000,
  ): Promise<Extract<ServerMessage, { type: T }>> => {
    const end = Date.now() + ms;
    for (;;) {
      const m = seen.find(
        (x): x is Extract<ServerMessage, { type: T }> =>
          x.type === type && pred(x as Extract<ServerMessage, { type: T }>),
      );
      if (m) return m;
      if (Date.now() > end) throw new Error(`no ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    page.send({ type: "session.send", sessionId: body.sessionId, text: "Test RedGiant" });
    const started = await waitSeen(
      "session.activity",
      (m) => m.agentId !== god.body.id && m.state === "running",
    );
    const orchSession = started.sessionId;
    if (!follow) {
      // The task's conversation, never opened: the canvas opens all the same, nothing else of
      // that conversation reaches the page, and the question reaches the bell.
      const open = await waitSeen("canvas.open", (m) => m.sessionId === orchSession);
      expect(open.event.type === "canvas.show" && open.event.payload?.target).toMatchObject({
        kind: "file",
        path: "app.py",
      });
      const q = await waitSeen("question.request");
      expect(q.request.sessionId).toBe(orchSession);
      expect(seen.some((m) => m.type === "event" && m.sessionId === orchSession)).toBe(false);
      expect(seen.filter((m) => m.type === "canvas.open")).toHaveLength(1);
      // Another person's page hears none of it.
      expect(
        other.messages.some((m) => m.type === "canvas.open" || m.type === "session.activity"),
      ).toBe(false);
      page.send({ type: "question.answer", requestId: q.request.requestId, answers: [["Yes"]] });
      return;
    }
    page.send({ type: "session.follow", sessionId: orchSession });
    // The question of the second task reaches the bell…
    const q = await waitSeen("question.request");
    // …and the conversation the page follows (the same one: tasks share the work conversation).
    expect(q.request.sessionId).toBe(orchSession);
    await waitSeen(
      "event",
      (m) => m.sessionId === orchSession && m.event.type === "question.asked",
      5000,
    );
    // The canvas opened for app.py, once, through the followed conversation's event.
    const shown = seen.filter(
      (m) => (m.type === "event" && m.event.type === "canvas.show") || m.type === "canvas.open",
    );
    expect(shown.length).toBe(1);
    // The list has the conversation of the tasks (the bell's «apri» finds it).
    const list = await server.api<{ id: string; agentId: string; task?: string | null }[]>(
      "GET",
      "/api/sessions",
    );
    expect(list.body.some((r) => r.id === orchSession)).toBe(true);
    // …with the task it works on, for the left bar's «Compito: …» (p3.5.4).
    expect(["Alpha", "Beta"]).toContain(list.body.find((r) => r.id === orchSession)?.task);
    expect(list.body.find((r) => r.id === body.sessionId)?.task).toBe(null);
    page.send({ type: "question.answer", requestId: q.request.requestId, answers: [["Yes"]] });
    // The command of the first task ends and the page still hears it.
    const bash = await waitSeen(
      "event",
      (m) =>
        m.sessionId === orchSession &&
        m.event.type === "tool.call" &&
        m.event.payload?.tool === "bash",
    );
    const callId = bash.event.type === "tool.call" ? bash.event.payload?.callId : undefined;
    await waitSeen(
      "event",
      (m) =>
        m.sessionId === orchSession &&
        m.event.type === "tool.result" &&
        m.event.payload?.callId === callId,
    );
  } finally {
    clearInterval(allow);
  }
}

describe("other conversations of an agent (p3.5.3)", () => {
  it("two tasks at once: the followed work conversation keeps its events", async () => {
    await run(true);
  }, 60_000);

  it("two tasks one after the other: the same", async () => {
    await run(false);
  }, 60_000);

  it("a task's conversation the page does not follow still opens the canvas", async () => {
    await run(false, false);
  }, 60_000);
});

describe("a conversation resumed by several callers at once (p3.5.3)", () => {
  it("is built once: a page that follows it while two tasks arrive hears both", async () => {
    s = await startServer((req) => ({ text: `answer ${req.messages.length}` }));
    const server = s;
    const god = await server.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const { body } = await server.api<{ sessionId: string }>("POST", "/api/sessions", {
      agentId: god.body.id,
    });
    const sid = body.sessionId;
    await (await server.core.send("me", sid, "first")).done;
    // Out of memory (idle, nobody following): the next callers resume it from the log.
    expect(server.core.closeIdle(0)).toBe(1);
    const heard: ServerMessage[] = [];
    const [, a, b] = await Promise.all([
      server.core.follow("me", sid, (m) => heard.push(m)),
      server.core.send("me", sid, "task one", { queue: true }),
      server.core.send("me", sid, "task two", { queue: true }),
    ]);
    await Promise.all([a.done, b.done]);
    const said = heard.flatMap((m) =>
      m.type === "event" && m.event.type === "message.user" ? [m.event.payload?.text] : [],
    );
    expect(said).toContain("task one");
    expect(said).toContain("task two");
    // One turn after the other, never two at once on two copies of the conversation.
    const events = (await server.api<{ type: string }[]>("GET", `/api/sessions/${sid}/events`))
      .body;
    expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
  });
});
